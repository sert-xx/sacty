import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Actor,
  ApproveStepInput,
  activeStep,
  applyEvent,
  BUDGET_WARN_RATIO,
  budgetState,
  CreateTicketInput,
  changeRounds,
  computeCostUsd,
  DEFAULT_BUDGET_USD,
  DecideChangeInput,
  type EventInput,
  excludedRepositories,
  formatUsd,
  GATED_STEPS,
  type LedgerEvent,
  MAX_CHANGE_REQUESTS,
  MAX_VERIFY_ATTEMPTS,
  MVP_STEPS,
  openProposal,
  type Project,
  ProjectDefinition,
  project,
  projectConflicts,
  proposalAccepted,
  RequestChangesInput,
  ResumeTaskInput,
  repositorySettings,
  responsibleSource,
  reworkTargets,
  type StepKey,
  type Task,
  type TaskProposal,
} from "@sacty/core";
import type { AgentExecutor } from "./agents/docker.js";
import { type AgentRole, buildInvocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { redact } from "./agents/redact.js";
import type { TestRunner } from "./agents/test-runner.js";
import type { AgentConfig, ConfigResult, SactyConfig } from "./config.js";
import type { FoundIssue, PullRequests } from "./github.js";
import type { LedgerStore } from "./ledger.js";
import type { ProjectStore } from "./projects.js";
import {
  buildFinalReviewPrompt,
  buildGuardianPrompt,
  buildPrompt,
  buildPullRequestBody,
  changeableSteps,
  EXECUTABLE_STEPS,
  extractBlocks,
  extractFinalReview,
  extractVerdict,
} from "./prompts.js";
import type { RepositoryWorkspace } from "./repository.js";
import { SecretNotFoundError, type SecretStore } from "./secrets.js";

export const DEFAULT_PROJECT_ID = "default";

type LedgerItem = { actor: Actor; event: EventInput };

/** 実装の検証（テストか最終レビュー）を待っているか。変更の申し出の判断待ちの間は検証しない。 */
function awaitingVerification(task: Task): boolean {
  return task.status === "idle" && task.verification !== undefined && !openProposal(task);
}

/** 状態に合わない操作（一時停止していないタスクの再開など）。APIでは409にする。 */
export class InvalidOperationError extends Error {}

export type ServiceDeps = {
  ledger: LedgerStore;
  /** 呼ぶたびに設定を読み直す（デーモンを止めずに設定を変えられるように）。 */
  config: () => ConfigResult;
  secrets: SecretStore;
  executor: AgentExecutor;
  /** 実装の対象リポジトリの clone・差分・コミットとプッシュ。 */
  repos: RepositoryWorkspace;
  /** PRの作成。 */
  pulls: PullRequests;
  /** プロジェクトの設定。 */
  projects: ProjectStore;
  /** テストの実行。 */
  tests: TestRunner;
  /** タスクごとの作業領域を作る場所。 */
  workspaceRoot: string;
};

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: string[];
  /** GitHub Issue の取り込みの状況（設定が無ければ null）。 */
  intake: IntakeStatus | null;
};

export type IntakeStatus = {
  lastRunAt?: string;
  /** 直近の取り込みで作ったタスクの数。 */
  imported?: number;
  /** 取り込めなかった取り込み元（検索の条件）と理由。 */
  errors?: { query?: string; message: string }[];
};

/** プロジェクトと、Org の取り込み元ごとの除外リポジトリ（ほかのプロジェクトが担当）。 */
export type ProjectView = {
  project: Project;
  exclusions: { org: string; repos: { repo: string; projectName: string }[] }[];
};

/**
 * タスクの読み書きの窓口。書き込みは必ず台帳への追記を通り、
 * 読み取り用の状態は台帳から復元したものを保持する。
 */
export class TaskService {
  private tasks: Map<string, Task>;

  private intakeStatus: IntakeStatus = {};

