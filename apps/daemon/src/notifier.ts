import {
  type DaemonText,
  gatePullRequest,
  isCompleted,
  message,
  type PauseReason,
  type Project,
  type ProjectNotification,
  renderMessage,
  type StepKey,
  type Task,
} from "@sacty/core";
import { errorText } from "./errors.js";
import { hideSecret } from "./platforms.js";
import type { SecretStore } from "./secrets.js";

/**
 * 人間の出番を Slack に通知する（PBI-38）。承認待ち・エスカレーション・一時停止（人間が止めたときを除く）・完了を、
 * タスクのプロジェクトの通知先に送る。送り方は Slack API の形（chat.postMessage。Slack Proxy でも使える）か
 * Incoming Webhook。送れなくてもタスクは止めず、理由をプロジェクトごとに持って画面に出す（次に送れたら消す）。
 */

/** 送れなかった理由の長さの上限（画面・ログに出す。秘密情報を伏せてから切り詰める）。 */
const REASON_MAX = 400;

export type NotificationKind = "approval" | "escalation" | "paused" | "completed";

type Language = "ja" | "en";

const STEP: Record<Language, Record<StepKey, string>> = {
  ja: {
    investigate: "調査",
    review: "レビュー",
    requirements: "要求要件",
    design: "設計",
    split: "タスク分割",
    integrate: "統合レビュー",
    reproduce: "再現",
    implement: "実装",
    pr: "成果物チェック",
  },
  en: {
    investigate: "Investigate",
    review: "Review",
    requirements: "Requirements",
    design: "Design",
    split: "Task split",
    integrate: "Integration review",
    reproduce: "Reproduce",
    implement: "Implement",
    pr: "Deliverable review",
  },
};

const PAUSE: Record<Language, Record<PauseReason, string>> = {
  ja: {
    budget: "予算の上限",
    usage_limit: "AI の利用上限",
    auth: "認証エラー",
    error: "エラー",
    verification: "実装の検証に通らない",
    manual: "人間が一時停止",
    child_cancelled: "子タスクの中止",
  },
  en: {
    budget: "budget cap",
    usage_limit: "AI usage limit",
    auth: "authentication error",
    error: "error",
    verification: "the implementation keeps failing verification",
    manual: "paused by a person",
    child_cancelled: "a subtask was cancelled",
  },
};

/** Slack の mrkdwn で特別な意味を持つ文字を逃がす。 */
/**
 * Slack の通知の送り手の名前とアイコン（PBI-68）。アイコンは、公開しているリポジトリの画像（assets/sacty-icon.png）。
 * 取りに行くのは Slack のサーバーなので、誰でも開ける URL にする。
 */
export const SLACK_USERNAME = "Sacty";
export const SLACK_ICON_URL =
  "https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png";

const escapeMrkdwn = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const link = (url: string, label: string) => `<${url}|${escapeMrkdwn(label)}>`;

