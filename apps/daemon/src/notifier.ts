import {
  activeStep,
  type DaemonText,
  gatePullRequest,
  isCompleted,
  message,
  type NotificationKind,
  type PauseReason,
  type Project,
  renderMessage,
  type SlackMention,
  type SlackNotification,
  type StepKey,
  type Task,
} from "@sacty/core";
import { errorText } from "./errors.js";
import { hideSecret } from "./platforms.js";
import type { SecretStore } from "./secrets.js";

/**
 * 人間の出番を Slack に通知する（PBI-38）。承認待ち・エスカレーション・一時停止（人間が止めたときを除く）・完了を、
 * sacty の設定の通知先に送る（すべてのプロジェクトのタスクを1つの送り先に送り、本文にプロジェクトの名前を入れる。
 * PBI-115）。送り方は Slack API の形（chat.postMessage。Slack Proxy でも使える）か Incoming Webhook。送れなくても
 * タスクは止めず、最後に送れなかった理由を1つ持って画面に出す（次に送れたら消す）。
 */

/** 送れなかった理由の長さの上限（画面・ログに出す。秘密情報を伏せてから切り詰める）。 */
const REASON_MAX = 400;

export type { NotificationKind };

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
    deployment: "マージの後の監視",
    document: "文書作成",
    operation: "作業",
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
    deployment: "After-merge watch",
    document: "Document",
    operation: "Operation",
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

/**
 * Slack の通知の送り手の名前とアイコン（PBI-68）。アイコンは、公開しているリポジトリの画像（assets/sacty-icon.png）。
 * 取りに行くのは Slack のサーバーなので、誰でも開ける URL にする。
 */
export const SLACK_USERNAME = "Sacty";
export const SLACK_ICON_URL =
  "https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png";

/** Slack の mrkdwn で特別な意味を持つ文字を逃がす。 */
const escapeMrkdwn = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const link = (url: string, label: string) => `<${url}|${escapeMrkdwn(label)}>`;

/**
 * 通知の本文（Slack の mrkdwn）。projectName は、タスクのプロジェクトの名前（1つの送り先に、すべてのプロジェクトの
 * タスクを送るので、題名の前に [名前] で入れる。PBI-115）。どの工程の通知かがわかるように、工程の名前を入れる
 * （承認待ちは承認を待つ工程、エスカレーションはエスカレーションした工程、一時停止は止まったときの工程。PBI-115）。
 * 工程に結びつかない通知（完了・工程を決める前の一時停止など）には、工程を入れない。
 */
