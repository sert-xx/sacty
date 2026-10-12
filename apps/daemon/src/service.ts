import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ActivityEvent,
  type Actor,
  ApproveStepInput,
  activeStep,
  applyEvent,
  BUDGET_WARN_RATIO,
  budgetState,
  type CleanupTarget,
  CreateTaskInput,
  changeRounds,
  computeCostUsd,
  type DaemonMessage,
  type DaemonText,
  DEFAULT_BUDGET_USD,
  DecideChangeInput,
  EventInput,
  excludedRepositories,
  GATED_STEPS,
  investigationIsGoal,
  isCompleted,
  MAX_CHANGE_REQUESTS,
  MAX_VERIFY_ATTEMPTS,
  message,
  openProposal,
  type PauseReason,
  type Project,
  ProjectDefinition,
  ProjectExport,
  project,
  projectConflicts,
  proposalAccepted,
  RepoName,
  RequestChangesInput,
  ResumeTaskInput,
  renderMessage,
  responsibleProject,
  reworkTargets,
  SactySettings,
  STEP_PLANS,
  type StepKey,
  type Task,
  type TaskProposal,
  exportProject as toProjectExport,
} from "@sacty/core";
import { ZodError } from "zod";
import type { ActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import {
  type AgentRole,
  buildInvocation,
  CONTAINER_CLAUDE_CONFIG_DIR,
  CONTAINER_CODEX_HOME,
} from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { redact, redactText } from "./agents/redact.js";
import type { TestRunner } from "./agents/test-runner.js";
import { type AgentConfig, type ConfigResult, githubRepoOf, type SactyConfig } from "./config.js";
import { type ContextFetcher, prepareContext } from "./context.js";
import { errorText, MessageError } from "./errors.js";
import {
  type GitHubAccount,
  type GitHubAuth,
  gitAuthEnv,
  gitAuthSecrets,
  isGitHubHttps,
} from "./gh.js";
import {
  type FoundIssue,
  githubStatus,
  type PullRequestFeedback,
  type PullRequestStatus,
  type PullRequests,
} from "./github.js";
import type { ProjectStore } from "./projects.js";
import {
  allowedPlans,
  buildChildBody,
  buildFinalReviewPrompt,
  buildGuardianPrompt,
  buildInvestigationComment,
  buildOrchestratorPrompt,
  buildPrompt,
  buildPullRequestBody,
  buildReviewBody,
  buildReviewComments,
  buildReworkPrompt,
  changeableSteps,
  EXECUTABLE_STEPS,
  extractBlocks,
  extractFinalReview,
  extractReproduction,
  extractReviewComments,
  extractRework,
  extractSplitPlan,
  extractStepPlan,
  extractVerdict,
  investigationMarker,
  REPRODUCTION_VIEWPOINT,
  REQUIREMENTS_VIEWPOINT,
  referencedPullRequest,
  reviewMarker,
  verificationBasis,
} from "./prompts.js";
import type { RepositoryWorkspace } from "./repository.js";
import { SecretNotFoundError, type SecretStore } from "./secrets.js";
import type { SettingsStore } from "./settings.js";

type ActivityItem = { actor: Actor; event: EventInput };

export type CleanupItem = { target: CleanupTarget; present: boolean; detail?: DaemonText };
type CleanupResult = {
  target: CleanupTarget;
  result: "done" | "skipped" | "failed";
  detail?: DaemonText;
};

/** 実装の検証（テストか最終レビュー）を待っているか。変更の申し出の判断待ちの間は検証しない。 */
function awaitingVerification(task: Task): boolean {
  return task.status === "idle" && task.verification !== undefined && !openProposal(task);
}

/** 状態に合わない操作（一時停止していないタスクの再開など）。APIでは409にする。 */
/** 状態に合わない操作。理由は文言のコードと引数で持ち、画面が画面の言語にする（PBI-11）。 */
export class InvalidOperationError extends Error {
  readonly messages: DaemonMessage[];
  constructor(...messages: [DaemonMessage, ...DaemonMessage[]]) {
    super(messages.map((m) => renderMessage(m, "ja")).join("\n"));
    this.messages = messages;
  }
}

export type ServiceDeps = {
  activity: ActivityStore;
  /** 呼ぶたびに設定を読み直す（デーモンを止めずに設定を変えられるように）。 */
  config: () => ConfigResult;
  secrets: SecretStore;
  executor: AgentExecutor;
  /** 実装の対象リポジトリの clone・差分・コミットとプッシュ。 */
  repos: RepositoryWorkspace;
  /** PRの作成。 */
  pulls: PullRequests;
  /** GitHub への認証（ホストの gh のアカウント。PBI-13）。 */
  github: GitHubAuth;
  /** 現在の時刻（テストで差し替える）。 */
  now?: () => number;
  /** オーケストレーターの代わりに工程を選ぶ（テストで差し替える。PBI-17）。 */
  planner?: (task: Task) => Promise<ChosenSteps>;
  /** プロジェクトの設定。 */
  projects: ProjectStore;
  /** sacty 全体の設定（取り込むラベルなど。PBI-26）。 */
  settings: SettingsStore;
  /** コンテキストリポジトリの取得（PBI-6）。 */
  contexts: ContextFetcher;
  /** sacty に同梱する既定のコンテキストのディレクトリ（PBI-24）。無ければ、プロジェクトのコンテキストだけを渡す。 */
  defaultContext?: string;
  /** テストの実行。 */
  tests: TestRunner;
  /** タスクごとの作業領域を作る場所。 */
  workspaceRoot: string;
};

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: DaemonText[];
  /** GitHub Issue の取り込みの状況（設定が無ければ null）。 */
  intake: IntakeStatus | null;
};

export type IntakeStatus = {
  /** 取り込むラベル（sacty の設定。PBI-26）。設定していなければ無い（取り込まない）。 */
  label?: string;
  lastRunAt?: string;
  /** 直近の取り込みで作ったタスクの数。 */
  imported?: number;
  /** 取り込めなかった取り込み元（検索の条件）と理由。 */
  errors?: { query?: string; message: DaemonText }[];
};

/** プロジェクトと、Org の取り込み元ごとの除外リポジトリ（ほかのプロジェクトが担当）。 */
export type ProjectView = {
  project: Project;
  exclusions: { org: string; repos: { repo: string; projectName: string }[] }[];
};

/**
 * タスクの読み書きの窓口。書き込みは必ず作業履歴への追記を通り、
 * 読み取り用の状態は作業履歴から復元したものを保持する。
 */
export class TaskService {
  private tasks: Map<string, Task>;

  private intakeStatus: IntakeStatus = {};
  /** 実行中のタスクと、そのタスクで動いているコンテナ（一時停止・中止で止めるため）。 */
  private readonly inflight = new Map<string, { runIds: Set<string>; done: Promise<void> }>();
  /** いま runNext が処理しているタスク（ワーカーは1件ずつ処理する）。 */
  private runningTask: string | undefined;
  /** 人間が一時停止・中止を求めたタスク。実行中の処理は、終わったら一時停止として記録する。 */
  private readonly pauseRequested = new Set<string>();
  /** 中止の後片付けをしているタスク（その間に実行を始めないため）。 */
  private readonly cancelling = new Set<string>();

