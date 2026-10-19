import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActivityEvent,
  type Actor,
  AdoptAuditProposalInput,
  ANSWER_MAX,
  ApproveStepInput,
  AskQuestionInput,
  type AuditTarget,
  activeStep,
  applyEvent,
  auditOpen,
  awaitingDeploymentCheck,
  awaitingDeploymentCi,
  awaitingRepository,
  awaitingTicketTriage,
  BUDGET_WARN_RATIO,
  budgetState,
  ChangeStepAgentInput,
  ChangeStepImageInput,
  type CiFailure,
  type CleanupTarget,
  CreateTaskInput,
  CreateTemplateTaskInput,
  canRereview,
  canRetryExport,
  changeRounds,
  computeCostUsd,
  type DaemonMessage,
  type DaemonText,
  DashboardStats,
  type DashboardSummary,
  DEFAULT_AUDIT_BUDGET_USD,
  DEFAULT_BUDGET_USD,
  DEFAULT_MAX_PARALLEL_TASKS,
  DEFAULT_MEMORY_RETENTION_DAYS,
  DEPLOYMENT_CI_GRACE_MS,
  DEPLOYMENT_CI_TIMEOUT_MS,
  DecideChangeInput,
  deploymentCheckRunning,
  EventInput,
  type ExportPlan,
  excludedRepositories,
  exportDue,
  exportSteps,
  fixDecisionPending,
  fixTaskOpen,
  GATED_STEPS,
  gatePullRequest,
  type IntakeKind,
  investigationIsGoal,
  isAuditTarget,
  isCompleted,
  isRepoless,
  latestStepPullRequest,
  MAX_CHANGE_REQUESTS,
  MAX_FIX_CHAIN,
  MAX_INTEGRATION_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS,
  MEMORY_BODY_MAX,
  MEMORY_SUMMARY_MAX,
  MEMORY_TITLE_MAX,
  type MemoryMove,
  mapFreeText,
  message,
  nextAuditDive,
  OperationSettings,
  openProposal,
  type PauseReason,
  type Project,
  ProjectDefinition,
  ProjectExport,
  type PullRequestMerge,
  type PullRequestTemplateUse,
  parseOrgUrl,
  parseRepoUrl,
  pendingQuestion,
  project,
  projectConflicts,
  proposalAccepted,
  questionBlocked,
  queueOverSince,
  RejectAuditProposalInput,
  RepoUrl,
  RequestChangesInput,
  ResumeAuditInput,
  ResumeTaskInput,
  renderMessage,
  responsibleProject,
  responsibleTicketProject,
  reworkTargets,
  SactySettings,
  SELF_REVIEW_STEPS,
  type SharedCompose,
  STEP_PLANS,
  StepKey,
  StepPullRequestKey,
  sameAuditTarget,
  sameGitHubUrl,
  stepAgentChangeable,
  stepDocumentPath,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
  type Task,
  type TaskProposal,
  type TicketService,
  type TriageKind,
  targetHost,
  targetImageOf,
  exportProject as toProjectExport,
} from "@sacty/core";
import { ZodError } from "zod";
import type { ActivityStore } from "./activity.js";
import { archivedFilePath, type CheckedAgentFile, checkArchivedFiles } from "./agent-sessions.js";
import { type AgentExecutor, CONTAINER_REVIEW_DIR } from "./agents/docker.js";
import type { LocalForward } from "./agents/forward.js";
import {
  type AgentRole,
  buildInvocation,
  CONTAINER_CLAUDE_CONFIG_DIR,
  CONTAINER_CODEX_HOME,
  type OrchestratorSessionResume,
} from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { redact, redactEscaped, redactText } from "./agents/redact.js";
import type { TestRunner, TestRunResult } from "./agents/test-runner.js";
import { type PlacedTier, selectTiers, tierFiles } from "./agents/tiers.js";
import { auditCounts, countToolFailures, redactDeep, redactStagedFiles } from "./audit-evidence.js";
import {
  AUDIT_LEDGER_DIR,
  AUDIT_LEDGER_FILE,
  buildAuditDivePrompt,
  buildAuditSurveyPrompt,
  cut,
  extractAuditDive,
  extractAuditSurvey,
  type KnownAuditCause,
  type KnownMemory,
  type OpenedMemory,
  type PromotionInput,
  type RejectedAuditProposal,
} from "./audit-prompts.js";
import { auditTargetCandidates } from "./audit-targets.js";
import { CI_FAILURES_MAX, type CiStatusReader, isFailedConclusion, redactLog } from "./ci.js";
import {
  type AgentConfig,
  agentFor,
  agentSetting,
  type ConfigResult,
  DEFAULT_IMAGE_NAME,
  definedAgent,
  githubRepoOf,
  resolveImage,
  type SactyConfig,
  stepAgentFor,
  type TierRuntime,
  tierAgentsFor,
} from "./config.js";
import {
  type ContextFetcher,
  type ContextPreview,
  contextExportInfo,
  contextPlatforms,
  contextSecretSources,
  GATEWAY_TOKEN_SECRET,
  type GatewayMcpServer,
  type HostedMcpRelay,
  type McpRouting,
  prepareContext,
  previewContext,
} from "./context.js";
import type { ContextMcpServers } from "./context-mcp.js";
import {
  buildCiFixTask,
  buildDeploymentFixTask,
  buildDeploymentPrompt,
  ciFingerprint,
  deploymentFingerprint,
  extractDeploymentCheck,
  findDeploymentSkill,
} from "./deployment.js";
import { errorText, MessageError } from "./errors.js";
import type { AiGateway, ContextMcpRoute, GatewayStats } from "./gateway.js";
import {
  type GitHubAccount,
  type GitHubAuth,
  gitAuthEnv,
  gitAuthSecrets,
  httpsHost,
} from "./gh.js";
import {
  type FoundIssue,
  githubStatus,
  type PullRequestFeedback,
  type PullRequestStatus,
  type PullRequests,
  type SactyReviewRound,
  sactyReviewKey,
  sactyReviewTask,
} from "./github.js";
import {
  CONTAINER_PROJECT_MEMORY_DIR,
  CONTAINER_REPOSITORY_MEMORY_DIR,
  countOpenedMemories,
  existingLayerDir,
  expiredMemories,
  type LiveMemory,
  layerOf,
  liveMemories,
  MEMORY_MAX_PER_LAYER,
  MEMORY_REFERENCES_DIR,
  type MemoryLayer,
  memoriesOf,
  memoryPromptLines,
  overCapacity,
  promotedMemories,
  repositoryMemoryKey,
  sameLayer,
  syncMemoryLayers,
  taskMemoryLayers,
  usefulCounts,
} from "./memory.js";
import { notificationFor, type SlackNotifier } from "./notifier.js";
import type { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import {
  mergePlatforms,
  type Platform,
  type PlatformSummary,
  platformPromptLines,
  platformSummary,
} from "./platforms.js";
import {
  fillTemplate,
  limitBody,
  PR_BODY_MAX,
  type PullRequestTemplates,
  type TemplateLookup,
} from "./pr-template.js";
import type { ProjectStore } from "./projects.js";
import {
  allowedPlans,
  type BodyParts,
  type BodyText,
  buildChatPrompt,
  buildChildBody,
  buildExportDocument,
  buildExportPrompt,
  buildFinalReviewPrompt,
  buildGuardianPrompt,
  buildIntegrationReviewPrompt,
  buildInvestigationComment,
  buildOrchestratorPrompt,
  buildPrompt,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildReviewBody,
  buildReviewComments,
  buildReworkPrompt,
  buildStepDocument,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
  buildStepPullRequestTitle,
  buildTicketInvestigationComment,
  buildTicketPullRequestComment,
  buildTicketTriagePrompt,
  type ChatLogs,
  changeableSteps,
  EXECUTABLE_STEPS,
  EXPORT_FILE,
  type ExportDestination,
  extractBlocks,
  extractExport,
  extractFinalReview,
  extractIntegrationReview,
  extractReproduction,
  extractReviewComments,
  extractRework,
  extractSplitPlan,
  extractStepPlan,
  extractTicketTriage,
  extractVerdict,
  finalReviewViewpointIds,
  integrationViewpointIds,
  investigationMarker,
  operationSucceeded,
  postedLatestCommit,
  type RawExportPlan,
  type RawServices,
  referencedPullRequest,
  reviewMarker,
  type SplitChild,
  type SubtaskSummary,
  servicePromptLines,
} from "./prompts.js";
import { CONTAINER_LOGS_DIR, stageQuestionLogs } from "./question-logs.js";
import { NothingToCommitError, type RepositoryWorkspace } from "./repository.js";
import {
  contextSecretUses,
  type SecretUse,
  secretUses,
  settingsSecretUses,
  uniqueUses,
} from "./secret-uses.js";
import { type PrefetchingSecretStore, SecretNotFoundError, type SecretStore } from "./secrets.js";
import {
  localForwards,
  type ServiceRunner,
  type ServicesSpec,
  type StartedServices,
} from "./services.js";
import type {
  ArchivedAgentSession,
  SessionLogFile,
  SessionLogHandle,
  SessionLogOffsets,
  SessionLogStore,
  StoredSessionLog,
} from "./session-logs.js";
import type { SettingsStore } from "./settings.js";
import {
  GitSharedComposeFetcher,
  type SharedComposeFetcher,
  sharedComposeRunDir,
} from "./shared-compose.js";
import { templateTask } from "./task-templates.js";
import { findTestFiles, noTestsStop } from "./test-files.js";
import { type FoundTicket, type TicketClient, ticketErrorText } from "./tickets.js";
import type { UpdateStatus } from "./update-check.js";

/**
 * レビューの工程で、PR の差分の全体を置くファイルの名前（PBI-65）。sacty が管理する `_review/<runId>/` に置き、
 * 読み取り専用で別にマウントする。作業領域の写しは PR 由来のリンクやファイルを含むので、その中には書かない。
 */
const REVIEW_DIFF_FILE = "pr.diff";

/** 共用の compose の取得の失敗の理由（git の出力）の上限（PBI-70）。 */
const SHARED_FETCH_DETAIL_MAX = 2000;

/**
 * 取り込みの1つの検索に入れる対象（repo:・org:）の数の上限（PBI-140）。GitHub の検索は 80 個でも答えるが、URL の長さに
 * 余裕を持たせて、これを超えたら検索を分ける。
 */
export const INTAKE_SCOPES_PER_QUERY = 30;

/** 並びを size ずつに分ける。 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

/** 文の、外から来た文の部分を、末尾の max 文字に切り詰める（秘密情報を伏せた後に使う）。 */
/** コンテナの中での、エージェントの設定のディレクトリ（コンテキストを置く場所）。 */
function contextContainerDir(runtime: "claude-code" | "codex"): string {
  return runtime === "codex" ? CONTAINER_CODEX_HOME : CONTAINER_CLAUDE_CONFIG_DIR;
}

/**
 * プロジェクトのコンテキストのプレビュー（PBI-76）。platforms は、ホストの PF とあわせた使える外部 PF の要約（秘密情報の
 * 名前・値は含めない）。
 */
export type ContextPreviewView = Omit<ContextPreview, "platforms"> & {
  platforms: PlatformSummary[];
};

function clipText(text: DaemonText, max: number): DaemonText {
  return mapFreeText(text, (value) => (value.length > max ? `…${value.slice(-max)}` : value));
}

type ActivityItem = { actor: Actor; event: EventInput };

/** 実行に渡すコンテキストと、置いた段階のサブエージェントの定義（PBI-119）。 */
type RunContext = Awaited<ReturnType<typeof prepareContext>> & { tiers: PlacedTier[] };

export type CleanupItem = { target: CleanupTarget; present: boolean; detail?: DaemonText };
type CleanupResult = {
  target: CleanupTarget;
  result: "done" | "skipped" | "failed";
  detail?: DaemonText;
};

/** 実装の検証（テストか最終レビュー）を待っているか。変更の申し出の判断待ちの間は検証しない。 */
/**
 * 起動したサービスに、エージェント・テストのコンテナからつなぐ設定（PBI-47）。ネットワークと、
 * localhost に転送するポート（PBI-60。転送するものが無ければ渡さない）。
 */
function serviceConnection(started: StartedServices): {
  network: string;
  forwards?: LocalForward[];
} {
  const { forwards } = localForwards(started.services);
  return { network: started.network, ...(forwards.length > 0 ? { forwards } : {}) };
}

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

/** 大まかな監査の記録の、メモリーをコンテキストにする提案（原因の形。PBI-128）。 */
type SurveyPromotionRecord = NonNullable<
  Extract<EventInput, { type: "AuditSurveyed" }>["payload"]["promotions"]
>[number];

/**
 * メモリーを読ませる工程の実行（PBI-126）。統合レビューはゴールガーディアンの役なので除く（判定の材料を承認済みのものに
 * 限る）。rework は、PR の指摘の差し戻し先をゴールガーディアンが判定する実行なので入れない（手直しそのものは、工程の役で
 * 実行し直す。PR #136 レビュー指摘）。
 */
export const MEMORY_STEP_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(
  StepKey.options.filter((k) => k !== "integrate"),
);

export type ServiceDeps = {
  activity: ActivityStore;
  /**
   * 完了したタスクを監査する（PBI-125）。既定は監査しない（テストや、監査の画面をモックで確かめるとき）。main.ts が
   * モックでないときに有効にする。
   */
  audit?: boolean;
  /** 呼ぶたびに設定を読み直す（デーモンを止めずに設定を変えられるように）。 */
  config: () => ConfigResult;
  secrets: SecretStore;
  executor: AgentExecutor;
  /** 実装の対象リポジトリの clone・差分・コミットとプッシュ。 */
  repos: RepositoryWorkspace;
  /** PRの作成。 */
  pulls: PullRequests;
  /** PR テンプレートを探す口（PBI-87）。無ければ、テンプレートを使わない（sacty の決まった形の本文にする）。 */
  templates?: PullRequestTemplates;
  /** マージのコミットの CI/CD の状態（PBI-89）。無ければ、マージの後の CI/CD を確かめられない（時間切れで終わる）。 */
  ci?: CiStatusReader;
  /** GitHub への認証（ホストの gh のアカウント。PBI-13）。 */
  github: GitHubAuth;
  /** 現在の時刻（テストで差し替える）。 */
  now?: () => number;
  /** オーケストレーターの代わりに工程を選ぶ（テストで差し替える。PBI-17）。 */
  planner?: (task: Task) => Promise<PlannedSteps>;
  /** チケット（JIRA など）の検索とコメント（PBI-52）。無ければ、チケットを扱わない。 */
  tickets?: TicketClient;
  /** docker compose のサービスを起動する口（PBI-47）。無ければ、サービスを使わない。 */
  services?: ServiceRunner;
  /**
   * 共用の compose のリポジトリの取得（PBI-70）。無ければ、作業領域の根の下にキャッシュを置いて git で取得する。
   */
  sharedComposes?: SharedComposeFetcher;
  /** プロジェクトの設定。 */
  projects: ProjectStore;
  /** sacty 全体の設定（取り込むラベルなど。PBI-26）。 */
  settings: SettingsStore;
  /** コンテキストリポジトリの取得（PBI-6）。 */
  contexts: ContextFetcher;
  /** sacty に同梱する既定のコンテキストのディレクトリ（PBI-24）。無ければ、プロジェクトのコンテキストだけを渡す。 */
  defaultContext?: string;
  /**
   * 秘密情報をまとめて取り出すときに、プロジェクトのコンテキストを読むのを待つ上限（ミリ秒。PBI-107）。既定は
   * CONTEXT_SECRETS_TIMEOUT_MS。超えたプロジェクトのコンテキストの秘密情報は、使うときに取り出す。
   */
  contextSecretsTimeoutMs?: number;
  /** テストの実行。 */
  tests: TestRunner;
  /** タスクごとの作業領域を作る場所。 */
  workspaceRoot: string;
  /** ホストのゲートウェイ（PBI-37）。無ければ、ゲートウェイ経由のエージェントは実行できない。 */
  gateway?: Pick<AiGateway, "containerOrigin" | "register" | "platformsUrl">;
  /** 認証情報を用意できない組織内 PF の理由（画面の状態に出す。PBI-35）。 */
  platformProblems?: (names: readonly string[]) => DaemonText[];
  /** 準備ができないホストの MCP サーバーの理由（画面の状態に出す。PBI-36）。 */
  hostMcpProblems?: () => DaemonText[];
  /**
   * 実行の前に、その実行が使うホストの MCP サーバーの準備を待つ（PBI-77。設定に足した直後でも使えるよう、設定と突き合わせて
   * 起動を待つ。上限あり）。準備ができないものの理由を返す。無ければ待たない。
   */
  hostMcpReady?: (names: readonly string[]) => Promise<DaemonMessage[]>;
  /**
   * コンテキストの command の MCP サーバーをホストで動かす（PBI-84）。ゲートウェイと一緒に渡す。無ければ、これまでどおり
   * コンテナの中で起動する。
   */
  contextMcp?: Pick<ContextMcpServers, "lease" | "ready">;
  /** sacty の新しい版の知らせ（PBI-135）。最新・確かめられない・OFF なら undefined。 */
  update?: () => UpdateStatus | undefined;
  /** 人間の出番の通知（PBI-38）。送るのは待たない。 */
  notifier?: Pick<SlackNotifier, "notify" | "test" | "problems"> &
    Partial<Pick<SlackNotifier, "settingsChanged">>;
  /**
   * 要求要件・設計を、対象のリポジトリへの PR のマージで承認するか（PBI-57）。既定は承認する（PR を作れるタスクだけ）。
   * false なら、これまでどおり sacty の画面で承認する（画面の承認の流れを確かめるテストで切る）。
   */
  stepPullRequests?: boolean;
  /** エージェントの実行ごとのセッションログの置き場所（PBI-62）。無ければ、残さない。 */
  sessionLogs?: SessionLogStore;
  /**
   * タスクごとのオーケストレーターのセッションの置き場所（PBI-67）。無ければ（セッションログも要る）、オーケストレーターも
   * 毎回新しいセッションで実行する。
   */
  orchestratorSessions?: OrchestratorSessionStore;
  /**
   * 監査が登録したメモリーを書き出す場所（SACTY_HOME/memory。PBI-126）。無ければ、深掘りに登録を求めず、出力にあっても
   * 登録しない。エージェントにも渡さない。
   */
  memoryRoot?: string;
  /** 階層ごとのメモリーの件数の上限（無ければ MEMORY_MAX_PER_LAYER。テストで小さくする）。 */
  memoryLimit?: number;
};

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: DaemonText[];
  /** 動くが、知らせたいこと（認証情報を用意できない組織内 PF など。PBI-35）。 */
  warnings: DaemonText[];
  /** 取り込みの状況（設定ファイルを読めなければ null）。 */
  intake: IntakeStatus | null;
  /** プロジェクトの対象で選べる、言語ごとのイメージ（名前と説明。PBI-41）。 */
  images: { name: string; description: string }[];
  /** チケットの取り込み先に選べる接続先（gateway.platforms の名前。PBI-52）。 */
  platforms: string[];
  /** タスクの詳細で工程のエージェントに選べるもの（config.yaml の agents。PBI-121）。 */
  agents: { id: string; runtime: string; model?: string; reasoningEffort?: string }[];
  /** config.yaml で決まる、工程ごとのエージェントの名前（step_agents か default_agent。PBI-121）。 */
  stepAgents: Partial<Record<StepKey, string>>;
  /** sacty の新しい版（PBI-135）。最新・確かめられない・OFF なら無い。 */
  update?: UpdateStatus;
};

export type IntakeStatus = {
  /** 取り込むラベル（sacty の設定。PBI-26）。設定していなければ無い（取り込まない）。 */
  label?: string;
  /** PR のレビュー用のラベルと、自分にレビューが依頼された PR を取り込むか（sacty の設定。PBI-44）。 */
  reviewLabel?: string;
  reviewRequested?: boolean;
  /** Off にしたトリアージの種類（sacty の設定。PBI-53）。 */
  triageOff?: TriageKind[];
  /** チケットの取り込むラベル（sacty の設定。PBI-52）。 */
  ticketLabel?: string;
  /** 取り込みの種類ごとの、直近の取り込み（PBI-100。種類ごとに別の間隔で取り込む）。まだ取り込んでいない種類は無い。 */
  runs?: Partial<Record<IntakeKind, IntakeRun>>;
  /** sacty の設定を読めなかった（ラベルなどは無い。PBI-100）。 */
  settingsUnreadable?: true;
  /** sacty の設定を読めなかった理由（PBI-100）。 */
  settingsError?: DaemonText;
};

/** 1つの種類の、直近の取り込み（PBI-100）。 */
export type IntakeRun = {
  lastRunAt: string;
  /** 直近の取り込みで作ったタスクの数。 */
  imported: number;
  /** 取り込めなかった取り込み元（検索の条件）と理由。 */
  errors?: { query?: string; message: DaemonText }[];
};

/**
 * 取り込みの検索の条件（取り込み元）。account は検索に使う gh のアカウント、project はプロジェクトの名前（まとめた検索は、
 * 含むプロジェクトの名前を「・」でつないだもの。PBI-140）。
 * review は、PR のレビューの取り込みの検索（PBI-44）。
 */
export type IntakeSource = {
  host: string;
  query: string;
  account?: string;
  project: string;
  review?: "requested" | "label";
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
/** エージェントの実行の結果（費用を含む）。 */
type Executed = { outcome: AgentOutcome; costUsd: number; estimated: boolean };

/** エージェントの1回の実行（TaskService.execute）に渡すもの。 */
type ExecuteRun = {
  agent: AgentConfig;
  image: string;
  /** 実行するタスク（セッションログの置き場所。PBI-62）。 */
  taskId: string;
  runId: string;
  prompt: string;
  role: AgentRole;
  workspaceDir: string;
  /** エージェントの形式に変換したコンテキスト（工程エージェントだけ。PBI-6）。 */
  context?: Parameters<typeof buildInvocation>[5];
  /**
   * 費用を概算として記録する（PBI-119）。段階のサブエージェントの定義を置いた実行は、担当が親と違うモデルで動きうるが、
   * 費用は親の結果の使用量 × 親の単価でしか出せないため。
   */
  estimateCost?: boolean;
  /** 使わせる組織内 PF の API（工程エージェントだけ。PBI-35）。 */
  platforms?: readonly Platform[];
  /** イメージの環境変数（言語ごとのイメージの env。PBI-41）。 */
  imageEnv?: Record<string, string>;
  /** つなぐネットワーク（docker compose のサービス。PBI-47）。 */
  network?: string;
  /** コンテナの中で localhost に転送するサービスのポート（PBI-60）。 */
  forwards?: readonly LocalForward[];
  /**
   * ゲートウェイ経由にした、コンテキストの HTTP の MCP サーバー（PBI-49）と、ホストで起動した command の MCP サーバー
   * （PBI-84）。
   */
  contextMcp?: readonly (GatewayMcpServer | HostedMcpRelay)[];
  /** 追加でマウントする、sacty が管理するディレクトリ（レビューの差分の全体。PBI-65）。 */
  mounts?: readonly { hostPath: string; containerPath: string; readOnly: boolean }[];
  /** 作業領域の外で読ませるディレクトリ（コンテナの中のパス。質問への答えの各実行のセッションログ。PBI-91）。 */
  readDirs?: readonly string[];
  /** true を返すと、コンテナを起動しない（質問への答えの実行が中止されたなど。PBI-54）。 */
  stopped?: () => boolean;
  /** 実行の ID が変わったら知らせる（セッションを新しく始め直したとき。止めるため。PBI-67）。 */
  onRunId?: (runId: string) => void;
};

/**
 * エージェントが、再開するセッションを受け付けなかったときのエラーの文（PBI-67）。エージェントの本体にある文から選ぶ
 * （推し量って広く取らない）。
 * - Claude Code（2.1.296 の本体で確かめた）：セッションが見つからない `No conversation found with session ID: <ID>`、
 *   読み込めない `--resume session load failed (…)`・`Failed to resume session <ID>`。どれも終了コード 1
 * - Codex（codex-cli 0.160.0 の本体で確かめた）：`no rollout found for thread id <ID>`・
 *   `no rollout found for conversation id <ID>`・`rollout path missing for thread <ID>`・`thread not found: <ID>`・
 *   `error resuming thread: …`
 */
const RESUME_REJECTED: Record<"claude-code" | "codex", RegExp[]> = {
  "claude-code": [
    /No conversation found with session ID: /,
    /--resume session load failed \(/,
    /Failed to resume session /,
  ],
  codex: [
    /no rollout found for (?:thread|conversation) id /i,
    /rollout path missing for thread /i,
    /thread not found: /i,
    /error resuming thread: /i,
  ],
};

/**
 * 再開したセッションを、エージェントが受け付けなかったか（PBI-67）。そうなら、新しいセッションで始め直す。
 * 始め直すのは、保存したセッションを設定の場所に戻せなかったときと、エージェントが再開を拒んだと文から分かるときだけ。
 * どちらも、何も使わずに失敗したとき（使ってから失敗したなら、再開はできている）。タイムアウト・コンテナの停止を
 * 確かめられない・途中で落ちたなど、ほかのエラーはそのまま返す（始め直すと、残ったコンテナや失敗を隠すため）。
 */
export function resumeRejected(runtime: "claude-code" | "codex", outcome: AgentOutcome): boolean {
  if (outcome.kind !== "failed" || outcome.reason !== "error") return false;
  const u = outcome.usage;
  if (u && u.input + u.cacheRead + u.cacheWrite + u.output > 0) return false;
  const text = outcome.message;
  if (typeof text !== "string") return text.code === "run.sessionRestoreFailed";
  return RESUME_REJECTED[runtime].some((pattern) => pattern.test(text));
}

/**
 * 秘密情報をまとめて取り出すときに、プロジェクトのコンテキストを読むのを待つ上限（PBI-107）。起動のときは、取り出し終える
 * までタスクの実行と取り込みを始めないので、プロジェクトが多くても、これより長くは止めない。
 */
export const CONTEXT_SECRETS_TIMEOUT_MS = 30_000;

/** 秘密情報をまとめて取り出すときに、同時に読むプロジェクトのコンテキストの数（PBI-107）。 */
export const CONTEXT_SECRETS_CONCURRENCY = 4;

export class TaskService {
  private tasks: Map<string, Task>;

  private intakeRuns: Partial<Record<IntakeKind, IntakeRun>> = {};
  private settingsSaves = 0;
  /** 実行中のタスクと、そのタスクで動いているコンテナ（一時停止・中止で止めるため）。 */
  private readonly inflight = new Map<string, { runIds: Set<string>; done: Promise<void> }>();
  /**
   * いま runNext が処理しているタスク。ワーカーは複数のタスクを同時に処理するので（PBI-30）、
   * 処理の流れごとに持つ（コンテナを、どのタスクの実行として覚えるかに使う）。
   */
  private readonly runningTask = new AsyncLocalStorage<string>();
  /** 人間が一時停止・中止を求めたタスク。実行中の処理は、終わったら一時停止として記録する。 */
  private readonly pauseRequested = new Set<string>();
  /**
   * タスクごとの、人が一時停止を求めた回数（メモリーだけに持つ。PBI-116 レビュー指摘）。CI/CD を読み始めたときと記録する直前で
   * 違えば、読んでいる間に一時停止した（すぐに再開していても）ので、読んだ結果を捨てる。読んでいる途中の処理はデーモンの再起動で
   * 消えるので、再起動で数え直しても困らない。
   */
  private readonly pauseCounts = new Map<string, number>();
  /** 共用の compose の取得（deps に無いときの既定。PBI-70）。 */
  private defaultSharedComposes: SharedComposeFetcher | undefined;
  /** 中止の後片付けをしているタスク（その間に実行を始めないため）。 */
  private readonly cancelling = new Set<string>();
  /** レビュー用のラベルを付けている途中の PR（タスクと PR。重ねて付けないため。PBI-88）。 */
  private readonly labeling = new Set<string>();
  /**
   * 質問に答えているタスクと、その実行（PBI-54）。工程の実行とは別に持つ（一時停止では止めず、中止では止める）。
   */
  private readonly chats = new Map<string, { runId: string; done: Promise<void> }>();
  /**
   * マージの後の監視で、前の確認ですべて終わっていた CI/CD の実行・チェックの並び（PBI-89）。続けて同じなら結果を決める
   * （CI の後に別のワークフロー（workflow_run のデプロイなど）が現れるのを、1回の確認ぶん待つため）。メモリーだけに持ち、
   * 再起動の後は1回ぶん余分に待つ。
   */
  private readonly ciSettled = new Map<string, string>();

  /** ダッシュボードの集計の元（作業履歴を畳み込んで持つ。PBI-118）。 */
  private readonly dashboardStats = new DashboardStats();
  /**
   * 実行待ちが上限より多い状態の始まり（ダッシュボードの待ち行列の欄。メモリーだけに持つ）。タスクの状態・実行の開始と終わり・
   * 設定・プロジェクトが変わるたびに trackQueue で更新し、画面の取得に依らず追う（PR #128 レビュー指摘）。
   */
  private queueOverSince: number | undefined;

  constructor(private readonly deps: ServiceDeps) {
    // 作業履歴を読むのと同じ1回の走査で、ダッシュボードの集計も作る（PBI-118）
    this.tasks = project(deps.activity.all(), (event, before, after) =>
      this.dashboardStats.add(event, before, after),
    );
    this.trackQueue();
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
   * タスクのエージェントの実行のセッションログ（PBI-62）。タスクが無い・その実行のログが無ければ undefined。
   * ログはタスクごとの場所に置くので、ほかのタスクの実行の ID を渡しても読めない。
   */
  sessionLog(
    taskId: string,
    runId: string,
    from?: SessionLogOffsets,
  ): StoredSessionLog | undefined {
    if (!this.tasks.has(taskId)) return undefined;
    return this.deps.sessionLogs?.read(taskId, runId, from);
  }

  /**
   * 写したエージェントの元のファイル（PBI-66）の一覧と、作業履歴に記録したハッシュとの一致。タスクが無い・その実行で
   * 写していなければ undefined。記録はタスクの作業履歴から探すので、ほかのタスクの実行の ID を渡しても読めない。
   */
  async agentSessionFiles(
    taskId: string,
    runId: string,
  ): Promise<
    | (Omit<Extract<ActivityEvent, { type: "AgentSessionArchived" }>["payload"], "files"> & {
        archivedAt: string;
        files: CheckedAgentFile[];
      })
    | undefined
  > {
    const found = this.archivedAgentSession(taskId, runId);
    const root = this.deps.sessionLogs?.agentFilesDir(taskId, runId);
    if (!found || !root) return undefined;
    const { files, ...rest } = found.payload;
    return { ...rest, archivedAt: found.at, files: await checkArchivedFiles(root, files) };
  }

  /** 写したエージェントのファイルの場所（ダウンロード用。PBI-66）。作業履歴に記録したファイルだけを返す。 */
  agentSessionFile(taskId: string, runId: string, path: string): string | undefined {
    const found = this.archivedAgentSession(taskId, runId);
    const root = this.deps.sessionLogs?.agentFilesDir(taskId, runId);
    if (!found || !root || !found.payload.files.some((f) => f.path === path)) return undefined;
    return archivedFilePath(root, path);
  }

  private archivedAgentSession(
    taskId: string,
    runId: string,
  ): Extract<ActivityEvent, { type: "AgentSessionArchived" }> | undefined {
    if (!this.tasks.has(taskId)) return undefined;
    return this.deps.activity
      .forTask(taskId)
      .filter(
        (e): e is Extract<ActivityEvent, { type: "AgentSessionArchived" }> =>
          e.type === "AgentSessionArchived" && e.payload.runId === runId,
      )
      .at(-1);
  }

  /** セッションログの生のファイルの場所（ダウンロード用。PBI-62）。タスクやログが無ければ undefined。 */
  sessionLogFile(taskId: string, runId: string, file: SessionLogFile): string | undefined {
    if (!this.tasks.has(taskId)) return undefined;
    const path = this.deps.sessionLogs?.path(taskId, runId, file);
    return path && existsSync(path) ? path : undefined;
  }

  /**
   * 承認待ちのタスクの PR の状態を確かめ、変化を記録する（PBI-14a）。
   * 実装の PR がマージされたら実装を承認してタスクを完了にし（PBI-110）、マージせずに閉じられたら記録して人間の判断を
   * 待つ（開き直されたら見守りを続ける）。PR は、プロジェクトの gh のアカウントで確かめる。
   * 確かめられないタスク（ネットワークやアカウントの問題）は、次の確認でやり直す。
   */
  async checkPullRequests(): Promise<void> {
    // 実装の PR と、要求要件・設計の PR（PBI-57・PBI-110）
    const waiting = [...this.tasks.values()].filter(
      (t) =>
        (t.status === "awaiting_approval" || t.status === "escalated") && gatePullRequest(t)?.repo,
    );
    for (const task of waiting) {
      const pr = gatePullRequest(task);
      if (!pr?.number || !pr.repo) continue;
      const usedSecrets: string[] = [];
      let status: PullRequestStatus;
      let token: string;
      try {
        token = await this.githubToken(task, pr.repo, usedSecrets);
        status = await this.deps.pulls.status({ repo: pr.repo, token, number: pr.number });
      } catch (error) {
        console.warn(
          `[daemon] PR #${pr.number}（${pr.repo}）の状態を確認できませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
        continue;
      }
      // 確かめている間に、人間が差し戻した・中止したなどで変わっていれば、記録しない
      const stillWatched = () => {
        const latest = this.tasks.get(task.id);
        if (!latest || this.cancelling.has(task.id)) return undefined;
        const watched = gatePullRequest(latest);
        if (
          watched?.step !== pr.step ||
          (latest.status !== "awaiting_approval" && latest.status !== "escalated") ||
          watched.number !== pr.number ||
          watched.commit !== pr.commit
        ) {
          return undefined;
        }
        return { latest, watched };
      };
      const found = stillWatched();
      if (!found) continue;
      let latest = found.latest;
      const current = found.watched.state;
      // 前の版で、違う内容でのマージとして止めた（merged_outdated）タスクも、承認として進める（PBI-63）
      if (status.state === current) {
        // 開いたままの PR は、レビュー・コメントを指摘として取り込む（PBI-14b・PBI-57）
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
      if (status.state === "merged") {
        // sacty が出したコミットと違う内容でマージされた（人が PR の中で直した・提案のコミットを積んだ）も、人がマージした
        // ＝人が承認したので、承認として進める（最終レビューはやり直さない。PBI-63）。監査のため、sacty が出したコミットと
        // 人が直した最終のコミットを両方残す。要求要件・設計は、人が直したファイルを承認済みの成果にする
        const edited = status.headSha !== pr.commit;
        let document: PullRequestMerge["document"];
        if (edited && pr.step !== "implement") {
          // 読むのは、マージの時点を特定できるコミット（マージのコミット、取れなければ PR の先頭）。タスクブランチの
          // 先端は、マージの後に積まれた未レビューの変更を含みうるので使わない
          const read = await this.readMergedDocument(
            latest,
            pr.number,
            status.mergeCommit ?? status.headSha,
            usedSecrets,
          );
          // タスクブランチを取得できなければ、何も記録せずに次の確認でやり直す
          if (read === "retry") continue;
          document = read;
          const again = stillWatched();
          if (!again) continue;
          latest = again.latest;
        }
        // マージは人間の承認なので、承認者は人間として記録する。要求要件・設計の PR（PBI-57）は、その工程の承認として
        // 次の工程に進める（承認した成果の書き出し（PBI-56）は、この承認の後に行う）
        const head = edited ? status.headSha : pr.commit;
        this.append(latest, [
          {
            actor: "person",
            event: {
              type: "PullRequestMerged",
              payload: {
                number: pr.number,
                ...(status.mergedBy ? { by: status.mergedBy } : {}),
                ...(head ? { commit: head } : {}),
                outdated: false,
                submitted: pr.commit,
                ...(status.mergeCommit ? { mergeCommit: status.mergeCommit } : {}),
                edited,
                ...(document ? { document } : {}),
              },
            },
          },
          {
            actor: "person",
            event: {
              type: "StepApproved",
              payload: {
                step: pr.step,
                next: this.nextAfterApproval(latest, pr.step),
              },
            },
          },
          // 実装の PR のマージなら、マージのコミットの CI/CD とデプロイの監視を始める（PBI-89。プロジェクトで On のときだけ）
          ...this.deploymentWatchEvents(latest, pr.step, pr.number, pr.repo, status.mergeCommit),
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
    // コンテキストにする改修の PR がマージされたメモリーを消す（PBI-128）
    this.cleanupPromotedMemories();
    await this.checkReviewPullRequests();
    // 公開の後、ラベルを付ける前に止まった PR に付ける（PBI-88 レビュー指摘）
    await this.resumePullRequestLabels();
    // マージの後の CI/CD とデプロイの監視（PBI-89）
    await this.checkDeployments();
  }

  /**
   * 人が PR の中で直してからマージした、要求要件・設計の成果のファイルを、マージ後のタスクブランチから読む（PBI-63）。
   * 退避した git のメタデータで読み、作業領域・利用者の git の設定は使わない。読むのは、その PR に出した成果のファイルの
   * パスだけ。読むコミットは、マージの時点を特定できるコミット（マージのコミット、取れなければ PR の先頭のコミット）で、
   * 退避したメタデータに無ければ取得する（タスクブランチの先端は、マージの後に積まれた未レビューの変更を含みうるので
   * 読まない）。sacty の版と違えば両方の本文を、同じなら本文を残さない。取得はできたが、ファイルが消された・中身を読めない
   * （大きすぎる・UTF-8 でない・NUL を含む・通常のファイルでない）なら、sacty の版を承認済みにするよう、そのことを残す。
   * タスクブランチを取得できない（ネットワーク・認証・GitHub の一時的なエラーなど）なら retry を返し、何も記録せずに
   * 次の確認でやり直す（理由はデーモンのログに出す。秘密情報は伏せる）。
   */
  private async readMergedDocument(
    task: Task,
    number: number,
    merged: string | undefined,
    usedSecrets: string[],
  ): Promise<PullRequestMerge["document"] | "retry"> {
    const entry = task.stepPullRequests.find((p) => p.number === number);
    if (!entry) return undefined;
    const { step, path } = entry;
    const retry = (reason: DaemonText): "retry" => {
      console.warn(
        `[daemon] PR #${number} でマージされた ${path} を取得できませんでした。次の確認でやり直します：${renderMessage(redactText(reason, usedSecrets), "ja")}`,
      );
      return "retry";
    };
    const loaded = this.deps.config();
    if (!loaded.ok) return retry(loaded.problem);
    // 退避した git のメタデータが無ければ、同じ起点で用意し直す
    const ready = await this.prepareRepository(task, loaded.config);
    if (!ready.ok) return retry(ready.message);
    const current = this.mustGet(task.id);
    const taskBranch = current.taskBranch;
    if (!current.repository || !taskBranch) return retry(message("pr.workspaceMissing"));
    // マージの時点を特定できるコミットが GitHub から取れなければ、次の確認でやり直す
    if (!merged) return retry(message("git.invalidBaseCommit"));
    const commit = merged;
    const gitDir = this.trustedGitDir(current);
    try {
      const authEnv = await this.gitAuth(current, current.repository.url, usedSecrets);
      // タスクブランチを取得すれば、マージのコミットは通常それに含まれる。含まれなければ（PR の先頭のコミットなど）、
      // そのコミットを取得する（すでにあれば取得しない）
      await this.deps.repos.fetchBranch(gitDir, taskBranch.branch, authEnv);
      await this.deps.repos.fetchCommits(gitDir, [commit], authEnv);
    } catch (error) {
      return retry(errorText(error));
    }
    let content: string | undefined;
    try {
      content = await this.deps.repos.readFile(gitDir, commit, path);
    } catch (error) {
      const reason = redactText(errorText(error), usedSecrets);
      // 中身を読めない（ファイルの問題）ときだけ、sacty の版で承認する。git を実行できないなどは、やり直す
      if (
        typeof reason === "string" ||
        !["git.fileNotRegular", "git.fileTooLarge", "git.fileNotText"].includes(reason.code)
      ) {
        return retry(reason);
      }
      console.warn(
        `[daemon] PR #${number} でマージされた ${path} を読めませんでした。sacty の版を承認済みにします：${renderMessage(reason, "ja")}`,
      );
      return { path, commit, fallback: "unreadable", reason };
    }
    if (content === undefined) {
      console.warn(
        `[daemon] PR #${number} のマージで ${path} が消されました。sacty の版を承認済みにします`,
      );
      return { path, commit, fallback: "deleted" };
    }
    const sacty = buildStepDocument(task, step);
    return content === sacty ? { path, commit } : { path, commit, sacty, final: content };
  }

  /**
   * PR のレビューの取り込みのタスク（PBI-44）のうち、終わっていないものの PR の状態を確かめ、マージされた・
   * マージせずに閉じられたら中止する（もうレビューする必要が無いため）。PR は、プロジェクトの gh のアカウントで
   * 確かめる。確かめられないタスクは、次の確認でやり直す。
   */
  private async checkReviewPullRequests(): Promise<void> {
    const open = [...this.tasks.values()].filter(
      (t) =>
        t.source?.review !== undefined &&
        t.source.kind === "github_pull_request" &&
        t.status !== "cancelled" &&
        !isCompleted(t),
    );
    for (const task of open) {
      const source = task.source;
      if (!source) continue;
      const usedSecrets: string[] = [];
      let status: PullRequestStatus;
      try {
        const token = await this.githubToken(task, source.repo, usedSecrets);
        status = await this.deps.pulls.status({ repo: source.repo, token, number: source.number });
      } catch (error) {
        console.warn(
          `[daemon] PR #${source.number}（${source.repo}）の状態を確認できませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
        continue;
      }
      if (status.state === "open") continue;
      // 確かめている間に、中止された・完了した（レビューを投稿した）なら、中止しない
      const latest = this.tasks.get(task.id);
      if (!latest || latest.status === "cancelled" || isCompleted(latest)) continue;
      if (this.cancelling.has(task.id)) continue;
      await this.cancel(
        task.id,
        status.state === "merged" ? "pull_request_merged" : "pull_request_closed",
      ).catch((error: unknown) => {
        console.warn(`[daemon] レビューのタスク ${task.id} を中止できませんでした：`, error);
      });
    }
  }

  /**
   * 実装の PR のマージで、マージのコミットの監視を始める記録（PBI-89）。マージの後の監視の工程（PBI-116）を飛ばしていない
   * タスクの、実装の PR のマージのときだけ。マージのコミットが取れなければ、監視を飛ばす記録になる（工程も終わる）。
   */
  private deploymentWatchEvents(
    task: Task,
    step: StepKey,
    number: number,
    repo: string,
    mergeCommit: string | undefined,
  ): { actor: Actor; event: EventInput }[] {
    if (step !== "implement" || !task.repository) return [];
    if (!task.steps.some((s) => s.key === "deployment" && s.state === "todo")) return [];
    return [
      {
        actor: "sacty",
        event: {
          type: "DeploymentWatchStarted",
          payload: {
            number,
            repo,
            branch: task.repository.baseBranch,
            ...(mergeCommit ? { commit: mergeCommit } : {}),
          },
        },
      },
    ];
  }

  /**
   * マージの後の監視（PBI-89）。PR の確認（60秒ごと）から呼ぶ。CI/CD の結果を待っているタスクの状態を読み、終わって
   * いれば結果を記録する。失敗なら修正のタスクを登録する（二重の登録と、連鎖の上限を確かめる）。登録したのに作る前に
   * 止まった修正のタスクも、ここで作る。1つのタスクの失敗は、ほかのタスクを止めない。
   */
  async checkDeployments(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      if (task.status === "cancelled" || !task.deployment || this.cancelling.has(task.id)) continue;
      // 一時停止したタスクは、CI/CD を見ない（再開すると続ける。PBI-116）
      if (task.status === "paused" || this.pauseRequested.has(task.id)) continue;
      try {
        if (awaitingDeploymentCi(task)) await this.pollDeploymentCi(task);
        const latest = this.tasks.get(task.id);
        if (latest && fixDecisionPending(latest)) this.registerFixTask(latest);
        const again = this.tasks.get(task.id);
        if (again) this.createRegisteredFixTask(again);
      } catch (error) {
        console.warn(
          `[daemon] タスク ${task.id} のマージの後の監視に失敗しました：${renderMessage(errorText(error), "ja")}`,
        );
      }
    }
  }

  /**
   * マージのコミットの CI/CD の状態を読み、終わっていれば結果を記録する（PBI-89）。読めない（認証・ネットワーク）なら
   * 記録せず、次の確認でやり直す（時間の上限を過ぎていれば時間切れ）。通ったら、デプロイの確認のスキルを探す。
   */
  private async pollDeploymentCi(task: Task): Promise<void> {
    const watch = task.deployment;
    if (!watch?.commit) return;
    const commit = watch.commit;
    const elapsed = this.now() - Date.parse(watch.startedAt);
    const usedSecrets: string[] = [];
    // 読み始めたときの一時停止の回数（読んでいる間に一時停止したかを、すぐに再開した後でも見分ける）
    const pauses = this.pauseCounts.get(task.id) ?? 0;
    type Payload = Extract<EventInput, { type: "DeploymentCiFinished" }>["payload"];
    const record = (payload: Payload) => {
      const latest = this.tasks.get(task.id);
      if (!latest || this.cancelling.has(task.id) || !awaitingDeploymentCi(latest)) return;
      // 読んでいる間に一時停止した（すぐに再開したときも）なら、結果を捨てる（再開した後の確認で取り直す。PBI-116 レビュー指摘）
      if (
        latest.status === "paused" ||
        this.pauseRequested.has(task.id) ||
        (this.pauseCounts.get(task.id) ?? 0) !== pauses
      ) {
        return;
      }
      this.append(latest, [{ actor: "sacty", event: { type: "DeploymentCiFinished", payload } }]);
    };
    let token: string;
    let snapshot: Awaited<ReturnType<CiStatusReader["snapshot"]>>;
    try {
      if (!this.deps.ci) throw new Error("CI/CD の状態を読む口がありません");
      token = await this.githubToken(task, watch.repo, usedSecrets);
      snapshot = await this.deps.ci.snapshot({ repo: watch.repo, token, commit });
    } catch (error) {
      console.warn(
        `[daemon] ${watch.repo} のコミット ${commit} の CI/CD の状態を読めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
      if (elapsed >= DEPLOYMENT_CI_TIMEOUT_MS)
        record({ result: "timed_out", checks: [], failures: [] });
      return;
    }
    // 記録するのは、失敗・終わっていないものを先に 50 件まで（作業履歴を膨らませない）
    const checks = [...snapshot.checks]
      .sort(
        (a, b) =>
          Number(isFailedConclusion(b)) - Number(isFailedConclusion(a)) ||
          Number(b.status === "pending") - Number(a.status === "pending"),
      )
      .slice(0, 50);
    if (snapshot.checks.length === 0) {
      // ワークフローの作成には少し時間がかかるので、しばらく待ってから CI/CD が無いと決める
      if (elapsed >= DEPLOYMENT_CI_GRACE_MS) record({ result: "none", checks: [], failures: [] });
      return;
    }
    if (snapshot.checks.some((c) => c.status === "pending")) {
      this.ciSettled.delete(task.id);
      if (elapsed >= DEPLOYMENT_CI_TIMEOUT_MS)
        record({ result: "timed_out", checks, failures: [] });
      return;
    }
    // すべて終わっていても、前の確認と同じになるまで（後から別のワークフローが現れないか）1回待つ
    const signature = JSON.stringify(
      snapshot.checks.map((c) => [c.kind, c.name, c.url ?? "", c.conclusion ?? ""]).sort(),
    );
    if (this.ciSettled.get(task.id) !== signature && elapsed < DEPLOYMENT_CI_TIMEOUT_MS) {
      this.ciSettled.set(task.id, signature);
      return;
    }
    this.ciSettled.delete(task.id);
    const failedChecks = snapshot.checks.filter(isFailedConclusion);
    if (failedChecks.length > 0) {
      let failures: CiFailure[] = [];
      try {
        failures = await this.deps.ci.failures({
          repo: watch.repo,
          token,
          runs: snapshot.failedRuns,
          secrets: usedSecrets,
        });
      } catch (error) {
        console.warn(
          `[daemon] ${watch.repo} の失敗したジョブを読めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
      }
      // ワークフローの実行の外のもの（ほかのアプリのチェック・コミットの状態）も、失敗として書く
      for (const c of failedChecks) {
        if (c.kind === "workflow" && failures.some((f) => f.workflow === c.name)) continue;
        failures.push({
          workflow: c.name,
          conclusion: c.conclusion ?? "",
          ...(c.url ? { url: c.url } : {}),
        });
      }
      record({ result: "failed", checks, failures: failures.slice(0, CI_FAILURES_MAX) });
      return;
    }
    // 通った。マージのコミットに、デプロイの確認のスキルがあるかを見る（読めなければ、次の確認でやり直す）
    const skill = await this.deploymentSkill(task, commit, usedSecrets);
    if (skill === "retry") {
      if (elapsed >= DEPLOYMENT_CI_TIMEOUT_MS) {
        record({
          result: "passed",
          checks,
          failures: [],
          skipCheck: message("deploy.skillMissing"),
        });
      }
      return;
    }
    record(
      "path" in skill
        ? { result: "passed", checks, failures: [], skill: skill.path }
        : { result: "passed", checks, failures: [], skipCheck: skill.problem },
    );
  }

  /**
   * マージの後の監視の工程をするかを決める（PBI-116）。起点のコミットに、デプロイの確認のスキル（deployment-observer）が
   * あればする（そのパス）。無い・使えない・探せないなら、理由を付けて飛ばす。工程を決めた後にスキルが増えても、この
   * タスクでは見ない。消えたら、CI/CD を見てデプロイの確認を飛ばす（マージのコミットで探し直す。checkDeployments）。
   */
  private async deploymentChoice(
    task: Task,
    commit: string | undefined,
  ): Promise<NonNullable<Extract<EventInput, { type: "StepsChosen" }>["payload"]["deployment"]>> {
    const skip = (detail: DaemonText) => ({ skipped: message("deploy.stepSkipped", { detail }) });
    if (!commit) return skip(message("deploy.noSkill"));
    try {
      const found = await findDeploymentSkill(this.deps.repos, this.trustedGitDir(task), commit);
      if ("path" in found) return { skill: found.path };
      return skip(
        typeof found.problem !== "string" && found.problem.code === "deploy.skillMissing"
          ? message("deploy.noSkill")
          : found.problem,
      );
    } catch (error) {
      return skip(message("deploy.skillLookupFailed", { detail: errorText(error) }));
    }
  }

  /**
   * 工程の選択に、マージの後の監視の工程をするかを足す（PBI-116）。飛ばすなら、その工程の既定のイメージの理由・理由が
   * 無いことは記録しない（実行しないので）。
   */
  private withDeploymentChoice(
    chosen: ChosenSteps,
    deployment: NonNullable<ChosenSteps["deployment"]>,
  ): Partial<ChosenSteps> {
    if (!("skipped" in deployment)) return { deployment };
    const { deployment: _reason, ...reasons } = chosen.defaultImageReasons ?? {};
    const unexplained = (chosen.imagesUnexplained ?? []).filter((step) => step !== "deployment");
    return {
      deployment,
      defaultImageReasons: Object.keys(reasons).length > 0 ? reasons : undefined,
      imagesUnexplained: unexplained.length > 0 ? unexplained : undefined,
    };
  }

  /** マージのコミットの、デプロイの確認のスキル（PBI-89）。コミットを取得できなければ retry。 */
  private async deploymentSkill(
    task: Task,
    commit: string,
    usedSecrets: string[],
  ): Promise<{ path: string } | { problem: DaemonText } | "retry"> {
    const loaded = this.deps.config();
    if (!loaded.ok) return "retry";
    const ready = await this.prepareRepository(task, loaded.config);
    if (!ready.ok) {
      console.warn(
        `[daemon] タスク ${task.id} のリポジトリを用意できず、デプロイの確認のスキルを探せませんでした：${renderMessage(ready.message, "ja")}`,
      );
      return "retry";
    }
    const current = this.mustGet(task.id);
    const gitDir = this.trustedGitDir(current);
    try {
      const authEnv = await this.gitAuth(current, current.repository?.url ?? "", usedSecrets);
      await this.deps.repos.fetchCommits(gitDir, [commit], authEnv);
      return await findDeploymentSkill(this.deps.repos, gitDir, commit);
    } catch (error) {
      console.warn(
        `[daemon] コミット ${commit} のデプロイの確認のスキルを探せませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
      return "retry";
    }
  }

  /**
   * 監視で見つけた失敗の、修正のタスクを登録する（PBI-89）。同じプロジェクトに、同じ目印の終わっていない修正のタスクが
   * あれば作らない（duplicate）。修正のタスクの連鎖が上限（MAX_FIX_CHAIN）を超えるなら作らない（chain_limit）。
   * 作るなら、元のタスクに登録の記録（ID・題・本文）を書いてから、修正のタスクを作る。
   */
  private registerFixTask(task: Task): void {
    const watch = task.deployment;
    if (!watch || !fixDecisionPending(task)) return;
    const kind = watch.check?.result === "unhealthy" ? "deployment" : "ci";
    const fingerprint =
      kind === "ci"
        ? ciFingerprint(watch.repo, watch.ci?.failures ?? [])
        : deploymentFingerprint(watch.repo);
    const depth = (task.fix?.depth ?? 0) + 1;
    const suppress = (reason: "duplicate" | "chain_limit", existing?: string) => {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "DeploymentFixSuppressed",
            payload: { kind, fingerprint, reason, ...(existing ? { existing } : {}) },
          },
        },
      ]);
    };
    const open = [...this.tasks.values()].find(
      (t) =>
        t.projectId === task.projectId &&
        // 監視しているタスク自身（修正のタスクのマージの監視。PBI-116 からは、監視の間は終わっていない）は除く
        t.id !== task.id &&
        // 登録して、まだ作っていないもの（デーモンが止まった）も含める
        ((t.fix?.fingerprint === fingerprint && fixTaskOpen(t)) ||
          (t.deployment?.fix?.fingerprint === fingerprint &&
            !this.tasks.has(t.deployment.fix.taskId))),
    );
    if (open) {
      suppress(
        "duplicate",
        open.fix?.fingerprint === fingerprint ? open.id : open.deployment?.fix?.taskId,
      );
      return;
    }
    if (depth > MAX_FIX_CHAIN) {
      suppress("chain_limit");
      return;
    }
    const { title, body } =
      kind === "ci"
        ? buildCiFixTask(task, watch, watch.ci?.failures ?? [])
        : buildDeploymentFixTask(task, watch);
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "DeploymentFixRegistered",
          payload: { taskId: randomUUID(), kind, fingerprint, depth, title, body },
        },
      },
    ]);
    this.createRegisteredFixTask(this.mustGet(task.id));
  }

  /** 登録した修正のタスクがまだ無ければ作る（PBI-89。登録の後、作る前にデーモンが止まったときも）。 */
  private createRegisteredFixTask(task: Task): void {
    const fix = task.deployment?.fix;
    if (!fix || this.tasks.has(fix.taskId) || !task.deployment) return;
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    this.append({ id: fix.taskId, projectId: task.projectId }, [
      {
        actor: "sacty",
        event: {
          type: "TaskCreated",
          payload: {
            title: fix.title,
            body: fix.body,
            start: "deployment",
            repo: task.deployment.repo,
            budgetCapUsd,
            fix: {
              taskId: task.id,
              kind: fix.kind,
              fingerprint: fix.fingerprint,
              depth: fix.depth,
            },
          },
        },
      },
    ]);
  }

  /**
   * デプロイの確認（PBI-89）。ワーカーが実行する。マージのコミットのコードの使い捨ての写しと、プロジェクトのコンテキスト
   * （外部 PF・MCP サーバー）を渡し、スキルに従ってデプロイの完了とデプロイ後のアプリの状態を確かめさせる。予算の上限に
   * 達していれば実行せずに飛ばす。費用は元のタスクの予算に入れる。エラーになっていたら、修正のタスクを登録する。
   */
  private async checkDeployment(task: Task): Promise<void> {
    const watch = task.deployment;
    const skill = watch?.ci?.skill;
    if (!watch?.commit || !skill || !awaitingDeploymentCheck(task)) return;
    const commit = watch.commit;
    const loaded = this.deps.config();
    // 設定の問題は status() で画面に出す。確認は待ったままにする
    if (!loaded.ok) return;
    const config = loaded.config;
    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "DeploymentWatchSkipped",
            payload: { reason: "budget", detail: message("deploy.budgetExceeded") },
          },
        },
      ]);
      return;
    }
    // 人がタスクの詳細で選んだエージェントを優先する（PBI-121）。選んだ名前が消えていれば、理由を示して止める
    const chosen = stepAgentFor(config, "deployment", this.mustGet(task.id).agents?.deployment);
    if (!chosen.ok) {
      this.pauseForMissingAgent(task, "deployment", chosen.missing);
      return;
    }
    const agent = chosen.agent;
    const runId = randomUUID();
    const setting = { agentId: agent.id, ...agentSetting(agent), runId };
    this.append(task, [
      { actor: "sacty", event: { type: "DeploymentCheckStarted", payload: { runId, skill } } },
    ]);
    type Payload = Extract<EventInput, { type: "DeploymentChecked" }>["payload"];
    const record = (actor: Actor, payload: Payload) => {
      const latest = this.tasks.get(task.id);
      if (!latest || latest.status === "cancelled" || !deploymentCheckRunning(latest)) return;
      this.append(latest, [{ actor, event: { type: "DeploymentChecked", payload } }]);
      // 予算の通知は記録する（完了したタスクなので、止めない）
      const updated = this.warnIfNeeded(this.mustGet(task.id));
      if (updated.deployment?.state === "failed") this.registerFixTask(updated);
    };
    const usedSecrets: string[] = [];
    // 準備・実行の途中で人が止めたなら、失敗ではなく中断として扱う（準備が止めたことで失敗しても、再開で確かめ直す。
    // PBI-116 レビュー指摘）
    const fail = (failed: DaemonText, cost?: Partial<Payload>) =>
      stopped()
        ? interrupted({ costUsd: 0, estimated: false, ...cost })
        : record("sacty", {
            result: "unknown",
            evidence: [],
            failed: message("deploy.checkFailed", { detail: redactText(failed, usedSecrets) }),
            runResult: "failed",
            ...setting,
            costUsd: 0,
            estimated: false,
            ...cost,
          });
    const stopped = () => this.pauseRequested.has(task.id) || this.cancelling.has(task.id);
    // マージの後の監視の工程（PBI-116）なら、人が止めた確認は結果にせず、再開で確かめ直す（ほかの工程の実行と同じ）。
    // 工程の無い PBI-116 より前のタスクの監視は、これまでどおり確かめられなかったものとして終える
    const stepped = task.steps.some((s) => s.key === "deployment");
    const interrupted = (cost: Pick<Payload, "costUsd" | "estimated"> & Partial<Payload>) =>
      record("sacty", {
        result: "unknown",
        evidence: [],
        failed: message("deploy.stopped"),
        runResult: "interrupted",
        ...setting,
        ...cost,
        ...(stepped ? { retry: true as const } : {}),
      });
    const workspaceDir = join(this.deps.workspaceRoot, "_deployment", runId);
    let context: RunContext | undefined;
    let executed: Executed;
    try {
      const ready = await this.prepareRepository(task, config);
      if (!ready.ok) return fail(ready.message);
      const current = this.mustGet(task.id);
      const gitDir = this.trustedGitDir(current);
      try {
        const authEnv = await this.gitAuth(current, current.repository?.url ?? "", usedSecrets);
        await this.deps.repos.fetchCommits(gitDir, [commit], authEnv);
        await this.deps.repos.snapshot(gitDir, commit, workspaceDir);
        context = await this.runContext(current, agent, config, usedSecrets);
      } catch (error) {
        return fail(errorText(error));
      }
      const platforms = mergePlatforms(config.platforms, context?.platforms ?? []);
      // 用意したコンテキスト（層・注意・置いた段階）を、この実行の記録として残す（PBI-119）
      if (context) {
        this.append(this.mustGet(task.id), [this.contextResolved(runId, context, platforms)]);
      }
      // マージの後の監視の工程のイメージ（ほかの工程と同じく、オーケストレーターか人が選ぶ。PBI-116）。工程の無い
      // PBI-116 より前のタスクは、実装の工程のイメージ。無ければ既定のイメージ
      const image = resolveImage(
        config,
        stepped ? current.images?.deployment : current.images?.implement,
      );
      if (stopped()) return interrupted({ costUsd: 0, estimated: false });
      executed = await this.execute({
        agent,
        taskId: task.id,
        image: image.ok ? image.image : config.image,
        ...(image.ok ? { imageEnv: image.env } : {}),
        runId,
        prompt: [
          buildDeploymentPrompt(current, watch, skill),
          ...platformPromptLines(platforms.platforms),
        ].join("\n"),
        platforms: platforms.platforms,
        role: "deployment",
        workspaceDir,
        ...(context ? { context: { dir: context.dir, ...context.placed } } : {}),
        ...(context && context.gatewayMcp.length > 0 ? { contextMcp: context.gatewayMcp } : {}),
        ...(context && context.tiers.length > 0 ? { estimateCost: true } : {}),
      });
    } finally {
      context?.dispose();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = executed;
    const cost = {
      ...setting,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      costUsd,
      estimated,
    };
    if (stopped()) return interrupted(cost);
    if (outcome.kind === "failed") return fail(outcome.message, cost);
    // 秘密情報は、execute が出力の全文から取り除いている（切り詰めるのは、その後）
    const answer = extractDeploymentCheck(outcome.output);
    if (!answer) {
      return record("agent", {
        result: "unknown",
        evidence: [],
        failed: message("deploy.unreadable"),
        runResult: "completed",
        ...cost,
      });
    }
    return record("agent", {
      result: answer.result,
      ci: answer.ci,
      deployment: answer.deployment,
      ...(answer.summary ? { summary: answer.summary } : {}),
      evidence: answer.evidence,
      ...(answer.result === "unknown" ? { failed: message("deploy.undetermined") } : {}),
      runResult: "completed",
      ...cost,
    });
  }

  /**
   * PR へのフィードバック（レビュー・行ごとのコメント・通常のコメント）を指摘として取り込み、
   * ゴールガーディアンに戻し先を判断させて、その工程に差し戻す（PBI-14b・PBI-58）。
   * まだ取り込んでいないものを、最後のフィードバックから一定の時間（書き終わるのを待つ）たってから、
   * まとめて取り込む。途中で止まっても、次の確認で続きから進める（判断・反映）。
   */
  private async importFeedback(task: Task, token: string): Promise<void> {
    // 実装の PR と、要求要件・設計の PR（PBI-57）の指摘
    const pr = gatePullRequest(task);
    if (!pr?.number || !pr.repo) return;
    let current = task;
    if (!current.pendingReview) {
      const fresh = (
        await this.deps.pulls.feedback({
          repo: pr.repo,
          token,
          number: pr.number,
          ...this.githubAccountOf(current, pr.repo),
          ...this.sactyReviewsOf(pr.repo, pr.number),
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
      const judged = await this.judgeRework(current, pr.step, pending.remarks, config.config);
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
   * この PR をレビューした sacty のタスクの回と、そのタスクが投稿に使うアカウント（PBI-88）。レビュー用のラベルを付けて取り込んだ
   * レビューだけのタスク（`source.review: sacty`）の、直すべき指摘のある回（評価を読めなかった回も）は、元のタスクへの PR の
   * 指摘として取り込む（allowed）。ほかの回・ほかのレビューのタスクの投稿は、アカウントが元のタスクと違っても除く。
   */
  private sactyReviewsOf(repo: string, number: number): { sactyReviews?: SactyReviewRound[] } {
    const rounds = [...this.tasks.values()].flatMap((t) => {
      const ref = referencedPullRequest(t);
      if (!ref || ref.number !== number || !sameRepo(ref.repo, repo)) return [];
      const account = this.githubAccountOf(t, repo).account;
      if (!account) return [];
      const verdicts = t.reviewVerdicts ?? [];
      const last = Math.max(t.reviewRound ?? 1, ...verdicts.map((v) => v.round));
      return Array.from({ length: last }, (_, i) => {
        const round = i + 1;
        const verdict = verdicts.find((v) => v.round === round);
        return {
          key: sactyReviewKey(t.id, round),
          account,
          // 修正が必要でない（提案だけ・指摘なし。マージしてよい）回は、差し戻さないので取り込まない。判定を読めなければ、
          // 指摘を落とさないように取り込む（PBI-111）
          allowed:
            t.source?.review === "sacty" &&
            verdict !== undefined &&
            (verdict.verdict === undefined || verdict.verdict === "changes_required"),
        };
      });
    });
    return rounds.length > 0 ? { sactyReviews: rounds } : {};
  }

  /**
   * ゴールガーディアンの判断に従って、取り込んだ PR の指摘を、判断した工程に差し戻す（人間の確認は待たない。
   * 設計・要求要件に戻したら、作り直した成果をいつもどおり人間が承認する）。判断できなければ実装をやり直す
   * （判断できなかったことと理由は ReworkJudged に残る）。上限を超えるならエスカレーションになる（PBI-58）。
   */
  private settleReview(task: Task): void {
    const pending = task.pendingReview;
    const judgement = pending?.judgement;
    const gate = task.gate;
    if (!pending || !judgement || !gate || !gatePullRequest(task)) return;
    if (task.status !== "awaiting_approval") return;
    // 判断できなければ、その工程をやり直す（実装なら実装。要求要件・設計なら同じ PR を更新する。PBI-57・PBI-110）
    const targets = reworkTargets(task, gate.step);
    const target =
      judgement.target && targets.includes(judgement.target)
        ? judgement.target
        : (targets[0] ?? gate.step);
    this.requestChanges(task.id, {
      step: gate.step,
      submission: gate.submission,
      target,
      comments: pending.remarks,
    });
  }

  /**
   * ゴールガーディアンを、対象リポジトリのコードの使い捨ての写しを渡して実行する（PBI-16）。
   * base は起点のコミットのコード、implemented は実装後のコード（実装の作業領域。.git を除く）。
   * コードは実行ごとのディレクトリに書き出し、終わったら消す。書き出せなければ、実行の失敗として返す。
   */
  private async runGuardian(
    task: Task,
    run: {
      agent: AgentConfig;
      image: string;
      prompt: string;
      role: AgentRole;
      /** 使わせる組織内 PF の API（チケットを読む1段目。PBI-52）。 */
      platforms?: readonly Platform[];
      /** 実行の ID（止めるために、呼ぶ側で決めるとき。PBI-54）。 */
      runId?: string;
      /** true を返すと、コンテナを起動しない（準備の間に中止されたなど。PBI-54）。 */
      stopped?: () => boolean;
      /** 実行の ID が変わったら知らせる（セッションを新しく始め直したとき。止めるため。PBI-67）。 */
      onRunId?: (runId: string) => void;
      /** 追加でマウントする、sacty が管理するディレクトリ（質問への答えの各実行のセッションログ。PBI-91）。 */
      mounts?: ExecuteRun["mounts"];
      readDirs?: ExecuteRun["readDirs"];
    },
    code: "base" | "implemented",
  ): Promise<Awaited<ReturnType<TaskService["execute"]>>> {
    const runId = run.runId ?? randomUUID();
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
            runId,
          };
        }
      }
      // 再開できなかったセッションを新しく始め直したら、その実行の ID になる（PBI-67）
      return await this.execute({ ...run, taskId: task.id, runId, workspaceDir });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  /**
   * 完了した調査の結果を、取り込み元の GitHub Issue にコメントとして返す（PBI-18）。
   * プロジェクトの gh のアカウントで返す。返せなければ理由を記録する（何度も返そうとしない）。
   */
  private async commentInvestigation(task: Task): Promise<void> {
    // チケットから取り込んだタスクは、チケットにコメントする（PBI-52）
    if (task.ticket && !task.source) return this.commentTicketInvestigation(task);
    const source = task.source;
    // PR から取り込んだタスクも、PR の会話にコメントする（PR も Issue のコメントの API で返せる。PBI-26）
    if (!source) return;
    const usedSecrets: string[] = [];
    let event: EventInput;
    try {
      const token = await this.githubToken(task, source.repo, usedSecrets);
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
      const token = await this.githubToken(task, ref.repo, usedSecrets);
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
          author: pr.author,
        },
      };
    } catch (error) {
      return { ok: false, message: redactText(errorText(error), usedSecrets) };
    }
  }

  /**
   * 再レビュー（PBI-44）で、前回のレビューの投稿の後の、PR の作者の返答（PBI-111）。PR のレビュー・行へのコメント・通常のコメントの
   * うち、作者が前回の投稿の後に書いたもの（sacty のレビューの目印で始まるものは除く）。作者が分からなければ、返答を選べないので
   * 読めなかったものとする（例外にする）。
   */
  private async reviewReplies(
    task: Task,
    target: NonNullable<Task["reviewTarget"]>,
    usedSecrets: string[],
  ): Promise<PullRequestFeedback[]> {
    const previous = task.previousReview;
    const author = target.author.toLowerCase();
    if (!previous) return [];
    if (!author) throw new Error("the pull request author is unknown");
    const token = await this.githubToken(task, target.repo, usedSecrets);
    const account = this.githubAccountOf(task, target.repo).account;
    const items = await this.deps.pulls.feedback({
      repo: target.repo,
      token,
      number: target.number,
      ...(account ? { account } : {}),
    });
    const since = Date.parse(previous.at);
    return items.filter(
      (item) =>
        item.author.toLowerCase() === author &&
        Date.parse(item.at) > since &&
        sactyReviewTask(item.body) === undefined,
    );
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
      const token = await this.githubToken(task, target.repo, usedSecrets);
      const account = this.githubAccountOf(task, target.repo).account ?? "";
      const pr = { repo: target.repo, token, number: target.number };
      // 前回、投稿の後・記録の前に止まっていたら、そのレビューを使う（同じレビューを二度投稿しない）
      const existing = await this.deps.pulls.findReview({
        ...pr,
        account,
        marker: reviewMarker(task),
      });
      // 投稿の直前に、PR の先頭がレビューしたコミットのままかを確かめる（PBI-111）。途中で push されていても、レビューは
      // レビューしたコミットに対して投稿し、その旨を本文に書く（最新のコミットは「再レビュー」でレビューする）
      // 先頭を読めない応答なら、確かめられないので投稿しない（一時停止し、再開すると確かめ直す）。すでに投稿したレビューが
      // あれば、その本文に残した先頭を記録し直す（投稿の後・記録の前に止まったとき）
      let latestCommit: string | undefined;
      if (existing) {
        latestCommit = postedLatestCommit(existing.body);
      } else {
        const head = (await this.deps.pulls.status(pr)).headSha?.trim() ?? "";
        if (!/^[0-9A-Za-z]{7,64}$/.test(head))
          throw new MessageError(message("review.headUnknown"));
        latestCommit = head !== target.headCommit ? head : undefined;
      }
      const post = (foldComments: boolean) =>
        this.deps.pulls.postReview({
          ...pr,
          commit: target.headCommit,
          body: buildReviewBody(task, { foldComments, ...(latestCommit ? { latestCommit } : {}) }),
          comments: foldComments ? [] : buildReviewComments(task),
        });
      const { url } =
        existing ??
        (await post(false).catch((error: unknown) => {
          // 行へのコメントを受け付けられなかった（行が差分に無いなど）なら、本文に入れて投稿し直す
          if (task.reviewComments.length > 0 && githubStatus(error) === 422) return post(true);
          throw error;
        }));
      event = {
        type: "PullRequestReviewPosted",
        payload: { url, ...(latestCommit ? { latestCommit } : {}) },
      };
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
   * 読ませ、候補（STEP_PLANS）から選ばせる。人間の承認は無い。判断できない（出力を読めない）・実行に失敗したときは、
   * 標準の工程で代わりに進めず failure を返し、呼び出し側が OrchestratorFailed を記録して一時停止する（PBI-32・PBI-40。
   * 再開すると工程の選択からやり直す）。リポジトリの無いタスクでコードを変える組み合わせなら、工程を決めずに
   * 選んだリポジトリ（repository。選べなければ failure）を返す（PBI-73）。テストでは deps.planner に差し替える。
   */
  private async chooseSteps(
    task: Task,
    config: SactyConfig,
  ): Promise<
    | ChosenSteps
    | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] }
    | { repository: Extract<EventInput, { type: "RepositoryChosen" }>["payload"] }
  > {
    // プロジェクトの対象でイメージを指定していれば、オーケストレーターに選ばせない（PBI-41）
    const pinned = this.pinnedImage(task);
    const candidates = pinned
      ? []
      : Object.values(config.images ?? {}).map(({ name, description }) => ({ name, description }));
    // 成果の書き出し先に使える接続先と、プロジェクトのコンテキストの規約（PBI-56）
    const exports = await this.exportDestinations(task, config);
    // プロジェクトの共用の compose（PBI-70）。要るかはオーケストレーターが決める（ここでは取得しない）
    const shared = task.repository
      ? (this.deps.projects.get(task.projectId)?.sharedComposes ?? [])
      : [];
    // 対象リポジトリの無いタスク（PBI-73）は、プロジェクトの対象（作業するリポジトリの候補）とコンテキストを渡して選ばせる
    const contextSource = this.deps.projects.get(task.projectId)?.context;
    const repoless = isRepoless(task)
      ? {
          repositories: (await this.projectRepositories(task.projectId))?.repositories ?? [],
          ...(contextSource
            ? {
                context: `${contextSource.repo}${contextSource.ref ? `（${contextSource.ref}）` : ""}`,
              }
            : {}),
          rules: exports.rules,
        }
      : undefined;
    const planned = this.deps.planner
      ? await this.deps.planner(task)
      : await this.askOrchestrator(task, config, candidates, exports, shared, repoless);
    if ("failure" in planned) return planned;
    const { repo: chosenRepo, repoReason, ...rest } = planned;
    let choice: PlannedSteps = rest;
    if (repoless) {
      // コードの変更が要る（分けない）なら、作業するリポジトリを対象から選ぶ。選べなければ、理由を示して止める
      // （人がリポジトリを選んで再開できる）
      if (choice.steps.some((step) => REPO_STEPS.includes(step))) {
        return this.repositoryFromPlan(choice, chosenRepo, repoReason, repoless.repositories);
      }
      // リポジトリの無いまま進めるので、リポジトリのコードに関わる決めごとは使わない
      const {
        testCommand: _testCommand,
        noTestsReason: _noTestsReason,
        baseBranch: _baseBranch,
        services: _services,
        servicesReason: _servicesReason,
        documentsDir: _documentsDir,
        ...noCode
      } = choice;
      choice = noCode;
    }
    const { operation: rawOperation, ...withoutOperation } = choice;
    const operation = OperationSettings.safeParse(rawOperation);
    choice = {
      ...withoutOperation,
      ...(choice.steps.includes("operation") && operation.success
        ? { operation: operation.data }
        : {}),
    };
    const withShared = this.withSharedCompose(choice, shared);
    if ("failure" in withShared) return withShared;
    return this.withImages(
      this.withExports(withShared, exports.destinations),
      config,
      pinned,
      // images の候補を見せたら、既定のイメージで動かす工程の理由を確かめる（PBI-105）
      candidates.length > 0 && !repoless,
    );
  }

  /**
   * 対象リポジトリの無いタスクで、コードの変更が要る組み合わせを選んだときの、作業するリポジトリ（PBI-73）。プロジェクトの
   * 対象にあるものだけを使う（登録した名前にそろえる）。書いていない・対象に無いなら、理由を示して止める（人が選べる）。
   */
  private repositoryFromPlan(
    choice: PlannedSteps,
    repo: string | undefined,
    reason: string | undefined,
    candidates: readonly string[],
  ):
    | { repository: Extract<EventInput, { type: "RepositoryChosen" }>["payload"] }
    | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] } {
    const cost = {
      ...(choice.agentId ? { agentId: choice.agentId } : {}),
      ...(choice.authMode ? { authMode: choice.authMode } : {}),
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
      ...(choice.runId ? { runId: choice.runId } : {}),
      ...(choice.usage ? { usage: choice.usage } : {}),
      costUsd: choice.costUsd,
      estimated: choice.estimated,
    };
    const found = repo ? candidates.find((c) => sameGitHubUrl(c, repo)) : undefined;
    if (found) {
      return { repository: { repo: found, reason: reason || choice.reason || "", ...cost } };
    }
    const detail = repo
      ? message("repo.notCandidate", { repo })
      : reason
        ? reason
        : message("repo.notChosen");
    return {
      failure: {
        reason: "error",
        message: message("repo.chooseFailed", { detail }),
        agentId: choice.agentId ?? "unknown",
        ...cost,
      },
    };
  }

  /**
   * リポジトリを指定せずに作ったタスクの、作業するリポジトリを人が選ぶ（PBI-73。オーケストレーターが選べなかったとき）。
   * まだ工程を決めていないタスクだけ。選んだ後に再開すると、そのリポジトリを用意して工程を選ぶ。チケットから取り込んだ
   * タスクは、チケットのリポジトリの選び方（PBI-52）にする。
   */
  async chooseRepository(id: string, repo: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.ticket) return this.chooseTicketRepository(id, repo);
    // 止まっているタスクだけ（オーケストレーターが選んでいる間に選ぶと、どちらを使うかがぶれるため）
    if (!awaitingRepository(task) || task.status !== "paused") {
      throw new InvalidOperationError(message("repo.notChoosable"));
    }
    const candidates = (await this.projectRepositories(task.projectId))?.repositories ?? [];
    const chosen = candidates.find((c) => sameGitHubUrl(c, repo));
    if (!chosen) throw new InvalidOperationError(message("repo.notCandidate", { repo }));
    const latest = this.mustGet(id);
    if (!awaitingRepository(latest) || latest.status !== "paused") {
      throw new InvalidOperationError(message("repo.notChoosable"));
    }
    return this.append(latest, [
      {
        actor: "person",
        event: {
          type: "RepositoryChosen",
          payload: { repo: chosen, reason: message("repo.chosenByPerson") },
        },
      },
    ]);
  }

  /**
   * オーケストレーターが選んだサービスを、記録する形にする（PBI-70）。共用の compose を名前で選んだなら、プロジェクトの
   * 設定と照らし、compose ファイル・リポジトリ・ref を記録する（どれを使ったかを残す）。設定に無い名前なら、理由を示して
   * 止める（再開すると選び直す）。選ばせた共用の compose の名前も残す（使わなかったことがわかるように）。
   */
  private withSharedCompose(
    choice: PlannedSteps,
    shared: readonly SharedCompose[],
  ):
    | (Omit<ChosenSteps, "exports"> & { exports?: PlannedSteps["exports"] })
    | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] } {
    const { services: raw, ...rest } = choice;
    const offered = shared.length > 0 ? { sharedComposes: shared.map((s) => s.name) } : {};
    if (!raw) return { ...rest, ...offered };
    if (raw.compose === undefined) {
      return {
        ...rest,
        ...offered,
        services: { file: raw.file, names: raw.names, steps: raw.steps },
      };
    }
    const found = shared.find((s) => s.name === raw.compose);
    if (!found) {
      return {
        failure: {
          reason: "error",
          message: message("orchestrator.failed", {
            detail: message("services.sharedUnknown", { name: raw.compose }),
          }),
          agentId: choice.agentId ?? "unknown",
          ...(choice.authMode ? { authMode: choice.authMode } : {}),
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
          ...(choice.runId ? { runId: choice.runId } : {}),
          ...(choice.usage ? { usage: choice.usage } : {}),
          costUsd: choice.costUsd,
          estimated: choice.estimated,
        },
      };
    }
    return {
      ...rest,
      ...offered,
      services: {
        file: found.file,
        names: raw.names,
        steps: raw.steps,
        compose: { name: found.name, repo: found.repo, ...(found.ref ? { ref: found.ref } : {}) },
      },
    };
  }

  /**
   * プロジェクトのコンテキストで合成した外部 PF と、合成の警告（PBI-74）。プロジェクトのコンテキストも既定のコンテキストも
   * 無ければ空。取得できなければ例外にする（呼ぶ側で、usedSecrets を取り除いてから理由を出す）。
   */
  private async contextPlatformsOf(
    projectId: string,
    usedSecrets: string[],
  ): Promise<{ platforms: Platform[]; warnings: DaemonText[] }> {
    const root = this.deps.projects.get(projectId)?.context;
    if (!root && !this.deps.defaultContext) return { platforms: [], warnings: [] };
    return contextPlatforms(
      this.deps.contexts,
      root,
      (repo) => this.gitAuth({ projectId }, repo, usedSecrets),
      this.deps.defaultContext,
    );
  }

  /**
   * 名前の外部 PF（PBI-74）。ホストの PF（config.yaml）を先に引き、無ければプロジェクトのコンテキストを取得して引く
   * （ホストの PF で足りるなら、コンテキストは取得しない）。どちらにも無ければ undefined。
   */
  private async findPlatform(
    task: Pick<Task, "projectId">,
    config: SactyConfig,
    name: string,
    usedSecrets: string[],
  ): Promise<Platform | undefined> {
    const host = config.platforms.find((p) => p.name === name);
    if (host) return host;
    const own = await this.contextPlatformsOf(task.projectId, usedSecrets);
    return mergePlatforms(config.platforms, own.platforms).platforms.find((p) => p.name === name);
  }

  /**
   * チケットの取り込み（PBI-52）の接続先にする、プロジェクトのコンテキストで合成した PF（PBI-74。ホストと同じ名前の
   * ものは除く）。取得できなければ、秘密情報を伏せた理由を返す。
   */
  async projectContextPlatforms(
    projectId: string,
  ): Promise<{ platforms: Platform[] } | { error: DaemonText }> {
    const config = this.deps.config();
    const host = config.ok ? config.config.platforms : [];
    const usedSecrets: string[] = [];
    try {
      const own = await this.contextPlatformsOf(projectId, usedSecrets);
      return {
        platforms: mergePlatforms(host, own.platforms).platforms.filter((p) => p.from),
      };
    } catch (error) {
      return { error: redactText(errorText(error), usedSecrets) };
    }
  }

  /**
   * プロジェクトで使える外部 PF（PBI-74。プロジェクトの設定の画面に出す）。ホストの PF と、プロジェクトのコンテキストで
   * 合成した PF（from にどの層のものか）。名前・説明・allow だけを返し、秘密情報の名前・値は返さない。コンテキストを
   * 読めなければ、ホストの PF と、秘密情報を伏せた理由を返す。
   */
  async projectPlatforms(id: string): Promise<
    | {
        platforms: PlatformSummary[];
        warnings: DaemonText[];
        error?: DaemonText;
      }
    | undefined
  > {
    if (!this.deps.projects.get(id)) return undefined;
    const config = this.deps.config();
    const host = config.ok ? config.config.platforms : [];
    const usedSecrets: string[] = [];
    try {
      const own = await this.contextPlatformsOf(id, usedSecrets);
      const merged = mergePlatforms(host, own.platforms);
      return {
        platforms: merged.platforms.map(platformSummary),
        warnings: [...own.warnings, ...merged.warnings],
      };
    } catch (error) {
      return {
        platforms: host.map(platformSummary),
        warnings: [],
        error: redactText(errorText(error), usedSecrets),
      };
    }
  }

  /**
   * プロジェクトのコンテキストの合成の結果のプレビュー（PBI-76）。実行のときと同じ処理で、AI の種類（runtime）ごとに
   * 置くファイル・合成の情報・警告を作る（ファイルは書かず、取得したリポジトリは消す。作業履歴にも残さない）。
   * definition を渡せば、保存していない設定（コンテキストリポジトリ・GitHub アカウント）で作る。プロジェクトが無ければ
   * undefined。取得・設定の誤りは、秘密情報を伏せた理由（error）で返す。
   */
  async projectContextPreview(
    id: string,
    runtime: "claude-code" | "codex",
    definition?: ProjectDefinition,
  ): Promise<{ preview: ContextPreviewView } | { error: DaemonText } | undefined> {
    const saved = this.deps.projects.get(id);
    if (!saved) return undefined;
    const project = definition ?? saved;
    const loaded = this.deps.config();
    const config = loaded.ok ? loaded.config : undefined;
    const usedSecrets: string[] = [];
    try {
      // 段階のサブエージェントの定義（PBI-119）。親は、その runtime の既定のエージェント（無ければ工程の・ゴールガーディアンの
      // エージェントのうち、その runtime のもの）。無ければ置かない
      const parent = config ? this.previewParent(config, runtime) : undefined;
      const tiers =
        parent && config ? this.tiersFor(parent, config) : { entries: [], warnings: [] };
      const preview = await previewContext(
        this.deps.contexts,
        project.context,
        runtime,
        contextContainerDir(runtime),
        (repo) => this.gitAuth({ projectId: id }, repo, usedSecrets, definition),
        this.deps.defaultContext,
        this.mcpRouting(config),
        tierFiles(runtime, tiers.entries),
      );
      // 使える外部 PF：ホストの PF と、合成した PF（同じ名前ならホストのもの。実行と同じ。PBI-74）
      const merged = mergePlatforms(config?.platforms ?? [], preview.platforms);
      return {
        preview: {
          ...preview,
          platforms: merged.platforms.map(platformSummary),
          warnings: [...preview.warnings, ...tiers.warnings, ...merged.warnings],
        },
      };
    } catch (error) {
      return { error: redactText(errorText(error), usedSecrets) };
    }
  }

  /**
   * 用意したコンテキストの記録（層・注意・外部 PF の要約・置いた段階。PBI-74・PBI-119）。工程・マージの後の監視・外部作業・
   * 書き出しの、コンテキストを渡す実行のたびに残す。
   */
  private contextResolved(
    runId: string,
    context: RunContext,
    platforms: { platforms: readonly Platform[]; warnings: readonly DaemonText[] },
  ): ActivityItem {
    return {
      actor: "sacty",
      event: {
        type: "ContextResolved",
        payload: {
          runId,
          layers: context.layers,
          warnings: [...context.warnings, ...platforms.warnings],
          ...(platforms.platforms.length > 0
            ? { platforms: platforms.platforms.map(platformSummary) }
            : {}),
          ...(context.tiers.length > 0 ? { tiers: context.tiers } : {}),
        },
      },
    };
  }

  /**
   * 親（工程のエージェント）に置く段階のサブエージェントの定義と、置かなかった段階の注意（PBI-119）。stub の親には置かない。
   */
  private tiersFor(
    agent: AgentConfig,
    config: SactyConfig,
  ): { entries: PlacedTier[]; warnings: DaemonText[] } {
    if (agent.runtime === "stub") return { entries: [], warnings: [] };
    return selectTiers(agent, tierAgentsFor(config, agent.runtime));
  }

  /**
   * プレビューで段階の親にするエージェント（PBI-119）。その runtime の既定のエージェント、無ければ工程・ゴールガーディアンの
   * エージェントのうち最初のもの。その runtime のエージェントが無ければ undefined。
   */
  private previewParent(config: SactyConfig, runtime: TierRuntime): AgentConfig | undefined {
    return [
      config.defaultAgent,
      ...Object.values(config.stepAgents ?? {}),
      config.guardianAgent,
    ].find((a) => a?.runtime === runtime);
  }

  /**
   * 保存したプロジェクトのコンテキストを、プレビューと同じ検査で確かめる（PBI-76）。誤り（取得の失敗・設定の形の誤り）が
   * あれば、その理由を返す。コンテキストリポジトリを設定していなければ確かめない（既定のコンテキストは同梱のもの）。
   */
  async checkProjectContext(id: string): Promise<DaemonText | undefined> {
    if (!this.deps.projects.get(id)?.context) return undefined;
    const result = await this.projectContextPreview(id, "claude-code");
    return result && "error" in result ? result.error : undefined;
  }

  /**
   * 成果の書き出し先に使える接続先（PBI-56）。ゲートウェイの接続先（gateway.platforms）と、MCP サーバー（ホストの MCP・
   * プロジェクトのコンテキストの MCP）。あわせて、プロジェクトのコンテキストの規約（どこに何を書くか）を読む。
   * コンテキストを読めなければ、コンテキストの MCP サーバーは候補にしない（工程の実行で、いつもどおり理由を出す）。
   */
  private async exportDestinations(
    task: Task,
    config: SactyConfig,
  ): Promise<{ destinations: ExportDestination[]; rules: string }> {
    const hostPlatforms = config.platforms.map(
      (p): ExportDestination => ({ via: "platform", name: p.name, description: p.description }),
    );
    // ホストの MCP サーバーは、ゲートウェイがあるときだけ渡せる（PBI-36）
    const host = this.deps.gateway
      ? config.hostMcp.map(
          (m): ExportDestination => ({ via: "mcp", name: m.name, description: m.description }),
        )
      : [];
    const root = this.deps.projects.get(task.projectId)?.context;
    let info = { mcp: [] as string[], rules: "", platforms: [] as Platform[] };
    if (root || this.deps.defaultContext) {
      try {
        info = await contextExportInfo(
          this.deps.contexts,
          root,
          (repo) => this.gitAuth(task, repo, []),
          this.deps.defaultContext,
        );
      } catch {
        // 読めなければ、コンテキストの MCP サーバーと規約は渡さない
      }
    }
    const hostNames = new Set(host.map((h) => h.name));
    const contextMcp = info.mcp
      .filter((name) => !hostNames.has(name))
      .map((name): ExportDestination => ({ via: "mcp", name, description: "" }));
    // プロジェクトのコンテキストで定義した PF も、書き出し先にできる（同じ名前ならホストのもの。PBI-74）
    const contextPlatforms = mergePlatforms(config.platforms, info.platforms)
      .platforms.filter((p) => p.from !== undefined)
      .map(
        (p): ExportDestination => ({ via: "platform", name: p.name, description: p.description }),
      );
    return {
      destinations: [...hostPlatforms, ...contextPlatforms, ...host, ...contextMcp],
      rules: info.rules,
    };
  }

  /**
   * オーケストレーターが決めた書き出し先を、使える接続先と照らして記録する形にする（PBI-56）。書き出せる工程ごとに、
   * 書き出し先（無ければ書き出さない）と理由を必ず持たせる。使える接続先が無い・書き出せる工程が無いなら、持たない。
   */
  private withExports(
    choice: Omit<ChosenSteps, "exports"> & { exports?: PlannedSteps["exports"] },
    destinations: readonly ExportDestination[],
  ): ChosenSteps {
    const { exports: raw, ...rest } = choice;
    const steps = exportSteps(choice.steps);
    if (destinations.length === 0 || steps.length === 0) return rest;
    const planOf = (plan: RawExportPlan | undefined): ExportPlan => {
      if (!plan) return { reason: message("export.notDecided") };
      if (!plan.to) return { reason: plan.reason || message("export.notDecided") };
      const { name, via } = plan.to;
      const found = destinations.find((d) => d.name === name && (!via || d.via === via));
      if (!found) return { reason: message("export.destinationUnknown", { name }) };
      return {
        to: { via: found.via, name: found.name, location: plan.to.location ?? "" },
        reason: plan.reason,
      };
    };
    return {
      ...rest,
      exports: Object.fromEntries(steps.map((step) => [step, planOf(raw?.[step])])),
    };
  }

  /**
   * 工程で使う docker compose のサービス（PBI-47）。オーケストレーターが決めた工程だけ。内容の調査では起動しない。
   */
  private serviceSpec(
    task: Task,
    step: StepKey,
  ): (ServicesSpec & { compose?: { name: string; repo: string; ref?: string } }) | undefined {
    const services = task.services;
    if (!this.deps.services || !services?.steps.includes(step)) return undefined;
    if (step === "investigate" && task.investigation !== "bug") return undefined;
    return {
      file: services.file,
      names: services.names,
      ...(services.compose ? { shared: services.compose.name, compose: services.compose } : {}),
    };
  }

  /** 共用の compose の取得（PBI-70）。無ければ、作業領域の根の下にキャッシュを置いて git で取得する。 */
  private get sharedComposeFetcher(): SharedComposeFetcher {
    this.defaultSharedComposes ??= new GitSharedComposeFetcher(
      join(this.deps.workspaceRoot, "_cache", "shared-compose"),
    );
    return this.deps.sharedComposes ?? this.defaultSharedComposes;
  }

  /** 工程・テストの実行の前に、サービスを起動する（PBI-47）。使わない工程なら undefined。 */
  private async startServices(
    task: Task,
    step: StepKey,
    runId: string,
    workspaceDir: string,
    forTests = false,
    /**
     * エージェントのイメージの名前（PBI-130）。あれば、サービスを起動する前に ID に確定させて返す（サービスのビルドが
     * タグを書き換えても、確定したイメージで動かす）。確かめられなければ返さない（名前のまま実行する）。
     */
    agentImage?: string,
  ): Promise<
    | { ok: true; started: StartedServices; image?: string }
    | { ok: false; message: DaemonText }
    | undefined
  > {
    const found = this.serviceSpec(task, step);
    const services = this.deps.services;
    if (!found || !services) return undefined;
    // 人間が止めた（一時停止・中止）なら、起動しない
    const stopped = { ok: false as const, message: message("run.stoppedByPerson") };
    if (this.stopRequested(task.id)) return stopped;
    // 起動の待ち（up --wait）の間に止められたら、起動を打ち切れるように、実行として覚える
    this.track(runId);
    const { compose, ...spec } = found;
    // 共用の compose（PBI-70）は、実行ごとのディレクトリに取得して、そこを作業領域として起動する（マウントできるのは、
    // 取得したリポジトリの中だけ）。HTTPS の GitHub は、コンテキストリポジトリと同じくプロジェクトの gh のアカウントで取得する
    const usedSecrets: string[] = [];
    let commit: string | undefined;
    let dir = workspaceDir;
    if (compose) {
      dir = sharedComposeRunDir(this.deps.workspaceRoot, runId);
      try {
        const authEnv = await this.gitAuth(task, compose.repo, usedSecrets);
        ({ commit } = await this.sharedComposeFetcher.checkout({
          repo: compose.repo,
          ...(compose.ref ? { ref: compose.ref } : {}),
          dest: dir,
          ...(authEnv ? { authEnv } : {}),
        }));
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        if (this.stopRequested(task.id)) return stopped;
        // 認証の値を伏せてから、切り詰める
        const detail = redactText(errorText(error), usedSecrets);
        return {
          ok: false,
          message: message("services.sharedFetchFailed", {
            name: compose.name,
            repo: compose.repo,
            detail: clipText(detail, SHARED_FETCH_DETAIL_MAX),
          }),
        };
      }
    }
    // エージェントのイメージを、起動する前に確定させる（PBI-130）
    const image = agentImage ? await services.imageId?.(agentImage, runId) : undefined;
    // 取得（認証の用意・取得）・イメージの確定を待つ間に止められたら、取得したものを片付けて起動しない
    if (this.stopRequested(task.id)) {
      if (compose) rmSync(dir, { recursive: true, force: true });
      return stopped;
    }
    const result = await services.start({
      runId,
      workspaceDir: dir,
      spec,
      ...(usedSecrets.length > 0 ? { secrets: usedSecrets } : {}),
    });
    // 起動を待つ間に止められたら、起動したものを止めて消し、使わない（打ち切って失敗したときも、止めたことにする）
    if (this.stopRequested(task.id)) {
      if (result.ok) await services.stop(runId).catch(() => undefined);
      if (compose) rmSync(dir, { recursive: true, force: true });
      return stopped;
    }
    if (!result.ok && compose) rmSync(dir, { recursive: true, force: true });
    if (result.ok) {
      // 複数のサービスが使うポートは、localhost に転送しない（PBI-60）
      const { shared } = localForwards(result.started.services);
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "ServicesStarted",
            payload: {
              runId,
              step,
              file: spec.file,
              services: result.started.services,
              ...(compose && commit ? { compose: { name: compose.name, commit } } : {}),
              ...(forTests ? { forTests } : {}),
              ...(shared.length > 0 ? { sharedPorts: shared } : {}),
            },
          },
        },
      ]);
    }
    return result.ok && image ? { ...result, image } : result;
  }

  /**
   * テストを実行する。確かめる工程でサービスを使うなら、テストの前に起動し、終わったら消す（PBI-47）。
   * サービスを起動できなければ、テストを実行せずに理由を返す。
   */
  private async runTests(
    task: Task,
    step: StepKey,
    input: Parameters<TestRunner["run"]>[0],
  ): Promise<{ ok: true; result: TestRunResult } | { ok: false; message: DaemonText }> {
    const services = await this.startServices(task, step, input.runId, input.workspaceDir, true);
    if (services && !services.ok) return services;
    try {
      const result = await this.deps.tests.run({
        ...input,
        ...(services?.ok ? serviceConnection(services.started) : {}),
      });
      return { ok: true, result };
    } finally {
      await this.stopServices(task, step, input.runId);
    }
  }

  /** サービスを止めて消す（PBI-47）。使わない工程なら何もしない。止められなくても、工程の結果は変えない。 */
  private async stopServices(task: Task, step: StepKey, runId: string): Promise<void> {
    const spec = this.serviceSpec(this.tasks.get(task.id) ?? task, step);
    if (!spec || !this.deps.services) return;
    await this.deps.services.stop(runId).catch(() => undefined);
    // 共用の compose を取得したディレクトリも消す（PBI-70）
    if (spec.compose) {
      rmSync(sharedComposeRunDir(this.deps.workspaceRoot, runId), { recursive: true, force: true });
    }
  }

  /** プロジェクトの対象で指定したイメージの名前（PBI-41）。 */
  private pinnedImage(task: Task): string | undefined {
    const repo = task.source
      ? task.source.repo
      : (task.repo ?? (task.repository && githubRepoOf(task.repository.url)));
    const project = this.deps.projects.get(task.projectId);
    return repo && project ? targetImageOf(project, repo) : undefined;
  }

  /**
   * 工程ごとのイメージを決める（PBI-41）。対象の指定があれば、すべての工程でそれを使う。無ければオーケストレーターの
   * 選択（選んだ工程の分だけ）。images に無い名前なら、理由を示して止める（再開すると選び直す）。
   * offered（images の候補をオーケストレーターに見せた）なら、既定のイメージで動かす工程ごとに、
   * images のどれも合わない理由を記録し、理由が無い工程（書かなかった・default と書いて理由が無い）も記録する（PBI-105。
   * 既定のイメージに黙って倒さない）。
   */
  private withImages(
    choice: ChosenSteps,
    config: SactyConfig,
    pinned: string | undefined,
    offered = false,
  ): ChosenSteps | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] } {
    const {
      images: picked,
      imageReason,
      defaultImageReasons: reasons,
      imagesUnexplained: _unexplained,
      ...rest
    } = choice;
    const images = pinned
      ? Object.fromEntries(choice.steps.map((step) => [step, pinned]))
      : Object.fromEntries(
          Object.entries(picked ?? {}).filter(([step]) => choice.steps.includes(step as StepKey)),
        );
    const unknown = Object.values(images).find((name) => !resolveImage(config, name).ok);
    if (unknown) {
      return {
        failure: {
          reason: "error",
          message: pinned
            ? message("image.unknown", { name: unknown })
            : message("orchestrator.failed", {
                detail: message("image.unknown", { name: unknown }),
              }),
          agentId: choice.agentId ?? "unknown",
          ...(choice.authMode ? { authMode: choice.authMode } : {}),
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
          ...(choice.usage ? { usage: choice.usage } : {}),
          costUsd: choice.costUsd,
          estimated: choice.estimated,
        },
      };
    }
    const defaults = offered && !pinned ? defaultImagesOf(choice.steps, images, reasons) : {};
    if (Object.keys(images).length === 0) return { ...rest, ...defaults };
    return {
      ...rest,
      images,
      imageSource: pinned ? "project" : "orchestrator",
      ...(!pinned && imageReason ? { imageReason } : {}),
      ...defaults,
    };
  }

  /** オーケストレーターに工程を選ばせる（PBI-17）。 */
  private async askOrchestrator(
    task: Task,
    config: SactyConfig,
    images: { name: string; description: string }[],
    exports: { destinations: ExportDestination[]; rules: string },
    sharedComposes: readonly SharedCompose[] = [],
    /** 対象リポジトリの無いタスク（PBI-73）の、作業するリポジトリの候補・コンテキスト。 */
    repoless?: { repositories: readonly string[]; context?: string; rules?: string },
  ): Promise<
    PlannedSteps | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] }
  > {
    // オーケストレーターに使う AI（step_agents.orchestrator か default_agent。PBI-40）。既定のイメージで動く
    const agent = agentFor(config, "orchestrator");
    const { outcome, costUsd, estimated, runId } = await this.runGuardian(
      task,
      {
        agent,
        image: config.image,
        prompt: buildOrchestratorPrompt(task, {
          images,
          ...(exports.destinations.length > 0 ? { exports } : {}),
          // 要求要件・設計を PR でレビューするなら、成果のファイルの置き場所を決めさせる（PBI-57）
          ...(task.repository && this.deps.stepPullRequests !== false
            ? { documents: { rules: exports.rules } }
            : {}),
          // 共用の compose（PBI-70）。要るかをタスクごとに判断させる
          ...(sharedComposes.length > 0
            ? {
                sharedComposes: sharedComposes.map((s) => ({
                  name: s.name,
                  file: s.file,
                  ...(s.description ? { description: s.description } : {}),
                })),
              }
            : {}),
          ...(repoless ? { repoless } : {}),
        }),
        role: "orchestrator",
      },
      "base",
    );
    // 実行に失敗した・選んだ工程を読み取れなかったときは、理由を記録して止める（PBI-32・PBI-40）。
    // 標準の工程で代わりに進めると、テストのコマンドも決まらず、調査のタスクでも設計・実装に進んでしまうため。
    // 再開すると、工程の選択からやり直す。使った分の費用は記録する
    const cost = {
      agentId: agent.id,
      ...agentSetting(agent),
      runId,
      usage: outcome.usage,
      costUsd,
      estimated,
    };
    if (outcome.kind === "failed") {
      return {
        failure: {
          reason: outcome.reason,
          message: message("orchestrator.failed", { detail: outcome.message }),
          ...cost,
        },
      };
    }
    const chosen = extractStepPlan(outcome.output, allowedPlans(task));
    if (chosen) {
      return {
        steps: [...STEP_PLANS[chosen.plan]],
        plan: chosen.plan,
        ...(chosen.operation ? { operation: chosen.operation } : {}),
        reason: chosen.reason,
        fallback: false,
        ...(chosen.testCommand ? { testCommand: chosen.testCommand } : {}),
        ...(chosen.noTests ? { noTestsReason: chosen.noTests } : {}),
        ...(chosen.investigation ? { investigation: chosen.investigation } : {}),
        ...(chosen.images ? { images: chosen.images } : {}),
        ...(chosen.imageReason ? { imageReason: chosen.imageReason } : {}),
        ...(chosen.defaultReasons ? { defaultImageReasons: chosen.defaultReasons } : {}),
        ...(chosen.services ? { services: chosen.services } : {}),
        ...(chosen.servicesReason ? { servicesReason: chosen.servicesReason } : {}),
        ...(chosen.baseBranch ? { baseBranch: chosen.baseBranch } : {}),
        ...(chosen.exports ? { exports: chosen.exports } : {}),
        ...(chosen.documentsDir ? { documentsDir: chosen.documentsDir } : {}),
        ...(chosen.repo ? { repo: chosen.repo } : {}),
        ...(chosen.repoReason ? { repoReason: chosen.repoReason } : {}),
        ...cost,
      };
    }
    return {
      failure: {
        reason: "error",
        message: message("orchestrator.failed", { detail: message("orchestrator.unreadable") }),
        ...cost,
      },
    };
  }

  /** ゴールガーディアンに、PR の指摘の戻し先を判断させる（新しいセッション。PBI-14b）。 */
  private async judgeRework(
    task: Task,
    gateStep: StepKey,
    remarks: string[],
    config: SactyConfig,
  ): Promise<Extract<EventInput, { type: "ReworkJudged" }>["payload"]> {
    const agent = config.guardianAgent;
    const targets = reworkTargets(task, gateStep);
    // 実装の PR は、指摘が実装で直せるかを判断するので実装後のコードを、要求要件・設計の PR（PBI-57）は
    // 起点のコードを読ませる
    const { outcome, costUsd, estimated, runId } = await this.runGuardian(
      task,
      {
        agent,
        image: config.image,
        prompt: buildReworkPrompt(task, remarks, targets, gateStep),
        role: "rework",
      },
      gateStep === "implement" ? "implemented" : "base",
    );
    const judgement =
      outcome.kind === "completed"
        ? extractRework(outcome.output, targets)
        : { reason: message("run.guardianFailed", { detail: outcome.message }) };
    return {
      ...judgement,
      runResult: outcome.kind === "completed" ? "completed" : "failed",
      agentId: agent.id,
      ...agentSetting(agent),
      runId,
      usage: outcome.usage,
      costUsd,
      estimated,
    };
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
    if (!config.ok) {
      return {
        agent: null,
        problems: [config.problem],
        warnings: [],
        intake: null,
        images: [],
        platforms: [],
        agents: [],
        stepAgents: {},
        // 設定に誤りがあっても知らせる（更新で直ることもあるため）
        ...this.updateStatus(),
      };
    }
    const agent = config.config.defaultAgent;
    return {
      agent: { id: agent.id, runtime: agent.runtime, authMode: agent.auth.mode },
      problems: [],
      warnings: [
        // 接続先・単価が無くて使えないエージェント（PBI-134）
        ...(config.config.agentWarnings ?? []),
        // 起動のときに取り出せなかった秘密情報（PBI-48）
        ...this.secretProblems.map((p) => p.text),
        ...(this.deps.platformProblems?.(config.config.platforms.map((p) => p.name)) ?? []),
        ...(this.deps.hostMcpProblems?.() ?? []),
        ...(this.deps.notifier?.problems() ?? []),
      ],
      // 取り込みは、設定ファイルを読めれば動く（PBI-100。以前は github: が要った）
      intake: this.intakeStatusOf(),
      images: Object.values(config.config.images ?? {}).map(({ name, description }) => ({
        name,
        description,
      })),
      // チケットの取り込み先に選べる接続先（PBI-52）
      platforms: (config.config.platforms ?? []).map((p) => p.name),
      // タスクの詳細で工程のエージェントに選べるもの（PBI-121）。秘密の値・接続先の URL は出さない
      // config.yaml で決まる工程ごとのエージェント（人が選ばなければ使うもの。PBI-121）
      stepAgents: Object.fromEntries(
        StepKey.options.map((step) => [step, agentFor(config.config, step).id]),
      ),
      agents: Object.values(config.config.agents ?? {}).map((a) => ({
        id: a.id,
        runtime: a.runtime,
        ...(a.model ? { model: a.model } : {}),
        ...(a.reasoning_effort ? { reasoningEffort: a.reasoning_effort } : {}),
      })),
      ...this.updateStatus(),
    };
  }

  /** sacty の新しい版の知らせ（PBI-135）。無ければ項目ごと出さない。 */
  private updateStatus(): { update?: UpdateStatus } {
    const update = this.deps.update?.();
    return update ? { update } : {};
  }

  /** 1回の監査の、予算の既定の上限（config.yaml の budget.default_per_audit_usd。読めなければ既定値。PBI-124）。 */
  auditBudgetUsd(): number {
    const config = this.deps.config();
    return config.ok ? config.config.budgetPerAuditUsd : DEFAULT_AUDIT_BUDGET_USD;
  }

  listProjects(): Project[] {
    return this.deps.projects.all();
  }

  /** sacty 全体の設定（PBI-26）。 */
  getSettings(): SactySettings {
    return this.deps.settings.get();
  }

  /** 同時に実行するタスクの数（sacty の設定。設定していなければ既定値。PBI-30）。 */
  maxParallelTasks(): number {
    return this.deps.settings.get().maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
  }

  /**
   * ダッシュボードの集計（PBI-118）。畳み込んで持っている記録と今のタスクから作るので、作業履歴やタスクの全件を読み直さない。
   * 消したプロジェクトのタスクは数えない。期間の境は、このマシンのローカルの日付。設定を読めなければ、上限は既定値。
   */
  dashboard(): DashboardSummary {
    const queue = this.trackQueue();
    return this.dashboardStats.summary({
      now: this.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      projects: new Set(this.deps.projects.all().map((p) => p.id)),
      tasks: this.tasks.values(),
      queue: {
        ...queue,
        ...(this.queueOverSince !== undefined ? { overSince: this.queueOverSince } : {}),
      },
    });
  }

  /**
   * 工程の待ち行列（PBI-118）。実行中は、ワーカーが処理しているタスク（inflight。実装の後のテスト・最終レビュー・再現の確認など、
   * status が idle の処理も含む）。実行待ちは、ワーカーが次に処理する対象（queuedTaskIds。ワーカーと同じ判定）のうち、まだ処理して
   * いないもの。上限は sacty の設定（読めなければ既定値）。消したプロジェクトのタスクを除くのは、集計（summary）の側。
   */
  private queueState(): { running: string[]; waiting: string[]; max: number } {
    let max = DEFAULT_MAX_PARALLEL_TASKS;
    try {
      max = this.maxParallelTasks();
    } catch {
      // 設定の問題は status() で画面に出す
    }
    const running = [...this.inflight.keys()];
    let waiting: string[] = [];
    try {
      waiting = this.queuedTaskIds().filter((id) => !this.inflight.has(id));
    } catch {
      // 設定を読めないときは、ワーカーも実行対象を取れない（実行待ちは 0 として扱う）
    }
    return { running, waiting, max };
  }

  /**
   * 実行待ちが上限より多い状態の始まりを更新する（PBI-118）。タスクの状態・実行の開始と終わり・設定・プロジェクトが変わるたびに
   * 呼ぶので、画面を開いていない間に解消・再発しても、古い始まりが残らない。消したプロジェクトのタスクは数えない。
   */
  private trackQueue(): { running: string[]; waiting: string[]; max: number } {
    const queue = this.queueState();
    let waiting = queue.waiting.length;
    try {
      const projects = new Set(this.deps.projects.all().map((p) => p.id));
      waiting = queue.waiting.filter((id) => {
        const task = this.tasks.get(id);
        return task !== undefined && projects.has(task.projectId);
      }).length;
    } catch {
      // プロジェクトを読めなければ、実行待ちの全件で判断する
    }
    this.queueOverSince = queueOverSince(waiting, queue.max, this.now(), this.queueOverSince);
    return queue;
  }

  /**
   * sacty 全体の設定を変える。取り込むラベルが変わると、取り込みは先頭から読み直す。取り込むラベルとレビュー用のラベルは
   * 同じ名前でもよい（Issue と PR は検索の条件で分かれる。PBI-104）。
   */
  saveSettings(raw: unknown): SactySettings {
    const parsed = SactySettings.parse(raw);
    let before: string | undefined;
    try {
      before = JSON.stringify(this.deps.settings.get().notification ?? null);
    } catch {
      before = undefined; // 読めなかった設定から変えたときも、変えたものとして扱う
    }
    const saved = this.deps.settings.put(parsed);
    // 通知先を変えたら、変える前の送れなかった理由を捨てる（戻しても、前の失敗を今の障害として出さない。PBI-115 レビュー指摘）
    if (before !== JSON.stringify(saved.notification ?? null))
      this.deps.notifier?.settingsChanged?.();
    // 保存したら、取り込みはすべての種類を次の確認ですぐに取り込む（何が変わったかは見分けない。PBI-100）
    this.settingsSaves += 1;
    // 同時に実行する数の上限が変わると、実行待ちが上限より多いかも変わる（PBI-118）
    this.trackQueue();
    return saved;
  }

  /**
   * sacty の設定を保存した回数（デーモンの起動から。PBI-100）。取り込みは、これが変わったら、すべての種類の間隔の起点を戻す
   * （On にした・ラベルを変えた・Off にしてすぐ On に戻した、などを見分けずに、次の確認ですぐに取り込む）。
   */
  settingsSaveCount(): number {
    return this.settingsSaves;
  }

  /**
   * 取り込みの状況（PBI-100）。sacty の設定を読めなくても、記録した取り込み（読めなかった理由を含む）は返す
   * （`settingsUnreadable` と、いま読めなかった理由 `settingsError` を付ける。定期の確認の前でも理由がわかるように）。
   */
  private intakeStatusOf(): IntakeStatus {
    const runs = Object.keys(this.intakeRuns).length > 0 ? { runs: { ...this.intakeRuns } } : {};
    let settings: SactySettings;
    try {
      settings = this.deps.settings.get();
    } catch (error) {
      return { settingsUnreadable: true, settingsError: errorText(error), ...runs };
    }
    return { ...this.labelOf(settings), ...runs };
  }

  private labelOf(
    settings: SactySettings,
  ): Pick<IntakeStatus, "label" | "reviewLabel" | "reviewRequested"> {
    return {
      ...(settings.intakeLabel ? { label: settings.intakeLabel } : {}),
      ...(settings.reviewLabel ? { reviewLabel: settings.reviewLabel } : {}),
      ...(settings.ticketLabel ? { ticketLabel: settings.ticketLabel } : {}),
      ...(settings.reviewRequested ? { reviewRequested: true } : {}),
      // Off にしたトリアージの種類（PBI-53）
      ...(settings.triageOff ? { triageOff: settings.triageOff } : {}),
    };
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
    { repositories: string[]; errors: { org: string; message: DaemonText }[] } | undefined
  > {
    const project = this.deps.projects.get(id);
    if (!project) return undefined;
    const all = this.deps.projects.all();
    const repositories = new Map<string, string>();
    const errors: { org: string; message: DaemonText }[] = [];
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
        const token = await this.githubToken({ projectId: id }, target.target, usedSecrets);
        for (const repo of await this.deps.pulls.repositories({ org: target.target, token }))
          add(repo);
      } catch (error) {
        errors.push({ org: target.target, message: redactText(errorText(error), usedSecrets) });
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
    // チケットの取り込み先の重複は、ホストの PF だけプロジェクトをまたいで調べる（コンテキストの PF はプロジェクトごと。
    // PBI-74）。設定を読めなければ、これまでどおりすべてを調べる
    const config = this.deps.config();
    const host = config.ok
      ? new Set((config.config.platforms ?? []).map((p) => p.name))
      : undefined;
    const problems = projectConflicts(
      this.deps.projects.all(),
      id,
      definition,
      host ? { sharedPlatform: (name) => host.has(name) } : {},
    );
    const [first, ...rest] = problems;
    if (first) throw new InvalidOperationError(first, ...rest);
    const saved = this.deps.projects.put(id ?? randomUUID(), definition);
    // プロジェクトが増えると、数える実行待ちも変わる（PBI-118）
    this.trackQueue();
    return saved;
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
   * 取り込みの検索の条件と、検索に使う gh のアカウント（プロジェクトの設定。PBI-13）。
   * 検索は、ドメイン（ホスト）・アカウント・検索の種類ごとに、すべてのプロジェクトの対象（repo:・org:）を1つの検索にまとめる
   * （GitHub への検索を最小にする。複数の repo:・org: は、どれかに当たるものを探す。PBI-140）。対象が多ければ
   * INTAKE_SCOPES_PER_QUERY ずつに分ける。担当のプロジェクトの判定は、見つかったものごとに importIssues で行う。
   * アカウントを選んでいないプロジェクトは、プロジェクトごとに分け、その名前を返す（検索せず、取り込みで理由を示す）。
   * ラベルは sacty 全体の設定（PBI-26）。設定していなければ取り込まない。取り込むラベルは Issue だけを探す（PBI-99）。
   * PR は、PR のレビューの取り込み（PBI-44）だけで探す。自分（そのホストのアカウント）に個人としてレビューが依頼された PR と、
   * レビュー用のラベルの付いた PR を探す（review にどちらの検索かを添える）。
   */
  intakeSources(): IntakeSource[] {
    const settings = this.deps.settings.get();
    const off = new Set(settings.triageOff ?? []);
    // 検索の種類ごとの、対象（repo:・org:）を入れる前後の条件
    const kinds: {
      key: string;
      review?: IntakeSource["review"];
      query: (scopes: string, account?: string) => string;
    }[] = [
      // 取り込むラベルは Issue だけ（PR は取り込まない。PBI-99）。Off なら検索しない（PBI-53）
      ...(settings.intakeLabel && !off.has("issues")
        ? [
            {
              key: "issues",
              query: (scopes: string) =>
                `is:open is:issue ${scopes} label:"${settings.intakeLabel}"`,
            },
          ]
        : []),
      ...(settings.reviewLabel && !off.has("reviewLabel")
        ? [
            {
              key: "label",
              review: "label" as const,
              query: (scopes: string) => `is:open is:pr ${scopes} label:"${settings.reviewLabel}"`,
            },
          ]
        : []),
      // チームへの依頼は含めない（user-review-requested は、個人として依頼されたものだけ）。
      // アカウントを選んでいなければ検索しない（理由を示すため、条件だけ返す）
      ...(settings.reviewRequested
        ? [
            {
              key: "requested",
              review: "requested" as const,
              query: (scopes: string, account?: string) =>
                `is:open is:pr ${scopes} user-review-requested:${account ?? "@me"}`,
            },
          ]
        : []),
    ];
    const groups = new Map<
      string,
      {
        host: string;
        account?: string;
        kind: (typeof kinds)[number];
        scopes: string[];
        projects: string[];
      }
    >();
    for (const project of this.deps.projects.all()) {
      for (const target of project.targets) {
        // 検索は、対象のホストの GitHub で、そのホストのアカウントで行う（PBI-40）
        const host = targetHost(target);
        const scope =
          target.scope === "org"
            ? `org:${parseOrgUrl(target.target)?.owner}`
            : `repo:${parseRepoUrl(target.target)?.path}`;
        const account = project.githubAccounts?.[host];
        for (const kind of kinds) {
          const id = `${host}\n${account ?? `\u0000${project.id}`}\n${kind.key}`;
          const group = groups.get(id) ?? {
            host,
            ...(account ? { account } : {}),
            kind,
            scopes: [],
            projects: [],
          };
          if (!group.scopes.includes(scope)) group.scopes.push(scope);
          if (!group.projects.includes(project.name)) group.projects.push(project.name);
          groups.set(id, group);
        }
      }
    }
    return [...groups.values()].flatMap(({ host, account, kind, scopes, projects }) =>
      chunk(scopes, INTAKE_SCOPES_PER_QUERY).map((part) => ({
        host,
        query: kind.query(part.join(" "), account),
        ...(account ? { account } : {}),
        project: projects.join("・"),
        ...(kind.review ? { review: kind.review } : {}),
      })),
    );
  }

  /**
   * プロジェクトの設定と取り込むラベルの版。変わったら、取り込みは読んだ位置を忘れて先頭から読み直す。
   */
  projectsRevision(): string {
    const settings = this.deps.settings.get();
    return [
      `label:${settings.intakeLabel ?? ""}`,
      `review:${settings.reviewLabel ?? ""}:${settings.reviewRequested ? "requested" : ""}`,
      `off:${(settings.triageOff ?? []).join("+")}`,
      `ticket:${settings.ticketLabel ?? ""}`,
      ...this.deps.projects.all().map((p) => `${p.id}@${p.updatedAt}`),
    ].join(",");
  }

  /** その種類の取り込みの結果を記録する（ほかの種類の記録は残す。PBI-100）。 */
  recordIntake(kind: IntakeKind, run: IntakeRun): void {
    this.intakeRuns = { ...this.intakeRuns, [kind]: run };
  }

  /** その種類の取り込みの記録を消す（取り込み元が無くなった種類の、古い結果を残さない。PBI-100）。 */
  clearIntake(kind: IntakeKind): void {
    const { [kind]: _removed, ...rest } = this.intakeRuns;
    this.intakeRuns = rest;
  }

  /**
   * 見つかった Issue・PR をタスクにする。担当するプロジェクトは取り込むたびに判定し（範囲が狭い
   * 指定が優先）、取り込むラベル（sacty の設定）が付いた Issue だけを通常のタスクにする（PR は、取り込むラベルが付いていても
   * 通常のタスクにしない。PBI-99）。同じものは二重に取り込まない。
   * PR は、PR のレビューの取り込み（PBI-44）だけで取り込む。自分にレビューが依頼された（切り替えが入っている）か、レビュー用の
   * ラベルが付いた PR だけを取り込み、レビューだけを行うタスクにする。両方に当てはまっても1つ。
   */
  importIssues(found: readonly FoundIssue[]): Task[] {
    const settings = this.deps.settings.get();
    // Off にした種類は取り込まない（検索の後に設定を変えたときも。PBI-53）
    const off = new Set(settings.triageOff ?? []);
    const label = settings.intakeLabel?.toLowerCase();
    const reviewLabel = off.has("reviewLabel") ? undefined : settings.reviewLabel?.toLowerCase();
    if (!label && !reviewLabel && !settings.reviewRequested) return [];
    // 取り込むラベルは Issue だけ（PBI-99）
    const intakeOn = (issue: FoundIssue) => !issue.pullRequest && !off.has("issues");
    const has = (issue: FoundIssue, name: string | undefined) =>
      name !== undefined && issue.labels.some((l) => l.toLowerCase() === name);
    const projects = this.deps.projects.all();
    // リポジトリの URL は、書き方の揺れ（.git・末尾の / など）をそろえて比べる（PBI-88）
    const key = (repo: string, number: number) => `${repoKey(repo)}#${number}`;
    // sacty がタスクのために作った PR（実装の PR と、要求要件・設計の PR。ラベルを付けた記録も。PBI-88）
    const sactyMade = new Set(
      [...this.tasks.values()].flatMap((t) => [
        ...(t.pullRequest?.repo && t.pullRequest.number
          ? [key(t.pullRequest.repo, t.pullRequest.number)]
          : []),
        ...t.stepPullRequests.map((p) => key(p.repo, p.number)),
        ...(t.pullRequestLabels ?? []).map((p) => key(p.repo, p.number)),
      ]),
    );
    const reviewOf = (issue: FoundIssue): "requested" | "label" | "sacty" | undefined => {
      if (!issue.pullRequest) return undefined;
      // sacty が作り、レビュー用のラベルを付けた PR は、元のタスクとは別の、レビューだけのタスク（sacty）にする（そのレビューを、
      // 元のタスクに PR の指摘として届けるため）。レビューの依頼にも当たっても、こちらにする（PBI-88・PBI-99）
      if (has(issue, reviewLabel) && sactyMade.has(key(issue.repo, issue.number))) {
        return "sacty";
      }
      // 依頼は、担当のプロジェクトでそのホストに選んだ本人への依頼だけ（ほかのプロジェクトのアカウントへの依頼を、
      // 担当のプロジェクトのアカウントで取り込んで投稿しない。PBI-44 レビュー指摘）
      if (issue.review === "requested" && settings.reviewRequested && issue.requestedFor) {
        const host = httpsHost(`${issue.repo}/`);
        const account =
          host && responsibleProject(projects, issue.repo)?.project.githubAccounts?.[host];
        if (account && account.toLowerCase() === issue.requestedFor.toLowerCase())
          return "requested";
      }
      return has(issue, reviewLabel) ? "label" : undefined;
    };
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
      const review = reviewOf(issue);
      if (!review && !(has(issue, label) && intakeOn(issue))) continue;
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
                  ...(review ? { review } : {}),
                },
              },
            },
          },
        ]),
      );
    }
    return created;
  }

  /**
   * レビューの再依頼（PBI-143）。依頼の検索で見つかった PR のうち、依頼で取り込んでレビューを投稿して完了したタスク
   * （「再レビュー」できるもの）がある PR を、PR の今の依頼先で確かめ、そのタスクのアカウントに依頼されていれば別タスクで再レビューする。
   * 依頼された人がレビューを投稿すると GitHub が依頼を外すので、投稿の後に依頼があれば、作者が再依頼したもの。
   * 検索の結果は反映が遅れる（投稿の直後に、外れた依頼が残る）ので、それだけでは再レビューしない。
   * 確かめられなかった PR は failed に返す（取り込み側は、その検索の読んだ位置を進めず、次の取り込みで確かめ直す）。
   */
  async restartRerequestedReviews(
    found: readonly FoundIssue[],
  ): Promise<{ restarted: Task[]; failed: { issue: FoundIssue; message: DaemonText }[] }> {
    const restarted: Task[] = [];
    const failed: { issue: FoundIssue; message: DaemonText }[] = [];
    // Off にしたら再レビューしない（検索の後に設定を変えたときも）
    if (!this.deps.settings.get().reviewRequested) return { restarted, failed };
    const key = (repo: string, number: number) => `${repoKey(repo)}#${number}`;
    const seen = new Set<string>();
    for (const issue of found) {
      if (!this.deps.settings.get().reviewRequested) break;
      if (!issue.pullRequest || issue.review !== "requested" || !issue.requestedFor) continue;
      const id = key(issue.repo, issue.number);
      if (seen.has(id)) continue;
      // 依頼で取り込んだタスクだけ（ラベルで取り込んだもの・sacty が作った PR のものは、元の動きのまま）
      const related = () =>
        [...this.tasks.values()].filter(
          (t) => t.source?.review === "requested" && key(t.source.repo, t.source.number) === id,
        );
      // 新しい依頼を処理中・失敗・中止なら、古い完了タスクから予約しない。
      // 投稿が同時刻でも、より後に作ったタスクを優先する。
      const latestRelated = () =>
        related()
          .reverse()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      const task = latestRelated();
      if (!task || !canRereview(task)) continue;
      const host = httpsHost(`${issue.repo}/`);
      const account = host && this.deps.projects.get(task.projectId)?.githubAccounts?.[host];
      // そのタスクのアカウントへの依頼の検索で見つかったものだけ
      if (!account || account.toLowerCase() !== issue.requestedFor.toLowerCase()) continue;
      seen.add(id);
      const usedSecrets: string[] = [];
      const postedAt = task.reviewPost?.at;
      const posted = Date.parse(postedAt ?? "");
      const round = task.reviewRound;
      let requestedAt: string | undefined;
      let requested: boolean;
      try {
        const token = await this.githubToken(task, issue.repo, usedSecrets);
        const ref = { repo: issue.repo, number: issue.number, token };
        const pr = await this.deps.pulls.pullRequest(ref);
        // 今も依頼されていて、最後の依頼が前回の投稿より後（再依頼）のときだけ。投稿で依頼が外れなかった（取り込みの後に
        // アカウントを変えたなど）ときに、投稿のたびに再レビューを繰り返さないため
        if (!pr.requestedReviewers.some((r) => r.toLowerCase() === account.toLowerCase())) continue;
        requestedAt =
          (await this.deps.pulls.lastReviewRequest({ ...ref, reviewer: account })) ?? undefined;
        requested = Date.parse(requestedAt ?? "") > posted;
      } catch (error) {
        failed.push({
          issue,
          message: message("intake.rerequestUnchecked", {
            pr: `${issue.repo}#${issue.number}`,
            detail: redactText(errorText(error), usedSecrets),
          }),
        });
        continue;
      }
      if (!requested || !requestedAt) continue;
      // API待機中に別の取り込みが作っても、同期的な再確認とappendの間には割り込めない。
      // 中止・失敗した再依頼タスクも、同じ依頼を再作成しない。
      if (
        related().some(
          (t) =>
            t.reviewRerequest &&
            t.reviewRerequest.reviewer.toLowerCase() === account.toLowerCase() &&
            Date.parse(t.reviewRerequest.requestedAt) >= Date.parse(requestedAt),
        )
      )
        continue;
      // 確かめている間に、人が再レビュー・中止・一時停止したら、始めない
      const latest = latestRelated();
      if (
        !latest ||
        latest.id !== task.id ||
        !canRereview(latest) ||
        this.pauseRequested.has(task.id)
      )
        continue;
      if (this.cancelling.has(task.id)) continue;
      if (latest.reviewRound !== round || latest.reviewPost?.at !== postedAt) continue;
      const latestAccount =
        host && this.deps.projects.get(latest.projectId)?.githubAccounts?.[host];
      if (
        !this.deps.settings.get().reviewRequested ||
        latestAccount?.toLowerCase() !== account.toLowerCase()
      )
        continue;
      if (!latest.reviewTarget || !latest.reviewPost || !latest.source) continue;
      const config = this.deps.config();
      restarted.push(
        this.append({ id: randomUUID(), projectId: latest.projectId }, [
          {
            actor: "sacty",
            event: {
              type: "TaskCreated",
              payload: {
                title: issue.title.trim() || latest.title,
                body: issue.body,
                start: "github_pull_request",
                source: latest.source,
                budgetCapUsd: config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD,
                reviewRerequest: {
                  taskId: latest.id,
                  requestedAt,
                  reviewer: account,
                  previousReview: {
                    round: latest.reviewRound ?? 1,
                    url: latest.reviewPost.url,
                    at: latest.reviewPost.at,
                    headCommit: latest.reviewTarget.headCommit,
                    body: latest.outputs.review ?? "",
                    comments: latest.reviewComments,
                  },
                },
              },
            },
          },
        ]),
      );
    }
    return { restarted, failed };
  }

  /**
   * チケットの取り込み先（PBI-52）。すべてのプロジェクトの取り込み先を、接続先と種類ごとにまとめる（キーは合わせる）。
   * 取り込むラベル（sacty の設定）が無いか、チケットのトリアージを Off にしていれば、取り込まない。
   */
  ticketSources(): {
    platform: string;
    service: TicketService;
    keys: string[];
    label: string;
    /**
     * 接続先がホストの PF（config.yaml）に無いとき、そのプロジェクト（PBI-74）。プロジェクトのコンテキストの PF は
     * プロジェクトごとに別のものなので、ほかのプロジェクトと合わせずに、そのプロジェクトの PF で検索する。
     */
    projectId?: string;
  }[] {
    const settings = this.deps.settings.get();
    const label = settings.ticketLabel;
    if (!label || settings.triageOff?.includes("tickets")) return [];
    const config = this.deps.config();
    const host = new Set(config.ok ? config.config.platforms.map((p) => p.name) : []);
    const groups = new Map<
      string,
      { platform: string; service: TicketService; keys: Set<string>; projectId?: string }
    >();
    for (const project of this.deps.projects.all()) {
      for (const source of project.tickets ?? []) {
        const own = !host.has(source.platform);
        const id = `${source.platform}\u0000${source.service}${own ? `\u0000${project.id}` : ""}`;
        const group = groups.get(id) ?? {
          platform: source.platform,
          service: source.service,
          keys: new Set<string>(),
          ...(own ? { projectId: project.id } : {}),
        };
        for (const key of source.keys) group.keys.add(key);
        groups.set(id, group);
      }
    }
    return [...groups.values()].map((g) => ({
      platform: g.platform,
      service: g.service,
      keys: [...g.keys].sort(),
      label,
      ...(g.projectId ? { projectId: g.projectId } : {}),
    }));
  }

  /**
   * 見つかったチケットをタスクにする（PBI-52）。担当するプロジェクトは、接続先とチケットのキーで決める（取り込むたびに
   * 判定する）。同じチケットは二度取り込まない。中身はオーケストレーターが読むので、題はキーと要約だけにする。
   */
  importTickets(found: readonly FoundTicket[]): Task[] {
    const settings = this.deps.settings.get();
    if (!settings.ticketLabel || settings.triageOff?.includes("tickets")) return [];
    const projects = this.deps.projects.all();
    // チケットの識別：ホストの PF は名前とキー、プロジェクトのコンテキストの PF はプロジェクトもあわせる（PBI-74）
    const id = (platform: string, key: string, projectId?: string) =>
      `${platform}\u0000${key}${projectId !== undefined ? `\u0000${projectId}` : ""}`;
    const known = new Set(
      [...this.tasks.values()].flatMap((t) =>
        t.ticket
          ? [
              id(
                t.ticket.platform,
                t.ticket.key,
                t.ticket.scope === "project" ? t.projectId : undefined,
              ),
            ]
          : [],
      ),
    );
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const created: Task[] = [];
    for (const ticket of found) {
      const ticketId = id(ticket.platform, ticket.key, ticket.projectId);
      if (known.has(ticketId)) continue;
      const responsible = responsibleTicketProject(
        projects,
        ticket.platform,
        ticket.key,
        ticket.projectId,
      );
      if (!responsible) continue;
      known.add(ticketId);
      created.push(
        this.append({ id: randomUUID(), projectId: responsible.project.id }, [
          {
            actor: "sacty",
            event: {
              type: "TaskCreated",
              payload: {
                title: `${ticket.key} ${ticket.summary}`.trim(),
                body: `JIRA のチケット ${ticket.key}（${ticket.url}）から取り込みました。オーケストレーターがチケットを読んで、作業するリポジトリと概要を決めます。`,
                start: "jira",
                budgetCapUsd,
                ticket: {
                  platform: ticket.platform,
                  service: ticket.service,
                  key: ticket.key,
                  url: ticket.url,
                  ...(ticket.projectId !== undefined ? { scope: "project" as const } : {}),
                },
              },
            },
          },
        ]),
      );
    }
    return created;
  }

  /**
   * チケットの取り込みの1段目（PBI-52）。オーケストレーターが、ゲートウェイ経由でチケット（サブタスクなら親とほかの
   * サブタスクも）を読み、プロジェクトの対象のリポジトリから作業するリポジトリを選び、題と概要を書く。決められなければ、
   * 理由を記録して止める（人がリポジトリを選んで再開できる。再開すると、もう一度読む）。
   */
  private async triageTicket(task: Task, config: SactyConfig): Promise<void> {
    const ticket = task.ticket;
    if (!ticket) return;
    const pause = (reason: PauseReason, text: DaemonText) =>
      this.append(this.mustGet(task.id), [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason, message: text } } },
      ]);
    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return;
    }
    // 接続先は、ホストの PF か、プロジェクトのコンテキストの PF（PBI-74）
    let platform: Platform | undefined;
    const usedSecrets: string[] = [];
    try {
      platform = await this.findPlatform(task, config, ticket.platform, usedSecrets);
    } catch (error) {
      pause(
        "error",
        message("ticket.triageFailed", { detail: redactText(errorText(error), usedSecrets) }),
      );
      return;
    }
    if (!platform) {
      pause(
        "error",
        message("ticket.triageFailed", {
          detail: message("ticket.platformMissing", { platform: ticket.platform }),
        }),
      );
      return;
    }
    // 人がリポジトリを選んでいれば、そのリポジトリに固定する（チケットの要件は読み直して書く）
    const fixed = task.repo && task.ticketTriage?.by === "person" ? task.repo : undefined;
    const candidates = fixed
      ? [fixed]
      : ((await this.projectRepositories(task.projectId))?.repositories ?? []);
    if (candidates.length === 0) {
      pause("error", message("ticket.triageFailed", { detail: message("ticket.noCandidates") }));
      return;
    }
    const agent = agentFor(config, "orchestrator");
    const { outcome, costUsd, estimated, runId } = await this.runGuardian(
      task,
      {
        agent,
        image: config.image,
        prompt: [
          buildTicketTriagePrompt(task, candidates, platform.name, fixed !== undefined),
          ...platformPromptLines([platform]),
        ].join("\n"),
        role: "orchestrator",
        platforms: [platform],
      },
      "base",
    );
    // 読んでいる間に、人間が止めた・中止した・ほかで決まったなら、記録しない
    const latest = this.mustGet(task.id);
    if (this.pauseRequested.has(task.id) || this.cancelling.has(task.id)) return;
    if (latest.status !== "queued" || !awaitingTicketTriage(latest) || latest.repo !== task.repo) {
      return;
    }
    const cost = {
      agentId: agent.id,
      ...agentSetting(agent),
      runId,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      costUsd,
      estimated,
    };
    const fail = (reason: "usage_limit" | "auth" | "error", detail: DaemonText) => {
      const text = message("ticket.triageFailed", { detail });
      this.append(latest, [
        {
          actor: "orchestrator",
          event: { type: "OrchestratorFailed", payload: { reason, message: text, ...cost } },
        },
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason, message: text } } },
      ]);
      this.warnIfNeeded(this.mustGet(task.id));
    };
    if (outcome.kind === "failed") return fail(outcome.reason, outcome.message);
    const triage = extractTicketTriage(outcome.output);
    if (!triage) return fail("error", message("ticket.triageUnreadable"));
    // 後の工程は概要を読んで作業するので、概要が無ければ要件を書けていない（どちらの経路でも止める）。
    // 固定したリポジトリなら、出力のリポジトリは使わない
    if (!triage.summary || (!fixed && !triage.repo)) {
      return fail("error", triage.reason || message("ticket.triageUnreadable"));
    }
    const repo = fixed ?? candidates.find((c) => sameGitHubUrl(c, triage.repo));
    if (!repo) return fail("error", message("ticket.repoNotCandidate", { repo: triage.repo }));
    this.append(latest, [
      {
        actor: "orchestrator",
        event: {
          type: "TicketTriaged",
          payload: {
            repo,
            ...(triage.title ? { title: triage.title } : {}),
            ...(triage.summary ? { body: triage.summary } : {}),
            reason: triage.reason,
            ...cost,
          },
        },
      },
    ]);
    this.warnIfNeeded(this.mustGet(task.id));
  }

  /**
   * チケットから取り込んだタスクの、作業するリポジトリを人が選ぶ（PBI-52。オーケストレーターが決められなかったとき）。
   * まだ工程を決めていないタスクだけ。選んだ後に再開すると、そのリポジトリで工程を選ぶ。
   */
  async chooseTicketRepository(id: string, repo: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (!task.ticket || task.steps.length > 0 || task.status === "cancelled" || task.repository) {
      throw new InvalidOperationError(message("ticket.notTriageable"));
    }
    const candidates = (await this.projectRepositories(task.projectId))?.repositories ?? [];
    const chosen = candidates.find((c) => sameGitHubUrl(c, repo));
    if (!chosen) throw new InvalidOperationError(message("ticket.repoNotCandidate", { repo }));
    return this.append(this.mustGet(id), [
      {
        actor: "person",
        event: {
          type: "TicketTriaged",
          payload: { repo: chosen, reason: message("ticket.repoChosenByPerson") },
        },
      },
    ]);
  }

  /** 完了した調査の結果を、取り込み元のチケットにコメントする（PBI-52）。返せなければ理由を記録する。 */
  private async commentTicketInvestigation(task: Task): Promise<void> {
    const event = await this.commentTicket(task, buildTicketInvestigationComment(task));
    const latest = this.tasks.get(task.id);
    if (!latest || !awaitingIssueComment(latest)) return;
    this.append(latest, [
      {
        actor: "sacty",
        event:
          "url" in event
            ? { type: "IssueCommented", payload: { url: event.url } }
            : { type: "IssueCommentFailed", payload: { message: event.failed } },
      },
    ]);
  }

  /** 作った PR の URL を、取り込み元のチケットにコメントする（PBI-52）。1回だけ。 */
  private async commentTicketPullRequest(task: Task): Promise<void> {
    const event = await this.commentTicket(task, buildTicketPullRequestComment(task));
    const latest = this.tasks.get(task.id);
    if (!latest || !awaitingTicketPrComment(latest)) return;
    this.append(latest, [
      { actor: "sacty", event: { type: "TicketPullRequestCommented", payload: event } },
    ]);
  }

  private async commentTicket(
    task: Task,
    body: string,
  ): Promise<{ url: string } | { failed: DaemonText }> {
    const ticket = task.ticket;
    const config = this.deps.config();
    if (!ticket || !this.deps.tickets) {
      return { failed: message("ticket.platformMissing", { platform: ticket?.platform ?? "" }) };
    }
    // 接続先は、ホストの PF か、プロジェクトのコンテキストの PF（PBI-74）
    let platform: Platform | undefined;
    const usedSecrets: string[] = [];
    try {
      platform = config.ok
        ? await this.findPlatform(task, config.config, ticket.platform, usedSecrets)
        : undefined;
    } catch (error) {
      return { failed: redactText(errorText(error), usedSecrets) };
    }
    if (!platform)
      return { failed: message("ticket.platformMissing", { platform: ticket.platform }) };
    try {
      return await this.deps.tickets.comment({
        platform,
        service: ticket.service,
        key: ticket.key,
        body,
      });
    } catch (error) {
      return { failed: ticketErrorText(error) };
    }
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
    const before = this.tasks.get(task.id);
    // 完了した瞬間の追記なら、監査を待つ記録を同じ追記に入れる（完了と監査の登録の間で止まっても、監査が抜けないように。
    // この機能より前に完了したタスクは監査しない。PBI-125・PR #135 レビュー指摘）
    const queued = this.auditQueueEvent(before, preview.get(task.id));
    if (queued) {
      preview = applyEvent(preview, {
        ...EventInput.parse(queued.event),
        seq: Number.MAX_SAFE_INTEGER,
        id: "preview-audit",
        taskId: task.id,
        projectId: task.projectId,
        at,
        actor: queued.actor,
      });
    }
    const written = this.deps.activity.append({
      taskId: task.id,
      projectId: task.projectId,
      events: queued ? [...events, queued] : events,
    });
    for (const event of written) {
      const previous = this.tasks.get(event.taskId);
      this.tasks = applyEvent(this.tasks, event);
      const applied = this.tasks.get(event.taskId);
      if (applied) this.dashboardStats.add(event, previous, applied);
    }
    const updated = this.tasks.get(task.id);
    if (!updated) throw new Error("task is missing from the projection");
    this.trackQueue();
    // 人間の出番（承認待ち・エスカレーション・一時停止）と完了を通知する（送るのは待たない。PBI-38）
    const kind = notificationFor(before, updated);
    // 通知の誤りは、書き終えたタスクの操作に伝えない（PBI-115 レビュー指摘）
    if (kind) {
      try {
        void this.deps.notifier?.notify(updated, kind)?.catch?.(() => {});
      } catch {
        // 通知の側で理由を持つ
      }
    }
    return updated;
  }

  /**
   * 画面からタスクを作る。作るプロジェクトは必ず指定する（既定のプロジェクトは無い。PBI-22）。
   * template があれば、テンプレートから作る（題と説明は sacty が決める。PBI-90）。
   */
  createTask(raw: unknown): Task {
    if (raw && typeof raw === "object" && "template" in raw) return this.createTemplateTask(raw);
    const input = CreateTaskInput.parse(raw);
    const { projectId } = input;
    const project = this.deps.projects.get(projectId);
    if (!project) {
      throw new InvalidOperationError(message("project.notFound"));
    }
    // 対象リポジトリは、プロジェクトの対象（Org・リポジトリ）の中から選ぶ（PBI-25）。
    // 対象がリポジトリ1つだけなら、選ばなくてよい。null は、リポジトリを指定しない（PBI-73）
    const [only, ...others] = project.targets;
    const wanted =
      input.repo === null
        ? undefined
        : (input.repo ?? (only?.scope === "repo" && others.length === 0 ? only.target : undefined));
    if (project.targets.length === 0) {
      throw new InvalidOperationError(message("task.repositoryMissing", { project: project.name }));
    }
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const { title, body } = input;
    // リポジトリを指定しないタスク（PBI-73）。オーケストレーターが、プロジェクトのコンテキストと対象から進め方を決める
    if (!wanted) {
      return this.append({ id: randomUUID(), projectId }, [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title, body, start: "sacty", noRepo: true, budgetCapUsd },
          },
        },
      ]);
    }
    const repo = this.projectRepository(project, wanted);
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

  /**
   * 対象リポジトリが、プロジェクトの対象の中にあるかを確かめ、記録する名前を返す（リポジトリの対象なら、登録した
   * 名前にそろえる：大文字・小文字の違い）。
   */
  private projectRepository(project: Project, wanted: string): string {
    const responsible = RepoUrl.safeParse(wanted).success
      ? responsibleProject(this.deps.projects.all(), wanted)
      : undefined;
    if (responsible?.project.id !== project.id) {
      throw new InvalidOperationError(message("task.repositoryUnknown", { project: project.name }));
    }
    return responsible.target.scope === "repo" ? responsible.target.target : RepoUrl.parse(wanted);
  }

  /**
   * テンプレートからタスクを作る（PBI-90）。題と説明はテンプレートから決め、対象リポジトリは必須（省略すると、
   * プロジェクトの対象がリポジトリ1つだけならそれにする）。作った後は、通常のタスクと同じく進む。
   */
  private createTemplateTask(raw: unknown): Task {
    const input = CreateTemplateTaskInput.parse(raw);
    const project = this.deps.projects.get(input.projectId);
    if (!project) throw new InvalidOperationError(message("project.notFound"));
    if (project.targets.length === 0) {
      throw new InvalidOperationError(message("task.repositoryMissing", { project: project.name }));
    }
    const [only, ...others] = project.targets;
    const wanted =
      input.repo ?? (only?.scope === "repo" && others.length === 0 ? only.target : undefined);
    if (!wanted) throw new InvalidOperationError(message("task.templateRepositoryRequired"));
    const repo = this.projectRepository(project, wanted);
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const { title, body } = templateTask(input.template, repo);
    return this.append({ id: randomUUID(), projectId: project.id }, [
      {
        actor: "person",
        event: {
          type: "TaskCreated",
          payload: { title, body, start: "sacty", repo, budgetCapUsd, template: input.template },
        },
      },
    ]);
  }

  /** 実行待ちのタスク（古い順）。 */
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  queuedTaskIds(): string[] {
    return (
      [...this.tasks.values()]
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
              awaitingReproductionCheck(t) ||
              // 作った PR の URL を、チケットにコメントする（PBI-52）
              awaitingTicketPrComment(t) ||
              // 承認した成果を、決めた書き出し先に書き出す（PBI-56）
              awaitingExport(t) !== undefined ||
              // 要求要件・設計の成果を、タスクブランチへの PR にする（PBI-57）
              this.awaitingStepPullRequest(t) !== undefined ||
              // マージの後のデプロイの確認（PBI-89）。一時停止中のタスクでは実行しない
              (awaitingDeploymentCheck(t) && t.status !== "paused") ||
              // 完了したタスクの監査（PBI-125）
              this.awaitingAudit(t),
        )
        .filter((t) => !this.cancelling.has(t.id) && !this.pauseRequested.has(t.id))
        // 監査だけが残るタスク（完了したタスク）は、ほかの実行の後にする（監査で、進めている作業の実行の枠を塞がない。PBI-125）
        .sort(
          (a, b) =>
            Number(this.auditOnly(a)) - Number(this.auditOnly(b)) ||
            a.createdAt.localeCompare(b.createdAt),
        )
        .map((t) => t.id)
    );
  }

  /**
   * デーモンが止まって中断された実行を、失敗として記録して一時停止する。
   * 中断されたゴールガーディアンの判定は、判定できなかったものとして人間に判断してもらう。
   */
  recoverInterrupted(): void {
    // デーモンが止まって答えられなかった質問は、中断として記録する（次の質問を受け付けるため。PBI-54）
    for (const task of [...this.tasks.values()]) {
      const question = pendingQuestion(task);
      if (!question || task.status === "cancelled") continue;
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "QuestionAnswered",
            payload: {
              questionId: question.id,
              failed: message("run.daemonStopped"),
              runResult: "interrupted",
              agentId: "unknown",
            },
          },
        },
      ]);
    }
    // デーモンが止まって途中になったデプロイの確認は、マージの後の監視の工程（PBI-116）なら、ほかの工程の実行と同じく
    // 中断として記録して一時停止する（再開すると確かめ直す）。工程の無い PBI-116 より前のタスクの監視は、確かめられなかった
    // （中断）として終える（やり直さない。PBI-89）
    for (const task of [...this.tasks.values()]) {
      if (!deploymentCheckRunning(task)) continue;
      const stepped = task.steps.some((s) => s.key === "deployment");
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "DeploymentChecked",
            payload: {
              result: "unknown",
              evidence: [],
              failed: message("run.daemonStopped"),
              runResult: "interrupted",
              agentId: "unknown",
              ...(task.deployment?.check ? { runId: task.deployment.check.runId } : {}),
              ...(stepped ? { retry: true as const } : {}),
            },
          },
        },
        ...(stepped && (task.status === "idle" || task.status === "queued")
          ? [
              {
                actor: "sacty" as const,
                event: {
                  type: "TaskPaused" as const,
                  payload: { reason: "error" as const, message: message("run.daemonStopped") },
                },
              },
            ]
          : []),
      ]);
    }
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
                runResult: "interrupted",
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
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              ...(step === "operation" ? this.unstoppedPayload([task.currentRunId]) : {}),
            },
          },
        },
      ]);
    }
  }

  /**
   * 実行できなかったために待機している工程を、実行待ちにする（起動時に呼ぶ）。
   * まだ一度も出力が無い工程だけが対象（PBI-7で承認され設計の工程が無かった、
   * PBI-8・9で設計が承認され実装の工程が無かったため待機していたタスクなど）。
   */
  queueWaitingSteps(): void {
    for (const task of this.tasks.values()) {
      const step = activeStep(task);
      if (task.status !== "idle" || !step || openProposal(task)) continue;
      if (!EXECUTABLE_STEPS.includes(step)) continue;
      if (task.outputs[step] !== undefined || task.verification) continue;
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
    // PR は常に作る（PR を作るかの設定は無い）
    return {
      ok: true,
      repo: {
        url: `${repo}.git`,
        ...(task.repository ? { baseBranch: task.repository.baseBranch } : {}),
        ...(task.testCommand ? { testCommand: task.testCommand } : {}),
        // テストは、確かめる工程のイメージで実行する（PBI-41）。実装のイメージ（無ければ再現のイメージ）。
        // images から消した名前なら既定のイメージにしておき、テストを実行するところで理由を示して止める
        ...testImageOf(config, task.images?.implement ?? task.images?.reproduce),
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
   * タスクのプロジェクトに設定した、url（リポジトリ・Org の URL）のホストの gh のアカウントで、GitHub のトークンを
   * 取り出す（PBI-13・PBI-40）。アカウントを選んでいなければ、理由つきで止める（アクティブなアカウントは
   * 切り替わるので使わない）。取り出した値は、出力やエラー文から取り除く対象にする。
   */
  private async githubToken(
    task: Pick<Task, "projectId">,
    url: string,
    usedSecrets: string[],
    /** 保存していない設定で確かめるときの、プロジェクトの定義（PBI-76）。無ければ保存したもの。 */
    unsaved?: ProjectDefinition,
  ): Promise<string> {
    const project = unsaved ?? this.deps.projects.get(task.projectId);
    const host = httpsHost(`${url}/`) ?? "";
    const account = project?.githubAccounts?.[host];
    if (!account) {
      throw new MessageError(
        message("github.accountRequired", { project: project?.name ?? task.projectId, host }),
      );
    }
    const token = await this.deps.github.token(host, account);
    usedSecrets.push(...gitAuthSecrets(token));
    return token;
  }

  /** タスクのプロジェクトで、url のホストに選んだ gh のアカウント（選んでいなければ空）。 */
  private githubAccountOf(task: Task, url: string): { account?: string } {
    const host = httpsHost(`${url}/`) ?? "";
    const account = this.deps.projects.get(task.projectId)?.githubAccounts?.[host];
    return account ? { account } : {};
  }

  /**
   * プロジェクトの GitHub（アカウントを選んだホストか、対象のホスト）の HTTPS の URL なら、gh のトークンで git を
   * 認証する環境変数。それ以外（SSH・ローカルのパス・ほかの git のサーバー）はホストの認証を使う。
   */
  private async gitAuth(
    task: Pick<Task, "projectId">,
    url: string,
    usedSecrets: string[],
    /** 保存していない設定で確かめるときの、プロジェクトの定義（PBI-76）。無ければ保存したもの。 */
    unsaved?: ProjectDefinition,
  ): Promise<Record<string, string> | undefined> {
    const host = httpsHost(url);
    const project = unsaved ?? this.deps.projects.get(task.projectId);
    const github =
      host !== undefined &&
      (project?.githubAccounts?.[host] !== undefined ||
        (project?.targets.some((t) => targetHost(t) === host) ?? false));
    return host && github
      ? gitAuthEnv(host, await this.githubToken(task, url, usedSecrets, unsaved))
      : undefined;
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
    this.trackQueue();
    // 完了は、止めたコンテナの確認と一時停止の記録まで含める（一時停止・中止はこれを待つ）
    entry.done = this.runningTask.run(taskId, async () => {
      try {
        await this.runNextInner(taskId);
      } finally {
        if (this.pauseRequested.has(taskId)) {
          // 止めたコンテナが本当に無くなったかを確かめてから、一時停止を記録する
          this.pauseIfRequested(taskId, await this.unstopped(entry.runIds));
        }
      }
    });
    try {
      await entry.done;
    } finally {
      this.inflight.delete(taskId);
      this.trackQueue();
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
    // 承認した成果の書き出しは、次の工程と取り込み元へのコメントの前に行う（コメントに URL を添えるため。PBI-56）
    const exporting = initial && awaitingExport(initial);
    if (initial && exporting) return this.exportOutput(initial, exporting);
    if (initial && awaitingVerification(initial)) return this.verify(initial);
    // 要求要件・設計の成果を、タスクブランチへの PR にして承認待ちにする（PBI-57）
    const waitingPr = initial && this.awaitingStepPullRequest(initial);
    if (initial && waitingPr) return this.publishStepPullRequest(initial, waitingPr);
    if (initial && awaitingIssueComment(initial)) return this.commentInvestigation(initial);
    if (initial && awaitingReviewPost(initial)) return this.postReview(initial);
    if (initial && this.splitPending(initial)) return this.settleSplit(initial);
    if (initial && awaitingReproductionCheck(initial)) return this.checkReproduction(initial);
    // 作った PR の URL を、取り込み元のチケットにコメントする（PBI-52）
    if (initial && awaitingTicketPrComment(initial)) return this.commentTicketPullRequest(initial);
    // マージの後のデプロイの確認（PBI-89）
    if (initial && awaitingDeploymentCheck(initial) && initial.status !== "paused") {
      return this.checkDeployment(initial);
    }
    // 完了したタスクの監査（PBI-125）。1回の呼び出しで、エージェントの実行を1つだけ進める
    if (initial && this.awaitingAudit(initial)) return this.runAudit(initial);
    if (initial?.status !== "queued") return;
    const config = this.deps.config();
    if (!config.ok) return; // 設定の問題は status() で画面に出す。タスクは実行待ちのまま。

    // チケットから取り込んだタスクは、まずオーケストレーターがチケットを読んで、作業するリポジトリ・題・概要を決める
    // （PBI-52。1段目）。リポジトリを用意した後に、いつもどおり工程を選ぶ（2段目）
    // 人がリポジトリを選んだ後も、そのリポジトリで題と概要を書くために、もう一度チケットを読む
    if (awaitingTicketTriage(initial)) return this.triageTicket(initial, config.config);

    // 対象リポジトリは、タスクの開始時（最初の実行）に、ベースブランチの最新を用意する（PBI-15）。
    // どの工程から始まるタスクでも同じ。以後はその起点のコミットを最後まで使う（途中で取り込み直さない）。
    // 用意できなければ、エージェントを実行する（費用をかける）前に、理由を記録して止める
    // 対象リポジトリの無いタスク（PBI-73）は、用意しない（工程を選んでリポジトリを決めたら、次の実行で用意する）
    if (!initial.repository && !isRepoless(initial)) {
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
      // PR のレビューの取り込みのタスクは、工程をレビューだけにする（オーケストレーターに選ばせない。PBI-44）
      const review = this.mustGet(taskId).source?.review;
      // プロジェクトの対象で指定したイメージ（PBI-41）は、レビューだけの工程にも同じく使い、名前も確かめる（PBI-44 レビュー指摘）
      const choice = review
        ? this.withImages(
            reviewOnlySteps(review),
            config.config,
            this.pinnedImage(this.mustGet(taskId)),
          )
        : await this.chooseSteps(this.mustGet(taskId), config.config);
      // 対象リポジトリの無いタスクで、コードの変更が要り、分けないなら、選んだリポジトリを記録する（PBI-73）。
      // 次の実行でそのリポジトリを用意して、いつもどおり工程を選ぶ
      if ("repository" in choice) {
        const latest = this.mustGet(taskId);
        if (this.pauseRequested.has(taskId) || this.cancelling.has(taskId)) return;
        // 選んでいる間に、人がリポジトリを選んだなら、記録しない
        if (latest.status !== "queued" || !awaitingRepository(latest) || !isRepoless(latest)) {
          return;
        }
        this.append(latest, [
          {
            actor: "orchestrator",
            event: { type: "RepositoryChosen", payload: choice.repository },
          },
        ]);
        this.warnIfNeeded(this.mustGet(taskId));
        return;
      }
      if ("failure" in choice) {
        // 選んでいる間に人間が止めた・中止したなら、記録しない（止めた記録は runNext の後始末で行う）
        const latest = this.mustGet(taskId);
        if (this.pauseRequested.has(taskId) || this.cancelling.has(taskId)) return;
        if (latest.status !== "queued" || latest.steps.length > 0) return;
        this.append(latest, [
          { actor: "orchestrator", event: { type: "OrchestratorFailed", payload: choice.failure } },
          {
            actor: "sacty",
            event: {
              type: "TaskPaused",
              payload: { reason: choice.failure.reason, message: choice.failure.message },
            },
          },
        ]);
        // 失敗した実行の費用でも、80%の通知は判定する（一時停止はすでにしている）
        this.warnIfNeeded(this.mustGet(taskId));
        return;
      }
      const { baseBranch, ...chosen } = choice;
      // 既定のブランチと違うベースブランチを選んだなら、そのブランチの最新で用意し直す（PBI-25）。
      // 用意できなければ、既定のブランチのまま進め、そのことを理由に添える
      const prepared = this.mustGet(taskId).repository;
      const rebased =
        baseBranch && prepared && baseBranch !== prepared.baseBranch
          ? await this.prepareRepository(this.mustGet(taskId), config.config, {
              branch: baseBranch,
            })
          : undefined;
      // マージの後の監視の工程をするかを、起点のコミットのデプロイの確認のスキルで決める（PBI-116）
      if (chosen.steps.includes("deployment")) {
        const commit =
          rebased?.ok && rebased.prepared
            ? rebased.prepared.baseCommit
            : this.mustGet(taskId).repository?.baseCommit;
        Object.assign(
          chosen,
          this.withDeploymentChoice(
            chosen,
            await this.deploymentChoice(this.mustGet(taskId), commit),
          ),
        );
      }
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
      // テストの仕組みが無いという判断（PBI-94）を確かめる。使えなければ、テストのコマンドを決められなかったものとして
      // 記録せずに止める（再開しても、テストを飛ばして通らないように）
      const noTests = this.checkNoTests(latest, chosen);
      if (noTests.stop) delete chosen.noTestsReason;
      events.push({
        actor: review ? "sacty" : "orchestrator",
        event: { type: "StepsChosen", payload: chosen },
      });
      // 実装を含むのにテストのコマンドが分からなければ、検証できないので費用をかける前に止める（PBI-25）。
      // テストの仕組みが無いと判断し、それを確かめられたなら止めない（PBI-94）
      if (chosen.steps.includes("implement") && !chosen.testCommand && !chosen.noTestsReason) {
        events.push({
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: noTests.stop ?? message("orchestrator.testCommandUnknown"),
            },
          },
        });
      }
      this.append(latest, events);
    }
    const task = this.mustGet(taskId);
    if (task.status !== "queued") return;
    const step = activeStep(task);
    if (!step) return;

    // 検証に通った実装の PR は、実装の工程の中で、エージェントではなく sacty が作る（PBI-110。予算の上限に達していても作る。
    // 費用はかからず、人の承認を待つだけなので）
    if (step === "implement" && task.publishPending) {
      return this.publish(this.mustGet(task.id), config.config);
    }

    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return;
    }

    // 統合レビューは、ゴールガーディアンがベースブランチの最新のコードで行う（PBI-31）
    if (step === "integrate") return this.integrate(task, config.config);
    if (step === "operation") return this.executeOperation(task, config.config);

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

    // 工程に使う AI（人がタスクの詳細で選んだもの。無ければ step_agents か default_agent。PBI-40・PBI-121）。準備（レビューの
    // 対象の確認など）の間に人が変えていれば、それを使う。決めてから開始の記録までは待たない（PR #131 レビュー指摘）
    const chosenName = this.mustGet(task.id).agents?.[step];
    const chosen = stepAgentFor(config.config, step, chosenName);
    if (!chosen.ok) {
      // 準備の間に選び直した名前が、この実行が読んだ設定に無い（その間に config.yaml に足した）なら、止めずに実行待ちの
      // まま戻し、次の実行で最新の設定から決め直す（PR #131 再々レビュー指摘）
      if (chosenName !== task.agents?.[step]) return;
      this.pauseForMissingAgent(task, step, chosen.missing);
      return;
    }
    const agent = chosen.agent;
    const runId = randomUUID();
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: { runId, step, agentId: agent.id, ...agentSetting(agent) },
        },
      },
    ]);
    // 工程のイメージは、実行を始めたときのものに決める。実行の間に人が変えても、この実行は変えない（次の実行から。PBI-106）
    const runImageName = this.mustGet(task.id).images?.[step];

    // 実装の工程は clone を作業領域にし、それ以外の工程は、起点のコミットのコードを使い捨ての写しで渡す
    // （clone はタスクの開始時に済んでいる。作業領域が消えていれば、同じ起点で用意し直す）
    // 対象リポジトリの無いタスク（PBI-73）は、空の作業領域で実行する。コードが要る工程は選ばせないが、選ばれていたら止める
    const repoless = isRepoless(this.mustGet(task.id));
    const ready: Awaited<ReturnType<TaskService["prepareRepository"]>> = repoless
      ? REPO_STEPS.includes(step)
        ? { ok: false, message: message("repo.stepNeedsRepository", { step }) }
        : { ok: true, dir: join(this.deps.workspaceRoot, task.id, "empty") }
      : await this.prepareRepository(this.mustGet(task.id), config.config);
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
    // 実装と再現（再現のテストを書く。PBI-29）は clone を作業領域にし、ほかは使い捨ての写し（書き込めるので、
    // リポジトリの手順のセットアップなども実行できる。変更は残らない。PBI-40）
    const scratch = step !== "implement" && step !== "reproduce";

    // sacty の既定のコンテキストと、プロジェクトのコンテキストを取得・合成して渡し、
    // 使ったリポジトリとコミット（既定は中身のハッシュ）を記録する
    let context: RunContext | undefined;
    if (step !== "document") {
      const usedSecrets: string[] = [];
      try {
        context = await this.runContext(task, agent, config.config, usedSecrets);
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
    }
    // 使える外部 PF：ホストの PF と、プロジェクトのコンテキストで合成した PF（同じ名前ならホストのもの。PBI-74）
    const runPlatforms = mergePlatforms(
      step === "document" ? [] : config.config.platforms,
      context?.platforms ?? [],
    );
    // ここから実行の try（finally で消す）までに例外になっても、用意したコンテキスト（一時のディレクトリ・ホストで起動する
    // MCP サーバーの確保）を残さない（PR #89 レビュー指摘）
    let splitCandidates: string[] | undefined;
    try {
      if (context) this.append(task, [this.contextResolved(runId, context, runPlatforms)]);

      // 対象リポジトリの無いタスクを分けるときの、子タスクのリポジトリの候補（プロジェクトの対象。PBI-73）
      splitCandidates =
        step === "split" && repoless
          ? ((await this.projectRepositories(task.projectId))?.repositories ?? [])
          : undefined;
    } catch (error) {
      context?.dispose();
      throw error;
    }
    let executed: Executed | undefined;
    // レビューの工程は、起点ではなく PR の先頭のコミットのコードを読ませ、PR の差分を渡す（PBI-19）
    const reviewTarget = step === "review" ? this.mustGet(task.id).reviewTarget : undefined;
    let reviewDiff: string | undefined;
    // 再レビューで、前回の投稿の後の PR の作者の返答（PBI-111）
    let reviewReplies: PullRequestFeedback[] | "unreadable" | undefined;
    // 要求要件・設計の工程は、起点のコミットのコードを実行ごとのディレクトリに書き出して渡し、終わったら消す
    // （実装の作業領域は実装の変更を含むので使わない。差し戻しでやり直しても、同じ起点のコードを読む）
    const snapshotDir = scratch ? join(this.deps.workspaceRoot, "_snapshots", runId) : undefined;
    // PR の差分の全体を置く、sacty が管理するディレクトリ（写しの外。PBI-65）
    const reviewDiffDir =
      reviewTarget && snapshotDir ? join(this.deps.workspaceRoot, "_review", runId) : undefined;
    try {
      // 対象リポジトリの無いタスク（PBI-73）は、コードを書き出さない（空の作業領域）
      if (snapshotDir && !repoless) {
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
            // 切り詰めずに取る（プロンプトでは切り詰めるが、ファイルには全体を置く）
            reviewDiff = await this.deps.repos.diffCommits(
              gitDir,
              reviewTarget.baseCommit,
              reviewTarget.headCommit,
              { full: true },
            );
            // 読めなくてもレビューは止めない（読めなかったことをプロンプトに書く）
            // 運用する人のために、読めなかった理由はタスクと PR を添えてデーモンのログに残す（秘密の値は伏せる）
            if (latest.previousReview) {
              const replySecrets: string[] = [];
              reviewReplies = await this.reviewReplies(latest, reviewTarget, replySecrets).catch(
                (error: unknown) => {
                  console.warn(
                    `[daemon] レビューのタスク ${task.id} で、PR #${reviewTarget.number}（${reviewTarget.repo}）の作者の返答を読めませんでした。返答なしで再レビューします：${renderMessage(redactText(errorText(error), replySecrets), "ja")}`,
                  );
                  return "unreadable" as const;
                },
              );
            }
          }
          await this.deps.repos.snapshot(
            this.trustedGitDir(latest),
            reviewTarget?.headCommit ?? latest.repository?.baseCommit ?? "",
            snapshotDir,
          );
          // 差分の全体をファイルで置く。写しに .git は無いので、プロンプトで切り詰めた残りを worker が git で取れない。
          // 写しの中には書かない（PR 由来のシンボリックリンクをたどってホストのファイルを書き換えないため。PBI-65）
          if (reviewDiff !== undefined && reviewDiffDir) {
            mkdirSync(reviewDiffDir, { recursive: true });
            writeFileSync(join(reviewDiffDir, REVIEW_DIFF_FILE), reviewDiff);
          }
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
      // 工程のイメージ（PBI-41）。images から消した名前なら、実行せずに理由を示して止める
      const stepImage = resolveImage(config.config, runImageName);
      if (!stepImage.ok) {
        executed ??= {
          outcome: { kind: "failed", reason: "error", message: stepImage.message },
          costUsd: 0,
          estimated: false,
        };
      }
      // docker compose のサービス（PBI-47）。この工程で使うなら、実行の前に起動し、終わったら消す。起動するときは、その前に
      // エージェントのイメージを ID に確定させ、その ID で実行する（PBI-130）
      const workspaceDir = snapshotDir ?? ready.dir;
      const imageName = stepImage.ok ? stepImage.image : config.config.image;
      const services = executed
        ? undefined
        : await this.startServices(
            this.mustGet(task.id),
            step,
            runId,
            workspaceDir,
            false,
            imageName,
          );
      if (services && !services.ok) {
        executed = {
          outcome: { kind: "failed", reason: "error", message: services.message },
          costUsd: 0,
          estimated: false,
        };
      }
      const started = services?.ok ? services.started : undefined;
      executed ??= await this.execute({
        agent,
        taskId: task.id,
        image: (services?.ok && services.image) || imageName,
        ...(stepImage.ok ? { imageEnv: stepImage.env } : {}),
        ...(started ? serviceConnection(started) : {}),
        runId,
        prompt: [
          buildPrompt(this.mustGet(task.id), step, {
            ...(reviewDiff !== undefined
              ? {
                  diff: reviewDiff,
                  diffFile: `${CONTAINER_REVIEW_DIR}/${REVIEW_DIFF_FILE}`,
                }
              : {}),
            ...(reviewReplies !== undefined ? { replies: reviewReplies } : {}),
            // 修正の子タスクを追加するときは、これまでの子タスクを渡す（PBI-31）
            ...(step === "split" ? { subtasks: this.subtaskSummaries(task) } : {}),
            // 対象リポジトリの無いタスクを分けるときは、子タスクに付けられるリポジトリを渡す（PBI-73）
            ...(step === "split" && repoless ? { repositories: splitCandidates ?? [] } : {}),
          }),
          // 使える組織内 PF の API（PBI-35。プロジェクトのコンテキストの PF も。PBI-74）
          ...platformPromptLines(runPlatforms.platforms),
          // 起動したサービスの接続先（PBI-47）
          ...servicePromptLines(started?.services ?? []),
        ].join("\n"),
        platforms: runPlatforms.platforms,
        role: step,
        workspaceDir,
        // 差分の全体は、作業領域の外に読み取り専用でマウントする（PBI-65）
        ...(reviewDiff !== undefined && reviewDiffDir
          ? {
              mounts: [
                { hostPath: reviewDiffDir, containerPath: CONTAINER_REVIEW_DIR, readOnly: true },
              ],
            }
          : {}),
        context: context && { dir: context.dir, ...context.placed },
        ...(context && context.gatewayMcp.length > 0 ? { contextMcp: context.gatewayMcp } : {}),
        ...(context && context.tiers.length > 0 ? { estimateCost: true } : {}),
      });
    } finally {
      // サービスは、作業領域（ビルドの context）を消す前に止めて消す
      await this.stopServices(task, step, runId);
      context?.dispose();
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
      if (reviewDiffDir) rmSync(reviewDiffDir, { recursive: true, force: true });
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
      // 統合レビューの後に追加する修正の子タスクは、1件から作れる（PBI-31）
      const extractedPlan = extractSplitPlan(outcome.output, latest.split ? 1 : undefined);
      // 対象リポジトリの無いタスクは、子タスクごとのリポジトリがプロジェクトの対象にあるかを確かめる（PBI-73）。
      // 無い・対象に無いなら使わない（再開すると分割をやり直して、選び直す）
      const plan =
        extractedPlan.ok && repoless
          ? splitWithRepositories(extractedPlan, splitCandidates ?? [])
          : extractedPlan;
      const run = { runId, step, agentId: agent.id, costUsd, estimated, usage: outcome.usage };
      // 人間の差し戻しの指摘（統合レビューの承認待ちから。PBI-31）への対応
      const { responses } = extractBlocks(
        outcome.output,
        new Set(latest.remarks.filter((r) => r.step === step && !r.voided).map((r) => r.id)),
        [],
      );
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
            payload: { ...run, authMode: agent.auth.mode, output: outcome.output, responses },
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
                ...(repoless && c.repo ? { repo: c.repo } : {}),
                ...(repoless && c.repo && c.repoReason ? { repoReason: c.repoReason } : {}),
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
      // テストのコマンドの申告を読むのは、テストの仕組みが無いタスクの実装の工程だけ（PR #105 再レビュー指摘）
      { testCommand: step === "implement" && Boolean(latest.noTestsReason) },
    );
    const { responses, testViewpoints, proposal, testMap, testCommand } = extracted;
    // テストの仕組みが無いタスクで、テストのコマンドの申告の形が正しくなければ、申告が無いものとして進めない
    // （用意したテストを飛ばして通らないように）。止めて、再開すると実装をやり直す（PR #105 レビュー指摘）
    if (step === "implement" && latest.noTestsReason && extracted.testCommandInvalid) {
      const failure = message("implement.testCommandInvalid");
      this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId,
              step,
              agentId: agent.id,
              costUsd,
              estimated,
              usage: outcome.usage,
              reason: "error",
              message: failure,
            },
          },
        },
        {
          actor: "sacty",
          event: { type: "TaskPaused", payload: { reason: "error", message: failure } },
        },
      ]);
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }
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
            // 提出の前のセルフレビューの報告（PBI-120）。させた工程で報告が無い・読めなければ null（記録なし）
            ...((SELF_REVIEW_STEPS as readonly StepKey[]).includes(step)
              ? { selfReview: extracted.selfReview ?? null }
              : {}),
            // テストの仕組みが無いタスクで、実装がテストの仕組みを用意したときだけ、そのコマンドを使う（PBI-94）
            ...(step === "implement" && latest.noTestsReason && testCommand ? { testCommand } : {}),
            ...(review ? { reviewComments: review.comments } : {}),
            ...(review?.verdict ? { reviewVerdict: review.verdict } : {}),
            ...(reproduction ? { reproductionTests: reproduction.tests } : {}),
          },
        },
      },
    ];
    if (!proposal) {
      // 実行の完了と提出は、同じトランザクションで記録する
      const submitted = this.append(task, [...events, ...this.submitEvents(latest, step)]);
      // PR で承認する工程（PBI-57）は、続けて成果を PR にしてから承認待ちにする（予算は、その後に判定する）
      const stepPr = this.awaitingStepPullRequest(submitted);
      if (stepPr) {
        await this.publishStepPullRequest(submitted, stepPr);
        this.checkBudget(this.mustGet(task.id));
        return;
      }
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
    const settled = this.append(proposed, [
      { actor: "guardian", event: { type: "ChangeJudged", payload: judgement } },
      ...this.settleEvents(proposed, judged, accepted),
    ]);
    // PR で承認する工程（PBI-57）の提出は、成果を PR にしてから承認待ちにする
    const stepPr = this.awaitingStepPullRequest(settled);
    if (stepPr) await this.publishStepPullRequest(settled, stepPr);
    this.checkBudget(this.mustGet(task.id));
  }

  /**
   * エージェントに渡すコンテキスト（sacty の既定のコンテキストと、プロジェクトのコンテキストを合成したもの）。ホストで
   * 動かす MCP サーバーは、ゲートウェイの HTTP の MCP として加える（PBI-36）。どれも無ければ undefined。取得できなければ
   * 例外にする（呼ぶ側で、usedSecrets を取り除いてから理由を記録する）。
   */
  private async runContext(
    task: Task,
    agent: AgentConfig,
    config: SactyConfig,
    usedSecrets: string[],
    /** 渡す MCP サーバーを、この名前の1つに絞る（成果の書き出し。PBI-56）。 */
    onlyMcp?: string,
  ): Promise<RunContext | undefined> {
    const contextSource = this.deps.projects.get(task.projectId)?.context;
    const defaultContext = this.deps.defaultContext;
    const { hostMcp = [], gatewayOrigin, hostCommands } = this.mcpRouting(config);
    // 段階のサブエージェントの定義（PBI-119）。置くものがあれば、コンテキストが無くても設定のディレクトリに置く
    const tiers = this.tiersFor(agent, config);
    if (
      !contextSource &&
      !defaultContext &&
      hostMcp.length === 0 &&
      tiers.entries.length === 0 &&
      tiers.warnings.length === 0
    ) {
      return undefined;
    }
    // 使うホストの MCP サーバーの準備を待つ（PBI-77）。書き出しは、決めた接続先がそれなら、それだけを待つ
    const waitFor = hostMcp
      .map((m) => m.name)
      .filter((name) => onlyMcp === undefined || name === onlyMcp);
    // 待つ間に人間が止めたら、待たずに戻る（一時停止・中止を、準備の上限まで待たせない。コンテナは起動しない）
    const hostProblems =
      waitFor.length > 0 && this.deps.hostMcpReady
        ? await untilStopped(this.deps.hostMcpReady(waitFor), () => this.stopRequested(task.id), [])
        : [];
    // 書き出しは、その MCP サーバーしか使わないので、準備ができなければ書き出さない（理由を記録する）
    const [onlyProblem] = onlyMcp !== undefined ? hostProblems : [];
    if (onlyProblem) throw new MessageError(onlyProblem);
    // コンテキストと継承の各リポジトリも、HTTPS の GitHub はプロジェクトの gh のアカウントで取得する
    const runtime = agent.runtime === "codex" ? "codex" : "claude-code";
    const prepared: RunContext = {
      ...(await prepareContext(
        this.deps.contexts,
        contextSource,
        runtime,
        contextContainerDir(runtime),
        (repo) => this.gitAuth(task, repo, usedSecrets),
        defaultContext,
        hostMcp,
        gatewayOrigin,
        onlyMcp,
        hostCommands,
        tierFiles(runtime, tiers.entries),
      )),
      tiers: tiers.entries,
    };
    // 置かなかった段階（親と認証・接続先が違う）は、注意として記録する（PBI-119）
    prepared.warnings.push(...tiers.warnings);
    // 準備ができないホストの MCP サーバーは、どれかがわかるよう、コンテキストの注意として記録する（実行は止めない。
    // 起動し直して準備ができれば、実行の途中からでも使える）
    prepared.warnings.push(...hostProblems);
    // 層の command の MCP サーバーは、ホストで起動する（PBI-84）。このタスクのプロジェクトのものとして確保し（同じ
    // 中身なら、実行をまたいで使い回す）、層を写してから（取得した層は dispose で消える）、準備を待つ
    if (prepared.hostedMcp.length > 0 && this.deps.contextMcp) {
      const contextMcp = this.deps.contextMcp;
      let lease: ReturnType<typeof contextMcp.lease>;
      try {
        // ログ・理由に、どのプロジェクトのものかを出す（PBI-92）
        lease = contextMcp.lease(
          task.projectId,
          prepared.hostedMcp,
          this.deps.projects.get(task.projectId)?.name ?? task.projectId,
        );
      } catch (error) {
        // 確保できなければ（層の写しの失敗など。確保の途中までは巻き戻してある）、用意したコンテキストも消す
        // （PR #89 レビュー指摘）
        prepared.dispose();
        throw error;
      }
      const dispose = prepared.dispose;
      const leased = lease;
      prepared.dispose = () => {
        leased.release();
        dispose();
      };
      prepared.gatewayMcp.push(...lease.relays);
      let problems: DaemonMessage[];
      try {
        problems = await untilStopped(
          contextMcp.ready(lease.keys),
          () => this.stopRequested(task.id),
          [],
        );
      } catch (error) {
        prepared.dispose();
        throw error;
      }
      const [problem] = onlyMcp !== undefined ? problems : [];
      if (problem) {
        prepared.dispose();
        throw new MessageError(problem);
      }
      prepared.warnings.push(...problems);
    }
    return prepared;
  }

  /**
   * 実行のときの MCP サーバーの渡し方（ホストの MCP サーバーと、ゲートウェイの起点）。ゲートウェイが無ければ、ホストの
   * MCP サーバーは渡せず、層の HTTP の MCP サーバーはコンテナから直接つなぐ。実行（runContext）とプレビュー（PBI-76）で
   * 同じものを使う。
   */
  private mcpRouting(config: Pick<SactyConfig, "hostMcp"> | undefined): McpRouting {
    const gatewayForMcp = this.deps.gateway;
    if (!gatewayForMcp) return {};
    const origin = gatewayForMcp.containerOrigin();
    return {
      hostMcp: (config?.hostMcp ?? []).map((m) => ({
        name: m.name,
        url: `${origin}/mcp/${m.name}`,
        // エージェントに渡す時間切れ（PBI-75）
        ...(m.startupTimeoutSec !== undefined ? { startup_timeout_sec: m.startupTimeoutSec } : {}),
        ...(m.toolTimeoutSec !== undefined ? { tool_timeout_sec: m.toolTimeoutSec } : {}),
      })),
      // 層の HTTP の MCP サーバーは、ゲートウェイ経由にする（PBI-49）
      gatewayOrigin: origin,
      // 層の command の MCP サーバーは、ホストで起動してゲートウェイ経由にする（PBI-84）
      hostCommands: Boolean(this.deps.contextMcp),
    };
  }

  /** 依頼された外部操作を一度だけ開始する。停止未確認の実行と作業領域は中止で確認するまで残す。 */
  private async executeOperation(task: Task, config: SactyConfig): Promise<void> {
    const step = "operation" as const;
    const pause = (detail: DaemonText) =>
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: detail },
          },
        },
      ]);
    if (task.operationAttempted) {
      pause(message("operation.attempted"));
      return;
    }
    const parsedOperation = OperationSettings.safeParse(task.operation);
    if (!parsedOperation.success) {
      pause(message("operation.incomplete"));
      return;
    }
    const operation = parsedOperation.data;
    const available = await this.exportDestinations(task, config);
    if (!available.destinations.some((d) => d.via === operation.via && d.name === operation.name)) {
      pause(message("operation.connectionMissing"));
      return;
    }
    // 接続先を調べている間に人が選び直していれば、それで決める（消えた名前から選び直したのに、古い名前で止めない。
    // PR #131 再レビュー指摘）
    const chosenName = this.mustGet(task.id).agents?.[step];
    const chosen = stepAgentFor(config, step, chosenName);
    if (!chosen.ok) {
      // 接続先を調べている間に選び直した名前が、この実行が読んだ設定に無い（その間に config.yaml に足した）なら、止めずに
      // 実行待ちのまま戻し、次の実行で最新の設定から決め直す（PR #131 再々レビュー指摘）
      if (chosenName !== task.agents?.[step]) return;
      pause(message("agent.chosenMissing", { step, name: chosen.missing }));
      return;
    }
    const agent = chosen.agent;
    const image = resolveImage(config, task.images?.[step]);
    if (!image.ok) {
      pause(image.message);
      return;
    }
    const usedSecrets: string[] = [];
    let context: RunContext | undefined;
    let platform: Platform | undefined;
    const runId = randomUUID();
    const workspaceDir = join(this.deps.workspaceRoot, task.id, "operation", runId);
    let attempted = false;
    let preserveWorkspace = false;
    const stoppedInfo = async () => {
      let runs: string[];
      try {
        runs = await this.unstopped([runId]);
      } catch {
        runs = [runId];
      }
      preserveWorkspace = runs.length > 0;
      return this.unstoppedPayload(runs);
    };
    try {
      if (operation.via === "mcp") {
        context = await this.runContext(task, agent, config, usedSecrets, operation.name);
        if (!context?.placed.mcpServers.includes(operation.name))
          throw new MessageError(message("operation.connectionMissing"));
        // 用意したコンテキスト（層・注意・置いた段階）を、この実行の記録として残す（PBI-119）
        this.append(this.mustGet(task.id), [
          this.contextResolved(runId, context, { platforms: [], warnings: [] }),
        ]);
      } else {
        platform = await this.findPlatform(task, config, operation.name, usedSecrets);
        if (!platform) throw new MessageError(message("operation.connectionMissing"));
      }
      const latest = this.mustGet(task.id);
      if (latest.status !== "queued" || this.stopRequested(task.id)) return;
      // 準備（接続先・コンテキストの用意）の間に人がエージェントを変えたなら、古いエージェントでは始めない。実行待ちのまま
      // 戻し、次の実行で新しいエージェントで準備し直す（PR #131 レビュー指摘）
      if (latest.agents?.[step] !== chosenName) return;
      mkdirSync(workspaceDir, { recursive: true });
      // 実行前に永続化する。結果が失われても再送しない。
      this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: { runId, step, agentId: agent.id, ...agentSetting(agent) },
          },
        },
      ]);
      attempted = true;
      const { outcome, costUsd, estimated } = await this.execute({
        agent,
        taskId: task.id,
        runId,
        role: step,
        image: image.image,
        imageEnv: image.env,
        workspaceDir,
        prompt: [
          buildPrompt(latest, step),
          ...platformPromptLines(platform ? [platform] : []),
        ].join("\n"),
        ...(platform ? { platforms: [platform] } : {}),
        ...(context
          ? {
              context: { dir: context.dir, ...context.placed },
              contextMcp: context.gatewayMcp,
              ...(context.tiers.length > 0 ? { estimateCost: true } : {}),
            }
          : {}),
      });
      const stopped = await stoppedInfo();
      const current = this.mustGet(task.id);
      const success =
        !preserveWorkspace &&
        outcome.kind !== "failed" &&
        operationSucceeded(outcome.output) &&
        !this.stopRequested(task.id);
      const events: ActivityItem[] = [
        {
          actor: "agent",
          event:
            outcome.kind === "failed"
              ? {
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
                }
              : {
                  type: "AgentRunCompleted",
                  payload: {
                    runId,
                    step,
                    agentId: agent.id,
                    authMode: agent.auth.mode,
                    output: outcome.output,
                    responses: [],
                    usage: outcome.usage,
                    costUsd,
                    estimated,
                  },
                },
        },
      ];
      if (success) events.push(...this.submitEvents(current, step));
      else
        events.push({
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: this.stopReason(task.id, "error"),
              message: message("operation.unconfirmed"),
              ...stopped,
            },
          },
        });
      this.checkBudget(this.append(current, events));
    } catch (error) {
      const latest = this.mustGet(task.id);
      const detail = redactText(errorText(error), usedSecrets);
      const stopped = attempted ? await stoppedInfo() : {};
      if (latest.currentRunId === runId)
        this.append(latest, [
          {
            actor: "sacty",
            event: {
              type: "AgentRunFailed",
              payload: { runId, step, agentId: agent.id, reason: "error", message: detail },
            },
          },
        ]);
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: this.stopReason(task.id, "error"), message: detail, ...stopped },
          },
        },
      ]);
    } finally {
      context?.dispose();
      if (!preserveWorkspace) rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  /**
   * 人間が承認した成果を、オーケストレーターが決めた書き出し先に、工程のエージェントで書き出す（PBI-56）。ゲートウェイの
   * 接続先は実行ごとのトークンを含む URL（SACTY_PF_URL）で、MCP サーバーはコンテキストの MCP・ホストの MCP として渡す
   * （どちらも認証はコンテナに渡さない）。前に書き出した先があれば、そのページを更新させる（新しく作らない）。
   * 書き出せなければ理由を記録して、いまの仕様（sacty の中に残す・取り込み元へのコメント）のまま進める（タスクは
   * 止めない。画面から書き出し直せる）。費用はタスクの予算に入れる。
   */
  private async exportOutput(task: Task, step: StepKey): Promise<void> {
    const to = task.exportPlans?.[step]?.to;
    const approved = task.approved[step];
    const loaded = this.deps.config();
    // 設定の問題は status() で画面に出す。書き出しは待ったままにする
    if (!to || !approved || !loaded.ok) return;
    const config = loaded.config;
    // 書き出しは、その工程のエージェント（人が選んだもの。無ければ step_agents か default_agent。PBI-121）で行う
    const chosen = stepAgentFor(config, step, task.agents?.[step]);
    const agent = chosen.ok ? chosen.agent : agentFor(config, step);
    const runId = randomUUID();
    const previous = task.exports[step];
    const base = {
      step,
      runId,
      approvedAt: approved.at,
      submission: approved.submission,
      via: to.via,
      name: to.name,
      agentId: agent.id,
      ...agentSetting(agent),
    };
    type Payload = Extract<EventInput, { type: "OutputExported" }>["payload"];
    const record = (actor: Actor, payload: Payload) => {
      const latest = this.tasks.get(task.id);
      if (!latest || latest.status === "cancelled") return;
      this.append(latest, [{ actor, event: { type: "OutputExported", payload } }]);
      // 予算の通知は記録するが、タスクは止めない（次の工程の実行の前に、予算で止まる）
      this.warnIfNeeded(this.mustGet(task.id));
    };
    const fail = (failed: DaemonText) =>
      record("sacty", { ...base, failed, runResult: "failed", costUsd: 0, estimated: false });
    if (budgetState(task.budget) === "exceeded") return fail(message("export.budgetExceeded"));
    // 人が選んだエージェントが config.yaml から消えていれば、既定に戻さず、書き出せなかった理由にする（PBI-121）
    if (!chosen.ok) return fail(message("agent.chosenMissing", { step, name: chosen.missing }));
    const usedSecrets: string[] = [];
    let platform: Platform | undefined;
    if (to.via === "platform") {
      // ホストの PF か、プロジェクトのコンテキストの PF（PBI-74）
      try {
        platform = await this.findPlatform(task, config, to.name, usedSecrets);
      } catch (error) {
        return fail(
          message("export.failed", { detail: redactText(errorText(error), usedSecrets) }),
        );
      }
      if (!platform) return fail(message("export.destinationMissing", { name: to.name }));
    }
    let context: RunContext | undefined;
    if (to.via === "mcp") {
      try {
        // 決めた接続先の MCP サーバーだけを渡す（ほかの MCP サーバーは使わせず、その認証も取り出さない）
        context = await this.runContext(task, agent, config, usedSecrets, to.name);
      } catch (error) {
        return fail(
          message("export.failed", { detail: redactText(errorText(error), usedSecrets) }),
        );
      }
      if (!context?.placed.mcpServers.includes(to.name)) {
        context?.dispose();
        return fail(message("export.destinationMissing", { name: to.name }));
      }
    }
    const workspaceDir = join(this.deps.workspaceRoot, "_export", runId);
    let executed: Executed;
    try {
      // 書き出す内容は、作業領域のファイルで渡す（指示の長さの上限に関わらず、全文を渡すため）
      try {
        mkdirSync(workspaceDir, { recursive: true });
        writeFileSync(join(workspaceDir, EXPORT_FILE), buildExportDocument(task, step));
      } catch (error) {
        return fail(message("export.failed", { detail: errorText(error) }));
      }
      // 準備の間に人間が止めた・中止した・承認が取り消されたなら、始めない（再開・承認し直すと書き出す）。エージェントを
      // 変えたなら、古いエージェントでは始めず、次の実行で新しいエージェントで書き出す（PR #131 レビュー指摘）
      const latest = this.mustGet(task.id);
      if (
        this.pauseRequested.has(task.id) ||
        this.cancelling.has(task.id) ||
        latest.approved[step]?.at !== approved.at ||
        latest.agents?.[step] !== task.agents?.[step]
      ) {
        return;
      }
      // 用意したコンテキスト（層・注意・置いた段階）も、この実行の記録として残す（PBI-119）。finally で消す範囲の中で
      // 記録する（記録に失敗しても、用意したディレクトリとホストの MCP サーバーの確保を残さない。PR #129 再レビュー指摘）
      this.append(latest, [
        ...(context ? [this.contextResolved(runId, context, { platforms: [], warnings: [] })] : []),
        {
          actor: "sacty",
          event: { type: "ExportStarted", payload: { step, runId, approvedAt: approved.at } },
        },
      ]);
      executed = await this.execute({
        agent,
        taskId: task.id,
        image: config.image,
        runId,
        prompt: [
          buildExportPrompt(task, step, {
            via: to.via,
            name: to.name,
            description:
              platform?.description ??
              config.hostMcp.find((m) => m.name === to.name)?.description ??
              "",
            location: to.location,
            ...(previous?.url ? { previousUrl: previous.url } : {}),
            interrupted: previous?.started !== undefined,
          }),
          // 使わせるのは、決めた接続先の API だけ（PBI-35）
          ...(platform ? platformPromptLines([platform]) : []),
        ].join("\n"),
        role: "export",
        workspaceDir,
        ...(platform ? { platforms: [platform] } : {}),
        ...(context ? { context: { dir: context.dir, ...context.placed } } : {}),
        ...(context && context.gatewayMcp.length > 0 ? { contextMcp: context.gatewayMcp } : {}),
        ...(context && context.tiers.length > 0 ? { estimateCost: true } : {}),
      });
    } finally {
      context?.dispose();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = executed;
    const cost = { ...(outcome.usage ? { usage: outcome.usage } : {}), costUsd, estimated };
    // 人間が止めた・中止したなら、書き出せたかが分からない。費用だけを記録し、再開すると目印で探して続ける
    if (this.pauseRequested.has(task.id) || this.cancelling.has(task.id)) {
      return record("sacty", {
        ...base,
        ...cost,
        failed: message("export.stopped"),
        runResult: "interrupted",
      });
    }
    if (outcome.kind === "failed") {
      return record("agent", {
        ...base,
        ...cost,
        failed: message("export.failed", { detail: outcome.message }),
        runResult: "failed",
      });
    }
    // 秘密情報は、execute が出力の全文から取り除いている（理由を切り詰めるのは、その後）
    const result = extractExport(outcome.output);
    if (result && "url" in result) {
      return record("agent", { ...base, ...cost, url: result.url, runResult: "completed" });
    }
    return record("agent", {
      ...base,
      ...cost,
      failed: result
        ? message("export.failed", { detail: result.error })
        : message("export.unreadable"),
      runResult: "completed",
    });
  }

  /** 書き出せなかった承認済みの成果を、画面から書き出し直す（PBI-56）。 */
  retryExport(id: string, raw: unknown): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    const step = StepKey.safeParse(raw);
    if (!step.success || !canRetryExport(task, step.data) || this.cancelling.has(id)) {
      throw new InvalidOperationError(message("export.notRetryable"));
    }
    return this.append(task, [
      { actor: "person", event: { type: "ExportRequested", payload: { step: step.data } } },
    ]);
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
    // テストの仕組みが無いタスク（PBI-94）は、実装が用意して申告したテストのコマンドがあれば、それで検証する
    const testCommand =
      repo.testCommand ?? (task.noTestsReason ? task.addedTestCommand : undefined);
    // テストのイメージが images から消えていれば、テストを実行せずに理由を示して止める（PBI-41）
    const testImage = resolveImage(config.config, task.images?.implement ?? task.images?.reproduce);
    // テストを飛ばすタスク（PBI-94）は、テストのイメージを使わない
    if (!testImage.ok && (testCommand || !task.noTestsReason)) {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: message("verify.testsUnavailable", { detail: testImage.message }),
            },
          },
        },
      ]);
      return;
    }
    // テストのコマンドはオーケストレーターが決める（PBI-25）。分からなければ検証できないので止める。
    // テストの仕組みが無いタスク（PBI-94）は、止めずにテストを飛ばし、最終レビューで目的から判定する
    if (!testCommand && !task.noTestsReason) {
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
    const viewpointIds = finalReviewViewpointIds(task);

    let current = task;
    if (current.verification === "pending" && !testCommand) {
      current = this.append(current, [
        { actor: "sacty", event: { type: "TestsSkipped", payload: {} } },
      ]);
    }
    if (current.verification === "pending" && testCommand) {
      const mapped = new Set(current.testMap.map((m) => m.viewpointId));
      const unmappedViewpoints = viewpointIds.filter((id) => !mapped.has(id));
      // 人間が止めたなら、テストのコンテナを起動しない（再開するとテストからやり直す）
      if (this.pauseRequested.has(task.id)) return;
      const testRunId = randomUUID();
      this.track(testRunId);
      const ran = await this.runTests(current, "implement", {
        runId: testRunId,
        image: repo.testImage,
        ...(Object.keys(repo.testEnv).length > 0 ? { env: repo.testEnv } : {}),
        workspaceDir: dir,
        command: testCommand,
      });
      // 人間が止めたなら、記録しない（止めた記録は runNext の後始末で行う。再開するとテストからやり直す）
      if (this.pauseRequested.has(task.id)) return;
      // テストに使うサービスを起動できなければ、テストを実行せずに止める（再開するとテストからやり直す。PBI-47）
      if (!ran.ok) {
        this.append(this.mustGet(task.id), [
          {
            actor: "sacty",
            event: {
              type: "TaskPaused",
              payload: {
                reason: "error",
                message: message("verify.testsUnavailable", { detail: ran.message }),
              },
            },
          },
        ]);
        return;
      }
      const result = ran.result;
      // テストの仕組みが無いタスク（PBI-94）は、観点にテストが対応していないことでは不合格にしない
      const passed =
        result.exitCode === 0 && (unmappedViewpoints.length === 0 || Boolean(task.noTestsReason));
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
    // 最終レビューは、実装後のコードを使い捨ての写しで読ませる（差分もこれまでどおり渡す）
    const { outcome, costUsd, estimated, runId } = await this.runGuardian(
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
              ...agentSetting(agent),
              runId,
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
          payload: {
            ...review,
            agentId: agent.id,
            ...agentSetting(agent),
            runId,
            usage: outcome.usage,
            costUsd,
            estimated,
          },
        },
      },
    ]);
    if (review.passed) this.checkBudget(reviewed);
    else this.pauseIfVerificationKeepsFailing(reviewed);
  }

  /**
   * オーケストレーターの「テストの仕組みが無い」という判断（PBI-94）を確かめる。判断が無い・テストのコマンドがある・
   * 実装を含まない組み合わせなら確かめない。不具合の修正を選んだ（再現はテストで確かめる）・起点のコードにテストのファイルが
   * 見つかった・確かめきれなかったなら、止める理由を返す（黙ってテストなしで通さないための歯止め）。
   */
  private checkNoTests(task: Task, chosen: ChosenSteps): { stop?: DaemonText } {
    const reason = chosen.noTestsReason;
    if (!reason || chosen.testCommand || !chosen.steps.includes("implement")) return {};
    if (chosen.steps.includes("reproduce")) {
      return { stop: message("orchestrator.bugfixNeedsTests", { reason }) };
    }
    // 工程を選ぶ前なので、作業領域は起点のコードのまま
    const stop = noTestsStop(reason, findTestFiles(this.repoDir(task)));
    return stop ? { stop } : {};
  }

  /** タスクの対象リポジトリ（リポジトリの URL）。PR を作るリポジトリ。 */
  private taskRepo(task: Task): string | undefined {
    return task.source
      ? task.source.repo
      : (task.repo ?? (task.repository && githubRepoOf(task.repository.url)));
  }

  /**
   * 要求要件・設計を、対象のリポジトリへの PR のマージで承認するタスクか（PBI-57）。タスクブランチを作ったタスクは、
   * 最後まで PR で承認する。まだ作っていなければ、対象のリポジトリがあり、プロジェクトでそのホストの gh のアカウントを
   * 選んでいて（PR を作れる）、これまでの流れ（画面）で要求要件・設計を提出していないタスクだけ。要求要件・設計の
   * 工程でだけ判断するので、調査だけ・レビューだけ・不具合の修正のように、要求要件・設計の無いタスクは PR を作らない。
   */
  private stepPullRequestsOn(task: Task): boolean {
    if (task.taskBranch) return true;
    if (this.deps.stepPullRequests === false || !task.repository) return false;
    if (task.submissions.requirements || task.submissions.design) return false;
    const repo = this.taskRepo(task);
    return Boolean(repo && this.githubAccountOf(task, repo).account);
  }

  /**
   * 要求要件・設計の成果を、タスクブランチへの PR にするのを待っている工程（PBI-57）。工程の実行が終わり（成果があり）、
   * まだ提出していない（承認待ちになっていない）とき。PR で承認するタスクでなくなっていたら（タスクブランチを作る前に
   * アカウントの設定を外したなど）、PR を作らずに提出する（publishStepPullRequest）。
   */
  private awaitingStepPullRequest(task: Task): StepPullRequestKey | undefined {
    if (task.status !== "idle" || task.gate) return undefined;
    const step = activeStep(task);
    if (!step || !isStepPullRequestKey(step) || task.outputs[step] === undefined) return undefined;
    if (openProposal(task)) return undefined;
    return step;
  }

  /** 工程を承認した後の状態（次の工程を実行できるなら実行待ち、まだ実装されていなければ待機）。 */
  private nextAfterApproval(task: Task, step: StepKey): "queued" | "idle" {
    const index = task.steps.findIndex((s) => s.key === step);
    const nextStep = task.steps[index + 1]?.key;
    return nextStep && EXECUTABLE_STEPS.includes(nextStep) ? "queued" : "idle";
  }

  /** 工程の最新の成果ができた時刻（PR のコミットの日時。再開しても同じコミットを作り直すため。PBI-57）。 */
  private outputAt(task: Task, step: StepKey): string {
    const events = this.deps.activity.forTask(task.id);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === "AgentRunCompleted" && event.payload.step === step) return event.at;
      if (
        event?.type === "ChangeApplied" &&
        task.proposals.find((p) => p.id === event.payload.proposalId)?.target === step
      ) {
        return event.at;
      }
    }
    return task.updatedAt;
  }

  /**
   * 要求要件・設計の成果を、ファイルにしてタスクブランチへの PR にし、その工程の承認待ちにする（PBI-57）。
   * - タスクブランチが無ければ、ベースブランチの起点のコミットから作る
   * - その工程の PR が開いていて、タスクブランチの先頭が変わっていなければ、同じ PR を更新する（その工程のやり直し）
   * - マージ済み・閉じられた、または前の工程の直しがマージされてタスクブランチが進んだなら、タスクブランチの最新から
   *   新しいブランチと PR を作る（開いていた前の PR は閉じる）
   * PR を作れなければ、理由を記録して止める（再開すると、ここからやり直す）。
   */
  private async publishStepPullRequest(task: Task, step: StepPullRequestKey): Promise<void> {
    // PR で承認するタスクでなければ、これまでどおり画面での承認待ちにする
    if (!this.stepPullRequestsOn(task)) {
      this.append(task, this.submitEvents(task, step));
      return;
    }
    const loaded = this.deps.config();
    if (!loaded.ok || this.cancelling.has(task.id) || this.pauseRequested.has(task.id)) return;
    const usedSecrets: string[] = [];
    const fail = (text: DaemonText) => {
      const latest = this.tasks.get(task.id);
      if (latest?.status !== "idle") return;
      this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: redactText(text, usedSecrets) },
          },
        },
      ]);
    };
    const repo = this.taskRepo(task);
    if (!repo) {
      fail(message("pr.unavailable", { detail: message("run.repositoryNotConfigured") }));
      return;
    }
    // 退避した git のメタデータが無ければ、同じ起点で用意し直す
    const ready = await this.prepareRepository(task, loaded.config);
    if (!ready.ok) {
      fail(message("pr.failed", { detail: ready.message }));
      return;
    }
    let current = this.mustGet(task.id);
    const repository = current.repository;
    if (!repository) {
      fail(message("pr.workspaceMissing"));
      return;
    }
    const gitDir = this.trustedGitDir(current);
    try {
      const authEnv = await this.gitAuth(current, repository.url, usedSecrets);
      const token = await this.githubToken(current, repo, usedSecrets);
      // タスクブランチは、ベースブランチの起点のコミットから作る（作ったら、中止で消せるように記録する）
      if (!current.taskBranch) {
        const branch = taskBranchName(current);
        await this.deps.repos.pushCommit(gitDir, repository.baseCommit, branch, authEnv);
        current = this.append(this.mustGet(task.id), [
          {
            actor: "sacty",
            event: {
              type: "TaskBranchCreated",
              payload: { branch, commit: repository.baseCommit },
            },
          },
        ]);
      }
      const taskBranch = current.taskBranch;
      if (!taskBranch) return;
      const head = await this.deps.repos.fetchBranch(gitDir, taskBranch.branch, authEnv);
      // 同じ PR を更新するか（開いていて、タスクブランチが進んでいない）、作り直すか
      const last = latestStepPullRequest(current, step);
      let reuse: typeof last;
      let supersede: number | undefined;
      // 前回の作り直しで閉じた後、記録の前に止まっていた（もう閉じている）なら、閉じたものとして記録する
      let superseded: number | undefined;
      if (last && !last.superseded && last.state === "open") {
        const status = await this.deps.pulls.status({
          repo: last.repo,
          token,
          number: last.number,
        });
        if (status.state === "open") {
          if (last.base === head) reuse = last;
          else supersede = last.number;
        } else if (status.state === "closed") {
          superseded = last.number;
        }
      }
      const attempt = current.stepPullRequests.filter((p) => p.step === step).length + 1;
      const branch = reuse?.branch ?? `${taskBranch.branch}-${step}-${attempt}`;
      const path = stepDocumentPath(current, step);
      // 同じ PR を更新するときは、その PR のブランチの最新に積む（人がレビューの提案をコミットしていても、
      // 強制プッシュせずに積めるように）
      const parent = reuse
        ? await this.deps.repos.fetchBranch(gitDir, reuse.branch, authEnv)
        : head;
      const { commit } = await this.deps.repos.commitFiles({
        gitDir,
        parent,
        files: { [path]: buildStepDocument(current, step) },
        branch,
        message: `${buildStepPullRequestTitle(current, step)}\n\nsacty task ${current.id}`,
        date: this.outputAt(current, step),
        // 新しい PR には、内容が同じでもコミットが要る（差分のコミットが無いと PR を作れない）
        allowEmpty: !reuse,
        authEnv,
      });
      // PR の作成の前に、プッシュしたブランチを記録する（PR の作成に失敗しても、中止で消せるように）
      if (!this.mustGet(task.id).stepBranches.includes(branch)) {
        current = this.append(this.mustGet(task.id), [
          {
            actor: "sacty",
            event: { type: "StepBranchPushed", payload: { step, branch, commit } },
          },
        ]);
      }
      // 作り直すときは、開いていた前の PR を閉じる（マージされないように。閉じられなければ、中止のときに閉じる）
      if (supersede !== undefined && last) {
        try {
          await this.deps.pulls.close({ repo: last.repo, token, number: supersede });
          superseded = supersede;
        } catch (error) {
          console.warn(
            `[daemon] 前の PR #${supersede}（${last.repo}）を閉じられませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
          );
        }
      }
      const { body, template } = await this.pullRequestBody(
        repo,
        token,
        usedSecrets,
        buildStepPullRequestBodyText(current, step, path),
        buildStepPullRequestBodyParts(current, step, path),
      );
      const pr = await this.deps.pulls.upsert({
        repo,
        token,
        branch,
        baseBranch: taskBranch.branch,
        title: buildStepPullRequestTitle(current, step),
        body,
        ...(reuse ? { number: reuse.number } : {}),
      });
      // 作った PR は、中止・一時停止を求められていても記録する（中止の後片付けで閉じるため）
      const latest = this.mustGet(task.id);
      if (this.awaitingStepPullRequest(latest) !== step) return;
      const submitted = this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "StepPullRequestPublished",
            payload: {
              step,
              branch,
              commit,
              template,
              base: reuse?.base ?? head,
              path,
              url: pr.url,
              number: pr.number,
              repo,
              ...(superseded !== undefined ? { supersedes: superseded } : {}),
              // レビュー用のラベルを付ける予定（公開と同じ記録に残し、止まっても再開で付ける。PBI-88・PBI-99）
              ...this.labelDue(latest, repo, pr.number),
            },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "StepSubmitted",
            payload: { step, submission: (latest.submissions[step] ?? 0) + 1 },
          },
        },
      ]);
      this.warnIfNeeded(submitted);
      // レビュー用のラベルを付ける（同じ PR を更新したときは、もう付けない。PBI-88・PBI-99）
      await this.labelPullRequest(task.id, repo, pr.number, token, usedSecrets);
    } catch (error) {
      fail(message("pr.failed", { detail: errorText(error) }));
    }
  }

  /**
   * PR の本文（PBI-87）。PR を作るリポジトリ（無ければ Org の .github リポジトリ）に PR テンプレートがあれば、その
   * 見出し・項目の形に沿って sacty の内容で埋める。無い・読めない・使えないときは、sacty の決まった形の本文にする
   * （PR の作成は止めない）。どちらにしたかを template として返す（台帳に残す）。本文は長さの上限に収め、
   * 使った秘密の値を伏せる。
   */
  private async pullRequestBody(
    repo: string,
    token: string,
    usedSecrets: readonly string[],
    fallback: BodyText,
    parts: BodyParts,
  ): Promise<{ body: string; template: PullRequestTemplateUse }> {
    let template: PullRequestTemplateUse;
    // テンプレートが無い・使えないときも、省けない部分（タスクの ID・Closes・承認の案内）を分けて持つ（PR #99 レビュー指摘）
    let text = fallback;
    try {
      const found: TemplateLookup = this.deps.templates
        ? await this.deps.templates.find({ repo, token })
        : { kind: "none" };
      if (found.kind === "found") {
        text = fillTemplate(found.template.text, parts);
        template = { repo: found.template.repo, path: found.template.path };
      } else if (found.kind === "unusable") {
        template = {
          fallback: "unusable",
          message: redactText(found.message, usedSecrets),
        };
      } else {
        template = {
          fallback: "none",
          ...(found.message ? { message: redactText(found.message, usedSecrets) } : {}),
        };
      }
    } catch (error) {
      // テンプレートの処理の失敗でも、PR の作成は止めない（sacty の決まった形の本文にする）
      text = fallback;
      template = { fallback: "unusable", message: redactText(errorText(error), usedSecrets) };
    }
    const limited = limitBody(
      redact(text.main, usedSecrets),
      redact(text.footer, usedSecrets),
      PR_BODY_MAX,
      text.keep.map((k) => redact(k, usedSecrets)),
    );
    return {
      body: limited.body,
      template: { ...template, ...(limited.truncated ? { truncated: true } : {}) },
    };
  }

  /**
   * 検証に通った実装を、実装の工程の中でコミットして sacty のブランチにプッシュし、PRを作って、
   * 実装の承認待ちで止める（PBI-110）。コミットは、エージェントが触れない退避した git の
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
    // タスクブランチのあるタスク（PBI-57）は、タスクブランチに実装を積み、タスクブランチからベースブランチへの PR にする
    const taskBranch = task.taskBranch;
    const branch = taskBranch?.branch ?? task.pullRequest?.branch ?? taskBranchName(task);
    // 一時停止・中止を求められていれば、プッシュも PR の作成もしない（一時停止は、PR の作成の待ちのまま止める。再開すると作る）
    if (this.stopRequested(task.id)) return;
    try {
      const authEnv = await this.gitAuth(task, task.repository.url, usedSecrets);
      let parent = task.pullRequest?.commit ?? task.repository.baseCommit;
      let keep: { commit: string; paths: string[] } | undefined;
      if (taskBranch) {
        // タスクブランチの最新（マージした要求要件・設計の PR を含む）に積む。要求要件・設計のファイルは実装の作業領域に
        // 無いので、タスクブランチのものを引き継ぐ
        parent = await this.deps.repos.fetchBranch(gitDir, taskBranch.branch, authEnv);
        const paths = [...new Set(task.stepPullRequests.map((p) => p.path))];
        if (paths.length > 0) keep = { commit: parent, paths };
        // 実装の作業領域は起点のコミットのままなので、sacty が最後に積んだコミット（無ければ起点）の後にタスクブランチへ
        // 積まれた変更（人が直接積んだ・ベースブランチをマージした）は、実装のコミットで消えてしまう。要求要件・設計の
        // ファイルのほかに変更があれば、消さないように公開を止める（人が判断する）
        const known =
          task.pushedBranch?.branch === taskBranch.branch
            ? task.pushedBranch.commit
            : task.repository.baseCommit;
        if (known !== parent) {
          const unexpected = (await this.deps.repos.changedPaths(gitDir, known, parent)).filter(
            (p) => !paths.includes(p),
          );
          if (unexpected.length > 0) {
            fail(
              message("pr.taskBranchChanged", {
                branch: taskBranch.branch,
                paths: unexpected.slice(0, 10).join(", "),
                count: unexpected.length,
              }),
            );
            return;
          }
        }
      }
      const { commit } = await this.deps.repos.publish({
        dir,
        gitDir,
        baseCommit: task.repository.baseCommit,
        parent,
        branch,
        message: `${task.title}\n\nsacty task ${task.id}`,
        // 提出ごとに決まる日時にして、再開しても同じコミットを作る（プッシュ済みなら何も変わらない）
        // （PR は最終レビューに通った後に作るので、通常は最終レビューの日時になる）
        date: task.lastReview?.at ?? task.createdAt,
        authEnv,
        ...(keep ? { keep } : {}),
      });
      // PRの作成の前に、プッシュしたブランチを記録する（PRの作成に失敗しても、中止で片付けられるように）
      if (task.pushedBranch?.commit !== commit || task.pushedBranch.branch !== branch) {
        this.append(task, [
          { actor: "sacty", event: { type: "BranchPushed", payload: { branch, commit } } },
        ]);
      }
      // PR は常に作る（PR を作るかの設定は無い。PBI-25）
      const prRepo = repo.pullRequest.repo;
      const token = await this.githubToken(task, prRepo, usedSecrets);
      // 前の PR がすでにマージされていれば、作り直した内容は新しい PR で出す
      // （マージ済みの PR を更新しても、マージされていない内容が完了扱いになってしまうため）
      let number = task.pullRequest?.number;
      if (number && task.pullRequest?.repo === prRepo) {
        const previous = await this.deps.pulls.status({ repo: prRepo, token, number });
        if (previous.state === "merged") number = undefined;
      }
      const { body, template } = await this.pullRequestBody(
        prRepo,
        token,
        usedSecrets,
        buildPullRequestBodyText(task),
        buildPullRequestBodyParts(task),
      );
      // PR を作る直前にも確かめる（プッシュしたブランチは記録済みなので、中止で片付けられる）。PR を作り始めたら、作り終えて
      // 実装の承認待ちにする（作った PR を記録しないまま止めると、再開で PR を二重に作りうるため）。そのときの一時停止は、
      // 承認待ちになったので止めなかったと返す（pause の pause.reachedApproval）
      if (this.stopRequested(task.id)) return;
      const pr = await this.deps.pulls.upsert({
        repo: prRepo,
        token,
        branch,
        baseBranch: task.repository.baseBranch,
        title: task.title,
        body,
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
              template,
              url: pr.url,
              number: pr.number,
              repo: prRepo,
              // レビュー用のラベルを付ける予定（公開と同じ記録に残し、止まっても再開で付ける。PBI-88・PBI-99）
              ...this.labelDue(task, prRepo, pr.number),
            },
          },
        },
        this.implementSubmitted(task),
      ]);
      this.checkBudget(submitted);
      // レビュー用のラベルを付ける（失敗しても PR の作成は失敗にしない。PBI-88・PBI-99）
      await this.labelPullRequest(task.id, prRepo, pr.number, token, usedSecrets);
    } catch (error) {
      // 実装が起点から何も変えていなかった（PBI-90）。まだ PR を作っていなければ、PR を作らずに実装の承認で人間に
      // 確かめてもらう（実装の説明に、変更が要らない理由がある。承認すれば変更なしで完了、差し戻せば実装をやり直す）。
      // タスクブランチ（PBI-57）は、ベースブランチへの PR を作らないまま残る。作った PR の作り直しで変更が無くなったときは、
      // 今までどおり止める（開いている PR をどうするかは人が決める）
      if (error instanceof NothingToCommitError && !task.pullRequest) {
        const submitted = this.append(task, [
          {
            actor: "sacty",
            event: {
              type: "NoChangesFound",
              payload: { submission: (task.submissions.implement ?? 0) + 1 },
            },
          },
          this.implementSubmitted(task),
        ]);
        this.checkBudget(submitted);
        return;
      }
      fail(message("pr.failed", { detail: errorText(error) }));
    }
  }

  /**
   * いま sacty の PR に付けるラベル（PBI-88）。レビュー用のラベル（sacty の設定 reviewLabel。PBI-99）。設定していなければ無い。
   * そのトリアージを Off にしていても付ける（一時的に Off にした間の PR も、On に戻したら取り込まれるように。PBI-139）。
   */
  private labelForPullRequests(): string | undefined {
    return this.deps.settings.get().reviewLabel || undefined;
  }

  /**
   * PR の公開の記録に入れる、レビュー用のラベルを付ける予定（PBI-88・PBI-99）。付けた・付けられなかった記録のある PR には付けない
   * （1つの PR に1回。人が外したラベルを付け直さないため）。
   */
  private labelDue(task: Task, repo: string, number: number): { label?: string } {
    const label = this.labelForPullRequests();
    if (!label) return {};
    const done = (task.pullRequestLabels ?? []).some(
      (x) => x.number === number && sameRepo(x.repo, repo),
    );
    return done ? {} : { label };
  }

  /**
   * 公開の記録に付ける予定があり、付けた・付けられなかった記録の無い、開いている sacty の PR（PBI-88）。公開を記録した後、
   * ラベルを付ける前に止まった（停止・クラッシュ）ものを、再開で付けるため。
   */
  private pendingPullRequestLabels(task: Task): { repo: string; number: number }[] {
    const prs = [
      ...(task.pullRequest?.label &&
      task.pullRequest.repo &&
      task.pullRequest.number &&
      task.pullRequestState === "open"
        ? [{ repo: task.pullRequest.repo, number: task.pullRequest.number }]
        : []),
      ...task.stepPullRequests
        .filter((p) => p.label && p.state === "open" && !p.superseded)
        .map((p) => ({ repo: p.repo, number: p.number })),
    ];
    return prs.filter(
      (p) =>
        !(task.pullRequestLabels ?? []).some(
          (x) => x.number === p.number && sameRepo(x.repo, p.repo),
        ),
    );
  }

  /**
   * 付ける予定のまま記録の無い PR に、レビュー用のラベルを付ける（PBI-88・PBI-99）。PR の確認（60秒ごと）のたびに行う。中止した
   * タスク・いまは付けない設定（レビュー用のラベルが無い）なら付けない（記録もしない）。
   */
  private async resumePullRequestLabels(): Promise<void> {
    if (!this.labelForPullRequests()) return;
    for (const task of [...this.tasks.values()]) {
      if (task.status === "cancelled" || this.cancelling.has(task.id)) continue;
      for (const pr of this.pendingPullRequestLabels(task)) {
        const usedSecrets: string[] = [];
        let token: string;
        try {
          token = await this.githubToken(task, pr.repo, usedSecrets);
        } catch (error) {
          console.warn(
            `[daemon] PR #${pr.number}（${pr.repo}）にラベルを付けるためのトークンを取り出せませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
          );
          continue;
        }
        await this.labelPullRequest(task.id, pr.repo, pr.number, token, usedSecrets);
      }
    }
  }

  /**
   * sacty が作った PR（実装の PR と、要求要件・設計の PR）に、レビュー用のラベル（sacty の設定 reviewLabel）を付ける
   * （PBI-88・PBI-99）。別のタスクとして取り込ませ、レビューだけを行わせるため。
   * - レビュー用のラベルを設定していなければ、付けない（そのトリアージが Off でも付ける。PBI-139）
   * - 1つの PR につき1回だけ付ける（付けた・付けられなかった記録があれば、PR を更新しても付けない。人が外したラベルを
   *   付け直さないため）。同じ PR を付けている途中なら、重ねて付けない
   * - 付けられなければ、理由を台帳に残す（秘密の値は伏せる）。PR の作成は失敗にしない
   */
  private async labelPullRequest(
    taskId: string,
    repo: string,
    number: number,
    token: string,
    usedSecrets: readonly string[],
  ): Promise<void> {
    const label = this.labelForPullRequests();
    if (!label) return;
    const same = (x: { repo: string; number: number }) =>
      x.number === number && sameRepo(x.repo, repo);
    if ((this.tasks.get(taskId)?.pullRequestLabels ?? []).some(same)) return;
    const key = `${taskId} ${repoKey(repo)}#${number}`;
    if (this.labeling.has(key)) return;
    this.labeling.add(key);
    try {
      let event: EventInput;
      try {
        const { created } = await this.deps.pulls.addLabel({ repo, token, number, label });
        event = {
          type: "PullRequestLabeled",
          payload: { repo, number, label, ...(created ? { created } : {}) },
        };
      } catch (error) {
        event = {
          type: "PullRequestLabelFailed",
          payload: { repo, number, label, message: redactText(errorText(error), usedSecrets) },
        };
      }
      // 付けている間に、ほかで記録された（同じ PR）なら、記録しない
      const latest = this.tasks.get(taskId);
      if (!latest || (latest.pullRequestLabels ?? []).some(same)) return;
      try {
        this.append(latest, [{ actor: "sacty", event }]);
      } catch (error) {
        console.warn(
          `[daemon] PR #${number}（${repo}）のラベルの記録に失敗しました：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
      }
    } finally {
      this.labeling.delete(key);
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
    const taskId = this.runningTask.getStore();
    if (taskId) this.inflight.get(taskId)?.runIds.add(runId);
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
    this.pauseCounts.set(id, (this.pauseCounts.get(id) ?? 0) + 1);
    const inflight = this.inflight.get(id);
    if (inflight) {
      this.stopRuns(inflight.runIds);
      await inflight.done.catch(() => {});
      // 記録は runNext の後始末で行う。止める前に作業が終わって承認待ちになった（PR を作り終えたなど）なら、一時停止は
      // していないので、そうはっきり返す（PBI-110 レビュー指摘）
      const after = this.mustGet(id);
      if (after.status === "awaiting_approval" || after.status === "escalated") {
        throw new InvalidOperationError(message("pause.reachedApproval"));
      }
      return after;
    }
    this.pauseIfRequested(id);
    return this.mustGet(id);
  }

  private stopRuns(runIds: Iterable<string>): void {
    for (const runId of runIds) {
      this.deps.executor.kill(runId);
      this.deps.tests.kill(runId);
      // サービスの起動の待ち（up --wait）も打ち切る（PBI-70 レビュー指摘）
      this.deps.services?.abort?.(runId);
    }
  }

  /** 人間が一時停止・中止を求めたか。 */
  private stopRequested(taskId: string): boolean {
    return this.pauseRequested.has(taskId) || this.cancelling.has(taskId);
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
      // オーケストレーターのセッション（PBI-67）。工程のエージェントは実行ごとに空の設定で起動するので、保存しない
      // （実行ごとに写した元のファイルは、監査のために消さない）
      {
        target: "session",
        present: this.deps.orchestratorSessions?.has(task.id) ?? false,
      },
      {
        target: "branch",
        present: sactyBranches(task).length > 0,
        detail: sactyBranches(task).join(", ") || undefined,
      },
      {
        target: "pull_request",
        present: Boolean(task.pullRequest?.number) || openStepPullRequests(task).length > 0,
        detail:
          [
            task.pullRequest?.number ? task.pullRequest.url : undefined,
            ...openStepPullRequests(task).map((p) => p.url),
          ]
            .filter(Boolean)
            .join(", ") || undefined,
      },
    ];
  }

  /**
   * 中止する。実行中ならコンテナを止めて処理の終わりを待ち、sacty が作ったものを片付ける
   * （PRを閉じる → sacty のブランチを消す → 作業領域を消す）。人間が作ったブランチやPRには触れない。
   * 片付けの結果を作業履歴に記録し、作業履歴は残す。
   */
  async cancel(
    id: string,
    /** sacty が中止する理由（レビューの PR がマージされた・閉じられた。PBI-44）。人間の中止では無い。 */
    reason?: "pull_request_merged" | "pull_request_closed",
  ): Promise<Task> {
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
      // 質問に答えている実行は止めて、答えの記録（中断・費用）を待つ（PBI-54）
      const chat = this.chats.get(id);
      if (chat) {
        this.deps.executor.kill(chat.runId);
        await chat.done;
      }
      const cleanup: CleanupResult[] = [];
      const inflight = this.inflight.get(id);
      // 止めたコンテナが無くなったことを確かめられなければ、作業領域は消さない（まだ書き込まれうるため）
      let containerStopped = true;
      if (inflight) {
        this.pauseRequested.add(id);
        // 監査の深掘りの順番を待っているなら、待つのをやめさせる（PR #135 再レビュー指摘）
        this.auditLockWaits.get(id)?.();
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
      // オーケストレーターのセッション（PBI-67）。実行と質問への答えが終わった後に消す
      const sessions = this.deps.orchestratorSessions;
      if (sessions?.has(id)) {
        try {
          sessions.remove(id);
          cleanup.push({ target: "session", result: "done" });
        } catch (error) {
          cleanup.push({ target: "session", result: "failed", detail: errorText(error) });
        }
      } else {
        cleanup.push({ target: "session", result: "skipped" });
      }

      const latest = this.mustGet(id);
      const pr = latest.pullRequest;
      // PR：sacty が作ったものだけを閉じる（マージはしない）。番号はリポジトリの中でしか一意でないので、
      // 作ったときに記録したリポジトリに対してだけ閉じる（いまの設定のリポジトリは使わない）
      // マージした実装の PR（マージの後の監視の工程の間に中止した。PBI-116）は、閉じられないので触れない
      if (pr?.number && latest.pullRequestState !== "merged") {
        const usedSecrets: string[] = [];
        try {
          if (!pr.repo) {
            throw new MessageError(message("cleanup.prRepoUnknown"));
          }
          // PR を作ったときと同じく、プロジェクトの gh のアカウントで閉じる
          const token = await this.githubToken(latest, pr.repo, usedSecrets);
          await this.deps.pulls.close({ repo: pr.repo, token, number: pr.number });
          cleanup.push({ target: "pull_request", result: "done", detail: pr.url });
        } catch (error) {
          cleanup.push({
            target: "pull_request",
            result: "failed",
            detail: redactText(errorText(error), usedSecrets),
          });
        }
      }
      // 要求要件・設計の PR（PBI-57）：sacty が作り、まだ開いているものを閉じる（マージ済み・閉じられたものはそのまま）
      for (const step of openStepPullRequests(latest)) {
        const usedSecrets: string[] = [];
        try {
          const token = await this.githubToken(latest, step.repo, usedSecrets);
          const now = await this.deps.pulls
            .status({ repo: step.repo, token, number: step.number })
            .catch(() => undefined);
          if (now && now.state !== "open") continue;
          await this.deps.pulls.close({ repo: step.repo, token, number: step.number });
          cleanup.push({ target: "pull_request", result: "done", detail: step.url });
        } catch (error) {
          cleanup.push({
            target: "pull_request",
            result: "failed",
            detail: redactText(errorText(error), usedSecrets),
          });
        }
      }
      if (!cleanup.some((c) => c.target === "pull_request")) {
        cleanup.push({ target: "pull_request", result: "skipped" });
      }
      // ブランチ：sacty のブランチだけを消す（実装の PR のブランチ・タスクブランチ・要求要件と設計のブランチ。PBI-57）
      const gitDir = this.trustedGitDir(latest);
      // PRの作成に失敗していても、プッシュ済みのブランチは記録してある
      const branches = sactyBranches(latest);
      for (const branch of branches) {
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
      }
      if (branches.length === 0) cleanup.push({ target: "branch", result: "skipped" });
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
        {
          actor: reason ? "sacty" : "person",
          event: { type: "TaskCancelled", payload: { ...(reason ? { reason } : {}), cleanup } },
        },
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
    const found = this.targetRepository(task, config.config);
    // 再現の確かめは、再現の工程のイメージで実行する（PBI-41）
    const reproduceImage = resolveImage(
      config.config,
      task.images?.reproduce ?? task.images?.implement,
    );
    const target: typeof found = !found.ok
      ? found
      : !reproduceImage.ok
        ? reproduceImage
        : {
            ok: true,
            repo: { ...found.repo, testImage: reproduceImage.image, testEnv: reproduceImage.env },
          };
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
    const ran = await this.runTests(task, "reproduce", {
      runId,
      image: target.repo.testImage,
      ...(Object.keys(target.repo.testEnv).length > 0 ? { env: target.repo.testEnv } : {}),
      workspaceDir: dir,
      command: testCommand,
    });
    // サービスを起動できなければ、テストの実行基盤の失敗として扱う（再現できたとはみなさない。PBI-47）
    const result: TestRunResult = ran.ok
      ? ran.result
      : { exitCode: 125, output: "", note: ran.message, infrastructure: true, durationMs: 0 };
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

  /**
   * 統合レビュー（PBI-31）。子タスクの PR がマージされた後のベースブランチの最新を取得し、ゴールガーディアンが
   * 新しいセッションで、そのコード（使い捨ての写し）と親の承認済みの要求要件・設計から判定する。合格、または
   * 続けて通らない上限に達したら統合レビューの承認待ちにする。上限の前に不合格なら、作業履歴の適用で
   * タスク分割の工程に戻り、修正の子タスクを追加する。実行できなければ理由を記録して止める（再開でやり直す）。
   */
  private async integrate(task: Task, config: SactyConfig): Promise<void> {
    const step = "integrate" as const;
    const agent = agentFor(config, step);
    const runId = randomUUID();
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: { runId, step, agentId: agent.id, ...agentSetting(agent) },
        },
      },
    ]);
    // 統合レビューのイメージは、実行を始めたときのものに決める（実行の間に変えても、次の実行から。PBI-106）
    const runImageName = this.mustGet(task.id).images?.[step];
    const workspaceDir = join(this.deps.workspaceRoot, "_guardian", runId);
    const subtasks = this.subtaskSummaries(task);
    let baseBranch = task.repository?.baseBranch ?? "";
    let commit = "";
    let executed: Executed | undefined;
    const failed = (detail: DaemonText) => ({
      outcome: { kind: "failed" as const, reason: "error" as const, message: detail },
      costUsd: 0,
      estimated: false,
    });
    // 対象リポジトリの無い親（PBI-73）は、子タスクのリポジトリごとにベースブランチの最新を用意する
    const repoless = isRepoless(task);
    let repositories:
      | { repo: string; baseBranch: string; commit: string; dir: string }[]
      | undefined;
    try {
      // 起点の clone（退避したメタデータ）が無ければ用意し直してから、ベースブランチの最新を取得する
      const ready = repoless
        ? ({ ok: true, dir: workspaceDir } as const)
        : await this.prepareRepository(this.mustGet(task.id), config);
      const latest = this.mustGet(task.id);
      baseBranch = latest.repository?.baseBranch ?? baseBranch;
      if (repoless) {
        const prepared = await this.childRepositories(latest, config, workspaceDir);
        if (prepared.ok) repositories = prepared.repositories;
        else executed = failed(prepared.message);
      } else if (!ready.ok) {
        executed = failed(
          message("integrate.baseUnavailable", { branch: baseBranch, detail: ready.message }),
        );
      } else {
        const usedSecrets: string[] = [];
        try {
          const gitDir = this.trustedGitDir(latest);
          commit = await this.deps.repos.fetchBranch(
            gitDir,
            baseBranch,
            await this.gitAuth(latest, latest.repository?.url ?? "", usedSecrets),
          );
          await this.deps.repos.snapshot(gitDir, commit, workspaceDir);
        } catch (error) {
          executed = failed(
            message("integrate.baseUnavailable", {
              branch: baseBranch,
              detail: redactText(errorText(error), usedSecrets),
            }),
          );
        }
      }
      // 統合レビューのイメージ（PBI-41）。images から消した名前なら、実行せずに理由を示して止める
      const stepImage = resolveImage(config, runImageName);
      if (!stepImage.ok) executed ??= failed(stepImage.message);
      executed ??= await this.execute({
        agent,
        taskId: task.id,
        image: stepImage.ok ? stepImage.image : config.image,
        ...(stepImage.ok ? { imageEnv: stepImage.env } : {}),
        runId,
        prompt: buildIntegrationReviewPrompt(latest, subtasks, {
          baseBranch,
          commit,
          ...(repositories ? { repositories } : {}),
        }),
        role: step,
        workspaceDir,
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = executed;
    if (outcome.kind === "failed") {
      const manual = await this.manualPauseInfo(task.id);
      this.append(this.mustGet(task.id), [
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
            payload: { reason: this.stopReason(task.id, outcome.reason), ...manual },
          },
        },
      ]);
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }
    const latest = this.mustGet(task.id);
    const { output, ...review } = extractIntegrationReview(
      outcome.output,
      integrationViewpointIds(latest),
      latest.remarks.filter((r) => !r.voided).map((r) => r.id),
    );
    const events: ActivityItem[] = [
      {
        actor: "guardian",
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
          },
        },
      },
      {
        actor: "guardian",
        event: {
          type: "IntegrationReviewed",
          payload: {
            ...review,
            baseBranch,
            commit,
            ...(repositories
              ? {
                  repositories: repositories.map(({ repo, baseBranch, commit }) => ({
                    repo,
                    baseBranch,
                    commit,
                  })),
                }
              : {}),
          },
        },
      },
    ];
    // 合格、または続けて通らない上限に達したら、人間の承認待ちにする（不合格のまま判断してもらう）
    if (review.passed || latest.integrationFailures + 1 >= MAX_INTEGRATION_ATTEMPTS) {
      events.push(...this.submitEvents(latest, step));
    }
    this.checkBudget(this.append(latest, events));
  }

  /**
   * 対象リポジトリの無い親の統合レビュー（PBI-73）のために、子タスクのリポジトリ（ベースブランチごと）の最新を、作業領域の下の
   * ディレクトリに書き出す。子タスクの clone（退避したメタデータ）が無ければ、その子タスクの起点で用意し直す。中止した・
   * リポジトリを用意する前の子タスクは読まない。用意できなければ理由を返す（再開すると、統合レビューをやり直す）。
   */
  private async childRepositories(
    parent: Task,
    config: SactyConfig,
    workspaceDir: string,
  ): Promise<
    | {
        ok: true;
        repositories: { repo: string; baseBranch: string; commit: string; dir: string }[];
      }
    | { ok: false; message: DaemonText }
  > {
    const repositories: { repo: string; baseBranch: string; commit: string; dir: string }[] = [];
    const seen = new Set<string>();
    for (const c of parent.split?.children ?? []) {
      const child = this.tasks.get(c.taskId);
      if (!child?.repository || child.status === "cancelled") continue;
      const repo = this.taskRepo(child) ?? child.repository.url;
      const branch = child.repository.baseBranch;
      const key = `${repo.toLowerCase()} ${branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const unavailable = (detail: DaemonText) => ({
        ok: false as const,
        message: message("integrate.baseUnavailable", { branch: `${repo} ${branch}`, detail }),
      });
      const ready = await this.prepareRepository(child, config);
      if (!ready.ok) return unavailable(ready.message);
      const usedSecrets: string[] = [];
      try {
        const gitDir = this.trustedGitDir(child);
        const commit = await this.deps.repos.fetchBranch(
          gitDir,
          branch,
          await this.gitAuth(child, child.repository.url, usedSecrets),
        );
        const dir = repositoryDirName(repo, repositories.length);
        await this.deps.repos.snapshot(gitDir, commit, join(workspaceDir, dir));
        repositories.push({ repo, baseBranch: branch, commit, dir });
      } catch (error) {
        return unavailable(redactText(errorText(error), usedSecrets));
      }
    }
    return { ok: true, repositories };
  }

  /** 分割で作った子タスクの要約（統合レビュー・修正の子タスクの追加に渡す。PBI-31）。 */
  private subtaskSummaries(parent: Task): SubtaskSummary[] {
    return (parent.split?.children ?? []).map((c) => {
      const child = this.tasks.get(c.taskId);
      const url = child?.pullRequest?.url;
      return {
        title: c.title,
        state: child && isCompleted(child) ? ("completed" as const) : ("cancelled" as const),
        ...(url ? { pullRequestUrl: url } : {}),
        round: c.round,
        ...(c.repo ? { repo: c.repo } : {}),
      };
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
              // リポジトリの無い親を分けたときは、子タスクごとに付けたリポジトリ（PBI-73）
              ...((child.repo ?? repo) ? { repo: child.repo ?? repo } : {}),
              ...(child.repo && child.repoReason ? { repoReason: child.repoReason } : {}),
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

  /**
   * 秘密情報を取り出してエージェントを実行し、出力やエラー文から秘密情報を取り除いて返す。オーケストレーター（質問への答えも）
   * は、タスクのセッションを使い回す（PBI-67）。返す runId は、最後に実行したもの（再開できずに新しく始め直したら変わる）。
   */
  private async execute(
    original: ExecuteRun,
  ): Promise<{ outcome: AgentOutcome; costUsd: number; estimated: boolean; runId: string }> {
    const run = this.withMemory(original);
    if (run.role === "orchestrator") {
      // 同じタスクで、オーケストレーターの実行は同時に1つだけ（並ぶ）
      return this.withOrchestratorLock(run.taskId, () => this.executeWithSession(run));
    }
    if (run.role === "chat") return this.executeWithSession(run);
    const { archived: _archived, ...executed } = await this.executeOnce(run);
    return { ...executed, runId: run.runId };
  }

  /** タスクごとの、オーケストレーターの実行の順番（PBI-67）。 */
  private readonly orchestratorQueue = new Map<string, Promise<void>>();

  private async withOrchestratorLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.orchestratorQueue.get(taskId) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.orchestratorQueue.set(taskId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.orchestratorQueue.get(taskId) === tail) this.orchestratorQueue.delete(taskId);
    }
  }

  /**
   * オーケストレーターのセッションを使って実行する（PBI-67）。オーケストレーターは、同じタスク・同じエージェントの保存した
   * セッションを再開し、無ければ・再開できなければ新しく始め、終わったらセッションを保存する。質問への答え（chat）は、
   * 保存したセッションを複製して答え、保存しない（元のセッションに、質問と答えが混ざらない）。指示はこれまでどおり台帳から
   * 作る（セッションは経緯の補い）。どちらも、使ったセッションを作業履歴に残す。
   */
  private async executeWithSession(
    run: ExecuteRun,
  ): Promise<{ outcome: AgentOutcome; costUsd: number; estimated: boolean; runId: string }> {
    const store = this.deps.orchestratorSessions;
    const runtime = run.agent.runtime;
    if (!store || !this.deps.sessionLogs || (runtime !== "claude-code" && runtime !== "codex")) {
      const { archived: _archived, ...executed } = await this.executeOnce(run);
      return { ...executed, runId: run.runId };
    }
    const chat = run.role === "chat";
    const agent = { agentId: run.agent.id, runtime };
    let plan: Awaited<ReturnType<OrchestratorSessionStore["plan"]>>;
    try {
      plan = await store.plan(run.taskId, agent);
    } catch (error) {
      console.warn(
        `[daemon] オーケストレーターのセッションを確かめられませんでした（${run.taskId}）：`,
        error instanceof Error ? error.message : error,
      );
      plan = { mode: "new", reason: "files_broken" };
    }
    let runId = run.runId;
    let executed = await this.executeOnce(
      plan.mode === "resume"
        ? { ...run, session: { resume: plan.sessionId, filesDir: plan.filesDir, fork: chat } }
        : run,
    );
    let reason = plan.mode === "new" ? plan.reason : undefined;
    let failedRunId: string | undefined;
    // AI が再開を受け付けなかった（何も使わずに失敗した）なら、新しいセッションで始め直す（タスクは止めない）。
    // 人間が止めた・中止したときは、始め直さない
    if (
      plan.mode === "resume" &&
      resumeRejected(runtime, executed.outcome) &&
      !this.stopRequested(run.taskId) &&
      !run.stopped?.()
    ) {
      failedRunId = runId;
      reason = "resume_failed";
      runId = randomUUID();
      run.onRunId?.(runId);
      const first = executed;
      executed = await this.executeOnce({ ...run, runId });
      executed = { ...executed, costUsd: executed.costUsd + first.costUsd };
    }
    const archived = executed.archived;
    // 再開を指定したのに、エージェントが別のセッションの ID を出した（再開せずに新しく始めた）なら、新規として記録する。
    // 複製（チャット）は、新しい ID になるのが正しい
    if (
      plan.mode === "resume" &&
      !failedRunId &&
      !chat &&
      archived?.sessionId &&
      archived.sessionId !== plan.sessionId
    ) {
      reason = "resume_failed";
    }
    const resumed = plan.mode === "resume" && !failedRunId && reason === undefined;
    let saved:
      | {
          saved: boolean;
          notSaved?: "not_archived" | "no_session" | "session_missing" | "copy_failed";
        }
      | undefined;
    // 中止したタスクのセッションは保存しない（中止の片付けで消す）
    if (!chat && this.tasks.get(run.taskId)?.status !== "cancelled") {
      const sourceDir = this.deps.sessionLogs.agentFilesDir(run.taskId, runId);
      saved =
        !archived || archived.notArchived || archived.files.length === 0 || !sourceDir
          ? { saved: false, notSaved: "not_archived" }
          : await store
              .save(run.taskId, {
                ...agent,
                sessionId: archived.sessionId,
                runId,
                sourceDir,
                files: archived.files,
              })
              .catch(() => ({ saved: false, notSaved: "copy_failed" as const }));
    }
    const task = this.tasks.get(run.taskId);
    if (task) {
      try {
        this.append(task, [
          {
            actor: "sacty",
            event: {
              type: "OrchestratorSessionUsed",
              payload: {
                runId,
                role: chat ? "chat" : "orchestrator",
                ...agent,
                mode: resumed ? (chat ? "forked" : "resumed") : "new",
                ...(archived?.sessionId ? { sessionId: archived.sessionId } : {}),
                ...(plan.mode === "resume" ? { resumedFrom: plan.sessionId } : {}),
                ...(reason ? { reason } : {}),
                ...(failedRunId ? { failedRunId } : {}),
                ...(saved ? { saved: saved.saved } : {}),
                ...(saved?.notSaved ? { notSaved: saved.notSaved } : {}),
              },
            },
          },
        ]);
      } catch (error) {
        console.warn(
          `[daemon] オーケストレーターのセッションを作業履歴に記録できませんでした（${runId}）：`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    const { archived: _archived, ...rest } = executed;
    return { ...rest, runId };
  }

  /** 1回の実行。写したエージェントのファイル（PBI-66）も返す。 */
  private async executeOnce(
    run: ExecuteRun & {
      /** 再開するセッション（PBI-67）。 */
      session?: OrchestratorSessionResume;
    },
  ): Promise<{
    outcome: AgentOutcome;
    costUsd: number;
    estimated: boolean;
    archived: ArchivedAgentSession | undefined;
  }> {
    // 実行に渡した秘密情報。作業履歴に書く前に、出力やエラー文から取り除く。
    const usedSecrets: string[] = [];
    // セッションログ（PBI-62）。実行に渡した秘密情報は、書く前に伏せる（準備の間に増えた分も）
    const log = this.deps.sessionLogs?.open(
      {
        taskId: run.taskId,
        runId: run.runId,
        role: run.role,
        agentId: run.agent.id,
        runtime: run.agent.runtime,
        authMode: run.agent.auth.mode,
        ...(run.agent.model ? { model: run.agent.model } : {}),
      },
      () => usedSecrets,
    );
    try {
      const executed = await this.executeLogged(run, usedSecrets, log);
      // 失敗した実行・止めた実行も、結果を残して閉じる（結果の文は、伏せた後のもの）
      log?.close(executed.outcome);
      return { ...executed, archived: log?.archived };
    } catch (error) {
      log?.close({ kind: "failed", reason: "error", message: errorText(error) });
      throw error;
    } finally {
      this.recordAgentSession(run, log);
    }
  }

  /**
   * 写したエージェントの元のファイル（PBI-66）の大きさとハッシュを、作業履歴に記録する（監査で書き換えを見つけるため）。
   * 中止したタスクにも記録する。記録できなくても、実行の結果は変えない。
   */
  private recordAgentSession(
    run: ExecuteRun & { session?: OrchestratorSessionResume },
    log: SessionLogHandle | undefined,
  ): void {
    const archived = log?.archived;
    const task = this.tasks.get(run.taskId);
    if (!archived || !task) return;
    try {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AgentSessionArchived",
            payload: {
              runId: run.runId,
              role: run.role,
              agentId: run.agent.id,
              runtime: archived.runtime,
              ...(archived.sessionId ? { sessionId: archived.sessionId } : {}),
              files: archived.files,
              limitBytes: archived.limitBytes,
              skipped: archived.skipped,
              ...(archived.notArchived ? { notArchived: archived.notArchived } : {}),
            },
          },
        },
      ]);
    } catch (error) {
      console.warn(
        `[daemon] 写したエージェントのファイルを作業履歴に記録できませんでした（${run.runId}）：`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async executeLogged(
    run: ExecuteRun & { session?: OrchestratorSessionResume },
    usedSecrets: string[],
    log: SessionLogHandle | undefined,
  ): Promise<{ outcome: AgentOutcome; costUsd: number; estimated: boolean }> {
    let outcome: AgentOutcome;
    let gatewayRun: ReturnType<NonNullable<ServiceDeps["gateway"]>["register"]> | undefined;
    try {
      // ゲートウェイ経由なら、API キーはゲートウェイに渡し、コンテナには実行ごとのトークンだけを渡す（PBI-37）
      // 組織内 PF の API を使わせるなら、実行ごとのトークンを含む URL を渡す（認証情報は渡さない。PBI-35）
      const auth = run.agent.auth;
      // Bedrock（PBI-37）か、providers の接続先（組織の AI gateway など。PBI-40）をゲートウェイ経由にする
      const endpoint = run.agent.endpoint;
      const viaGateway =
        (run.agent.via_gateway && auth.mode === "bedrock") ||
        (auth.mode === "provider" && Boolean(endpoint?.viaGateway));
      const platforms = run.platforms ?? [];
      // ホストの MCP サーバー（PBI-36）の認証のヘッダーに、実行ごとのトークンを入れる
      const tokenEnvs = (run.context?.secrets ?? []).filter(
        (s) => s.secret === GATEWAY_TOKEN_SECRET,
      );
      let gateway: { origin: string; token: string } | undefined;
      if (viaGateway || platforms.length > 0 || tokenEnvs.length > 0) {
        if (!this.deps.gateway) throw new MessageError(message("gateway.unavailable"));
        let route: { base: string; apiKey?: string } | undefined;
        if (viaGateway && auth.mode === "bedrock") {
          const apiKey = await this.deps.secrets.get(auth.secret);
          usedSecrets.push(apiKey);
          route = { base: `${bedrockOrigin(auth)}/openai/v1`, apiKey };
        } else if (viaGateway && endpoint) {
          const apiKey = endpoint.secret ? await this.deps.secrets.get(endpoint.secret) : undefined;
          if (apiKey) usedSecrets.push(apiKey);
          route = { base: endpoint.baseUrl, ...(apiKey ? { apiKey } : {}) };
        }
        // コンテキストの HTTP の MCP サーバー（PBI-49）。認証のヘッダーの秘密情報はホストで取り出し、ゲートウェイだけに
        // 持たせる（コンテナには渡さない）
        const contextMcp: Record<string, ContextMcpRoute> = {};
        for (const server of run.contextMcp ?? []) {
          // ホストで起動した command の MCP サーバー（PBI-84）。env の秘密情報はホストで起動するときに取り出してあり、
          // ゲートウェイには中の名前だけを渡す
          if ("host" in server) {
            contextMcp[server.name] = { host: server.host };
            continue;
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(server.headers)) {
            if (typeof value === "string") {
              headers[name] = value;
              continue;
            }
            const secret = await this.deps.secrets.get(value.secret);
            usedSecrets.push(secret);
            headers[name] = `${value.prefix}${secret}`;
          }
          // 時間切れを書いたなら、ゲートウェイの中継がそれより先に切れないようにする（PBI-75）
          const timeoutSec = Math.max(
            server.startup_timeout_sec ?? 0,
            server.tool_timeout_sec ?? 0,
          );
          contextMcp[server.name] = {
            url: server.url,
            headers,
            ...(timeoutSec > 0 ? { timeoutMs: timeoutSec * 1000 } : {}),
          };
        }
        // プロジェクトのコンテキストで定義した PF は、この実行のトークンでだけ使えるようにする（PBI-74）
        gatewayRun = this.deps.gateway.register(
          route,
          contextMcp,
          platforms.filter((p) => p.from !== undefined),
          // 接続先を決めて使う実行（操作・文書・書き出し）は、決めた PF・MCP だけを使える。書き出しは、選んだ PF か、
          // 選んだ MCP だけを置いたコンテキストを渡すので、その範囲に縛る（PBI-131）
          run.role === "operation" || run.role === "document" || run.role === "export"
            ? { platforms: platforms.map((p) => p.name), hostMcp: run.context?.mcpServers ?? [] }
            : undefined,
        );
        usedSecrets.push(gatewayRun.token);
        if (viaGateway) {
          gateway = { origin: this.deps.gateway.containerOrigin(), token: gatewayRun.token };
        }
      }
      const invocation = await buildInvocation(
        run.agent,
        run.prompt,
        this.deps.secrets,
        (value) => usedSecrets.push(value),
        run.role,
        run.context,
        gateway,
        run.session,
        run.readDirs,
      );
      if (gatewayRun && platforms.length > 0 && this.deps.gateway) {
        invocation.env.SACTY_PF_URL = this.deps.gateway.platformsUrl(gatewayRun.token);
        invocation.hostGateway = true;
      }
      if (gatewayRun && tokenEnvs.length > 0) {
        for (const s of tokenEnvs) invocation.env[s.env] = `${s.prefix}${gatewayRun.token}`;
        invocation.hostGateway = true;
      }
      if (run.mounts && run.mounts.length > 0) invocation.mounts = [...run.mounts];
      // コンテナから見たホストのアドレス（Rancher Desktop など。PBI-40）
      const config = this.deps.config();
      if (invocation.hostGateway && config.ok) invocation.hostAddress = config.config.hostAddress;
      mkdirSync(run.workspaceDir, { recursive: true });
      // 準備の間（clone や秘密情報の取り出し）に人間が止めたなら、コンテナを起動しない
      const running = this.runningTask.getStore();
      if ((running && this.pauseRequested.has(running)) || run.stopped?.()) {
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
        invocation,
        ...(run.imageEnv && Object.keys(run.imageEnv).length > 0 ? { imageEnv: run.imageEnv } : {}),
        ...(run.network ? { network: run.network } : {}),
        ...(run.forwards ? { forwards: run.forwards } : {}),
        ...(log ? { log } : {}),
      });
    } catch (error) {
      outcome = {
        kind: "failed",
        reason: error instanceof SecretNotFoundError ? "auth" : "error",
        message: errorText(error),
      };
    } finally {
      gatewayRun?.close();
    }
    // ゲートウェイがリトライしたら、どの実行のものかを作業履歴に残す（PBI-37）
    const retried = gatewayRun?.stats();
    if (retried && retried.retries + (retried.gaveUp ? 1 : 0) > 0) {
      this.recordRetries(run.runId, run.agent.id, retried);
    }
    outcome =
      outcome.kind === "failed"
        ? { ...outcome, message: redactText(outcome.message, usedSecrets) }
        : // 出力の JSON は、取り出すときにデコードする（レビューのコメント・監査・再現のテストなど）。デコードすると元の値に
          // 戻るエスケープ（"\u0073…"）も伏せる（PBI-131）
          { ...outcome, output: redactEscaped(redact(outcome.output, usedSecrets), usedSecrets) };
    // サブスクリプションは実際の請求が発生しないので、同じ単価で換算した値として扱う
    const estimated =
      run.agent.auth.mode === "subscription" ||
      run.agent.auth.mode === "stub" ||
      run.estimateCost === true;
    const costUsd = outcome.usage ? computeCostUsd(outcome.usage, run.agent.price) : 0;
    return { outcome, costUsd, estimated };
  }

  /** ゲートウェイのリトライを、実行中のタスクの作業履歴に記録する（PBI-37）。 */
  private recordRetries(runId: string, agentId: string, stats: GatewayStats): void {
    const taskId = this.runningTask.getStore();
    const task = taskId ? this.tasks.get(taskId) : undefined;
    if (!task || task.status === "cancelled") return;
    this.append(task, [
      {
        actor: "sacty",
        event: { type: "AiRequestsRetried", payload: { runId, agentId, ...stats } },
      },
    ]);
  }

  /**
   * 実装の承認待ちにするイベント（PBI-110）。検証に通った実装の PR を作った（変更が無くて作らなかった）記録と、同じ追記で記録する。
   */
  private implementSubmitted(task: Task): ActivityItem {
    return {
      actor: "sacty",
      event: {
        type: "StepSubmitted",
        payload: { step: "implement", submission: (task.submissions.implement ?? 0) + 1 },
      },
    };
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
    // 実装は、検証（テストと最終レビュー）に通り、PR を作ってから承認待ちにする（PBI-110。publish の implementSubmitted）
    if (step === "implement") return [];
    // PR で承認する工程（PBI-57）は、成果を PR にしてから承認待ちにする（PR の記録と一緒に提出する）
    if (isStepPullRequestKey(step) && this.stepPullRequestsOn(task)) return [];
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
    // 変更の申し出の判定は、起点のコミットのコードを使い捨ての写しで読ませる
    const { outcome, costUsd, estimated, runId } = await this.runGuardian(
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
      runResult: outcome.kind === "completed" ? "completed" : "failed",
      agentId: agent.id,
      ...agentSetting(agent),
      runId,
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
  /**
   * 人が、タスクの詳細で工程のイメージを変える（PBI-106）。工程の状態は問わない（実行中・終わった工程も変えられる）。
   * 今の実行は止めず、その工程を次に実行するときから使う（実行の開始で、そのときのイメージを決める）。テストの実行も、
   * 実行を始めるときの実装（再現）の工程のイメージを使う。プロジェクトの対象の指定より、人の変更を優先する。
   * images に無い名前（config.yaml から消した名前など）は、理由を示して断る。
   */
  changeStepImage(id: string, raw: unknown): Task {
    const { step, image } = ChangeStepImageInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    if (!task.steps.some((s) => s.key === step)) {
      throw new InvalidOperationError(message("image.stepMissing"));
    }
    const config = this.deps.config();
    // 設定を読めない・解析できなければ、名前を確かめられないので、その理由を示して断る（名前の誤りと取り違えないため）
    if (!config.ok) {
      throw new InvalidOperationError(
        message("image.configUnavailable", { detail: config.problem }),
      );
    }
    if (!resolveImage(config.config, image).ok) {
      throw new InvalidOperationError(message("image.notInImages", { name: image }));
    }
    const from = task.images?.[step] ?? DEFAULT_IMAGE_NAME;
    if (from === image)
      throw new InvalidOperationError(message("image.unchanged", { name: image }));
    return this.append(task, [
      {
        actor: "person",
        event: { type: "StepImageChanged", payload: { step, from, to: image } },
      },
    ]);
  }

  /**
   * 人が、タスクの詳細で工程のエージェントを変える（PBI-121）。工程のイメージ（PBI-106）と同じく、工程の状態は問わず、
   * 今の実行は止めず、その工程を次に実行するときから使う。config.yaml の step_agents より優先する。agents に無い名前は断る。
   */
  changeStepAgent(id: string, raw: unknown): Task {
    const { step, agent } = ChangeStepAgentInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    if (!task.steps.some((s) => s.key === step)) {
      throw new InvalidOperationError(message("agent.stepMissing"));
    }
    // 統合レビューは、ゴールガーディアンが実行する。画面で出さないだけでなく、API でも断る（PR #131 レビュー指摘）
    if (!stepAgentChangeable(step)) {
      throw new InvalidOperationError(message("agent.stepNotChangeable"));
    }
    const config = this.deps.config();
    if (!config.ok) {
      throw new InvalidOperationError(
        message("agent.configUnavailable", { detail: config.problem }),
      );
    }
    if (!definedAgent(config.config, agent)) {
      throw new InvalidOperationError(message("agent.notInAgents", { name: agent }));
    }
    const from = task.agents?.[step] ?? agentFor(config.config, step).id;
    if (from === agent)
      throw new InvalidOperationError(message("agent.unchanged", { name: agent }));
    return this.append(task, [
      { actor: "person", event: { type: "StepAgentChanged", payload: { step, from, to: agent } } },
    ]);
  }

  /** 人が選んだ工程のエージェントが config.yaml から消えていたら、理由を示して一時停止する（PBI-121）。 */
  private pauseForMissingAgent(task: Task, step: StepKey, name: string): void {
    const latest = this.mustGet(task.id);
    if (latest.status !== "queued" && latest.status !== "idle") return;
    this.append(latest, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: { reason: "error", message: message("agent.chosenMissing", { step, name }) },
        },
      },
    ]);
  }

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

  /** sacty の設定の通知先に、テストの通知を送る（PBI-38・PBI-115）。送れなければ、理由の例外にする。 */
  async testNotification(): Promise<void> {
    if (!this.deps.notifier || !this.readableSettings().notification) {
      throw new InvalidOperationError(message("notify.notConfigured"));
    }
    try {
      await this.deps.notifier.test();
    } catch (error) {
      throw new InvalidOperationError(
        message("notify.failed", {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * 「再レビュー」（PBI-44）。レビューを PR に投稿して完了したタスクのレビューの工程をやり直し、PR の最新の
   * コミットに対してもう一度レビューして投稿する（対象の PR は実行の前に確かめ直す）。
   */
  rereview(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (!canRereview(task)) throw new InvalidOperationError(message("review.notRereviewable"));
    return this.append(task, [
      { actor: "person", event: { type: "ReviewRestarted", payload: {} } },
    ]);
  }

  /**
   * タスクの詳細で、オーケストレーターに質問する（PBI-54）。質問を記録し、答えは待たずに返す（answered で待てる）。
   * 作業中のタスクでも質問でき、タスクの状態・工程・承認済みの内容は変えない（作業中の実行には話しかけない）。
   * 中止したタスク・予算の上限に達したタスクでは質問できない。答えを待つ質問は、1タスクに1件まで。
   */
  askQuestion(id: string, raw: unknown): { task: Task; answered: Promise<void> } {
    const { text } = AskQuestionInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    const blocked = questionBlocked(task);
    if (blocked) throw new InvalidOperationError(blocked);
    // 中止の後片付けの間も、質問を受け付けない
    if (this.cancelling.has(id)) throw new InvalidOperationError(message("task.cancelled"));
    const config = this.deps.config();
    if (!config.ok) throw new InvalidOperationError(message("chat.unavailable"));
    const questionId = `Q-${task.questions.length + 1}`;
    const asked = this.append(task, [
      { actor: "person", event: { type: "QuestionAsked", payload: { questionId, text } } },
    ]);
    // 実行の ID は、セッションを新しく始め直すと変わる（止める対象を、いまの実行にする。PBI-67）
    const entry: { runId: string; done: Promise<void> } = {
      runId: randomUUID(),
      done: Promise.resolve(),
    };
    const answered = this.answerQuestion(asked, questionId, entry, config.config)
      .catch((error) => {
        console.error(`[daemon] could not record the answer for task ${id}:`, error);
      })
      .finally(() => {
        // 次の質問の実行を消さないよう、この実行の分だけを消す
        if (this.chats.get(id) === entry) this.chats.delete(id);
      });
    entry.done = answered;
    this.chats.set(id, entry);
    return { task: asked, answered };
  }

  /**
   * オーケストレーターに、タスクの台帳を読ませて質問に答えさせる（PBI-54）。用意済みのタスクは、対象リポジトリの
   * 起点のコードの使い捨ての写しを渡す（変更は残らない）。答えから秘密情報を取り除いてから、長ければ切り詰める。
   * 答えられなくても、使った分の費用は記録する。
   */
  private async answerQuestion(
    task: Task,
    questionId: string,
    /** 実行（止めるために、いまの実行の ID を書き換える）。 */
    chat: { runId: string },
    config: SactyConfig,
  ): Promise<void> {
    const question = task.questions.find((q) => q.id === questionId);
    if (!question) return;
    // オーケストレーターに使う AI（step_agents.orchestrator か default_agent。PBI-40）
    const agent = agentFor(config, "orchestrator");
    const setting = { agentId: agent.id, ...agentSetting(agent), runId: chat.runId };
    let payload: Extract<EventInput, { type: "QuestionAnswered" }>["payload"];
    // 各実行のセッションログを、答えの実行ごとの場所に並べて、読み取り専用でマウントする（PBI-91）
    const logsDir = join(this.deps.workspaceRoot, "_question-logs", chat.runId);
    try {
      const activity = this.deps.activity.forTask(task.id);
      const logs = this.stageQuestionLogs(task.id, activity, logsDir, chat.runId);
      // オーケストレーターのセッションを複製して答える（作業中のセッションには話しかけない。PBI-67）
      const { outcome, costUsd, estimated, runId } = await this.runGuardian(
        task,
        {
          agent,
          image: config.image,
          prompt: buildChatPrompt(task, activity, question, logs),
          role: "chat",
          ...("runs" in logs
            ? {
                mounts: [{ hostPath: logsDir, containerPath: CONTAINER_LOGS_DIR, readOnly: true }],
                readDirs: [CONTAINER_LOGS_DIR],
              }
            : {}),
          runId: chat.runId,
          // 準備の間（コードの書き出しなど）に中止されたなら、コンテナを起動しない
          stopped: () => this.cancelling.has(task.id),
          onRunId: (next) => {
            chat.runId = next;
          },
        },
        "base",
      );
      const cost = {
        ...setting,
        runId,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        costUsd,
        estimated,
      };
      // 秘密情報は、execute が出力の全文から取り除いている（切り詰めるのは、その後）
      const answer = outcome.kind === "completed" ? outcome.output.trim() : "";
      if (this.cancelling.has(task.id)) {
        payload = {
          questionId,
          failed: message("chat.cancelled"),
          runResult: "interrupted",
          ...cost,
        };
      } else if (outcome.kind === "failed") {
        payload = {
          questionId,
          failed: message("chat.failed", { detail: outcome.message }),
          runResult: "failed",
          ...cost,
        };
      } else if (!answer) {
        payload = { questionId, failed: message("chat.emptyAnswer"), runResult: "failed", ...cost };
      } else {
        payload = {
          questionId,
          answer: answer.length > ANSWER_MAX ? `${answer.slice(0, ANSWER_MAX - 1)}…` : answer,
          runResult: "completed",
          ...cost,
        };
      }
    } catch (error) {
      payload = {
        questionId,
        failed: message("chat.failed", { detail: errorText(error) }),
        runResult: "failed",
        ...setting,
      };
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
    const latest = this.tasks.get(task.id);
    if (!latest || latest.status === "cancelled" || pendingQuestion(latest)?.id !== questionId) {
      return;
    }
    try {
      this.append(latest, [
        { actor: "orchestrator", event: { type: "QuestionAnswered", payload } },
      ]);
    } catch (error) {
      // 答えを記録できなければ、答えられなかったこととして記録する（答え待ちのまま、次の質問を塞がない）。
      // 実行にかかった費用（使用量・換算か）は、そのまま記録する
      const { answer: _answer, failed: _failed, ...rest } = payload;
      this.append(this.mustGet(task.id), [
        {
          actor: "orchestrator",
          event: {
            type: "QuestionAnswered",
            payload: {
              ...rest,
              failed: message("chat.failed", { detail: errorText(error) }),
              runResult: "failed",
            },
          },
        },
      ]);
    }
    // 予算の通知は記録するが、タスクは止めない（次の工程の実行の前に、予算で止まる）
    this.warnIfNeeded(this.mustGet(task.id));
  }

  // ─── 完了したタスクの監査（PBI-125） ───────────────────────────────────────────────

  /** デーモンを止めている（止めるときの実行の失敗を、監査の失敗として記録しない）。 */
  private stopping = false;

  /** デーモンを止め始めた（main.ts が、実行中のコンテナを止める前に呼ぶ）。 */
  beginShutdown(): void {
    this.stopping = true;
  }

  /** 監査を進めるタスクか。 */
  private awaitingAudit(task: Task): boolean {
    return this.deps.audit === true && isAuditTarget(task) && auditOpen(task);
  }

  /** 監査のほかに実行するものが無いタスクか（待ち行列で後にする）。 */
  private auditOnly(task: Task): boolean {
    return (
      this.awaitingAudit(task) &&
      awaitingExport(task) === undefined &&
      !(awaitingDeploymentCheck(task) && task.status !== "paused")
    );
  }

  /** 監査のエージェントの実行中か（画面の「大まかな監査中」「深掘り中」の表示）。 */
  auditRunning(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task !== undefined && this.awaitingAudit(task) && this.inflight.has(taskId);
  }

  /** タスクが完了する（監査の対象になる）追記なら、監査を待つ記録（同じ追記に入れる）。 */
  private auditQueueEvent(
    before: Task | undefined,
    after: Task | undefined,
  ): { actor: Actor; event: EventInput } | undefined {
    if (this.deps.audit !== true || !after || after.audit || !isAuditTarget(after))
      return undefined;
    if (before && isAuditTarget(before)) return undefined;
    return {
      actor: "sacty",
      event: {
        type: "AuditQueued",
        payload: { auditId: randomUUID(), capUsd: this.auditBudgetUsd() },
      },
    };
  }

  /** プロジェクトごとの、深掘りの順番待ち（既存の原因の一覧を読んでから記録するまでを重ねない）。 */
  private readonly auditDiveLocks = new Map<string, Promise<void>>();

  /**
   * 同じプロジェクトの深掘りを1つずつ実行する（PR #135 レビュー指摘）。並べて実行すると、どちらも同じ既存の原因の一覧を
   * 読むため、同じ新しい原因が別の鍵で記録され、まとまらない。
   */
  private async withAuditDiveLock(
    projectId: string,
    taskId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const previous = this.auditDiveLocks.get(projectId) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => mine);
    this.auditDiveLocks.set(projectId, chain);
    // 順番を待つ間に中止されたら、待つのをやめる（中止の操作が、先の深掘りの終わりを待たない。PR #135 再レビュー指摘）。
    // 後に並んだ深掘りは、自分の順番（先の深掘りの後）を保ったまま進む
    const aborted = new Promise<true>((resolve) =>
      this.auditLockWaits.set(taskId, () => resolve(true)),
    );
    try {
      const stopped = await Promise.race([previous.then(() => false), aborted]);
      if (stopped || this.cancelling.has(taskId) || this.stopping) return;
      await run();
    } finally {
      this.auditLockWaits.delete(taskId);
      release();
      // 待つのをやめたときも、先の深掘りが終わるまで（chain が解決するまで）は、順番の記録を消さない。後から来た深掘りが
      // 先の深掘りと重ならないように（PR #135 再レビュー指摘）
      void chain.then(() => {
        if (this.auditDiveLocks.get(projectId) === chain) this.auditDiveLocks.delete(projectId);
      });
    }
  }

  /** 深掘りの順番を待っているタスクの、待つのをやめさせる関数（中止のとき）。 */
  private readonly auditLockWaits = new Map<string, () => void>();

  /**
   * 監査を1つ進める（ワーカーが実行する）。大まかな監査 → 懸念のある工程の深掘り（1つずつ）→ 完了。エージェントを実行する
   * 前に予算を確かめ、上限に達していれば一時停止する。
   */
  private async runAudit(task: Task): Promise<void> {
    const audit = task.audit;
    if (!audit) return;
    const config = this.deps.config();
    if (!config.ok) return; // 設定の問題は status() で画面に出す。監査は待ったまま
    const step = audit.survey ? nextAuditDive(audit) : undefined;
    if (audit.survey && !step) {
      this.append(task, [
        { actor: "sacty", event: { type: "AuditCompleted", payload: { auditId: audit.auditId } } },
      ]);
      return;
    }
    if (audit.usedUsd >= audit.capUsd) {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AuditBudgetPaused",
            payload: { auditId: audit.auditId, usedUsd: audit.usedUsd, capUsd: audit.capUsd },
          },
        },
      ]);
      return;
    }
    if (!step) return this.runAuditAgent(task, config.config, undefined);
    await this.withAuditDiveLock(task.projectId, task.id, async () => {
      // 順番を待つ間に、中止された・別の実行が進めたなら、何もしない
      const latest = this.tasks.get(task.id);
      if (!latest || !this.awaitingAudit(latest) || !latest.audit?.survey) return;
      if (nextAuditDive(latest.audit) !== step) return;
      await this.runAuditAgent(latest, config.config, step);
    });
  }

  /** 監査のエージェントを1回実行して記録する。step が無ければ大まかな監査、あれば その工程の深掘り。 */
  private async runAuditAgent(
    task: Task,
    config: SactyConfig,
    step: StepKey | undefined,
  ): Promise<void> {
    const audit = task.audit;
    if (!audit) return;
    const agent = config.auditAgent;
    const runId = randomUUID();
    const logsDir = join(this.deps.workspaceRoot, "_audit-logs", runId);
    const ledgerDir = join(this.deps.workspaceRoot, "_audit-ledger", runId);
    let record: { actor: Actor; event: EventInput }[];
    try {
      // 監査に渡す材料（台帳・タスクの本文・指摘・却下の理由など）は、切り詰める前に秘密情報を伏せる（PR #135 レビュー指摘）
      const hide = await this.auditRedactor(task, config);
      const raw = this.deps.activity.forTask(task.id);
      const activity = raw.map(
        (e) => ({ ...e, payload: redactDeep(e.payload, hide) }) as ActivityEvent,
      );
      const shown = redactDeep(task, hide);
      const logs = this.stageQuestionLogs(task.id, raw, logsDir, runId);
      // 並べたログは元のファイルへのハードリンクなので、元を変えずに、伏せた写しに置き換える（PR #135 再レビュー指摘）
      if ("runs" in logs) await redactStagedFiles(logsDir, hide);
      // 台帳の全文（伏せたもの）を、読み取り専用で渡す（指示には上限まで入れ、省いた行はここで読める。PR #135 レビュー指摘）
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(
        join(ledgerDir, AUDIT_LEDGER_FILE),
        `${activity.map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
      // 根拠の件数は大まかな監査のときに数え、深掘りでは記録した件数を使う（ログを毎回読み直さない。PR #135 レビュー指摘）
      const counts =
        audit.survey?.counts ?? auditCounts(raw, await this.taskToolFailures(task.id, raw));
      const project = this.deps.projects.get(task.projectId);
      const candidates = auditTargetCandidates(task, project);
      const known = this.knownAuditCauses(task.projectId);
      // メモリーは書き出す場所があるときだけ登録させる（無ければ、エージェントにも渡せない。PBI-126）
      const memoryRepo = task.repository ? repositoryMemoryKey(task.repository.url) : undefined;
      const memories = this.deps.memoryRoot ? this.knownMemories(task) : undefined;
      // 大まかな監査には、タスクの実行で開いたメモリーを渡し、役に立ったかを判断させる（PBI-127）
      const opened =
        !step && this.deps.memoryRoot ? await this.openedMemories(task, raw) : undefined;
      // 大まかな監査には、階層の移動とコンテキストへの昇格を判断する材料も渡す（PBI-128）
      const promotion = opened ? this.promotionInput(task, candidates) : undefined;
      const prompt = step
        ? buildAuditDivePrompt(shown, activity, counts, logs, {
            step,
            reason: hide(audit.survey?.concerns.find((c) => c.step === step)?.reason ?? ""),
            survey: hide(audit.survey?.summary ?? ""),
            candidates,
            known: known.causes.map((c) => ({ ...c, title: hide(c.title) })),
            rejected: known.rejected.map((r) => ({ title: hide(r.title), reason: hide(r.reason) })),
            ...(memories
              ? {
                  memories: memories.map((m) => ({
                    ...m,
                    title: hide(m.title),
                    summary: hide(m.summary),
                  })),
                  ...(memoryRepo ? { repository: memoryRepo } : {}),
                }
              : {}),
          })
        : buildAuditSurveyPrompt(
            shown,
            activity,
            counts,
            logs,
            opened?.map((m) => ({ ...m, title: hide(m.title), summary: hide(m.summary) })),
            promotion && {
              ...promotion,
              memories: promotion.memories.map((m) => ({
                ...m,
                title: hide(m.title),
                summary: hide(m.summary),
                ...(m.rejectedReason ? { rejectedReason: hide(m.rejectedReason) } : {}),
              })),
            },
          );
      const {
        outcome,
        costUsd,
        estimated,
        runId: ran,
      } = await this.runGuardian(
        task,
        {
          agent,
          image: config.image,
          prompt,
          role: step ? "audit-dive" : "audit",
          mounts: [
            { hostPath: ledgerDir, containerPath: AUDIT_LEDGER_DIR, readOnly: true },
            ...("runs" in logs
              ? [{ hostPath: logsDir, containerPath: CONTAINER_LOGS_DIR, readOnly: true }]
              : []),
          ],
          readDirs: [AUDIT_LEDGER_DIR, ...("runs" in logs ? [CONTAINER_LOGS_DIR] : [])],
          runId,
          stopped: () => this.cancelling.has(task.id) || this.stopping,
        },
        task.steps.some((s) => s.key === "implement") ? "implemented" : "base",
      );
      // デーモンを止める・タスクを中止するときの実行の終わりは、記録しない（次の起動で、もう一度実行する）
      if (this.stopping || this.cancelling.has(task.id)) return;
      // 監査の間に秘密情報の値・参照を変えても伏せるよう、記録する前に今の値を取り直す（送る前の値も合わせて伏せる。
      // PR #135 再レビュー指摘）
      const fresh = await this.auditRedactor(task, config);
      const hideResult = (text: string) => fresh(hide(text));
      const run = {
        agentId: agent.id,
        ...agentSetting(agent),
        runId: ran,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        auditCostUsd: costUsd,
        estimated,
      };
      const failed = (reason: DaemonText): { actor: Actor; event: EventInput }[] => [
        {
          actor: "auditor",
          event: {
            type: "AuditFailed",
            payload: { auditId: audit.auditId, reason, ...(step ? { step } : {}), ...run },
          },
        },
      ];
      if (outcome.kind === "failed") {
        record = failed(
          message("audit.runFailed", { detail: mapFreeText(outcome.message, hideResult) }),
        );
      } else if (!step) {
        const survey = extractAuditSurvey(
          hideResult(outcome.output),
          task,
          hideResult,
          new Set(opened?.map((m) => m.id)),
          promotion,
        );
        record = survey.ok
          ? [
              {
                actor: "auditor",
                event: {
                  type: "AuditSurveyed",
                  payload: {
                    auditId: audit.auditId,
                    summary: survey.summary,
                    counts,
                    concerns: survey.concerns,
                    ...(opened
                      ? {
                          openedMemories: opened.map((m) => m.id),
                          usefulMemories: survey.usefulMemories,
                          ...this.surveyPromotionRecord(
                            task,
                            audit.auditId,
                            survey,
                            promotion,
                            hideResult,
                          ),
                        }
                      : {}),
                    ...run,
                  },
                },
              },
            ]
          : failed(survey.reason);
      } else {
        const dive = extractAuditDive(
          hideResult(outcome.output),
          {
            eventIds: new Set(activity.map((e) => e.id)),
            runIds: new Set(
              activity.flatMap((e) => {
                const id = (e.payload as { runId?: unknown }).runId;
                return typeof id === "string" && id ? [id] : [];
              }),
            ),
            candidates,
            knownKeys: new Set(known.causes.map((c) => c.causeKey)),
            ...(memories
              ? {
                  knownMemoryIds: new Set(memories.map((m) => m.id)),
                  ...(memoryRepo ? { repository: memoryRepo } : {}),
                }
              : {}),
          },
          hideResult,
        );
        record = dive.ok
          ? [
              {
                actor: "auditor",
                event: {
                  type: "AuditDeepDived",
                  payload: {
                    auditId: audit.auditId,
                    step,
                    summary: dive.summary,
                    findings: dive.findings.map((f, i) => ({
                      causeKey: f.sameAs ?? `${audit.auditId}:${step}:${i}`,
                      title: f.title,
                      detail: f.detail,
                      step,
                      evidence: f.evidence.map((e) => ({ ...e, step })),
                      proposals: f.proposals.map((p, j) => ({
                        id: `${task.id}:${audit.auditId}:${step}:${i}:${j}`,
                        title: p.title,
                        body: p.body,
                        target: p.target,
                        candidates,
                      })),
                    })),
                    ...(memories
                      ? { memories: dive.memories.map((m) => ({ ...m, id: randomUUID() })) }
                      : {}),
                    ...run,
                  },
                },
              },
            ]
          : failed(dive.reason);
      }
    } catch (error) {
      if (this.stopping || this.cancelling.has(task.id)) return;
      record = [
        {
          actor: "auditor",
          event: {
            type: "AuditFailed",
            payload: {
              auditId: audit.auditId,
              reason: message("audit.runFailed", { detail: errorText(error) }),
              ...(step ? { step } : {}),
            },
          },
        },
      ];
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    }
    const latest = this.tasks.get(task.id);
    if (!latest || !isAuditTarget(latest) || latest.audit?.auditId !== audit.auditId) return;
    // 移す前の置き場所（書き直すため。PBI-128）
    const beforeMoves = this.memories();
    this.append(latest, record);
    // 登録したメモリーを書き出す（上限を超えた階層は、古いものを消してから。PBI-126）
    const registered = record.flatMap(({ event }) =>
      event.type === "AuditDeepDived" ? (event.payload.memories ?? []) : [],
    );
    if (registered.length > 0) {
      const layers = registered.map(
        (m): MemoryLayer =>
          m.scope === "project"
            ? { kind: "project", projectId: task.projectId }
            : { kind: "repository", repo: m.repo },
      );
      this.writeMemories([...layers, ...this.trimMemories()]);
    }
    // 移したメモリーは、移す前と後の階層を書き直す（PBI-128）
    const moved = record.flatMap(({ event }) =>
      event.type === "AuditSurveyed" ? (event.payload.memoryMoves ?? []) : [],
    );
    if (moved.length > 0) {
      const before = new Map(beforeMoves.map((m) => [m.id, layerOf(m)]));
      // 移した先が上限を超えたら、登録のときと同じく古いものから消す（PR #138 レビュー指摘）
      const trimmed = this.trimMemories();
      this.writeMemories([
        ...trimmed,
        ...moved.flatMap((move): MemoryLayer[] => [
          ...(before.has(move.id) ? [before.get(move.id) as MemoryLayer] : []),
          move.scope === "project"
            ? { kind: "project", projectId: move.projectId }
            : { kind: "repository", repo: move.repo },
        ]),
      ]);
    }
    // 役に立ったメモリーの有効な最終利用日が変わるので、その階層を書き直す（PBI-127）
    const useful = new Set(
      record.flatMap(({ event }) =>
        event.type === "AuditSurveyed" ? (event.payload.usefulMemories ?? []) : [],
      ),
    );
    if (useful.size > 0) {
      this.writeMemories(
        this.memories()
          .filter((m) => useful.has(m.id))
          .map(layerOf),
      );
    }
    this.warnAuditBudget(this.mustGet(task.id));
  }

  /**
   * メモリーを読ませる実行なら、タスクのプロジェクトと対象リポジトリのメモリーを読み取り専用でマウントする（PBI-126）。
   * 工程（統合レビューを除く）には、読み方の指示も足す。監査には、既存のメモリーとの重複を確かめるために渡す。
   * ゴールガーディアン（判定・最終レビュー・統合レビュー・PR の指摘の差し戻し先の判定）・オーケストレーター・質問への答え・
   * 書き出しには渡さない
   * （ゴールガーディアンの判定の材料は、承認済みのものに限るため）。ほかのプロジェクト・リポジトリのメモリーは渡さない。
   */
  private withMemory(run: ExecuteRun): ExecuteRun {
    const root = this.deps.memoryRoot;
    const step = MEMORY_STEP_ROLES.has(run.role);
    if (!root || (!step && run.role !== "audit" && run.role !== "audit-dive")) return run;
    const task = this.tasks.get(run.taskId);
    if (!task) return run;
    const layers = taskMemoryLayers(task);
    const mounts: { hostPath: string; containerPath: string; readOnly: boolean }[] = [];
    const project = existingLayerDir(root, layers.project);
    if (project) {
      mounts.push({
        hostPath: project,
        containerPath: CONTAINER_PROJECT_MEMORY_DIR,
        readOnly: true,
      });
    }
    const repository = layers.repository && existingLayerDir(root, layers.repository);
    if (repository) {
      mounts.push({
        hostPath: repository,
        containerPath: CONTAINER_REPOSITORY_MEMORY_DIR,
        readOnly: true,
      });
    }
    if (mounts.length === 0) return run;
    const dirs = mounts.map((m) => m.containerPath);
    return {
      ...run,
      mounts: [...(run.mounts ?? []), ...mounts],
      readDirs: [...(run.readDirs ?? []), ...dirs],
      ...(step ? { prompt: [...memoryPromptLines(dirs), "", run.prompt].join("\n") } : {}),
    };
  }

  /** 消していないメモリー（すべてのプロジェクト）。 */
  private memories(): LiveMemory[] {
    return liveMemories(this.tasks.values());
  }

  /**
   * 階層のメモリーを書き出す（PBI-126）。layers を渡さなければ、すべての階層を書き直す（起動のとき）。正本は作業履歴なので、
   * 書けなくても記録は残り、次の起動で書き直す。
   */
  private writeMemories(layers?: readonly MemoryLayer[]): void {
    const root = this.deps.memoryRoot;
    if (!root) return;
    try {
      syncMemoryLayers(root, this.memories(), layers);
    } catch (error) {
      console.warn("[daemon] メモリーを書き出せませんでした：", errorText(error));
    }
  }

  /**
   * 階層ごとの件数の上限を超えたメモリーを、有効な最終利用日の古いものから消す（PBI-126）。消したことは、メモリーを登録した
   * タスクの作業履歴に記録する。消した階層を返す。
   */
  private trimMemories(): MemoryLayer[] {
    const trimmed: MemoryLayer[] = [];
    for (const memory of overCapacity(
      this.memories(),
      this.deps.memoryLimit ?? MEMORY_MAX_PER_LAYER,
    )) {
      const task = this.tasks.get(memory.taskId);
      if (!task) continue;
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AuditMemoryDeleted",
            payload: { memoryId: memory.id, reason: "capacity" },
          },
        },
      ]);
      trimmed.push(layerOf(memory));
    }
    return trimmed;
  }

  /**
   * 起動のとき、上限を超えたメモリーを消し、すべての階層を作業履歴に合わせて書き直す（登録・削除の記録の後、書き出す前に
   * 止まっていても直す。PBI-126）。
   */
  syncMemories(): void {
    this.expireMemories();
    this.retirePromotedMemories();
    this.trimMemories();
    this.writeMemories();
  }

  /**
   * 有効な最終利用日から、sacty の設定の残す日数を過ぎたメモリーを消す（PBI-127）。消したことは、メモリーを登録したタスクの
   * 作業履歴に記録し、その階層を書き直す。デーモンが定期的に実行する（起動のときも）。記録と書き出しは同期で行うので、
   * 監査の記録の途中に挟まらない。
   */
  cleanupMemories(): void {
    const layers = [...this.expireMemories(), ...this.retirePromotedMemories()];
    if (layers.length > 0) this.writeMemories(layers);
  }

  /**
   * コンテキストにする改修の PR がマージされたメモリーを消す（PBI-128）。コンテキストになったので、メモリーとしては要らない。
   * 却下・判断待ち・マージ前なら残す。消したことは、メモリーを登録したタスクの作業履歴に記録する。消した階層を返す。
   */
  private retirePromotedMemories(): MemoryLayer[] {
    if (!this.deps.memoryRoot) return [];
    const retired: MemoryLayer[] = [];
    for (const memory of promotedMemories(this.tasks.values(), this.memories())) {
      const source = this.tasks.get(memory.taskId);
      if (!source) continue;
      this.append(source, [
        {
          actor: "sacty",
          event: {
            type: "AuditMemoryDeleted",
            payload: { memoryId: memory.id, reason: "promoted" },
          },
        },
      ]);
      retired.push(layerOf(memory));
    }
    return retired;
  }

  /** コンテキストにする提案が、判断待ちか採用済みのメモリー（同じ提案を重ねないため）と、却下の理由（PBI-128）。 */
  private memoryPromotions(): { promoting: Set<string>; rejected: Map<string, string> } {
    const promoting = new Set<string>();
    const rejected = new Map<string, string>();
    for (const task of this.tasks.values()) {
      if (task.status === "cancelled") continue;
      for (const finding of task.audit?.findings ?? []) {
        for (const p of finding.proposals) {
          if (!p.memoryId) continue;
          if (p.decision?.kind === "rejected") rejected.set(p.memoryId, p.decision.reason);
          else promoting.add(p.memoryId);
        }
      }
    }
    return { promoting, rejected };
  }

  /**
   * 大まかな監査に渡す、昇格の判断の材料（PBI-128）。タスクのプロジェクトと対象リポジトリの、消していないメモリー（有効な
   * 最終利用日・役に立った回数・提案中か）と、コンテキストにする提案の宛先の候補（sacty の既定のコンテキストは除く）。
   */
  private promotionInput(task: Task, candidates: readonly AuditTarget[]): PromotionInput {
    const layers = taskMemoryLayers(task);
    const all = this.memories();
    const counts = usefulCounts(this.tasks.values());
    const { promoting, rejected } = this.memoryPromotions();
    const of = (layer: MemoryLayer, dir: string) =>
      memoriesOf(all, layer).map((m) => ({
        id: m.id,
        scope: m.scope,
        title: m.title,
        summary: m.summary,
        lastUsefulAt: m.lastUsefulAt,
        usefulCount: counts.get(m.id) ?? 0,
        promoting: promoting.has(m.id),
        ...(rejected.has(m.id) ? { rejectedReason: rejected.get(m.id) } : {}),
        path: `${dir}/${MEMORY_REFERENCES_DIR}/${m.id}.md`,
      }));
    return {
      memories: [
        ...of(layers.project, CONTAINER_PROJECT_MEMORY_DIR),
        ...(layers.repository ? of(layers.repository, CONTAINER_REPOSITORY_MEMORY_DIR) : []),
      ],
      candidates: candidates.filter((c) => c.kind !== "sacty"),
      ...(layers.repository?.kind === "repository" ? { repository: layers.repository.repo } : {}),
    };
  }

  /**
   * 大まかな監査が出した、階層の移動とコンテキストにする提案を、記録の形にする（PBI-128）。記録の時点で、メモリーが消えて
   * いない・まだタスクの階層にある・移す先と違う階層にある・提案中でないことを確かめ直す（大まかな監査は同じプロジェクトで
   * 同時に動くことがあるため）。提案は、元のメモリーの中身を本文に添え、原因の鍵を `memory:<ID>` にする。
   */
  private surveyPromotionRecord(
    task: Task,
    auditId: string,
    survey: Extract<ReturnType<typeof extractAuditSurvey>, { ok: true }>,
    promotion: PromotionInput | undefined,
    hide: (text: string) => string,
  ): { memoryMoves: MemoryMove[]; promotions: SurveyPromotionRecord[] } {
    if (!promotion) return { memoryMoves: [], promotions: [] };
    const layers = taskMemoryLayers(task);
    const inTask = (m: LiveMemory) =>
      sameLayer(layerOf(m), layers.project) ||
      (layers.repository !== undefined && sameLayer(layerOf(m), layers.repository));
    const live = new Map(this.memories().map((m) => [m.id, m]));
    const memoryMoves: MemoryMove[] = survey.memoryMoves.flatMap((move): MemoryMove[] => {
      const memory = live.get(move.id);
      if (!memory || !inTask(memory) || memory.scope === move.to) return [];
      if (move.to === "project")
        return [{ id: move.id, scope: "project", projectId: task.projectId }];
      return promotion.repository
        ? [{ id: move.id, scope: "repository", repo: promotion.repository }]
        : [];
    });
    const { promoting } = this.memoryPromotions();
    const promotions = survey.memoryPromotions.flatMap((p): SurveyPromotionRecord[] => {
      const memory = live.get(p.id);
      if (!memory || !inTask(memory) || promoting.has(p.id)) return [];
      // 元のメモリーも、今の秘密情報の値で伏せてから添える（登録の後に秘密情報になった値や、共有のリポジトリのメモリーに
      // 入っている値を、提案に平文で写さない。PR #138 レビュー指摘）
      const original = {
        title: cut(hide(memory.title), MEMORY_TITLE_MAX),
        summary: cut(hide(memory.summary), MEMORY_SUMMARY_MAX),
        body: cut(hide(memory.body), MEMORY_BODY_MAX),
      };
      return [
        {
          // 題は元のメモリーの題だけを持ち、「メモリーをコンテキストにする」の定型の題と説明は、画面の言語で出す
          // （原因の鍵 memory:<ID> で見分ける。PR #138 レビュー指摘）
          causeKey: `memory:${p.id}`,
          title: original.title || p.title,
          detail: "",
          evidence: [],
          proposals: [
            {
              id: `${task.id}:${auditId}:memory:${p.id}`,
              title: p.title,
              body: p.body,
              target: p.target,
              candidates: [...promotion.candidates],
              memoryId: p.id,
              memoryOriginal: original,
            },
          ],
        },
      ];
    });
    return { memoryMoves, promotions };
  }

  /** コンテキストにする改修の PR がマージされたメモリーを消し、階層を書き直す（PBI-128）。 */
  private cleanupPromotedMemories(): void {
    const layers = this.retirePromotedMemories();
    if (layers.length > 0) this.writeMemories(layers);
  }

  /** 残す日数を過ぎたメモリーを消し、消した階層を返す（PBI-127）。 */
  private expireMemories(): MemoryLayer[] {
    if (!this.deps.memoryRoot) return [];
    const days = this.deps.settings.get().memoryRetentionDays ?? DEFAULT_MEMORY_RETENTION_DAYS;
    const expired: MemoryLayer[] = [];
    for (const memory of expiredMemories(this.memories(), this.now(), days)) {
      const task = this.tasks.get(memory.taskId);
      if (!task) continue;
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "AuditMemoryDeleted",
            payload: { memoryId: memory.id, reason: "expired" },
          },
        },
      ]);
      expired.push(layerOf(memory));
    }
    return expired;
  }

  /**
   * 大まかな監査に渡す、タスクの実行で開いたメモリー（PBI-127）。タスクのプロジェクトと対象リポジトリの、消していないメモリーの
   * うち、タスクの実行のセッションログに中身のファイルの場所が出てきたもの（開いた回数の多い順）。
   */
  private async openedMemories(
    task: Task,
    activity: readonly ActivityEvent[],
  ): Promise<OpenedMemory[]> {
    const store = this.deps.sessionLogs;
    if (!store) return [];
    const layers = taskMemoryLayers(task);
    const all = this.memories();
    const candidates = [
      ...memoriesOf(all, layers.project),
      ...(layers.repository ? memoriesOf(all, layers.repository) : []),
    ];
    if (candidates.length === 0) return [];
    const ids = new Set(candidates.map((m) => m.id));
    // 監査の実行は数えない（PR #137 レビュー指摘）。大まかな監査の途中でデーモンを止めると、監査の記録は残らないが、実行の
    // セッションの記録（role が audit・audit-dive）は残り、次の起動の大まかな監査で、前の監査が開いたものまで数えてしまうため
    const auditRuns = new Set(
      activity.flatMap((e) => {
        const p = e.payload as { runId?: unknown; role?: unknown };
        const audit = e.type.startsWith("Audit") || p.role === "audit" || p.role === "audit-dive";
        return audit && typeof p.runId === "string" ? [p.runId] : [];
      }),
    );
    const runIds = new Set(
      activity.flatMap((e) => {
        const id = (e.payload as { runId?: unknown }).runId;
        return typeof id === "string" && id && !auditRuns.has(id) ? [id] : [];
      }),
    );
    const counts = new Map<string, number>();
    for (const runId of runIds) {
      const path = store.path(task.id, runId, "events");
      if (!path) continue;
      try {
        countOpenedMemories(await readFile(path, "utf8"), ids, counts);
      } catch (error) {
        // 無いログは数えない。それ以外の読めなかったログは、追えるように警告する（ログの中身は出さない。PR #137 レビュー指摘）
        const code = (error as { code?: unknown }).code;
        if (code !== "ENOENT") {
          console.warn(
            `[daemon] メモリーを開いたかを数えるログを読めませんでした（task ${task.id}・run ${runId}・${typeof code === "string" ? code : "unknown"}）。`,
          );
        }
      }
    }
    return candidates
      .filter((m) => counts.has(m.id))
      .map((m) => ({ id: m.id, title: m.title, summary: m.summary, count: counts.get(m.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
  }

  /** 深掘りに渡す、タスクの階層の既存のメモリー（PBI-126）。 */
  private knownMemories(task: Task): KnownMemory[] {
    const layers = taskMemoryLayers(task);
    const all = this.memories();
    const known = (layer: MemoryLayer, dir: string): KnownMemory[] =>
      memoriesOf(all, layer).map((m) => ({
        id: m.id,
        scope: m.scope,
        title: m.title,
        summary: m.summary,
        path: `${dir}/${MEMORY_REFERENCES_DIR}/${m.id}.md`,
      }));
    return [
      ...known(layers.project, CONTAINER_PROJECT_MEMORY_DIR),
      ...(layers.repository ? known(layers.repository, CONTAINER_REPOSITORY_MEMORY_DIR) : []),
    ];
  }

  /**
   * 監査が登録したメモリーを、人が消す（PBI-126）。人はメモリーを登録できず、誤ったものを消すだけ。消したことは、メモリーを
   * 登録したタスクの作業履歴に記録する。
   */
  deleteAuditMemory(memoryId: string): Task {
    for (const task of this.tasks.values()) {
      const memory = task.audit?.memories.find((m) => m.id === memoryId);
      if (!memory) continue;
      if (memory.deleted) throw new InvalidOperationError(message("audit.memoryDeleted"));
      // 監査が移したメモリーは、登録したときの階層ではなく、今の置き場所の階層を書き直す（PR #138 レビュー指摘）
      const placed = this.memories().find((m) => m.id === memoryId);
      const updated = this.append(task, [
        {
          actor: "person",
          event: { type: "AuditMemoryDeleted", payload: { memoryId, reason: "person" } },
        },
      ]);
      this.writeMemories([
        placed
          ? layerOf(placed)
          : memory.scope === "project"
            ? { kind: "project", projectId: task.projectId }
            : { kind: "repository", repo: repositoryMemoryKey(memory.repo) ?? memory.repo },
      ]);
      return updated;
    }
    throw new InvalidOperationError(message("audit.memoryNotFound"));
  }

  /** 監査の予算の 80% に達したら記録する（上限ごとに1回）。 */
  private warnAuditBudget(task: Task): void {
    const audit = task.audit;
    if (!audit || !auditOpen(task)) return;
    if (audit.usedUsd < audit.capUsd * BUDGET_WARN_RATIO || audit.warnedCapUsd === audit.capUsd) {
      return;
    }
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AuditBudgetWarned",
          payload: { auditId: audit.auditId, usedUsd: audit.usedUsd, capUsd: audit.capUsd },
        },
      },
    ]);
  }

  /**
   * タスクの各実行のセッションログ（標準出力の JSONL だけ）から、失敗したツール呼び出しを数える（ログが無ければ 0）。
   * 1つずつ非同期で読む（大きいログで、ほかのタスクの進行や API の応答を止めない。PR #135 レビュー指摘）。
   */
  private async taskToolFailures(
    taskId: string,
    activity: readonly ActivityEvent[],
  ): Promise<number> {
    const store = this.deps.sessionLogs;
    if (!store) return 0;
    const runIds = new Set(
      activity.flatMap((e) => {
        const id = (e.payload as { runId?: unknown }).runId;
        return typeof id === "string" && id ? [id] : [];
      }),
    );
    let failures = 0;
    for (const runId of runIds) {
      const path = store.path(taskId, runId, "events");
      if (!path) continue;
      try {
        failures += countToolFailures(await readFile(path, "utf8"));
      } catch {
        // 無い・読めないログは数えない
      }
    }
    return failures;
  }

  /**
   * 監査の材料から秘密情報を伏せる関数（PR #135 レビュー指摘）。sacty の設定・sacty の設定で使う秘密情報の値と、
   * GitHub のトークン、よくある秘密情報の形（CI のログと同じ規則）を伏せる。取り出せない値は飛ばす。
   */
  private async auditRedactor(task: Task, config: SactyConfig): Promise<(text: string) => string> {
    // 実行に使う設定と、今の設定の両方から取り出す（深掘りの順番を待つ間に設定を変えても伏せる。PR #135 再レビュー指摘）
    const values = await this.auditSecretValues(task.projectId, config);
    if (task.repository) {
      try {
        await this.githubToken(task, task.repository.url, values);
      } catch {
        // GitHub のアカウントを選んでいないなど
      }
    }
    return (text: string) => redactLog(text, values);
  }

  /**
   * 監査で伏せる秘密情報の値：sacty の設定・sacty の設定で使う秘密情報（監査の AI のものを含む）と、プロジェクトで選んだ
   * GitHub のアカウントのトークン。取り出せない値は飛ばす（形で伏せる）。config を渡したときは、それと今の設定の両方から
   * 取り出す。同じ参照の値の入れ替えは知る手立てが無いので、使い回さずに毎回取り出す（PR #135 再レビュー指摘）。
   */
  private async auditSecretValues(projectId: string, config?: SactyConfig): Promise<string[]> {
    const current = this.deps.config();
    const configs = [config, current.ok ? current.config : undefined].filter(
      (c): c is SactyConfig => c !== undefined,
    );
    const refs = [
      ...new Set(
        configs.flatMap((c) =>
          uniqueUses(secretUses(c, this.readableSettings())).map((u) => u.ref),
        ),
      ),
    ];
    const accounts = this.deps.projects.get(projectId)?.githubAccounts ?? {};
    const values: string[] = [];
    for (const ref of refs) {
      try {
        values.push(await this.deps.secrets.get(ref));
      } catch {
        // 取り出せない値は伏せられないが、形で伏せる
      }
    }
    for (const host of Object.keys(accounts)) {
      try {
        await this.githubToken({ projectId }, `https://${host}/sacty/sacty`, values);
      } catch {
        // gh にログインしていないなど
      }
    }
    return values;
  }

  /**
   * 監査の画面・レポートに出す文（元のタスクの題など）の秘密情報を伏せる関数（PR #135 再レビュー指摘）。設定を読めなければ、
   * よくある秘密情報の形だけを伏せる。
   */
  async auditHide(projectId: string): Promise<(text: string) => string> {
    const values = await this.auditSecretValues(projectId);
    return (text: string) => redactLog(text, values);
  }

  /** プロジェクトの既存の原因（鍵・題・状態）と、人が却下した提案と理由（監査に渡す）。 */
  private knownAuditCauses(projectId: string): {
    causes: KnownAuditCause[];
    rejected: RejectedAuditProposal[];
  } {
    const causes = new Map<string, KnownAuditCause>();
    const rejected: RejectedAuditProposal[] = [];
    for (const t of this.tasks.values()) {
      if (t.projectId !== projectId || !t.audit || t.status === "cancelled") continue;
      for (const f of t.audit.findings) {
        // メモリーをコンテキストにする提案は、深掘りの原因の一覧に入れない（PBI-128）
        if (f.causeKey.startsWith("memory:")) continue;
        const adopted = f.proposals.some((p) => p.decision?.kind === "adopted");
        const previous = causes.get(f.causeKey);
        causes.set(f.causeKey, {
          causeKey: f.causeKey,
          title: previous?.title ?? f.title,
          status:
            adopted || previous?.status === "改修を採用した" ? "改修を採用した" : "改修は未採用",
        });
        for (const p of f.proposals) {
          if (p.decision?.kind === "rejected") {
            rejected.push({ title: p.title, reason: p.decision.reason });
          }
        }
      }
    }
    return { causes: [...causes.values()], rejected };
  }

  /** 改修の提案を持つタスクと、その提案を探す。 */
  private findAuditProposal(proposalId: string) {
    for (const task of this.tasks.values()) {
      for (const finding of task.audit?.findings ?? []) {
        const proposal = finding.proposals.find((p) => p.id === proposalId);
        if (proposal) return { task, finding, proposal };
      }
    }
    return undefined;
  }

  /**
   * 改修の提案を採用する（PBI-125）。宛先は提案の候補から選ぶ。対象リポジトリ・コンテキストのリポジトリが宛先なら、
   * 改修のタスクを作る（先に採用を記録してから作り、途中で止まっても起動のときに作る）。sacty の既定のコンテキストが
   * 宛先なら、利用者のプロジェクトにはタスクを作らず、採用だけを記録する（ADR 20261017-1145）。
   */
  adoptAuditProposal(proposalId: string, raw: unknown): Task {
    const { target } = AdoptAuditProposalInput.parse(raw);
    const found = this.findAuditProposal(proposalId);
    if (!found) throw new InvalidOperationError(message("audit.proposalNotFound"));
    const { task, proposal } = found;
    if (task.status === "cancelled") throw new InvalidOperationError(message("audit.notAdoptable"));
    if (proposal.decision) throw new InvalidOperationError(message("audit.alreadyDecided"));
    if (!proposal.candidates.some((c) => sameAuditTarget(c, target))) {
      throw new InvalidOperationError(message("audit.targetNotCandidate"));
    }
    const fixTaskId = target.kind === "sacty" ? undefined : randomUUID();
    const updated = this.append(task, [
      {
        actor: "person",
        event: {
          type: "AuditProposalAdopted",
          payload: { proposalId, target, ...(fixTaskId ? { fixTaskId } : {}) },
        },
      },
    ]);
    this.createAuditFixTask(updated, proposalId);
    return this.mustGet(task.id);
  }

  /** 採用した提案の改修のタスクを作る（作ってあれば何もしない）。 */
  private createAuditFixTask(task: Task, proposalId: string): void {
    const finding = task.audit?.findings.find((f) => f.proposals.some((p) => p.id === proposalId));
    const proposal = finding?.proposals.find((p) => p.id === proposalId);
    const decision = proposal?.decision;
    if (!finding || !proposal || decision?.kind !== "adopted" || !decision.fixTaskId) return;
    if (decision.target.kind === "sacty" || this.tasks.has(decision.fixTaskId)) return;
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const title = `改修：${proposal.title}`;
    // コンテキストにする提案は、元のメモリーを欠けずに添える（PBI-128。PR #138 レビュー指摘）
    const original = proposal.memoryOriginal;
    const body = original
      ? [
          proposal.body,
          "",
          "---",
          `コンテキストにする元のメモリー：${original.title}（${original.summary}）`,
          "",
          original.body,
        ].join("\n")
      : [proposal.body, "", "---", `監査で見つけた原因：${finding.title}`, "", finding.detail].join(
          "\n",
        );
    this.append({ id: decision.fixTaskId, projectId: task.projectId }, [
      {
        actor: "sacty",
        event: {
          type: "TaskCreated",
          payload: {
            title: title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1)}…` : title,
            body: body.length > TASK_BODY_MAX ? `${body.slice(0, TASK_BODY_MAX - 1)}…` : body,
            start: "audit",
            repo: decision.target.repo,
            budgetCapUsd,
            auditFix: { taskId: task.id, proposalId },
          },
        },
      },
    ]);
  }

  /** 採用を記録したが、作る前に止まった改修のタスクを作る（起動のとき）。 */
  resumeAuditFixTasks(): void {
    for (const task of [...this.tasks.values()]) {
      for (const finding of task.audit?.findings ?? []) {
        for (const p of finding.proposals) {
          if (p.decision?.kind === "adopted" && p.decision.fixTaskId) {
            this.createAuditFixTask(this.mustGet(task.id), p.id);
          }
        }
      }
    }
  }

  /**
   * 改修の提案を、理由を添えて却下する（PBI-125）。理由は以後の監査に渡す。理由は監査の画面・レポートにも出るので、
   * 記録する前に秘密情報を伏せる（PR #135 再レビュー指摘）。
   */
  async rejectAuditProposal(proposalId: string, raw: unknown): Promise<Task> {
    const { reason } = RejectAuditProposalInput.parse(raw);
    const check = () => {
      const found = this.findAuditProposal(proposalId);
      if (!found) throw new InvalidOperationError(message("audit.proposalNotFound"));
      if (found.task.status === "cancelled") {
        throw new InvalidOperationError(message("audit.notAdoptable"));
      }
      if (found.proposal.decision) throw new InvalidOperationError(message("audit.alreadyDecided"));
      return found;
    };
    const config = this.deps.config();
    const hide = config.ok
      ? await this.auditRedactor(check().task, config.config)
      : (text: string) => redactLog(text, []);
    // 秘密情報を取り出す間に、ほかの操作が判断していないかを確かめ直す
    const found = check();
    return this.append(found.task, [
      {
        actor: "person",
        event: { type: "AuditProposalRejected", payload: { proposalId, reason: hide(reason) } },
      },
    ]);
  }

  /** 予算で一時停止した監査を、新しい上限（累計。使った額より大きい）で再開する（PBI-125）。 */
  resumeAudit(taskId: string, raw: unknown): Task {
    const { capUsd } = ResumeAuditInput.parse(raw);
    const task = this.tasks.get(taskId);
    const audit = task && isAuditTarget(task) ? task.audit : undefined;
    if (!task || !audit) throw new InvalidOperationError(message("audit.notFound"));
    if (!audit.paused) throw new InvalidOperationError(message("audit.notPaused"));
    if (capUsd === undefined) throw new InvalidOperationError(message("resume.capRequired"));
    if (capUsd <= audit.usedUsd) {
      throw new InvalidOperationError(message("resume.capTooLow", { usedUsd: audit.usedUsd }));
    }
    return this.append(task, [
      {
        actor: "person",
        event: { type: "AuditCapRaised", payload: { auditId: audit.auditId, capUsd } },
      },
    ]);
  }

  /**
   * 質問への答えに読ませる、タスクの各実行のセッションログを dest に並べる（PBI-91）。ログの置き場所が無い・並べられない
   * ときは、理由を返す（答えは台帳だけで作る）。並べるのは、このタスクの終わった実行の分だけ。
   */
  private stageQuestionLogs(
    taskId: string,
    activity: readonly ActivityEvent[],
    dest: string,
    chatRunId: string,
  ): ChatLogs {
    const store = this.deps.sessionLogs;
    if (!store) return { unavailable: "セッションログを残していない" };
    try {
      return stageQuestionLogs({ store, taskId, activity, dest, exclude: [chatRunId] });
    } catch (error) {
      console.warn(
        `[daemon] 質問への答えに、セッションログを用意できませんでした（${taskId}）：`,
        error instanceof Error ? error.message : error,
      );
      // 理由は、エラーの種類（EACCES・ENOTDIR など）だけを伝える（ホストのパスは指示に入れない）
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return {
        unavailable: `セッションログを用意できなかった${typeof code === "string" ? `：${code}` : ""}`,
      };
    }
  }

  /**
   * 取り出せなかった秘密情報（起動のとき・取り出し直したとき。PBI-48）と、読めなかったプロジェクトのコンテキスト
   * （PBI-107）。projectId のあるものは、そのプロジェクトの警告（保存し直すと置き換える）。settings のものは、
   * sacty の設定（通知先。PBI-115）の警告（設定を保存し直すと置き換える）。
   */
  private secretProblems: { text: DaemonText; projectId?: string; settings?: true }[] = [];

  /**
   * 秘密情報の取り出しの世代（PBI-107）。取り出しを始めるたびに1つ進め、全体（設定の秘密情報）とプロジェクトごとに、
   * 最後に始めた取り出しの世代を持つ。起動・取り出し直し・保存のどの経路でも、終わったときに、自分より後に始まった
   * 取り出しがある範囲の警告は書き換えない（古い結果で、新しい結果を上書きしない）。
   */
  private secretRound = 0;
  private globalSecretRound = 0;
  private settingsSecretRound = 0;
  private readonly projectSecretRounds = new Map<string, number>();

  /** 取り出しの結果の警告を、その世代が最新の範囲だけ置き換える（PBI-107）。 */
  private applySecretProblems(
    round: number,
    problems: readonly { text: DaemonText; projectId?: string; settings?: true }[],
  ): void {
    const latest = (p: { projectId?: string; settings?: true }) =>
      p.projectId !== undefined
        ? this.projectSecretRounds.get(p.projectId) === round
        : p.settings
          ? this.settingsSecretRound === round
          : this.globalSecretRound === round;
    this.secretProblems = [
      ...this.secretProblems.filter((p) => !latest(p)),
      ...problems.filter(latest),
    ];
  }

  /**
   * 設定とプロジェクトで使う秘密情報を、まとめて取り出す（sacty up の起動時。PBI-48）。1Password の認証を1回にし、
   * タスクの実行中に認証を求めないため。プロジェクトのコンテキスト（mcp.yaml・platforms.yaml）の秘密情報も、取得して
   * から一緒に取り出す（PBI-107）。取り出せなかったものは、画面の警告に出す（値は出さない）。fresh なら、
   * 持っている値を捨てて取り出し直す（画面の「取り出し直す」）。
   */
  async prefetchSecrets(options: { fresh?: boolean } = {}): Promise<{
    total: number;
    /** 取り出せた参照の数（PBI-107。problems には、コンテキストを読めなかった理由も入るため、別に数える）。 */
    fetched: number;
    /** 読めなかったプロジェクトのコンテキストの数（PBI-107。その中の秘密情報は total に入らない）。 */
    unreadContexts: number;
    problems: DaemonText[];
  }> {
    const config = this.deps.config();
    const secrets = this.deps.secrets as SecretStore & Partial<PrefetchingSecretStore>;
    if (!config.ok || !secrets.prefetch) {
      return { total: 0, fetched: 0, unreadContexts: 0, problems: [] };
    }
    const projects = this.deps.projects.all();
    const round = ++this.secretRound;
    this.globalSecretRound = round;
    this.settingsSecretRound = round;
    for (const project of projects) this.projectSecretRounds.set(project.id, round);
    // コンテキストを読み終えてから、ほかの秘密情報と一緒に1回で取り出す（1Password の承認を1回にする。PBI-107）
    const context = await this.contextSecretUsesOf(projects, config.config);
    const uses = uniqueUses([
      ...secretUses(config.config, this.readableSettings()),
      ...context.uses,
    ]);
    const failures = await secrets.prefetch(
      uses.map((u) => u.ref),
      options,
    );
    const problems = [
      ...context.problems,
      ...failures.map(({ ref, error }) => {
        const use = uses.find((u) => u.ref === ref);
        return {
          text: message("secret.prefetchFailed", { where: use?.where ?? ref, detail: error.text }),
          ...(use?.projectId ? { projectId: use.projectId } : {}),
          ...(use?.settings ? { settings: true as const } : {}),
        };
      }),
    ];
    this.applySecretProblems(round, problems);
    return {
      total: uses.length,
      fetched: uses.length - failures.length,
      unreadContexts: context.problems.length,
      problems: problems.map((p) => p.text),
    };
  }

  /**
   * プロジェクトを保存したときに、そのプロジェクトの秘密情報（コンテキスト）をまとめて取り出す（PBI-107）。
   * すでに持っている参照は取り出さない（1Password に問い合わせない）。取り出せなかったものと、コンテキストを読めなかった
   * 理由は、画面の警告に出す（そのプロジェクトの前の警告は置き換える）。保存は止めないので、呼ぶ側は待たない。
   */
  async prefetchProjectSecrets(id: string): Promise<DaemonText[]> {
    const config = this.deps.config();
    const secrets = this.deps.secrets as SecretStore & Partial<PrefetchingSecretStore>;
    const project = this.deps.projects.get(id);
    if (!config.ok || !secrets.prefetch || !project) return [];
    // 起動・取り出し直し・ほかの保存と重なっても、最後に始めた取り出しの結果だけを、このプロジェクトの警告にする
    const round = ++this.secretRound;
    this.projectSecretRounds.set(id, round);
    const context = await this.contextSecretUsesOf([project], config.config);
    const uses = context.uses;
    const failures = await secrets.prefetch(uses.map((u) => u.ref));
    const problems = [
      ...context.problems,
      ...failures.map(({ ref, error }) => ({
        text: message("secret.savePrefetchFailed", {
          where: uses.find((u) => u.ref === ref)?.where ?? ref,
          detail: error.text,
        }),
        projectId: id,
      })),
    ];
    this.applySecretProblems(round, problems);
    return problems.map((p) => p.text);
  }

  /**
   * sacty の設定を保存したときに、設定の秘密情報（通知先のトークン・Webhook の URL。PBI-115）を取り出す。すでに持って
   * いる参照は取り出さない。取り出せなかったものは画面の警告に出す（前の設定の警告は置き換える）。呼ぶ側は待たない。
   */
  async prefetchSettingsSecrets(): Promise<DaemonText[]> {
    const config = this.deps.config();
    const secrets = this.deps.secrets as SecretStore & Partial<PrefetchingSecretStore>;
    if (!config.ok || !secrets.prefetch) return [];
    const round = ++this.secretRound;
    this.settingsSecretRound = round;
    const uses = settingsSecretUses(this.readableSettings());
    const failures = await secrets.prefetch(uses.map((u) => u.ref));
    const problems = failures.map(({ ref, error }) => ({
      text: message("secret.settingsSavePrefetchFailed", {
        where: uses.find((u) => u.ref === ref)?.where ?? ref,
        detail: error.text,
      }),
      settings: true as const,
    }));
    this.applySecretProblems(round, problems);
    return problems.map((p) => p.text);
  }

  /** sacty の設定（読めなければ空。読めない理由は、取り込みの状況に出る）。 */
  private readableSettings(): SactySettings {
    try {
      return this.deps.settings.get();
    } catch {
      return {};
    }
  }

  /**
   * プロジェクトのコンテキスト（継承の鎖の上の層も含めて合成したもの）で使う秘密情報の参照を、コンテキストを取得して
   * 集める（PBI-107）。プロジェクトが多くても待ちすぎないよう、同時に CONTEXT_SECRETS_CONCURRENCY 件ずつ読み、全体で
   * 上限の時間だけ待つ。読めなかった・時間内に読めなかったプロジェクトは、その理由を返す（その秘密情報は、使うときに
   * 取り出す）。
   */
  private async contextSecretUsesOf(
    projects: readonly Project[],
    config: SactyConfig,
  ): Promise<{ uses: SecretUse[]; problems: { text: DaemonText; projectId: string }[] }> {
    const targets = projects.filter((p) => p.context);
    if (targets.length === 0) return { uses: [], problems: [] };
    const uses: SecretUse[][] = targets.map(() => []);
    const problems: ({ text: DaemonText; projectId: string } | undefined)[] = targets.map(
      () => undefined,
    );
    const limitMs = this.deps.contextSecretsTimeoutMs ?? CONTEXT_SECRETS_TIMEOUT_MS;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 上限を過ぎたら、進んでいる取得も止める（git の子プロセスを止め、取得したリポジトリを消す）
    const stop = new AbortController();
    const deadline = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        stop.abort();
        resolve("expired");
      }, limitMs);
      timer.unref?.();
    });
    const host = {
      platforms: config.platforms.map((p) => p.name),
      // 層の MCP サーバーをホストの同じ名前のものが置き換えるのは、ゲートウェイがあるときだけ（mcpRouting と同じ）
      mcp: this.deps.gateway ? config.hostMcp.map((m) => m.name) : [],
    };
    let next = 0;
    const work = async () => {
      while (next < targets.length) {
        const i = next++;
        const project = targets[i] as Project;
        const root = project.context as NonNullable<Project["context"]>;
        const fail = (detail: DaemonText) => {
          problems[i] = {
            text: message("secret.contextUnavailable", { project: project.name, detail }),
            projectId: project.id,
          };
        };
        const timedOut = () =>
          fail(message("secret.contextTimedOut", { seconds: Math.ceil(limitMs / 1000) }));
        if (expired) {
          timedOut();
          continue;
        }
        const usedSecrets: string[] = [];
        const reading = contextSecretSources(
          this.deps.contexts,
          root,
          (repo) => this.gitAuth({ projectId: project.id }, repo, usedSecrets),
          this.deps.defaultContext,
          stop.signal,
        );
        // 時間切れで止めた取得の失敗は、知らせない（時間切れとして知らせる。取得したリポジトリは消える）
        reading.catch(() => {});
        try {
          const sources = await Promise.race([reading, deadline]);
          if (sources === "expired") timedOut();
          else uses[i] = contextSecretUses(project, sources, host);
        } catch (error) {
          // 取得のエラー文には、認証のトークンが入りうるので伏せる
          fail(redactText(errorText(error), usedSecrets));
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(CONTEXT_SECRETS_CONCURRENCY, targets.length) }, work),
      );
    } finally {
      clearTimeout(timer);
    }
    return {
      uses: uses.flat(),
      problems: problems.filter((p): p is { text: DaemonText; projectId: string } => !!p),
    };
  }

  /** 一時停止中のタスクを再開する。予算で止まった場合は、累計の新しい上限が必要。 */
  resume(id: string, raw: unknown, options: { containersConfirmed?: boolean } = {}): Task {
    const input = ResumeTaskInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status !== "paused") {
      throw new InvalidOperationError(message("resume.notPaused"));
    }
    if (task.operationAttempted) throw new InvalidOperationError(message("operation.attempted"));
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
    // PR を作った工程（実装の PR と、要求要件・設計の PR）は、PR のマージで承認する（PBI-14a・PBI-57・PBI-110）
    const watched = gatePullRequest(task);
    if (watched && watched.step === step) {
      throw new InvalidOperationError(
        message("gate.approveOnPullRequest", { url: watched.url ?? "" }),
      );
    }
    const next = this.nextAfterApproval(task, step);
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
    // 実装のゲートでは、省略すると実装をやり直す
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
      // PR の指摘の戻し先の確認（PBI-58 より前の作業履歴）では、人間がどの工程を選んでも引き継ぐ（指摘は人間のレビューなので）
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
    // 統合レビュー（PBI-31）で合格にしたものを差し戻した場合も、見逃しとして記録する
    const review =
      input.step === "implement"
        ? task.lastReview
        : input.step === "integrate"
          ? task.integration
          : undefined;
    const missed =
      review?.passed && !task.misses.some((m) => m.reviewAt === review.at)
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

/**
 * オーケストレーター（テストでは planner）が選んだ工程。書き出し先（PBI-56）は、使える接続先と照らす前の形
 * （接続先の種類が無ければ名前で探す）。
 */
export type PlannedSteps = Omit<ChosenSteps, "exports" | "services" | "sharedComposes"> & {
  exports?: Partial<Record<StepKey, RawExportPlan>>;
  /** 作業するリポジトリと理由（対象リポジトリの無いタスクで、コードの変更が要るとき。PBI-73）。 */
  repo?: string;
  repoReason?: string;
  /** サービス（PBI-47）。共用の compose（PBI-70）は名前だけで、プロジェクトの設定と照らす前の形。 */
  services?: RawServices;
};

/**
 * 統合レビューで、子タスクのリポジトリを書き出すディレクトリの名前（PBI-73）。リポジトリの URL の末尾（owner と名前）から作り、
 * 同じ名前にならないように順番を前に付ける。
 */
function repositoryDirName(repo: string, index: number): string {
  const name = repo
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("__")
    .replace(/[^\w.-]/g, "_");
  return `${index + 1}-${name || "repo"}`;
}

/**
 * 既定のイメージで動かす工程の、images のどれも合わない理由と、理由が無い工程（PBI-105）。工程のイメージが無い・default なら
 * 既定のイメージで動く。理由は、既定のイメージで動く工程の分だけ残す。
 */
function defaultImagesOf(
  steps: readonly StepKey[],
  images: Partial<Record<StepKey, string>>,
  reasons: Partial<Record<StepKey, string>> | undefined,
): { defaultImageReasons?: Partial<Record<StepKey, string>>; imagesUnexplained?: StepKey[] } {
  const onDefault = steps.filter((step) => !images[step] || images[step] === DEFAULT_IMAGE_NAME);
  const explained = Object.fromEntries(
    onDefault.flatMap((step) => (reasons?.[step] ? [[step, reasons[step]]] : [])),
  ) as Partial<Record<StepKey, string>>;
  const unexplained = onDefault.filter((step) => !reasons?.[step]);
  return {
    ...(Object.keys(explained).length > 0 ? { defaultImageReasons: explained } : {}),
    ...(unexplained.length > 0 ? { imagesUnexplained: unexplained } : {}),
  };
}

/**
 * 対象リポジトリが要る工程（PBI-73）。対象リポジトリの無いタスクでは実行しない（コードを変える・PR を読む・PR を作る）。
 */
const REPO_STEPS: readonly StepKey[] = ["implement", "reproduce", "review"];

/**
 * 対象リポジトリの無いタスクの分割案で、子タスクごとのリポジトリを、プロジェクトの対象と照らす（PBI-73）。無い・対象に
 * 無いなら理由を返す（使わない）。登録した名前にそろえる。
 */
function splitWithRepositories(
  plan: { ok: true; reason: string; children: SplitChild[] },
  candidates: readonly string[],
): { ok: true; reason: string; children: SplitChild[] } | { ok: false; message: DaemonText } {
  const children: SplitChild[] = [];
  for (const child of plan.children) {
    if (!child.repo)
      return { ok: false, message: message("split.repoMissing", { key: child.key }) };
    const found = candidates.find((c) => sameGitHubUrl(c, child.repo ?? ""));
    if (!found) {
      return {
        ok: false,
        message: message("split.repoNotCandidate", { key: child.key, repo: child.repo }),
      };
    }
    children.push({ ...child, repo: found });
  }
  return { ...plan, children };
}

/** リポジトリの URL の、比べるためのキー（書き方の揺れをそろえ、大文字・小文字を区別しない。PBI-88）。 */
function repoKey(repo: string): string {
  return (parseRepoUrl(repo)?.url ?? repo).toLowerCase();
}

function sameRepo(a: string, b: string): boolean {
  return repoKey(a) === repoKey(b);
}

/** PR のレビューの取り込みのタスクの工程（レビューだけ。オーケストレーターは使わないので費用は無い。PBI-44）。 */
function reviewOnlySteps(via: "requested" | "label" | "sacty"): ChosenSteps {
  return {
    steps: [...STEP_PLANS.review],
    plan: "review",
    reason: message("review.reviewOnly", { via }),
    fallback: false,
    costUsd: 0,
    estimated: false,
  };
}

/** タスクの対象リポジトリ。 */
type TargetRepository = {
  url: string;
  /** 用意したベースブランチ（用意する前は無い。既定のブランチを clone する）。 */
  baseBranch?: string;
  /** オーケストレーターが決めたテストのコマンド（PBI-25）。 */
  testCommand?: string;
  testImage: string;
  /** テストのイメージの環境変数（言語ごとのイメージの env。PBI-41）。 */
  testEnv: Record<string, string>;
  pullRequest: { provider: "github"; repo: string };
};

/** テストのイメージと環境変数（PBI-41）。名前が images に無ければ既定のイメージ（使う前に確かめる）。 */
function testImageOf(
  config: SactyConfig,
  name: string | undefined,
): { testImage: string; testEnv: Record<string, string> } {
  const resolved = resolveImage(config, name);
  return resolved.ok
    ? { testImage: resolved.image, testEnv: resolved.env }
    : { testImage: config.image, testEnv: {} };
}

/** PR で承認する工程か（要求要件・設計。PBI-57）。 */
function isStepPullRequestKey(step: StepKey): step is StepPullRequestKey {
  return (StepPullRequestKey.options as readonly StepKey[]).includes(step);
}

/**
 * タスクブランチの名前（PBI-57）。実装の PR は、このブランチからベースブランチに向けて作る（タスクブランチの無いタスク
 * の実装の PR のブランチと同じ名前）。
 */
function taskBranchName(task: Pick<Task, "id">): string {
  return `sacty/task-${task.id.slice(0, 8)}`;
}

/**
 * sacty がプッシュしたブランチ（中止で消す）。実装の PR のブランチ（PR の作成に失敗しても記録してある）と、タスク
 * ブランチ・要求要件と設計のブランチ（PBI-57）。
 */
function sactyBranches(task: Task): string[] {
  const branches = [
    (task.pushedBranch ?? task.pullRequest)?.branch,
    task.taskBranch?.branch,
    ...task.stepBranches,
  ];
  return [...new Set(branches.filter((b): b is string => Boolean(b)))];
}

/** promise を待つ。その間に stopped が true になったら、待たずに whenStopped を返す（PBI-77）。 */
async function untilStopped<T>(
  promise: Promise<T>,
  stopped: () => boolean,
  whenStopped: T,
  pollMs = 200,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        const check = () => {
          if (stopped()) resolve(whenStopped);
          else timer = setTimeout(check, pollMs);
        };
        check();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** sacty が作った、要求要件・設計の PR のうち、閉じていない（と記録している）もの（PBI-57）。 */
function openStepPullRequests(task: Task) {
  return task.stepPullRequests.filter((p) => p.state === "open" && !p.superseded);
}

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

/**
 * 承認した成果を、決めた書き出し先に書き出すのを待っている工程（PBI-56）。一時停止中・実行中は書き出さない
 * （一時停止を再開したら書き出す）。
 */
function awaitingExport(task: Task): StepKey | undefined {
  if (task.status === "paused" || task.status === "running") return undefined;
  return exportDue(task);
}

/** 完了した調査のタスクで、結果をまだ取り込み元の Issue に返していないか（PBI-18）。 */
export function awaitingIssueComment(task: Task): boolean {
  return (
    isCompleted(task) &&
    // 書き出す成果は、書き出してから返す（コメントに URL を添えるため。PBI-56）
    exportDue(task) === undefined &&
    // 調査そのものが目的のタスクだけ（前段の調査の結果は返さない。PBI-29）
    investigationIsGoal(task) &&
    // Issue・PR・チケットから取り込んだタスク（PBI-26・PBI-52）
    (task.source !== undefined || task.ticket !== undefined) &&
    !task.issueComment
  );
}

/** 作った PR の URL を、取り込み元のチケットにコメントするのを待っている（PBI-52）。 */
export function awaitingTicketPrComment(task: Task): boolean {
  return (
    task.ticket !== undefined &&
    task.status !== "cancelled" &&
    Boolean(task.pullRequest?.url) &&
    !task.ticketPrComment
  );
}

/** Bedrock の OpenAI 互換の API の起点（Codex の組み込みのプロバイダーと同じ。PBI-37）。 */
function bedrockOrigin(auth: { region: string; endpoint?: "runtime" | "mantle" }): string {
  return (auth.endpoint ?? "runtime") === "runtime"
    ? `https://bedrock-runtime.${auth.region}.amazonaws.com`
    : `https://bedrock-mantle.${auth.region}.api.aws`;
}