export function notificationText(
  task: Task,
  kind: NotificationKind,
  language: Language,
  webUrl: string,
  projectName?: string,
): string {
  const ja = language === "ja";
  const base = webUrl.replace(/\/+$/, "");
  const title = `${projectName ? `[${escapeMrkdwn(projectName)}] ` : ""}${link(`${base}/tasks/${task.id}`, task.title)}`;
  const review = `${base}/tasks/${task.id}/review`;
  const nameOf = (step: StepKey | undefined) => (step ? STEP[language][step] : "");
  if (kind === "approval") {
    const step = task.gate?.step;
    const stepName = nameOf(step);
    const what =
      step === "reproduce"
        ? ja
          ? `${stepName}の工程で再現できなかったため、判断を待っています`
          : `${stepName}: the bug was not reproduced; your decision is needed`
        : step === "integrate" && task.integration?.passed === false
          ? ja
            ? `${stepName}に通らないため、判断を待っています`
            : `${stepName} keeps failing; your decision is needed`
          : stepName
            ? ja
              ? `${stepName}の承認を待っています`
              : `${stepName} is waiting for your approval`
            : ja
              ? "承認を待っています"
              : "Waiting for your approval";
    // 実装の PR と、要求要件・設計の PR（PBI-57・PBI-110）は、マージで承認する
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
    const stepName = nameOf(task.escalation?.step ?? task.gate?.step);
    const where = stepName ? (ja ? `${stepName}で` : ` in ${stepName}`) : "";
    const what =
      reason === "rework_confirmation"
        ? ja
          ? `${where}エスカレーションしました。PR の指摘の戻し先を確かめてください`
          : `Escalated${where}: confirm the step to redo for the PR comments`
        : ja
          ? `${where}エスカレーションしました。判断してください`
          : `Escalated${where}; your decision is needed`;
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
    // 止まったときの工程。工程を決める前（オーケストレーターが工程を決める前）なら、そう書く
    const stepName = nameOf(activeStep(task));
    const where = stepName
      ? ja
        ? `${stepName}で`
        : ` in ${stepName}`
      : task.steps.length === 0
        ? ja
          ? "工程を決める前に"
          : " before the steps were decided"
        : "";
    const why = reason ? (ja ? `（${reason}）` : ` (${reason})`) : "";
    return [
      `:double_vertical_bar: ${title}`,
      ja ? `${where}一時停止しました${why}` : `Paused${where}${why}`,
      short ? escapeMrkdwn(short) : "",
      ja ? "確かめてから再開してください。" : "Check it and resume.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`:white_check_mark: ${title}`, ja ? "完了しました" : "Done"].join("\n");
}

/**
 * メンションの書き方（PBI-69）。ユーザーは <@U…>、ユーザーグループは <!subteam^S…>、@here・@channel は
 * <!here>・<!channel>。ID の形は設定の読み込みで確かめている（<>|& などは入らない）。
 */
export function mentionText(mention: SlackMention | undefined): string {
  return (mention?.targets ?? [])
    .map((target) =>
      target === "@here"
        ? "<!here>"
        : target === "@channel"
          ? "<!channel>"
          : target.startsWith("S")
            ? `<!subteam^${target}>`
            : `<@${target}>`,
    )
    .join(" ");
}

/** 本文の先頭にメンションを付ける。kind が undefined（テストの通知）なら、種類によらず付ける（見え方を確かめるため）。 */
export function withMention(
  text: string,
  mention: SlackMention | undefined,
  kind: NotificationKind | undefined,
): string {
  if (!mention || (kind && !mention.kinds.includes(kind))) return text;
  const mentions = mentionText(mention);
  return mentions ? `${mentions} ${text}` : text;
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

/** 送り先を見分ける値（秘密情報は参照の名前だけなので、値は入らない）。 */
const keyOf = (destination: SlackNotification) => JSON.stringify(destination);

export class SlackNotifier {
  /**
   * 最後に送れなかった理由（sacty 全体で1つ。送れたら消す。PBI-115）。key は、そのときの送り先（設定を読めなかったときは
   * 無し）。今の送り先と違えば、画面に出さない（送り先を変えた後に、古い送り先の理由を出さない）。
   */
  private failure: { key: string | undefined; text: DaemonText } | undefined;
  /** 送り始めた順の番号と、結果を反映した最後の番号（後に始めた送信の結果を、先に始めた送信の結果で上書きしない）。 */
  private started = 0;
  private settled = 0;
  /**
   * 送り先の設定を変えたときの、送り始めた番号（PBI-115 レビュー指摘）。これまでに始めた送信の結果は、変える前の設定のものなので
   * 反映しない（A → B → A と戻しても、変える前の失敗を今の障害として出さない）。
   */
  private changedAt = 0;

  constructor(
    private readonly deps: {
      /** sacty の設定の通知先（PBI-115）。読めなければ例外。 */
      notification: () => SlackNotification | undefined;
      /** タスクのプロジェクト（本文に名前を入れる）。 */
      project: (id: string) => Project | undefined;
      secrets: SecretStore;
      /** sacty の画面の URL（リンクに使う）。 */
      webUrl: string;
      fetchImpl?: typeof fetch;
      log?: (line: string) => void;
    },
  ) {}

  /**
   * 通知する（送るのを待たない）。設定・プロジェクトを読めない・本文を作れない・送れない、のどれでも例外にせず、送れなかった
   * 理由として持つ（タスクの操作は、作業履歴に書いた後に呼ぶので、例外を伝えると成功した操作が失敗に見える。PBI-115 レビュー指摘）。
   */
  notify(task: Task, kind: NotificationKind): Promise<void> {
    const seq = ++this.started;
    let key: string | undefined;
    try {
      const destination = this.deps.notification();
      // 止めている（設定は残している）ときは送らない
      if (!destination || destination.off) return Promise.resolve();
      key = keyOf(destination);
      const projectName = this.deps.project(task.projectId)?.name;
      const text = withMention(
        notificationText(task, kind, destination.language, this.deps.webUrl, projectName),
        destination.mention,
        kind,
      );
      return this.send(destination, text, seq).catch(() => {});
    } catch (error) {
      try {
        this.fail(error, [], key, seq);
      } catch {
        // 理由を持てなくても、タスクの操作には伝えない
      }
      return Promise.resolve();
    }
  }

  /**
   * テストの通知を送る（sacty の設定の画面から）。止めているときも送る（On に戻す前に確かめられるように）。送れなければ、
   * 理由の例外にする。
   */
  async test(): Promise<void> {
    const destination = this.deps.notification();
    if (!destination) throw new Error(renderMessage(message("notify.notConfigured"), "ja"));
    const text =
      destination.language === "ja"
        ? ":wave: sacty からのテストの通知です。人間の出番になると、すべてのプロジェクトのタスクを、ここに通知します。"
        : ":wave: Test notification from sacty. sacty will notify you here about tasks in every project when it needs you.";
    await this.send(destination, withMention(text, destination.mention, undefined), ++this.started);
  }

  /** 送れなかった理由（無ければ空）。今の送り先の理由だけを出す（通知先を外した・変えたら、前の理由は出さない）。 */
  problems(): DaemonText[] {
    if (!this.failure) return [];
    let current: string | undefined;
    try {
      const destination = this.deps.notification();
      if (!destination || destination.off) return [];
      current = keyOf(destination);
    } catch {
      // 設定を読めないときは、持っている理由を出す
      return [this.failure.text];
    }
    return this.failure.key === current ? [this.failure.text] : [];
  }

  /**
   * sacty の設定の通知先を変えたときに呼ぶ。持っている失敗を捨て、変える前に始めた送信の結果を反映しないようにする。
   */
  settingsChanged(): void {
    this.changedAt = this.started;
    this.failure = undefined;
  }

  /**
   * 結果を反映してよいか。通知先を変える前に始めた送信の結果は反映しない。後に始めた送信の結果がすでに反映されていれば反映しない。送り先が変わっていれば（今の設定を読めない
   * ときも）、古い送り先の結果なので反映しない。key が無い（設定を読めなかった）ときは、そのまま反映する。
   */
  private settle(seq: number, key: string | undefined): boolean {
    if (seq <= this.changedAt || seq < this.settled) return false;
    if (key !== undefined) {
      let current: string | undefined;
      try {
        const destination = this.deps.notification();
        current = destination ? keyOf(destination) : undefined;
      } catch {
        current = undefined;
      }
      if (current !== key) return false;
    }
    this.settled = seq;
    return true;
  }

  /**
   * 送れなかった理由を、秘密情報を伏せてから切り詰め、ログに出す。今の送り先の最新の結果なら、画面に出す理由として持つ。
   * 切り詰めた理由を返す。
   */
  private fail(
    error: unknown,
    secrets: readonly string[],
    key: string | undefined,
    seq: number,
  ): string {
    const raw = errorText(error);
    const hidden = secrets.reduce(
      (t, s) => hideSecret(t, s),
      typeof raw === "string" ? raw : renderMessage(raw, "ja"),
    );
    const detail = hidden.length > REASON_MAX ? `${hidden.slice(0, REASON_MAX)}…` : hidden;
    if (this.settle(seq, key)) this.failure = { key, text: message("notify.failed", { detail }) };
    this.deps.log?.(`[notify] ${detail}`);
    return detail;
  }

  private async send(destination: SlackNotification, text: string, seq: number): Promise<void> {
    const key = keyOf(destination);
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
      if (this.settle(seq, key)) this.failure = undefined;
    } catch (error) {
      throw new Error(this.fail(error, secrets, key, seq));
    }
  }
}