  constructor(private readonly deps: ServiceDeps) {
    this.tasks = project(deps.activity.all());
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): { task: Task; activity: ActivityEvent[] } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { task, activity: this.deps.activity.forTask(id) };
  }

  /**
   * 成果物チェックで待っているタスクの PR の状態を確かめ、変化を記録する（PBI-14a）。
   * マージされたら成果物チェックを承認してタスクを完了にし、マージせずに閉じられたら記録して人間の判断を
   * 待つ（開き直されたら見守りを続ける）。PR は、プロジェクトの gh のアカウントで確かめる。
   * 確かめられないタスク（ネットワークやアカウントの問題）は、次の確認でやり直す。
   */
  async checkPullRequests(): Promise<void> {
    const waiting = [...this.tasks.values()].filter(
      (t) =>
        t.gate?.step === "pr" &&
        (t.status === "awaiting_approval" || t.status === "escalated") &&
        t.pullRequest?.number &&
        t.pullRequest.repo,
    );
    for (const task of waiting) {
      const pr = task.pullRequest;
      if (!pr?.number || !pr.repo) continue;
      const usedSecrets: string[] = [];
      let status: PullRequestStatus;
      let token: string;
      try {
        token = await this.githubToken(task, usedSecrets);
        status = await this.deps.pulls.status({ repo: pr.repo, token, number: pr.number });
      } catch (error) {
        console.warn(
          `[daemon] PR #${pr.number}（${pr.repo}）の状態を確認できませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
        continue;
      }
      // 確かめている間に、人間が差し戻した・中止したなどで変わっていれば、記録しない
      const latest = this.tasks.get(task.id);
      if (!latest) continue;
      if (
        latest.gate?.step !== "pr" ||
        (latest.status !== "awaiting_approval" && latest.status !== "escalated") ||
        latest.pullRequest?.number !== pr.number
      ) {
        continue;
      }
      const current = latest.pullRequestState ?? "open";
      if (
        status.state === current ||
        (status.state === "merged" && current === "merged_outdated")
      ) {
        // 開いたままの PR は、Request changes のレビューを指摘として取り込む（PBI-14b）
        if (status.state === "open" && latest.status === "awaiting_approval") {
          try {
            await this.importFeedback(latest, token);
          } catch (error) {
            console.warn(
              `[daemon] PR #${pr.number}（${pr.repo}）のレビューを取り込めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
            );
          }
        }
        continue;
      }
      // 承認にするのは、最新の提出（記録したコミット）がマージされたときだけ
      if (status.state === "merged" && status.headSha !== pr.commit) {
        this.append(latest, [
          {
            actor: "sacty",
            event: {
              type: "PullRequestMerged",
              payload: {
                number: pr.number,
                ...(status.mergedBy ? { by: status.mergedBy } : {}),
                ...(status.headSha ? { commit: status.headSha } : {}),
                outdated: true,
              },
            },
          },
        ]);
        continue;
      }
      if (status.state === "merged") {
        // マージは人間の承認なので、承認者は人間として記録する
        this.append(latest, [
          {
            actor: "person",
            event: {
              type: "PullRequestMerged",
              payload: {
                number: pr.number,
                ...(status.mergedBy ? { by: status.mergedBy } : {}),
                commit: pr.commit,
                outdated: false,
              },
            },
          },
          {
            actor: "person",
            event: { type: "StepApproved", payload: { step: "pr", next: "idle" } },
          },
        ]);
      } else if (status.state === "closed") {
        this.append(latest, [
          { actor: "sacty", event: { type: "PullRequestClosed", payload: { number: pr.number } } },
        ]);
      } else {
        this.append(latest, [
          {
            actor: "sacty",
            event: { type: "PullRequestReopened", payload: { number: pr.number } },
          },
        ]);
      }
    }
  }

  /**
   * PR へのフィードバック（レビュー・行ごとのコメント・通常のコメント）を指摘として取り込み、
   * ゴールガーディアンに戻し先を判断させて、差し戻すか人間の確認に回す（PBI-14b）。
   * まだ取り込んでいないものを、最後のフィードバックから一定の時間（書き終わるのを待つ）たってから、
   * まとめて取り込む。途中で止まっても、次の確認で続きから進める（判断・反映）。
   */
  private async importFeedback(task: Task, token: string): Promise<void> {
    const pr = task.pullRequest;
    if (!pr?.number || !pr.repo) return;
    let current = task;
    if (!current.pendingReview) {
      const fresh = (
        await this.deps.pulls.feedback({
          repo: pr.repo,
          token,
          number: pr.number,
          ...this.githubAccountOf(current),
        })
      ).filter((item) => !current.importedFeedback.includes(item.key));
      if (fresh.length === 0) return;
      // コメントは何件かに分けて書かれるので、最後のものから一定の時間たつまで待つ
      const newest = Math.max(...fresh.map((item) => Date.parse(item.at) || 0));
      if (this.now() - newest < FEEDBACK_QUIET_MS) return;
      // 一度に取り込むのは、指摘の件数の上限まで（古い順）。残りは取り込み済みにせず、次の取り込みに残す
      const batch = fresh.slice(0, REMARKS_MAX);
      const latest = this.tasks.get(task.id);
      if (latest?.status !== "awaiting_approval" || latest.pendingReview) return;
      current = this.append(latest, [
        {
          // レビューは人間の判断なので、人間の操作として記録する
          actor: "person",
          event: {
            type: "PullRequestReviewImported",
            payload: {
              number: pr.number,
              items: batch.map((item) => ({
                key: item.key,
                author: item.author,
                at: item.at,
                ...(item.url ? { url: item.url } : {}),
              })),
              remarks: feedbackRemarks(batch),
            },
          },
        },
      ]);
    }
    const pending = current.pendingReview;
    if (!pending) return;
    if (!pending.judgement) {
      const config = this.deps.config();
      if (!config.ok) return;
      const judged = await this.judgeRework(current, pending.remarks, config.config);
      // 判断の間に、人間が差し戻した・中止したなどで変わっていれば、記録しない
      const latest = this.tasks.get(task.id);
      if (
        !latest?.pendingReview ||
        latest.pendingReview.judgement ||
        latest.pendingReview.keys.join() !== pending.keys.join()
      ) {
        return;
      }
      current = this.append(latest, [
        { actor: "guardian", event: { type: "ReworkJudged", payload: judged } },
      ]);
    }
    this.settleReview(current);
  }

  /**
   * ゴールガーディアンの判断に従って、取り込んだ PR の指摘を反映する。実装だけなら差し戻し
   * （上限を超えるならエスカレーション）、設計・要求要件まで戻す・判断できないなら人間の確認に回す。
   */
  private settleReview(task: Task): void {
    const pending = task.pendingReview;
    const judgement = pending?.judgement;
    if (!pending || !judgement || task.gate?.step !== "pr" || task.status !== "awaiting_approval") {
      return;
    }
    if (judgement.target === "implement") {
      this.requestChanges(task.id, {
        step: "pr",
        submission: task.gate.submission,
        target: "implement",
        comments: pending.remarks,
      });
      return;
    }
    const target = judgement.target ?? "implement";
    const round = changeRounds(task, target) + 1;
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "TaskEscalated",
          payload: {
            step: "pr",
            target,
            reason: "rework_confirmation",
            note: judgement.reason,
            pendingRemarks: pending.remarks.map((text, i) => ({
              id: `${target}-${round}-${i + 1}`,
              text,
            })),
          },
        },
      },
    ]);
  }

  /**
   * ゴールガーディアンを、対象リポジトリのコードを読み取り専用で渡して実行する（PBI-16）。
   * base は起点のコミットのコード、implemented は実装後のコード（実装の作業領域。.git を除く）。
   * コードは実行ごとのディレクトリに書き出し、終わったら消す。書き出せなければ、実行の失敗として返す。
   */
  private async runGuardian(
    task: Task,
    run: { agent: AgentConfig; image: string; prompt: string; role: AgentRole },
    code: "base" | "implemented",
  ): Promise<Awaited<ReturnType<TaskService["execute"]>>> {
    const runId = randomUUID();
    const workspaceDir = join(this.deps.workspaceRoot, "_guardian", runId);
    try {
      if (task.repository) {
        try {
          if (code === "base") {
            await this.deps.repos.snapshot(
              this.trustedGitDir(task),
              task.repository.baseCommit,
              workspaceDir,
            );
          } else {
            await this.deps.repos.copyWorkingTree(this.repoDir(task), workspaceDir);
          }
        } catch (error) {
          return {
            outcome: { kind: "failed", reason: "error", message: errorText(error) },
            costUsd: 0,
            estimated: false,
          };
        }
      }
      return await this.execute({ ...run, runId, workspaceDir, readOnlyWorkspace: true });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  /**
   * 完了した調査の結果を、取り込み元の GitHub Issue にコメントとして返す（PBI-18）。
   * プロジェクトの gh のアカウントで返す。返せなければ理由を記録する（何度も返そうとしない）。
   */
  private async commentInvestigation(task: Task): Promise<void> {
    const source = task.source;
    // PR から取り込んだタスクも、PR の会話にコメントする（PR も Issue のコメントの API で返せる。PBI-26）
    if (!source) return;
    const usedSecrets: string[] = [];
    let event: EventInput;
    try {
      const token = await this.githubToken(task, usedSecrets);
      const target = { repo: source.repo, token, number: source.number };
      // 前回、投稿の後・記録の前に止まっていたら、そのコメントを使う（同じ結果を二度コメントしない）
      const existing = await this.deps.pulls.findIssueComment({
        ...target,
        marker: investigationMarker(task),
      });
      const { url } =
        existing ??
        (await this.deps.pulls.commentIssue({ ...target, body: buildInvestigationComment(task) }));
      event = { type: "IssueCommented", payload: { url } };
    } catch (error) {
      event = {
        type: "IssueCommentFailed",
        payload: { message: redactText(errorText(error), usedSecrets) },
      };
    }
    const latest = this.tasks.get(task.id);
    if (!latest || !awaitingIssueComment(latest)) return;
    this.append(latest, [{ actor: "sacty", event }]);
  }

  /**
   * レビューの工程の対象の PR を確かめる（PBI-19）。タスクにある、タスクの対象リポジトリの PR を、
   * プロジェクトの gh のアカウントで読む。確かめられなければ理由を返す（トークンは含めない）。
   */
  private async resolveReviewTarget(
    task: Task,
  ): Promise<
    | { ok: true; target: Extract<EventInput, { type: "ReviewTargetResolved" }>["payload"] }
    | { ok: false; message: DaemonText }
  > {
    const ref = referencedPullRequest(task);
    if (!ref) {
      const repo = (task.repository && githubRepoOf(task.repository.url)) ?? "";
      return { ok: false, message: message("review.pullRequestMissing", { repo }) };
    }
    const usedSecrets: string[] = [];
    try {
      const token = await this.githubToken(task, usedSecrets);
      const pr = await this.deps.pulls.pullRequest({ ...ref, token });
      return {
        ok: true,
        target: {
          repo: ref.repo,
          number: ref.number,
          url: pr.url,
          title: pr.title,
          body: pr.body,
          headCommit: pr.headSha,
          baseCommit: pr.baseSha,
        },
      };
    } catch (error) {
      return { ok: false, message: redactText(errorText(error), usedSecrets) };
    }
  }

  /**
   * 書いたレビューを、対象の PR にレビュー（COMMENT）として投稿する（PBI-19）。人間の承認は待たない。
   * 投稿するとタスクは完了する。投稿できなければ理由を記録して一時停止する（再開すると投稿からやり直す）。
   */
  private async postReview(task: Task): Promise<void> {
    const target = task.reviewTarget;
    if (!target) return;
    const usedSecrets: string[] = [];
    let event: EventInput;
    try {
      const token = await this.githubToken(task, usedSecrets);
      const account = this.githubAccountOf(task).account ?? "";
      const pr = { repo: target.repo, token, number: target.number };
      // 前回、投稿の後・記録の前に止まっていたら、そのレビューを使う（同じレビューを二度投稿しない）
      const existing = await this.deps.pulls.findReview({
        ...pr,
        account,
        marker: reviewMarker(task),
      });
      const post = (foldComments: boolean) =>
        this.deps.pulls.postReview({
          ...pr,
          commit: target.headCommit,
          body: buildReviewBody(task, { foldComments }),
          comments: foldComments ? [] : buildReviewComments(task),
        });
      const { url } =
        existing ??
        (await post(false).catch((error: unknown) => {
          // 行へのコメントを受け付けられなかった（行が差分に無いなど）なら、本文に入れて投稿し直す
          if (task.reviewComments.length > 0 && githubStatus(error) === 422) return post(true);
          throw error;
        }));
      event = { type: "PullRequestReviewPosted", payload: { url } };
    } catch (error) {
      event = {
        type: "TaskPaused",
        payload: { reason: "error", message: redactText(errorText(error), usedSecrets) },
      };
    }
    const latest = this.tasks.get(task.id);
    if (!latest || !awaitingReviewPost(latest) || this.pauseRequested.has(task.id)) return;
    this.append(latest, [{ actor: "sacty", event }]);
  }

  /**
   * オーケストレーターに、タスクの工程を選ばせる（PBI-17）。タスクの内容と対象リポジトリの起点のコードを
   * 読ませ、候補（STEP_PLANS）から選ばせる。人間の承認は無い。判断できない・実行に失敗したときは、
   * 標準の工程にして、そのことを記録する。テストでは deps.planner に差し替える。
   */
  private async chooseSteps(task: Task, config: SactyConfig): Promise<ChosenSteps> {
    if (this.deps.planner) return this.deps.planner(task);
    const agent = config.defaultAgent;
    const { outcome, costUsd, estimated } = await this.runGuardian(
      task,
      { agent, image: config.image, prompt: buildOrchestratorPrompt(task), role: "orchestrator" },
      "base",
    );
    const cost = { agentId: agent.id, usage: outcome.usage, costUsd, estimated };
    const chosen =
      outcome.kind === "completed"
        ? extractStepPlan(outcome.output, allowedPlans(task))
        : undefined;
    if (chosen) {
      return {
        steps: [...STEP_PLANS[chosen.plan]],
        plan: chosen.plan,
        reason: chosen.reason,
        fallback: false,
        ...(chosen.testCommand ? { testCommand: chosen.testCommand } : {}),
        ...(chosen.baseBranch ? { baseBranch: chosen.baseBranch } : {}),
        ...cost,
      };
    }
    return {
      steps: [...STEP_PLANS.standard],
      plan: "standard",
      reason: message("orchestrator.fallback", {
        detail: outcome.kind === "failed" ? outcome.message : message("orchestrator.unreadable"),
      }),
      fallback: true,
      ...cost,
    };
  }

  /** ゴールガーディアンに、PR の指摘の戻し先を判断させる（新しいセッション。PBI-14b）。 */
  private async judgeRework(
    task: Task,
    remarks: string[],
    config: SactyConfig,
  ): Promise<Extract<EventInput, { type: "ReworkJudged" }>["payload"]> {
    const agent = config.guardianAgent;
    const targets = reworkTargets(task, "pr");
    // 指摘が実装で直せるかを判断するので、実装後のコードを読ませる
    const { outcome, costUsd, estimated } = await this.runGuardian(
      task,
      {
        agent,
        image: config.image,
        prompt: buildReworkPrompt(task, remarks, targets),
        role: "rework",
      },
      "implemented",
    );
    const judgement =
      outcome.kind === "completed"
        ? extractRework(outcome.output, targets)
        : { reason: message("run.guardianFailed", { detail: outcome.message }) };
    return { ...judgement, agentId: agent.id, usage: outcome.usage, costUsd, estimated };
  }

  /** gh にログイン済みの GitHub のアカウント。gh が無いなどで分からなければ、その理由。 */
  async githubAccounts(): Promise<{ accounts: GitHubAccount[] } | { error: DaemonText }> {
    try {
      return { accounts: await this.deps.github.accounts() };
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  status(): DaemonStatus {
    const config = this.deps.config();
    if (!config.ok) return { agent: null, problems: [config.problem], intake: null };
    const agent = config.config.defaultAgent;
    return {
      agent: { id: agent.id, runtime: agent.runtime, authMode: agent.auth.mode },
      problems: [],
      intake: config.config.github
        ? { ...this.intakeStatus, ...this.labelOf(this.deps.settings.get()) }
        : null,
    };
  }

  listProjects(): Project[] {
    return this.deps.projects.all();
  }

  /** sacty 全体の設定（PBI-26）。 */
  getSettings(): SactySettings {
    return this.deps.settings.get();
  }

  /** sacty 全体の設定を変える。取り込むラベルが変わると、取り込みは先頭から読み直す。 */
  saveSettings(raw: unknown): SactySettings {
    return this.deps.settings.put(SactySettings.parse(raw));
  }

  private labelOf(settings: SactySettings): { label?: string } {
    return settings.intakeLabel ? { label: settings.intakeLabel } : {};
  }

  getProject(id: string): ProjectView | undefined {
    const project = this.deps.projects.get(id);
    if (!project) return undefined;
    const all = this.deps.projects.all();
    return {
      project,
      exclusions: project.targets
        .filter((t) => t.scope === "org")
        .map((t) => ({ org: t.target, repos: excludedRepositories(all, id, t.target) })),
    };
  }

  /**
   * プロジェクトの対象から選べる、タスクの対象リポジトリ（PBI-25）。リポジトリの対象はそれ自身、Org の対象は
   * プロジェクトの gh のアカウントで読んだその Org のリポジトリ（ほかのプロジェクトがリポジトリ単位で担当する
   * ものを除く）。読めなかった Org は、理由を返す（読めたものは返す）。
   */
  async projectRepositories(
    id: string,
  ): Promise<
    { repositories: string[]; errors: { owner: string; message: DaemonText }[] } | undefined
  > {
    const project = this.deps.projects.get(id);
    if (!project) return undefined;
    const all = this.deps.projects.all();
    const repositories = new Map<string, string>();
    const errors: { owner: string; message: DaemonText }[] = [];
    const add = (repo: string) => {
      if (responsibleProject(all, repo)?.project.id === id)
        repositories.set(repo.toLowerCase(), repo);
    };
    for (const target of project.targets) {
      if (target.scope === "repo") {
        add(target.target);
        continue;
      }
      const usedSecrets: string[] = [];
      try {
        const token = await this.githubToken({ projectId: id }, usedSecrets);
        for (const repo of await this.deps.pulls.repositories({ owner: target.target, token }))
          add(repo);
      } catch (error) {
        errors.push({ owner: target.target, message: redactText(errorText(error), usedSecrets) });
      }
    }
    return {
      repositories: [...repositories.values()].sort((a, b) => a.localeCompare(b)),
      errors,
    };
  }

  /** プロジェクトを作る、または変える。ほかのプロジェクトと対象が重複していれば拒否する。 */
  saveProject(id: string | undefined, raw: unknown): Project {
    const definition = ProjectDefinition.parse(raw);
    if (id && !this.deps.projects.get(id)) {
      throw new InvalidOperationError(message("project.notFound"));
    }
    const problems = projectConflicts(this.deps.projects.all(), id, definition);
    const [first, ...rest] = problems;
    if (first) throw new InvalidOperationError(first, ...rest);
    return this.deps.projects.put(id ?? randomUUID(), definition);
  }

  /** プロジェクトの定義をエクスポートする（個人の設定や秘密情報は含めない）。 */
  exportProject(id: string): ProjectExport | undefined {
    const project = this.deps.projects.get(id);
    return project ? toProjectExport(project) : undefined;
  }

  /**
   * エクスポートしたプロジェクトの定義を、新しいプロジェクトとしてインポートする。
   * 形式・版・知らない項目を検査し、ほかのプロジェクトと対象が重複していれば拒否する。
   */
  importProject(raw: unknown): Project {
    const { project } = ProjectExport.parse(raw);
    return this.saveProject(undefined, project);
  }

  /**
   * 対象ごとの取り込みの検索の条件と、検索に使う gh のアカウント（プロジェクトの設定。PBI-13）。
   * アカウントを選んでいないプロジェクトは、プロジェクトの名前を返す（取り込みで理由を示す）。
   * ラベルは sacty 全体の設定（PBI-26）。設定していなければ取り込まない。Issue と PR の両方を探す。
   */
  intakeSources(): { query: string; account?: string; project: string }[] {
    const label = this.deps.settings.get().intakeLabel;
    if (!label) return [];
    const sources = new Map<string, { query: string; account?: string; project: string }>();
    for (const project of this.deps.projects.all()) {
      for (const target of project.targets) {
        const where = target.scope === "org" ? `org:${target.target}` : `repo:${target.target}`;
        const query = `is:open ${where} label:"${label}"`;
        const account = project.githubAccount;
        sources.set(`${account ?? ""}\n${query}`, {
          query,
          ...(account ? { account } : {}),
          project: project.name,
        });
      }
    }
    return [...sources.values()];
  }

  /**
   * プロジェクトの設定と取り込むラベルの版。変わったら、取り込みは読んだ位置を忘れて先頭から読み直す。
   */
  projectsRevision(): string {
    return [
      `label:${this.deps.settings.get().intakeLabel ?? ""}`,
      ...this.deps.projects.all().map((p) => `${p.id}@${p.updatedAt}`),
    ].join(",");
  }

  recordIntake(status: IntakeStatus): void {
    this.intakeStatus = status;
  }

  /**
   * 見つかった Issue・PR をタスクにする。担当するプロジェクトは取り込むたびに判定し（範囲が狭い
   * 指定が優先）、取り込むラベル（sacty の設定）が付いたものだけを取り込む。同じものは二重に取り込まない。
   */
  importIssues(found: readonly FoundIssue[]): Task[] {
    const label = this.deps.settings.get().intakeLabel?.toLowerCase();
    if (!label) return [];
    const projects = this.deps.projects.all();
    const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
    const known = new Set(
      [...this.tasks.values()].flatMap((t) =>
        t.source ? [key(t.source.repo, t.source.number)] : [],
      ),
    );
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const created: Task[] = [];
    for (const issue of found) {
      if (known.has(key(issue.repo, issue.number))) continue;
      const responsible = responsibleProject(projects, issue.repo);
      if (!responsible) continue;
      if (!issue.labels.some((l) => l.toLowerCase() === label)) continue;
      // PR（PBI-26）は、Issue と同じ番号の空間なので、二重の判定はそのまま使える
      const kind = issue.pullRequest ? "github_pull_request" : "github_issue";
      known.add(key(issue.repo, issue.number));
      created.push(
        this.append({ id: randomUUID(), projectId: responsible.project.id }, [
          {
            actor: "sacty",
            event: {
              type: "TaskCreated",
              payload: {
                // Issue の本文とタイトルは切り詰めない（後ろに書かれた条件を失わないため。
                // GitHub 側の上限があるので、際限なく大きくはならない）
                title: issue.title.trim() || `${issue.repo}#${issue.number}`,
                body: issue.body,
                start: kind,
                budgetCapUsd,
                source: {
                  kind,
                  repo: issue.repo,
                  number: issue.number,
                  url: issue.url,
                },
              },
            },
          },
        ]),
      );
    }
    return created;
  }

  private append(
    task: Pick<Task, "id" | "projectId">,
    events: { actor: Actor; event: EventInput }[],
  ) {
    // 作業履歴に書く前に、状態の復元で受け付けられるかを確かめる（受け付けられないイベントを
    // 書いてしまうと、以降は作業履歴から状態を復元できず、デーモンが起動できなくなるため）
    let preview: Map<string, Task> = this.tasks;
    const at = new Date().toISOString();
    for (const [i, item] of events.entries()) {
      try {
        preview = applyEvent(preview, {
          ...EventInput.parse(item.event),
          seq: Number.MAX_SAFE_INTEGER - events.length + i,
          id: `preview-${i}`,
          taskId: task.id,
          projectId: task.projectId,
          at,
          actor: item.actor,
        });
      } catch (error) {
        if (error instanceof ZodError) throw error;
        throw new InvalidOperationError(message("task.invalidState"));
      }
    }
    const written = this.deps.activity.append({
      taskId: task.id,
      projectId: task.projectId,
      events,
    });
    for (const event of written) {
      this.tasks = applyEvent(this.tasks, event);
    }
    const updated = this.tasks.get(task.id);
    if (!updated) throw new Error("task is missing from the projection");
    return updated;
  }

  /** 画面からタスクを作る。作るプロジェクトは必ず指定する（既定のプロジェクトは無い。PBI-22）。 */
  createTask(raw: unknown): Task {
    const input = CreateTaskInput.parse(raw);
    const { projectId } = input;
    const project = this.deps.projects.get(projectId);
    if (!project) {
      throw new InvalidOperationError(message("project.notFound"));
    }
    // 対象リポジトリは、プロジェクトの対象（Org・リポジトリ）の中から選ぶ（PBI-25）。
    // 対象がリポジトリ1つだけなら、選ばなくてよい
    const [only, ...others] = project.targets;
    const wanted =
      input.repo ?? (only?.scope === "repo" && others.length === 0 ? only.target : undefined);
    if (project.targets.length === 0) {
      throw new InvalidOperationError(message("task.repositoryMissing", { project: project.name }));
    }
    const responsible =
      wanted && RepoName.safeParse(wanted).success
        ? responsibleProject(this.deps.projects.all(), wanted)
        : undefined;
    if (!wanted || responsible?.project.id !== projectId) {
      throw new InvalidOperationError(message("task.repositoryUnknown", { project: project.name }));
    }
    // リポジトリの対象なら、登録した名前にそろえる（大文字・小文字の違い）
    const repo = responsible.target.scope === "repo" ? responsible.target.target : wanted.trim();
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const { title, body } = input;
    return this.append({ id: randomUUID(), projectId }, [
      {
        actor: "person",
        event: {
          type: "TaskCreated",
          payload: { title, body, start: "sacty", repo, budgetCapUsd },
        },
      },
    ]);
  }

  /** 実行待ちのタスク（古い順）。 */
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  queuedTaskIds(): string[] {
    return [...this.tasks.values()]
      .filter((t) =>
        // 親が中止された子タスクは実行せず、中止する（親の中止の途中でデーモンが止まっても、
        // 再起動の後に中止を終えるため。PBI-27 レビュー指摘）
        this.parentCancelled(t)
          ? t.status !== "cancelled" && !isCompleted(t)
          : // 工程がまだ決まっていないタスクも、オーケストレーターが選ぶので実行対象にする（PBI-17）
            (t.status === "queued" && (activeStep(t) || t.steps.length === 0)) ||
            awaitingVerification(t) ||
            // 完了した調査の結果を、取り込み元の Issue に返す（PBI-18）
            awaitingIssueComment(t) ||
            // 書いたレビューを、対象の PR に投稿する（PBI-19）
            awaitingReviewPost(t) ||
            // 分割した子タスクを作る・始める、子タスクがすべて終わったら完了にする（PBI-27）
            this.splitPending(t) ||
            // 再現のテストを実行して、再現できたかを確かめる（PBI-29）
            awaitingReproductionCheck(t),
      )
      .filter((t) => !this.cancelling.has(t.id) && !this.pauseRequested.has(t.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => t.id);
  }

  /**
   * デーモンが止まって中断された実行を、失敗として記録して一時停止する。
   * 中断されたゴールガーディアンの判定は、判定できなかったものとして人間に判断してもらう。
   */
  recoverInterrupted(): void {
    for (const task of this.tasks.values()) {
      const judging = task.proposals.find((p) => !p.judgement);
      if (task.status === "idle" && judging) {
        this.append(task, [
          {
            actor: "sacty",
            event: {
              type: "ChangeJudged",
              payload: {
                proposalId: judging.id,
                verdict: "undecidable",
                reason: message("run.guardianInterrupted"),
                agentId: "unknown",
              },
            },
          },
          ...this.settleEvents(task, judging, undefined),
        ]);
        continue;
      }
      if (task.status === "idle" && this.resumeSettlement(task)) continue;
      if (task.status !== "running" || !task.currentRunId) continue;
      const step = activeStep(task) ?? "requirements";
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId: task.currentRunId,
              step,
              agentId: "unknown",
              reason: "error",
              message: message("run.daemonStopped"),
            },
          },
        },
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
      ]);
    }
  }

  /**
   * 実行できなかったために待機している工程を、実行待ちにする（起動時に呼ぶ）。
   * まだ一度も出力が無い工程だけが対象（PBI-7で承認され設計の工程が無かった、
   * PBI-8・9で設計が承認され実装の工程が無かった、PBI-10aで最終レビューに通り
   * PR作成の工程が無かったため待機していたタスクなど）。
   */
  queueWaitingSteps(): void {
    for (const task of this.tasks.values()) {
      const step = activeStep(task);
      if (task.status !== "idle" || !step || openProposal(task)) continue;
      if (!EXECUTABLE_STEPS.includes(step)) continue;
      if (task.outputs[step] !== undefined || task.verification) continue;
      if (step === "pr" && task.pullRequest) continue;
      this.append(task, [{ actor: "sacty", event: { type: "StepQueued", payload: { step } } }]);
    }
  }

  /** 実装の対象リポジトリの、タスクごとの clone の場所。 */
  private repoDir(task: Task): string {
    return join(this.deps.workspaceRoot, task.id, "repo");
  }

  /**
   * clone した直後の git のメタデータを退避する場所。どのコンテナにもマウントしない
   * （エージェントやテストが書き換えた git の設定を、差分を作るときに読まないため）。
   */
  private trustedGitDir(task: Task): string {
    return join(this.deps.workspaceRoot, "_git", `${task.id}.git`);
  }

  /**
   * タスクの実装の対象リポジトリと、その設定。GitHub Issue から取り込んだタスクは、その Issue の
   * リポジトリに実装し、設定はプロジェクトのリポジトリの設定を使う。手で作ったタスクは
   * config.yaml の repository を使う。
   */
  private targetRepository(
    task: Task,
    config: SactyConfig,
  ): { ok: true; repo: TargetRepository } | { ok: false; message: DaemonText } {
    // Issue から取り込んだタスクはその Issue のリポジトリ、画面で作ったタスクは作るときに選んだリポジトリ（PBI-21）。
    // 対象リポジトリを選ぶ前の版で作り、すでに clone したタスクは、記録した URL のリポジトリで続ける
    const repo = task.source
      ? task.source.repo
      : (task.repo ?? (task.repository && githubRepoOf(task.repository.url)));
    if (!repo) return { ok: false, message: message("run.repositoryNotConfigured") };
    // ベースブランチとテストのコマンドは、タスクの開始時にオーケストレーターが決める（PBI-25）。
    // PR は常に作る（PR作成許可の設定は無い）
    return {
      ok: true,
      repo: {
        url: `https://github.com/${repo}.git`,
        ...(task.repository ? { baseBranch: task.repository.baseBranch } : {}),
        ...(task.testCommand ? { testCommand: task.testCommand } : {}),
        testImage: config.image,
        pullRequest: { provider: "github" as const, repo },
      },
    };
  }

  /** 実装の対象リポジトリを用意する（初回だけ clone し、起点のコミットを作業履歴に記録する）。 */
  private async prepareRepository(
    task: Task,
    config: SactyConfig,
    /**
     * オーケストレーターが、既定のブランチとは違うベースブランチを選んだとき（PBI-25）。そのブランチの
     * 最新で用意し直し、その記録（RepositoryPrepared）は呼び出し側が工程の選択と一緒に書く。
     */
    rebase?: { branch: string },
  ): Promise<
    | { ok: true; dir: string; prepared?: { url: string; baseBranch: string; baseCommit: string } }
    | { ok: false; message: DaemonText }
  > {
    const dir = this.repoDir(task);
    if (!rebase && task.repository && existsSync(dir) && existsSync(this.trustedGitDir(task))) {
      return { ok: true, dir };
    }
    const target = this.targetRepository(task, config);
    if (!target.ok && !task.repository) return target;
    const repo = target.ok ? target.repo : undefined;
    // 一度用意したタスクは、設定が変わっても同じリポジトリ・ブランチで作業する。
    // 初めて用意するときは、ブランチを指定せずに既定のブランチを clone する
    const url = task.repository?.url ?? repo?.url ?? "";
    const branch = rebase?.branch ?? task.repository?.baseBranch;
    const usedSecrets: string[] = [];
    try {
      const prepared = await this.deps.repos.prepare(
        dir,
        this.trustedGitDir(task),
        url,
        branch,
        await this.gitAuth(task, url, usedSecrets),
        // 用意し直すとき（作業領域が消えた）は、記録済みの起点のコミットで用意する（PBI-15）
        rebase ? undefined : task.repository?.baseCommit,
      );
      const { baseCommit, baseBranch } = prepared;
      if (rebase) return { ok: true, dir, prepared: { url, baseBranch, baseCommit } };
      // 起点はタスクの開始時に一度だけ記録し、以後は変えない
      if (!task.repository) {
        this.append(task, [
          {
            actor: "sacty",
            event: { type: "RepositoryPrepared", payload: { url, baseBranch, baseCommit } },
          },
        ]);
      } else if (baseCommit !== task.repository.baseCommit) {
        throw new MessageError(
          message("git.baseCommitMissing", { commit: task.repository.baseCommit }),
        );
      }
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, message: redactText(errorText(error), usedSecrets) };
    }
  }

  /**
   * タスクのプロジェクトに設定した gh のアカウントで、GitHub のトークンを取り出す（PBI-13）。
   * アカウントを選んでいなければ、理由つきで止める（アクティブなアカウントは切り替わるので使わない）。
   * 取り出した値は、出力やエラー文から取り除く対象にする。
   */
  private async githubToken(task: Pick<Task, "projectId">, usedSecrets: string[]): Promise<string> {
    const project = this.deps.projects.get(task.projectId);
    if (!project?.githubAccount) {
      throw new MessageError(
        message("github.accountRequired", { project: project?.name ?? task.projectId }),
      );
    }
    const token = await this.deps.github.token(project.githubAccount);
    usedSecrets.push(...gitAuthSecrets(token));
    return token;
  }

  /** タスクのプロジェクトで選んだ gh のアカウント（選んでいなければ空）。 */
  private githubAccountOf(task: Task): { account?: string } {
    const account = this.deps.projects.get(task.projectId)?.githubAccount;
    return account ? { account } : {};
  }

  /** HTTPS の GitHub なら、gh のトークンで git を認証する環境変数。それ以外はホストの認証を使う。 */
  private async gitAuth(
    task: Task,
    url: string,
    usedSecrets: string[],
  ): Promise<Record<string, string> | undefined> {
    return isGitHubHttps(url) ? gitAuthEnv(await this.githubToken(task, usedSecrets)) : undefined;
  }

  /**
   * 実行待ちのタスクの、現在の工程をエージェントで実行する（実装の検証待ちなら、検証する）。
   * 実行中に人間が一時停止を求めたら、終わったところで一時停止として記録する。
   */
  async runNext(taskId: string): Promise<void> {
    if (this.cancelling.has(taskId) || this.pauseRequested.has(taskId)) return;
    const task = this.tasks.get(taskId);
    if (task && this.parentCancelled(task)) {
      if (task.status === "cancelled" || isCompleted(task)) return;
      // 実行の印（inflight）を付ける前に中止する（中止は、実行中の処理の終わりを待つため）
      await this.cancel(taskId).catch((error) => {
        console.error(`[daemon] could not cancel subtask ${taskId}:`, error);
      });
      return;
    }
    const entry = { runIds: new Set<string>(), done: Promise.resolve() };
    this.inflight.set(taskId, entry);
    this.runningTask = taskId;
    // 完了は、止めたコンテナの確認と一時停止の記録まで含める（一時停止・中止はこれを待つ）
    entry.done = (async () => {
      try {
        await this.runNextInner(taskId);
      } finally {
        this.runningTask = undefined;
        if (this.pauseRequested.has(taskId)) {
          // 止めたコンテナが本当に無くなったかを確かめてから、一時停止を記録する
          this.pauseIfRequested(taskId, await this.unstopped(entry.runIds));
        }
      }
    })();
    try {
      await entry.done;
    } finally {
      this.inflight.delete(taskId);
    }
  }

  /** 止めたコンテナのうち、無くなったことを確かめられなかったもの（の実行）。 */
  private async unstopped(runIds: Iterable<string>): Promise<string[]> {
    const list = [...runIds];
    const results = await Promise.all(list.map((runId) => this.deps.executor.ensureStopped(runId)));
    return list.filter((_, i) => !results[i]);
  }

  private async confirmStopped(runIds: Iterable<string>): Promise<boolean> {
    return (await this.unstopped(runIds)).length === 0;
  }

  private notStopped(runIds: Iterable<string>): DaemonMessage {
    const names = [...runIds].map((r) => `sacty-run-${r}`).join(", ");
    return message("containers.notStopped", { names });
  }

  /** 一時停止を求められていて、止められる状態なら、人間の一時停止として記録する。 */
  private pauseIfRequested(taskId: string, unstoppedRuns: string[] = []): void {
    if (!this.pauseRequested.has(taskId)) return;
    this.pauseRequested.delete(taskId);
    const task = this.tasks.get(taskId);
    if (task?.status !== "queued" && task?.status !== "idle") return;
    this.append(task, [
      {
        actor: "person",
        event: {
          type: "TaskPaused",
          payload: { reason: "manual", ...this.unstoppedPayload(unstoppedRuns) },
        },
      },
    ]);
  }

  /**
   * 人間が止めた実行の、一時停止に添える説明。止めたコンテナが無くなったことを確かめられなければ、
   * その旨を返す（再開する前に確かめてもらうため）。
   */
  private async manualPauseInfo(
    taskId: string,
  ): Promise<{ message?: DaemonText; unstoppedRuns?: string[] }> {
    if (!this.pauseRequested.has(taskId)) return {};
    return this.unstoppedPayload(await this.unstopped(this.inflight.get(taskId)?.runIds ?? []));
  }

  /** 停止を確かめられなかった実行を、一時停止の記録に添える形にする。 */
  private unstoppedPayload(runs: string[]): { message?: DaemonText; unstoppedRuns?: string[] } {
    return runs.length > 0 ? { message: this.notStopped(runs), unstoppedRuns: runs } : {};
  }

  /** 実行の失敗で止めるときの理由。人間が止めた（コンテナを止めた）のなら、人間の一時停止。 */
  private stopReason(taskId: string, reason: PauseReason): PauseReason {
    return this.pauseRequested.has(taskId) ? "manual" : reason;
  }

  private async runNextInner(taskId: string): Promise<void> {
    const initial = this.tasks.get(taskId);
    if (initial && awaitingVerification(initial)) return this.verify(initial);
    if (initial && awaitingIssueComment(initial)) return this.commentInvestigation(initial);
    if (initial && awaitingReviewPost(initial)) return this.postReview(initial);
    if (initial && this.splitPending(initial)) return this.settleSplit(initial);
    if (initial && awaitingReproductionCheck(initial)) return this.checkReproduction(initial);
    if (initial?.status !== "queued") return;
    const config = this.deps.config();
    if (!config.ok) return; // 設定の問題は status() で画面に出す。タスクは実行待ちのまま。

    // 対象リポジトリは、タスクの開始時（最初の実行）に、ベースブランチの最新を用意する（PBI-15）。
    // どの工程から始まるタスクでも同じ。以後はその起点のコミットを最後まで使う（途中で取り込み直さない）。
    // 用意できなければ、エージェントを実行する（費用をかける）前に、理由を記録して止める
    if (!initial.repository) {
      const ready = await this.prepareRepository(initial, config.config);
      if (!ready.ok) {
        this.append(initial, [
          {
            actor: "sacty",
            event: { type: "TaskPaused", payload: { reason: "error", message: ready.message } },
          },
        ]);
        return;
      }
    }

    // 工程がまだ決まっていなければ、オーケストレーターがタスクの内容とリポジトリを読んで選ぶ（PBI-17）
    if (this.mustGet(taskId).steps.length === 0) {
      if (budgetState(this.mustGet(taskId).budget) === "exceeded") {
        this.append(this.mustGet(taskId), [
          { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
        ]);
        return;
      }
      const { baseBranch, ...chosen } = await this.chooseSteps(this.mustGet(taskId), config.config);
      // 既定のブランチと違うベースブランチを選んだなら、そのブランチの最新で用意し直す（PBI-25）。
      // 用意できなければ、既定のブランチのまま進め、そのことを理由に添える
      const prepared = this.mustGet(taskId).repository;
      const rebased =
        baseBranch && prepared && baseBranch !== prepared.baseBranch
          ? await this.prepareRepository(this.mustGet(taskId), config.config, {
              branch: baseBranch,
            })
          : undefined;
      // 選んでいる間に、人間が止めた・中止したなら、記録しない（止めた記録は runNext の後始末で行う）
      const latest = this.mustGet(taskId);
      if (
        this.pauseRequested.has(taskId) ||
        this.cancelling.has(taskId) ||
        latest.status !== "queued" ||
        latest.steps.length > 0
      ) {
        return;
      }
      const events: ActivityItem[] = [];
      if (rebased?.ok && rebased.prepared) {
        events.push({
          actor: "sacty",
          event: { type: "RepositoryPrepared", payload: rebased.prepared },
        });
      } else if (rebased && !rebased.ok && baseBranch) {
        chosen.reason = message("orchestrator.baseBranchUnavailable", {
          branch: baseBranch,
          detail: rebased.message,
        });
      }
      events.push({ actor: "orchestrator", event: { type: "StepsChosen", payload: chosen } });
      // 実装を含むのにテストのコマンドが分からなければ、検証できないので費用をかける前に止める（PBI-25）
      if (chosen.steps.includes("implement") && !chosen.testCommand) {
        events.push({
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: message("orchestrator.testCommandUnknown") },
          },
        });
      }
      this.append(latest, events);
    }
    const task = this.mustGet(taskId);
    if (task.status !== "queued") return;
    const step = activeStep(task);
    if (!step) return;

    // PR作成は、エージェントではなく sacty が行う
    if (step === "pr") return this.publish(this.mustGet(task.id), config.config);

    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return;
    }

    // レビューの工程は、エージェントを実行する（費用をかける）前に、対象の PR を確かめて記録する（PBI-19）
    if (step === "review" && !task.reviewTarget) {
      const resolved = await this.resolveReviewTarget(task);
      const latest = this.mustGet(task.id);
      if (latest.status !== "queued" || this.pauseRequested.has(task.id)) return;
      this.append(
        latest,
        resolved.ok
          ? [{ actor: "sacty", event: { type: "ReviewTargetResolved", payload: resolved.target } }]
          : [
              {
                actor: "sacty",
                event: {
                  type: "TaskPaused",
                  payload: { reason: "error", message: resolved.message },
                },
              },
            ],
      );
      if (!resolved.ok) return;
    }

    const agent = config.config.defaultAgent;
    const runId = randomUUID();
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: { runId, step, agentId: agent.id, authMode: agent.auth.mode },
        },
      },
    ]);

    // 実装の工程は clone を作業領域にし、それ以外の工程は、起点のコミットのコードを読み取り専用で渡す
    // （clone はタスクの開始時に済んでいる。作業領域が消えていれば、同じ起点で用意し直す）
    const ready = await this.prepareRepository(this.mustGet(task.id), config.config);
    if (!ready.ok) {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: { runId, step, agentId: agent.id, reason: "error", message: ready.message },
          },
        },
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
      ]);
      return;
    }
    // 実装と再現（再現のテストを書く。PBI-29）は clone を作業領域にし、ほかは読み取り専用
    const readOnlyWorkspace = step !== "implement" && step !== "reproduce";

    // sacty の既定のコンテキストと、プロジェクトのコンテキストを取得・合成して渡し、
    // 使ったリポジトリとコミット（既定は中身のハッシュ）を記録する
    const contextSource = this.deps.projects.get(task.projectId)?.context;
    const defaultContext = this.deps.defaultContext;
    let context: Awaited<ReturnType<typeof prepareContext>> | undefined;
    if (contextSource || defaultContext) {
      // コンテキストと継承の各リポジトリも、HTTPS の GitHub はプロジェクトの gh のアカウントで取得する
      const usedSecrets: string[] = [];
      try {
        context = await prepareContext(
          this.deps.contexts,
          contextSource,
          agent.runtime === "codex" ? "codex" : "claude-code",
          agent.runtime === "codex" ? CONTAINER_CODEX_HOME : CONTAINER_CLAUDE_CONFIG_DIR,
          (repo) => this.gitAuth(task, repo, usedSecrets),
          defaultContext,
        );
      } catch (error) {
        this.append(task, [
          {
            actor: "sacty",
            event: {
              type: "AgentRunFailed",
              payload: {
                runId,
                step,
                agentId: agent.id,
                reason: "error",
                message: redactText(errorText(error), usedSecrets),
              },
            },
          },
          { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
        ]);
        return;
      }
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "ContextResolved",
            payload: { runId, layers: context.layers, warnings: context.warnings },
          },
        },
      ]);
    }

    let executed: Awaited<ReturnType<TaskService["execute"]>> | undefined;
    // レビューの工程は、起点ではなく PR の先頭のコミットのコードを読ませ、PR の差分を渡す（PBI-19）
    const reviewTarget = step === "review" ? this.mustGet(task.id).reviewTarget : undefined;
    let reviewDiff: string | undefined;
    // 要求要件・設計の工程は、起点のコミットのコードを実行ごとのディレクトリに書き出して渡し、終わったら消す
    // （実装の作業領域は実装の変更を含むので使わない。差し戻しでやり直しても、同じ起点のコードを読む）
    const snapshotDir = readOnlyWorkspace
      ? join(this.deps.workspaceRoot, "_snapshots", runId)
      : undefined;
    try {
      if (snapshotDir) {
        const latest = this.mustGet(task.id);
        const usedSecrets: string[] = [];
        try {
          if (reviewTarget) {
            const gitDir = this.trustedGitDir(latest);
            await this.deps.repos.fetchCommits(
              gitDir,
              [reviewTarget.headCommit, reviewTarget.baseCommit],
              await this.gitAuth(latest, latest.repository?.url ?? "", usedSecrets),
            );
            reviewDiff = await this.deps.repos.diffCommits(
              gitDir,
              reviewTarget.baseCommit,
              reviewTarget.headCommit,
            );
          }
          await this.deps.repos.snapshot(
            this.trustedGitDir(latest),
            reviewTarget?.headCommit ?? latest.repository?.baseCommit ?? "",
            snapshotDir,
          );
        } catch (error) {
          executed = {
            outcome: {
              kind: "failed",
              reason: "error",
              message: redactText(errorText(error), usedSecrets),
            },
            costUsd: 0,
            estimated: false,
          };
        }
      }
      executed ??= await this.execute({
        agent,
        image: config.config.image,
        runId,
        prompt: buildPrompt(
          this.mustGet(task.id),
          step,
          reviewDiff !== undefined ? { diff: reviewDiff } : {},
        ),
        role: step,
        workspaceDir: snapshotDir ?? ready.dir,
        readOnlyWorkspace,
        context: context && { dir: context.dir, ...context.placed },
      });
    } finally {
      context?.dispose();
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = executed;

    if (outcome.kind === "failed") {
      const manual = await this.manualPauseInfo(task.id);
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId,
              step,
              agentId: agent.id,
              reason: outcome.reason,
              message: outcome.message,
              usage: outcome.usage,
              costUsd,
              estimated,
            },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: this.stopReason(task.id, outcome.reason),
              ...manual,
            },
          },
        },
      ]);
      // 失敗した実行の費用でも、80%の通知は判定する（一時停止はすでにしている）
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }

    const latest = this.mustGet(task.id);
    // タスク分割は、子タスクの一覧を確かめて記録し、子タスクを作る（PBI-27）
    if (step === "split") {
      const plan = extractSplitPlan(outcome.output);
      const run = { runId, step, agentId: agent.id, costUsd, estimated, usage: outcome.usage };
      if (!plan.ok) {
        this.append(latest, [
          {
            actor: "sacty",
            event: {
              type: "AgentRunFailed",
              payload: { ...run, reason: "error", message: plan.message },
            },
          },
          { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
        ]);
        this.warnIfNeeded(this.mustGet(task.id));
        return;
      }
      const ids = new Map(plan.children.map((c) => [c.key, randomUUID()]));
      const titles = new Map(plan.children.map((c) => [c.key, c.title]));
      const split = this.append(latest, [
        {
          actor: "agent",
          event: {
            type: "AgentRunCompleted",
            payload: { ...run, authMode: agent.auth.mode, output: outcome.output },
          },
        },
        {
          actor: "agent",
          event: {
            type: "TaskSplit",
            payload: {
              reason: plan.reason,
              children: plan.children.map((c) => ({
                taskId: ids.get(c.key) ?? "",
                title: c.title,
                body: buildChildBody(latest, c, titles),
                dependsOn: c.dependsOn.map((d) => ids.get(d) ?? ""),
              })),
            },
          },
        },
      ]);
      this.checkBudget(split);
      return this.settleSplit(this.mustGet(task.id));
    }
    const extracted = extractBlocks(
      outcome.output,
      new Set(latest.remarks.filter((r) => r.step === step && !r.voided).map((r) => r.id)),
      changeableSteps(latest, step),
    );
    const { responses, testViewpoints, proposal, testMap } = extracted;
    // レビューの工程は、PR の差分に含まれる行へのコメントを取り出す（差分の外のものは本文に入れる）
    const review =
      step === "review" ? extractReviewComments(extracted.output, reviewDiff ?? "") : undefined;
    // 再現の工程は、申告された再現のテストを取り出す（PBI-29）
    const reproduction = step === "reproduce" ? extractReproduction(extracted.output) : undefined;
    const output = review?.output ?? reproduction?.output ?? extracted.output;
    const events: { actor: Actor; event: EventInput }[] = [
      {
        actor: "agent",
        event: {
          type: "AgentRunCompleted",
          payload: {
            runId,
            step,
            agentId: agent.id,
            authMode: agent.auth.mode,
            usage: outcome.usage,
            costUsd,
            estimated,
            output,
            responses,
            ...(step === "design" ? { testViewpoints } : {}),
            ...(step === "implement" ? { testMap } : {}),
            ...(review ? { reviewComments: review.comments } : {}),
            ...(reproduction ? { reproductionTests: reproduction.tests } : {}),
          },
        },
      },
    ];
    if (!proposal) {
      // 実行の完了と提出は、同じトランザクションで記録する
      const submitted = this.append(task, [...events, ...this.submitEvents(latest, step)]);
      this.checkBudget(submitted);
      // 再現は、続けて sacty がテストを実行して確かめる（PBI-29）
      if (awaitingReproductionCheck(submitted)) return this.checkReproduction(submitted);
      return;
    }

    // 承認済みの成果物への変更の申し出は、提出の前にゴールガーディアンが判定する
    const proposalId = `CP-${latest.proposals.length + 1}`;
    events.push({
      actor: "agent",
      event: { type: "ChangeProposed", payload: { proposalId, fromStep: step, ...proposal } },
    });
    const proposed = this.append(task, events);
    const judged = proposed.proposals.find((p) => p.id === proposalId);
    if (!judged) throw new Error(`proposal ${proposalId} is missing`);
    const judgement = await this.judge(proposed, judged, config.config);
    // 判定と、その後始末（エスカレーション・反映・提出）は同じトランザクションで記録する。
    // 間でデーモンが止まると、判定済みなのにどの状態にも進まないタスクが残るため。
    const accepted =
      judgement.verdict === "approved"
        ? true
        : judgement.verdict === "rejected"
          ? false
          : undefined;
    this.checkBudget(
      this.append(proposed, [
        { actor: "guardian", event: { type: "ChangeJudged", payload: judgement } },
        ...this.settleEvents(proposed, judged, accepted),
      ]),
    );
  }

  /**
   * 実装を検証する。sacty がテストを別のコンテナで実行し（終了コード0かつ、すべての観点に
   * テストが対応していれば合格）、通ればゴールガーディアンが新しいセッションで最終レビューする。
   * 通らなければ失敗の内容を渡して実装をやり直し、続けて通らなければ一時停止する。
   */
  private async verify(task: Task): Promise<void> {
    const config = this.deps.config();
    if (!config.ok) return;
    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return;
    }
    const target = this.targetRepository(task, config.config);
    const dir = this.repoDir(task);
    if (
      !target.ok ||
      !task.repository ||
      !existsSync(dir) ||
      !existsSync(this.trustedGitDir(task))
    ) {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: !target.ok
                ? message("verify.testsUnavailable", { detail: target.message })
                : message("verify.workspaceMissing"),
            },
          },
        },
      ]);
      return;
    }
    const repo = target.repo;
    const testCommand = repo.testCommand;
    // テストのコマンドはオーケストレーターが決める（PBI-25）。分からなければ検証できないので止める
    if (!testCommand) {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: message("orchestrator.testCommandUnknown") },
          },
        },
      ]);
      return;
    }
    // テストを対応させる観点。設計を省いたタスク（PBI-17）は、要求要件の受け入れ条件（REQ）を観点にする。
    // テストの対応の確かめと、最終レビューの両方で同じ観点を使う
    // 不具合の修正（PBI-29）は、再現のテストが通ること（REPRO）を観点にする
    const basis = verificationBasis(task);
    const viewpointIds =
      basis === "design"
        ? (task.approved.design?.testViewpoints ?? []).map((v) => v.id)
        : basis === "reproduce"
          ? [REPRODUCTION_VIEWPOINT]
          : [REQUIREMENTS_VIEWPOINT];

    let current = task;
    if (current.verification === "pending") {
      const mapped = new Set(current.testMap.map((m) => m.viewpointId));
      const unmappedViewpoints = viewpointIds.filter((id) => !mapped.has(id));
      // 人間が止めたなら、テストのコンテナを起動しない（再開するとテストからやり直す）
      if (this.pauseRequested.has(task.id)) return;
      const testRunId = randomUUID();
      this.track(testRunId);
      const result = await this.deps.tests.run({
        runId: testRunId,
        image: repo.testImage,
        workspaceDir: dir,
        command: testCommand,
      });
      // 人間が止めた（コンテナを止めた）テストの結果は記録しない。再開するとテストからやり直す
      if (this.pauseRequested.has(task.id)) return;
      const passed = result.exitCode === 0 && unmappedViewpoints.length === 0;
      current = this.append(current, [
        {
          actor: "sacty",
          event: {
            type: "TestsRun",
            payload: {
              command: testCommand,
              exitCode: result.exitCode,
              unmappedViewpoints,
              passed,
              output: result.output,
              ...(result.note ? { note: result.note } : {}),
              durationMs: result.durationMs,
            },
          },
        },
      ]);
      if (!passed) {
        this.pauseIfVerificationKeepsFailing(current);
        return;
      }
    }

    // 差分は、テストが観点を検証しているかを判断するのに欠かせない。取れなければ最終レビューをせずに止める
    // （再開すると、差分の取得からやり直す）
    let diff: string;
    try {
      diff = await this.deps.repos.diff(dir, this.trustedGitDir(task), task.repository.baseCommit);
    } catch (error) {
      this.append(current, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: message("verify.diffUnavailable", { detail: errorText(error) }),
            },
          },
        },
      ]);
      return;
    }
    const agent = config.config.guardianAgent;
    // 最終レビューは、実装後のコードを読み取り専用で読ませる（差分もこれまでどおり渡す）
    const { outcome, costUsd, estimated } = await this.runGuardian(
      current,
      {
        agent,
        image: config.config.image,
        prompt: buildFinalReviewPrompt(current, diff),
        role: "final-review",
      },
      "implemented",
    );
    if (outcome.kind === "failed") {
      // 実装の問題ではないので、やり直さずに止める。再開すると最終レビューからやり直す。
      // 使った分の費用は記録し、予算に入れる
      const failure = message("verify.finalReviewFailed", { detail: outcome.message });
      this.append(current, [
        {
          actor: "guardian",
          event: {
            type: "FinalReviewFailed",
            payload: {
              reason: outcome.reason,
              message: failure,
              agentId: agent.id,
              usage: outcome.usage,
              costUsd,
              estimated,
            },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: this.stopReason(task.id, outcome.reason),
              message: failure,
              ...(await this.manualPauseInfo(task.id)),
            },
          },
        },
      ]);
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }
    const review = extractFinalReview(
      outcome.output,
      viewpointIds,
      current.remarks.filter((r) => !r.voided).map((r) => r.id),
    );
    const reviewed = this.append(current, [
      {
        actor: "guardian",
        event: {
          type: "FinalReviewed",
          payload: { ...review, agentId: agent.id, usage: outcome.usage, costUsd, estimated },
        },
      },
    ]);
    if (review.passed) this.checkBudget(reviewed);
    else this.pauseIfVerificationKeepsFailing(reviewed);
  }

  /**
   * 作業をコミットして sacty のブランチにプッシュし、PRを作って（設定があれば）、
   * 成果物チェックのゲートで止める。コミットは、エージェントが触れない退避した git の
   * メタデータで作る。失敗したら理由を記録して止める（再開するとやり直す）。
   */
  private async publish(task: Task, config: SactyConfig): Promise<void> {
    const target = this.targetRepository(task, config);
    const dir = this.repoDir(task);
    const gitDir = this.trustedGitDir(task);
    const usedSecrets: string[] = [];
    const fail = (text: DaemonText) =>
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: redactText(text, usedSecrets) },
          },
        },
      ]);
    if (!target.ok) {
      fail(message("pr.unavailable", { detail: target.message }));
      return;
    }
    if (!task.repository || !existsSync(dir) || !existsSync(gitDir)) {
      fail(message("pr.workspaceMissing"));
      return;
    }
    const repo = target.repo;
    const branch = task.pullRequest?.branch ?? `sacty/task-${task.id.slice(0, 8)}`;
    try {
      const { commit } = await this.deps.repos.publish({
        dir,
        gitDir,
        baseCommit: task.repository.baseCommit,
        parent: task.pullRequest?.commit ?? task.repository.baseCommit,
        branch,
        message: `${task.title}\n\nsacty task ${task.id}`,
        // 提出ごとに決まる日時にして、再開しても同じコミットを作る（プッシュ済みなら何も変わらない）
        // （PR作成の工程は最終レビューに通った後なので、通常は最終レビューの日時になる）
        date: task.lastReview?.at ?? task.createdAt,
        authEnv: await this.gitAuth(task, task.repository.url, usedSecrets),
      });
      // PRの作成の前に、プッシュしたブランチを記録する（PRの作成に失敗しても、中止で片付けられるように）
      if (task.pushedBranch?.commit !== commit || task.pushedBranch.branch !== branch) {
        this.append(task, [
          { actor: "sacty", event: { type: "BranchPushed", payload: { branch, commit } } },
        ]);
      }
      // PR は常に作る（PR作成許可の設定は無い。PBI-25）
      const token = await this.githubToken(task, usedSecrets);
      const prRepo = repo.pullRequest.repo;
      // 前の PR がすでにマージされていれば、作り直した内容は新しい PR で出す
      // （マージ済みの PR を更新しても、マージされていない内容が完了扱いになってしまうため）
      let number = task.pullRequest?.number;
      if (number && task.pullRequest?.repo === prRepo) {
        const previous = await this.deps.pulls.status({ repo: prRepo, token, number });
        if (previous.state === "merged") number = undefined;
      }
      const pr = await this.deps.pulls.upsert({
        repo: prRepo,
        token,
        branch,
        baseBranch: task.repository.baseBranch,
        title: task.title,
        body: buildPullRequestBody(task),
        number,
      });
      const submitted = this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "PullRequestPublished",
            payload: {
              branch,
              commit,
              url: pr.url,
              number: pr.number,
              repo: prRepo,
            },
          },
        },
        ...this.submitEvents(task, "pr"),
      ]);
      this.checkBudget(submitted);
    } catch (error) {
      fail(message("pr.failed", { detail: errorText(error) }));
    }
  }

  /** 検証が続けて通らなければ、実装のやり直しを止めて人間に判断してもらう。 */
  private pauseIfVerificationKeepsFailing(task: Task): void {
    if (task.verifyFailures < MAX_VERIFY_ATTEMPTS) return;
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: {
            reason: "verification",
            message: message("verify.tooManyAttempts", { count: MAX_VERIFY_ATTEMPTS }),
          },
        },
      },
    ]);
  }

  /** 実行中のタスクのコンテナとして覚える（一時停止・中止で止めるため）。 */
  private track(runId: string): void {
    if (this.runningTask) this.inflight.get(this.runningTask)?.runIds.add(runId);
  }

  /**
   * 人間が一時停止する。実行中ならコンテナを止め、処理が終わるのを待ってから一時停止として記録する
   * （作業領域は残すので、再開すると止まった工程からやり直す）。
   */
  async pause(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    if (task.status === "paused") throw new InvalidOperationError(message("pause.alreadyPaused"));
    if (task.status === "awaiting_approval" || task.status === "escalated") {
      throw new InvalidOperationError(message("pause.awaitingPerson"));
    }
    if (task.status === "blocked" || task.status === "waiting_children") {
      throw new InvalidOperationError(message("pause.waitingTasks"));
    }
    const judging = openProposal(task);
    if (judging && !judging.judgement) {
      throw new InvalidOperationError(message("pause.guardianJudging"));
    }
    this.pauseRequested.add(id);
    const inflight = this.inflight.get(id);
    if (inflight) {
      this.stopRuns(inflight.runIds);
      await inflight.done.catch(() => {});
      // 記録は runNext の後始末で行う
      return this.mustGet(id);
    }
    this.pauseIfRequested(id);
    return this.mustGet(id);
  }

  private stopRuns(runIds: Iterable<string>): void {
    for (const runId of runIds) {
      this.deps.executor.kill(runId);
      this.deps.tests.kill(runId);
    }
  }

  /**
   * 一時停止のときに停止を確かめられなかったコンテナが、いまは無くなっているかを確かめる
   * （残っていれば止める）。そのようなコンテナが無ければ true。
   */
  async confirmPausedContainers(id: string): Promise<boolean> {
    const runs = this.tasks.get(id)?.unstoppedRuns ?? [];
    if (runs.length === 0) return true;
    this.stopRuns(runs);
    return this.confirmStopped(runs);
  }

  /** 中止したときに片付けるもの（確認の画面に並べる）。 */
  cleanupPlan(id: string): CleanupItem[] | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const inflight = this.inflight.get(id);
    const workspace = join(this.deps.workspaceRoot, task.id);
    return [
      {
        target: "container",
        present: Boolean((inflight && inflight.runIds.size > 0) || task.unstoppedRuns?.length),
        detail:
          [...(inflight?.runIds ?? []), ...(task.unstoppedRuns ?? [])]
            .map((r) => `sacty-run-${r}`)
            .join(", ") || undefined,
      },
      {
        target: "workspace",
        present: existsSync(workspace) || existsSync(this.trustedGitDir(task)),
        detail: workspace,
      },
      // sacty はエージェントのセッションを保存しない（実行ごとに空の設定で起動する）
      { target: "session", present: false },
      {
        target: "branch",
        present: Boolean(task.pushedBranch ?? task.pullRequest),
        detail: (task.pushedBranch ?? task.pullRequest)?.branch,
      },
      {
        target: "pull_request",
        present: Boolean(task.pullRequest?.number),
        detail: task.pullRequest?.url,
      },
    ];
  }

  /**
   * 中止する。実行中ならコンテナを止めて処理の終わりを待ち、sacty が作ったものを片付ける
   * （PRを閉じる → sacty のブランチを消す → 作業領域を消す）。人間が作ったブランチやPRには触れない。
   * 片付けの結果を作業履歴に記録し、作業履歴は残す。
   */
  async cancel(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled")
      throw new InvalidOperationError(message("cancel.alreadyCancelled"));
    if (this.cancelling.has(id)) throw new InvalidOperationError(message("cancel.cleaningUp"));
    const judging = openProposal(task);
    if (judging && !judging.judgement) {
      throw new InvalidOperationError(message("cancel.guardianJudging"));
    }
    this.cancelling.add(id);
    try {
      const cleanup: CleanupResult[] = [];
      const inflight = this.inflight.get(id);
      // 止めたコンテナが無くなったことを確かめられなければ、作業領域は消さない（まだ書き込まれうるため）
      let containerStopped = true;
      if (inflight) {
        this.pauseRequested.add(id);
        const runIds = [...inflight.runIds];
        this.stopRuns(runIds);
        await inflight.done.catch(() => {});
        containerStopped = await this.confirmStopped(runIds);
        cleanup.push(
          containerStopped
            ? { target: "container", result: "done" }
            : { target: "container", result: "failed", detail: this.notStopped(runIds) },
        );
      } else if (task.unstoppedRuns?.length) {
        // 一時停止のときに停止を確かめられなかったコンテナは、ここで確かめ直す
        const runs = task.unstoppedRuns;
        this.stopRuns(runs);
        containerStopped = await this.confirmStopped(runs);
        cleanup.push(
          containerStopped
            ? { target: "container", result: "done" }
            : { target: "container", result: "failed", detail: this.notStopped(runs) },
        );
      } else {
        cleanup.push({ target: "container", result: "skipped" });
      }
      cleanup.push({ target: "session", result: "skipped" });

      const latest = this.mustGet(id);
      const pr = latest.pullRequest;
      // PR：sacty が作ったものだけを閉じる（マージはしない）。番号はリポジトリの中でしか一意でないので、
      // 作ったときに記録したリポジトリに対してだけ閉じる（いまの設定のリポジトリは使わない）
      if (pr?.number) {
        const usedSecrets: string[] = [];
        try {
          if (!pr.repo) {
            throw new MessageError(message("cleanup.prRepoUnknown"));
          }
          // PR を作ったときと同じく、プロジェクトの gh のアカウントで閉じる
          const token = await this.githubToken(latest, usedSecrets);
          await this.deps.pulls.close({ repo: pr.repo, token, number: pr.number });
          cleanup.push({ target: "pull_request", result: "done", detail: pr.url });
        } catch (error) {
          cleanup.push({
            target: "pull_request",
            result: "failed",
            detail: redactText(errorText(error), usedSecrets),
          });
        }
      } else {
        cleanup.push({ target: "pull_request", result: "skipped" });
      }
      // ブランチ：sacty のブランチだけを消す
      const gitDir = this.trustedGitDir(latest);
      // PRの作成に失敗していても、プッシュ済みのブランチは記録してある
      const branch = (latest.pushedBranch ?? pr)?.branch;
      if (branch) {
        const usedSecrets: string[] = [];
        try {
          if (!existsSync(gitDir)) throw new MessageError(message("cleanup.noWorkspace"));
          await this.deps.repos.deleteBranch(
            gitDir,
            branch,
            latest.repository
              ? await this.gitAuth(latest, latest.repository.url, usedSecrets)
              : undefined,
          );
          cleanup.push({ target: "branch", result: "done", detail: branch });
        } catch (error) {
          cleanup.push({
            target: "branch",
            result: "failed",
            detail: redactText(errorText(error), usedSecrets),
          });
        }
      } else {
        cleanup.push({ target: "branch", result: "skipped" });
      }
      // 作業領域：タスクの作業領域と、退避した git のメタデータ
      const workspace = join(this.deps.workspaceRoot, latest.id);
      const existed = existsSync(workspace) || existsSync(gitDir);
      if (!containerStopped) {
        cleanup.push({
          target: "workspace",
          result: "failed",
          detail: message("cleanup.containerUnconfirmed"),
        });
      } else {
        try {
          rmSync(workspace, { recursive: true, force: true });
          rmSync(gitDir, { recursive: true, force: true });
          cleanup.push({ target: "workspace", result: existed ? "done" : "skipped" });
        } catch (error) {
          cleanup.push({
            target: "workspace",
            result: "failed",
            detail: errorText(error),
          });
        }
      }
      const cancelled = this.append(this.mustGet(id), [
        { actor: "person", event: { type: "TaskCancelled", payload: { cleanup } } },
      ]);
      // 分割したタスクを中止したら、終わっていない子タスクも中止する（PBI-27）
      for (const child of cancelled.split?.children ?? []) {
        const current = this.tasks.get(child.taskId);
        if (!current || current.status === "cancelled" || isCompleted(current)) continue;
        await this.cancel(child.taskId).catch(() => {});
      }
      return this.mustGet(id);
    } finally {
      this.cancelling.delete(id);
      this.pauseRequested.delete(id);
    }
  }

  /**
   * 再現の工程の後に、テストを実行して再現を確かめる（PBI-29）。再現のテストが失敗すれば再現できたとして
   * 実装へ進む。通った・再現のテストが無いなら、再現できなかったとして人間の判断を待つ。
   */
  private async checkReproduction(task: Task): Promise<void> {
    const config = this.deps.config();
    if (!config.ok) return;
    const record = (payload: Extract<EventInput, { type: "ReproductionChecked" }>["payload"]) =>
      this.append(this.mustGet(task.id), [
        { actor: "sacty", event: { type: "ReproductionChecked", payload } },
      ]);
    const tests = task.reproductionTests;
    if (tests.length === 0) {
      record({ reproduced: false, tests, note: message("reproduce.noTests") });
      return;
    }
    const target = this.targetRepository(task, config.config);
    const dir = this.repoDir(task);
    const testCommand = target.ok ? target.repo.testCommand : undefined;
    if (!target.ok || !testCommand || !existsSync(dir)) {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: !target.ok
                ? message("verify.testsUnavailable", { detail: target.message })
                : !testCommand
                  ? message("orchestrator.testCommandUnknown")
                  : message("verify.workspaceMissing"),
            },
          },
        },
      ]);
      return;
    }
    // 人間が止めたなら、テストのコンテナを起動しない（再開すると確かめ直す）
    if (this.pauseRequested.has(task.id)) return;
    const runId = randomUUID();
    this.track(runId);
    const result = await this.deps.tests.run({
      runId,
      image: target.repo.testImage,
      workspaceDir: dir,
      command: testCommand,
    });
    if (this.pauseRequested.has(task.id)) return;
    // テストの実行基盤の失敗は、テストの失敗（再現できた）と区別し、確かめずに止める。
    // 再現の確かめを待ったまま止めるので、再開するとテストを実行し直す（PBI-29 レビュー指摘）
    if (result.infrastructure) {
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: message("reproduce.runFailed", {
                detail: result.note ?? `exit ${result.exitCode}`,
              }),
            },
          },
        },
      ]);
      return;
    }
    record({
      reproduced: result.exitCode !== 0,
      tests,
      command: testCommand,
      exitCode: result.exitCode,
      output: result.output,
      ...(result.note ? { note: result.note } : {}),
      durationMs: result.durationMs,
    });
  }

  /** 分割で作った子タスクで、親が中止されているか（PBI-27）。 */
  private parentCancelled(task: Task): boolean {
    return Boolean(task.parent && this.tasks.get(task.parent.taskId)?.status === "cancelled");
  }

  /** 子タスクが片付いたか（完了したか、人間が中止を認めたか）。PBI-27 */
  private childSettled(parent: Task, childId: string): boolean {
    const child = this.tasks.get(childId);
    if (child && isCompleted(child)) return true;
    return parent.split?.acceptedCancellations.includes(childId) ?? false;
  }

  /** 中止されたが、まだ人間が認めていない子タスク。 */
  private unacceptedCancellations(parent: Task): string[] {
    return (parent.split?.children ?? [])
      .filter((c) => this.tasks.get(c.taskId)?.status === "cancelled")
      .filter((c) => !parent.split?.acceptedCancellations.includes(c.taskId))
      .map((c) => c.taskId);
  }

  /** 子タスクの完了を待っている親タスクに、sacty が進めることがあるか（PBI-27）。 */
  private splitPending(task: Task): boolean {
    if (task.status !== "waiting_children" || !task.split) return false;
    const { children } = task.split;
    return (
      children.some((c) => !this.tasks.has(c.taskId)) ||
      this.unacceptedCancellations(task).length > 0 ||
      children.every((c) => this.childSettled(task, c.taskId)) ||
      children.some(
        (c) =>
          this.tasks.get(c.taskId)?.status === "blocked" &&
          c.dependsOn.every((d) => this.childSettled(task, d)),
      )
    );
  }

  /**
   * 分割したタスクを進める（PBI-27）。まだ作っていない子タスクを作り、中止された子タスクがあれば
   * 親を止めて人間の判断を待ち、依存先が片付いた子タスクを実行待ちにし、すべて片付いたら完了にする。
   */
  private settleSplit(parent: Task): void {
    const split = parent.split;
    if (parent.status !== "waiting_children" || !split) return;
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const repo = parent.repo ?? parent.source?.repo;
    for (const child of split.children) {
      if (this.tasks.has(child.taskId)) continue;
      this.append({ id: child.taskId, projectId: parent.projectId }, [
        {
          actor: "sacty",
          event: {
            type: "TaskCreated",
            payload: {
              title: child.title,
              body: child.body,
              start: "split",
              budgetCapUsd,
              ...(repo ? { repo } : {}),
              parent: { taskId: parent.id, dependsOn: child.dependsOn },
            },
          },
        },
      ]);
    }
    const cancelled = this.unacceptedCancellations(parent);
    if (cancelled.length > 0) {
      const titles = split.children
        .filter((c) => cancelled.includes(c.taskId))
        .map((c) => `「${c.title}」`)
        .join("・");
      this.append(parent, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "child_cancelled",
              message: message("split.childCancelled", { titles }),
              cancelledChildren: cancelled,
            },
          },
        },
      ]);
      return;
    }
    for (const child of split.children) {
      const current = this.tasks.get(child.taskId);
      if (current?.status !== "blocked") continue;
      if (!child.dependsOn.every((d) => this.childSettled(parent, d))) continue;
      this.append(current, [{ actor: "sacty", event: { type: "TaskUnblocked", payload: {} } }]);
    }
    if (split.children.every((c) => this.childSettled(parent, c.taskId))) {
      this.append(parent, [{ actor: "sacty", event: { type: "SplitCompleted", payload: {} } }]);
    }
  }

  /** 秘密情報を取り出してエージェントを実行し、出力やエラー文から秘密情報を取り除いて返す。 */
  private async execute(run: {
    agent: AgentConfig;
    image: string;
    runId: string;
    prompt: string;
    role: AgentRole;
    workspaceDir: string;
    /** 作業領域を読み取り専用で渡す（要求要件・設計の工程。PBI-15）。 */
    readOnlyWorkspace?: boolean;
    /** エージェントの形式に変換したコンテキスト（工程エージェントだけ。PBI-6）。 */
    context?: Parameters<typeof buildInvocation>[5];
  }): Promise<{ outcome: AgentOutcome; costUsd: number; estimated: boolean }> {
    // 実行に渡した秘密情報。作業履歴に書く前に、出力やエラー文から取り除く。
    const usedSecrets: string[] = [];
    let outcome: AgentOutcome;
    try {
      const invocation = await buildInvocation(
        run.agent,
        run.prompt,
        this.deps.secrets,
        (value) => usedSecrets.push(value),
        run.role,
        run.context,
      );
      mkdirSync(run.workspaceDir, { recursive: true });
      // 準備の間（clone や秘密情報の取り出し）に人間が止めたなら、コンテナを起動しない
      if (this.runningTask && this.pauseRequested.has(this.runningTask)) {
        return {
          outcome: {
            kind: "failed",
            reason: "error",
            message: message("run.stoppedByPerson"),
          },
          costUsd: 0,
          estimated: false,
        };
      }
      this.track(run.runId);
      outcome = await this.deps.executor.run({
        runId: run.runId,
        image: run.image,
        workspaceDir: run.workspaceDir,
        ...(run.readOnlyWorkspace ? { readOnlyWorkspace: true } : {}),
        invocation,
      });
    } catch (error) {
      outcome = {
        kind: "failed",
        reason: error instanceof SecretNotFoundError ? "auth" : "error",
        message: errorText(error),
      };
    }
    outcome =
      outcome.kind === "failed"
        ? { ...outcome, message: redactText(outcome.message, usedSecrets) }
        : { ...outcome, output: redact(outcome.output, usedSecrets) };
    // サブスクリプションは実際の請求が発生しないので、同じ単価で換算した値として扱う
    const estimated = run.agent.auth.mode === "subscription" || run.agent.auth.mode === "stub";
    const costUsd = outcome.usage ? computeCostUsd(outcome.usage, run.agent.price) : 0;
    return { outcome, costUsd, estimated };
  }

  /** 承認ゲートのある工程なら、人間の承認待ちで止めるイベント。 */
  private submitEvents(task: Task, step: StepKey): ActivityItem[] {
    // 前段の調査（実装する組み合わせの先頭）は、人間の承認なしに次の工程へ進める（PBI-29）
    if (step === "investigate" && !investigationIsGoal(task)) {
      const index = task.steps.findIndex((s) => s.key === step);
      const nextStep = task.steps[index + 1]?.key;
      const next = nextStep && EXECUTABLE_STEPS.includes(nextStep) ? "queued" : "idle";
      return [{ actor: "sacty", event: { type: "StepCompleted", payload: { step, next } } }];
    }
    if (!GATED_STEPS.includes(step)) return [];
    return [
      {
        actor: "sacty",
        event: {
          type: "StepSubmitted",
          payload: { step, submission: (task.submissions[step] ?? 0) + 1 },
        },
      },
    ];
  }

  /**
   * ゴールガーディアンが、変更の申し出を判定する。判定ごとに新しいセッション（空の作業領域・
   * 空の設定）で実行し、承認済みの成果物と申し出の内容だけを渡す。実行に失敗した場合は、
   * 判定できなかったものとして人間に判断してもらう。
   */
  private async judge(
    task: Task,
    proposal: TaskProposal,
    config: SactyConfig,
  ): Promise<Extract<EventInput, { type: "ChangeJudged" }>["payload"]> {
    const agent = config.guardianAgent;
    // 変更の申し出の判定は、起点のコミットのコードを読み取り専用で読ませる
    const { outcome, costUsd, estimated } = await this.runGuardian(
      task,
      { agent, image: config.image, prompt: buildGuardianPrompt(task, proposal), role: "guardian" },
      "base",
    );
    const judgement =
      outcome.kind === "completed"
        ? extractVerdict(outcome.output)
        : {
            verdict: "undecidable" as const,
            reason: message("run.guardianFailed", { detail: outcome.message }),
          };
    return {
      proposalId: proposal.id,
      ...judgement,
      agentId: agent.id,
      usage: outcome.usage,
      costUsd,
      estimated,
    };
  }

  /**
   * 判定（または人間の判断）に従った、申し出の後始末のイベント。判定や判断と同じ
   * トランザクションで記録する（間で止まっても、どの状態にも進まないタスクを残さないため）。
   * - 判定できなければエスカレーションにする
   * - 認められたら変更を反映する。要求要件の変更は、人間の再承認に回す
   * - 却下されたら（設計の変更が反映された場合も）、申し出た工程の成果物をそのまま提出する
   * 反映（ChangeApplied）は提出回を変えないので、提出回は記録前のタスクから求めてよい。
   */
  private settleEvents(
    task: Task,
    proposal: TaskProposal,
    accepted: boolean | undefined,
  ): ActivityItem[] {
    if (accepted === undefined) {
      return [
        {
          actor: "sacty",
          event: {
            type: "TaskEscalated",
            payload: {
              step: proposal.fromStep,
              target: proposal.target,
              reason: "change_undecidable",
              proposalId: proposal.id,
            },
          },
        },
      ];
    }
    if (!accepted) return this.submitEvents(task, proposal.fromStep);
    return [
      { actor: "sacty", event: { type: "ChangeApplied", payload: { proposalId: proposal.id } } },
      ...this.submitEvents(
        task,
        proposal.target === "requirements" ? "requirements" : proposal.fromStep,
      ),
    ];
  }

  /**
   * 判定や判断は記録されたのに、後始末が記録されていないタスクを先に進める（冪等）。
   * 判定と後始末は同じトランザクションで記録するので通常は起きないが、
   * 途中までしか記録されていない作業履歴でも、タスクが止まったままにならないようにする。
   */
  private resumeSettlement(task: Task): boolean {
    const last = this.deps.activity.forTask(task.id).at(-1);
    if (
      last?.type !== "ChangeJudged" &&
      last?.type !== "ChangeDecided" &&
      last?.type !== "ChangeApplied"
    ) {
      return false;
    }
    const proposal = task.proposals.find((p) => p.id === last.payload.proposalId);
    if (!proposal) return false;
    const accepted = proposalAccepted(proposal);
    const events =
      last.type === "ChangeApplied"
        ? this.submitEvents(
            task,
            proposal.target === "requirements" ? "requirements" : proposal.fromStep,
          )
        : this.settleEvents(task, proposal, accepted);
    if (events.length > 0) this.append(task, events);
    return true;
  }

  /** ゴールガーディアンが判定できなかった変更の申し出を、人間が判断する。 */
  decideChange(id: string, proposalId: string, raw: unknown): Task {
    const { accept } = DecideChangeInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    const open = openProposal(task);
    if (task.status !== "escalated" || open?.id !== proposalId || !open.judgement) {
      throw new InvalidOperationError(message("change.notAwaiting"));
    }
    return this.append(task, [
      { actor: "person", event: { type: "ChangeDecided", payload: { proposalId, accept } } },
      ...this.settleEvents(task, open, accept),
    ]);
  }

  private mustGet(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`task ${id} is missing from the projection`);
    return task;
  }

  /** 予算の80%に達していて、まだ通知していなければ通知を記録する。 */
  private warnIfNeeded(task: Task): Task {
    if (task.budget.warned || task.budget.usedUsd < task.budget.capUsd * BUDGET_WARN_RATIO) {
      return task;
    }
    return this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "BudgetWarned",
          payload: { usedUsd: task.budget.usedUsd, capUsd: task.budget.capUsd },
        },
      },
    ]);
  }

  /** 実行の完了後に予算を判定する。1回で上限を超えた場合も、通知を記録してから止める。 */
  private checkBudget(task: Task) {
    const warned = this.warnIfNeeded(task);
    // 承認待ちのタスクは、すでに人間の判断で止まっている。予算超過は次の実行の前に判定する。
    if (warned.status === "idle" && budgetState(warned.budget) === "exceeded") {
      this.append(warned, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
    }
  }

  /** 一時停止中のタスクを再開する。予算で止まった場合は、累計の新しい上限が必要。 */
  resume(id: string, raw: unknown, options: { containersConfirmed?: boolean } = {}): Task {
    const input = ResumeTaskInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status !== "paused") {
      throw new InvalidOperationError(message("resume.notPaused"));
    }
    // 止めたコンテナがまだ残っているかもしれないうちは、再開しない（作業領域を取り合うため）
    if (task.unstoppedRuns?.length && !options.containersConfirmed) {
      throw new InvalidOperationError(this.notStopped(task.unstoppedRuns));
    }
    const events: { actor: Actor; event: EventInput }[] = [];
    const needsCap = task.pausedReason === "budget";
    if (needsCap && input.capUsd === undefined) {
      throw new InvalidOperationError(message("resume.capRequired"));
    }
    if (input.capUsd !== undefined) {
      if (input.capUsd <= task.budget.usedUsd) {
        throw new InvalidOperationError(
          message("resume.capTooLow", { usedUsd: task.budget.usedUsd }),
        );
      }
      events.push({
        actor: "person",
        event: { type: "BudgetCapRaised", payload: { capUsd: input.capUsd } },
      });
    }
    events.push({
      actor: "person",
      event: { type: "TaskResumed", payload: { retry: task.resumeTo === "queued" } },
    });
    return this.append(task, events);
  }

  private gateTask(id: string, step: StepKey, submission: number): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status !== "awaiting_approval" && task.status !== "escalated") {
      throw new InvalidOperationError(message("gate.notAwaiting"));
    }
    const gateStep = task.gate?.step ?? task.escalation?.step;
    if (gateStep !== step) {
      throw new InvalidOperationError(message("gate.stepNotAwaiting"));
    }
    // 表示していた成果物と、いま承認待ちの成果物が同じかを確かめる
    const current = task.gate?.submission ?? task.submissions[step];
    if (current !== submission) {
      throw new InvalidOperationError(
        message("gate.staleSubmission", { submission, current: current ?? 0 }),
      );
    }
    return task;
  }

  /** 承認する。工程を完了にし、次の工程を実行対象にする（実行できる工程なら実行待ちにする）。 */
  approve(id: string, raw: unknown): Task {
    const { step, submission } = ApproveStepInput.parse(raw);
    const task = this.gateTask(id, step, submission);
    // 再現できなかったときは、先へは進めない（差し戻すか中止する。PBI-29）
    if (step === "reproduce") {
      throw new InvalidOperationError(message("gate.reproduceNotApprovable"));
    }
    // PR を作ったタスクの成果物チェックは、PR のマージで承認する（PBI-14a）
    if (step === "pr" && task.pullRequest?.number) {
      throw new InvalidOperationError(
        message("gate.approveOnPullRequest", { url: task.pullRequest.url ?? "" }),
      );
    }
    const index = task.steps.findIndex((s) => s.key === step);
    const nextStep = task.steps[index + 1]?.key;
    const next = nextStep && EXECUTABLE_STEPS.includes(nextStep) ? "queued" : "idle";
    return this.append(task, [
      { actor: "person", event: { type: "StepApproved", payload: { step, next } } },
    ]);
  }

  /**
   * 差し戻す。指摘は作業履歴に累積し、工程を実行し直す。
   * やり直す工程には、承認ゲートの工程か、それより前の承認ゲートのある工程を選べる。
   * 前の工程に戻すと、その工程から先の承認は取り消され、人間の再承認が必要になる。
   * 同じ工程への差し戻しが上限を超える場合はエスカレーションにし、人間に続けるかを判断してもらう。
   */
  requestChanges(id: string, raw: unknown): Task {
    const input = RequestChangesInput.parse(raw);
    const task = this.gateTask(id, input.step, input.submission);
    // やり直す工程は、ゲートの工程か、それより前の工程エージェントが作る工程。
    // 成果物チェック（PR作成）のゲートでは、省略すると実装をやり直す
    const targets = reworkTargets(task, input.step);
    const target = input.target ?? targets[0];
    if (!target || !targets.includes(target)) {
      throw new InvalidOperationError(message("gate.invalidTarget"));
    }
    const rounds = changeRounds(task, target);

    if (task.status === "awaiting_approval" && input.comments.length === 0) {
      throw new InvalidOperationError(message("gate.remarksRequired"));
    }
    const round = rounds + 1;
    const toRemarks = (texts: string[]) =>
      texts.map((text, i) => ({ id: `${target}-${round}-${i + 1}`, text }));

    if (task.status === "awaiting_approval" && rounds >= MAX_CHANGE_REQUESTS) {
      return this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskEscalated",
            payload: {
              step: input.step,
              target,
              reason: "too_many_changes",
              pendingRemarks: toRemarks(input.comments),
            },
          },
        },
      ]);
    }

    let remarks = toRemarks(input.comments);
    // エスカレーションの後でも、上限に達していない別の工程に戻すのは通常の差し戻し
    const overLimit = task.status === "escalated" && rounds >= MAX_CHANGE_REQUESTS;
    if (overLimit && !input.continueOverLimit) {
      throw new InvalidOperationError(message("gate.overLimit", { limit: MAX_CHANGE_REQUESTS }));
    }
    if (task.status === "escalated") {
      // 書きかけの指摘は、エスカレーションしたときと同じ工程に戻す場合だけ引き継ぐ。
      // PR の指摘の戻し先の確認では、人間がどの工程を選んでも引き継ぐ（指摘は人間のレビューなので）
      const rework = task.escalation?.reason === "rework_confirmation";
      if (
        remarks.length === 0 &&
        task.escalation &&
        (rework || task.escalation.target === target)
      ) {
        remarks = toRemarks(task.escalation.pendingRemarks.map((r) => r.text));
      }
      if (remarks.length === 0) {
        throw new InvalidOperationError(message("gate.remarksRequired"));
      }
    }
    // ゴールガーディアンが最終レビューで合格にした成果物を人間が差し戻したら、見逃しとして記録する
    const review = task.lastReview;
    const missed =
      input.step === "pr" && review?.passed && !task.misses.some((m) => m.reviewAt === review.at)
        ? [
            {
              actor: "sacty" as const,
              event: {
                type: "GuardianMissed" as const,
                payload: { reviewAt: review.at, remarkIds: remarks.map((r) => r.id) },
              },
            },
          ]
        : [];
    return this.append(task, [
      ...missed,
      {
        actor: "person",
        event: {
          type: "ChangesRequested",
          payload: { step: input.step, target, round, remarks, overLimit },
        },
      },
    ]);
  }

  /** 前提が変わった指摘を無効にする。以降、エージェントには渡さない。 */
  voidRemark(id: string, remarkId: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    const remark = task.remarks.find((r) => r.id === remarkId);
    if (!remark) throw new InvalidOperationError(message("remark.notFound"));
    if (remark.voided) return task;
    return this.append(task, [
      { actor: "person", event: { type: "RemarkVoided", payload: { remarkId } } },
    ]);
  }
}