  constructor(private readonly deps: ServiceDeps) {
    this.tasks = project(deps.ledger.all());
    if (!deps.projects.get(DEFAULT_PROJECT_ID)) {
      deps.projects.put(DEFAULT_PROJECT_ID, ProjectDefinition.parse({ name: "デフォルト" }));
    }
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): { task: Task; ledger: LedgerEvent[] } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { task, ledger: this.deps.ledger.forTask(id) };
  }

  status(): DaemonStatus {
    const config = this.deps.config();
    if (!config.ok) return { agent: null, problems: [config.problem], intake: null };
    const agent = config.config.defaultAgent;
    return {
      agent: { id: agent.id, runtime: agent.runtime, authMode: agent.auth.mode },
      problems: [],
      intake: config.config.github ? this.intakeStatus : null,
    };
  }

  listProjects(): Project[] {
    return this.deps.projects.all();
  }

  getProject(id: string): ProjectView | undefined {
    const project = this.deps.projects.get(id);
    if (!project) return undefined;
    const all = this.deps.projects.all();
    return {
      project,
      exclusions: project.sources
        .filter((s) => s.scope === "org")
        .map((s) => ({ org: s.target, repos: excludedRepositories(all, id, s.target) })),
    };
  }

  /** プロジェクトを作る、または変える。ほかのプロジェクトと取り込み元が重複していれば拒否する。 */
  saveProject(id: string | undefined, raw: unknown): Project {
    const definition = ProjectDefinition.parse(raw);
    if (id && !this.deps.projects.get(id)) {
      throw new InvalidOperationError("プロジェクトが見つかりません。");
    }
    const problems = projectConflicts(this.deps.projects.all(), id, definition);
    if (problems.length > 0) throw new InvalidOperationError(problems.join("\n"));
    return this.deps.projects.put(id ?? randomUUID(), definition);
  }

  /** 取り込みで検索する条件（取り込み元ごと）。 */
  intakeQueries(): string[] {
    const queries = new Set<string>();
    for (const project of this.deps.projects.all()) {
      for (const source of project.sources) {
        const where = source.scope === "org" ? `org:${source.target}` : `repo:${source.target}`;
        queries.add(`is:issue is:open ${where} label:"${source.label.replace(/"/g, "")}"`);
      }
    }
    return [...queries];
  }

  /** プロジェクトの設定の版。変わったら、取り込みは読んだ位置を忘れて先頭から読み直す。 */
  projectsRevision(): string {
    return this.deps.projects
      .all()
      .map((p) => `${p.id}@${p.updatedAt}`)
      .join(",");
  }

  recordIntake(status: IntakeStatus): void {
    this.intakeStatus = status;
  }

  /**
   * 見つかった Issue をタスクにする。担当するプロジェクトは取り込むたびに判定し（範囲が狭い
   * 指定が優先）、その取り込み元のラベルが付いた Issue だけを取り込む。同じ Issue は二重に取り込まない。
   */
  importIssues(found: readonly FoundIssue[]): Task[] {
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
      const responsible = responsibleSource(projects, issue.repo);
      if (!responsible) continue;
      const label = responsible.source.label.toLowerCase();
      if (!issue.labels.some((l) => l.toLowerCase() === label)) continue;
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
                start: "github_issue",
                budgetCapUsd,
                source: {
                  kind: "github_issue",
                  repo: issue.repo,
                  number: issue.number,
                  url: issue.url,
                },
              },
            },
          },
          { actor: "sacty", event: { type: "StepsChosen", payload: { steps: [...MVP_STEPS] } } },
        ]),
      );
    }
    return created;
  }

  private append(
    task: Pick<Task, "id" | "projectId">,
    events: { actor: Actor; event: EventInput }[],
  ) {
    const written = this.deps.ledger.append({
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

  createTicket(raw: unknown): Task {
    const input = CreateTicketInput.parse(raw);
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    return this.append({ id: randomUUID(), projectId: DEFAULT_PROJECT_ID }, [
      {
        actor: "person",
        event: { type: "TaskCreated", payload: { ...input, start: "ticket", budgetCapUsd } },
      },
      { actor: "sacty", event: { type: "StepsChosen", payload: { steps: [...MVP_STEPS] } } },
    ]);
  }

  /** 実行待ちのタスク（古い順）。 */
  queuedTaskIds(): string[] {
    return [...this.tasks.values()]
      .filter((t) => (t.status === "queued" && activeStep(t)) || awaitingVerification(t))
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
                reason: "デーモンが停止したため、ゴールガーディアンの判定が中断されました。",
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
              message: "デーモンが停止したため、実行が中断されました。",
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
  ): { ok: true; repo: NonNullable<SactyConfig["repository"]> } | { ok: false; message: string } {
    if (task.source?.kind === "github_issue") {
      const project = this.deps.projects.get(task.projectId);
      const settings = repositorySettings(project, task.source.repo);
      if (!settings) {
        return {
          ok: false,
          message: `プロジェクト「${project?.name ?? task.projectId}」に、${task.source.repo} のリポジトリの設定（ベースブランチ・テストのコマンド）がありません。プロジェクトの設定で追加してから再開してください。`,
        };
      }
      if (settings.pullRequest && !config.github) {
        return {
          ok: false,
          message:
            "PRを作るには、config.yaml の github.token_secret（GitHub のトークン）が必要です。設定するか、プロジェクトのリポジトリの設定でPRを作らないようにしてから再開してください。",
        };
      }
      return {
        ok: true,
        repo: {
          url: `https://github.com/${task.source.repo}.git`,
          baseBranch: settings.baseBranch,
          testCommand: settings.testCommand,
          testImage: config.image,
          ...(settings.pullRequest && config.github
            ? {
                pullRequest: {
                  provider: "github" as const,
                  repo: task.source.repo,
                  tokenSecret: config.github.tokenSecret,
                },
              }
            : {}),
        },
      };
    }
    if (!config.repository) {
      return {
        ok: false,
        message:
          "実装の対象リポジトリが設定されていません。config.yaml の repository を設定してから再開してください。",
      };
    }
    return { ok: true, repo: config.repository };
  }

  /** 実装の対象リポジトリを用意する（初回だけ clone し、起点のコミットを台帳に記録する）。 */
  private async prepareRepository(
    task: Task,
    config: SactyConfig,
  ): Promise<{ ok: true; dir: string } | { ok: false; message: string }> {
    const dir = this.repoDir(task);
    if (task.repository && existsSync(dir) && existsSync(this.trustedGitDir(task))) {
      return { ok: true, dir };
    }
    const target = this.targetRepository(task, config);
    if (!target.ok && !task.repository) return target;
    const repo = target.ok ? target.repo : undefined;
    // 一度用意したタスクは、設定が変わっても同じリポジトリ・ブランチで作業する
    const url = task.repository?.url ?? repo?.url ?? "";
    const baseBranch = task.repository?.baseBranch ?? repo?.baseBranch ?? "main";
    try {
      const { baseCommit } = await this.deps.repos.prepare(
        dir,
        this.trustedGitDir(task),
        url,
        baseBranch,
      );
      this.append(task, [
        {
          actor: "sacty",
          event: { type: "RepositoryPrepared", payload: { url, baseBranch, baseCommit } },
        },
      ]);
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 実行待ちのタスクの、現在の工程をエージェントで実行する（実装の検証待ちなら、検証する）。 */
  async runNext(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task && awaitingVerification(task)) return this.verify(task);
    if (task?.status !== "queued") return;
    const step = activeStep(task);
    if (!step) return;
    const config = this.deps.config();
    if (!config.ok) return; // 設定の問題は status() で画面に出す。タスクは実行待ちのまま。
    // PR作成は、エージェントではなく sacty が行う
    if (step === "pr") return this.publish(task, config.config);

    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return;
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

    // 実装の工程は、対象リポジトリの clone を作業領域にする
    let workspaceDir = join(this.deps.workspaceRoot, task.id);
    if (step === "implement") {
      const ready = await this.prepareRepository(task, config.config);
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
      workspaceDir = ready.dir;
    }

    const { outcome, costUsd, estimated } = await this.execute({
      agent,
      image: config.config.image,
      runId,
      prompt: buildPrompt(this.mustGet(task.id), step),
      role: step,
      workspaceDir,
    });

    if (outcome.kind === "failed") {
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
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: outcome.reason } } },
      ]);
      // 失敗した実行の費用でも、80%の通知は判定する（一時停止はすでにしている）
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }

    const latest = this.mustGet(task.id);
    const { output, responses, testViewpoints, proposal, testMap } = extractBlocks(
      outcome.output,
      new Set(latest.remarks.filter((r) => r.step === step && !r.voided).map((r) => r.id)),
      changeableSteps(latest, step),
    );
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
          },
        },
      },
    ];
    if (!proposal) {
      // 実行の完了と提出は、同じトランザクションで記録する
      this.checkBudget(this.append(task, [...events, ...this.submitEvents(latest, step)]));
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
                ? `テストを実行できません：${target.message}`
                : "実装の作業領域が見つからないため、検証できません。",
            },
          },
        },
      ]);
      return;
    }
    const repo = target.repo;
    const viewpointIds = (task.approved.design?.testViewpoints ?? []).map((v) => v.id);

    let current = task;
    if (current.verification === "pending") {
      const mapped = new Set(current.testMap.map((m) => m.viewpointId));
      const unmappedViewpoints = viewpointIds.filter((id) => !mapped.has(id));
      const result = await this.deps.tests.run({
        runId: randomUUID(),
        image: repo.testImage,
        workspaceDir: dir,
        command: repo.testCommand,
      });
      const passed = result.exitCode === 0 && unmappedViewpoints.length === 0;
      current = this.append(current, [
        {
          actor: "sacty",
          event: {
            type: "TestsRun",
            payload: {
              command: repo.testCommand,
              exitCode: result.exitCode,
              unmappedViewpoints,
              passed,
              output: result.output,
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
              message: `差分を取得できないため、最終レビューをしていません：${error instanceof Error ? error.message : String(error)}`,
            },
          },
        },
      ]);
      return;
    }
    const agent = config.config.guardianAgent;
    const runId = randomUUID();
    const workspaceDir = join(this.deps.workspaceRoot, "_guardian", runId);
    let result: Awaited<ReturnType<TaskService["execute"]>>;
    try {
      result = await this.execute({
        agent,
        image: config.config.image,
        runId,
        prompt: buildFinalReviewPrompt(current, diff),
        role: "final-review",
        workspaceDir,
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = result;
    if (outcome.kind === "failed") {
      // 実装の問題ではないので、やり直さずに止める。再開すると最終レビューからやり直す。
      // 使った分の費用は記録し、予算に入れる
      const message = `ゴールガーディアンの最終レビューを実行できませんでした：${outcome.message}`;
      this.append(current, [
        {
          actor: "guardian",
          event: {
            type: "FinalReviewFailed",
            payload: {
              reason: outcome.reason,
              message,
              agentId: agent.id,
              usage: outcome.usage,
              costUsd,
              estimated,
            },
          },
        },
        {
          actor: "sacty",
          event: { type: "TaskPaused", payload: { reason: outcome.reason, message } },
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
    const fail = (message: string) =>
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: redact(message, usedSecrets) },
          },
        },
      ]);
    if (!target.ok) {
      fail(`PRを作れません：${target.message}`);
      return;
    }
    if (!task.repository || !existsSync(dir) || !existsSync(gitDir)) {
      fail("実装の作業領域が無いため、PRを作れません。");
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
      });
      let pr: { url: string; number: number } | undefined;
      if (repo.pullRequest) {
        const token = await this.deps.secrets.get(repo.pullRequest.tokenSecret);
        usedSecrets.push(token);
        pr = await this.deps.pulls.upsert({
          repo: repo.pullRequest.repo,
          token,
          branch,
          baseBranch: task.repository.baseBranch,
          title: task.title,
          body: buildPullRequestBody(task),
          number: task.pullRequest?.number,
        });
      }
      const submitted = this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "PullRequestPublished",
            payload: { branch, commit, ...(pr ? { url: pr.url, number: pr.number } : {}) },
          },
        },
        ...this.submitEvents(task, "pr"),
      ]);
      this.checkBudget(submitted);
    } catch (error) {
      fail(`PRを作れませんでした：${error instanceof Error ? error.message : String(error)}`);
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
            message: `実装の検証（テストと最終レビュー）に、${MAX_VERIFY_ATTEMPTS}回続けて通りませんでした。`,
          },
        },
      },
    ]);
  }

  /** 秘密情報を取り出してエージェントを実行し、出力やエラー文から秘密情報を取り除いて返す。 */
  private async execute(run: {
    agent: AgentConfig;
    image: string;
    runId: string;
    prompt: string;
    role: AgentRole;
    workspaceDir: string;
  }): Promise<{ outcome: AgentOutcome; costUsd: number; estimated: boolean }> {
    // 実行に渡した秘密情報。台帳に書く前に、出力やエラー文から取り除く。
    const usedSecrets: string[] = [];
    let outcome: AgentOutcome;
    try {
      const invocation = await buildInvocation(
        run.agent,
        run.prompt,
        this.deps.secrets,
        (value) => usedSecrets.push(value),
        run.role,
      );
      mkdirSync(run.workspaceDir, { recursive: true });
      outcome = await this.deps.executor.run({
        runId: run.runId,
        image: run.image,
        workspaceDir: run.workspaceDir,
        invocation,
      });
    } catch (error) {
      outcome = {
        kind: "failed",
        reason: error instanceof SecretNotFoundError ? "auth" : "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    outcome =
      outcome.kind === "failed"
        ? { ...outcome, message: redact(outcome.message, usedSecrets) }
        : { ...outcome, output: redact(outcome.output, usedSecrets) };
    // サブスクリプションは実際の請求が発生しないので、同じ単価で換算した値として扱う
    const estimated = run.agent.auth.mode === "subscription" || run.agent.auth.mode === "stub";
    const costUsd = outcome.usage ? computeCostUsd(outcome.usage, run.agent.price) : 0;
    return { outcome, costUsd, estimated };
  }

  /** 承認ゲートのある工程なら、人間の承認待ちで止めるイベント。 */
  private submitEvents(task: Task, step: StepKey): LedgerItem[] {
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
    const runId = randomUUID();
    const workspaceDir = join(this.deps.workspaceRoot, "_guardian", runId);
    let result: Awaited<ReturnType<TaskService["execute"]>>;
    try {
      result = await this.execute({
        agent,
        image: config.image,
        runId,
        prompt: buildGuardianPrompt(task, proposal),
        role: "guardian",
        workspaceDir,
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = result;
    const judgement =
      outcome.kind === "completed"
        ? extractVerdict(outcome.output)
        : {
            verdict: "undecidable" as const,
            reason: `ゴールガーディアンの実行に失敗しました：${outcome.message}`,
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
  ): LedgerItem[] {
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
   * 途中までしか記録されていない台帳でも、タスクが止まったままにならないようにする。
   */
  private resumeSettlement(task: Task): boolean {
    const last = this.deps.ledger.forTask(task.id).at(-1);
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
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    const open = openProposal(task);
    if (task.status !== "escalated" || open?.id !== proposalId || !open.judgement) {
      throw new InvalidOperationError("この変更の申し出は、判断待ちではありません。");
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
  resume(id: string, raw: unknown): Task {
    const input = ResumeTaskInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    if (task.status !== "paused") {
      throw new InvalidOperationError("一時停止中のタスクではありません。");
    }
    const events: { actor: Actor; event: EventInput }[] = [];
    const needsCap = task.pausedReason === "budget";
    if (needsCap && input.capUsd === undefined) {
      throw new InvalidOperationError("予算で止まったタスクを再開するには、新しい上限が必要です。");
    }
    if (input.capUsd !== undefined) {
      if (input.capUsd <= task.budget.usedUsd) {
        throw new InvalidOperationError(
          `新しい上限は、使用済み（${formatUsd(task.budget.usedUsd)}）より大きい金額にしてください。`,
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
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    if (task.status !== "awaiting_approval" && task.status !== "escalated") {
      throw new InvalidOperationError("承認待ちのタスクではありません。");
    }
    const gateStep = task.gate?.step ?? task.escalation?.step;
    if (gateStep !== step) {
      throw new InvalidOperationError("この工程は承認待ちではありません。");
    }
    // 表示していた成果物と、いま承認待ちの成果物が同じかを確かめる
    const current = task.gate?.submission ?? task.submissions[step];
    if (current !== submission) {
      throw new InvalidOperationError(
        `表示している成果物（${submission}回目の提出）は最新ではありません。画面を更新して、最新の提出（${current}回目）を確認してください。`,
      );
    }
    return task;
  }

  /** 承認する。工程を完了にし、次の工程を実行対象にする（実行できる工程なら実行待ちにする）。 */
  approve(id: string, raw: unknown): Task {
    const { step, submission } = ApproveStepInput.parse(raw);
    const task = this.gateTask(id, step, submission);
    const index = task.steps.findIndex((s) => s.key === step);
    const nextStep = task.steps[index + 1]?.key;
    const next = nextStep && EXECUTABLE_STEPS.includes(nextStep) ? "queued" : "idle";
    return this.append(task, [
      { actor: "person", event: { type: "StepApproved", payload: { step, next } } },
    ]);
  }

  /**
   * 差し戻す。指摘は台帳に累積し、工程を実行し直す。
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
      throw new InvalidOperationError("この工程には差し戻せません。");
    }
    const rounds = changeRounds(task, target);

    if (task.status === "awaiting_approval" && input.comments.length === 0) {
      throw new InvalidOperationError("差し戻すには、指摘を1件以上入力してください。");
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
      throw new InvalidOperationError(
        `差し戻しが上限（${MAX_CHANGE_REQUESTS}回）に達しています。続ける場合は、上限を超えて差し戻すことを選んでください。`,
      );
    }
    if (task.status === "escalated") {
      // 書きかけの指摘は、エスカレーションしたときと同じ工程に戻す場合だけ引き継ぐ
      if (remarks.length === 0 && task.escalation?.target === target) {
        remarks = task.escalation.pendingRemarks;
      }
      if (remarks.length === 0) {
        throw new InvalidOperationError("差し戻すには、指摘を1件以上入力してください。");
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
    if (!task) throw new InvalidOperationError("タスクが見つかりません。");
    const remark = task.remarks.find((r) => r.id === remarkId);
    if (!remark) throw new InvalidOperationError("指摘が見つかりません。");
    if (remark.voided) return task;
    return this.append(task, [
      { actor: "person", event: { type: "RemarkVoided", payload: { remarkId } } },
    ]);
  }
}