/** 通知の本文（Slack の mrkdwn）。 */
export function notificationText(
  task: Task,
  kind: NotificationKind,
  language: Language,
  webUrl: string,
): string {
  const ja = language === "ja";
  const base = webUrl.replace(/\/+$/, "");
  const title = link(`${base}/tasks/${task.id}`, task.title);
  const review = `${base}/tasks/${task.id}/review`;
  const step = task.gate?.step ?? task.escalation?.step;
  const stepName = step ? STEP[language][step] : "";
  if (kind === "approval") {
    const what =
      step === "reproduce"
        ? ja
          ? "再現できなかったため、判断を待っています"
          : "The bug was not reproduced; your decision is needed"
        : step === "integrate" && task.integration?.passed === false
          ? ja
            ? "統合レビューに通らないため、判断を待っています"
            : "The integration review keeps failing; your decision is needed"
          : ja
            ? `${stepName}の承認を待っています`
            : `${stepName} is waiting for your approval`;
    // 成果物チェックの PR と、要求要件・設計の PR（PBI-57）は、マージで承認する
    const watched = gatePullRequest(task);
    const pr = watched?.url
      ? ja
        ? `PR：${link(watched.url, `#${watched.number}`)}（マージで承認）`
        : `PR: ${link(watched.url, `#${watched.number}`)} (merge to approve)`
      : "";
    return [
      `:raising_hand: ${title}`,
      what,
      ja ? `窓口：${link(review, "承認の画面")}` : `Decide here: ${link(review, "review page")}`,
      pr,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (kind === "escalation") {
    const reason = task.escalation?.reason;
    const what =
      reason === "rework_confirmation"
        ? ja
          ? "PR の指摘の戻し先を確かめてください（エスカレーション）"
          : "Confirm the step to redo for the PR comments (escalated)"
        : ja
          ? `${stepName}がエスカレーションしました。判断してください`
          : `${stepName} was escalated; your decision is needed`;
    return [
      `:warning: ${title}`,
      what,
      ja ? `窓口：${link(review, "判断の画面")}` : `Decide here: ${link(review, "review page")}`,
    ].join("\n");
  }
  if (kind === "paused") {
    const reason = task.pausedReason ? PAUSE[language][task.pausedReason] : "";
    const detail = task.pausedMessage ? renderMessage(task.pausedMessage, language) : "";
    const short = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
    return [
      `:double_vertical_bar: ${title}`,
      ja ? `一時停止しました（${reason}）` : `Paused (${reason})`,
      short ? escapeMrkdwn(short) : "",
      ja ? "確かめてから再開してください。" : "Check it and resume.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`:white_check_mark: ${title}`, ja ? "完了しました" : "Done"].join("\n");
}

/** 状態の変わり方から、通知することを決める（無ければ undefined）。 */
export function notificationFor(
  before: Task | undefined,
  after: Task,
): NotificationKind | undefined {
  if (after.status === "escalated" && before?.status !== "escalated") return "escalation";
  if (
    after.status === "awaiting_approval" &&
    (before?.status !== "awaiting_approval" ||
      before.gate?.step !== after.gate?.step ||
      before.gate?.submission !== after.gate?.submission)
  ) {
    return "approval";
  }
  // 人間が自分で止めたときは、通知しない
  if (after.status === "paused" && before?.status !== "paused" && after.pausedReason !== "manual") {
    return "paused";
  }
  if (isCompleted(after) && !(before && isCompleted(before))) return "completed";
  return undefined;
}

export class SlackNotifier {
  /** プロジェクトごとの、最後に送れなかった理由（送れたら消す）。 */
  private readonly failures = new Map<string, DaemonText>();

  constructor(
    private readonly deps: {
      project: (id: string) => Project | undefined;
      secrets: SecretStore;
      /** sacty の画面の URL（リンクに使う）。 */
      webUrl: string;
      fetchImpl?: typeof fetch;
      log?: (line: string) => void;
    },
  ) {}

  /** 通知する（送るのを待たない。送れなくても例外にしない）。 */
  notify(task: Task, kind: NotificationKind): Promise<void> {
    const project = this.deps.project(task.projectId);
    const destination = project?.notification;
    if (!project || !destination) return Promise.resolve();
    return this.send(
      project,
      destination,
      notificationText(task, kind, destination.language, this.deps.webUrl),
    ).catch(() => {});
  }

  /** テストの通知を送る（プロジェクトの設定の画面から）。送れなければ、理由の例外にする。 */
  async test(projectId: string): Promise<void> {
    const project = this.deps.project(projectId);
    const destination = project?.notification;
    if (!project || !destination)
      throw new Error(renderMessage(message("notify.notConfigured"), "ja"));
    const text =
      destination.language === "ja"
        ? `:wave: sacty からのテストの通知です（プロジェクト「${escapeMrkdwn(project.name)}」）。人間の出番になると、ここに通知します。`
        : `:wave: Test notification from sacty (project "${escapeMrkdwn(project.name)}"). sacty will notify you here when it needs you.`;
    await this.send(project, destination, text);
  }

  /** 送れなかったプロジェクトの理由。 */
  problems(): DaemonText[] {
    return [...this.failures.values()];
  }

  private async send(
    project: Project,
    destination: ProjectNotification,
    text: string,
  ): Promise<void> {
    const secrets: string[] = [];
    try {
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      let res: Response;
      if (destination.kind === "slack-api") {
        const token = destination.token
          ? await this.deps.secrets.get(destination.token)
          : undefined;
        if (token) secrets.push(token);
        res = await fetchImpl(destination.url, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            channel: destination.channel,
            // 送り手の名前とアイコン（PBI-68）。ボットのトークンに chat:write.customize の権限が無いと、Slack は無視する
            username: SLACK_USERNAME,
            icon_url: SLACK_ICON_URL,
            text,
            unfurl_links: false,
            unfurl_media: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } else {
        const url = await this.deps.secrets.get(destination.webhook);
        secrets.push(url);
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(15_000),
        });
      }
      const body = await res.text();
      // 本文は切り詰めずに理由に入れる（秘密情報を伏せてから切り詰める。PBI-38 レビュー指摘）
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
      // Slack API は、失敗しても 200 で {"ok": false, "error": …} を返す
      if (destination.kind === "slack-api") {
        let parsed: { ok?: boolean; error?: string } | undefined;
        try {
          parsed = JSON.parse(body) as { ok?: boolean; error?: string };
        } catch {
          parsed = undefined;
        }
        if (parsed?.ok === false) throw new Error(`Slack: ${parsed.error ?? "not ok"}`);
      }
      this.failures.delete(project.id);
    } catch (error) {
      const raw = errorText(error);
      const hidden = secrets.reduce(
        (t, s) => hideSecret(t, s),
        typeof raw === "string" ? raw : renderMessage(raw, "ja"),
      );
      const detail = hidden.length > REASON_MAX ? `${hidden.slice(0, REASON_MAX)}…` : hidden;
      this.failures.set(project.id, message("notify.failed", { project: project.name, detail }));
      this.deps.log?.(`[notify] ${project.name}: ${detail}`);
      throw new Error(detail);
    }
  }
}