/** 指摘の1件あたりの上限（差し戻しの入力と同じ）と、件数の上限。 */
const REMARK_MAX = 2_000;
const REMARKS_MAX = 50;

/** PR へのフィードバックを取り込むまでに、最後のフィードバックから待つ時間（書き終わるのを待つ）。 */
export const FEEDBACK_QUIET_MS = 2 * 60_000;

/**
 * PR へのフィードバックを、指摘の文にする（PBI-14b）。1件のフィードバックを1件の指摘にする（取り込み済みに
 * するものと、指摘に反映するものを一致させるため）。行ごとのコメントにはファイルと行を添える。
 * 本文の無い Request changes は、変更を求められたことを1件にする。
 */
function feedbackRemarks(items: PullRequestFeedback[]): string[] {
  const cut = (text: string) =>
    text.length > REMARK_MAX ? `${text.slice(0, REMARK_MAX - 1)}…` : text;
  return items.map((item) => {
    const body = item.body.trim();
    if (item.kind === "review_comment") {
      return cut(`${item.path}${item.line ? `:${item.line}` : ""}：${body}`);
    }
    return cut(body || `${item.author} が PR の変更を求めました（コメントなし）。`);
  });
}

/**
 * オーケストレーターが選んだ工程（作業履歴の StepsChosen）と、ベースブランチ（PBI-25）。ベースブランチは、
 * 既定のブランチと違えば用意し直して RepositoryPrepared として記録する。
 */
type ChosenSteps = Extract<EventInput, { type: "StepsChosen" }>["payload"] & {
  baseBranch?: string;
};

/** タスクの対象リポジトリ。 */
type TargetRepository = {
  url: string;
  /** 用意したベースブランチ（用意する前は無い。既定のブランチを clone する）。 */
  baseBranch?: string;
  /** オーケストレーターが決めたテストのコマンド（PBI-25）。 */
  testCommand?: string;
  testImage: string;
  pullRequest: { provider: "github"; repo: string };
};

/** 再現の工程が終わり、テストでの再現の確かめを待っている（PBI-29）。 */
function awaitingReproductionCheck(task: Task): boolean {
  return (
    task.status === "idle" && activeStep(task) === "reproduce" && Boolean(task.reproductionPending)
  );
}

/** 書いたレビューを、まだ対象の PR に投稿していない（PBI-19）。 */
function awaitingReviewPost(task: Task): boolean {
  return (
    activeStep(task) === "review" &&
    task.status === "idle" &&
    task.outputs.review !== undefined &&
    !task.reviewPost
  );
}

/** 完了した調査のタスクで、結果をまだ取り込み元の Issue に返していないか（PBI-18）。 */
export function awaitingIssueComment(task: Task): boolean {
  return (
    isCompleted(task) &&
    // 調査そのものが目的のタスクだけ（前段の調査の結果は返さない。PBI-29）
    investigationIsGoal(task) &&
    // Issue・PR から取り込んだタスク（PBI-26）
    task.source !== undefined &&
    !task.issueComment
  );
}
