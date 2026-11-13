import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActivityEvent,
  type Actor,
  AdoptAuditProposalInput,
  type AgentRunContinuedReason,
  ANSWER_MAX,
  ApproveStepInput,
  AskQuestionInput,
  type AuditTarget,
  activeStep,
  applyEvent,
  auditOpen,
  awaitingDeploymentCheck,
  awaitingDeploymentCi,
  awaitingGathering,
  awaitingRepository,
  awaitingTicketTriage,
  BUDGET_WARN_RATIO,
  budgetState,
  ChangeStepAgentInput,
  ChangeTaskImageInput,
  type CiCheck,
  type CiFailure,
  type CleanupTarget,
  type ContinuedPullRequest,
  CreateTaskInput,
  CreateTemplateTaskInput,
  canDecideTests,
  canDerive,
  canOverrideVerification,
  canRereview,
  canRerun,
  canRetryExport,
  changeRounds,
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
  DeriveTaskInput,
  deploymentCheckRunning,
  derivedRecord,
  ERROR_ANALYSIS_MAX,
  EventInput,
  type ExportPlan,
  errorAnalysisBlocked,
  excludedRepositories,
  exportDue,
  exportSteps,
  findFlakyTest,
  fixDecisionPending,
  fixTaskOpen,
  flakyTests,
  GATED_STEPS,
  gatePullRequest,
  heldReview,
  humanAsks,
  type IntakeKind,
  implementationMerged,
  investigationIsGoal,
  isAuditTarget,
  isCompleted,
  isFinished,
  isRepoless,
  isSecurityTask,
  lastChangeRound,
  latestStepPullRequest,
  MAX_BASE_CONFLICTS,
  MAX_CHANGE_REQUESTS,
  MAX_FIX_CHAIN,
  MAX_INTEGRATION_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS,
  MEMORY_BODY_MAX,
  MEMORY_SUMMARY_MAX,
  MEMORY_TITLE_MAX,
  type MemoryMove,
  mapFreeText,
  mergeProjectDefinitions,
  message,
  nextAuditDive,
  OperationSettings,
  openProposal,
  type PauseReason,
  type Project,
  ProjectDefinition,
  ProjectExport,
  type ProjectFlakyTests,
  type PullRequestMerge,
  type PullRequestTemplateUse,
  parseOrgUrl,
  parseRepoUrl,
  pendingErrorAnalysis,
  pendingHeadMerge,
  pendingQuestion,
  project,
  projectConflicts,
  proposalAccepted,
  pullRequestBodyKey,
  questionBlocked,
  queueOverSince,
  RejectAuditProposalInput,
  RenameTaskInput,
  RepoUrl,
  RequestChangesInput,
  RequestSecurityFixInput,
  RerunTaskInput,
  ResumeAuditInput,
  ResumeTaskInput,
  renderMessage,
  repoKey,
  responsibleProject,
  responsibleTicketProject,
  resumeNoteRoom,
  reviewedPullRequest,
  reviewReworkTarget,
  reworkingPullRequest,
  reworkTargets,
  SactySettings,
  type ScheduledTaskSettings,
  SELF_REVIEW_STEPS,
  type SecurityCategory,
  type SecurityFinding,
  type SharedCompose,
  STEP_PLANS,
  StepKey,
  type StepPlan,
  StepPullRequestKey,
  type StepSettingMap,
  sameAuditTarget,
  sameGitHubUrl,
  skippableSteps,
  stepAgentChangeable,
  stepDocumentPath,
  stepImageOf,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
  type Task,
  type TaskProposal,
  type TicketService,
  type TriageKind,
  targetHost,
  targetImageOf,
  taskPlan,
  exportProject as toProjectExport,
  unreflectedImplementRemarks,
  type VerificationRecord,
  verificationImageOf,
  workBaseCommit,
} from "@sacty/core";
import { ZodError } from "zod";
import type { ActivityStore } from "./activity.js";
import { archivedFilePath, type CheckedAgentFile, checkArchivedFiles } from "./agent-sessions.js";
import { type RunCost, runCost } from "./agents/cost.js";
import { type AgentExecutor, CONTAINER_INPUT_DIR, CONTAINER_REVIEW_DIR } from "./agents/docker.js";
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
import { type PlacedTier, selectTiers, tierFiles } from "./agents/tiers.js";
import { aiReviewFor, aiReviewOfHead } from "./ai-review-head.js";
import { auditCounts, countToolFailures, redactDeep, redactStagedFiles } from "./audit-evidence.js";
import {
  type AdoptedAuditProposalNote,
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
  COMMIT_CONVENTION_FILES,
  type CommitKind,
  commitSubject,
  detectCommitConvention,
} from "./commit-message.js";
import {
  type AgentConfig,
  agentFor,
  agentSetting,
  type ConfigResult,
  DEFAULT_FALLBACK_COOLDOWN_MINUTES,
  DEFAULT_IMAGE_NAME,
  definedAgent,
  fallbackAgentFor,
  githubRepoOf,
  hasImage,
  imageDefined,
  type LanguageImage,
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
  contextImages,
  contextPlatforms,
  contextSecretSources,
  GATEWAY_TOKEN_SECRET,
  type GatewayMcpServer,
  type HostedMcpRelay,
  type McpRouting,
  prepareContext,
  previewContext,
} from "./context.js";
import type { ContextImageBuilder, ContextImagesView } from "./context-images.js";
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
import { buildErrorReport, type ReportLocale } from "./error-report.js";
import { AgentTimeoutError, errorText, MessageError } from "./errors.js";
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
  isTransientGitHubFailure,
  type PullRequestFeedback,
  type PullRequestStatus,
  type PullRequests,
  type SactyReviewRound,
  sactyReviewKey,
  sactyReviewTask,
} from "./github.js";
import {
  buildGitHubComment,
  commentAllowed,
  githubCommentMarker,
  mentionsGitHubComments,
  requestedGitHubComments,
} from "./github-comments.js";
import { githubPromptLines, githubRelayEnv } from "./github-relay.js";
import { buildHumanAskNotice, humanAskMarker } from "./human-ask-notice.js";
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
import { requesterTexts } from "./memory-answers.js";
import type { FeedReply, NotificationFeed } from "./notification-feed.js";
import { notificationFor, type SlackNotifier } from "./notifier.js";
import { CONTAINER_HANDOFF_DIR, stageHandoff } from "./orchestrator-handoff.js";
import type { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import {
  mergePlatforms,
  type Platform,
  type PlatformSummary,
  platformPromptLines,
  platformSummary,
  readOnlyPlatforms,
} from "./platforms.js";
import {
  buildPullRequestBodyMergePrompt,
  extractMergedPullRequestBody,
  mergePullRequestBody,
  normalizeNewlines,
} from "./pr-body-merge.js";
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
  answerMarker,
  type BodyParts,
  type BodyText,
  buildChatPrompt,
  buildChildBody,
  buildErrorAnalysisPrompt,
  buildExportDocument,
  buildExportPrompt,
  buildGatherPrompt,
  buildIntegrationReviewPrompt,
  buildInvestigationComment,
  buildOrchestratorPrompt,
  buildPrompt,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildRerunBody,
  buildReviewBody,
  buildReviewComments,
  buildReviewImagePrompt,
  buildReworkPrompt,
  buildStepDocument,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
  buildStepPullRequestTitle,
  buildStepReviewPrompt,
  buildTicketInvestigationComment,
  buildTicketPullRequestComment,
  buildTicketTriagePrompt,
  type ChatLogs,
  changeableSteps,
  checkProvenance,
  continuablePullRequest,
  deriveBody,
  deriveRecord,
  ERROR_REPORT_FILE,
  EXECUTABLE_STEPS,
  EXPORT_FILE,
  type ExportDestination,
  extractBlocks,
  extractDocumentPages,
  extractExport,
  extractGathered,
  extractIntegrationReview,
  extractReproduction,
  extractReviewComments,
  extractReviewImage,
  extractRework,
  extractSplitPlan,
  extractStepPlan,
  extractStepReview,
  extractTicketTriage,
  integrationViewpointIds,
  investigationMarker,
  lineContextText,
  operationSucceeded,
  passedContinuedFeedback,
  postedLatestCommit,
  provenanceIds,
  provenanceInputs,
  pullRequestInText,
  type RawExportPlan,
  type RawServices,
  type ReviewCi,
  type ReviewReworkContext,
  type ReviewSecurity,
  referencedPullRequest,
  reviewMarker,
  type SplitChild,
  STEP_NAME,
  type SubtaskSummary,
  selectablePlans,
  servicePromptLines,
  skippedFilesLines,
  verificationBasis,
  viewpointRename,
  withoutInternalPaths,
  withoutWorkReport,
} from "./prompts.js";
import { CONTAINER_LOGS_DIR, stageQuestionLogs } from "./question-logs.js";
import { NothingToCommitError, type RepositoryWorkspace } from "./repository.js";
import {
  buildResolvedNotice,
  buildStopNotice,
  isOpenStopNotice,
  notifiesReviewStop,
  stopKey,
  stopMarker,
  stopMarkerOfTask,
  stopSummary,
} from "./review-stop-notice.js";
import { agentTimeoutMs } from "./run-timeouts.js";
import {
  contextSecretUses,
  type SecretUse,
  secretUses,
  settingsSecretUses,
  uniqueUses,
} from "./secret-uses.js";
import { type PrefetchingSecretStore, SecretNotFoundError, type SecretStore } from "./secrets.js";
import {
  isSecurityFix,
  scopeViolation,
  securityFindings,
  securityFixTask,
  securityScope,
} from "./security.js";
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
import { prepareTaskCache, taskCachePromptLines } from "./task-cache.js";
import { templateTask } from "./task-templates.js";
import { findTestFiles, noTestsStop } from "./test-files.js";
import { type FoundTicket, type TicketClient, ticketErrorText } from "./tickets.js";
import {
  type ContinuePlan,
  planTimeoutResume,
  timeoutMinutes,
  timeoutResumeLines,
} from "./timeout-resume.js";
import type { UpdateStatus } from "./update-check.js";
import {
  CODE_COPY_DIR,
  idEntries,
  overlapsMounts,
  RUN_SCRATCH_DIRS,
  removeEntry,
  TASK_CACHE_DIR,
  taskCachePath,
  taskWorkspacePaths,
  workspaceRetirable,
} from "./workspace-cleanup.js";

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
/** スケジュールタスクの内容を、画面の作成と同じ入力にする（リポジトリが無ければ、リポジトリを指定しない）。 */
function scheduledTaskInput(projectId: string, settings: ScheduledTaskSettings): unknown {
  if (settings.template) {
    return {
      template: settings.template,
      projectId,
      ...(settings.repo ? { repo: settings.repo } : {}),
    };
  }
  return {
    title: settings.title,
    body: settings.body,
    projectId,
    repo: settings.repo ?? null,
    ...(settings.plan ? { plan: settings.plan } : {}),
  };
}

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
 * ローカルのセッション（`sacty launch`）。置くファイル（設定のディレクトリからの相対パス・どの層のものか・base64 の中身）、
 * AI の CLI に渡す環境変数（MCP の秘密情報とゲートウェイのトークンの値を含む）、MCP サーバーの名前、注意。
 */
export type LocalSessionView = {
  id: string;
  runtime: "claude-code" | "codex";
  files: { path: string; from?: string; content: string }[];
  env: Record<string, string>;
  mcpServers: string[];
  warnings: DaemonText[];
};

/**
 * プロジェクトのコンテキストのプレビュー（PBI-76）。platforms は、ホストの PF とあわせた使える外部 PF の要約（秘密情報の
 * 名前・値は含めない）。
 */
export type ContextPreviewView = Omit<ContextPreview, "platforms"> & {
  platforms: PlatformSummary[];
};

/** すべての工程で使うと決まっているイメージ（再実行で人が指定した・プロジェクトの対象で指定した。PBI-41）。 */
type PinnedImage = { name: string; source: "project" | "rerun" | "request" };

function clipText(text: DaemonText, max: number): DaemonText {
  return mapFreeText(text, (value) => (value.length > max ? `…${value.slice(-max)}` : value));
}

type ActivityItem = { actor: Actor; event: EventInput };
/** 実装の作り直しを、PR のマージで止めたときの段階（ReworkStoppedByMerge。PBI-276）。 */
type ReworkStage = Extract<EventInput, { type: "ReworkStoppedByMerge" }>["payload"]["was"];

/** 情報収集のまとめと、読んで関係があると判断した情報源。 */
export type GatheredInformation = { brief: string; sources: { title: string; url?: string }[] };

/** 実行に渡すコンテキストと、置いた段階のサブエージェントの定義（PBI-119）。 */
type RunContext = Awaited<ReturnType<typeof prepareContext>> & { tiers: PlacedTier[] };

export type CleanupItem = { target: CleanupTarget; present: boolean; detail?: DaemonText };
type CleanupResult = {
  target: CleanupTarget;
  result: "done" | "skipped" | "failed";
  detail?: DaemonText;
};

/**
 * 起動したサービスに、エージェントのコンテナ（工程）からつなぐ設定（PBI-47）。ネットワークと、
 * localhost に転送するポート（PBI-60。転送するものが無ければ渡さない）。
 */
function serviceConnection(started: StartedServices): {
  network: string;
  forwards?: LocalForward[];
} {
  const { forwards } = localForwards(started.services);
  return { network: started.network, ...(forwards.length > 0 ? { forwards } : {}) };
}

/**
 * 実装の工程の後の、PR の作成の前の確かめ（競合の目印・セキュリティ対応の修正の範囲）を待っているか。変更の申し出の判断待ちの
 * 間は進めない。最終レビュー・CI の待ちの途中だった以前の版のタスクも、ここから新しい流れに乗る（PBI-331）。
 */
function awaitingVerification(task: Task): boolean {
  return task.status === "idle" && task.verification !== undefined && !openProposal(task);
}

/** 戻し先の判断の記録の担い手（PBI-332）。レビューの子タスクの答えから決めたなら sacty、工程のエージェントが判断したなら agent。 */
function reworkActor(judged: { reviewTaskId?: string }): "sacty" | "agent" {
  return judged.reviewTaskId ? "sacty" : "agent";
}

/** PR のレビューの子タスクの、最後に投稿した回の判定が指摘なしか（PBI-331）。 */
function reviewCleared(child: Task): boolean {
  const last = child.reviewVerdicts?.at(-1);
  return last?.verdict === "no_findings" && last.round === (child.reviewRound ?? 1);
}

/** 一時的な失敗のやり直しの途中で、やり直しをやめた（止める・中止・デーモンの停止）。何も記録せずに処理を終える。 */
class RetryAbandoned extends Error {}

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
  /**
   * sacty が作った PR をレビューする子タスクを作る（PBI-330）。既定は作らない（工程の流れだけを確かめるテストで、子タスクが
   * エージェントの実行を使わないように）。main.ts が有効にする。
   */
  reviewTasks?: boolean;
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
  /**
   * オーケストレーターの代わりに工程を見直す（テストで差し替える。工程の見直し）。planner を差し替えて、これを差し替えない
   * ときは見直さない（工程を選ぶオーケストレーターがいないため）。
   */
  stepReviewer?: (
    task: Task,
    after: StepKey,
    skippable: readonly StepKey[],
  ) => Promise<{ steps: StepKey[]; reason: string }>;
  /**
   * 情報収集のエージェントの代わりに情報を集める（テストで差し替える）。undefined を返すと、集めずに進める
   * （記録しない）。
   */
  gatherer?: (task: Task) => Promise<GatheredInformation | undefined>;
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
  /**
   * PR のレビューの子タスクが、レビューの準備で先頭のコミットの CI を読むのを待つ上限（ミリ秒。PBI-331）。既定は
   * REVIEW_CI_TIMEOUT_MS。超えたら、読めなかったものとしてレビューを続ける。
   */
  reviewCiTimeoutMs?: number;
  /**
   * レビューを待つ実装の PR のドラフトを外す・戻す・先頭を読むときに、GitHub の答えを待つ上限（ミリ秒。PBI-331）。既定は
   * DRAFT_TIMEOUT_MS。超えたら、答えを受け取れなかったものとして扱う。
   */
  draftTimeoutMs?: number;
  /** タスクごとの作業領域を作る場所。 */
  workspaceRoot: string;
  /**
   * 動いているコンテナがマウントしているホストの場所（作業領域を消す前に確かめる。PBI-157）。Docker に問い合わせられなければ
   * undefined を返す（消さない）。無ければ、動いているコンテナは無いものとする。
   */
  containerMounts?: () => Promise<string[] | undefined>;
  /** 作業領域の根の下のものを消す口（PBI-157。テストで、消せないときを作るために差し替える）。無ければ removeEntry。 */
  removeWorkspaceEntry?: (root: string, path: string) => Promise<boolean>;
  /** ホストのゲートウェイ（PBI-37）。無ければ、ゲートウェイ経由のエージェントは実行できない。 */
  gateway?: Pick<AiGateway, "containerOrigin" | "register" | "platformsUrl" | "githubUrl"> &
    Partial<Pick<AiGateway, "hostOrigin">>;
  /** 認証情報を用意できない組織内 PF の理由（画面の状態に出す。PBI-35）。 */
  platformProblems?: (names: readonly string[]) => DaemonText[];
  /** 準備ができないホストの MCP サーバーの理由（画面の状態に出す。PBI-36）。 */
  hostMcpProblems?: () => DaemonText[];
  /** Docker が動いていない・手元に無い・版の違うエージェントのイメージ（起動のときと1分ごとに確かめる。PBI-148）。 */
  imageProblems?: () => DaemonText[];
  /**
   * コンテキストリポジトリの images.yaml のイメージ（PBI-325）。デーモンが裏で作る。無ければ、コンテキストのイメージは
   * 使わない（config.yaml の images だけ）。
   */
  contextImages?: Pick<ContextImageBuilder, "images" | "pending" | "view" | "rebuild" | "refresh">;
  /** コンテキストのイメージを作り終えるのを待つ上限（ミリ秒。PBI-325）。無ければ CONTEXT_IMAGES_WAIT_MS。 */
  contextImagesWaitMs?: number;
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
  /** 画面のデスクトップ通知のための、最近の通知の一覧。無ければ持たない。 */
  feed?: Pick<NotificationFeed, "add" | "since">;
  /**
   * 起動した画面の URL（PBI-292。レビューが止まったことを PR に知らせる投稿に、タスクの画面へのリンクとして入れる）。
   * 無ければ http://127.0.0.1:4700。
   */
  webUrl?: string;
  /**
   * レビューが止まったことの PR への知らせ（投稿・解消済みへの書き換え）の、処理全体の期限（ミリ秒。PBI-292）。既定は 30 秒。
   * 超えたら通信も止めて、警告にして終える（実行の枠を放す）。
   */
  stopNoticeTimeoutMs?: number;
  /**
   * Sacty のレビューのタスクが、GitHub の一時的な失敗（5xx・レート制限・接続の失敗）で止まりそうなとき、自動でやり直すまでの
   * 待ち時間（ミリ秒）の並び（PBI-301）。長さが、やり直しの回数の上限。既定は 15 秒・1 分・3 分・5 分の 4 回（計 9 分余り）。
   */
  reviewRetryDelaysMs?: readonly number[];
  /**
   * 要求要件・設計を、対象のリポジトリへの PR のマージで承認するか（PBI-57）。既定は承認する（PR を作れるタスクだけ）。
   * false なら、これまでどおり sacty の画面で承認する（画面の承認の流れを確かめるテストで切る）。
   */
  stepPullRequests?: boolean;
  /**
   * 実装の PR をドラフトで作り、PR のレビューの子タスクの指摘なしまでドラフトのまま待つか（PBI-331）。既定は待つ。
   * false なら、ドラフトにせずに実装の承認待ちにする（ドラフトの扱いを確かめないテストで切る）。
   */
  draftPullRequests?: boolean;
  /**
   * 実装の作業領域に、ベースブランチの最新を取り込むか（実装を始めるとき。取り込んだら、提出する
   * コミットはベースブランチの先頭を第2の親にしたマージコミットになる）。既定は取り込む。false なら取り込まない
   * （取り込みを確かめないテストで切る）。
   */
  mergeBase?: boolean;
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
  /**
   * Docker とエージェントのイメージの注意（Docker が動いていない・docker が無い・イメージが無い・版が違う。PBI-148）。
   * 起動のときと1分ごとに確かめた結果。warnings と分けて、画面はどの画面でも出す。
   */
  docker: DaemonText[];
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
  /**
   * コンテキストのイメージの作成の状況（PBI-325）。コンテキストのイメージがあるプロジェクトだけ。画面はどの画面でも、
   * 作成中・失敗したものを出す。
   */
  contextImages?: ContextImagesView[];
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
/** 使った分の全体を読めなかった実行の印（イベントの costUnknown。読めたならイベントには持たせない。PBI-281）。 */
function unknownCost(run: { costUnknown?: boolean | undefined }): { costUnknown?: true } {
  return run.costUnknown ? { costUnknown: true } : {};
}

/** エージェントの実行の結果（費用を含む）。 */
type Executed = {
  outcome: AgentOutcome;
  costUsd: number;
  estimated: boolean;
  /** 使った分の全体を読めなかった（costUsd は読めた分の下限で、無ければ 0。時間切れなど。PBI-281）。 */
  costUnknown?: true;
};

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
  /** エージェントの形式に変換したコンテキスト（工程エージェントとオーケストレーター。PBI-6・PBI-146）。 */
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
  /**
   * タスクごとの依存のキャッシュを使う（PBI-319）。タスクのイメージで対象のリポジトリを扱う実行（工程・最終レビュー・
   * 統合レビュー）だけ。
   */
  taskCache?: true;
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
 * - Claude Code（2.1.318 の本体で確かめた）：セッションが見つからない `No conversation found with session ID: <ID>`、
 *   読み込めない `--resume session load failed (…)`・`Failed to resume session <ID>`。どれも終了コード 1
 * - Codex（codex-cli 0.167.0 の本体で確かめた）：`no rollout found for thread id <ID>`・
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

/**
 * PR のレビューの子タスクが、レビューの準備で先頭のコミットの CI を読むのを待つ上限（PBI-331）。GitHub が答えなくても、
 * レビューを始められないままにしない（過ぎたら、読めなかったものとしてレビューを続ける）。
 */
export const REVIEW_CI_TIMEOUT_MS = 30_000;

/**
 * レビューを待つ実装の PR のドラフトを外す・戻す・先頭を読むときに、GitHub の答えを待つ上限（PBI-331）。GitHub が答えないまま
 * 待ち続けて、ドラフトに戻すことも次の確認もできなくなるのを防ぐ（過ぎたら、答えを受け取れなかったものとして扱う）。
 */
export const DRAFT_TIMEOUT_MS = 30_000;

/** PR のレビューの子タスクの流れ（PBI-331）の実装の PR か（指摘なしを待つ・指摘なしで外して記録した）。 */
function reviewFlowPullRequest(pr: { awaitingReview?: boolean; reviewedCommit?: string }): boolean {
  return pr.awaitingReview === true || pr.reviewedCommit !== undefined;
}

/**
 * 開いている PR の答えにドラフトか（draft）が無ければ、デーモンのログに残す（PBI-331。ドラフトを合わせられないので、
 * 次の確認でやり直す）。
 */
function warnDraftUnknown(number: number, repo: string): void {
  console.warn(
    `[daemon] PR #${number}（${repo}）がドラフトかを GitHub の答えから読めなかったので、ドラフトを合わせませんでした（次の確認でやり直します）`,
  );
}

/**
 * PR の確認で、実装の PR の先頭・ドラフトを同時に読む数（PBI-331。reconcileReviewTasks・settlePausedDrafts。答えが返らない
 * PR が続いても、1つずつ待たない）。
 */
export const DRAFT_CHECK_CONCURRENCY = 4;

/** items を、同時に limit 件ずつ fn で処理する（PBI-331）。 */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
}

/**
 * 答えを待つのをやめたドラフトの切り替えの要求を、終わっていない要求として数える上限（DRAFT_TIMEOUT_MS の倍数。PBI-331）。
 * 通信を中断しても終わらない要求で、ずっとドラフトを外せなくならないようにする。
 */
export const DRAFT_SETTLE_FACTOR = 10;

/** 答えが ms のうちに返らなければ、時間切れの失敗にする（PBI-331）。時間切れの後に届いた失敗は知らせない。 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${ms} ミリ秒のうちに答えが返りませんでした`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * コンテキストのイメージ（PBI-325）を作り終えるのを、タスクが待つ上限（60分）。イメージの作成（OS のパッケージやブラウザの
 * 導入など）には時間がかかるので長めにする。過ぎたら、理由を示して止める。
 */
export const CONTEXT_IMAGES_WAIT_MS = 60 * 60_000;

/** 秘密情報をまとめて取り出すときに、同時に読むプロジェクトのコンテキストの数（PBI-107）。 */
export const CONTEXT_SECRETS_CONCURRENCY = 4;

export class TaskService {
  private tasks: Map<string, Task>;

  private intakeRuns: Partial<Record<IntakeKind, IntakeRun>> = {};
  private settingsSaves = 0;
  /** 実行中のタスクと、そのタスクで動いているコンテナ（一時停止・中止で止めるため）。 */
  private readonly inflight = new Map<string, { runIds: Set<string>; done: Promise<void> }>();
  /** コンテキストのイメージを作り終えるのを待っているタスクと、待ち始めた時刻（PBI-325）。 */
  private readonly contextImageWaits = new Map<string, number>();
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
  /** 承認待ちの PR の、PR の確認で最後に読んだ head（タスク → PR の番号・提出したコミット・読んだ head。PR #304 のレビュー）。 */
  private readonly latestHeads = new Map<
    string,
    { number: number; commit: string; head: string; draft?: boolean }
  >();
  /** 共用の compose の取得（deps に無いときの既定。PBI-70）。 */
  private defaultSharedComposes: SharedComposeFetcher | undefined;
  /** 中止の後片付けをしているタスク（その間に実行を始めないため）。 */
  private readonly cancelling = new Set<string>();
  /**
   * PR の向き先を付け替えている途中のタスク（PBI-317）。その間は実行しない（差し戻しの後の再提出と、付け替え・ドラフトの
   * 切り替えが混ざらないように。付け替えは、実行中のタスクでは始めない）。
   */
  private readonly retargeting = new Set<string>();
  /** PR のレビューの子タスクの指摘なしで、ドラフトを外している最中のタスク（PBI-331）。 */
  private readonly readying = new Set<string>();
  /**
   * このデーモンの起動の後に、レビューの確認でドラフトに戻せた、レビューを待つ実装の PR（PBI-331。タスク ID と提出した
   * コミット）。同じ提出では、もう戻さない（再起動の後は、台帳の draft にかかわらず1回戻す）。
   */
  private readonly redrafted = new Set<string>();
  /**
   * ドラフトを外した後に戻そうとして戻せなかった、レビューを待つ実装の PR（PBI-331。タスク ID と提出したコミット）。台帳には
   * draft が残るので、GitHub でドラフトに戻せたと確かめられるまで、確認のたびに戻す。
   */
  private readonly redraftPending = new Set<string>();
  /**
   * ドラフトを外す要求の答えを受け取れなかった（時間切れ・失敗）、レビューを待つ実装の PR（PBI-331。タスク ID と PR の番号。
   * 提出をまたいで引き継ぐ）。外す要求が後から届いてドラフトが外れるかもしれないので、指摘なしで外して記録するまで、確認の
   * たびにドラフトに戻す。
   */
  private readonly undraftUnsettled = new Set<string>();
  /**
   * 答えを待つのをやめた後も、まだ終わっていないドラフトの切り替えの要求の数（PBI-331。タスク ID と PR の番号）。終わるまで
   * ドラフトを外さない（後から届いた戻す要求で、外した PR がドラフトに戻り、記録と食い違うのを防ぐ）。
   */
  private readonly draftRequests = new Map<string, number>();
  /** 実装の PR がマージされたので、作り直しの実行を止めているタスク（PBI-276）。止めた実行は、一時停止にしない。 */
  private readonly mergeStopping = new Set<string>();
  /**
   * 人が再開したタスク（メモリーだけ）。止まった工程を走り直す前に、PR に届いた指摘をもう一度読む（PBI-279。一時停止の間の
   * 確認は一定の間隔なので、再開の直前に書かれた指摘も拾う）。デーモンの再起動で消えても、残しておいた指摘は作業履歴にある。
   */
  private readonly heldRecheck = new Set<string>();
  /**
   * PR のフィードバックを、このデーモンが初めて見た時刻（タスクの ID → フィードバックの key → 時刻。メモリーだけ）。
   * 書き終わるのを待つ時間は、GitHub の時刻だけでなく、これも使って数える（PBI-270）。
   */
  private readonly feedbackSeenAt = new Map<string, Map<string, number>>();
  /** レビュー用のラベルを付けている途中の PR（タスクと PR。重ねて付けないため。PBI-88）。 */
  /**
   * 質問に答えているタスクと、その実行（PBI-54）。工程の実行とは別に持つ（一時停止では止めず、中止では止める）。
   */
  private readonly chats = new Map<string, { runId: string; done: Promise<void> }>();
  /** エラーの分析をしている実行（タスクごとに1つ。止めるための実行の ID と、終わり）。 */
  private readonly analyses = new Map<string, { runId: string; done: Promise<void> }>();
  /** 作業領域を消している途中のタスク（消し終わるまでの Promise。作り直す・読む前に待つ。PBI-157）。 */
  private readonly retiring = new Map<string, Promise<void>>();
  /** 作業領域を用意している途中のタスク（用意を1つずつにする。PBI-157 レビュー指摘）。 */
  private readonly preparing = new Map<string, Promise<unknown>>();
  /** ほかのタスク（統合レビューの親）が読んでいる子タスクの作業領域と、読んでいる数（その間は消さない）。 */
  private readonly borrowed = new Map<string, number>();
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
   * 画面に返すタスクと作業履歴。承認待ちの PR の今の head に、sacty の AI のレビューが付いているかを足す（PBI-302 D1）。
   * ほかのタスクを見て計算するので、タスクの状態（作業履歴から復元するもの）には持たない。
   */
  /**
   * 承認待ちの PR の、PR の確認で最後に読んだ head（PR #304 のレビュー）。読んだときの PR の番号と提出したコミットが今の
   * 承認待ちの PR と同じときだけ使う（作り直して別の PR・別の提出になったら、読み直すまで分からない）。
   */
  private latestHeadOf(task: Task): string | undefined {
    const pr = gatePullRequest(task);
    const seen = this.latestHeads.get(task.id);
    if (!pr || !seen || seen.number !== pr.number || seen.commit !== pr.commit) return undefined;
    return seen.head;
  }

  view(id: string): { task: Task; activity: ActivityEvent[] } | undefined {
    const found = this.get(id);
    if (!found) return undefined;
    const aiReview = aiReviewOfHead(
      found.task,
      this.tasks.values(),
      sameRepo,
      this.latestHeadOf(found.task),
    );
    return aiReview ? { ...found, task: { ...found.task, aiReview } } : found;
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
    // 実装の作り直しの間に、実装の PR がマージされたタスクは、作り直しを止めて承認として進める（PBI-276）
    await this.checkReworkMerges();
    // 重ねた子タスクの承認待ちの PR の向き先を、依存先の PR のマージの後のブランチに付け替える（PBI-317）
    // 前のタスクの GitHub の操作を待つ間に、後のタスクが変わりうるので、ID ごとにその時点の最新で決める
    for (const id of [...this.tasks.keys()]) {
      const task = this.tasks.get(id);
      if (task && this.retargetDue(task) && !this.cancelling.has(id) && !this.inflight.has(id)) {
        await this.retargetPullRequest(task);
      }
    }
    // 一時停止の間に実装の PR に届いた指摘を、未反映として残す（PBI-279）
    await this.checkHeldFeedback();
    // 実装の PR と、要求要件・設計の PR（PBI-57・PBI-110）
    const waiting = [...this.tasks.values()].filter(
      (t) =>
        (t.status === "awaiting_approval" || t.status === "escalated") && gatePullRequest(t)?.repo,
    );
    // 指摘を取り込む対象から外れたタスク（完了・中止・差し戻し・マージなど）の、初めて見た時刻は忘れる（常駐中に増え続けないため。PBI-270）
    const importing = new Set(
      waiting.filter((t) => t.status === "awaiting_approval").map((t) => t.id),
    );
    for (const id of [...this.feedbackSeenAt.keys()]) {
      if (!importing.has(id)) this.feedbackSeenAt.delete(id);
    }
    // 指摘の取り込みの間に PR がマージされた・閉じられたタスクは、状態を読み直して一度だけ確かめ直す
    const rechecked = new Set<string>();
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
        // 開いたままの PR は、ベースブランチとの競合を画面に出し（取り込まない）、レビュー・コメントを指摘として取り込む
        // （PBI-14b・PBI-57）
        if (status.state === "open" && latest.status === "awaiting_approval") {
          // PR が開いている間の最新の head（提出したコミットとは別。人が足したコミットで変わる。PR #304 のレビュー）
          const head = status.headSha?.trim();
          if (head) {
            this.latestHeads.set(task.id, {
              number: pr.number,
              commit: pr.commit,
              head,
              ...(status.draft !== undefined ? { draft: status.draft } : {}),
            });
          } else this.latestHeads.delete(task.id);
          latest = this.recordPullRequestConflict(latest, pr, status.mergeable) ?? latest;
          // 指摘なしでドラフトを外した実装の PR が、GitHub でドラフトに戻っていたら外し直す。指摘なしを待つ実装の PR の
          // ドラフトが外れていたら、ドラフトに戻す（PBI-331。GitHub の状態で決めるので、再起動の後も、後から届いた要求も直す）
          if (status.draft !== undefined && pr.step === "implement") {
            await this.settleDraft(task.id, pr.repo, pr.number, pr.commit, token, {
              draft: status.draft,
              ...(head ? { head } : {}),
            });
            latest = this.tasks.get(task.id) ?? latest;
          } else if (pr.step === "implement" && reviewFlowPullRequest(latest.pullRequest ?? {})) {
            warnDraftUnknown(pr.number, pr.repo);
          }
          try {
            const settled = await this.importFeedback(latest, token);
            if (settled === "pull_request_changed" && !rechecked.has(task.id)) {
              rechecked.add(task.id);
              const again = this.tasks.get(task.id);
              if (again) waiting.push(again);
            }
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
        this.append(
          latest,
          this.mergeApprovalItems(latest, { ...pr, repo: pr.repo }, status, document),
        );
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
    // 承認待ちの PR のレビューの子タスク：止まって作れなかったものを作り、親が PR を更新していたら再レビューする（PBI-330）
    await this.reconcileReviewTasks();
    // 一時停止したタスクの実装の PR のドラフト（PBI-331）
    if (this.deps.reviewTasks === true) await this.settlePausedDrafts();
    // マージの後の CI/CD とデプロイの監視（PBI-89）
    await this.checkDeployments();
  }

  /**
   * 一時停止中のタスクの実装の PR に届いた指摘（人の指摘と、sacty 自身の AI のレビューの指摘）を、未反映として残す（PBI-279）。
   * 差し戻しにはしない。再開したあと、止まった工程を走り直す前に、ゴールガーディアンに戻し先を判断させて反映する
   * （reworkHeldReview）。予算の上限で止まったタスクも、エラーで止まったタスクも、人が止めたタスクも同じに扱う。
   * PR は、プロジェクトの gh のアカウントで確かめる。確かめられないタスクは、次の確認でやり直す。
   */
  private async checkHeldFeedback(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      if (task.status !== "paused" || task.pendingReview?.judgement) continue;
      const pr = reworkingPullRequest(task);
      if (!pr?.repo || this.cancelling.has(task.id) || this.mergeStopping.has(task.id)) continue;
      const usedSecrets: string[] = [];
      try {
        const token = await this.githubToken(task, pr.repo, usedSecrets);
        await this.holdFeedback(task.id, token);
      } catch (error) {
        console.warn(
          `[daemon] PR #${pr.number}（${pr.repo}）に届いた指摘を確認できませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
      }
    }
  }

  /**
   * 実装の PR にまだ取り込んでいない指摘を読み、未反映として残す（PBI-279）。承認待ちの取り込み（importFeedback）と同じく、
   * 古い head への AI のレビューは捨て、取り込み済みの指摘は読み直さない。書き終わるのを待たない（反映は再開のときなので、
   * 続きの指摘は続けて足す）。未反映の指摘は合計で承認待ちの取り込みと同じ上限（REMARKS_MAX）まで。上限に達している間は
   * 読んでも足さず、超えた分は取り込み済みにしない（反映した後、通常の取り込みが取り込む）。
   * 一時停止中の確認（resumed が false）は、読んでいる間に再開された（実行待ち・待機になった）なら足さない
   * （再開した後の判断と食い違わないよう、再開した後は反映の側（reworkHeldReview）だけが足す）。
   * PR の head を確かめられず、AI のレビューを今回は扱えなかったときは false を返す（呼び出し元は、確かめ直すまで待つ）。
   */
  private async holdFeedback(taskId: string, token: string, resumed = false): Promise<boolean> {
    const task = this.tasks.get(taskId);
    const pr = task ? reworkingPullRequest(task) : undefined;
    if (!task || !pr?.repo || this.cancelling.has(taskId) || task.pendingReview?.judgement) {
      return true;
    }
    let headUnknown = false;
    const listed = (
      await this.deps.pulls.feedback({
        repo: pr.repo,
        token,
        number: pr.number,
        ...this.githubAccountOf(task, pr.repo),
        ...this.sactyReviewsOf(pr.repo, pr.number),
      })
    )
      .filter((item) => !task.importedFeedback.includes(item.key))
      .filter((item) => !handedOverFeedback(task, pr, item));
    const fresh = await this.withoutStaleReviews(
      taskId,
      { repo: pr.repo, number: pr.number },
      token,
      listed,
      "held",
      () => {
        headUnknown = true;
      },
    );
    // 読んでいる間に、実行が始まった・別の状態になった・人が反映の判断を始めたなら、残さない（次の確認でやり直す）
    const latest = this.tasks.get(taskId);
    if (
      !latest ||
      this.cancelling.has(taskId) ||
      latest.status === "running" ||
      (!resumed && latest.status !== "paused") ||
      latest.pendingReview?.judgement ||
      reworkingPullRequest(latest)?.number !== pr.number
    ) {
      return !headUnknown;
    }
    const room = Math.max(REMARKS_MAX - (latest.pendingReview?.remarks.length ?? 0), 0);
    const batch = fresh
      .filter((item) => !latest.importedFeedback.includes(item.key))
      .slice(0, room);
    if (batch.length === 0) return !headUnknown;
    this.append(latest, [
      {
        // AI のレビューの指摘だけの回は、人間の操作にしない（PBI-275）
        actor: batch.some((item) => item.source !== "sacty_review") ? "person" : "sacty",
        event: {
          type: "PullRequestReviewImported",
          payload: {
            number: pr.number,
            items: batch.map((item) => ({
              key: item.key,
              author: item.author,
              at: item.at,
              ...(item.url ? { url: item.url } : {}),
              ...(item.source ? { source: item.source } : {}),
              ...(item.source && item.review ? { review: item.review } : {}),
            })),
            remarks: feedbackRemarks(batch),
            held: true,
          },
        },
      },
    ]);
    return !headUnknown;
  }

  /** 再開したタスクに、反映する指摘がある・再開の直後に読み直す必要があるか（PBI-279）。 */
  private heldReviewDue(task: Task): boolean {
    return (
      (task.status === "queued" || task.status === "idle") &&
      reworkingPullRequest(task) !== undefined &&
      (this.heldRecheck.has(task.id) || task.pendingReview !== undefined)
    );
  }

  /**
   * 再開したタスクの、止まった工程を走り直す前に、一時停止の間に届いた PR の指摘を反映する（PBI-279）。再開の直前に書かれた
   * 指摘もあるので、再開した直後にもう一度読む。未反映の指摘があれば、ゴールガーディアンに戻し先を判断させ（承認待ちの
   * PR の指摘と同じ判断。PBI-58・PBI-265）、その工程に差し戻す。差し戻したか、反映を待つ（設定の問題・一時停止の求め）なら
   * true を返し、呼び出し元は止まった工程を走り直さない。指摘が無ければ false（今までどおり止まった工程を走り直す）。
   * 判断の途中で止まっても、次の実行で残りから続ける（指摘と判断は作業履歴にある）。
   * 人の差し戻しの上限は、人の再開を、続ける判断として扱い、止めない（承認ゲートが無く、エスカレーションを置く場所が無い）。
   */
  private async reworkHeldReview(task: Task): Promise<boolean> {
    const taskId = task.id;
    if (task.status !== "queued" && task.status !== "idle") return false;
    const pr = reworkingPullRequest(task);
    const recheck = this.heldRecheck.has(taskId);
    if (!pr || (!recheck && !task.pendingReview)) return false;
    if (!pr.repo) this.heldRecheck.delete(taskId);
    let status: PullRequestStatus | undefined;
    if (pr.repo) {
      const usedSecrets: string[] = [];
      let token: string | undefined;
      try {
        token = await this.githubToken(task, pr.repo, usedSecrets);
        if (recheck) {
          // 読めなかった（例外）・AI のレビューの head を確かめられなかったときは、印を残し、確かめられるまで止まった工程を
          // 走り直さない（直前の指摘を落として走り直さないため）
          if (!(await this.holdFeedback(taskId, token, true))) return true;
          this.heldRecheck.delete(taskId);
        }
      } catch (error) {
        console.warn(
          `[daemon] PR #${pr.number}（${pr.repo}）に届いた指摘を確認できませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
        if (recheck) return true;
      }
      // 残した指摘があるときだけ、マージ済みかを確かめる（読めなければ分からないので、そのまま進める）
      if (token !== undefined && this.tasks.get(taskId)?.pendingReview) {
        status = await this.deps.pulls
          .status({ repo: pr.repo, token, number: pr.number })
          .catch(() => undefined);
      }
    }
    const held = this.tasks.get(taskId);
    const pending = held ? heldReview(held) : undefined;
    if (!held || !pending) return false;
    // 中止・作り直しの停止（PR のマージ）・一時停止の途中なら、反映しない（それぞれの処理が、残した指摘を扱う）
    if (
      this.cancelling.has(taskId) ||
      this.mergeStopping.has(taskId) ||
      (held.status !== "queued" && held.status !== "idle")
    ) {
      return true;
    }
    // マージされた PR は、反映せずに、作り直しを止めてマージを承認として進める（残した指摘は捨てる。PBI-276）
    if (status?.state === "merged") return this.endHeldByMerge(held, status);
    const config = this.deps.config();
    if (!config.ok) return true; // 設定の問題は status() で画面に出す。タスクは実行待ちのまま。
    if (!pending.judgement) {
      // 判断の実行は費用がかかる。予算の上限に達していれば、実行せずに止める（工程の実行の前の確認と同じ）
      if (budgetState(held.budget) === "exceeded") {
        this.append(held, [
          { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
        ]);
        return true;
      }
      const judged = await this.judgeRework(
        held,
        "implement",
        pending.remarks,
        pending.aiReview ?? [],
        pending.aiReviewFrom ?? {},
        config.config,
      );
      // 選んだエージェントが無ければ、判断せずに止める（指摘は未判断のまま残す。再開したら判断し直す）
      if ("missingAgent" in judged) {
        this.pauseForMissingAgent(held, "implement", judged.missingAgent);
        return true;
      }
      // 判断を採用できないとき（一時停止・作り直しの停止（PR のマージ）・デーモンの停止のために実行を止めた・中止された・
      // 指摘や状態が変わった）は、判断は残さず、
      // 使った費用だけを記録する（runResult が interrupted の ReworkJudged は、指摘を未判断のまま保つ）。再開したら判断し直す
      const latest = this.tasks.get(taskId);
      if (
        ((this.pauseRequested.has(taskId) || this.mergeStopping.has(taskId) || this.stopping) &&
          judged.runResult !== "completed") ||
        !latest?.pendingReview ||
        latest.pendingReview.judgement ||
        latest.pendingReview.keys.join() !== pending.keys.join() ||
        (latest.status !== "queued" && latest.status !== "idle") ||
        this.cancelling.has(taskId)
      ) {
        if (latest) {
          this.append(latest, [
            {
              actor: reworkActor(judged),
              event: { type: "ReworkJudged", payload: { ...judged, runResult: "interrupted" } },
            },
          ]);
          this.warnIfNeeded(this.mustGet(taskId));
        }
        return true;
      }
      this.warnIfNeeded(
        this.append(latest, [
          { actor: reworkActor(judged), event: { type: "ReworkJudged", payload: judged } },
        ]),
      );
      // 判断の間（実行は長い）に、PR がマージされたかもしれない。差し戻す前に読み直し、マージ済みなら反映しない
      // （戻し先が設計・要求要件だと、作り直しの停止の対象外になり、マージ済みなのに前の工程を実行してしまうため）
      if (pr.repo) {
        const usedSecrets: string[] = [];
        try {
          const token = await this.githubToken(held, pr.repo, usedSecrets);
          const reread = await this.deps.pulls.status({ repo: pr.repo, token, number: pr.number });
          const merging = this.tasks.get(taskId);
          if (reread.state === "merged" && merging && !this.mergeStopping.has(taskId)) {
            return this.endHeldByMerge(merging, reread);
          }
        } catch (error) {
          console.warn(
            `[daemon] PR #${pr.number}（${pr.repo}）の状態を確認できませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
          );
        }
      }
    }
    // 差し戻す直前（判断済みの経路も含む）に、読んでいる間に変わっていないかを確かめる。中止された・別の状態になった・
    // 作り直しの停止（PR のマージ）が始まった・一時停止を求められたなら、古い応答で差し戻さない
    const settling = this.tasks.get(taskId);
    if (
      !settling ||
      this.cancelling.has(taskId) ||
      this.mergeStopping.has(taskId) ||
      this.pauseRequested.has(taskId) ||
      (settling.status !== "queued" && settling.status !== "idle") ||
      !heldReview(settling)?.judgement
    ) {
      return true;
    }
    this.settleHeldReview(settling);
    return true;
  }

  /**
   * 再開したタスクで、反映する前に実装の PR がマージされていたので、反映せずに、作り直しを止めてマージを承認として進める
   * （PBI-276 と同じ記録。実行中の処理はこの実行だけなので、止める実行は無い）。呼び出し元は反映の対象として扱い終える（true）。
   */
  private endHeldByMerge(task: Task, status: Extract<PullRequestStatus, { state: "merged" }>) {
    const reworking = reworkingPullRequest(task);
    if (reworking) {
      this.endReworkByMerge(task.id, reworking.number, status, {
        stoppedRuns: [],
        stage: this.reworkStage(task),
      });
    }
    return true;
  }

  /**
   * ゴールガーディアンの判断に従って、一時停止の間に届いた PR の指摘を、判断した工程に差し戻す（PBI-279）。settleReview の
   * 承認ゲートが無い版。判断できなければ実装をやり直す。ゴールガーディアンの見逃しとしては記録しない（止まった工程の実装は、
   * 最終レビューで合格にしていないため）。
   */
  private settleHeldReview(task: Task): void {
    const pending = heldReview(task);
    const judgement = pending?.judgement;
    if (!pending || !judgement) return;
    if (task.status !== "queued" && task.status !== "idle") return;
    const targets = reworkTargets(task, "implement");
    const target =
      judgement.target && targets.includes(judgement.target)
        ? judgement.target
        : (targets[0] ?? "implement");
    // 回の番号と指摘の ID は、AI のレビューだけの回も含めて続ける。人の差し戻しの回数に数えるのは人の指摘だけ（PBI-275）
    const round = lastChangeRound(task, target) + 1;
    const aiIndexes = new Set(pending.aiReview ?? []);
    const remarks = pending.remarks.map((text, i) => ({
      id: `${target}-${round}-${i + 1}`,
      text,
      ...(aiIndexes.has(i) ? { source: "sacty_review" as const } : {}),
    }));
    const onlyAiReview = remarks.every((r) => r.source === "sacty_review");
    this.append(task, [
      {
        actor: onlyAiReview ? "sacty" : "person",
        event: {
          type: "ChangesRequested",
          payload: {
            step: "implement",
            target,
            round,
            remarks,
            overLimit: !onlyAiReview && changeRounds(task, target) >= MAX_CHANGE_REQUESTS,
            ...(judgement.cause ? { cause: judgement.cause } : {}),
          },
        },
      },
    ]);
  }

  /**
   * 実装の作り直し（実装・最終レビュー・PR の更新が走っている・待っている。一時停止中も）の間に、人が実装の PR を
   * マージしたタスクを探して、作り直しを止める（PBI-276）。承認待ちのタスクは、checkPullRequests が見守る。
   * PR の状態は、プロジェクトの gh のアカウントで確かめる。確かめられないタスクは、次の確認でやり直す。
   */
  private async checkReworkMerges(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      const reworking = reworkingPullRequest(task);
      if (!reworking?.repo || this.cancelling.has(task.id)) continue;
      const usedSecrets: string[] = [];
      try {
        const token = await this.githubToken(task, reworking.repo, usedSecrets);
        const status = await this.deps.pulls.status({
          repo: reworking.repo,
          token,
          number: reworking.number,
        });
        if (status.state === "merged") await this.stopReworkForMerge(task.id, reworking, status);
      } catch (error) {
        console.warn(
          `[daemon] PR #${reworking.number}（${reworking.repo}）のマージの確認と作り直しの停止ができませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
      }
    }
  }

  /**
   * 実装の作り直しの間に実装の PR がマージされたので、作り直しを止めて、マージを承認として進める（PBI-276）。
   * 実行中ならコンテナを止めて終わりを待ち、止めたコンテナが無くなったことを確かめてから、作業履歴に残す。
   * - ReworkStoppedByMerge：止めた実行と、作り直しに渡す前に捨てた指摘（理由はマージ）
   * - 続けて PullRequestMerged・StepApproved（承認待ちのマージと同じ記録）。新しい PR は作らない
   * 止めている間に、人が中止した・別の状態になったなら、何も記録しない。止めたコンテナを確かめられなければ、一時停止にして
   * 人の確認を待つ（再開の前に確かめる。次の確認で、確かめ直して続ける）。
   */
  private async stopReworkForMerge(
    taskId: string,
    reworking: NonNullable<ReturnType<typeof reworkingPullRequest>>,
    status: Extract<PullRequestStatus, { state: "merged" }>,
  ): Promise<void> {
    const same = () => {
      const task = this.tasks.get(taskId);
      const now = task ? reworkingPullRequest(task) : undefined;
      return task && now?.number === reworking.number && !this.cancelling.has(taskId)
        ? task
        : undefined;
    };
    const before = same();
    if (!before) return;
    // 承認か一時停止を記録するまで、このタスクの実行を始めさせない（止めた実行が正常に終わっていても、続きの検証を
    // ワーカーが始めないように。runNext と queuedTaskIds が見る）
    this.mergeStopping.add(taskId);
    try {
      // 一時停止のときに止めたコンテナが残っているかもしれないタスクは、止めて確かめる
      if (before.status === "paused" && (before.unstoppedRuns?.length ?? 0) > 0) {
        if (!(await this.confirmPausedContainers(taskId))) return;
      }
      const stage = this.reworkStage(before);
      // 前の確認で止めたコンテナを確かめられず、一時停止にしていたなら、その実行も止めた実行に含める
      let stoppedRuns = [...(before.unstoppedRuns ?? [])];
      const inflight = this.inflight.get(taskId);
      if (inflight) {
        // 実行中の処理を止める。止めた実行は、一時停止にしない（止めた理由は、この後の記録に残す）
        // （人の一時停止・中止が同時に求められていれば、その印は消さない）
        const humanStop = this.pauseRequested.has(taskId);
        this.pauseRequested.add(taskId);
        stoppedRuns = [...new Set([...stoppedRuns, ...inflight.runIds])];
        try {
          this.stopRuns(inflight.runIds);
          await inflight.done.catch(() => {});
        } finally {
          if (!humanStop) this.pauseRequested.delete(taskId);
        }
        const unstopped = await this.unstopped(stoppedRuns);
        const after = this.tasks.get(taskId);
        if (unstopped.length > 0) {
          // 止めたコンテナを確かめられない間は、作業領域が書き換わりうるので進めない。一時停止にして人が確かめる
          // 実行の費用で先に一時停止していた（予算など）場合も、確かめられなかった実行を残す
          if (
            after &&
            (after.status === "queued" || after.status === "idle" || after.status === "paused")
          ) {
            this.append(after, [
              {
                actor: "sacty",
                event: {
                  type: "TaskPaused",
                  payload: { reason: "manual", ...this.unstoppedPayload(unstopped) },
                },
              },
            ]);
          }
          return;
        }
      }
      // 止めている間に、承認待ちになった（PR の更新を終えた）・中止されたなら、ここでは記録しない（承認待ちのマージは、
      // 次の確認で確かめる）
      this.endReworkByMerge(taskId, reworking.number, status, {
        stoppedRuns,
        stage: inflight && stage === "queued" ? "running" : stage,
      });
    } finally {
      this.mergeStopping.delete(taskId);
    }
  }

  /**
   * 実装の作り直しを止めた記録と、マージの承認の記録を、同じ追記で行う（PBI-276）。作り直しの途中でなくなっていれば（承認待ちに
   * なった・中止された・別の PR になった）何も記録せず、false を返す。実行は止めてから呼ぶ（実行中は記録できない）。
   */
  private endReworkByMerge(
    taskId: string,
    number: number,
    status: Extract<PullRequestStatus, { state: "merged" }>,
    stopped: { stoppedRuns: string[]; stage?: ReworkStage },
  ): boolean {
    const latest = this.tasks.get(taskId);
    const reworking = latest ? reworkingPullRequest(latest) : undefined;
    if (!latest || !reworking || reworking.number !== number || latest.status === "running") {
      return false;
    }
    if (this.cancelling.has(taskId)) return false;
    this.append(latest, [
      {
        actor: "sacty",
        event: {
          type: "ReworkStoppedByMerge",
          payload: {
            number,
            was: stopped.stage ?? this.reworkStage(latest),
            stoppedRuns: stopped.stoppedRuns,
            discardedRemarks: unreflectedImplementRemarks(latest).map((r) => ({
              id: r.id,
              text: r.text,
            })),
            ...(latest.verifyFeedback ? { discardedFeedback: latest.verifyFeedback.kind } : {}),
            // 一時停止の間に届いて、まだ作り直しに渡していない PR の指摘（PBI-279）
            ...(heldReview(latest)?.remarks.length
              ? { discardedReview: heldReview(latest)?.remarks.length }
              : {}),
          },
        },
      },
      ...this.mergeApprovalItems(
        latest,
        { step: "implement", number, repo: reworking.repo ?? "", commit: reworking.commit },
        status,
      ),
    ]);
    return true;
  }

  /** 実装の作り直しが、いまどの段階か（ReworkStoppedByMerge に残す）。 */
  private reworkStage(task: Task): ReworkStage {
    if (task.status === "paused") return "paused";
    if (task.status === "running") return "running";
    if (task.publishPending) return "publishing";
    if (task.verification !== undefined) return "verifying";
    return "queued";
  }

  /**
   * 人が PR をマージした記録（PullRequestMerged と、その工程の承認 StepApproved。実装の PR なら、マージのコミットの
   * CI/CD とデプロイの監視の開始も）。承認待ちの PR のマージ（checkPullRequests）と、実装の作り直しの間のマージ
   * （stopReworkForMerge。PBI-276）が同じ記録を作る。人が PR の中で直してからマージした（PR の先頭が sacty の出した
   * コミットと違う）なら、人が直した最終のコミットも残す（PBI-63）。
   */
  private mergeApprovalItems(
    task: Task,
    pr: { step: StepKey; number: number; repo: string; commit: string },
    status: Extract<PullRequestStatus, { state: "merged" }>,
    document?: PullRequestMerge["document"],
  ): ActivityItem[] {
    const edited = status.headSha !== pr.commit;
    const head = edited ? status.headSha : pr.commit;
    return [
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
          payload: { step: pr.step, next: this.nextAfterApproval(task, pr.step) },
        },
      },
      // 実装の PR のマージなら、マージのコミットの CI/CD とデプロイの監視を始める（PBI-89。プロジェクトで On のときだけ）
      ...this.deploymentWatchEvents(task, pr.step, pr.number, pr.repo, status.mergeCommit),
    ];
  }

  /**
   * 実装の承認待ちの PR が、ベースブランチと競合しているか（GitHub の mergeable）が変わったら記録する。画面に出すだけで、
   * ベースブランチは取り込まず、実行も始めない（取り込みは、人が差し戻すか指摘を書いたときに行う）。PR の状態の確認で
   * 読んだ値を使うので、GitHub への問い合わせは増えない。mergeable が分からない（GitHub が計算中・読めない）ときは、前の
   * 記録のままにする。記録したら、記録後のタスクを返す。
   */
  private recordPullRequestConflict(
    task: Task,
    pr: { step: StepKey; number: number; commit: string },
    mergeable: boolean | undefined,
  ): Task | undefined {
    if (pr.step !== "implement" || mergeable === undefined) return undefined;
    // 記録済みか（ゴールガーディアンが指摘を判断している間は画面に出さないが、記録は残るので、重ねて記録しない）
    const recorded = task.pullRequestConflict;
    const conflicting = recorded?.number === pr.number && recorded.commit === pr.commit;
    if (conflicting === !mergeable) return undefined;
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: mergeable ? "PullRequestConflictResolved" : "PullRequestConflicted",
          payload: { number: pr.number },
        },
      },
    ]);
    return this.tasks.get(task.id);
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
            // マージ先のブランチ。引き継いだ既存の PR は、作業領域のベースブランチ（PR の元のブランチ）ではなく、PR の向き先
            branch: task.continuedPullRequest?.baseBranch ?? task.repository.baseBranch,
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
   * コミットの CI/CD の状態を読み、終わっていれば結果を返す（PBI-89。マージの後の監視）。待つなら undefined。読めない
   * （認証・ネットワーク）なら待ち、時間の上限（timeoutMs）を過ぎていれば時間切れ。1つも無ければ graceMs を過ぎるまで
   * 待ってから none。すべて終わっていても、前の確認（key ごとに覚える）と同じ並びになるまで1回待つ。失敗があれば、失敗した
   * ジョブとログの抜粋を読む。
   */
  private async readCi(
    task: Task,
    input: {
      repo: string;
      commit: string;
      elapsed: number;
      key: string;
      graceMs: number;
      timeoutMs: number;
      usedSecrets: string[];
    },
  ): Promise<
    | {
        result: "passed" | "failed" | "none" | "timed_out";
        checks: CiCheck[];
        failures: CiFailure[];
      }
    | undefined
  > {
    const { repo, commit, elapsed, key, usedSecrets } = input;
    let token: string;
    let snapshot: Awaited<ReturnType<CiStatusReader["snapshot"]>>;
    try {
      if (!this.deps.ci) throw new Error("CI/CD の状態を読む口がありません");
      token = await this.githubToken(task, repo, usedSecrets);
      snapshot = await this.deps.ci.snapshot({ repo, token, commit });
    } catch (error) {
      console.warn(
        `[daemon] ${repo} のコミット ${commit} の CI/CD の状態を読めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
      return elapsed >= input.timeoutMs
        ? { result: "timed_out", checks: [], failures: [] }
        : undefined;
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
      return elapsed >= input.graceMs ? { result: "none", checks: [], failures: [] } : undefined;
    }
    if (snapshot.checks.some((c) => c.status === "pending")) {
      this.ciSettled.delete(key);
      return elapsed >= input.timeoutMs ? { result: "timed_out", checks, failures: [] } : undefined;
    }
    // すべて終わっていても、前の確認と同じになるまで（後から別のワークフローが現れないか）1回待つ
    const signature = JSON.stringify(
      snapshot.checks.map((c) => [c.kind, c.name, c.url ?? "", c.conclusion ?? ""]).sort(),
    );
    if (this.ciSettled.get(key) !== signature && elapsed < input.timeoutMs) {
      this.ciSettled.set(key, signature);
      return undefined;
    }
    this.ciSettled.delete(key);
    const failedChecks = snapshot.checks.filter(isFailedConclusion);
    if (failedChecks.length === 0) return { result: "passed", checks, failures: [] };
    let failures: CiFailure[] = [];
    try {
      failures = await this.deps.ci.failures({
        repo,
        token,
        runs: snapshot.failedRuns,
        secrets: usedSecrets,
      });
    } catch (error) {
      console.warn(
        `[daemon] ${repo} の失敗したジョブを読めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
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
    return { result: "failed", checks, failures: failures.slice(0, CI_FAILURES_MAX) };
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
    const ci = await this.readCi(task, {
      repo: watch.repo,
      commit,
      elapsed,
      key: task.id,
      graceMs: DEPLOYMENT_CI_GRACE_MS,
      timeoutMs: DEPLOYMENT_CI_TIMEOUT_MS,
      usedSecrets,
    });
    if (!ci) return;
    if (ci.result !== "passed") {
      record(ci);
      return;
    }
    const { checks } = ci;
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
   * 工程の選択に、マージの後の監視の工程をするかを足す（PBI-116）。イメージはタスクに1つなので（PBI-318）、飛ばしても
   * 既定のイメージの理由・理由が無いことはそのまま残す（ほかの工程がそのイメージで動く）。
   */
  private withDeploymentChoice(
    _chosen: ChosenSteps,
    deployment: NonNullable<ChosenSteps["deployment"]>,
  ): Partial<ChosenSteps> {
    return { deployment };
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
    // 人が選んだエージェント（作成時の指定、またはタスクの詳細・再開・差し戻しでの変更）を優先する（PBI-121）。選んだ名前が消えていれば、理由を示して止める
    const chosen = stepAgentFor(config, "deployment", this.mustGet(task.id).agents?.deployment);
    if (!chosen.ok) {
      this.pauseForMissingAgent(task, "deployment", chosen.missing);
      return;
    }
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で確かめる
    const agent = this.usableAgent(config, chosen.agent, task.id, "deployment");
    const runId = randomUUID();
    const setting = { agentId: agent.id, ...agentSetting(agent), runId };
    // マージの後の監視の工程のイメージ（タスクのイメージ。PBI-318）。古い版の作業履歴の工程ごとのイメージなら、その工程の
    // イメージ（工程の無い PBI-116 より前のタスクは、実装の工程のイメージ）。無い・images に無い名前なら既定のイメージ。
    // 確認を始めるときに決め、使う名前を記録に残す（画面が、どのイメージで動いたかを出す）
    const atStart = this.mustGet(task.id);
    const watchStepped = atStart.steps.some((s) => s.key === "deployment");
    const imageName =
      atStart.image ?? (watchStepped ? atStart.images?.deployment : atStart.images?.implement);
    const images = this.projectImagesConfig(config, task.projectId);
    const image = resolveImage(images, imageName);
    // 作成中・作成に失敗したコンテキストのイメージ（PBI-325）は、既定のイメージに倒さず、理由を示して確認を止める（要る
    // ツールの無いイメージで確かめないため）。images から消した名前は、これまでどおり既定のイメージで確かめる
    const unavailable =
      !image.ok && imageName !== undefined && imageDefined(images, imageName)
        ? image.message
        : undefined;
    const usedImage =
      image.ok || unavailable ? (imageName ?? DEFAULT_IMAGE_NAME) : DEFAULT_IMAGE_NAME;
    this.append(task, [
      {
        actor: "sacty",
        event: { type: "DeploymentCheckStarted", payload: { runId, skill, image: usedImage } },
      },
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
    if (unavailable) return fail(unavailable);
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
        context = await this.runContext(
          current,
          agent,
          config,
          usedSecrets,
          undefined,
          "deployment",
        );
      } catch (error) {
        return fail(errorText(error));
      }
      const platforms = mergePlatforms(config.platforms, context?.platforms ?? []);
      // 用意したコンテキスト（層・注意・置いた段階）を、この実行の記録として残す（PBI-119）
      if (context) {
        this.append(this.mustGet(task.id), [this.contextResolved(runId, context, platforms)]);
      }
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
      await rm(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = executed;
    const cost = {
      ...setting,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      costUsd,
      estimated,
      ...unknownCost(executed),
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
   * 差し戻す直前に PR の状態を読み直し、開いたままでなければ（判断の間にマージされた・閉じられた）差し戻さず
   * `"pull_request_changed"` を返す（呼び出し元が、マージ・クローズとして確かめ直す）。
   */
  private async importFeedback(
    task: Task,
    token: string,
  ): Promise<"pull_request_changed" | undefined> {
    // 実装の PR と、要求要件・設計の PR（PBI-57）の指摘
    const pr = gatePullRequest(task);
    if (!pr?.number || !pr.repo) return;
    let current = task;
    if (!current.pendingReview) {
      const listed = (
        await this.deps.pulls.feedback({
          repo: pr.repo,
          token,
          number: pr.number,
          ...this.githubAccountOf(current, pr.repo),
          ...this.sactyReviewsOf(pr.repo, pr.number),
        })
      )
        .filter((item) => !current.importedFeedback.includes(item.key))
        .filter((item) => !handedOverFeedback(current, pr, item));
      // 古い head へのレビュー（sacty のレビューのタスクの投稿）は、取り込まずに捨てる（PBI-275）
      const fresh = await this.withoutStaleReviews(
        task.id,
        { repo: pr.repo, number: pr.number },
        token,
        listed,
      );
      if (fresh.length === 0) {
        this.feedbackSeenAt.delete(task.id);
        return;
      }
      // コメントは何件かに分けて書かれるので、最後のものから一定の時間たつまで待つ。
      // フィードバックの時刻は GitHub の時刻なので、それがこの機械の時計より先に進んでいても待ち続けないよう、
      // このデーモンが初めて見た時刻より後には数えない（見た時点で、そのフィードバックはもう書かれている）
      const now = this.now();
      const previouslySeen = this.feedbackSeenAt.get(task.id);
      const seenAt = new Map(fresh.map((item) => [item.key, previouslySeen?.get(item.key) ?? now]));
      this.feedbackSeenAt.set(task.id, seenAt);
      const newest = Math.max(
        ...fresh.map((item) => Math.min(Date.parse(item.at) || 0, seenAt.get(item.key) ?? now)),
      );
      if (now - newest < FEEDBACK_QUIET_MS) return;
      // 一度に取り込むのは、指摘の件数の上限まで（古い順）。残りは取り込み済みにせず、次の取り込みに残す
      const batch = fresh.slice(0, REMARKS_MAX);
      const latest = this.tasks.get(task.id);
      if (latest?.status !== "awaiting_approval" || latest.pendingReview) return;
      current = this.append(latest, [
        {
          // レビューは人間の判断なので、人間の操作として記録する。AI のレビュー（sacty のレビューのタスクの投稿）だけの
          // 回は、人間の操作にしない（PBI-275）
          actor: batch.some((item) => item.source !== "sacty_review") ? "person" : "sacty",
          event: {
            type: "PullRequestReviewImported",
            payload: {
              number: pr.number,
              items: batch.map((item) => ({
                key: item.key,
                author: item.author,
                at: item.at,
                ...(item.url ? { url: item.url } : {}),
                ...(item.source ? { source: item.source } : {}),
                ...(item.source && item.review ? { review: item.review } : {}),
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
      const judged = await this.judgeRework(
        current,
        pr.step,
        pending.remarks,
        pending.aiReview ?? [],
        pending.aiReviewFrom ?? {},
        config.config,
      );
      // 選んだエージェントが無ければ、判断せずに止める（指摘は未判断のまま残す。再開したら判断し直す）
      if ("missingAgent" in judged) {
        this.pauseForMissingAgent(current, pr.step, judged.missingAgent, { awaiting: true });
        return;
      }
      // 判断の間に、人間が差し戻した・中止したなどで変わっていれば、記録しない
      const latest = this.tasks.get(task.id);
      // デーモンを止める・中止するために止めた実行は、判断の失敗として採用しない（採用すると、実装をやり直すことになる）。
      // 使った費用だけを記録し、指摘は未判断のまま残す（次の確認で判断し直す）
      if ((this.stopping || this.cancelling.has(task.id)) && judged.runResult !== "completed") {
        if (latest) {
          this.append(latest, [
            {
              actor: reworkActor(judged),
              event: { type: "ReworkJudged", payload: { ...judged, runResult: "interrupted" } },
            },
          ]);
        }
        return;
      }
      if (
        !latest?.pendingReview ||
        latest.pendingReview.judgement ||
        latest.pendingReview.keys.join() !== pending.keys.join()
      ) {
        return;
      }
      current = this.append(latest, [
        { actor: reworkActor(judged), event: { type: "ReworkJudged", payload: judged } },
      ]);
    }
    // 判断の間（エージェントの実行は長い）に、人が PR をマージした・閉じたかもしれない。差し戻す前に PR の状態を読み直し、
    // 開いたままでなければ差し戻さない（マージは承認。承認した成果を差し戻して、マージ済みのタスクが動き出さないように）。
    // 取り込んだ指摘と判断は作業履歴に残っている。マージ・クローズの記録は、確かめ直し（checkPullRequests）が行う
    const status = await this.deps.pulls.status({ repo: pr.repo, token, number: pr.number });
    // 読んでいる間に、人間が差し戻した・中止したなどで変わっていれば、記録しない
    const settling = this.tasks.get(task.id);
    const watched = settling ? gatePullRequest(settling) : undefined;
    if (
      !settling ||
      this.cancelling.has(task.id) ||
      settling.status !== "awaiting_approval" ||
      settling.pendingReview?.keys.join() !== pending.keys.join() ||
      !settling.pendingReview?.judgement ||
      watched?.step !== pr.step ||
      watched.number !== pr.number ||
      watched.commit !== pr.commit
    ) {
      return;
    }
    if (status.state !== "open") return "pull_request_changed";
    this.settleReview(settling);
  }

  /**
   * 取り込む指摘から、古い head へのレビューを除き、捨てたことを作業履歴に残す（PBI-275）。sacty のレビューのタスクの投稿
   * （AI のレビュー）で、対象にしたコミットが今の PR の head と違うもの（レビューの間や、取り込みの前に PR が更新された）は、
   * もう直された内容へのレビューなので、元のタスクに届けない。捨てたものは取り込み済みにして、取り込み直さない。
   * PR の head を読めなければ、古いかどうか分からないので、AI のレビューは今回は取り込まず、次の確認で確かめ直す
   * （人の指摘は、head によらず取り込む）。
   */
  private async withoutStaleReviews(
    taskId: string,
    pr: { repo: string; number: number },
    token: string,
    items: PullRequestFeedback[],
    /** gate：承認待ちの取り込み。held：一時停止の間に届いた指摘を残すとき（PBI-279）。 */
    where: "gate" | "held" = "gate",
    /** PR の head を確かめられず、AI のレビューを今回は扱わなかったときに呼ぶ（呼び出し元が、確かめ直すまで待つため）。 */
    onHeadUnknown?: () => void,
  ): Promise<PullRequestFeedback[]> {
    const reviewed = items.filter((item) => item.source === "sacty_review" && item.commit);
    if (reviewed.length === 0) return items;
    let head: string | undefined;
    try {
      head = (await this.deps.pulls.status({ ...pr, token })).headSha?.trim() || undefined;
    } catch (error) {
      // 原因は残す（確かめ直すまで AI のレビューを扱わないので、続くと止まっているように見える）。トークンは伏せる
      console.warn(
        `[daemon] タスク ${taskId.slice(0, 8)} の PR #${pr.number}（${pr.repo}）の head を確認できませんでした（AI のレビューは確認できるまで扱いません）：${renderMessage(redactText(errorText(error), [token]), "ja")}`,
      );
      head = undefined;
    }
    if (!head) {
      onHeadUnknown?.();
      return items.filter((item) => !reviewed.includes(item));
    }
    const current = head;
    const stale = reviewed.filter((item) => !sameCommit(item.commit ?? "", current));
    if (stale.length === 0) return items;
    const latest = this.tasks.get(taskId);
    // 同時に走っている別の確認（一時停止中の確認と再開の後の確認など）が先に捨てた・取り込んだものは、重ねて記録しない
    // （記録すると、取り込み済みの重複として作業履歴を読めなくなる）
    const pending = latest
      ? stale.filter((item) => !latest.importedFeedback.includes(item.key))
      : stale;
    const watched = latest ? gatePullRequest(latest) : undefined;
    // 見ている間に承認待ちでなくなった・指摘を取り込み中になった・見守る PR が変わったなら、記録しない（次の確認でやり直す）。
    // 一時停止の間に残すときは、作り直しの PR が変わった・実行が始まった・判断が済んだなら、記録しない
    const watching =
      where === "held"
        ? latest !== undefined &&
          latest.status !== "running" &&
          !latest.pendingReview?.judgement &&
          reworkingPullRequest(latest)?.number === pr.number
        : latest?.status === "awaiting_approval" &&
          !latest.pendingReview &&
          watched?.number === pr.number;
    if (!watching || pending.length === 0) {
      return items.filter((item) => !stale.includes(item));
    }
    this.append(latest as Task, [
      {
        actor: "sacty",
        event: {
          type: "PullRequestReviewDiscarded",
          payload: {
            number: pr.number,
            reason: "stale_head",
            head: current,
            items: pending.map((item) => ({
              key: item.key,
              author: item.author,
              at: item.at,
              ...(item.url ? { url: item.url } : {}),
              commit: item.commit ?? "",
              summary: discardedSummary(item),
            })),
          },
        },
      },
    ]);
    return items.filter((item) => !stale.includes(item));
  }

  /**
   * この PR をレビューした sacty のタスクの回と、そのタスクが投稿に使うアカウント（PBI-88）。この PR を参照する sacty のタスクの、
   * 指摘のある回（修正が必要・提案あり。判定を読めなかった回も）は、元のタスクへの PR の指摘として取り込む（allowed。PBI-145）。
   * 取り込みの経路（レビュー用のラベル・レビューの依頼・手動で作ったタスク）は問わない（どれも人が求めたレビュー）。
   * 指摘の無い回・判定の記録が無い回は、アカウントが元のタスクと違っても除く。
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
          // 指摘のある回（修正が必要・提案あり）は、元のタスクに対応させるために取り込む。提案だけの回も取り込む（繰り返しの
          // 費用は予算で止める。PBI-145）。指摘の無い回は取り込まない。判定を読めなければ、指摘を落とさないように取り込む（PBI-111）
          allowed: verdict !== undefined && verdict.verdict !== "no_findings",
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
    this.requestChanges(
      task.id,
      {
        step: gate.step,
        submission: gate.submission,
        target,
        comments: pending.remarks,
        // ゴールガーディアンが判断した原因（判断できなければ、原因を決めない。見逃しにしない。PBI-268）
        ...(judgement.cause ? { cause: judgement.cause } : {}),
        // 質問への答えだけで、推奨どおり（決定を変えない）なら、答えの反映だけの軽い直しにする（PBI-302 B1）。
        // 要求要件・設計の PR を、その工程で直すときだけ（前の工程へ戻す・実装の PR・判断できなかったときは、今までどおりの直し）
        ...(judgement.cause === "question_answer" && judgement.answer === "changes_decision"
          ? { answer: "changes_decision" as const }
          : judgement.cause === "question_answer" &&
              judgement.answer === "as_recommended" &&
              judgement.target === gate.step &&
              target === gate.step &&
              (gate.step === "requirements" || gate.step === "design")
            ? { answer: "as_recommended" as const }
            : {}),
      },
      // AI のレビューの指摘は、人の差し戻しの回数に数えない（PBI-275）
      { aiReview: pending.aiReview ?? [] },
    );
  }

  /**
   * ゴールガーディアンを、対象リポジトリのコードの使い捨ての写しを渡して実行する（PBI-16）。
   * base は起点のコミットのコード、implemented は実装後のコード（実装の作業領域。.git を除く）。
   * コードは実行ごとのディレクトリに書き出し、終わったら消す。書き出せなければ、実行の失敗として返す。
   */
  /**
   * ゴールガーディアンの判定（変更の申し出・差し戻しの指摘。コンテキストを渡さない実行）を、失敗したら代わりのエージェント
   * （agents の fallback）でやり直して返す。切り替えたことは作業履歴に記録し、失敗した実行の費用は返す費用に足す。1回の判定の
   * 中では、試したエージェントをもう一度は試さない（試し終えたら、最後の失敗を返す。やり直しの回数は代わりの数まで）。
   */
  private async runGuardianWithFallback(
    task: Task,
    run: Parameters<TaskService["runGuardian"]>[1],
    code: "base" | "implemented",
    config: SactyConfig,
  ): Promise<Awaited<ReturnType<TaskService["runGuardian"]>> & { agent: AgentConfig }> {
    const selected = run.agent;
    let agent = this.usableAgent(config, selected, task.id, run.role);
    let executed = await this.runGuardian(task, { ...run, agent }, code);
    let spent = 0;
    // 失敗して代わりのエージェントで判定し直したとき、先の実行の使用量が不明なら、合計も不明（PBI-281）
    let unknown = false;
    const tried = new Set([agent.id]);
    for (;;) {
      if (executed.outcome.kind !== "failed") break;
      const switched = this.fallBack(
        task.id,
        { runId: executed.runId, role: run.role, agent, selected },
        executed.outcome.reason,
        config,
        tried,
      );
      if (switched?.event.type !== "AgentFellBack") break;
      this.append(this.mustGet(task.id), [switched]);
      spent += executed.costUsd;
      unknown ||= executed.costUnknown === true;
      const next = definedAgent(config, switched.event.payload.fallbackAgentId);
      if (!next) break;
      agent = next;
      tried.add(agent.id);
      executed = await this.runGuardian(task, { ...run, agent, runId: undefined }, code);
    }
    // 1回の判定の中で試し終えたので、次の判定は、選んだエージェントから試す
    this.forgetTried(task.id, run.role);
    return {
      ...executed,
      costUsd: executed.costUsd + spent,
      ...(unknown ? { costUnknown: true as const } : {}),
      agent,
    };
  }

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
      /** イメージの環境変数（言語ごとのイメージの env。最終レビューはタスクのイメージで動く。PBI-41・PBI-318）。 */
      imageEnv?: Record<string, string>;
      /** つなぐネットワークと、localhost に転送するポート（最終レビューでテストに使うサービス。PBI-47・PBI-60）。 */
      network?: ExecuteRun["network"];
      forwards?: ExecuteRun["forwards"];
      /** true を返すと、コンテナを起動しない（準備の間に中止されたなど。PBI-54）。 */
      stopped?: () => boolean;
      /** 実行の ID が変わったら知らせる（セッションを新しく始め直したとき。止めるため。PBI-67）。 */
      onRunId?: (runId: string) => void;
      /** 追加でマウントする、sacty が管理するディレクトリ（質問への答えの各実行のセッションログ。PBI-91）。 */
      mounts?: ExecuteRun["mounts"];
      /** タスクごとの依存のキャッシュを使う（最終レビュー。PBI-319）。 */
      taskCache?: true;
      readDirs?: ExecuteRun["readDirs"];
      /** エージェントの形式に変換したコンテキストと、その MCP サーバー（オーケストレーター。PBI-146）。 */
      context?: ExecuteRun["context"];
      contextMcp?: ExecuteRun["contextMcp"];
      estimateCost?: boolean;
    },
    code: "base" | "implemented",
  ): Promise<Awaited<ReturnType<TaskService["execute"]>>> {
    const runId = run.runId ?? randomUUID();
    const workspaceDir = join(this.deps.workspaceRoot, CODE_COPY_DIR, runId);
    // 作業領域の写しに入れなかったファイル（読めないもの）を知らせる文を足した、実行の指示
    let prompt = run.prompt;
    try {
      if (task.repository) {
        // 完了の後に作業領域を消したタスク（PBI-157）は、同じ起点で用意し直す（実装の変更は戻らない）
        const missing = await this.workspaceMissing(task);
        if (missing) {
          return {
            outcome: { kind: "failed", reason: "error", message: missing },
            costUsd: 0,
            estimated: false,
            runId,
          };
        }
        try {
          if (code === "base") {
            await this.deps.repos.snapshot(
              this.trustedGitDir(task),
              task.repository.baseCommit,
              workspaceDir,
            );
          } else {
            // エージェントが git を参照できるように、退避したメタデータの写しを .git にする。写す間も画面や API に
            // 応答し続けるよう、非同期で写す（写しの途中で止められたら、execute が起動の前に止める。PBI-156）
            const copied = await this.deps.repos.copyWorkingTree(
              this.repoDir(task),
              workspaceDir,
              this.trustedGitDir(task),
            );
            // 読めないファイル（エージェントが展開したツールの権限 0000 のファイルなど）は、写し全体を失敗にせず、
            // 写さずに作業履歴に残して、エージェントに知らせる（PBI-278）
            if (copied.skipped.count > 0) {
              this.recordSkippedFiles(task.id, runId, run.role, copied.skipped);
              prompt = [prompt, ...skippedFilesLines(copied.skipped)].join("\n");
            }
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
      return await this.execute({ ...run, prompt, taskId: task.id, runId, workspaceDir });
    } finally {
      // 写しは数 GB になりうるので、非同期で消す（消す間もデーモンが応答し続ける。PBI-156）。消せなくても、実行の結果
      // （判定・答え・分析と費用）を失わないよう、警告だけにする
      await rm(workspaceDir, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(
          `[daemon] ゴールガーディアン・オーケストレーターの実行の作業領域を消せませんでした（${task.id}）：`,
          error instanceof Error ? error.message : error,
        );
      });
    }
  }

  /**
   * 実装の作業領域の写しで、読めないために写さなかったファイルを、作業履歴に残す（PBI-278）。残せなくても（写している間に
   * 中止された、など）実行は続ける。
   */
  private recordSkippedFiles(
    taskId: string,
    runId: string,
    role: AgentRole,
    skipped: { count: number; paths: string[] },
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    try {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "WorkspaceFilesSkipped",
            payload: { runId, role, count: skipped.count, paths: skipped.paths },
          },
        },
      ]);
    } catch (error) {
      console.warn(
        `[daemon] 写さなかったファイルを作業履歴に残せませんでした（${taskId}）：`,
        error instanceof Error ? error.message : error,
      );
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
   * 工程の成果でエージェントが頼んだ、PR・Issue へのコメント（sacty-github-comments）を、プロジェクトの gh の
   * アカウントで投稿する。投稿先は、プロジェクトの対象のリポジトリだけ。前に投稿の後・記録の前に止まっていたら、
   * 目印で見つけたコメントを使う（二度投稿しない）。投稿できなくても、理由を記録してタスクは進める。
   * when が approved なら承認した成果の頼み。submitted なら、PR のマージで承認する工程の、承認を待つ提出の頼み
   * （指摘への返信を、PR を見ている人がその場で読めるように。PBI-301）。
   */
  private postGitHubComments(
    task: Task,
    step: StepKey,
    when: "approved" | "submitted" = "approved",
  ): Promise<void> {
    // 同じタスク・工程の投稿は順に処理する（先の処理が検索や投稿の最中のまま、もう1本始まっても、二重に投稿しない。PBI-301）
    return this.serialized(`gh-comments:${task.id}:${step}`, () =>
      this.postGitHubCommentsNow(task, step, when),
    );
  }

  private async postGitHubCommentsNow(
    task: Task,
    step: StepKey,
    when: "approved" | "submitted",
  ): Promise<void> {
    // 頼みを読む成果と、その版の目印（承認の日時。承認の前の投稿は、提出の回）
    const submission = when === "submitted" ? task.gate?.submission : undefined;
    const approved = task.approved[step];
    const source =
      when === "approved"
        ? approved && { output: approved.output, at: approved.at }
        : submission !== undefined
          ? { output: task.outputs[step] ?? "", at: `submission-${submission}` }
          : undefined;
    if (!source) return;
    const usedSecrets: string[] = [];
    const requested = requestedGitHubComments(source.output);
    const results: { target: string; url?: string; failed?: DaemonText }[] = [];
    let failed: DaemonText | undefined;
    if (!requested) return;
    // 待っている間（トークンの取り出し・既存のコメントの検索）に、止められた・承認や提出が変わったら、新しく投稿しない
    // （記録もしない。再開したら、目印で投稿済みのものを見つけて続ける）
    const valid = () => {
      if (this.cancelling.has(task.id) || this.pauseRequested.has(task.id)) return false;
      const latest = this.tasks.get(task.id);
      if (latest === undefined) return false;
      return when === "approved"
        ? awaitingGitHubComments(latest) === step && latest.approved[step]?.at === source.at
        : awaitingSubmittedGitHubComments(latest) === step &&
            latest.gate?.submission === submission;
    };
    if (!requested.ok) failed = requested.reason;
    else {
      const project = this.deps.projects.get(task.projectId);
      for (const [index, comment] of requested.comments.entries()) {
        if (!valid()) return;
        const target = comment.target.slice(0, 2000);
        if (!comment.repo || !comment.number) {
          results.push({ target, failed: message("githubComments.targetInvalid") });
          continue;
        }
        if (!commentAllowed(comment.repo, project?.targets ?? [], task)) {
          results.push({ target, failed: message("githubComments.targetNotAllowed") });
          continue;
        }
        try {
          const token = await this.githubToken(task, comment.repo, usedSecrets);
          const where = { repo: comment.repo, token, number: comment.number };
          // 承認の後の投稿は、承認を待つ間に投稿済みの同じ提出の頼み（目印の承認の日時の所が提出の回のもの）も探す。
          // 承認を待つ間の投稿の最中にマージされて記録できなかったときも、二重に投稿しない
          const submitted =
            when === "approved" && approved
              ? await this.deps.pulls.findIssueComment({
                  ...where,
                  marker: githubCommentMarker(
                    task.id,
                    step,
                    `submission-${approved.submission}`,
                    index,
                  ),
                })
              : undefined;
          const existing =
            submitted ??
            (await this.deps.pulls.findIssueComment({
              ...where,
              marker: githubCommentMarker(task.id, step, source.at, index),
            }));
          if (!existing && !valid()) return;
          const { url } =
            existing ??
            (await this.deps.pulls.commentIssue({
              ...where,
              body: buildGitHubComment({
                taskId: task.id,
                step,
                stepName: STEP_NAME[step],
                approvedAt: source.at,
                index,
                // 作業領域の内部のパスは、人が辿れないので、人が辿れる呼び方に置き換える（PBI-301 A7）
                body: withoutInternalPaths(comment.body),
                ...(when === "submitted" ? { awaitingApproval: true } : {}),
              }),
            }));
          results.push({ target, url });
        } catch (error) {
          results.push({ target, failed: redactText(errorText(error), usedSecrets) });
        }
      }
    }
    const latest = this.tasks.get(task.id);
    if (!latest || !valid()) return;
    this.append(latest, [
      {
        actor: "sacty",
        event: {
          type: "GitHubCommentsPosted",
          payload: {
            step,
            approvedAt: when === "approved" ? source.at : "",
            ...(submission !== undefined ? { submission } : {}),
            results,
            ...(failed ? { failed } : {}),
          },
        },
      },
    ]);
  }

  /**
   * レビューの工程の対象の PR を確かめる（PBI-19）。タスクにある、タスクの対象リポジトリの PR を、
   * プロジェクトの gh のアカウントで読む。確かめられなければ理由を返す（トークンは含めない）。
   */
  private async resolveReviewTarget(
    task: Task,
  ): Promise<
    | { ok: true; target: Extract<EventInput, { type: "ReviewTargetResolved" }>["payload"] }
    | { ok: false; message: DaemonText; abandoned?: true }
  > {
    const ref = referencedPullRequest(task);
    if (!ref) {
      const repo = (task.repository && githubRepoOf(task.repository.url)) ?? "";
      return { ok: false, message: message("review.pullRequestMissing", { repo }) };
    }
    const usedSecrets: string[] = [];
    try {
      // GitHub の一時的な失敗は、間を置いて自動でやり直す（PBI-301）
      const pr = await this.retryTransient(task.id, "reviewTarget", usedSecrets, async () => {
        const token = await this.githubToken(task, ref.repo, usedSecrets);
        return this.deps.pulls.pullRequest({ ...ref, token });
      });
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
      // やり直しの途中で止める・中止・デーモンの停止があった。何も記録せずに終える
      if (error instanceof RetryAbandoned) {
        return { ok: false, message: "", abandoned: true };
      }
      return { ok: false, message: redactText(errorText(error), usedSecrets) };
    }
  }

  /**
   * オーケストレーターが引き継いで直すと判断した、タスクにある既存の PR を確かめる。開いていて、元のブランチが対象リポジトリに
   * あり（フォークの PR でない）、ほかの sacty のタスクが扱っていない PR だけを引き継ぐ。確かめられなければ理由を返す
   * （トークンは含めない）。
   */
  private async resolveContinuedPullRequest(
    task: Task,
  ): Promise<{ ok: true; pr: ContinuedPullRequest } | { ok: false; message: DaemonText }> {
    const ref = continuablePullRequest(task);
    if (!ref) {
      const repo = (task.repository && githubRepoOf(task.repository.url)) ?? "";
      return { ok: false, message: message("review.pullRequestMissing", { repo }) };
    }
    const unavailable = (detail: DaemonText) => ({
      ok: false as const,
      message: message("continue.unavailable", { number: ref.number, detail }),
    });
    const owner = this.continuedPullRequestOwner(task.id, ref);
    if (owner) return unavailable(message("continue.inUse", { task: owner.id.slice(0, 8) }));
    const usedSecrets: string[] = [];
    try {
      const token = await this.githubToken(task, ref.repo, usedSecrets);
      const pr = await this.deps.pulls.pullRequest({ ...ref, token });
      if (pr.state === "merged" || pr.state === "closed") {
        return unavailable(message("continue.notOpen", { state: pr.state }));
      }
      if (
        pr.state !== "open" ||
        !pr.headRef ||
        !pr.baseRef ||
        !pr.headRepo ||
        !sameRepo(pr.headRepo, ref.repo)
      ) {
        return unavailable(message("continue.notSameRepository"));
      }
      return {
        ok: true,
        pr: {
          repo: ref.repo,
          number: ref.number,
          url: pr.url,
          branch: pr.headRef,
          baseBranch: pr.baseRef,
        },
      };
    } catch (error) {
      return unavailable(redactText(errorText(error), usedSecrets));
    }
  }

  /**
   * その PR を扱っている、ほかの sacty のタスク（中止したものを除く）。実装の PR・要求要件・設計の PR として作った PR と、
   * 引き継いだ PR。そのタスクが PR の指摘を取り込んで直し、PR やブランチを更新・中止で片付けるので、別のタスクには引き継がせない。
   */
  private continuedPullRequestOwner(
    taskId: string,
    ref: { repo: string; number: number },
  ): Task | undefined {
    const same = (pr: { repo?: string; number?: number } | undefined) =>
      pr?.number === ref.number && pr.repo !== undefined && sameRepo(pr.repo, ref.repo);
    return [...this.tasks.values()].find(
      (t) =>
        t.id !== taskId &&
        t.status !== "cancelled" &&
        (same(t.pullRequest) || same(t.continuedPullRequest) || t.stepPullRequests.some(same)),
    );
  }

  /**
   * PR のレビューの子タスクがレビューする先頭のコミットの CI の状態（PBI-331。sacty は CI を待たないので、子タスクが読んで
   * 指摘にする）。読めなければ、読めなかったことを渡す（レビューは止めない）。
   */
  private async reviewCiOf(
    task: Task,
    target: NonNullable<Task["reviewTarget"]>,
  ): Promise<ReviewCi> {
    const ci = this.deps.ci;
    const usedSecrets: string[] = [];
    if (!ci) return { commit: target.headCommit, checks: "unreadable" };
    let timer: NodeJS.Timeout | undefined;
    try {
      const token = await this.githubToken(task, target.repo, usedSecrets);
      const reading = ci.snapshot({ repo: target.repo, token, commit: target.headCommit });
      // 時間切れの後に届いた失敗は、知らせない（時間切れとして知らせる）
      reading.catch(() => {});
      const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(
          () => resolve("expired"),
          this.deps.reviewCiTimeoutMs ?? REVIEW_CI_TIMEOUT_MS,
        );
      });
      const snapshot = await Promise.race([reading, expired]);
      if (snapshot === "expired") {
        console.warn(
          `[daemon] レビューのタスク ${task.id} で、PR #${target.number}（${target.repo}）の CI が時間内に読めませんでした`,
        );
        return { commit: target.headCommit, checks: "unreadable" };
      }
      // ワークフローのほかに、その中のジョブも渡す（ワークフローが成功でも、実行されなかったジョブを見落とさない）
      return { commit: target.headCommit, checks: [...snapshot.checks, ...(snapshot.jobs ?? [])] };
    } catch (error) {
      console.warn(
        `[daemon] レビューのタスク ${task.id} で、PR #${target.number}（${target.repo}）の CI を読めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
      return { commit: target.headCommit, checks: "unreadable" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * PR のレビューのタスクに渡す、同じコミットで実行済みの検証の記録（PBI-305）。sacty が作った実装の PR（レビュー用のラベルで
   * 作ったレビューのタスク）で、その PR を作ったタスクの最終レビューの記録が、レビューする先頭のコミットのものなら返す。
   * 人の PR・コミットが進んだ PR・記録の無いものは無い（レビューは、CI の結果だけを自分で読んで使い回す）。
   */
  private reviewVerification(task: Task): VerificationRecord | undefined {
    const target = task.reviewTarget;
    if (!target || task.source?.kind !== "github_pull_request" || task.source.review !== "sacty") {
      return undefined;
    }
    const owner = this.continuedPullRequestOwner(task.id, target);
    const record = owner?.lastReview?.verificationRecord;
    return record?.commit !== undefined && record.commit === target.headCommit ? record : undefined;
  }

  /**
   * 引き継いで直す既存の PR にある、レビュー・行へのコメント・通常のコメント（本文のある承認も含む）。工程の指示に渡す。
   * 読めなくても工程は止めず、読めなかったこと（"unreadable"）を渡し、理由はデーモンのログに残す（秘密の値は伏せる）。
   */
  private async continuedFeedback(
    task: Task,
    continued: ContinuedPullRequest,
  ): Promise<PullRequestFeedback[] | "unreadable"> {
    const usedSecrets: string[] = [];
    try {
      const token = await this.githubToken(task, continued.repo, usedSecrets);
      return await this.deps.pulls.feedback({
        repo: continued.repo,
        token,
        number: continued.number,
        ...this.githubAccountOf(task, continued.repo),
        // sacty のタスクがこの PR に投稿したレビューも、PR の指摘として渡す（PR の指摘の取り込みの条件とは分ける）
        ...allSactyReviews(this.sactyReviewsOf(continued.repo, continued.number)),
        includeApprovals: true,
      });
    } catch (error) {
      console.warn(
        `[daemon] タスク ${task.id} で、引き継いだ PR #${continued.number}（${continued.repo}）のレビュー・コメントを読めませんでした。それらなしで進めます：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
      return "unreadable";
    }
  }

  /**
   * レビューの工程に渡す、対象の PR にすでにあるレビュー・行へのコメント・通常のコメント（existing。他のレビュアーの指摘と作者の返答。
   * このタスクのアカウントの sacty のレビューの目印で始まる投稿＝前回の投稿は含まない。PBI-144）と、再レビュー（PBI-44）での、
   * 前回のレビューの投稿の後の PR の作者の返答（replies。PBI-111。作者が前回の投稿の後に書いたもので、目印で始まるものは除く）。
   * 返答は再レビューのときだけ。作者が分からなければ、返答を選べないので返答だけ読めなかったもの（"unreadable"）にする。
   */
  private async reviewFeedback(
    task: Task,
    target: NonNullable<Task["reviewTarget"]>,
    usedSecrets: string[],
  ): Promise<{
    existing: PullRequestFeedback[];
    replies?: PullRequestFeedback[] | "unreadable";
  }> {
    const token = await this.githubToken(task, target.repo, usedSecrets);
    const account = this.githubAccountOf(task, target.repo).account;
    const existing = await this.deps.pulls.feedback({
      repo: target.repo,
      token,
      number: target.number,
      ...(account ? { account } : {}),
      // レビューが止まったことの投稿（PBI-292）を除くために、ほかのプロジェクトで選んだ同じホストのアカウントも渡す
      noticeAccounts: this.githubAccountsOnHost(target.repo),
      // 本文のある承認（「承認するが、ここは直してほしい」）も、既存の指摘として渡す（PR #161 レビュー指摘）
      includeApprovals: true,
    });
    const previous = task.previousReview;
    if (!previous) return { existing };
    const author = target.author.toLowerCase();
    if (!author) return { existing, replies: "unreadable" };
    const since = Date.parse(previous.at);
    const replies = existing.filter(
      (item) =>
        item.author.toLowerCase() === author &&
        Date.parse(item.at) > since &&
        sactyReviewTask(item.body) === undefined,
    );
    return { existing, replies };
  }

  /**
   * Sacty のレビューのタスクの GitHub への問い合わせ（レビューの対象の PR の確認・レビューの投稿）を、一時的な失敗なら、間を
   * 置いて自動でやり直す（PBI-301）。一時的な失敗は GitHub の 5xx・レート制限・接続の失敗。権限が無いなど、待っても変わらない
   * 失敗はやり直さずに投げる。やり直しの回数の上限（deps.reviewRetryDelaysMs の長さ）を超えたときも、最後の失敗を投げる。
   * やり直す前に、作業履歴へ ReviewGitHubRetried を記録する。待つ間に止める・中止・デーモンの停止があれば、やり直しをやめて
   * RetryAbandoned を投げる。
   */
  private async retryTransient<T>(
    taskId: string,
    where: "reviewTarget" | "reviewPost",
    usedSecrets: readonly string[],
    attempt: () => Promise<T>,
  ): Promise<T> {
    const delays = this.deps.reviewRetryDelaysMs ?? [15_000, 60_000, 180_000, 300_000];
    const abandoned = () =>
      this.stopping ||
      this.cancelling.has(taskId) ||
      this.pauseRequested.has(taskId) ||
      !this.tasks.has(taskId);
    for (let retry = 0; ; retry++) {
      try {
        return await attempt();
      } catch (error) {
        const waitMs = delays[retry];
        if (waitMs === undefined || !isTransientGitHubFailure(error)) throw error;
        if (abandoned()) throw new RetryAbandoned();
        const task = this.tasks.get(taskId);
        if (task && task.status !== "cancelled") {
          this.append(task, [
            {
              actor: "sacty",
              event: {
                type: "ReviewGitHubRetried",
                payload: {
                  where,
                  attempt: retry + 1,
                  maxAttempts: delays.length,
                  waitMs,
                  message: redactText(errorText(error), usedSecrets),
                },
              },
            },
          ]);
        }
        // 長く待つ間も、止める・中止・停止に気づけるよう、短く区切って待つ
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
          if (abandoned()) throw new RetryAbandoned();
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
        }
        if (abandoned()) throw new RetryAbandoned();
      }
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
      // GitHub の一時的な失敗は、間を置いて自動でやり直す（PBI-301）。やり直しの間は止めないので、PR に「止まりました」の知らせも
      // 出さない。上限を超えたら、今までどおり理由を記録して止まる。やり直しても、投稿済みのレビューは目印で見つけて二度投稿しない
      event = await this.retryTransient(task.id, "reviewPost", usedSecrets, () =>
        this.composeReviewPost(task, target, usedSecrets),
      );
    } catch (error) {
      if (error instanceof RetryAbandoned) return;
      event = {
        type: "TaskPaused",
        payload: { reason: "error", message: redactText(errorText(error), usedSecrets) },
      };
    }
    const latest = this.tasks.get(task.id);
    if (!latest || !awaitingReviewPost(latest) || this.pauseRequested.has(task.id)) return;
    this.append(latest, [{ actor: "sacty", event }]);
    // 前に止まったときの、PR の知らせの投稿を解消済みにする（PBI-292）
    if (event.type === "PullRequestReviewPosted") {
      await this.resolveReviewStops(
        {
          taskId: task.id,
          projectId: task.projectId,
          target: { repo: target.repo, number: target.number },
        },
        event.payload.url,
      );
    }
  }

  /** レビューを PR に投稿して、記録するイベント（PullRequestReviewPosted）を返す。投稿できなければ例外。 */
  private async composeReviewPost(
    task: Task,
    target: NonNullable<Task["reviewTarget"]>,
    usedSecrets: string[],
  ): Promise<EventInput> {
    // 認証・既存のレビューの検索・自分へのメンションに、同じアカウントを使う（トークンを取り出している間にプロジェクトの
    // アカウントが変わっても、投稿するアカウントと違う人にメンションしないように。PR #197 レビュー指摘）
    const project = this.deps.projects.get(task.projectId);
    const token = await this.githubToken(task, target.repo, usedSecrets, project);
    const account = project?.githubAccounts?.[httpsHost(`${target.repo}/`) ?? ""] ?? "";
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
      if (!/^[0-9A-Za-z]{7,64}$/.test(head)) throw new MessageError(message("review.headUnknown"));
      latestCommit = head !== target.headCommit ? head : undefined;
    }
    // sacty の設定で選んでいれば、PR の作者ではなく自分（投稿するアカウント）にメンションする
    const mentionSelf = this.deps.settings.get().reviewMentionSelf ? account : undefined;
    const post = (foldComments: boolean) =>
      this.deps.pulls.postReview({
        ...pr,
        commit: target.headCommit,
        body: buildReviewBody(task, {
          foldComments,
          ...(latestCommit ? { latestCommit } : {}),
          ...(mentionSelf !== undefined ? { mentionSelf } : {}),
        }),
        comments: foldComments ? [] : buildReviewComments(task),
      });
    const { url } =
      existing ??
      (await post(false).catch((error: unknown) => {
        // 行へのコメントを受け付けられなかった（行が差分に無いなど）なら、本文に入れて投稿し直す
        if (task.reviewComments.length > 0 && githubStatus(error) === 422) return post(true);
        throw error;
      }));
    return {
      type: "PullRequestReviewPosted",
      payload: { url, ...(latestCommit ? { latestCommit } : {}) },
    };
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
    // 再実行・作成時に人が指定した・プロジェクトの対象で指定したイメージがあれば、オーケストレーターに選ばせない（PBI-41・
    // PBI-318）。古い版の作業履歴で、人が作成時に進め方のすべての工程のイメージを指定したタスクも選ばせない
    const pinned = this.pinnedImage(task);
    const allRequested = legacyAllRequested(task);
    const candidates =
      pinned || allRequested
        ? []
        : Object.values(config.images ?? {}).map(({ name, description }) => ({
            name,
            description,
          }));
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
                context: `${contextSource.repo}${contextSource.path ? `の ${contextSource.path}` : ""}${contextSource.ref ? `（${contextSource.ref}）` : ""}`,
              }
            : {}),
          rules: exports.rules,
          githubHosts: Object.keys(this.githubRelayHosts(task.id)),
        }
      : undefined;
    const planned = this.deps.planner
      ? await this.deps.planner(task)
      : await this.askOrchestrator(task, config, candidates, exports, shared, repoless);
    if ("failure" in planned) return planned;
    const { repo: chosenRepo, repoReason, ...rest } = planned;
    let choice: PlannedSteps = rest;
    if (repoless) {
      // コードの変更が要る（分けない）・コードを点検する（セキュリティチェック）なら、作業するリポジトリを対象から選ぶ。
      // 選べなければ、理由を示して止める（人がリポジトリを選んで再開できる）
      if (
        choice.steps.some((step) => REPO_STEPS.includes(step)) ||
        choice.plan === "security-check"
      ) {
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
    const exported = this.withExports(withShared, exports.destinations);
    // 古い版の作業履歴で、すべての工程のイメージを人が指定したタスクは、タスクのイメージを決めない（投影が人の指定を入れる）
    const { image: _picked, ...withoutImage } = exported;
    const decided = this.withImages(
      allRequested ? withoutImage : exported,
      config,
      allRequested ? undefined : pinned,
      // images の候補を見せたら、既定のイメージで動かすときの理由を確かめる（PBI-105・PBI-318）
      candidates.length > 0 && !repoless,
    );
    // 古い版の作業履歴で、一部の工程だけイメージを人が指定したタスクは、イメージが決まらなくても既定のイメージをタスクの
    // イメージとして確かめる。決めないと、投影が古い工程ごとの指定を入れ、工程の間でイメージがそろわない（PR #322 レビュー指摘）
    if (
      !("failure" in decided) &&
      !allRequested &&
      !decided.image &&
      Object.keys(task.requestedImages ?? {}).length > 0
    ) {
      return { ...decided, image: DEFAULT_IMAGE_NAME };
    }
    return decided;
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
      ...unknownCost(choice),
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
    // チケットのタスクの再実行は、リポジトリを指定せずに作ったタスクと同じく選ぶ（チケットを読み直さない）
    if (task.ticket && !task.rerun) return this.chooseTicketRepository(id, repo);
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
          ...unknownCost(choice),
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

  /** ローカルのセッション（`sacty launch`）ごとの後片付け（ゲートウェイの登録・ホストの MCP サーバー・一時ディレクトリ）。 */
  private readonly localSessions = new Map<string, () => void>();

  /**
   * ローカルのセッション（`sacty launch`）を作る。プロジェクトのコンテキストを、実行・プレビューと同じ組み立てで、ゲートウェイの
   * 起点をホストから見たもの（127.0.0.1）にして作り、置くファイル（中身）と環境変数を返す。dir は CLI が作った一時ディレクトリ
   * （Codex の規則のスキルの場所を、その絶対パスで書くため）。MCP と外部 PF は、このセッション用に登録したゲートウェイの
   * トークンで使える（closeLocalSession で閉じる）。作業履歴には記録しない。プロジェクトが無ければ undefined。
   */
  async createLocalSession(
    projectId: string,
    runtime: "claude-code" | "codex",
    dir: string,
  ): Promise<{ session: LocalSessionView } | { error: DaemonText } | undefined> {
    const project = this.deps.projects.get(projectId);
    if (!project) return undefined;
    const loaded = this.deps.config();
    const config = loaded.ok ? loaded.config : undefined;
    const usedSecrets: string[] = [];
    const cleanups: (() => void)[] = [];
    const cleanup = () => {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          // 後片付けの失敗で、ほかの後片付けを止めない
        }
      }
    };
    try {
      const gateway = this.deps.gateway;
      const origin = gateway?.hostOrigin?.();
      // ゲートウェイの起点はホストから見たもの。手元のセッションには実行の上限が無いので、時間切れの警告は出さない
      const routing: McpRouting = origin
        ? { ...this.mcpRouting(config, undefined, origin), runLimitMs: Number.POSITIVE_INFINITY }
        : { runLimitMs: Number.POSITIVE_INFINITY };
      // 段階のサブエージェントは、sacty の AI の定義のモデルで作る。Bedrock・providers の接続先のモデルの名前は、手元の
      // ログインでは使えないので置かない
      const parent = config ? this.previewParent(config, runtime) : undefined;
      const warnings: DaemonText[] = [];
      let tiers: { entries: PlacedTier[]; warnings: DaemonText[] } = { entries: [], warnings: [] };
      if (parent && config) {
        if (parent.auth.mode === "bedrock" || parent.auth.mode === "provider") {
          warnings.push(
            message("local.tiersSkipped", { parent: parent.id, mode: parent.auth.mode }),
          );
        } else {
          tiers = this.tiersFor(parent, config);
        }
      }
      const prepared = await prepareContext(
        this.deps.contexts,
        project.context,
        runtime,
        dir,
        (repo) => this.gitAuth({ projectId }, repo, usedSecrets),
        this.deps.defaultContext,
        routing.hostMcp ?? [],
        routing.gatewayOrigin,
        undefined,
        routing.hostCommands,
        tierFiles(runtime, tiers.entries),
        routing.runLimitMs,
      );
      cleanups.push(prepared.dispose);
      warnings.push(...prepared.warnings, ...tiers.warnings);
      // 層の command の MCP サーバーは、実行と同じくホストで起動する（PBI-84）
      const relays: (GatewayMcpServer | HostedMcpRelay)[] = [...prepared.gatewayMcp];
      if (prepared.hostedMcp.length > 0 && this.deps.contextMcp) {
        const lease = this.deps.contextMcp.lease(
          projectId,
          prepared.hostedMcp,
          project.name ?? projectId,
        );
        cleanups.push(() => lease.release());
        relays.push(...lease.relays);
        warnings.push(...(await this.deps.contextMcp.ready(lease.keys)));
      }
      // 使えるホストの MCP サーバーの準備を待つ（PBI-77）。準備ができないものは注意にする
      const hostNames = (routing.hostMcp ?? []).map((m) => m.name);
      if (hostNames.length > 0 && this.deps.hostMcpReady) {
        warnings.push(...(await this.deps.hostMcpReady(hostNames)));
      }
      const platforms = mergePlatforms(config?.platforms ?? [], prepared.platforms);
      warnings.push(...platforms.warnings);
      const env: Record<string, string> = { ...prepared.placed.env };
      const tokenEnvs = prepared.placed.secrets.filter((s) => s.secret === GATEWAY_TOKEN_SECRET);
      let token: string | undefined;
      if (gateway && origin && (tokenEnvs.length > 0 || platforms.platforms.length > 0)) {
        // MCP の中継先（ヘッダーの秘密情報はホストで取り出し、ゲートウェイだけに持たせる。PBI-49）
        const contextMcp: Record<string, ContextMcpRoute> = {};
        for (const server of relays) {
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
        // AI の呼び出しと GitHub の読み取りは中継しない（AI は利用者のログインで直接つなぎ、GitHub はホストの gh を使える）
        const registered = gateway.register(
          undefined,
          contextMcp,
          platforms.platforms.filter((p) => p.from !== undefined),
        );
        cleanups.push(() => registered.close());
        token = registered.token;
        for (const s of tokenEnvs) env[s.env] = `${s.prefix}${token}`;
        if (platforms.platforms.length > 0) env.SACTY_PF_URL = gateway.platformsUrl(token, origin);
      }
      // via_gateway: false の MCP サーバーの秘密情報は、実行のときにコンテナへ渡すのと同じく、環境変数で渡す
      for (const s of prepared.placed.secrets) {
        if (s.secret === GATEWAY_TOKEN_SECRET) continue;
        const value = await this.deps.secrets.get(s.secret);
        usedSecrets.push(value);
        env[s.env] = `${s.prefix}${value}`;
      }
      // ゲートウェイを使えなければ、外部 PF は渡せない（ホストから見た起点が無い）。黙って落とさず、注意にする
      if (!token && platforms.platforms.length > 0) {
        warnings.push(message("local.platformsUnavailable"));
      }
      // 置いたファイルの中身。規則には、使える外部 PF の案内を足す（工程では指示に足しているもの。PBI-35）
      const rulesPath = runtime === "codex" ? "AGENTS.md" : "CLAUDE.md";
      const pfLines = token ? platformPromptLines(platforms.platforms) : [];
      const files: LocalSessionView["files"] = prepared.files.map((f) => ({
        path: f.path,
        ...(f.from ? { from: f.from } : {}),
        content: readFileSync(join(prepared.dir, f.path)).toString("base64"),
      }));
      // 中身を読んだら、取得した層は要らない（ホストで起動する MCP サーバーは、確保のときに層を写してある）
      prepared.dispose();
      if (pfLines.length > 0) {
        const existing = files.find((f) => f.path === rulesPath);
        const before = existing ? Buffer.from(existing.content, "base64").toString("utf8") : "";
        const content = Buffer.from(`${before}${pfLines.join("\n")}\n`).toString("base64");
        if (existing) existing.content = content;
        else files.push({ path: rulesPath, content });
      }
      const id = randomUUID();
      this.localSessions.set(id, cleanup);
      return {
        session: {
          id,
          runtime,
          files,
          env,
          mcpServers: prepared.placed.mcpServers,
          warnings: warnings.map((w) => redactText(w, usedSecrets)),
        },
      };
    } catch (error) {
      cleanup();
      return { error: redactText(errorText(error), usedSecrets) };
    }
  }

  /** ローカルのセッションを終える（ゲートウェイの登録を閉じ、ホストで起動した MCP サーバーを手放す）。無ければ false。 */
  closeLocalSession(id: string): boolean {
    const cleanup = this.localSessions.get(id);
    if (!cleanup) return false;
    this.localSessions.delete(id);
    cleanup();
    return true;
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
   * プレビューで段階の親にするエージェント（PBI-119）。その runtime の既定のエージェント、無ければ工程・監査の
   * エージェントのうち最初のもの。その runtime のエージェントが無ければ undefined。
   */
  private previewParent(config: SactyConfig, runtime: TierRuntime): AgentConfig | undefined {
    return [config.defaultAgent, ...Object.values(config.stepAgents ?? {}), config.auditAgent].find(
      (a) => a?.runtime === runtime,
    );
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
        await rm(dir, { recursive: true, force: true });
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
      if (compose) await rm(dir, { recursive: true, force: true });
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
      if (compose) await rm(dir, { recursive: true, force: true });
      return stopped;
    }
    if (!result.ok && compose) await rm(dir, { recursive: true, force: true });
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

  /** サービスを止めて消す（PBI-47）。使わない工程なら何もしない。止められなくても、工程の結果は変えない。 */
  private async stopServices(task: Task, step: StepKey, runId: string): Promise<void> {
    const spec = this.serviceSpec(this.tasks.get(task.id) ?? task, step);
    if (!spec || !this.deps.services) return;
    await this.deps.services.stop(runId).catch(() => undefined);
    // 共用の compose を取得したディレクトリも消す（PBI-70）
    if (spec.compose) {
      await rm(sharedComposeRunDir(this.deps.workspaceRoot, runId), {
        recursive: true,
        force: true,
      });
    }
  }

  /**
   * オーケストレーターに選ばせずに決まっているタスクのイメージの名前と、決めた元。優先の順に、再実行で人が指定したもの・
   * 作成時に人が指定したもの（PBI-318）・プロジェクトの対象で指定したもの（PBI-41）。
   */
  private pinnedImage(task: Task): PinnedImage | undefined {
    if (task.rerun?.image) return { name: task.rerun.image, source: "rerun" };
    if (task.requestedImage) return { name: task.requestedImage, source: "request" };
    const repo = task.source
      ? task.source.repo
      : (task.repo ?? (task.repository && githubRepoOf(task.repository.url)));
    const project = this.deps.projects.get(task.projectId);
    const name = repo && project ? targetImageOf(project, repo) : undefined;
    return name ? { name, source: "project" } : undefined;
  }

  /**
   * プロジェクトで使えるイメージを足した設定（PBI-325）。config.yaml の images に、プロジェクトのコンテキストの images.yaml の
   * イメージを足す（同じ名前は config.yaml のものを使う）。作成中・作成に失敗したものは、使えない理由を付けて足す（選べるが、
   * 実行のときは理由を示して止める）。
   */
  private projectImagesConfig(config: SactyConfig, projectId: string): SactyConfig {
    const entries = this.deps.contextImages?.images(projectId) ?? [];
    if (entries.length === 0) return config;
    const project = this.deps.projects.get(projectId)?.name ?? projectId;
    const added: Record<string, LanguageImage> = {};
    for (const entry of entries) {
      if (hasImage(config, entry.name)) continue;
      added[entry.name] = {
        ...entry.language,
        ...(entry.state === "ready"
          ? {}
          : {
              unavailable:
                entry.state === "failed"
                  ? message("contextImage.failed", {
                      project,
                      name: entry.name,
                      detail: entry.error ?? "",
                    })
                  : message("contextImage.building", { project, name: entry.name }),
            }),
      };
    }
    return { ...config, images: { ...added, ...config.images } };
  }

  /**
   * コンテキストのイメージを作り終えるのを待つタスクか（PBI-325）。プロジェクトのコンテキストのイメージを読んでいる・作って
   * いる間、そのイメージを使うかもしれないタスク（イメージをまだ選んでいない・コンテキストのイメージを使う）は、実行を始めずに
   * 待たせる（オーケストレーターが合わないイメージを選ばないように。作り終えたものから選ばせる）。上限を過ぎたら、理由を
   * 示して止める。待っている間も、一時停止・中止はできる（実行を始めていないので）。
   */
  private awaitingContextImages(task: Task): boolean {
    const builder = this.deps.contextImages;
    const config = this.deps.config();
    if (
      !builder ||
      !config.ok ||
      task.status !== "queued" ||
      !builder.pending(task.projectId) ||
      !this.mayUseContextImage(task, config.config)
    ) {
      this.contextImageWaits.delete(task.id);
      return false;
    }
    const now = this.now();
    const since = this.contextImageWaits.get(task.id) ?? now;
    this.contextImageWaits.set(task.id, since);
    const limit = this.deps.contextImagesWaitMs ?? CONTEXT_IMAGES_WAIT_MS;
    if (now - since < limit) return true;
    this.contextImageWaits.delete(task.id);
    const project = this.deps.projects.get(task.projectId)?.name ?? task.projectId;
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: {
            reason: "error",
            message: message("contextImage.waitTimedOut", {
              project,
              minutes: Math.round(limit / 60_000),
            }),
          },
        },
      },
    ]);
    return true;
  }

  /**
   * タスクがコンテキストのイメージを使うかもしれないか（PBI-325）。イメージをまだ決めていない（工程を選ぶ前で、人も
   * プロジェクトの対象も指定していない）か、決めた名前が既定のイメージでも config.yaml の images でもない。
   */
  private mayUseContextImage(task: Task, config: SactyConfig): boolean {
    // 実行のときと同じ順で決める（stepImageOf）。タスクのイメージ（人が変えたものを含む）があれば、それだけを見る。
    // 古い版の作業履歴の工程ごとのイメージ、工程を選ぶ前なら決まっているイメージ（作成時・プロジェクトの対象）の順
    const legacy = Object.values(task.images ?? {}).filter(
      (n): n is string => typeof n === "string",
    );
    const pinned = task.steps.length === 0 ? this.pinnedImage(task)?.name : undefined;
    const names =
      task.image !== undefined
        ? [task.image]
        : legacy.length > 0
          ? legacy
          : pinned !== undefined
            ? [pinned]
            : [];
    if (names.length === 0) return task.steps.length === 0;
    return names.some((n) => n !== DEFAULT_IMAGE_NAME && !hasImage(config, n));
  }

  /**
   * タスクのイメージを決める（PBI-41・PBI-318）。決まっているイメージ（pinned）があれば、それを使う。無ければ
   * オーケストレーターの選択。images に無い名前なら、理由を示して止める（再開すると選び直す）。
   * offered（images の候補をオーケストレーターに見せた）なら、既定のイメージで動かすときに、images のどれも合わない理由を
   * 記録し、理由が無い（書かなかった・default と書いて理由が無い）ことも記録する（PBI-105 の考え方。既定のイメージに黙って
   * 倒さない）。
   */
  private withImages(
    choice: ChosenSteps,
    config: SactyConfig,
    pinned: PinnedImage | undefined,
    offered = false,
  ): ChosenSteps | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] } {
    const {
      image: picked,
      imageReason,
      defaultImageReason: reason,
      imageUnexplained: _unexplained,
      // 古い版の工程ごとのイメージは、新しい記録には書かない
      images: _images,
      defaultImageReasons: _reasons,
      imagesUnexplained: _stepsUnexplained,
      ...rest
    } = choice;
    const image = pinned ? pinned.name : picked;
    // コンテキストのイメージ（PBI-325）は、作成中・作成に失敗したものも選べる（実行のときに待つか、理由を示して止める）
    if (image && !imageDefined(config, image)) {
      return {
        failure: {
          reason: "error",
          message: pinned
            ? message("image.unknown", { name: image })
            : message("orchestrator.failed", {
                detail: message("image.unknown", { name: image }),
              }),
          agentId: choice.agentId ?? "unknown",
          ...(choice.authMode ? { authMode: choice.authMode } : {}),
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
          // 実行の ID を引き継ぐ（代わりのエージェントで選び直すため。PR #180 レビュー指摘）
          ...(choice.runId ? { runId: choice.runId } : {}),
          ...(choice.usage ? { usage: choice.usage } : {}),
          costUsd: choice.costUsd,
          estimated: choice.estimated,
          ...unknownCost(choice),
        },
      };
    }
    const onDefault = !image || image === DEFAULT_IMAGE_NAME;
    const defaults =
      offered && !pinned && onDefault
        ? reason
          ? { defaultImageReason: reason }
          : { imageUnexplained: true as const }
        : {};
    if (!image) return { ...rest, ...defaults };
    return {
      ...rest,
      image,
      imageSource: pinned ? pinned.source : "orchestrator",
      ...(!pinned && imageReason ? { imageReason } : {}),
      ...defaults,
    };
  }

  /**
   * オーケストレーターを実行する（工程の選択・レビューのイメージの選択で共通。PBI-17）。実行に失敗したら、理由と使った分の費用を
   * failure で返す。promptOf には、使える外部 PF を渡す（指示に API を書くため）。
   */
  private async runOrchestrator(
    task: Task,
    config: SactyConfig,
    promptOf: (platforms: readonly Platform[]) => string,
    /** gather：タスクの開始時の情報収集（step_agents.gather。セッションは保存しない）。 */
    role: "orchestrator" | "gather" = "orchestrator",
  ): Promise<
    | {
        output: string;
        cost: Omit<
          Extract<EventInput, { type: "OrchestratorFailed" }>["payload"],
          "reason" | "message"
        >;
      }
    | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] }
  > {
    // オーケストレーターに使う AI（step_agents.orchestrator か default_agent。PBI-40）。既定のイメージで動く。
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）。セッションは、前のエージェントのものを引き継ぐ
    const agent = this.usableAgent(config, agentFor(config, role), task.id, role);
    const failed = (detail: DaemonText) =>
      message(role === "gather" ? "gather.failed" : "orchestrator.failed", { detail });
    // 工程の実行と同じく、既定のコンテキストとプロジェクトのコンテキスト（規則・スキル・MCP サーバー）を渡す（PBI-146。
    // 既定のスキル plan-steps で、答えの JSON を検査させる）。用意できなければ、実行せずに理由を返す（費用は無い）
    const runId = randomUUID();
    const contextSecrets: string[] = [];
    let context: RunContext | undefined;
    try {
      context = await this.runContext(task, agent, config, contextSecrets, undefined, role);
    } catch (error) {
      return {
        failure: {
          reason: "error",
          message: failed(redactText(errorText(error), contextSecrets)),
          agentId: agent.id,
          ...agentSetting(agent),
          runId,
          costUsd: 0,
          estimated: false,
        },
      };
    }
    // 使える外部 PF：ホストの PF と、プロジェクトのコンテキストで合成した PF（工程の実行と同じ。PBI-74）
    const runPlatforms = mergePlatforms(config.platforms, context?.platforms ?? []);
    // 用意したコンテキスト（層・注意・置いた段階・PF）を、実行の記録として残す（ほかの実行と同じ。PBI-119）
    const record = (id: string) => {
      if (context) {
        this.append(this.mustGet(task.id), [this.contextResolved(id, context, runPlatforms)]);
      }
    };
    let ran: Awaited<ReturnType<TaskService["runGuardian"]>>;
    try {
      record(runId);
      ran = await this.runGuardian(
        task,
        {
          agent,
          image: config.image,
          runId,
          // 再開できなかったセッションを新しく始め直したら（PBI-67）、その実行の ID でも記録する（PR #162 レビュー指摘）
          onRunId: record,
          platforms: runPlatforms.platforms,
          context: context && { dir: context.dir, ...context.placed },
          ...(context && context.gatewayMcp.length > 0 ? { contextMcp: context.gatewayMcp } : {}),
          ...(context && context.tiers.length > 0 ? { estimateCost: true } : {}),
          prompt: promptOf(runPlatforms.platforms),
          role,
        },
        "base",
      );
    } finally {
      context?.dispose();
    }
    // 再開できなかったセッションを新しく始め直したら、実行の ID はそちらになる（PBI-67）
    const { outcome, costUsd, estimated, runId: ranId } = ran;
    // 実行に失敗した・選んだ工程を読み取れなかったときは、理由を記録して止める（PBI-32・PBI-40）。
    // 標準の工程で代わりに進めると、テストのコマンドも決まらず、調査のタスクでも設計・実装に進んでしまうため。
    // 再開すると、工程の選択からやり直す。使った分の費用は記録する
    const cost = {
      agentId: agent.id,
      ...agentSetting(agent),
      runId: ranId,
      usage: outcome.usage,
      costUsd,
      estimated,
      ...unknownCost(ran),
    };
    if (outcome.kind === "failed") {
      return {
        failure: {
          reason: outcome.reason,
          message: failed(outcome.message),
          ...cost,
        },
      };
    }
    return { output: outcome.output, cost };
  }

  /**
   * PR のレビューだけのタスク（PBI-44）の工程。工程はレビューだけに決め、オーケストレーターには選ばせない。プロジェクトの
   * 対象・再実行でイメージを決めておらず、images があるときだけ、レビューの工程のイメージをオーケストレーターに選ばせる
   * （レビューは検証コマンドを実行するので、既定のイメージでは動かないことがある）。既定のイメージを選んだら、その理由
   * （または理由が無いこと）を記録する（PBI-105）。
   */
  private async chooseReviewSteps(
    task: Task,
    config: SactyConfig,
    via: "requested" | "label" | "sacty",
  ): Promise<
    ChosenSteps | { failure: Extract<EventInput, { type: "OrchestratorFailed" }>["payload"] }
  > {
    const pinned = this.pinnedImage(task);
    const candidates = Object.values(config.images ?? {}).map(({ name, description }) => ({
      name,
      description,
    }));
    if (pinned || candidates.length === 0) {
      return this.withImages(reviewOnlySteps(via), config, pinned);
    }
    const ran = await this.runOrchestrator(task, config, (platforms) =>
      [buildReviewImagePrompt(task, candidates), ...platformPromptLines(platforms)].join("\n"),
    );
    if ("failure" in ran) return ran;
    const chosen = extractReviewImage(ran.output);
    if (!chosen) {
      return {
        failure: {
          reason: "error",
          message: message("orchestrator.failed", { detail: message("orchestrator.unreadable") }),
          ...ran.cost,
        },
      };
    }
    return this.withImages(
      {
        ...reviewOnlySteps(via, true),
        image: chosen.image,
        ...(chosen.reason ? { imageReason: chosen.reason } : {}),
        ...(chosen.defaultReason ? { defaultImageReason: chosen.defaultReason } : {}),
        ...ran.cost,
      },
      config,
      undefined,
      true,
    );
  }

  /**
   * 工程の見直し：工程が終わった後、次の工程を実行する前に、オーケストレーターに終わった工程の成果を読ませ、まだの工程の
   * うち飛ばせる工程（skippableSteps）が要るかを決めさせて、StepsSkipped を記録する。工程を足す・並べ替えることはさせない。
   * 見直しは成果物を作らない補助の判断なので、実行できなかった・答えを読めなかったときは、止めずに飛ばさないで進める
   * （sacty の記録）。予算の上限に達していれば見直さない（次の工程の実行の前に一時停止し、再開したら見直す）。
   */
  private async reviewSteps(task: Task, after: StepKey, config: SactyConfig): Promise<void> {
    if (budgetState(task.budget) === "exceeded") return;
    const skippable = skippableSteps(task);
    if (skippable.length === 0) return;
    if (this.deps.stepReviewer || this.deps.planner) {
      if (!this.deps.stepReviewer) return;
      const reviewed = await this.deps.stepReviewer(task, after, skippable);
      const latest = this.mustGet(task.id);
      if (latest.status !== "queued" || latest.stepReview !== after) return;
      this.append(latest, [
        { actor: "orchestrator", event: { type: "StepsSkipped", payload: { after, ...reviewed } } },
      ]);
      return;
    }
    const ran = await this.runOrchestrator(task, config, (platforms) =>
      [buildStepReviewPrompt(task, after, skippable), ...platformPromptLines(platforms)].join("\n"),
    );
    // 見直している間に、人間が止めた・中止した・工程が変わったなら、記録しない（止めた記録は runNext の後始末で行う）
    const latest = this.mustGet(task.id);
    if (
      this.pauseRequested.has(task.id) ||
      this.cancelling.has(task.id) ||
      latest.status !== "queued" ||
      latest.stepReview !== after
    ) {
      return;
    }
    const chosen = "failure" in ran ? undefined : extractStepReview(ran.output, skippable);
    if ("failure" in ran || !chosen) {
      const {
        reason: _reason,
        message: detail,
        ...cost
      } = "failure" in ran
        ? ran.failure
        : { reason: "error", message: message("orchestrator.unreadable"), ...ran.cost };
      // コンテナが止まったことを確かめられなかった実行（元のコンテナが動いたままかもしれない）なら、次の工程の実行と
      // 重ならないように止める（代わりのエージェントに切り替えないのと同じ。fallBack）
      const unconfirmed = "failure" in ran && this.unconfirmedRuns.delete(ran.failure.runId ?? "");
      this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "StepsSkipped",
            payload: {
              after,
              steps: [],
              reason: message("orchestrator.stepReviewFailed", { detail }),
              ...cost,
            },
          },
        },
        ...(unconfirmed && "failure" in ran
          ? [
              {
                actor: "sacty" as const,
                event: {
                  type: "TaskPaused" as const,
                  payload: { reason: ran.failure.reason, message: ran.failure.message },
                },
              },
            ]
          : []),
      ]);
    } else {
      this.append(latest, [
        {
          actor: "orchestrator",
          event: {
            type: "StepsSkipped",
            payload: { after, steps: chosen.steps, reason: chosen.reason, ...ran.cost },
          },
        },
      ]);
    }
    this.warnIfNeeded(this.mustGet(task.id));
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
    const ran = await this.runOrchestrator(task, config, (platforms) =>
      [
        buildOrchestratorPrompt(task, {
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
          // 作業のみ（operation）の接続先にできる GitHub のホスト
          githubHosts: Object.keys(this.githubRelayHosts(task.id)),
        }),
        // 使える組織内 PF の API（PBI-35・PBI-74）
        ...platformPromptLines(platforms),
      ].join("\n"),
    );
    if ("failure" in ran) return ran;
    const { output, cost } = ran;
    const chosen = extractStepPlan(output, allowedPlans(task));
    if (chosen) {
      return {
        steps: [...STEP_PLANS[chosen.plan]],
        plan: chosen.plan,
        ...(chosen.operation ? { operation: chosen.operation } : {}),
        reason: chosen.reason,
        fallback: false,
        ...(chosen.testCommand ? { testCommand: chosen.testCommand } : {}),
        ...(chosen.noTests ? { noTestsReason: chosen.noTests } : {}),
        ...(chosen.documentsOnly ? { documentsOnly: true as const } : {}),
        ...(chosen.investigation ? { investigation: chosen.investigation } : {}),
        ...(chosen.image ? { image: chosen.image } : {}),
        ...(chosen.imageReason ? { imageReason: chosen.imageReason } : {}),
        ...(chosen.defaultReason ? { defaultImageReason: chosen.defaultReason } : {}),
        ...(chosen.services ? { services: chosen.services } : {}),
        ...(chosen.servicesReason ? { servicesReason: chosen.servicesReason } : {}),
        ...(chosen.baseBranch ? { baseBranch: chosen.baseBranch } : {}),
        ...(chosen.exports ? { exports: chosen.exports } : {}),
        ...(chosen.documentsDir ? { documentsDir: chosen.documentsDir } : {}),
        ...(chosen.repo ? { repo: chosen.repo } : {}),
        ...(chosen.repoReason ? { repoReason: chosen.repoReason } : {}),
        ...(chosen.continuePullRequest ? { continuePullRequest: true as const } : {}),
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

  /**
   * PR のレビューの子タスクの指示に渡す、親の PR の工程・戻し先の候補・承認済みの成果物（PBI-332）。子タスクでなければ・親が
   * 無ければ渡さない（ラベルや依頼で取り込んだレビューだけのタスクは、戻し先を示さない）。
   */
  private reviewReworkContext(task: Task): { reviewRework?: ReviewReworkContext } {
    const of = this.tasks.get(task.id)?.reviewOf;
    const parent = of && this.tasks.get(of.taskId);
    if (!of || !parent) return {};
    return { reviewRework: { gateStep: of.step, targets: reworkTargets(parent, of.step), parent } };
  }

  /**
   * AI のレビューの指摘だけのとき、その PR のレビューの子タスク（PBI-330）が最後の回に示した指摘ごとの戻し先と原因から、戻し先の
   * 判断を作る（PBI-332）。承認済みの前の工程の決定を変える指摘があればその工程、複数なら前の工程。子タスクの答えを読めない
   * （rework が無い）なら、その PR の工程で直す。人の指摘を含む・子タスクが無い・その回の判定が無いなら undefined（工程の
   * エージェントが判断する）。
   */
  private reviewTaskRework(
    task: Task,
    gateStep: StepKey,
    remarks: readonly string[],
    aiReview: readonly number[],
    aiReviewFrom: Readonly<Record<string, string>>,
  ): Extract<EventInput, { type: "ReworkJudged" }>["payload"] | undefined {
    const ai = new Set(aiReview);
    if (remarks.length === 0 || remarks.some((_, i) => !ai.has(i))) return undefined;
    const pr = gateStep === "implement" ? task.pullRequest : gatePullRequest(task);
    const record = (task.reviewTasks ?? []).findLast(
      (r) => r.step === gateStep && pr !== undefined && r.number === pr.number,
    );
    const child = record && this.tasks.get(record.taskId);
    if (!child) return undefined;
    const round = child.reviewRound ?? 1;
    // 指摘がすべて、その子タスクの最後の回の投稿のときだけ、その回の判定から決める（ほかのレビューのタスク・前の回の指摘に
    // 別の回の戻し先を当てない。出どころの回が分からない指摘も、工程のエージェントが判断する）
    const from = sactyReviewKey(child.id, round);
    if (remarks.some((_, i) => aiReviewFrom[String(i)] !== from)) return undefined;
    const last = child.reviewVerdicts?.find((v) => v.round === round);
    if (!last || last.verdict === "no_findings") return undefined;
    const targets = reworkTargets(task, gateStep);
    const target = reviewReworkTarget(last.rework, targets, gateStep);
    const rework = last.rework;
    const decisive = rework?.findings.find((f) => f.target === target && target !== gateStep);
    const reason: DaemonText = rework
      ? [
          ...(decisive ? [decisive.reason] : []),
          ...rework.findings.map(
            (f) =>
              `- [${f.target && targets.includes(f.target) ? f.target : gateStep}] ${f.finding}：${f.reason}`,
          ),
        ].join("\n") || message("rework.reviewTaskUnreadable")
      : message("rework.reviewTaskUnreadable");
    return {
      ...(target ? { target } : {}),
      ...(rework?.cause ? { cause: rework.cause } : {}),
      reason,
      agentId: last.agentId ?? "",
      reviewTaskId: child.id,
      runResult: "completed",
      costUsd: 0,
      estimated: false,
    };
  }

  /**
   * PR の指摘の戻し先を判断する（PBI-14b）。AI のレビューの指摘だけなら、PR のレビューの子タスクが示した指摘ごとの戻し先から
   * 決める（実行しない。PBI-332）。人の指摘を含めば、PR の工程のエージェント（人が選んだもの。無ければ step_agents か
   * default_agent）に新しいセッションで判断させる（PBI-332 より前はゴールガーディアン）。
   */
  private async judgeRework(
    task: Task,
    gateStep: StepKey,
    remarks: string[],
    aiReview: readonly number[],
    aiReviewFrom: Readonly<Record<string, string>>,
    config: SactyConfig,
  ): Promise<Extract<EventInput, { type: "ReworkJudged" }>["payload"] | { missingAgent: string }> {
    const fromReview = this.reviewTaskRework(task, gateStep, remarks, aiReview, aiReviewFrom);
    if (fromReview) return fromReview;
    const targets = reworkTargets(task, gateStep);
    // 人が選んだエージェントが設定から消えていれば、判断せずに知らせて止める（選ばれていないエージェントで費用を使わない）
    const chosen = stepAgentFor(config, gateStep, task.agents?.[gateStep]);
    if (!chosen.ok) return { missingAgent: chosen.missing };
    // 実装の PR は、指摘が実装で直せるかを判断するので実装後のコードを、要求要件・設計の PR（PBI-57）は
    // 起点のコードを読ませる。失敗したら、代わりのエージェントで判定し直す
    const { outcome, costUsd, estimated, costUnknown, runId, agent } =
      await this.runGuardianWithFallback(
        task,
        {
          agent: chosen.agent,
          image: config.image,
          prompt: buildReworkPrompt(task, remarks, targets, gateStep, aiReview),
          role: "rework",
        },
        gateStep === "implement" ? "implemented" : "base",
        config,
      );
    const judgement =
      outcome.kind === "completed"
        ? extractRework(outcome.output, targets)
        : { reason: message("rework.runFailed", { detail: outcome.message }) };
    return {
      ...judgement,
      runResult: outcome.kind === "completed" ? "completed" : "failed",
      agentId: agent.id,
      ...agentSetting(agent),
      runId,
      usage: outcome.usage,
      costUsd,
      estimated,
      ...unknownCost({ costUnknown }),
    };
  }

  /** コンテキストのイメージの作成の状況（PBI-325）。無ければ載せない。 */
  private contextImagesStatus(): { contextImages?: ContextImagesView[] } {
    const view = this.deps.contextImages?.view() ?? [];
    return view.length > 0 ? { contextImages: view } : {};
  }

  /**
   * プロジェクトのコンテキストの images.yaml のイメージ（PBI-325）。デーモンがイメージを作るために読む。取得のエラー文は、
   * 認証のトークンを伏せる。
   */
  async loadContextImages(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof contextImages>>> {
    const project = this.deps.projects.get(projectId);
    if (!project?.context) return { images: [], warnings: [], layers: [] };
    const usedSecrets: string[] = [];
    try {
      return await contextImages(
        this.deps.contexts,
        project.context,
        (repo) => this.gitAuth({ projectId }, repo, usedSecrets),
        this.deps.defaultContext,
        signal,
      );
    } catch (error) {
      // 文言のコードのまま返す（画面の言語で出す）。取得のエラー文の認証のトークンは伏せる
      const text = redactText(errorText(error), usedSecrets);
      throw typeof text === "string" ? new Error(text) : new MessageError(text as DaemonMessage);
    }
  }

  /** コンテキストのあるプロジェクト（PBI-325。イメージを作るデーモンが読む）。 */
  contextImageProjects(): { id: string; name: string }[] {
    return this.deps.projects
      .all()
      .filter((p) => p.context)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  /** 作成に失敗したコンテキストのイメージを作り直す（画面の「作り直す」。PBI-325）。 */
  rebuildContextImage(projectId: string, name: string): void {
    const builder = this.deps.contextImages;
    if (!builder) throw new InvalidOperationError(message("contextImage.notFound", { name }));
    if (!this.deps.projects.get(projectId)) {
      throw new InvalidOperationError(message("project.notFound"));
    }
    const result = builder.rebuild(projectId, name);
    if (!result.ok) throw new InvalidOperationError(result.message);
  }

  /** プロジェクトの設定を保存したときに、コンテキストのイメージを読み直す（PBI-325。作り終えるのは待たない）。 */
  refreshContextImages(projectId?: string): void {
    void this.deps.contextImages?.refresh(projectId).catch((error: unknown) => {
      console.warn("[daemon] context images: could not refresh:", error);
    });
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
        // 設定ファイルが無くても Docker と既定のイメージは確かめるので、その注意は載せる（PR #166 レビュー指摘。PBI-148）
        docker: this.deps.imageProblems?.() ?? [],
        ...this.contextImagesStatus(),
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
        // コンテキストのイメージ（PBI-325）を読めなかった・config.yaml と同じ名前だった
        ...(this.deps.contextImages?.view() ?? []).flatMap((p) => [
          ...(p.loadError ? [p.loadError] : []),
          ...p.warnings,
        ]),
      ],
      // Docker が動いていない・手元に無い・版の違うエージェントのイメージ（PBI-148）。画面はどの画面でも出す
      docker: this.deps.imageProblems?.() ?? [],
      ...this.contextImagesStatus(),
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

  /** 画面に出すタスクか（消したプロジェクトのタスクは出さない。タスクと作業履歴は残す）。 */
  visibleTask(id: string): boolean {
    const task = this.tasks.get(id);
    return task !== undefined && this.deps.projects.get(task.projectId) !== undefined;
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

  /**
   * プロジェクトを作る、または変える。ほかのプロジェクトと対象が重複していれば拒否する。
   * 変えるときに `base`（読み込んだときの `updatedAt`）を渡すと、その後にほかの保存で変わっていれば、上書きせずに、互いの変更を
   * 併合して保存する（PBI-301）。併合できなければ（同じ項目を違うように変えたなど）拒否する。照合と保存の間に待ちが無いので、
   * 同時に保存しても、先に保存した変更を後の保存が消さない。
   */
  saveProject(id: string | undefined, raw: unknown, base?: string): Project {
    return this.saveProjectMerging(id, raw, base).project;
  }

  /** saveProject と同じ。読み込んだ後にほかの保存があって、併合して保存したかも返す（画面が、最新の設定を読み込み直すことを案内する）。 */
  saveProjectMerging(
    id: string | undefined,
    raw: unknown,
    base?: string,
  ): { project: Project; merged: boolean } {
    let definition = ProjectDefinition.parse(raw);
    const current = id ? this.deps.projects.get(id) : undefined;
    if (id && !current) {
      throw new InvalidOperationError(message("project.notFound"));
    }
    let merged = false;
    if (id && current && base !== undefined && current.updatedAt !== base) {
      // 読み込んだ版の定義を元に、ほかの保存の変更と、この保存の変更を併合する。元の版が無い（古くて消えた）・併合できないなら拒否する
      const original = this.deps.projects.revision(id, base);
      const result = original
        ? mergeProjectDefinitions(original, ProjectDefinition.parse(current), definition)
        : undefined;
      if (!result) throw new InvalidOperationError(message("project.changedElsewhere"));
      definition = ProjectDefinition.parse(result);
      merged = true;
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
    return { project: saved, merged };
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
   * プロジェクトを削除する（プロジェクトの設定の「危険な操作」）。消すのはプロジェクトの定義だけで、タスクと作業履歴は
   * 残す（消したプロジェクトのタスクは、画面に出さず、数えない）。終わっていないタスクや、完了したタスクでも実行中・実行待ちの
   * 処理（監査・デプロイの確認など）・回答中の質問があれば拒否する（消した後に、プロジェクトの設定の無いまま進めないため）。
   */
  deleteProject(id: string): void {
    if (!this.deps.projects.get(id)) throw new InvalidOperationError(message("project.notFound"));
    let queued = new Set<string>();
    try {
      queued = new Set(this.queuedTaskIds());
    } catch {
      // 設定を読めないときは、ワーカーも実行対象を取れない（終わっていないタスクと実行中だけで判断する）
    }
    const active = [...this.tasks.values()].filter(
      (t) =>
        t.projectId === id &&
        (!isFinished(t) ||
          this.inflight.has(t.id) ||
          queued.has(t.id) ||
          this.chats.has(t.id) ||
          this.analyses.has(t.id)),
    ).length;
    if (active > 0)
      throw new InvalidOperationError(message("project.hasActiveTasks", { count: active }));
    this.deps.projects.delete(id);
    // 消したプロジェクトの秘密情報の警告を、画面に残さない
    this.secretProblems = this.secretProblems.filter((p) => p.projectId !== id);
    this.projectSecretRounds.delete(id);
    // プロジェクトが減ると、数える実行待ちも変わる（PBI-118）
    this.trackQueue();
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
    const sactyMade = this.sactyMadePullRequests();
    const reviewOf = (issue: FoundIssue): "requested" | "label" | "sacty" | undefined => {
      if (!issue.pullRequest) return undefined;
      // sacty が作った PR は取り込まない。PR を作ったタスクが、レビューの子タスクを作ってレビューさせる（PBI-330）。以前の版で
      // ラベルを付けた PR・レビューの依頼に当たった PR も同じ（二重にレビューしない）
      if (sactyMade.has(key(issue.repo, issue.number))) return undefined;
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
   * sacty がタスクのために作った PR（実装の PR と、要求要件・設計の PR。ラベルを付けた記録と、レビューの子タスクの記録も。
   * PBI-88・PBI-330）。値は `repoKey(repo)#番号`。取り込みと再依頼の両方で、これらの PR を別のレビューのタスクにしない。
   */
  private sactyMadePullRequests(): Set<string> {
    const key = (repo: string, number: number) => `${repoKey(repo)}#${number}`;
    return new Set(
      [...this.tasks.values()].flatMap((t) => [
        ...(t.pullRequest?.repo && t.pullRequest.number
          ? [key(t.pullRequest.repo, t.pullRequest.number)]
          : []),
        ...t.stepPullRequests.map((p) => key(p.repo, p.number)),
        ...(t.pullRequestLabels ?? []).map((p) => key(p.repo, p.number)),
        ...(t.reviewTasks ?? []).map((p) => key(p.repo, p.number)),
      ]),
    );
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
      // sacty が作った PR は、以前の版で依頼から取り込んだタスクがあっても再レビューしない。PR を作ったタスクの
      // レビューの子タスクがレビューする（PBI-330 レビュー指摘）
      if (this.sactyMadePullRequests().has(id)) continue;
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
   * タスクの開始時の情報収集。情報収集のエージェントが、取り込み元のチケットの親（ストーリー・エピック）・リンク・本文の
   * URL・対象リポジトリのコード・MCP サーバー・外部 PF などから、タスクに関係する情報を集めて絞り込み、まとめる
   * （InformationGathered）。リポジトリを用意したタスクは作業領域の写しを、まだ決まっていないタスクはリポジトリの候補を読む。
   * まとめは、チケットのトリアージ・オーケストレーター・すべての工程・ゴールガーディアンの指示に添える。
   * 集められなければ、工程の選択と同じく OrchestratorFailed（actor は gatherer）を記録し、代わりのエージェントで集め直すか
   * 一時停止する（再開すると集め直す）。記録した・止めたら true（次の実行で続ける）。集めずに進めるなら false。
   */
  private async gatherInformation(task: Task, config: SactyConfig): Promise<boolean> {
    if (this.deps.gatherer) {
      const gathered = await this.deps.gatherer(task);
      if (!gathered) return false;
      const latest = this.mustGet(task.id);
      if (latest.status !== "queued" || !awaitingGathering(latest)) return true;
      this.append(latest, [
        {
          actor: "gatherer",
          event: {
            type: "InformationGathered",
            payload: { ...gathered, agentId: "test", costUsd: 0, estimated: false },
          },
        },
      ]);
      return true;
    }
    if (budgetState(task.budget) === "exceeded") {
      this.append(task, [
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "budget" } } },
      ]);
      return true;
    }
    // チケットから取り込んだタスクは、集めた情報からトリアージ（作業するリポジトリ・題・概要）も決めさせる（PBI-52）。
    // チケットの接続先・リポジトリの候補が無ければ、集める前に止める（チケットを読めないと集められない）
    const triaging = awaitingTicketTriage(task)
      ? await this.ticketTriageTarget(task, config)
      : undefined;
    if (triaging && "failed" in triaging) {
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: { type: "TaskPaused", payload: { reason: "error", message: triaging.failed } },
        },
      ]);
      return true;
    }
    const triage = triaging && {
      candidates: triaging.candidates,
      fixed: triaging.fixed !== undefined,
    };
    // 作業するリポジトリがまだ決まっていないタスクは、プロジェクトの対象から関係しそうなリポジトリを洗い出させ、そのコードを
    // GitHub の読み取りの中継で読ませる（トリアージなら、トリアージの候補。用意したタスクは、作業領域の写しを読む）
    // 一覧を読めなかった Org（認証切れ・権限不足など）は、調べられなかった情報源として指示に伝える（候補に入らないので）
    const listed =
      !task.repository && !triage && isRepoless(task)
        ? await this.projectRepositories(task.projectId)
        : undefined;
    const candidates = listed?.repositories ?? [];
    const unreadable = triaging?.unreadable ?? listed?.errors ?? [];
    // 共用の compose（PBI-70）は、サービスを分けるときの候補にする（PBI-152。使うかはオーケストレーターが決める）
    const sharedComposes = (this.deps.projects.get(task.projectId)?.sharedComposes ?? []).map(
      (s) => ({
        name: s.name,
        file: s.file,
        ...(s.description ? { description: s.description } : {}),
      }),
    );
    const ran = await this.runOrchestrator(
      task,
      config,
      // 書き込みの API は、指示にも出さない（ゲートウェイが拒否する）
      (platforms) =>
        [
          buildGatherPrompt(task, triage, { candidates, unreadable, sharedComposes }),
          ...platformPromptLines(readOnlyPlatforms(platforms)),
        ].join("\n"),
      "gather",
    );
    // 集めている間に、人間が止めた・中止した・ほかで決まったなら、記録しない（止めた記録は runNext の後始末で行う）
    const latest = this.mustGet(task.id);
    if (this.pauseRequested.has(task.id) || this.cancelling.has(task.id)) return true;
    if (latest.status !== "queued" || !awaitingGathering(latest)) return true;
    const gathered = "failure" in ran ? undefined : extractGathered(ran.output);
    if ("failure" in ran || !gathered) {
      const failure =
        "failure" in ran
          ? ran.failure
          : {
              reason: "error" as const,
              message: message("gather.failed", { detail: message("gather.unreadable") }),
              ...ran.cost,
            };
      const failedAgent = definedAgent(config, failure.agentId);
      this.append(latest, [
        { actor: "gatherer", event: { type: "OrchestratorFailed", payload: failure } },
        // 失敗したら、止めずに代わりのエージェントで集め直す
        (failedAgent &&
          failure.runId &&
          this.fallBack(
            task.id,
            {
              runId: failure.runId,
              role: "gather",
              agent: failedAgent,
              selected: agentFor(config, "gather"),
            },
            failure.reason,
            config,
          )) || {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: failure.reason, message: failure.message },
          },
        },
      ]);
      this.warnIfNeeded(this.mustGet(task.id));
      return true;
    }
    const { triage: triaged, ...information } = gathered;
    this.append(latest, [
      {
        actor: "gatherer",
        event: { type: "InformationGathered", payload: { ...information, ...ran.cost } },
      },
      // 集めている間に、人がリポジトリを選んだなら、トリアージは記録しない（次の実行で、選んだリポジトリで書き直す）
      ...(triaging && awaitingTicketTriage(latest) && latest.repo === task.repo
        ? [this.ticketTriaged(triaged, triaging)]
        : []),
    ]);
    this.warnIfNeeded(this.mustGet(task.id));
    return true;
  }

  /**
   * 情報収集が兼ねたトリアージの答えを記録する（費用は InformationGathered に入れたので持たない）。リポジトリ・概要を
   * 決められなかったら、理由を記録して止める（人がリポジトリを選んで再開できる。再開すると、トリアージだけをやり直す）。
   */
  private ticketTriaged(
    triage: ReturnType<typeof extractTicketTriage>,
    target: { candidates: string[]; fixed: string | undefined },
  ): ActivityItem {
    const paused = (detail: DaemonText): ActivityItem => ({
      actor: "sacty",
      event: {
        type: "TaskPaused",
        payload: { reason: "error", message: message("ticket.triageFailed", { detail }) },
      },
    });
    // 後の工程は概要を読んで作業するので、概要が無ければ要件を書けていない（triageTicket と同じ）
    if (!triage) return paused(message("ticket.triageUnreadable"));
    if (!triage.summary || (!target.fixed && !triage.repo)) {
      return paused(triage.reason || message("ticket.triageUnreadable"));
    }
    const repo = target.fixed ?? target.candidates.find((c) => sameGitHubUrl(c, triage.repo));
    if (!repo) return paused(message("ticket.repoNotCandidate", { repo: triage.repo }));
    return {
      actor: "gatherer",
      event: {
        type: "TicketTriaged",
        payload: {
          repo,
          ...(triage.title ? { title: triage.title } : {}),
          body: triage.summary,
          reason: triage.reason,
        },
      },
    };
  }

  /**
   * チケットのトリアージ（作業するリポジトリ・題・概要を決める。PBI-52）に使う、チケットの接続先と作業するリポジトリの候補。
   * 人がリポジトリを選んでいれば、そのリポジトリに固定する（fixed。チケットの要件は読み直して書く）。接続先が無い・候補が
   * 無ければ、止める理由を返す。一覧を読めなかった Org（unreadable。理由は秘密を伏せたもの）も返す（情報収集に伝える）。
   */
  private async ticketTriageTarget(
    task: Task,
    config: SactyConfig,
  ): Promise<
    | {
        platform: Platform;
        candidates: string[];
        fixed: string | undefined;
        unreadable: { org: string; message: DaemonText }[];
      }
    | { failed: DaemonText }
  > {
    const ticket = task.ticket;
    if (!ticket) return { failed: message("ticket.triageFailed", { detail: "" }) };
    // 接続先は、ホストの PF か、プロジェクトのコンテキストの PF（PBI-74）
    let platform: Platform | undefined;
    const usedSecrets: string[] = [];
    try {
      platform = await this.findPlatform(task, config, ticket.platform, usedSecrets);
    } catch (error) {
      return {
        failed: message("ticket.triageFailed", {
          detail: redactText(errorText(error), usedSecrets),
        }),
      };
    }
    if (!platform) {
      return {
        failed: message("ticket.triageFailed", {
          detail: message("ticket.platformMissing", { platform: ticket.platform }),
        }),
      };
    }
    const fixed = task.repo && task.ticketTriage?.by === "person" ? task.repo : undefined;
    const listed = fixed ? undefined : await this.projectRepositories(task.projectId);
    const candidates = fixed ? [fixed] : (listed?.repositories ?? []);
    if (candidates.length === 0) {
      return { failed: message("ticket.triageFailed", { detail: message("ticket.noCandidates") }) };
    }
    return { platform, candidates, fixed, unreadable: listed?.errors ?? [] };
  }

  /**
   * チケットの取り込みの1段目（PBI-52）。オーケストレーターが、ゲートウェイ経由でチケット（サブタスクなら親とほかの
   * サブタスクも）を読み、プロジェクトの対象のリポジトリから作業するリポジトリを選び、題と概要を書く。決められなければ、
   * 理由を記録して止める（人がリポジトリを選んで再開できる。再開すると、もう一度読む）。
   * ふつうは情報収集がトリアージを兼ねる（gatherInformation）。これは、情報収集の後にまだ決まっていないとき（情報収集で
   * 決められずに止まった後の再開・人がリポジトリを選んだ後に題と概要を書き直すとき）だけ動く。
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
    const target = await this.ticketTriageTarget(task, config);
    if ("failed" in target) {
      pause("error", target.failed);
      return;
    }
    const { platform, candidates, fixed } = target;
    const selected = agentFor(config, "orchestrator");
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で読む
    const agent = this.usableAgent(config, selected, task.id, "orchestrator");
    const { outcome, costUsd, estimated, costUnknown, runId } = await this.runGuardian(
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
      ...unknownCost({ costUnknown }),
    };
    const fail = (reason: "usage_limit" | "auth" | "error", detail: DaemonText) => {
      const text = message("ticket.triageFailed", { detail });
      this.append(latest, [
        {
          actor: "orchestrator",
          event: { type: "OrchestratorFailed", payload: { reason, message: text, ...cost } },
        },
        // 失敗したら、止めずに代わりのエージェントで読み直す
        this.pauseOrFallBack(
          task.id,
          { runId, role: "orchestrator", agent, selected },
          reason,
          { actor: "sacty", event: { type: "TaskPaused", payload: { reason, message: text } } },
          config,
        ),
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
    // もう作業領域を使わなくなった（完了した・監査が終わった）なら消す。実行の途中なら、実行の終わりに消す（PBI-157）
    if (workspaceRetirable(updated) && !(before && workspaceRetirable(before))) {
      void this.retireWorkspace(updated.id);
    }
    // 人間の出番（承認待ち・エスカレーション・一時停止）と完了を通知する（送るのは待たない。PBI-38）
    const kind = notificationFor(before, updated);
    // 通知の誤りは、書き終えたタスクの操作に伝えない（PBI-115 レビュー指摘）
    if (kind) {
      try {
        void this.deps.notifier?.notify(updated, kind)?.catch?.(() => {});
      } catch {
        // 通知の側で理由を持つ
      }
      // 画面のデスクトップ通知（画面が取り直す）。Slack の On/Off によらず持つ
      this.deps.feed?.add(updated, kind);
    }
    // Sacty のレビューが止まったら、レビューを頼んだ PR にも知らせる（PBI-292。送るのは待たない）
    if (
      updated.status === "paused" &&
      before?.status !== "paused" &&
      notifiesReviewStop(updated.pausedReason)
    ) {
      this.announceReviewStop(updated);
    }
    // 作り直した成果物が承認待ちになったとき、人に確かめてほしいこと（ゴールガーディアンが指摘の意図を判断できなかった理由・
    // 実行が挙げた聞き返し）があれば、その PR にも知らせる（PBI-301。送るのは待たない）
    if (humanAskDue(before, updated)) this.announceHumanAsks(updated);
    return updated;
  }

  /** 通知など、同じ対象（タスク・工程・提出回）では順に処理する処理の、最後の処理（キーごと）。 */
  private readonly serialTails = new Map<string, Promise<void>>();

  /**
   * 同じキーの処理を、前の処理が終わってから始める（PBI-301）。先の処理が検索や通信の最中のまま、一時停止と再開などでもう1本
   * 始まると、どちらも「まだ書いていない」と見て二重に投稿するため。後の処理は、先の処理の終了後に目印を探し直す。
   */
  private serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serialTails.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.serialTails.set(key, tail);
    void tail.then(() => {
      if (this.serialTails.get(key) === tail) this.serialTails.delete(key);
    });
    return run;
  }

  /**
   * 人に確かめてほしいこと（`humanAsks`）を、承認待ちの成果物の PR にコメントする（PBI-301）。PR を見ている人は sacty の
   * 画面を開かないので、承認の画面に出すだけでは気づかれない。1 回の提出につき 1 件（目印で見つけたものがあれば書かない）。
   * GitHub のアカウントを選んでいないプロジェクト・PR が無い成果物には書かない（画面には出る）。投稿できなくても、タスクは
   * 変えない（例外は投げない）。
   */
  private announceHumanAsks(task: Task): void {
    const asks = humanAsks(task);
    const watched = gatePullRequest(task);
    const gate = task.gate;
    // セキュリティのタスクは、確かめたいこと（脆弱性や修正の範囲の詳細を含みうる）を公開の PR に書かない（承認の画面には出る）
    if (isSecurityTask(task)) return;
    if ((!asks.undecided && asks.confirms.length === 0) || !watched?.repo || !gate) return;
    const repo = watched.repo;
    const number = watched.number;
    const project = this.deps.projects.get(task.projectId);
    if (!project?.githubAccounts?.[httpsHost(`${repo}/`) ?? ""]) return;
    const usedSecrets: string[] = [];
    const base = (this.deps.webUrl ?? "http://127.0.0.1:4700").replace(/\/+$/, "");
    void this.serialized(`human-ask:${task.id}:${gate.step}:${gate.submission}`, async () => {
      // 期限は、順番を待った後の処理の始まりから数える
      const signal = this.stopNoticeDeadline();
      try {
        const token = await untilAborted(
          signal,
          this.githubToken(task, repo, usedSecrets, project),
        );
        const body = buildHumanAskNotice({
          taskId: task.id,
          step: gate.step,
          stepName: STEP_NAME[gate.step],
          submission: gate.submission,
          ...(asks.undecided
            ? { undecided: { remarkIds: asks.undecided.remarkIds, reason: asks.undecided.reason } }
            : {}),
          confirms: asks.confirms.map((c) => ({ remarkId: c.remarkId, text: c.text })),
          taskUrl: `${base}/tasks/${task.id}`,
          secrets: usedSecrets,
        });
        if (!body) return;
        const pr = { repo, token, number };
        const existing = await untilAborted(
          signal,
          this.deps.pulls.findIssueComment({
            ...pr,
            marker: humanAskMarker(task.id, gate.step, gate.submission),
          }),
        );
        if (existing) return;
        // 確かめている間に、承認された・差し戻された・別の提出になったなら、書かない
        const latest = this.tasks.get(task.id);
        if (
          latest?.status !== "awaiting_approval" ||
          latest.gate?.step !== gate.step ||
          latest.gate.submission !== gate.submission
        ) {
          return;
        }
        await untilAborted(signal, this.deps.pulls.commentIssue({ ...pr, body, signal }));
      } catch (error) {
        console.warn(
          `[daemon] タスク ${task.id} の、人に確かめてほしいことを PR に知らせられませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
        );
      }
    });
  }

  /**
   * Sacty のレビューのタスク（PR のレビューの取り込みと、レビューの対象を決めたタスク）が、レビューを投稿する前に止まったときの、
   * レビューを頼んだ PR。それ以外は undefined（PBI-292）。
   */
  private reviewStopTarget(task: Task): { repo: string; number: number } | undefined {
    if (task.reviewPost) return undefined;
    if (task.reviewTarget)
      return { repo: task.reviewTarget.repo, number: task.reviewTarget.number };
    const source = task.source;
    return source?.kind === "github_pull_request" && source.review
      ? { repo: source.repo, number: source.number }
      : undefined;
  }

  /** 止まった理由の元の文（一時停止の説明。無ければ、直前に失敗した実行・オーケストレーターの説明）。 */
  private stopReasonText(task: Task): DaemonText | undefined {
    if (task.pausedMessage !== undefined) return task.pausedMessage;
    const events = this.deps.activity.forTask(task.id);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (!event) continue;
      if (event.type === "AgentRunFailed" || event.type === "OrchestratorFailed") {
        return event.payload.message;
      }
      if (event.type === "TaskResumed" || event.type === "AgentRunStarted") return undefined;
    }
    return undefined;
  }

  /**
   * タスクごとの、止まったことの知らせの投稿の最後の処理（PBI-292）。知らせは同じタスクで順に処理する（同時に二つ進めない）。
   * 解消済みへの書き換えは、これが終わるのを待ってから対象を取る（投稿の最中に再開・レビューの投稿が終わっても、後から
   * できた知らせを取りこぼさない）。
   */
  private readonly stopNotices = new Map<string, Promise<void>>();
  /** タスクごとの、知らせの通信を止める印（解消が期限を超えたとき、まだ終わっていない知らせの通信を止めて、後から投稿させない）。 */
  private readonly stopNoticeAborts = new Map<string, AbortController>();

  /** 知らせの処理全体の期限（PBI-292）。 */
  private stopNoticeDeadline(): AbortSignal {
    return AbortSignal.timeout(this.deps.stopNoticeTimeoutMs ?? 30_000);
  }

  /**
   * Sacty のレビューが止まったことを PR に知らせる処理を、そのタスクの順番の最後に足す。止まった時点の理由と説明は、ここで
   * 持つ（待っている間にまた止まっても、それぞれの停止の理由を知らせる）。知らせる対象でなければ何もしない。
   */
  private announceReviewStop(task: Task): void {
    const target = this.reviewStopTarget(task);
    const reason = task.pausedReason;
    if (!target || !reason || !notifiesReviewStop(reason)) return;
    const stop = {
      taskId: task.id,
      projectId: task.projectId,
      reason,
      text: this.stopReasonText(task),
      target,
    };
    const abort = this.stopNoticeAborts.get(task.id) ?? new AbortController();
    this.stopNoticeAborts.set(task.id, abort);
    // 前の処理が無ければすぐ始める（一時停止の状態を読むのを、遅らせない）
    const previous = this.stopNotices.get(task.id);
    const run = previous
      ? previous.then(() => this.postReviewStopNotice(stop))
      : this.postReviewStopNotice(stop);
    this.stopNotices.set(task.id, run);
    void run.finally(() => {
      if (this.stopNotices.get(task.id) !== run) return;
      this.stopNotices.delete(task.id);
      this.stopNoticeAborts.delete(task.id);
    });
  }

  /**
   * Sacty のレビューが止まったことを、レビューを頼んだ PR にコメントする（PBI-292）。同じ止まり方（理由と要点が同じ）で、
   * まだ解消していない投稿が PR にあれば、書かない。投稿できなくても、タスクの一時停止は変えない（例外は投げない）。
   */
  private async postReviewStopNotice(stop: {
    taskId: string;
    projectId: string;
    reason: PauseReason;
    text: DaemonText | undefined;
    target: { repo: string; number: number };
  }): Promise<void> {
    const { taskId, reason, target } = stop;
    const usedSecrets: string[] = [];
    // 処理全体の期限か、解消が期限を超えて待てなくなったとき、通信ごと止める（止めずに待ちだけ切ると、遅れて投稿される）
    const abort = this.stopNoticeAborts.get(taskId);
    const signal = AbortSignal.any([this.stopNoticeDeadline(), ...(abort ? [abort.signal] : [])]);
    try {
      // 待っている間に再開・中止された（今は止まっていない）なら、書かない
      if (this.tasks.get(taskId)?.status !== "paused") return;
      const project = this.deps.projects.get(stop.projectId);
      const account = project?.githubAccounts?.[httpsHost(`${target.repo}/`) ?? ""];
      // GitHub のアカウントを選んでいないプロジェクトでは、PR に書けない（画面と Slack で知らせる）
      if (!account) return;
      const token = await untilAborted(
        signal,
        this.githubToken(stop, target.repo, usedSecrets, project),
      );
      const summary = stopSummary(stop.text, usedSecrets);
      const key = stopKey(reason, summary);
      const pr = { repo: target.repo, token, number: target.number };
      const same = await untilAborted(
        signal,
        this.deps.pulls.listIssueComments({
          ...pr,
          prefix: stopMarker(taskId, key),
          account,
          signal,
        }),
      );
      if (same.length > 0) return;
      // 確かめている間に再開・中止された（今は別の状態の）なら、書かない
      if (this.tasks.get(taskId)?.status !== "paused") return;
      const base = (this.deps.webUrl ?? "http://127.0.0.1:4700").replace(/\/+$/, "");
      await untilAborted(
        signal,
        this.deps.pulls.commentIssue({
          ...pr,
          body: buildStopNotice({
            taskId,
            reason,
            summary,
            taskUrl: `${base}/tasks/${taskId}`,
          }),
          signal,
        }),
      );
    } catch (error) {
      console.warn(
        `[daemon] タスク ${taskId} のレビューが止まったことを PR に知らせられませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    }
  }

  /**
   * レビューを投稿したら、そのタスクの、止まったことの投稿（解消前のもの）を解消済みに直す（PBI-292）。直せなくても、
   * タスクの完了は変えない。対象のタスクと PR は呼ぶ側が持つ（投稿の最中の知らせを待つ間に「再レビュー」が始まると、
   * タスクの状態から対象の PR が消えるため）。
   */
  private async resolveReviewStops(
    posted: { taskId: string; projectId: string; target: { repo: string; number: number } },
    reviewUrl: string,
  ): Promise<void> {
    const { taskId, target } = posted;
    const usedSecrets: string[] = [];
    // 待ちも通信も、1つの期限の中で行う。超えたら、まだ終わっていない知らせの通信も止める（後から投稿させない）
    const signal = this.stopNoticeDeadline();
    try {
      // 投稿の最中の知らせがあれば、できあがるのを待ってから、解消する対象を取る
      await untilAborted(signal, this.stopNotices.get(taskId) ?? Promise.resolve());
      const project = this.deps.projects.get(posted.projectId);
      const account = project?.githubAccounts?.[httpsHost(`${target.repo}/`) ?? ""];
      if (!account) return;
      const token = await untilAborted(
        signal,
        this.githubToken(posted, target.repo, usedSecrets, project),
      );
      const pr = { repo: target.repo, token, number: target.number };
      const notices = await untilAborted(
        signal,
        this.deps.pulls.listIssueComments({
          ...pr,
          prefix: stopMarkerOfTask(taskId),
          account,
          signal,
        }),
      );
      for (const notice of notices.filter((n) => isOpenStopNotice(n.body))) {
        await untilAborted(
          signal,
          this.deps.pulls.editIssueComment({
            repo: target.repo,
            token,
            id: notice.id,
            body: buildResolvedNotice(notice.body, reviewUrl),
            signal,
          }),
        );
      }
    } catch (error) {
      // 期限を超えて待てなかったなら、まだ終わっていない知らせの通信も止める（後から投稿されて、解消されないまま残らないように）
      if (signal.aborted) {
        // 止めるのは今ある知らせの通信だけ。このあと止まったときの知らせは、新しい印で書けるようにする
        const pending = this.stopNoticeAborts.get(taskId);
        if (pending) this.stopNoticeAborts.set(taskId, new AbortController());
        pending?.abort();
      }
      console.warn(
        `[daemon] タスク ${taskId} のレビューが止まったことの投稿を解消済みにできませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    }
  }

  /**
   * 画面からタスクを作る。作るプロジェクトは必ず指定する（既定のプロジェクトは無い。PBI-22）。
   * template があれば、テンプレートから作る（題と説明は sacty が決める。PBI-90）。
   */
  createTask(raw: unknown): Task {
    const { projectId, payload } = this.prepareTask(raw);
    return this.append({ id: randomUUID(), projectId }, [
      { actor: "person", event: { type: "TaskCreated", payload } },
    ]);
  }

  /**
   * スケジュールタスクの内容で、タスクを作れるかを確かめる（作らない）。作れなければ、画面の作成と同じ理由
   * （InvalidOperationError）で断る。
   */
  checkScheduledTask(projectId: string, settings: ScheduledTaskSettings): void {
    this.prepareTask(scheduledTaskInput(projectId, settings));
  }

  /**
   * スケジュールタスクの予定の回のタスクを作る（start: schedule）。内容の扱いは、画面の作成と同じ（テンプレートなら題と
   * 説明は sacty が決め、リポジトリが無ければリポジトリを指定せずに作る）。
   */
  createScheduledTask(
    projectId: string,
    settings: ScheduledTaskSettings,
    schedule: { id: string; slot: string },
  ): Task {
    const prepared = this.prepareTask(scheduledTaskInput(projectId, settings));
    return this.append({ id: randomUUID(), projectId: prepared.projectId }, [
      {
        actor: "sacty",
        event: {
          type: "TaskCreated",
          payload: { ...prepared.payload, start: "schedule", schedule },
        },
      },
    ]);
  }

  /** スケジュールタスクのその回で作ったタスク（二重に作らないために確かめる）。 */
  scheduledTask(scheduleId: string, slot: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.schedule?.id === scheduleId && task.schedule.slot === slot) return task;
    }
    return undefined;
  }

  /** 画面の作成の入力を確かめ、作るタスクの TaskCreated の内容にする（記録はしない）。 */
  private prepareTask(raw: unknown): {
    projectId: string;
    payload: Extract<EventInput, { type: "TaskCreated" }>["payload"];
  } {
    if (raw && typeof raw === "object" && "template" in raw) return this.prepareTemplateTask(raw);
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
    const repo = wanted ? this.projectRepository(project, wanted) : undefined;
    // 人が指定した進め方は、タスクの形で選べるものだけ（レビューは、対象リポジトリの PR のリンクがあるときだけ）
    const plan = input.plan;
    if (
      plan &&
      !selectablePlans({
        pullRequest:
          repo !== undefined && pullRequestInText(repo, `${title}\n${body}`) !== undefined,
        child: false,
      }).includes(plan)
    ) {
      throw new InvalidOperationError(message("task.reviewPlanNeedsPullRequest"));
    }
    const stepSettings = this.requestedStepSettings(projectId, plan, input.image, input.agents);
    // 直す不安定なテスト（PBI-312）。画面の名前は伏せた値なので、識別子で台帳から元のテストを探す
    const flakyFix = input.flakyFixTest
      ? findFlakyTest([...this.tasks.values()], projectId, input.flakyFixTest)
      : undefined;
    if (
      input.flakyFixTest &&
      (!flakyFix || repo === undefined || repoKey(repo) !== repoKey(flakyFix.repo))
    ) {
      throw new InvalidOperationError(message("task.flakyTestNotFound"));
    }
    return {
      projectId,
      payload: {
        title,
        body,
        start: "sacty",
        // リポジトリを指定しないタスク（PBI-73）。オーケストレーターが、プロジェクトのコンテキストと対象から進め方を決める
        ...(repo ? { repo } : { noRepo: true as const }),
        budgetCapUsd,
        ...(plan ? { plan } : {}),
        ...stepSettings,
        ...(flakyFix ? { flakyFix: { name: flakyFix.name, file: flakyFix.file } } : {}),
      },
    };
  }

  /**
   * 作成時に指定した、タスクのイメージ（PBI-318）と工程ごとのエージェントを確かめる。進め方を選んだときだけ指定でき、
   * エージェントはその工程だけ（統合レビューを除く）。名前は config.yaml の images（か default）・agents にあるものだけ。
   * 何も指定していなければ、何も返さない。
   */
  private requestedStepSettings(
    projectId: string,
    plan: StepPlan | undefined,
    image: string | undefined,
    agents: StepSettingMap | undefined,
  ): { image?: string; agents?: StepSettingMap } {
    const agentSteps = Object.keys(agents ?? {}) as StepKey[];
    if (image === undefined && agentSteps.length === 0) return {};
    if (!plan) throw new InvalidOperationError(message("task.stepSettingsNeedPlan"));
    const steps: readonly StepKey[] = STEP_PLANS[plan];
    if (agentSteps.some((step) => !steps.includes(step))) {
      throw new InvalidOperationError(message("task.stepSettingOutsidePlan"));
    }
    // 統合レビューのエージェントは、config.yaml の step_agents.integrate で決める（タスクの詳細で変えるときと同じく断る）
    if (!agentSteps.every(stepAgentChangeable)) {
      throw new InvalidOperationError(message("agent.stepNotChangeable"));
    }
    // 設定を読めなければ、名前を確かめられないので、その理由を示して断る（名前の誤りと取り違えないため）
    const config = this.deps.config();
    if (!config.ok) {
      throw new InvalidOperationError(
        image !== undefined
          ? message("image.configUnavailable", { detail: config.problem })
          : message("agent.configUnavailable", { detail: config.problem }),
      );
    }
    if (
      image !== undefined &&
      !imageDefined(this.projectImagesConfig(config.config, projectId), image)
    ) {
      throw new InvalidOperationError(message("image.notInImages", { name: image }));
    }
    for (const name of Object.values(agents ?? {})) {
      if (!definedAgent(config.config, name)) {
        throw new InvalidOperationError(message("agent.notInAgents", { name }));
      }
    }
    return {
      ...(image !== undefined ? { image } : {}),
      ...(agentSteps.length > 0 ? { agents } : {}),
    };
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
   * テンプレートから作るタスクの入力を確かめる（PBI-90）。題と説明はテンプレートから決め、対象リポジトリは必須（省略すると、
   * プロジェクトの対象がリポジトリ1つだけならそれにする）。作った後は、通常のタスクと同じく進む。
   */
  private prepareTemplateTask(raw: unknown): ReturnType<TaskService["prepareTask"]> {
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
    return {
      projectId: project.id,
      payload: {
        title,
        body,
        start: "sacty",
        repo,
        budgetCapUsd,
        template: input.template,
        // セキュリティチェックは、進め方をテンプレートで決める（オーケストレーターに選び直させない）
        ...(input.template === "security-check" ? { plan: "security-check" as const } : {}),
      },
    };
  }

  /**
   * 中止したタスクを、最初からやり直す（再実行）。中止したタスクの作業履歴には書き足せないので、元のタスクを引き継いだ
   * 新しいタスクを作る（元のタスクには、再実行で作ったタスクを記録する。再実行は1度だけ）。題・説明・作業するリポジトリ
   * （null はリポジトリを指定しない）・イメージは人が決め、説明には補足と前の試行の記録を足す（中止で作業領域・ブランチ・
   * PR は消えているため）。チケットから取り込んだタスクはチケットを引き継ぎ（PR の URL をチケットに返す・同じチケットを
   * 二重に取り込まない）、チケットを読み直さずに、人が決めたリポジトリで進める。
   */
  rerunTask(id: string, raw: unknown): Task {
    const input = RerunTaskInput.parse(raw);
    const previous = this.tasks.get(id);
    if (!previous) throw new InvalidOperationError(message("task.notFound"));
    if (previous.status !== "cancelled") {
      throw new InvalidOperationError(message("rerun.notCancelled"));
    }
    if (previous.rerunBy) throw new InvalidOperationError(message("rerun.alreadyRerun"));
    if (!canRerun(previous)) throw new InvalidOperationError(message("rerun.notRerunnable"));
    const project = this.deps.projects.get(previous.projectId);
    if (!project) throw new InvalidOperationError(message("project.notFound"));
    if (project.targets.length === 0) {
      throw new InvalidOperationError(message("task.repositoryMissing", { project: project.name }));
    }
    const repo = input.repo === null ? undefined : this.projectRepository(project, input.repo);
    const config = this.deps.config();
    if (input.image !== undefined) {
      // 設定を読めなければ、名前を確かめられないので、その理由を示して断る（PBI-106 と同じ）
      if (!config.ok) {
        throw new InvalidOperationError(
          message("image.configUnavailable", { detail: config.problem }),
        );
      }
      if (!imageDefined(this.projectImagesConfig(config.config, previous.projectId), input.image)) {
        throw new InvalidOperationError(message("image.notInImages", { name: input.image }));
      }
    }
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    // 派生で作ったタスクは、人が直した説明の後に、元のタスクの記録を付け直し（記録は人の入力の上限に数えない）、元の
    // タスクとのつながりと記録を引き継ぐ（再実行を重ねても、記録を人が直す説明に混ぜない）
    const record = derivedRecord(previous);
    const body = buildRerunBody(
      previous,
      record ? deriveBody(input.body ?? "", record) : (input.body ?? ""),
      input.note ?? "",
      (text) => renderMessage(text, "ja"),
    );
    return this.append({ id: randomUUID(), projectId: previous.projectId }, [
      {
        actor: "person",
        event: {
          type: "TaskCreated",
          payload: {
            title: input.title,
            body,
            start: previous.ticket ? "jira" : "sacty",
            ...(previous.ticket ? { ticket: previous.ticket } : {}),
            ...(repo ? { repo } : { noRepo: true as const }),
            budgetCapUsd,
            rerun: { taskId: previous.id, ...(input.image ? { image: input.image } : {}) },
            ...(previous.derivedFrom ? { derivedFrom: previous.derivedFrom } : {}),
            // セキュリティの組み合わせは引き継ぐ（最小限の変更の決まりと、公開しない扱いを外さないため）。ほかの
            // 組み合わせは引き継がず、オーケストレーターが選ぶ
            ...(isSecurityTask(previous) ? { plan: taskPlan(previous) } : {}),
            // レポートの区分から作った対応のタスクは、元のレポート・区分・指摘の全件も引き継ぐ（説明に入りきらなかった
            // 指摘を、再実行で落とさないため）
            ...(previous.securityFix ? { securityFix: previous.securityFix } : {}),
            // 不安定なテストを直すタスクは、同じリポジトリでやり直すときだけ、直すテストを引き継ぐ（PBI-312。引き継がないと、
            // 再実行先の PR をマージしても台帳の古い記録が残る）
            ...(previous.flakyFix &&
            repo !== undefined &&
            sameRepo(repo, previous.repository?.url ?? previous.repo ?? "")
              ? { flakyFix: previous.flakyFix }
              : {}),
          },
        },
      },
    ]);
  }

  /**
   * 完了したタスクから、続きの作業のタスクを作る（派生）。元のタスクは変えず、元のタスクを指す新しいタスクを作る（元の
   * タスクには、派生で作ったタスクを記録する。いくつでも作れる）。題・依頼（続きで何をするか）・作業するリポジトリ（null は
   * リポジトリを指定しない）・進め方は人が決め、説明には元のタスクの記録を足す。チケット・取り込み元は引き継がない
   * （元のタスクの依頼は終わっていて、続きは新しい依頼のため）。セキュリティの組み合わせのタスクからは、セキュリティの
   * 組み合わせの続きだけを作る（記録に入るレポート・範囲を、公開の場所に出さないため）。
   */
  deriveTask(id: string, raw: unknown): Task {
    const input = DeriveTaskInput.parse(raw);
    const original = this.tasks.get(id);
    if (!original) throw new InvalidOperationError(message("task.notFound"));
    if (!canDerive(original)) throw new InvalidOperationError(message("derive.notCompleted"));
    const project = this.deps.projects.get(original.projectId);
    if (!project) throw new InvalidOperationError(message("project.notFound"));
    if (project.targets.length === 0) {
      throw new InvalidOperationError(message("task.repositoryMissing", { project: project.name }));
    }
    const repo = input.repo === null ? undefined : this.projectRepository(project, input.repo);
    // セキュリティの組み合わせのタスクの続きは、進め方を指定しなければセキュリティ対応にする
    const plan = isSecurityTask(original) ? (input.plan ?? "security-fix") : input.plan;
    if (isSecurityTask(original) && plan !== "security-fix" && plan !== "security-check") {
      throw new InvalidOperationError(message("derive.securityPlanRequired"));
    }
    if (
      plan &&
      !selectablePlans({
        pullRequest:
          repo !== undefined &&
          pullRequestInText(repo, `${input.title}\n${input.body}`) !== undefined,
        child: false,
      }).includes(plan)
    ) {
      throw new InvalidOperationError(message("task.reviewPlanNeedsPullRequest"));
    }
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const record = deriveRecord(original);
    return this.append({ id: randomUUID(), projectId: original.projectId }, [
      {
        actor: "person",
        event: {
          type: "TaskCreated",
          payload: {
            title: input.title,
            body: deriveBody(input.body, record),
            start: "sacty",
            ...(repo ? { repo } : { noRepo: true as const }),
            budgetCapUsd,
            derivedFrom: { taskId: original.id, record },
            ...(plan ? { plan } : {}),
          },
        },
      },
    ]);
  }

  /** 実行待ちのタスク（古い順）。 */
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * 利用制限に達したエージェントと、使わない期限（エポックからのミリ秒）。メモリーだけに持つ（デーモンを起動し直すと、
   * 元のエージェントから試す）。
   */
  private readonly limitedAgents = new Map<string, number>();

  /** エージェントが利用制限中か（期限を過ぎたら、制限中でなくする）。 */
  private agentLimited(id: string): boolean {
    const until = this.limitedAgents.get(id);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.limitedAgents.delete(id);
    return false;
  }

  /**
   * 利用制限でない理由で失敗したエージェントと、使わない期限（タスクの ID ごと。エポックからのミリ秒）。そのタスクでだけ
   * 使わない（認証の失敗やタスクの中身による失敗を、ほかのタスクに広げない）。メモリーだけに持つ。
   */
  private readonly failedAgents = new Map<string, Map<string, number>>();

  /** エージェントが、このタスクで失敗して使わないものか（期限を過ぎたら、使えるものにする）。 */
  private agentFailed(taskId: string, id: string): boolean {
    const failed = this.failedAgents.get(taskId);
    const until = failed?.get(id);
    if (!failed || until === undefined) return false;
    if (until > this.now()) return true;
    failed.delete(id);
    if (failed.size === 0) this.failedAgents.delete(taskId);
    return false;
  }

  /**
   * 失敗して代わりに切り替える間に試したエージェント（タスクの ID と、やり直している処理の役割ごと）。期限とは別に持ち、
   * 期限が過ぎても試し終えたものには戻らない（代わりも失敗したら、元に戻らずに止める）。pending は、切り替えた後の実行が
   * まだ始まっていないこと。切り替えた後の実行が fallBack に戻らずに終わった（答えを確かめるまで成功した）なら、その役割の
   * 次の実行を選ぶときに忘れる。人が再開したときも忘れる。
   */
  private readonly fallbackTried = new Map<
    string,
    Map<string, { tried: Set<string>; pending: boolean }>
  >();

  /**
   * コンテナが止まったことを確かめられなかった実行（実行の ID）。代わりのエージェントに切り替えない（元のコンテナが動いた
   * ままかもしれず、同じ作業領域で代わりが始めると、変更や外への操作が重なりうるため）。
   */
  private readonly unconfirmedRuns = new Set<string>();

  /** エージェントを使わないか（利用制限中か、このタスクで失敗したか）。 */
  private agentUnusable(taskId: string, id: string): boolean {
    return this.agentLimited(id) || this.agentFailed(taskId, id);
  }

  /** 役割の切り替えの間に試したエージェントの記録を忘れる。 */
  private forgetTried(taskId: string, role: string): void {
    const byRole = this.fallbackTried.get(taskId);
    byRole?.delete(role);
    if (byRole?.size === 0) this.fallbackTried.delete(taskId);
  }

  /** 使わない期限（config.yaml の agent_fallback.cooldown_minutes。ミリ秒）。 */
  private fallbackCooldownMs(config?: SactyConfig): number {
    const read = config ? undefined : this.deps.config();
    const loaded = config ?? (read?.ok ? read.config : undefined);
    return loaded?.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MINUTES * 60_000;
  }

  /**
   * 実行に使うエージェント。選んだエージェントが利用制限中か、このタスクで失敗して使わないものか、この役割の切り替えの間に
   * 試したものなら、代わりのエージェント（agents の fallback）。代わりもすべて使わないものなら、選んだエージェント。
   * role は、fallBack に渡す役割と同じもの（工程の名前・orchestrator・final-review など）。
   */
  private usableAgent(
    config: SactyConfig,
    agent: AgentConfig,
    taskId: string,
    role: string,
  ): AgentConfig {
    const entry = this.fallbackTried.get(taskId)?.get(role);
    // 切り替えた後の実行が fallBack に戻らずに終わったなら、切り替えは終わっている
    if (entry && !entry.pending) this.forgetTried(taskId, role);
    else if (entry) entry.pending = false;
    const tried = this.fallbackTried.get(taskId)?.get(role)?.tried;
    return fallbackAgentFor(
      config,
      agent,
      (id) => this.agentUnusable(taskId, id) || tried?.has(id) === true,
    );
  }

  /** 利用制限で失敗したエージェントを、期限（config.yaml の agent_fallback.cooldown_minutes）まで使わない。 */
  private markLimited(agent: AgentConfig, outcome: AgentOutcome): void {
    if (outcome.kind !== "failed" || outcome.reason !== "usage_limit") return;
    this.limitedAgents.set(agent.id, this.now() + this.fallbackCooldownMs());
  }

  /**
   * 失敗した実行を、止めずに代わりのエージェントでやり直すか（失敗の理由は問わない）。やり直すなら、切り替えた記録
   * （AgentFellBack）を返す。呼ぶ側は、止める記録（TaskPaused）の代わりにこれを記録する（失敗の記録が実行待ちに
   * 戻しているので、次の処理で usableAgent が代わりのエージェントを選ぶ）。利用制限なら、そのエージェントはすべての
   * タスクで（execute が覚える）、ほかの失敗なら、このタスクでだけ、期限まで使わない。人間が止めた・中止した、コンテナが
   * 止まったことを確かめられなかった、代わりが無い・すべて使わないもの（試し終えたものを含む）なら undefined。
   */
  private fallBack(
    taskId: string,
    failed: { runId: string; role: string; agent: AgentConfig; selected?: AgentConfig },
    reason: string,
    config?: SactyConfig,
    /** この処理の中で、すでに試したエージェント（制限の期限が過ぎていても、もう一度は試さない）。 */
    tried?: ReadonlySet<string>,
  ): ActivityItem | undefined {
    if (this.pauseRequested.has(taskId) || this.cancelling.has(taskId)) return undefined;
    if (this.unconfirmedRuns.delete(failed.runId)) return undefined;
    const read = config ? undefined : this.deps.config();
    const loaded = config ?? (read?.ok ? read.config : undefined);
    if (!loaded) return undefined;
    const limit = reason === "usage_limit";
    if (!limit) {
      const failedHere = this.failedAgents.get(taskId) ?? new Map<string, number>();
      failedHere.set(failed.agent.id, this.now() + this.fallbackCooldownMs(loaded));
      this.failedAgents.set(taskId, failedHere);
    }
    const byRole = this.fallbackTried.get(taskId) ?? new Map();
    this.fallbackTried.set(taskId, byRole);
    const entry = byRole.get(failed.role) ?? { tried: new Set<string>(), pending: false };
    byRole.set(failed.role, entry);
    entry.tried.add(failed.agent.id);
    const skip = (id: string) =>
      this.agentUnusable(taskId, id) || entry.tried.has(id) || tried?.has(id) === true;
    const next = fallbackAgentFor(loaded, failed.selected ?? failed.agent, skip);
    if (next.id === failed.agent.id || skip(next.id)) return undefined;
    entry.pending = true;
    const until =
      (limit
        ? this.limitedAgents.get(failed.agent.id)
        : this.failedAgents.get(taskId)?.get(failed.agent.id)) ?? this.now();
    return {
      actor: "sacty",
      event: {
        type: "AgentFellBack",
        payload: {
          runId: failed.runId,
          role: failed.role,
          agentId: failed.agent.id,
          fallbackAgentId: next.id,
          reason: limit ? "usage_limit" : reason === "auth" ? "auth" : "error",
          until: new Date(until).toISOString(),
        },
      },
    };
  }

  /** 失敗して代わりのエージェントに切り替えるなら、その記録。そうでなければ、止める記録（pause）。 */
  private pauseOrFallBack(
    taskId: string,
    failed: { runId: string; role: string; agent: AgentConfig; selected?: AgentConfig },
    reason: string,
    pause: ActivityItem,
    config?: SactyConfig,
  ): ActivityItem {
    return this.fallBack(taskId, failed, reason, config) ?? pause;
  }

  /**
   * ワーカーが、いま実行を始めてよいタスク（PBI-325）。実行待ちのうち、コンテキストのイメージを作り終えるのを待っている
   * ものを除く（実行の枠を数える前に除き、待っているタスクが、後の実行できるタスクの枠を塞がないように）。
   */
  runnableTaskIds(): string[] {
    return this.queuedTaskIds().filter((id) => {
      const task = this.tasks.get(id);
      return !(task && !this.inflight.has(id) && this.awaitingContextImages(task));
    });
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
              // 再開した後に、一時停止の間に届いた PR の指摘を反映する。PR の作成の前の確かめの待ちから外れていても、先に
              // 反映する（PBI-279）
              this.heldReviewDue(t) ||
              awaitingVerification(t) ||
              // 完了した調査の結果を、取り込み元の Issue に返す（PBI-18）
              awaitingIssueComment(t) ||
              // 書いたレビューを、対象の PR に投稿する（PBI-19）
              awaitingReviewPost(t) ||
              // 分割した子タスクを作る・始める、子タスクがすべて終わったら完了にする（PBI-27）
              this.splitPending(t) ||
              // 依存先の PR に重ねた子タスクの、起点のブランチの付け替え・停止（PBI-317）
              this.stackAction(t) !== undefined ||
              // 再現のテストを実行して、再現できたかを確かめる（PBI-29）
              awaitingReproductionCheck(t) ||
              // 作った PR の URL を、チケットにコメントする（PBI-52）
              awaitingTicketPrComment(t) ||
              // 承認した成果を、決めた書き出し先に書き出す（PBI-56）
              awaitingExport(t) !== undefined ||
              // 承認した成果で頼まれた、PR・Issue へのコメントを投稿する
              awaitingGitHubComments(t) !== undefined ||
              // PR のマージで承認する工程の、承認を待つ提出で頼まれたコメントを投稿する（PBI-301）
              awaitingSubmittedGitHubComments(t) !== undefined ||
              // 要求要件・設計の成果を、タスクブランチへの PR にする（PBI-57）
              this.awaitingStepPullRequest(t) !== undefined ||
              // マージの後のデプロイの確認（PBI-89）。一時停止中のタスクでは実行しない
              (awaitingDeploymentCheck(t) && t.status !== "paused") ||
              // 完了したタスクの監査（PBI-125）
              this.awaitingAudit(t),
        )
        .filter(
          (t) =>
            !this.cancelling.has(t.id) &&
            !this.pauseRequested.has(t.id) &&
            // PR のマージで作り直しを止めている間は、実行を始めさせない（PBI-276）
            !this.mergeStopping.has(t.id),
        )
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
    // デーモンが止まって終わらなかったエラーの分析も、中断として記録する（次の分析を受け付けるため）
    for (const task of [...this.tasks.values()]) {
      const analysis = pendingErrorAnalysis(task);
      if (!analysis || task.status === "cancelled") continue;
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "ErrorAnalyzed",
            payload: {
              analysisId: analysis.id,
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
      // 以前の版で、AI（ゴールガーディアン）が判定している間に止まった申し出は、人の判断待ちにする（PBI-333）
      const judging = task.proposals.find((p) => !p.judgement && !p.decision);
      if (task.status === "idle" && judging) {
        this.append(task, [
          {
            actor: "sacty",
            event: {
              type: "TaskEscalated",
              payload: {
                step: judging.fromStep,
                target: judging.target,
                reason: "change_proposed",
                proposalId: judging.id,
              },
            },
          },
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
              // 作業を止めたコンテナが残っているかもしれない実装の作り直し（開いた PR がある）も、実行を残す。PR のマージで
              // 作り直しを止めるとき（PBI-276）、停止を確かめてから承認へ進むため
              ...(step === "operation" || reworkingPullRequest(task)
                ? this.unstoppedPayload([task.currentRunId])
                : {}),
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

  // ─── 終わったタスクと、中断された実行の作業領域の片付け（PBI-157） ─────────────────────────────

  /**
   * 作業領域を使っている（実行・質問の答え・中止の片付け・用意の途中、ほかのタスクの統合レビューが読んでいる）か。
   */
  private workspaceBusy(taskId: string): boolean {
    return (
      this.inflight.has(taskId) ||
      this.chats.has(taskId) ||
      this.analyses.has(taskId) ||
      this.cancelling.has(taskId) ||
      this.preparing.has(taskId) ||
      (this.borrowed.get(taskId) ?? 0) > 0
    );
  }

  /** タスクの作業領域を消している途中なら、消し終わるまで待つ（作り直す・読む前に）。 */
  private async workspaceSettled(taskId: string): Promise<void> {
    await this.retiring.get(taskId);
  }

  /** 消している途中の作業領域を、すべて消し終わるまで待つ（新しくは消し始めない。テストと終了の前に使う）。 */
  async workspaceCleanupsSettled(): Promise<void> {
    while (this.retiring.size > 0) await Promise.all([...this.retiring.values()]);
  }

  /** 動いているコンテナがマウントしている場所。問い合わせられなければ undefined。 */
  private async containerMounts(): Promise<string[] | undefined> {
    if (!this.deps.containerMounts) return [];
    return this.deps.containerMounts().catch(() => undefined);
  }

  /**
   * 消す。どれかが動いているコンテナがマウントしている場所と重なれば、どれも消さない。1つを消せなければ理由をログに残し、
   * 残りは消す（デーモンの起動・タスクの進行を止めない）。消したものの数を返す。
   */
  private async removeWorkspacePaths(
    paths: readonly string[],
    mounts: readonly string[],
  ): Promise<number> {
    const mounted = paths.find((path) => overlapsMounts(path, mounts));
    if (mounted) {
      console.warn(
        `[daemon] 動いているコンテナがマウントしているので、消しませんでした：${mounted}`,
      );
      return 0;
    }
    const remove = this.deps.removeWorkspaceEntry ?? removeEntry;
    let removed = 0;
    for (const path of paths) {
      try {
        if (await remove(this.deps.workspaceRoot, path)) removed++;
      } catch (error) {
        console.warn(`[daemon] 作業領域を消せませんでした：${path}：${errorText(error)}`);
      }
    }
    return removed;
  }

  /**
   * 完了したタスクが、もう作業領域を使わなければ（監査をするタスクは監査が終わったら）、タスクの作業領域と退避した git の
   * メタデータを消す。作業領域を使っている途中なら消さない（その終わりに、もう一度呼ぶ）。消し終わるまでの Promise を返す。
   * mounts は、起動時の片付けが問い合わせ済みのもの（無ければ問い合わせる）。消したものの数で解決する。
   */
  private retireWorkspace(taskId: string, known?: readonly string[]): Promise<number> {
    if (this.retiring.has(taskId)) return Promise.resolve(0);
    const retirable = () => {
      const task = this.tasks.get(taskId);
      return task !== undefined && workspaceRetirable(task) && !this.workspaceBusy(taskId);
    };
    if (!retirable()) return Promise.resolve(0);
    const paths = taskWorkspacePaths(this.deps.workspaceRoot, taskId);
    if (!paths.some((path) => existsSync(path))) return Promise.resolve(0);
    const done = (async () => {
      const mounts = known ?? (await this.containerMounts());
      if (mounts === undefined) {
        console.warn(
          `[daemon] コンテナが動いていないことを確かめられないので、タスク ${taskId} の作業領域を消しませんでした（次の起動のときに、もう一度確かめます）。`,
        );
        return 0;
      }
      // 問い合わせている間に、作業領域を使い始めたなら消さない（使い始めた処理は、消し終わるのを待ってから作り直す）
      if (!retirable()) return 0;
      return this.removeWorkspacePaths(paths, mounts);
    })().finally(() => this.retiring.delete(taskId));
    this.retiring.set(
      taskId,
      done.then(() => {}),
    );
    return done;
  }

  /**
   * 作業領域を使う実行の前に、消えていれば同じ起点で用意し直す（完了の後に消したタスク。PBI-157）。作業領域と退避した git の
   * メタデータが両方とも無いときだけ用意し直す（片方が残っていれば、これまでどおり用意し直さず、写すところで失敗する。
   * 作業中の実装の変更を消さないため）。用意できなければ、その理由を返す。
   */
  private async workspaceMissing(task: Task): Promise<DaemonText | undefined> {
    await this.workspaceSettled(task.id);
    if (
      existsSync(join(this.deps.workspaceRoot, task.id)) ||
      existsSync(this.trustedGitDir(task))
    ) {
      return undefined;
    }
    const loaded = this.deps.config();
    if (!loaded.ok) return loaded.problem;
    const ready = await this.prepareRepository(task, loaded.config);
    return ready.ok ? undefined : ready.message;
  }

  /**
   * デーモンの起動時に、前回の残りを消す（ワーカーが実行を再開・始める前に終える）。実行ごとの一時領域のうち、動いている
   * 実行のものでないものと、もう作業領域を使わない完了したタスク・どのタスクのものでもない作業領域と退避した git の
   * メタデータ。消したものの数を返す。
   */
  async cleanupWorkspacesAtStartup(): Promise<number> {
    const root = this.deps.workspaceRoot;
    // 消す候補は、最初に待つ前（API の待ち受け・ワーカーを始める前）に決める。片付けの間に始まった実行・質問が作る
    // 一時領域・作業領域は、候補に入らないので消さない（PBI-157 レビュー指摘）
    const scratch = RUN_SCRATCH_DIRS.flatMap((name) =>
      idEntries(join(root, name)).map((runId) => ({ runId, path: join(root, name, runId) })),
    );
    const taskIds = new Set([
      ...idEntries(root),
      ...idEntries(join(root, "_git"), ".git").map((name) => name.slice(0, -".git".length)),
      ...idEntries(join(root, TASK_CACHE_DIR)),
    ]);
    const mounts = await this.containerMounts();
    if (mounts === undefined) {
      console.warn(
        "[daemon] コンテナが動いていないことを確かめられないので、残っている作業領域を消しませんでした（次の起動のときに、もう一度確かめます）。",
      );
      return 0;
    }
    let removed = 0;
    for (const { runId, path } of scratch) {
      // 停止を確かめられなかったコンテナの実行のものは残す（消す直前の状態で確かめる）
      if (this.activeRunIds().has(runId)) continue;
      removed += await this.removeWorkspacePaths([path], mounts);
    }
    for (const taskId of taskIds) {
      // 完了したタスクは、完了の後と同じく消す（その間に質問などが作業領域を使い始めても、消し終わるのを待つ）。
      // 中止したタスクは、中止の片付けに任せる（依存のキャッシュだけは、ここでも消す）
      const task = this.tasks.get(taskId);
      if (task) {
        // 中止したタスクの依存のキャッシュ（中止の片付けの途中で止まったなど）は、もう使わないので消す（PBI-319）。
        // 完了したタスクと同じく、作業領域・退避した git のメタデータ・キャッシュのどれかがマウントと重なれば残す
        if (
          task.status === "cancelled" &&
          !this.workspaceBusy(taskId) &&
          !taskWorkspacePaths(root, taskId).some((path) => overlapsMounts(path, mounts))
        ) {
          removed += await this.removeWorkspacePaths([taskCachePath(root, taskId)], mounts);
        }
        removed += await this.retireWorkspace(taskId, mounts);
        continue;
      }
      // どのタスクのものでもないものは消す（新しいタスクは新しい ID なので、使い始めることは無い）
      removed += await this.removeWorkspacePaths(taskWorkspacePaths(root, taskId), mounts);
    }
    return removed;
  }

  /** 動いている実行（工程・質問への答え）と、停止を確かめられなかったコンテナの実行。 */
  private activeRunIds(): Set<string> {
    const active = new Set<string>(
      [...this.chats.values(), ...this.analyses.values()].map((c) => c.runId),
    );
    for (const entry of this.inflight.values()) for (const runId of entry.runIds) active.add(runId);
    for (const task of this.tasks.values())
      for (const runId of task.unstoppedRuns ?? []) active.add(runId);
    return active;
  }

  /** 実装の対象リポジトリの、タスクごとの clone の場所。 */
  private repoDir(task: Task): string {
    return join(this.deps.workspaceRoot, task.id, "repo");
  }

  /** 起点のコミットごとの、コミットメッセージの形の定め（commitSubjectFor が読んだもの）。 */
  private readonly commitConventions = new Map<string, boolean>();

  /**
   * sacty が作るコミットの1行目（PBI-301 A8）。リポジトリが Conventional Commits の形（Commitizen・commitlint の設定、
   * AGENTS.md・CONTRIBUTING などの決まり）を定めているときだけ、題に種類（feat・fix・docs）を付ける。定めは起点のコミットから
   * 読む（エージェントが書き換えた作業領域は読まない。再開しても同じコミットになる）。読めなければ、定めが無いものとして題のまま。
   */
  private async commitSubjectFor(task: Task, kind: CommitKind, title: string): Promise<string> {
    const baseCommit = task.repository?.baseCommit;
    if (!baseCommit) return title;
    const gitDir = this.trustedGitDir(task);
    const key = `${gitDir}@${baseCommit}`;
    let conventional = this.commitConventions.get(key);
    if (conventional === undefined) {
      const files: Record<string, string | undefined> = {};
      let unreadable = false;
      await Promise.all(
        COMMIT_CONVENTION_FILES.map(async (path) => {
          try {
            files[path] = await this.deps.repos.readFile(gitDir, baseCommit, path);
          } catch {
            // 読めない（大きすぎる・文字でない・git を実行できない）ものは、定めを探す材料にしない
            unreadable = true;
          }
        }),
      );
      conventional = detectCommitConvention(files);
      // 起点のコミットの内容は変わらないので覚える。読めないものがあった回は、覚えずに次に読み直す
      if (!unreadable) this.commitConventions.set(key, conventional);
    }
    return commitSubject(title, kind, conventional);
  }

  /** 実装のコミットの種類。文書だけの依頼は docs、不具合の修正は fix、それ以外は feat。 */
  private implementCommitKind(task: Task): CommitKind {
    if (task.documentsOnly === true) return "docs";
    return verificationBasis(task) === "reproduce" ? "fix" : "feat";
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
        // テストは、タスクのイメージで実行する（PBI-318。古い版の作業履歴なら、確かめる工程のイメージ）。
        // images から消した名前なら既定のイメージにしておき、テストを実行するところで理由を示して止める
        ...testImageOf(this.projectImagesConfig(config, task.projectId), verificationImageOf(task)),
        pullRequest: { provider: "github" as const, repo },
      },
    };
  }

  /**
   * 実装の PR の向き先を記録し、PR の更新でも向き先を付け替えるタスクか（PBI-317）。依存先の PR に重ねている子タスクと、
   * 重ねて作った PR の向き先を記録した子タスク（付け替えの後も）。ほかの PR は、向き先を作るときだけ決める（今までどおり）。
   */
  private recordsPullRequestBase(task: Task): boolean {
    return Boolean(task.stack || task.pullRequest?.baseBranch !== undefined);
  }

  /** 依存先の PR に重ねている子タスクの、重ねた先の PR（本文に書く。PBI-317）。 */
  private stackedPullRequest(
    task: Task,
  ): { number: number; url: string; title: string } | undefined {
    const dep = task.stack && this.tasks.get(task.stack.taskId);
    const pr = dep?.pullRequest;
    if (!dep || !pr?.number || !pr.url) return undefined;
    return { number: pr.number, url: pr.url, title: dep.title };
  }

  /**
   * 重ねた子タスクの、承認待ちの実装の PR の向き先を、今の起点のブランチに付け替える（PBI-317。依存先の PR がマージされた
   * 後）。本文も書き直し（重ねた先が変わる・無くなる）、重ねるのをやめたなら、ドラフトを外す（検証に通った PR なので）。
   * 失敗したら、記録せずに次の確認でやり直す（承認待ちのまま。タスクは止めない）。付け替えの間は、そのタスクを実行しない。
   * 差し戻し・一時停止・中止などでタスクが変わったら（`unchanged`）、次のようにする。どれも記録しない（やり直しの提出が、
   * そのときの向き先・ドラフトで PR を更新する）。
   * - 認証・本文の用意の後（PR の更新の前）に見つけたら、PR を更新しない
   * - PR の更新を待つ間に変わったら、ドラフトを外さない
   * - ドラフトを外す操作を待つ間に変わったら、ドラフトに戻す（台帳はドラフトのまま。中止・完了したタスクは戻さない）
   */
  private async retargetPullRequest(task: Task): Promise<void> {
    const pr = task.pullRequest;
    const repository = task.repository;
    if (!pr?.number || !pr.repo || !repository) return;
    const usedSecrets: string[] = [];
    // 付け替えを始めたときと同じ承認待ちのままか（同じ PR・同じコミット・同じ提出・同じ起点のブランチ・重ねているか）
    const unchanged = (): Task | undefined => {
      const latest = this.tasks.get(task.id);
      const now = latest?.pullRequest;
      const same =
        latest?.status === "awaiting_approval" &&
        now?.number === pr.number &&
        now?.commit === pr.commit &&
        !now?.verifying &&
        latest.gate?.step === "implement" &&
        latest.gate.submission === task.gate?.submission &&
        latest.repository?.baseBranch === repository.baseBranch &&
        latest.stack?.taskId === task.stack?.taskId &&
        !this.cancelling.has(task.id);
      return same ? latest : undefined;
    };
    this.retargeting.add(task.id);
    try {
      const token = await this.githubToken(task, pr.repo, usedSecrets);
      const stackedOn = this.stackedPullRequest(task);
      // 本文は、承認待ちの PR を作ったときと同じ材料で書き直す（重ねた先だけが変わる）
      const aiReview = aiReviewFor(
        { repo: pr.repo, number: pr.number, head: pr.commit },
        task.id,
        this.tasks.values(),
        sameRepo,
      );
      const stage = {
        secrets: usedSecrets,
        aiReview,
        ...(stackedOn ? { stackedOn } : {}),
      };
      // 本文は、待つ間に人が変えた題で書く（テンプレートを読んだ後に作る。PBI-323）
      const { body } = await this.pullRequestBody(
        pr.repo,
        token,
        usedSecrets,
        () => buildPullRequestBodyText(this.latestTitled(task), stage),
        () => buildPullRequestBodyParts(this.latestTitled(task), stage),
      );
      // 人が直した本文は、3方向でマージして残す（PBI-334）
      // 付け替えはタスクの実行の外なので、重なってもエージェントは実行しない（次のやり直しの提出でまとめる）
      const sent = await this.reconcilePullRequestBody(task, {
        repo: pr.repo,
        token,
        number: pr.number,
        generated: body,
        agent: false,
      });
      // 認証・本文の用意を待つ間に変わったら、古い向き先・本文で PR を更新しない
      if (!unchanged()) return;
      await this.deps.pulls.upsert({
        repo: pr.repo,
        token,
        branch: pr.branch,
        baseBranch: repository.baseBranch,
        title: task.title,
        body: sent.body,
        number: pr.number,
        retarget: true,
      });
      if (sent.record) this.recordPullRequestBody(task.id, pr.repo, pr.number, body);
      // PR のレビューの子タスクの指摘なしを待つ PR は、ドラフトのままにする（指摘なしで外す。PBI-331）
      const ready = !task.stack && !pr.awaitingReview;
      if (!unchanged()) return;
      if (ready) {
        try {
          await this.deps.pulls.setDraft({
            repo: pr.repo,
            token,
            number: pr.number,
            draft: false,
          });
        } catch (error) {
          // 答えを受け取れなくても、GitHub ではドラフトが外れているかもしれない。待つ間にタスクが変わったなら、ドラフトに
          // 戻しておく（変わったタスクは付け替えの対象から外れうるので、次の確認では直らない）。変わっていなければ、次の確認で
          // やり直す（記録していないので）
          if (!unchanged()) {
            await this.redraftAfterRetarget(task.id, pr.repo, token, pr.number, usedSecrets);
          }
          throw error;
        }
      }
      const latest = unchanged();
      if (!latest) {
        if (ready) await this.redraftAfterRetarget(task.id, pr.repo, token, pr.number, usedSecrets);
        return;
      }
      const retargeted = this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "PullRequestRetargeted",
            payload: {
              number: pr.number,
              baseBranch: repository.baseBranch,
              ...(ready ? { ready: true as const } : {}),
            },
          },
        },
      ]);
      // ドラフトを外したら、PR をレビューする子タスクを作る（PBI-330）
      this.ensureReviewTask(retargeted, "implement", pr.repo, pr.number, pr.url);
    } catch (error) {
      console.warn(
        `[daemon] PR #${pr.number}（${pr.repo}）の向き先を ${repository.baseBranch} に付け替えられませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    } finally {
      this.retargeting.delete(task.id);
    }
  }

  /**
   * 付け替えでドラフトを外す操作を待つ間にタスクが変わったとき、PR をドラフトに戻す（PBI-317。記録しなかったので、台帳の
   * ドラフトにそろえる。安全側）。中止・完了したタスクの PR は戻さない。戻せなければログに出す（やり直しの提出が、その
   * ときのドラフトで PR を更新する）。
   */
  private async redraftAfterRetarget(
    taskId: string,
    repo: string,
    token: string,
    number: number,
    usedSecrets: readonly string[],
  ): Promise<void> {
    const latest = this.tasks.get(taskId);
    if (!latest || latest.status === "cancelled" || isCompleted(latest)) return;
    if (latest.pullRequest?.number !== number) return;
    await this.deps.pulls.setDraft({ repo, token, number, draft: true }).catch((error: unknown) => {
      console.warn(
        `[daemon] PR #${number}（${repo}）をドラフトに戻せませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    });
  }

  /**
   * 実装の作業領域に、ベースブランチの最新と、人が PR のブランチに足したコミット（PBI-334）を取り込むタスクか。sacty が PR を
   * 作る実装だけ。既存の PR を引き継ぐタスクは、人の PR のブランチに積むので取り込まない。ベースブランチの取り込みは、
   * 設定 mergeBase（テスト用）が false なら行わない（`syncBase`）。
   */
  private mergesBase(task: Task): boolean {
    return !!task.repository && !task.continuedPullRequest;
  }

  /**
   * ベースブランチの最新を、実装の作業領域に取り込む（ホストで、作業領域の内容とベースブランチの先頭を3方向でマージする。
   * 履歴は書き換えない）。取り込んだら、提出するコミットは、その先頭を第2の親にしたマージコミットになる。
   * - 取り込むものが無ければ、何もしない（clean）
   * - 競合したファイルには目印が入る。目印が残っているうちは、さらに取り込まず、そのファイルを返す（conflicts。実装の
   *   エージェントが解消する）。fresh は、この呼び出しで新しく競合したこと（前の取り込みの目印が残っているのではない）
   * - 取得・マージできなければ failed（呼び出し側が止める）
   * エージェントの実行中は呼ばない（作業領域を書き換えるため）。
   */
  private async syncBase(
    task: Task,
  ): Promise<
    | { kind: "clean" }
    | { kind: "conflicts"; files: string[]; fresh: boolean }
    | { kind: "failed"; message: DaemonText }
  > {
    const repository = task.repository;
    if (!repository) return { kind: "clean" };
    const dir = this.repoDir(task);
    const gitDir = this.trustedGitDir(task);
    const usedSecrets: string[] = [];
    try {
      // 前に取り込んで競合した目印が残っていれば、先に解消させる（目印の上に、さらに取り込まない）
      const pending = pendingConflicts(task);
      if (pending.length > 0) {
        const remaining = await this.deps.repos.conflictMarkers(dir, pending);
        if (remaining.length > 0) return { kind: "conflicts", files: remaining, fresh: false };
      }
      // 人が PR のブランチに足したコミットを、先に取り込む（PBI-334。取り込まずに積むと、プッシュできないか、人の変更が消える）
      const head = await this.syncPullRequestHead(task);
      if (head.kind !== "clean") return head;
      if (this.deps.mergeBase === false) return { kind: "clean" };
      task = this.mustGet(task.id);
      const base = workBaseCommit(repository, task.baseMerge);
      // 依存先の PR に重ねた子タスクは、依存先の PR の合格したコミットを取り込む（依存先が直されて合格し直したとき。PBI-317）。
      // 依存先が作り直しの途中（合格した PR が無い）なら、取り込まない
      const stackedOn = task.stack && this.tasks.get(task.stack.taskId);
      const reviewed = stackedOn ? reviewedPullRequest(stackedOn) : undefined;
      if (task.stack && (!reviewed || reviewed.commit === base)) return { kind: "clean" };
      const authEnv = await this.gitAuth(task, repository.url, usedSecrets);
      const fetched = await this.deps.repos.fetchBranch(gitDir, repository.baseBranch, authEnv);
      const tip = reviewed?.commit ?? fetched;
      if (tip === base) return { kind: "clean" };
      const merged = await this.deps.repos.mergeBase({
        dir,
        gitDir,
        base,
        target: tip,
        maxConflicts: MAX_BASE_CONFLICTS,
      });
      if (merged.status === "unchanged") return { kind: "clean" };
      // 作業領域に書いた結果を、すぐ記録する（以後の差分・コミットは、取り込んだ先頭を起点にする）
      // 全件を記録する（競合が多すぎるときは、mergeBase が作業領域を書き換える前に失敗する）。切り捨てると、残りの目印を検査できない
      const conflicts = merged.conflicts;
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: { type: "BaseBranchMerged", payload: { from: base, commit: tip, conflicts } },
        },
      ]);
      return conflicts.length > 0
        ? { kind: "conflicts", files: conflicts, fresh: true }
        : { kind: "clean" };
    } catch (error) {
      return {
        kind: "failed",
        message: message("merge.failed", { detail: redactText(errorText(error), usedSecrets) }),
      };
    }
  }

  /**
   * 人が sacty の PR のブランチに足したコミット（レビューの提案の適用・ベースブランチの取り込みなど）を、実装の作業領域に
   * 取り込む（PBI-334）。sacty が最後にプッシュしたコミット（取り込み済みならその先頭）を共通の祖先にして、作業領域の内容と
   * ブランチの先頭を3方向でマージする（`mergeBase`。タスクブランチから引き継ぐ要求要件・設計のファイルは外す）。取り込んだら
   * PullRequestHeadMerged を記録し、次の提出はその先頭を親にして積む（強制プッシュしない）。
   * - 取り込むもの（sacty がまだプッシュしていない・ブランチが進んでいない）が無ければ clean
   * - ブランチを読めない（PR がマージされてブランチが消えたなど）ときは、取り込まずに clean（ログに出す。プッシュで止まる）
   * - 競合したファイルには目印が入り、conflicts（fresh）を返す。マージできなければ failed
   * エージェントの実行中は呼ばない（作業領域を書き換えるため）。
   */
  private async syncPullRequestHead(
    task: Task,
  ): Promise<
    | { kind: "clean"; merged?: true }
    | { kind: "conflicts"; files: string[]; fresh: boolean }
    | { kind: "failed"; message: DaemonText }
  > {
    const repository = task.repository;
    const pushed = task.pushedBranch;
    // ベースブランチの取り込みの設定（テスト用の mergeBase）とは関係なく取り込む。引き継いだ人の PR は、人のブランチなので
    // 取り込まない（publishContinued が、前にプッシュしたコミットか先頭に積む）
    if (!repository || !pushed || task.continuedPullRequest) return { kind: "clean" };
    const pending = pendingHeadMerge(task);
    // 前の取り込みで競合した目印が残っていれば、さらに取り込まず、先に解消させる（新しい取り込みの記録で、残った目印の記録を
    // 消さない）
    if (pending && pending.conflicts.length > 0) {
      try {
        const remaining = await this.deps.repos.conflictMarkers(
          this.repoDir(task),
          pending.conflicts,
        );
        if (remaining.length > 0) return { kind: "conflicts", files: remaining, fresh: false };
      } catch (error) {
        return {
          kind: "failed",
          message: message("pr.headMergeFailed", {
            branch: pushed.branch,
            detail: errorText(error),
          }),
        };
      }
    }
    const known = pending?.commit ?? pushed.commit;
    const gitDir = this.trustedGitDir(task);
    const usedSecrets: string[] = [];
    let head: string;
    try {
      const authEnv = await this.gitAuth(task, repository.url, usedSecrets);
      head = await this.deps.repos.fetchBranch(gitDir, pushed.branch, authEnv);
    } catch (error) {
      const detail = redactText(errorText(error), usedSecrets);
      console.warn(
        `[daemon] PR のブランチ ${pushed.branch} を読めないため、人が足したコミットを確かめませんでした：${renderMessage(detail, "ja")}`,
      );
      return { kind: "clean" };
    }
    if (head === known) return { kind: "clean" };
    try {
      const keep = [...new Set(task.stepPullRequests.map((p) => p.path))];
      const merged = await this.deps.repos.mergeBase({
        dir: this.repoDir(task),
        gitDir,
        base: known,
        target: head,
        maxConflicts: MAX_BASE_CONFLICTS,
        ...(keep.length > 0 ? { exclude: keep } : {}),
      });
      // 先頭が、sacty がプッシュしたものの履歴に含まれる（人が戻した）ときも、次の提出はその先頭に積む
      const conflicts = merged.conflicts;
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "PullRequestHeadMerged",
            payload: {
              branch: pushed.branch,
              from: pushed.commit,
              commit: head,
              conflicts,
            },
          },
        },
      ]);
      return conflicts.length > 0
        ? { kind: "conflicts", files: conflicts, fresh: true }
        : { kind: "clean", merged: true };
    } catch (error) {
      return {
        kind: "failed",
        message: message("pr.headMergeFailed", {
          branch: pushed.branch,
          detail: redactText(errorText(error), usedSecrets),
        }),
      };
    }
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
  ): ReturnType<TaskService["prepareRepositoryNow"]> {
    // 同じタスクの用意は1つずつにする（完了の後の質問と再レビューが、同時に clone し直して、互いの clone を消さないように。
    // PBI-157 レビュー指摘）。待った後は、先の用意の記録を含む最新の状態で確かめる
    const previous = this.preparing.get(task.id);
    const current = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        this.prepareRepositoryNow(
          previous ? (this.tasks.get(task.id) ?? task) : task,
          config,
          rebase,
        ),
      );
    this.preparing.set(task.id, current);
    try {
      return await current;
    } finally {
      if (this.preparing.get(task.id) === current) this.preparing.delete(task.id);
    }
  }

  private async prepareRepositoryNow(
    task: Task,
    config: SactyConfig,
    rebase?: { branch: string },
  ): Promise<
    | { ok: true; dir: string; prepared?: { url: string; baseBranch: string; baseCommit: string } }
    | { ok: false; message: DaemonText }
  > {
    // 完了の後に作業領域を消している途中なら、消し終わってから用意し直す（PBI-157）
    await this.workspaceSettled(task.id);
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
    // 依存先の PR に重ねた子タスクは、初めて用意するとき、その PR のブランチの合格したコミットで用意する（PBI-317）。用意する
    // 前に依存先がマージされたなら、付け替えた起点のブランチ（stackedBase）の最新で用意する
    const branch =
      rebase?.branch ?? task.repository?.baseBranch ?? task.stack?.branch ?? task.stackedBase;
    const usedSecrets: string[] = [];
    try {
      const prepared = await this.deps.repos.prepare(
        dir,
        this.trustedGitDir(task),
        url,
        branch,
        await this.gitAuth(task, url, usedSecrets),
        // 用意し直すとき（作業領域が消えた）は、記録済みの起点のコミットで用意する（PBI-15）。ベースブランチの最新を
        // 取り込んでいたなら、そのコミットで用意する（取り込む前の実装の変更は戻らないので、起点に戻すと取り込みが消える）
        rebase
          ? undefined
          : task.repository
            ? workBaseCommit(task.repository, task.baseMerge)
            : task.stack?.commit,
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
      } else if (baseCommit !== workBaseCommit(task.repository, task.baseMerge)) {
        throw new MessageError(
          message("git.baseCommitMissing", {
            commit: workBaseCommit(task.repository, task.baseMerge),
          }),
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

  /**
   * GitHub の読み取りの中継で使える、ホストごとの gh のアカウント（タスクのプロジェクトで選んだもの）。タスクでない
   * 実行や、アカウントを選んでいないプロジェクトでは空。
   */
  private githubRelayHosts(taskId: string): Record<string, string> {
    const task = this.tasks.get(taskId);
    const accounts = task ? this.deps.projects.get(task.projectId)?.githubAccounts : undefined;
    return { ...accounts };
  }

  /** gh api の既定のホスト（タスクのリポジトリのホスト、無ければ github.com、無ければ最初のホスト）。 */
  private githubDefaultHost(taskId: string, hosts: readonly string[]): string {
    const task = this.tasks.get(taskId);
    const repo = task?.source?.repo ?? task?.repo ?? task?.repository?.url;
    const host = repo ? httpsHost(`${repo}/`) : undefined;
    const bound = new Set(hosts);
    if (host && bound.has(host)) return host;
    return bound.has("github.com") ? "github.com" : (hosts[0] ?? "github.com");
  }

  /** すべてのプロジェクトで、url のホストに選んだ gh のアカウント（重複なし）。 */
  private githubAccountsOnHost(url: string): string[] {
    const host = httpsHost(`${url}/`) ?? "";
    return [
      ...new Set(
        this.deps.projects.all().flatMap((p) => {
          const account = p.githubAccounts?.[host];
          return account ? [account] : [];
        }),
      ),
    ];
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
    if (
      this.cancelling.has(taskId) ||
      this.pauseRequested.has(taskId) ||
      this.mergeStopping.has(taskId) ||
      this.retargeting.has(taskId)
    ) {
      return;
    }
    const task = this.tasks.get(taskId);
    if (task && this.parentCancelled(task)) {
      if (task.status === "cancelled" || isCompleted(task)) return;
      // 実行の印（inflight）を付ける前に中止する（中止は、実行中の処理の終わりを待つため）
      await this.cancel(taskId).catch((error) => {
        console.error(`[daemon] could not cancel subtask ${taskId}:`, error);
      });
      return;
    }
    // コンテキストのイメージを作っている間は、実行を始めない（実行の印も付けない。次の見回りで確かめ直す。PBI-325）
    if (task && this.awaitingContextImages(task)) return;
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
      // 完了・監査の終わりを記録した実行なら、作業領域を消す（PBI-157）
      void this.retireWorkspace(taskId);
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
    // PR のマージで止めた実行（PBI-276）は、人の一時停止にしない（stopReworkForMerge が、止めた理由とともに承認として進める）
    if (this.mergeStopping.has(taskId)) return;
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
    // 一時停止の間に届いた PR の指摘は、止まった工程を走り直す前に反映する（PBI-279）
    const held = this.tasks.get(taskId);
    // （反映の対象でなければ、待たずに先へ進む。待つと、ほかの処理との順番が変わる）
    if (held && this.heldReviewDue(held) && (await this.reworkHeldReview(held))) return;
    const initial = this.tasks.get(taskId);
    // 依存先の PR に重ねた子タスクは、ほかの処理の前に、起点のブランチの付け替え・停止をする（PBI-317）
    if (initial && this.stackAction(initial)) return this.settleStack(initial);
    // 承認した成果の書き出しは、次の工程と取り込み元へのコメントの前に行う（コメントに URL を添えるため。PBI-56）
    const exporting = initial && awaitingExport(initial);
    if (initial && exporting) return this.exportOutput(initial, exporting);
    // 承認した成果で頼まれたコメントは、次の工程の前に投稿する
    const commenting = initial && awaitingGitHubComments(initial);
    if (initial && commenting) return this.postGitHubComments(initial, commenting);
    // PR のマージで承認する工程の、承認を待つ提出で頼まれたコメントは、承認を待たずに投稿する（PBI-301）
    const submittedComments = initial && awaitingSubmittedGitHubComments(initial);
    if (initial && submittedComments) {
      return this.postGitHubComments(initial, submittedComments, "submitted");
    }
    if (initial && awaitingVerification(initial)) {
      // 最終レビュー（テストの実行）も CI の待ちもせずに、PR の作成へ進める（PR のレビューの子タスクがレビューする。PBI-331）。
      // ベースブランチは取り込み直さないが、実装の間に人が PR のブランチに足したコミットは取り込む（PBI-334）。実装の前の
      // 取り込みで競合した目印が残っていれば、PR を作らずに実装をやり直す
      if (!(await this.headSyncedBeforePublish(initial))) return;
      if (!(await this.conflictsResolved(this.mustGet(taskId)))) return;
      const securityScope = await this.checkSecurityScope(initial);
      if (securityScope === "stopped") return;
      this.append(initial, [
        {
          actor: "sacty",
          event: {
            type: "FinalReviewSkipped",
            payload: securityScope ? { securityScope } : {},
          },
        },
      ]);
      return;
    }
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

    // 対象リポジトリは、タスクの開始時（最初の実行。情報収集の前）に、ベースブランチの最新を用意する（PBI-15）。
    // どの工程から始まるタスクでも同じ。以後はその起点のコミットを最後まで使う（途中で取り込み直さない）。
    // 情報収集は、用意したコードも読む。
    // 用意できなければ、エージェントを実行する（費用をかける）前に、理由を記録して止める
    // 対象リポジトリの無いタスク（PBI-73）と、チケットのトリアージを待つタスク（PBI-52）は、用意しない（リポジトリを
    // 決めたら、次の実行で用意する。それまでの情報収集は、リポジトリの候補のコードを GitHub の読み取りの中継で読む）
    if (!initial.repository && !isRepoless(initial) && !awaitingTicketTriage(initial)) {
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

    // タスクの開始時に、まず情報収集のエージェントがタスクに関係する情報を集めて絞り込む。まとめは、チケットのトリアージ・
    // オーケストレーター・すべての工程・ゴールガーディアンに渡す（分割の子タスクは親のまとめを内容に持つので集めない）
    if (
      awaitingGathering(initial) &&
      (await this.gatherInformation(this.mustGet(taskId), config.config))
    ) {
      return;
    }

    // チケットから取り込んだタスクは、まずオーケストレーターがチケットを読んで、作業するリポジトリ・題・概要を決める
    // （PBI-52。1段目）。リポジトリを用意した後に、いつもどおり工程を選ぶ（2段目）
    // 人がリポジトリを選んだ後も、そのリポジトリで題と概要を書くために、もう一度チケットを読む
    if (awaitingTicketTriage(initial)) return this.triageTicket(initial, config.config);

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
      // images があれば、レビューの工程のイメージだけをオーケストレーターに選ばせる（検証コマンドを実行するため）
      const choice = review
        ? await this.chooseReviewSteps(
            this.mustGet(taskId),
            this.projectImagesConfig(config.config, initial.projectId),
            review,
          )
        : await this.chooseSteps(
            this.mustGet(taskId),
            this.projectImagesConfig(config.config, initial.projectId),
          );
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
        const failedAgent = definedAgent(config.config, choice.failure.agentId);
        this.append(latest, [
          { actor: "orchestrator", event: { type: "OrchestratorFailed", payload: choice.failure } },
          // 失敗したら、止めずに代わりのエージェントで選び直す
          (failedAgent &&
            choice.failure.runId &&
            this.fallBack(
              taskId,
              {
                runId: choice.failure.runId,
                role: "orchestrator",
                agent: failedAgent,
                selected: agentFor(config.config, "orchestrator"),
              },
              choice.failure.reason,
              config.config,
            )) || {
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
      const { baseBranch, continuePullRequest, ...chosen } = choice;
      // 文書だけの依頼（PBI-284）は、実装を含み、不具合の修正でない組み合わせのときだけ使う（検証するコードの変更の話なので）
      if (
        chosen.documentsOnly &&
        (!chosen.steps.includes("implement") || chosen.steps.includes("reproduce"))
      ) {
        delete chosen.documentsOnly;
      }
      // タスクにある既存の PR を引き継いで直す（オーケストレーターの判断）なら、PR を確かめ、PR の元のブランチの先頭で
      // 用意し直す（ベースブランチの選択は使わない）。引き継げなければ、新しい PR を作らないように、工程を決めずに止める
      const continuing =
        continuePullRequest && continuablePullRequest(this.mustGet(taskId))
          ? await this.resolveContinuedPullRequest(this.mustGet(taskId))
          : undefined;
      // 既定のブランチと違うベースブランチを選んだなら、そのブランチの最新で用意し直す（PBI-25）。
      // 用意できなければ、既定のブランチのまま進め、そのことを理由に添える
      const prepared = this.mustGet(taskId).repository;
      // 依存先の PR に重ねた子タスクは、起点のブランチを依存先で決めるので、ベースブランチの選択は使わない（PBI-317）
      const stacked = this.mustGet(taskId);
      const rebaseTo = continuing?.ok
        ? continuing.pr.branch
        : stacked.stack || stacked.stackedBase !== undefined
          ? undefined
          : baseBranch;
      const rebased =
        rebaseTo && prepared && (continuing?.ok || rebaseTo !== prepared.baseBranch)
          ? await this.prepareRepository(this.mustGet(taskId), config.config, {
              branch: rebaseTo,
            })
          : undefined;
      const continueProblem =
        continuing && !continuing.ok
          ? continuing.message
          : continuing?.ok && rebased && !rebased.ok
            ? message("continue.unavailable", {
                number: continuing.pr.number,
                detail: rebased.message,
              })
            : undefined;
      // 引き継げないなら、工程を記録せずに、判断の費用と理由を記録して止める（再開すると工程の選択からやり直す）
      const stopContinuing = (problem: DaemonText) => {
        const latest = this.mustGet(taskId);
        if (this.pauseRequested.has(taskId) || this.cancelling.has(taskId)) return;
        if (latest.status !== "queued" || latest.steps.length > 0) return;
        this.append(latest, [
          {
            actor: "orchestrator",
            event: {
              type: "OrchestratorFailed",
              payload: {
                reason: "error",
                message: problem,
                agentId: chosen.agentId ?? "unknown",
                ...(chosen.authMode ? { authMode: chosen.authMode } : {}),
                ...(chosen.model ? { model: chosen.model } : {}),
                ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
                ...(chosen.runId ? { runId: chosen.runId } : {}),
                ...(chosen.usage ? { usage: chosen.usage } : {}),
                costUsd: chosen.costUsd,
                estimated: chosen.estimated,
                ...unknownCost(chosen),
              },
            },
          },
          {
            actor: "sacty",
            event: { type: "TaskPaused", payload: { reason: "error", message: problem } },
          },
        ]);
        this.warnIfNeeded(this.mustGet(taskId));
      };
      if (continueProblem) return stopContinuing(continueProblem);
      if (continuing?.ok) chosen.continuedPullRequest = continuing.pr;
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
      // PR を確かめた後に、ほかのタスクが同じ PR を引き継いだ・作ったなら、引き継がずに止める（並行して確かめたとき。ここから
      // 記録までは await しない）
      const takenBy = continuing?.ok
        ? this.continuedPullRequestOwner(taskId, continuing.pr)
        : undefined;
      if (continuing?.ok && takenBy) {
        return stopContinuing(
          message("continue.unavailable", {
            number: continuing.pr.number,
            detail: message("continue.inUse", { task: takenBy.id.slice(0, 8) }),
          }),
        );
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
      // テストの仕組みが無いという判断（PBI-94）を確かめる。使えなければ、その判断を記録しない（sacty はテストを実行しない
      // ので止めない。実装の工程のエージェントが、リポジトリから決めて実行する。PBI-331）
      if (this.checkNoTests(latest, chosen).stop) delete chosen.noTestsReason;
      // 選んだ組み合わせに予算を設定していれば、タスクの予算の上限をそれにする。人が上限を上げた後は、その上限を残す
      const planCap = chosen.plan && config.config.budgetPerPlanUsd?.[chosen.plan];
      if (planCap && !latest.budget.raised) chosen.budgetCapUsd = planCap;
      else delete chosen.budgetCapUsd;
      events.push({
        // レビューだけのタスクは、オーケストレーターがイメージを選んだときだけ、オーケストレーターの記録にする
        actor: review && chosen.imageSource !== "orchestrator" ? "sacty" : "orchestrator",
        event: { type: "StepsChosen", payload: chosen },
      });
      this.append(latest, events);
    }
    // 工程が終わったら、次の工程を実行する前に、オーケストレーターが残りの工程を見直し、要らない工程を飛ばす（工程の見直し）
    const reviewing = this.mustGet(taskId);
    if (reviewing.status === "queued" && reviewing.stepReview) {
      await this.reviewSteps(reviewing, reviewing.stepReview, config.config);
    }
    const task = this.mustGet(taskId);
    if (task.status !== "queued") return;
    const step = activeStep(task);
    if (!step) return;

    // 検証に通った実装の PR は、実装の工程の中で、エージェントではなく sacty が作る（PBI-110。予算の上限に達していても作る。
    // 費用はかからず、人の承認を待つだけなので）
    if (step === "implement" && task.publishPending) {
      await this.publish(this.mustGet(task.id), config.config);
      return;
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
      if (!resolved.ok && resolved.abandoned) return;
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
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で実行する
    const agent = this.usableAgent(config.config, chosen.agent, task.id, step);
    const runId = randomUUID();
    // 工程のイメージは、実行を始めたときのものに決める。実行の間に人が変えても、この実行は変えない（次の実行から。PBI-106・
    // PBI-318）。使う名前を実行の記録に残す（画面が、どのイメージで動いたかを出す）
    const runImageName = stepImageOf(this.mustGet(task.id), step);
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: {
            runId,
            step,
            agentId: agent.id,
            ...agentSetting(agent),
            image: runImageName ?? DEFAULT_IMAGE_NAME,
          },
        },
      },
    ]);

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
    // 実装は、始める前に、ベースブランチの最新を作業領域に取り込む（差し戻し・PR の指摘の取り込み・再レビューで実装を
    // やり直すときも。並行する別のタスクのマージで PR が競合したままにならないように）。競合したファイルには目印が入るので、
    // 実装の指示に渡して解消させる。取り込めなければ、実行せずに止める
    let mergeConflicts: string[] = [];
    if (step === "implement" && this.mergesBase(this.mustGet(task.id))) {
      const synced = await this.syncBase(this.mustGet(task.id));
      if (synced.kind === "failed") {
        this.append(task, [
          {
            actor: "sacty",
            event: {
              type: "AgentRunFailed",
              payload: { runId, step, agentId: agent.id, reason: "error", message: synced.message },
            },
          },
          { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
        ]);
        return;
      }
      if (synced.kind === "conflicts") mergeConflicts = synced.files;
    }
    // 実装と再現（再現のテストを書く。PBI-29）は clone を作業領域にし、ほかは使い捨ての写し（書き込めるので、
    // リポジトリの手順のセットアップなども実行できる。変更は残らない。PBI-40）
    const scratch = step !== "implement" && step !== "reproduce";

    // sacty の既定のコンテキストと、プロジェクトのコンテキストを取得・合成して渡し、
    // 使ったリポジトリとコミット（既定は中身のハッシュ）を記録する
    let context: RunContext | undefined;
    const contextSecrets: string[] = [];
    try {
      context = await this.runContext(task, agent, config.config, contextSecrets, undefined, step);
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
              message: redactText(errorText(error), contextSecrets),
            },
          },
        },
        { actor: "sacty", event: { type: "TaskPaused", payload: { reason: "error" } } },
      ]);
      return;
    }
    // 使える外部 PF：ホストの PF と、プロジェクトのコンテキストで合成した PF（同じ名前ならホストのもの。PBI-74）
    const runPlatforms = mergePlatforms(config.config.platforms, context?.platforms ?? []);
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
    // PR にすでにあるレビュー・コメント（他のレビュアーの指摘と作者の返答。PBI-144）
    let reviewExisting: PullRequestFeedback[] | "unreadable" | undefined;
    // PR のレビューの子タスクに渡す、レビューする先頭のコミットの CI（PBI-331）
    let reviewCi: ReviewCi | undefined;
    // PR のレビューの子タスクに渡す、セキュリティ対応の修正の範囲と照合の結果（PBI-331）
    let reviewSecurity: ReviewSecurity | undefined;
    // 引き継いで直す既存の PR の指摘（レビュー・行へのコメント・通常のコメント）。実装と、その前の工程に渡す
    const continued = this.mustGet(task.id).continuedPullRequest;
    const continuedFeedback =
      continued && step !== "review" && step !== "deployment"
        ? await this.continuedFeedback(this.mustGet(task.id), continued)
        : undefined;
    // 実装の指示に渡す指摘。実装の実行が終わったときに、その完了と一緒に記録する（PR の指摘として取り込み直さない）。実行を
    // 始められなかった・失敗したときは記録しないので、渡せなかった指摘は、あとで取り込む
    const handedOverKeys =
      step === "implement" && Array.isArray(continuedFeedback)
        ? passedContinuedFeedback(continuedFeedback).map((item) => item.key)
        : [];
    // 要求要件・設計の工程は、起点のコミットのコードを実行ごとのディレクトリに書き出して渡し、終わったら消す
    // （実装の作業領域は実装の変更を含むので使わない。差し戻しでやり直しても、同じ起点のコードを読む）
    const snapshotDir = scratch ? join(this.deps.workspaceRoot, "_snapshots", runId) : undefined;
    // PR の差分の全体を置く、sacty が管理するディレクトリ（写しの外。PBI-65）
    const reviewDiffDir =
      reviewTarget && snapshotDir ? join(this.deps.workspaceRoot, "_review", runId) : undefined;
    // 要求要件・設計の工程は、出典の分類の担当に読ませる Input を、作業領域の外に置く。抜き出しの照合にも同じ中身を使う
    const provenanceStep = step === "requirements" || step === "design" ? step : undefined;
    const inputs =
      provenanceStep && snapshotDir
        ? provenanceInputs(this.mustGet(task.id), provenanceStep, {
            ...(continuedFeedback !== undefined ? { continuedFeedback } : {}),
          })
        : undefined;
    const inputDir = inputs ? join(this.deps.workspaceRoot, "_input", runId) : undefined;
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
            // PR にすでにあるレビュー・コメント（PBI-144）と、再レビューでの作者の返答（PBI-111）を読む。
            // 読めなくてもレビューは止めない（読めなかったことをプロンプトに書く）
            // 運用する人のために、読めなかった理由はタスクと PR を添えてデーモンのログに残す（秘密の値は伏せる）
            const feedbackSecrets: string[] = [];
            const feedback = await this.reviewFeedback(latest, reviewTarget, feedbackSecrets).catch(
              (error: unknown) => {
                console.warn(
                  `[daemon] レビューのタスク ${task.id} で、PR #${reviewTarget.number}（${reviewTarget.repo}）の既存のレビューと作者の返答を読めませんでした。それらなしでレビューします：${renderMessage(redactText(errorText(error), feedbackSecrets), "ja")}`,
                );
                return "unreadable" as const;
              },
            );
            reviewExisting = feedback === "unreadable" ? "unreadable" : feedback.existing;
            if (latest.reviewOf && this.deps.ci) {
              reviewCi = await this.reviewCiOf(latest, reviewTarget);
            }
            // セキュリティ対応の実装の PR なら、修正の範囲と照合の結果を渡す（PBI-331）
            const parent = latest.reviewOf && this.tasks.get(latest.reviewOf.taskId);
            if (parent && latest.reviewOf?.step === "implement" && isSecurityFix(parent)) {
              reviewSecurity = {
                scope: securityScope(parent),
                ...(parent.securityScopeCheck ? { check: parent.securityScopeCheck } : {}),
              };
            }
            if (latest.previousReview) {
              reviewReplies = feedback === "unreadable" ? "unreadable" : feedback.replies;
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
      if (inputs && inputDir && !executed) {
        try {
          mkdirSync(inputDir, { recursive: true });
          for (const input of inputs) writeFileSync(join(inputDir, input.name), input.text);
        } catch (error) {
          executed = {
            outcome: { kind: "failed", reason: "error", message: errorText(error) },
            costUsd: 0,
            estimated: false,
          };
        }
      }
      // 工程のイメージ（タスクのイメージ。PBI-41・PBI-318）。images から消した名前なら、実行せずに理由を示して止める
      const stepImage = resolveImage(
        this.projectImagesConfig(config.config, task.projectId),
        runImageName,
      );
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
      // 同じコミットで、sacty の最終レビューが実行済みの検証（PBI-305）
      const reviewVerification =
        step === "review" ? this.reviewVerification(this.mustGet(task.id)) : undefined;
      executed ??= await this.execute({
        agent,
        taskId: task.id,
        image: (services?.ok && services.image) || imageName,
        ...(stepImage.ok ? { imageEnv: stepImage.env } : {}),
        taskCache: true,
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
            // PR にすでにあるレビュー・コメント（PBI-144）
            ...(reviewExisting !== undefined ? { existing: reviewExisting } : {}),
            ...(reviewCi ? { reviewCi } : {}),
            ...(reviewSecurity ? { reviewSecurity } : {}),
            // PR のレビューの子タスクに、指摘ごとの戻し先を示させる（PBI-332）
            ...this.reviewReworkContext(task),
            // 同じコミットで、sacty の最終レビューが実行済みの検証（PBI-305）
            ...(reviewVerification ? { reviewVerification } : {}),
            ...(continuedFeedback !== undefined ? { continuedFeedback } : {}),
            ...(mergeConflicts.length > 0 ? { mergeConflicts } : {}),
            ...(inputDir ? { inputDir: CONTAINER_INPUT_DIR } : {}),
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
        // 差分の全体（PBI-65）と出典の分類の Input は、作業領域の外に読み取り専用でマウントする
        ...(reviewDiff !== undefined && reviewDiffDir
          ? {
              mounts: [
                { hostPath: reviewDiffDir, containerPath: CONTAINER_REVIEW_DIR, readOnly: true },
              ],
            }
          : inputDir
            ? {
                mounts: [
                  { hostPath: inputDir, containerPath: CONTAINER_INPUT_DIR, readOnly: true },
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
      if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
      if (reviewDiffDir) await rm(reviewDiffDir, { recursive: true, force: true });
      if (inputDir) await rm(inputDir, { recursive: true, force: true });
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
              ...unknownCost(executed),
            },
          },
        },
        // 失敗したら、止めずに代わりのエージェントでやり直す
        this.pauseOrFallBack(
          task.id,
          { runId, role: step, agent, selected: chosen.agent },
          outcome.reason,
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
          config.config,
        ),
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
      {
        testCommand: step === "implement" && Boolean(latest.noTestsReason),
        keepIndent: step === "implement",
      },
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
    // 文書作成の工程は、外部に直接作った・直したページ（成果物）の申告を取り出す（差し戻し・書き出しで同じページを使う）。
    // 申告は元の出力から読む（指摘への対応と同じ JSON に入っていると、extractBlocks がそのオブジェクトごと除くため。
    // PR #220 レビュー指摘）。原稿からは、残った申告の JSON だけを除く
    const documentPages =
      step === "document"
        ? {
            pages: extractDocumentPages(outcome.output).pages,
            output: extractDocumentPages(extracted.output).output,
          }
        : undefined;
    // 要求要件・設計は、最後のメッセージがそのまま成果物になる。文書の外に書かれた作業の報告は、sacty が取り除く（PBI-302 C1）
    const deliverable =
      step === "requirements" || step === "design"
        ? withoutWorkReport(extracted.output)
        : extracted.output;
    const output = review?.output ?? reproduction?.output ?? documentPages?.output ?? deliverable;
    const events: { actor: Actor; event: EventInput }[] = [
      ...(handedOverKeys.length > 0
        ? [
            {
              actor: "sacty" as const,
              event: {
                type: "ContinuedFeedbackPassed" as const,
                payload: { runId, keys: handedOverKeys },
              },
            },
          ]
        : []),
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
            // 実装の工程が、最後の変更の後に実行した検証の記録（PBI-305）
            ...(step === "implement" && extracted.verificationRecord
              ? { verificationRecord: extracted.verificationRecord }
              : {}),
            // 提出の前のセルフレビューの報告（PBI-120）。させた工程で報告が無い・読めなければ null（記録なし）
            ...((SELF_REVIEW_STEPS as readonly StepKey[]).includes(step)
              ? { selfReview: extracted.selfReview ?? null }
              : {}),
            // 出典の分類。分類させた工程で答えが無い・読めなければ null（記録なし）
            ...(provenanceStep && inputs
              ? {
                  provenance:
                    checkProvenance(
                      extracted.provenance,
                      inputs,
                      provenanceIds(provenanceStep, deliverable, testViewpoints),
                      provenanceStep === "design"
                        ? viewpointRename(extracted.viewpointPositions)
                        : undefined,
                    ) ?? null,
                }
              : {}),
            // テストの仕組みが無いタスクで、実装がテストの仕組みを用意したときだけ、そのコマンドを使う（PBI-94）
            ...(step === "implement" && latest.noTestsReason && testCommand ? { testCommand } : {}),
            ...(review ? { reviewComments: review.comments } : {}),
            ...(review?.verdict ? { reviewVerdict: review.verdict } : {}),
            ...(review?.rework ? { reviewRework: review.rework } : {}),
            ...(reproduction ? { reproductionTests: reproduction.tests } : {}),
            ...(documentPages && documentPages.pages.length > 0
              ? { documentPages: documentPages.pages }
              : {}),
          },
        },
      },
    ];
    if (!proposal) {
      // 実行の完了と提出は、同じトランザクションで記録する。再現の工程は、エージェントが確かめた結果も一緒に記録する（PBI-29）
      const submitted = this.append(task, [
        ...events,
        ...this.submitEvents(latest, step),
        ...(reproduction
          ? [
              {
                actor: "sacty" as const,
                event: {
                  type: "ReproductionChecked" as const,
                  payload: reproductionChecked(reproduction.tests, reproduction.check),
                },
              },
            ]
          : []),
      ]);
      // PR で承認する工程（PBI-57）は、続けて成果を PR にしてから承認待ちにする（予算は、その後に判定する）
      const stepPr = this.awaitingStepPullRequest(submitted);
      if (stepPr) {
        await this.publishStepPullRequest(submitted, stepPr);
        this.checkBudget(this.mustGet(task.id));
        return;
      }
      this.checkBudget(submitted);
      return;
    }

    // 承認済みの成果物への変更の申し出は、AI の判定を挟まずに人が判断する（PBI-333）。申し出と人の判断待ちは同じ
    // トランザクションで記録する（間でデーモンが止まっても、判断待ちにならない申し出を残さないため）
    const proposalId = `CP-${latest.proposals.length + 1}`;
    events.push({
      actor: "agent",
      event: { type: "ChangeProposed", payload: { proposalId, fromStep: step, ...proposal } },
    });
    events.push({
      actor: "sacty",
      event: {
        type: "TaskEscalated",
        payload: {
          step,
          target: proposal.target,
          reason: "change_proposed",
          proposalId,
        },
      },
    });
    this.append(task, events);
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
    onlyMcp: string | undefined,
    /** その実行の役割（MCP の時間切れの警告を、その役割の実行の上限で判断する。PBI-150）。 */
    role: string,
  ): Promise<RunContext | undefined> {
    const contextSource = this.deps.projects.get(task.projectId)?.context;
    const defaultContext = this.deps.defaultContext;
    const { hostMcp = [], gatewayOrigin, hostCommands, runLimitMs } = this.mcpRouting(config, role);
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
        runLimitMs,
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
  private mcpRouting(
    config: Pick<SactyConfig, "hostMcp" | "runTimeouts"> | undefined,
    /** その実行の役割（MCP の時間切れの警告を、その役割の実行の上限で判断する。PBI-150）。 */
    role?: string,
    /** ゲートウェイの起点（既定はコンテナから見たもの。ローカルのセッションはホストから見たもの）。 */
    originOverride?: string,
  ): McpRouting {
    const runLimitMs = agentTimeoutMs(config?.runTimeouts, role);
    const gatewayForMcp = this.deps.gateway;
    if (!gatewayForMcp) return { runLimitMs };
    const origin = originOverride ?? gatewayForMcp.containerOrigin();
    return {
      runLimitMs,
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
    if (operation.via === "github") {
      // GitHub は、プロジェクトで gh のアカウントを選んだホストだけ（ゲートウェイが無ければ読めない）
      const hosts = this.deps.gateway ? this.githubRelayHosts(task.id) : {};
      if (!Object.hasOwn(hosts, operation.name.toLowerCase())) {
        pause(message("operation.connectionMissing"));
        return;
      }
    } else {
      const available = await this.exportDestinations(task, config);
      if (
        !available.destinations.some((d) => d.via === operation.via && d.name === operation.name)
      ) {
        pause(message("operation.connectionMissing"));
        return;
      }
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
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で実行する
    const agent = this.usableAgent(config, chosen.agent, task.id, step);
    const image = resolveImage(
      this.projectImagesConfig(config, task.projectId),
      stepImageOf(task, step),
    );
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
        context = await this.runContext(task, agent, config, usedSecrets, operation.name, step);
        if (!context?.placed.mcpServers.includes(operation.name))
          throw new MessageError(message("operation.connectionMissing"));
        // 用意したコンテキスト（層・注意・置いた段階）を、この実行の記録として残す（PBI-119）
        this.append(this.mustGet(task.id), [
          this.contextResolved(runId, context, { platforms: [], warnings: [] }),
        ]);
      } else if (operation.via === "platform") {
        platform = await this.findPlatform(task, config, operation.name, usedSecrets);
        if (!platform) throw new MessageError(message("operation.connectionMissing"));
      }
      const latest = this.mustGet(task.id);
      if (latest.status !== "queued" || this.stopRequested(task.id)) return;
      // 準備（接続先・コンテキストの用意）の間に人がエージェントを変えたなら、古いエージェントでは始めない。実行待ちのまま
      // 戻し、次の実行で新しいエージェントで準備し直す（PR #131 レビュー指摘）
      if (latest.agents?.[step] !== chosenName) return;
      // 準備の間に人がイメージを変えたなら、エージェントと同じく、実行待ちのまま戻し、次の実行で最新の設定から決め直す
      // （その間に config.yaml に足した名前を、この実行が読んだ設定で解決して止めない。PR #322 レビュー指摘）
      const runImageName = stepImageOf(latest, step);
      if (runImageName !== stepImageOf(task, step)) return;
      // 使う名前（準備の前に確かめたもの）を実行の記録に残す（PBI-318。画面が、どのイメージで動いたかを出す）
      mkdirSync(workspaceDir, { recursive: true });
      // 実行前に永続化する。結果が失われても再送しない。
      this.append(latest, [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: {
              runId,
              step,
              agentId: agent.id,
              ...agentSetting(agent),
              image: runImageName ?? DEFAULT_IMAGE_NAME,
            },
          },
        },
      ]);
      attempted = true;
      const { outcome, costUsd, estimated, costUnknown } = await this.execute({
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
                    ...unknownCost({ costUnknown }),
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
      if (!preserveWorkspace) await rm(workspaceDir, { recursive: true, force: true });
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
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で書き出す
    const agent = this.usableAgent(
      config,
      chosen.ok ? chosen.agent : agentFor(config, step),
      task.id,
      "export",
    );
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
        context = await this.runContext(task, agent, config, usedSecrets, to.name, "export");
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
      await rm(workspaceDir, { recursive: true, force: true });
    }
    const { outcome, costUsd, estimated } = executed;
    const cost = {
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      costUsd,
      estimated,
      ...unknownCost(executed),
    };
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
   * オーケストレーターの「テストの仕組みが無い」という判断（PBI-94）を確かめる。判断が無い・テストのコマンドがある・
   * 実装を含まない組み合わせなら確かめない。不具合の修正を選んだ（再現はテストで確かめる）・起点のコードにテストのファイルが
   * 見つかった・確かめきれなかったなら、判断を使えない理由を返す（黙ってテストなしとして扱わないための歯止め）。
   */
  private checkNoTests(task: Task, chosen: ChosenSteps): { stop?: DaemonText } {
    const reason = chosen.noTestsReason;
    if (!reason || chosen.testCommand || !chosen.steps.includes("implement")) return {};
    if (chosen.steps.includes("reproduce")) {
      return { stop: message("orchestrator.bugfixNeedsTests", { reason }) };
    }
    // 文書だけの依頼（PBI-284）は、テストのファイルがあっても、テストなしで進めてよい（ここでテストのファイルを探さない）
    if (chosen.documentsOnly) return {};
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
    // 既存の PR を引き継ぐタスクは、要求要件・設計を PR にしない（引き継いだ PR に成果のファイルを混ぜない。画面で承認する）
    if (task.continuedPullRequest) return false;
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
        // 題は、コミットの日時（成果を出した時刻）のときの題にする（再試行で同じコミットにする。PBI-323）
        message: `${await this.commitSubjectFor(current, "docs", buildStepPullRequestTitle({ ...current, title: this.titleAt(current, this.outputAt(current, step)) }, step))}\n\nsacty task ${current.id}`,
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
      // 更新する head に、sacty の AI のレビューが付いているか（PR の本文に書く。PBI-302 D1）
      const aiReview = aiReviewFor(
        { repo, number: reuse?.number, head: commit },
        task.id,
        this.tasks.values(),
        sameRepo,
      );
      const { body, template } = await this.pullRequestBody(
        repo,
        token,
        usedSecrets,
        // 待つ間に人が変えた題で書く（テンプレートを読んだ後に作る。PBI-323）
        () => buildStepPullRequestBodyText(this.latestTitled(current), step, path, aiReview),
        () => buildStepPullRequestBodyParts(this.latestTitled(current), step, path, aiReview),
      );
      // 同じ PR を更新するときは、人が直した本文を3方向でマージして残す（PBI-334）
      const sent = reuse
        ? await this.reconcilePullRequestBody(current, {
            repo,
            token,
            number: reuse.number,
            generated: body,
          })
        : { body, record: true };
      // 本文をまとめる間に一時停止・中止を求められた・まとめたコンテナが止まったか確かめられなかったら、PR を更新しない
      // （同じ PR がすでにあるので、作った PR を記録し損ねることはない。再開すると、ここからやり直す）
      if (reuse && ("stop" in sent || this.stopRequested(task.id))) return;
      const pr = await this.deps.pulls.upsert({
        repo,
        token,
        branch,
        baseBranch: taskBranch.branch,
        // 作るときだけ使う（すでにある PR の題は変えない）。待つ間に人が変えた題にする（PBI-323）
        title: buildStepPullRequestTitle(this.latestTitled(current), step),
        body: sent.body,
        ...(reuse ? { number: reuse.number } : {}),
      });
      if (sent.record && !pr.existing) this.recordPullRequestBody(task.id, repo, pr.number, body);
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
      // PR をレビューする子タスクを作る（同じ PR を更新したときは、もう作らない。PBI-330）
      this.ensureReviewTask(submitted, step, repo, pr.number, pr.url);
    } catch (error) {
      fail(message("pr.failed", { detail: errorText(error) }));
    }
  }

  /**
   * PR の本文（PBI-87）。PR を作るリポジトリ（無ければ Org の .github リポジトリ）に PR テンプレートがあれば、その
   * 見出し・項目の形に沿って sacty の内容で埋める。無い・読めない・使えないときは、sacty の決まった形の本文にする
   * （PR の作成は止めない）。どちらにしたかを template として返す（台帳に残す）。本文は長さの上限に収め、
   * 使った秘密の値を伏せる。本文の材料（fallback・parts）は、テンプレートを読んだ後に作る（待つ間に人が変えた題を
   * 使うため。PBI-323）。
   */
  private async pullRequestBody(
    repo: string,
    token: string,
    usedSecrets: readonly string[],
    makeFallback: () => BodyText,
    makeParts: () => BodyParts,
  ): Promise<{ body: string; template: PullRequestTemplateUse }> {
    let template: PullRequestTemplateUse;
    let found: TemplateLookup | undefined;
    let failed: unknown;
    try {
      found = this.deps.templates
        ? await this.deps.templates.find({ repo, token })
        : { kind: "none" };
    } catch (error) {
      failed = error;
    }
    const fallback = makeFallback();
    // テンプレートが無い・使えないときも、省けない部分（タスクの ID・Closes・承認の案内）を分けて持つ（PR #99 レビュー指摘）
    let text = fallback;
    try {
      if (!found) throw failed;
      if (found.kind === "found") {
        text = fillTemplate(found.template.text, makeParts());
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
   * すでにある PR を更新するときの本文（PBI-334）。sacty が前回組み立てた本文（`pullRequestBodies`）を共通の祖先にして、
   * GitHub の今の本文（人が補足・整形したもの）と、今回組み立てた本文（generated）を3方向でマージする。
   * - 前回の記録が無い（PBI-334 より前に書いた本文）・今の本文を読めないときは、これまでどおり generated にする
   * - 人が直していない・重ならずにマージできたら、その結果にする
   * - 同じ箇所で重なった（長さの上限を超えた）ら、オーケストレーターのエージェントにまとめさせ、PullRequestBodyResolved を記録する。
   *   まとめられなければ（予算の上限・実行の失敗・答えを読めない・まとめる間に人が本文をまた直した）、本文に触れない
   *   （body が undefined。読んだ時点の古い本文を書き戻さない）。agent が false なら（タスクの実行の外の、向き先の付け替え）、
   *   エージェントを実行せずに本文に触れない（次のやり直しの提出で、もう一度まとめる）
   * record は、更新した後に generated を前回の版として記録するか（本文に触れなかったときは記録しない。次の更新で、もう一度
   * 今回の sacty の更新を取り込むため）。
   */
  private async reconcilePullRequestBody(
    task: Task,
    input: { repo: string; token: string; number: number; generated: string; agent?: boolean },
  ): Promise<{ body?: string; record: boolean; stop?: true }> {
    const generated = input.generated;
    const base = task.pullRequestBodies?.[pullRequestBodyKey(input.repo, input.number)];
    if (base === undefined) return { body: generated, record: true };
    const read = () =>
      this.deps.pulls.pullRequestBody({
        repo: input.repo,
        token: input.token,
        number: input.number,
      });
    let human: string;
    try {
      human = await read();
    } catch (error) {
      console.warn(
        `[daemon] PR #${input.number}（${input.repo}）の今の本文を読めないため、sacty の本文で更新します：${renderMessage(errorText(error), "ja")}`,
      );
      return { body: generated, record: true };
    }
    let merged: Awaited<ReturnType<typeof mergePullRequestBody>>;
    try {
      merged = await mergePullRequestBody({ base, human, generated });
    } catch (error) {
      // 本文に触れず、理由を作業履歴に残す（画面で、本文に今回の内容が入らなかったことが分かるように）
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "PullRequestBodyResolved",
            payload: {
              repo: input.repo,
              number: input.number,
              outcome: "kept",
              reason: message("pr.bodyMergeError", { detail: errorText(error) }),
            },
          },
        },
      ]);
      return { record: false };
    }
    if (merged.conflicts === 0 && merged.text.length <= PR_BODY_MAX) {
      return { body: merged.text, record: true };
    }
    // 重なった箇所は、エージェントにまとめさせる
    const kept = (reason: DaemonText, cost: Record<string, unknown> = {}) => {
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "PullRequestBodyResolved",
            payload: { repo: input.repo, number: input.number, outcome: "kept", reason, ...cost },
          },
        },
      ]);
      return { record: false };
    };
    if (input.agent === false) return kept(message("pr.bodyMergeDeferred"));
    const config = this.deps.config();
    if (!config.ok) return kept(message("pr.bodyMergeUnavailable", { detail: config.problem }));
    if (budgetState(this.mustGet(task.id).budget) === "exceeded") {
      return kept(message("pr.bodyMergeBudget"));
    }
    const ran = await this.runOrchestrator(this.mustGet(task.id), config.config, () =>
      buildPullRequestBodyMergePrompt({
        taskId: task.id,
        number: input.number,
        base,
        human,
        generated,
        merged: merged.text,
        maxLength: PR_BODY_MAX,
      }),
    );
    if ("failure" in ran) {
      const { reason: _reason, message: detail, ...cost } = ran.failure;
      const result = kept(message("pr.bodyMergeFailed", { detail }), cost);
      // コンテナが止まったことを確かめられなかった実行（元のコンテナが動いたままかもしれない）なら、ほかの実行と重ならないように
      // PR を更新せずに一時停止する（再開・中止のときに、止まったことを確かめる。工程の見直しと同じ）
      const runId = ran.failure.runId;
      if (runId && this.unconfirmedRuns.delete(runId)) {
        this.append(this.mustGet(task.id), [
          {
            actor: "sacty",
            event: {
              type: "TaskPaused",
              // 止まったことを確かめられなかった実行を記録する（再開・中止の前に、残ったコンテナを確かめ直す）
              payload: {
                reason: ran.failure.reason,
                message: ran.failure.message,
                unstoppedRuns: [runId],
              },
            },
          },
        ]);
        return { ...result, stop: true };
      }
      return result;
    }
    const body = extractMergedPullRequestBody(ran.output, PR_BODY_MAX);
    if (!body) return kept(message("orchestrator.unreadable"), ran.cost);
    // まとめる間に人が本文をまた直していたら、その直しを含まない本文で上書きしない（次の更新で、もう一度まとめる）
    let now: string | undefined;
    try {
      now = await read();
    } catch {
      now = undefined;
    }
    if (now === undefined || normalizeNewlines(now) !== normalizeNewlines(human)) {
      return kept(message("pr.bodyEditedDuringMerge"), ran.cost);
    }
    this.append(this.mustGet(task.id), [
      {
        actor: "orchestrator",
        event: {
          type: "PullRequestBodyResolved",
          payload: { repo: input.repo, number: input.number, outcome: "resolved", ...ran.cost },
        },
      },
    ]);
    return { body, record: true };
  }

  /** sacty が組み立てた本文を、前回の版として記録する（PBI-334。PR を作った・更新した後）。 */
  private recordPullRequestBody(taskId: string, repo: string, number: number, body: string): void {
    const latest = this.tasks.get(taskId);
    if (!latest || latest.pullRequestBodies?.[pullRequestBodyKey(repo, number)] === body) return;
    this.append(latest, [
      {
        actor: "sacty",
        event: { type: "PullRequestBodyWritten", payload: { repo, number, body } },
      },
    ]);
  }

  /**
   * 実装の PR を、PR のレビューの子タスクの指摘なしまでドラフトにして待つか（PBI-331）。sacty が作る PR だけ（引き継いだ
   * 人の PR は、人の PR なのでドラフトにしない）。ServiceDeps の draftPullRequests を false にしたテストでは待たない。
   */
  private awaitsReview(task: Task): boolean {
    return this.deps.draftPullRequests !== false && !task.continuedPullRequest && !!task.repository;
  }

  /**
   * 実装を、実装の工程の中でコミットして sacty のブランチにプッシュし、PRを作る（PBI-110）。コミットは、エージェントが
   * 触れない退避した git のメタデータで作る。失敗したら理由を記録して止める（再開するとやり直す）。PR は、PR のレビューの
   * 子タスクの指摘なしまでドラフトのまま、実装の承認待ちで止め、レビュー用のラベルを付ける（PBI-331）。
   */
  private async publish(task: Task, config: SactyConfig): Promise<"published" | "stopped"> {
    const target = this.targetRepository(task, config);
    const dir = this.repoDir(task);
    const gitDir = this.trustedGitDir(task);
    const usedSecrets: string[] = [];
    const fail = (text: DaemonText): "stopped" => {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: { reason: "error", message: redactText(text, usedSecrets) },
          },
        },
      ]);
      return "stopped";
    };
    if (!target.ok) return fail(message("pr.unavailable", { detail: target.message }));
    if (!task.repository || !existsSync(dir) || !existsSync(gitDir)) {
      return fail(message("pr.workspaceMissing"));
    }
    const repo = target.repo;
    // 実装の作り直しの間に、人が前の PR をマージしていたら、プッシュも PR の作成もせず、マージを承認として進める
    // （新しい PR を作らない。PBI-276。マージの確認は 60 秒ごとなので、確認の前に PR の更新が始まることがある。
    // 引き継いだ既存の PR も同じ）
    // （引き継いだ PR は、初めて提出するまで task.pullRequest が無いので、引き継いだ PR を見る）
    const earlier = task.pullRequest ?? task.continuedPullRequest;
    if (earlier?.number && earlier.repo) {
      try {
        const earlierToken = await this.githubToken(task, earlier.repo, usedSecrets);
        const now = await this.deps.pulls.status({
          repo: earlier.repo,
          token: earlierToken,
          number: earlier.number,
        });
        if (
          now.state === "merged" &&
          this.endReworkByMerge(task.id, earlier.number, now, { stoppedRuns: [] })
        ) {
          return "stopped";
        }
      } catch (error) {
        return fail(message("pr.failed", { detail: errorText(error) }));
      }
    }
    // 既存の PR を引き継ぐタスクは、その PR の元のブランチに実装を積み、新しい PR を作らない
    const continued = task.continuedPullRequest;
    if (continued) {
      await this.publishContinued(task, continued, fail, usedSecrets);
      return "published";
    }
    // タスクブランチのあるタスク（PBI-57）は、タスクブランチに実装を積み、タスクブランチからベースブランチへの PR にする
    const taskBranch = task.taskBranch;
    const branch = taskBranch?.branch ?? task.pullRequest?.branch ?? taskBranchName(task);
    // 一時停止・中止を求められていれば、プッシュも PR の作成もしない（一時停止は、PR の作成の待ちのまま止める。再開すると作る）
    if (this.stopRequested(task.id)) return "stopped";
    // PR を出す直前にも、人が PR のブランチに足したコミットを取り込む（PBI-334。PR を出す前の取り込みの後に足されたもの）。
    // 競合したら、PR を出さずに実装をやり直す（PR の作成の待ちなら、PullRequestHeadMerged の投影がやり直しに戻す）
    const waitingPublish = task.publishPending === true;
    const head = await this.syncPullRequestHead(task);
    if (head.kind === "failed") return fail(head.message);
    if (head.kind === "conflicts") {
      // 新しく競合したなら、PullRequestHeadMerged の投影が実装のやり直しに戻した
      if (waitingPublish && head.fresh) return "stopped";
      // 前の取り込みの目印が残っているなら、目印のある内容をプッシュせずに止める
      return fail(message("pr.headConflicted", { branch: task.pushedBranch?.branch ?? branch }));
    }
    // 先頭を読む間に一時停止・中止を求められたら、プッシュしない
    if (this.stopRequested(task.id)) return "stopped";
    task = this.mustGet(task.id);
    // 取り込みで競合した目印が残っていれば、目印のある内容をプッシュしない
    const unresolved = pendingHeadMerge(task)?.conflicts ?? [];
    if (unresolved.length > 0) {
      try {
        if ((await this.deps.repos.conflictMarkers(dir, unresolved)).length > 0) {
          return fail(
            message("pr.headConflicted", { branch: task.pushedBranch?.branch ?? branch }),
          );
        }
      } catch (error) {
        return fail(message("pr.failed", { detail: errorText(error) }));
      }
    }
    const repositoryNow = task.repository;
    if (!repositoryNow) return fail(message("pr.workspaceMissing"));
    try {
      const authEnv = await this.gitAuth(task, repositoryNow.url, usedSecrets);
      // 人が PR のブランチに足したコミットを取り込んでいれば、その先頭に積む（PBI-334。強制プッシュしない）
      let parent =
        pendingHeadMerge(task)?.commit ?? task.pullRequest?.commit ?? repositoryNow.baseCommit;
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
            ? (pendingHeadMerge(task)?.commit ?? task.pushedBranch.commit)
            : repositoryNow.baseCommit;
        if (known !== parent) {
          const unexpected = (await this.deps.repos.changedPaths(gitDir, known, parent)).filter(
            (p) => !paths.includes(p),
          );
          if (unexpected.length > 0) {
            return fail(
              message("pr.taskBranchChanged", {
                branch: taskBranch.branch,
                paths: unexpected.slice(0, 10).join(", "),
                count: unexpected.length,
              }),
            );
          }
        }
      }
      // 実装の工程が終わったときにする（PBI-331）
      const date = this.outputAt(task, "implement");
      // 認証・タスクブランチの取得などを待つ間に一時停止・中止を求められたら、プッシュしない（プッシュの直前に確かめる）
      if (this.stopRequested(task.id)) return "stopped";
      const { commit } = await this.deps.repos.publish({
        dir,
        gitDir,
        // ベースブランチの最新を取り込んでいれば、作業領域はそのコミットに実装の変更を加えたもの。コミットは、そのコミットを
        // 第2の親にしたマージコミットにする（まだ parent の履歴に含まれていなければ）
        baseCommit: workBaseCommit(repositoryNow, task.baseMerge),
        ...(task.baseMerge ? { merge: task.baseMerge.commit } : {}),
        parent,
        branch,
        // 題は、コミットの日時のときの題にする（同じ提出の再試行で、題を変えても同じコミットにする。PBI-323）
        message: `${await this.commitSubjectFor(task, this.implementCommitKind(task), this.titleAt(task, date))}\n\nsacty task ${task.id}`,
        // 提出ごとに決まる日時にして、再開しても同じコミットを作る（プッシュ済みなら何も変わらない）
        date,
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
        if (previous.state === "merged") {
          // プッシュの間にマージされた（PBI-276）：新しい PR は作らず、マージを承認として進める
          if (this.endReworkByMerge(task.id, number, previous, { stoppedRuns: [] })) {
            return "stopped";
          }
          number = undefined;
        }
      }
      // 更新する head に、sacty の AI のレビューが付いているか（PR の本文に書く。PBI-302 D1）
      const aiReview = aiReviewFor(
        { repo: prRepo, number, head: commit },
        task.id,
        this.tasks.values(),
        sameRepo,
      );
      // 依存先の PR に重ねた子タスク（PBI-317）は、PR の向き先を依存先の PR のブランチにし、本文にどの PR に重ねたかを書く。
      // 重ねている間は、検証に通った後もドラフトのままにする（依存先より先にマージさせない）
      const stackedOn = this.stackedPullRequest(task);
      const stacked = this.recordsPullRequestBase(task);
      // PR のレビューの子タスクが指摘なしにするまでドラフトにする（PBI-331）
      const awaitsReview = this.awaitsReview(task);
      // 本文の「sacty のタスク「…」」は、待つ間に人が変えた題にする（テンプレートを読んだ後に作る。PBI-323）
      const { body, template } = await this.pullRequestBody(
        prRepo,
        token,
        usedSecrets,
        () =>
          buildPullRequestBodyText(this.latestTitled(task), {
            secrets: usedSecrets,
            aiReview,
            ...(stackedOn ? { stackedOn } : {}),
          }),
        () =>
          buildPullRequestBodyParts(this.latestTitled(task), {
            secrets: usedSecrets,
            aiReview,
            ...(stackedOn ? { stackedOn } : {}),
          }),
      );
      // PR を作る直前にも確かめる（プッシュしたブランチは記録済みなので、中止で片付けられる）。PR を作り始めたら、作り終えて
      // 記録する（作った PR を記録しないまま止めると、再開で PR を二重に作りうるため）。検証に通った後なら、そのときの
      // 一時停止は、承認待ちになったので止めなかったと返す（pause の pause.reachedApproval）
      if (this.stopRequested(task.id)) return "stopped";
      // 同じ PR を更新するときは、人が直した本文を3方向でマージして残す（PBI-334）
      const sent = number
        ? await this.reconcilePullRequestBody(task, {
            repo: prRepo,
            token,
            number,
            generated: body,
          })
        : { body, record: true };
      if ("stop" in sent || this.stopRequested(task.id)) return "stopped";
      const pr = await this.deps.pulls.upsert({
        repo: prRepo,
        token,
        branch,
        baseBranch: repositoryNow.baseBranch,
        // 作るときだけ使う（すでにある PR の題は変えない）。待つ間に人が変えた題にする（PBI-323）
        title: this.latestTitled(task).title,
        body: sent.body,
        number,
        ...(awaitsReview || task.stack ? { draft: true } : {}),
        // 重ねている間は、ドラフトを使えないリポジトリでも、ドラフトでない PR にしない（PBI-317）
        ...(task.stack ? { requireDraft: true } : {}),
        ...(stacked ? { retarget: true } : {}),
      });
      if (sent.record && !pr.existing) {
        this.recordPullRequestBody(task.id, prRepo, pr.number, body);
      }
      let draft = pr.draft;
      let draftError: unknown;
      const baseRecord = stacked ? { baseBranch: repositoryNow.baseBranch } : {};
      if (awaitsReview || task.stack) {
        // 前の提出でドラフトを外した PR を更新した（PR の指摘で実装をやり直した）なら、ドラフトに戻す。戻せなく
        // ても（リポジトリがドラフトを使えないなど）、PR の作成は失敗にしない。依存先の PR に重ねている間は、検証に通った後も
        // ドラフトにする（PBI-317。作った PR がドラフトでなかったときも）
        if ((number || task.stack) && !draft) {
          draft = await this.setDraftWithin(task.id, {
            repo: prRepo,
            token,
            number: pr.number,
            draft: true,
          })
            .then((r) => r.draft)
            .catch((error: unknown) => {
              draftError = error;
              console.warn(
                `[daemon] PR #${pr.number}（${prRepo}）をドラフトに戻せませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
              );
              return false;
            });
        }
      }
      // 依存先の PR に重ねている間は、ドラフトにできなければ、記録せずに止める（ドラフトでない重ねた PR で承認待ちにすると、
      // 依存先より先にマージされうる。再開すると、ここからやり直す。PBI-317）
      if (task.stack && !draft) {
        return fail(
          message("pr.stackDraftFailed", {
            detail:
              draftError === undefined
                ? message("pr.notDraft", { number: pr.number })
                : errorText(draftError),
          }),
        );
      }
      // レビューへ進める（検証に通った・人がレビューへ進めた）ので、ドラフトを外す。外せない・今の状態を確かめられなければ、
      // 承認待ちにせずに止める（再開すると、ここからやり直す）。ドラフトかは、台帳や PR の更新の答えではなく、外す前に
      // GitHub の今の PR を読んで決める（ドラフトに戻した答え・更新の答えを受け取れなかったときも外すため）。すでに
      // 外れていれば（人が外した・ドラフトを使えないリポジトリ）何もしない
      // 依存先の PR に重ねている間は、ドラフトのまま承認待ちにする（依存先がマージされたら、向き先を付け替えて外す。PBI-317）
      // sacty が作る PR は、ドラフトのまま承認待ちにし、PR のレビューの子タスクの指摘なしで外す（PBI-331）
      if (!task.stack && !awaitsReview) {
        try {
          await this.deps.pulls.setDraft({ repo: prRepo, token, number: pr.number, draft: false });
        } catch (error) {
          return fail(message("pr.readyFailed", { detail: errorText(error) }));
        }
      }
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
              ...((task.stack || awaitsReview) && draft ? { draft: true as const } : {}),
              ...(awaitsReview ? { awaitingReview: true as const } : {}),
              ...baseRecord,
            },
          },
        },
        this.implementSubmitted(task),
      ]);
      this.checkBudget(submitted);
      // PR をレビューする子タスクを作る（作れなくても PR の作成は失敗にしない。PBI-330）
      this.ensureReviewTask(submitted, "implement", prRepo, pr.number, pr.url);
      return "published";
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
        return "published";
      }
      return fail(message("pr.failed", { detail: errorText(error) }));
    }
  }

  /**
   * 既存の PR を引き継ぐタスクの、検証に通った実装を PR の元のブランチに積む。起点（PR の先頭）か前にプッシュしたコミットに
   * 積み、強制プッシュはしない（人が PR のブランチを進めていたら、止めて人が判断する）。PR の題・本文は変えず、レビュー用の
   * ラベルも付けない（人が作った PR なので）。PR が開いていれば、その PR を実装の PR として記録し、実装の承認待ち（PR の
   * マージ）にする。
   */
  private async publishContinued(
    task: Task,
    continued: ContinuedPullRequest,
    fail: (text: DaemonText) => void,
    usedSecrets: string[],
  ): Promise<void> {
    if (!task.repository) return;
    const dir = this.repoDir(task);
    const gitDir = this.trustedGitDir(task);
    const branch = continued.branch;
    const parent = task.pullRequest?.commit ?? task.repository.baseCommit;
    // 一時停止・中止を求められていれば、プッシュしない（一時停止は、PR の作成の待ちのまま止める。再開すると積む）
    if (this.stopRequested(task.id)) return;
    try {
      const authEnv = await this.gitAuth(task, task.repository.url, usedSecrets);
      // 提出ごとに決まる日時にして、再開しても同じコミットを作る（プッシュ済みなら何も変わらない）。実装の工程が終わった
      // ときにする（PBI-331）
      const date = this.outputAt(task, "implement");
      // 題は、コミットの日時のときの題にする（同じ提出の再試行で、題を変えても同じコミットにする。PBI-323）
      const subject = await this.commitSubjectFor(
        task,
        this.implementCommitKind(task),
        this.titleAt(task, date),
      );
      const push = () =>
        this.deps.repos.publish({
          dir,
          gitDir,
          baseCommit: task.repository?.baseCommit ?? parent,
          parent,
          branch,
          message: `${subject}\n\nsacty task ${task.id}`,
          date,
          authEnv,
        });
      let commit: string;
      // 認証を待つ間に一時停止・中止を求められていれば、人のブランチにプッシュしない（一時停止は、PR の作成の待ちのまま）
      if (this.stopRequested(task.id)) return;
      try {
        ({ commit } = await push());
      } catch (error) {
        if (error instanceof NothingToCommitError) throw error;
        const head = await this.deps.repos
          .fetchBranch(gitDir, branch, authEnv)
          .catch(() => undefined);
        if (!head || head === parent || head === task.pushedBranch?.commit) throw error;
        if (this.stopRequested(task.id)) return;
        // ブランチの先頭が、起点とも前にプッシュしたコミットとも違う。プッシュはできていて応答だけを受け取れなかったなら、
        // 先頭はこの提出のコミット（同じ内容・日時で作り直すと同じコミットになる）なので、もう一度プッシュすると何も変わらずに
        // 通る。通らなければ、人が PR のブランチを進めたとして、そうはっきり示す
        try {
          ({ commit } = await push());
        } catch {
          fail(message("pr.continuedBranchMoved", { branch, number: continued.number }));
          return;
        }
      }
      if (task.pushedBranch?.commit !== commit || task.pushedBranch.branch !== branch) {
        this.append(task, [
          { actor: "sacty", event: { type: "BranchPushed", payload: { branch, commit } } },
        ]);
      }
      const token = await this.githubToken(task, continued.repo, usedSecrets);
      const now = await this.deps.pulls.status({
        repo: continued.repo,
        token,
        number: continued.number,
      });
      // プッシュの間にマージされた（PBI-276）：マージを承認として進める
      if (
        now.state === "merged" &&
        this.endReworkByMerge(task.id, continued.number, now, { stoppedRuns: [] })
      ) {
        return;
      }
      if (now.state !== "open") {
        fail(message("pr.continuedNotOpen", { number: continued.number }));
        return;
      }
      if (this.stopRequested(task.id)) return;
      const submitted = this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "PullRequestPublished",
            payload: {
              branch,
              commit,
              url: continued.url,
              number: continued.number,
              repo: continued.repo,
            },
          },
        },
        this.implementSubmitted(task),
      ]);
      this.checkBudget(submitted);
    } catch (error) {
      // 実装が起点（PR の先頭）から何も変えていなかった（PBI-90）。まだ積んでいなければ、実装の承認で人間に確かめてもらう
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
   * sacty が作った PR（要求要件・設計・実装の PR）をレビューする子タスクを作る（PBI-330）。PR を作った工程とは別の
   * コンテキストで、PR のレビューだけのタスク（source.review: sacty）としてレビューさせ、指摘は PR の指摘の取り込みで親に
   * 届ける。1つの PR につき1つ（作った記録のある PR には、更新しても作らない）。
   * - 子タスクを作った後、親に記録する前に止まった（停止・クラッシュ）ときは、作った子タスクを見つけて記録だけ足す
   * - ほかのレビューのタスク（以前の版でラベルから取り込んだものなど）が終わらずにあれば、二重に作らない
   * - 作れなくても、PR の作成・承認待ちは失敗にしない（次の PR の確認で作り直す）
   */
  private ensureReviewTask(
    parent: Task,
    step: "requirements" | "design" | "implement",
    repo: string,
    number: number,
    url: string | undefined,
  ): void {
    const same = (r: string | undefined, n: number | undefined) =>
      n === number && r !== undefined && sameRepo(r, repo);
    if (this.deps.reviewTasks !== true) return;
    try {
      if (parent.status === "cancelled" || this.cancelling.has(parent.id)) return;
      // 依存先に重ねた実装の PR は、依存先がマージされて向き先を付け替えるまでレビューしない。ドラフトのままレビューし、
      // 指摘なしで外す（PBI-331）。指摘なしを待たない PR（以前の版の記録など）は、ドラフトを外したとき（付け替えの後）に作る
      const pr = parent.pullRequest;
      if (step === "implement" && pr?.number === number) {
        const retargeted =
          !pr.baseBranch ||
          !parent.repository?.baseBranch ||
          pr.baseBranch === parent.repository.baseBranch;
        if (pr.awaitingReview ? parent.stack || !retargeted : pr.draft) return;
      }
      if (!this.needsReviewTask(parent, repo, number)) return;
      const recorded = new Set((parent.reviewTasks ?? []).map((x) => x.taskId));
      const reviews = [...this.tasks.values()].filter(
        (t) =>
          t.source?.kind === "github_pull_request" &&
          t.source.review !== undefined &&
          same(t.source.repo, t.source.number),
      );
      // 作ったが親に記録する前に止まった子タスク
      const mine = reviews.findLast(
        (t) => t.reviewOf?.taskId === parent.id && !recorded.has(t.id) && t.status !== "cancelled",
      );
      let childId = mine?.id;
      if (!childId) {
        // 以前の版でラベルから取り込んだレビューのタスクが、まだ終わっていなければ任せる
        if (reviews.some((t) => t.status !== "cancelled" && !isCompleted(t))) return;
        const config = this.deps.config();
        const child = this.append({ id: randomUUID(), projectId: parent.projectId }, [
          {
            actor: "sacty",
            event: {
              type: "TaskCreated",
              payload: {
                title: reviewTaskTitle(parent.title, number),
                body: "",
                start: "github_pull_request",
                budgetCapUsd: config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD,
                source: {
                  kind: "github_pull_request",
                  repo,
                  number,
                  url: url ?? `${repo.replace(/\.git$|\/$/g, "")}/pull/${number}`,
                  review: "sacty",
                },
                reviewOf: { taskId: parent.id, step },
              },
            },
          },
        ]);
        childId = child.id;
      }
      const latest = this.tasks.get(parent.id);
      if (!latest || !this.needsReviewTask(latest, repo, number)) return;
      this.append(latest, [
        {
          actor: "sacty",
          event: { type: "ReviewTaskCreated", payload: { taskId: childId, step, repo, number } },
        },
      ]);
    } catch (error) {
      console.warn(
        `[daemon] PR #${number}（${repo}）のレビューの子タスクを作れませんでした：${renderMessage(errorText(error), "ja")}`,
      );
    }
  }

  /**
   * その PR に、レビューの子タスクを（また）作るか。まだ無いか、最後の子タスクが PR のクローズで中止された（PR を開き直した。
   * 中止したタスクは再レビューできないので、新しい子タスクにする）とき（PBI-330）。
   */
  private needsReviewTask(parent: Task, repo: string, number: number): boolean {
    const last = (parent.reviewTasks ?? []).findLast(
      (x) => x.number === number && sameRepo(x.repo, repo),
    );
    if (!last) return true;
    const child = this.tasks.get(last.taskId);
    return child?.status === "cancelled" && child.cancelled?.reason === "pull_request_closed";
  }

  /**
   * PR の確認（60秒ごと）で、承認待ちの PR のレビューの子タスクを整える（PBI-330）。
   * - 子タスクの無い承認待ちの PR（作る前に止まったもの）には作る
   * - 親が PR を更新して承認待ちに戻った（指摘を直した）のに、子タスクが前の先頭をレビューして終わっていれば、最新の
   *   コミットを再レビューさせる。同じ先頭では1回だけ（先頭を読み違えても、繰り返さない）
   * 一時停止・中止を求められた親と子、一時停止した子は動かさない。
   */
  private async reconcileReviewTasks(): Promise<void> {
    if (this.deps.reviewTasks !== true) return;
    // 親が中止されたら、終わっていないレビューの子タスクも中止する（中止の片付けで PR を閉じなかったときも、レビューを続けない）
    for (const child of [...this.tasks.values()]) {
      if (!child.reviewOf || child.status === "cancelled" || isCompleted(child)) continue;
      if (this.cancelling.has(child.id)) continue;
      if (this.tasks.get(child.reviewOf.taskId)?.status !== "cancelled") continue;
      await this.cancel(child.id, "parent_cancelled").catch((error: unknown) => {
        console.warn(`[daemon] レビューの子タスク ${child.id} を中止できませんでした：`, error);
      });
    }
    // 指摘なしを待つ実装の PR の GitHub の先頭は、先に並べて読む（答えが返らない PR が続いても、1つずつ待たない）
    const heads = new Map<string, string | undefined>();
    const awaitingParents = [...this.tasks.values()].filter((parent) => {
      const gate = gatePullRequest(parent);
      return (
        parent.status === "awaiting_approval" &&
        gate?.state === "open" &&
        gate.repo !== undefined &&
        gate.step === "implement" &&
        parent.pullRequest?.awaitingReview === true
      );
    });
    await inParallel(awaitingParents, DRAFT_CHECK_CONCURRENCY, async (parent) => {
      const gate = gatePullRequest(parent);
      if (!gate?.repo) return;
      heads.set(
        `${parent.id}:${gate.number}`,
        await this.pullRequestHead(parent, gate.repo, gate.number),
      );
    });
    for (const parent of [...this.tasks.values()]) {
      if (parent.status !== "awaiting_approval" || this.cancelling.has(parent.id)) continue;
      if (this.pauseRequested.has(parent.id)) continue;
      const gate = gatePullRequest(parent);
      if (gate?.state !== "open" || !gate.repo) continue;
      if (gate.step !== "requirements" && gate.step !== "design" && gate.step !== "implement") {
        continue;
      }
      this.ensureReviewTask(parent, gate.step, gate.repo, gate.number, gate.url);
      const record = (this.tasks.get(parent.id)?.reviewTasks ?? []).findLast(
        (x) => x.number === gate.number && gate.repo !== undefined && sameRepo(x.repo, gate.repo),
      );
      const child = record && this.tasks.get(record.taskId);
      if (!child) continue;
      // 子タスクの指摘なしでドラフトを外す実装の PR（PBI-331）は、GitHub の今の先頭をレビューの対象にする（レビューの間に
      // 人がコミットを足しても、レビューしていない先頭のドラフトを外さない）。読めなければ、次の確認でやり直す
      const awaiting = gate.step === "implement" && parent.pullRequest?.awaitingReview === true;
      // 指摘なしでドラフトを外した後は、指摘なしにした先頭（人が足したコミットを含む）と比べる（同じ先頭を再レビューしない）
      const reviewed =
        gate.step === "implement" && parent.pullRequest?.number === gate.number
          ? parent.pullRequest.reviewedCommit
          : undefined;
      // 指摘なしで外した後に、人がコミットを足した（PR の確認で読んだ GitHub の先頭）なら、ドラフトかにかかわらず、その先頭を
      // 再レビューさせる（指摘なしになるまで、ドラフトにする。settleDraft）
      const seen = this.latestHeads.get(parent.id);
      const draftedAhead =
        !awaiting &&
        reviewed !== undefined &&
        seen?.number === gate.number &&
        seen.commit === gate.commit &&
        seen.head !== reviewed
          ? seen.head
          : undefined;
      const key = `${parent.id}:${gate.number}`;
      const target = awaiting
        ? heads.has(key)
          ? heads.get(key)
          : await this.pullRequestHead(parent, gate.repo, gate.number)
        : (draftedAhead ?? reviewed ?? gate.commit);
      if (!target) continue;
      const cleared = child.reviewTarget?.headCommit === target && reviewCleared(child);
      // 提出のときにドラフトに戻せなかった PR は、指摘なしになるまで、確認のたびにドラフトに戻す（レビューの途中も。レビュー
      // していないコミットをマージできるままにしない。PBI-331）
      if (awaiting && !cleared) await this.redraftAwaiting(parent, gate.repo, gate.number);
      if (!canRereview(child) || child.status === "paused") continue;
      if (this.cancelling.has(child.id) || this.pauseRequested.has(child.id)) continue;
      if (child.reviewTarget?.headCommit === target) {
        // 今の先頭を指摘なしにしたら、ドラフトを外す（PBI-331）
        if (awaiting && cleared) await this.markReady(parent, child, target);
        continue;
      }
      if (child.reviewRestartCommit === target) continue;
      try {
        this.append(child, [
          {
            actor: "sacty",
            event: {
              type: "ReviewRestarted",
              payload: { reason: "updated", commit: target },
            },
          },
        ]);
      } catch (error) {
        console.warn(
          `[daemon] レビューの子タスク ${child.id} を再レビューにできませんでした：${renderMessage(errorText(error), "ja")}`,
        );
      }
    }
  }

  /**
   * 指摘なしを待つ実装の PR を、ドラフトに戻す（PBI-331）。台帳の draft は、戻せなかった・外す要求が後から届いたなどで GitHub と
   * 違うことがあり、戻せなかったことの記憶（redraftPending）は再起動で消えるので、起動の後に1回は GitHub で戻す。戻せたら、同じ
   * 提出では繰り返さない（redrafted）。ただし、ドラフトを外した後に戻せなかった（redraftPending）・外す要求の答えを受け取れな
   * かった（undraftUnsettled）ときは、確認のたびに戻す。戻せなければ、次の確認でやり直す。
   */
  private async redraftAwaiting(parent: Task, repo: string, number: number): Promise<void> {
    // 先頭を読む間に変わっていれば、今の記録で判断する
    const task = this.tasks.get(parent.id);
    const pr = task?.pullRequest;
    if (task?.status !== "awaiting_approval" || this.cancelling.has(task.id)) return;
    if (!pr?.awaitingReview || pr.number !== number) return;
    const key = `${task.id}:${pr.commit}`;
    const again = this.redraftPending.has(key) || this.undraftUnsettled.has(`${task.id}:${number}`);
    if (!again && this.redrafted.has(key)) return;
    if (this.readying.has(task.id)) return;
    const usedSecrets: string[] = [];
    try {
      const token = await this.githubToken(task, repo, usedSecrets);
      const result = await this.setDraftWithin(task.id, { repo, token, number, draft: true });
      if (result.draft) {
        this.redrafted.add(key);
        this.redraftPending.delete(key);
      }
    } catch (error) {
      console.warn(
        `[daemon] PR #${number}（${repo}）をドラフトに戻せませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    }
  }

  /**
   * 実装の実行の間に人が PR のブランチに足したコミットを、PR を出す前に取り込む
   * （PBI-334）。新しく競合したら BaseConflictsRemained（fresh。数えない）を記録して実装をやり直させ、false。取り込めなければ
   * 一時停止して false。
   */
  private async headSyncedBeforePublish(task: Task): Promise<boolean> {
    if (!existsSync(this.repoDir(task)) || !existsSync(this.trustedGitDir(task))) return true;
    const synced = await this.syncPullRequestHead(task);
    if (synced.kind === "clean") return true;
    if (synced.kind === "failed") {
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: { type: "TaskPaused", payload: { reason: "error", message: synced.message } },
        },
      ]);
      return false;
    }
    const failed = this.append(this.mustGet(task.id), [
      {
        actor: "sacty",
        event: {
          type: "BaseConflictsRemained",
          payload: { files: synced.files, ...(synced.fresh ? { fresh: true } : {}) },
        },
      },
    ]);
    // 前の取り込みの目印が残っているときは、検証に通らなかったものとして数える
    if (!synced.fresh) this.pauseIfVerificationKeepsFailing(failed);
    return false;
  }

  /**
   * 実装の前のベースブランチの取り込みで競合した目印が、実装の後に残っていないか確かめる（PBI-331。取り込み直しはしない）。残っていれば BaseConflictsRemained を
   * 記録して実装をやり直させ（続けて解消できなければ一時停止する）、false。確かめられなければ一時停止して false。
   */
  private async conflictsResolved(task: Task): Promise<boolean> {
    const pending = pendingConflicts(task);
    if (pending.length === 0 || !existsSync(this.repoDir(task))) return true;
    let remaining: string[];
    try {
      remaining = await this.deps.repos.conflictMarkers(this.repoDir(task), pending);
    } catch (error) {
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: message("merge.failed", { detail: errorText(error) }),
            },
          },
        },
      ]);
      return false;
    }
    if (remaining.length === 0) return true;
    const failed = this.append(this.mustGet(task.id), [
      { actor: "sacty", event: { type: "BaseConflictsRemained", payload: { files: remaining } } },
    ]);
    this.pauseIfVerificationKeepsFailing(failed);
    return false;
  }

  /**
   * セキュリティ対応の差分を、前段の調査が宣言した修正の範囲と照らす（PBI-331。PR の本文と PR のレビューの子タスクに
   * 渡す）。セキュリティ対応でなければ undefined。差分を取れなければ止める（"stopped"）。
   */
  private async checkSecurityScope(
    task: Task,
  ): Promise<
    { violation?: NonNullable<ReturnType<typeof scopeViolation>> } | undefined | "stopped"
  > {
    if (!isSecurityFix(task) || !task.repository) return undefined;
    try {
      const changes = await this.deps.repos.diffStats(
        this.repoDir(task),
        this.trustedGitDir(task),
        workBaseCommit(task.repository, task.baseMerge),
      );
      const violation = scopeViolation(securityScope(task), changes);
      return violation ? { violation } : {};
    } catch (error) {
      this.append(task, [
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
      return "stopped";
    }
  }

  private draftTimeoutMs(): number {
    return this.deps.draftTimeoutMs ?? DRAFT_TIMEOUT_MS;
  }

  /**
   * PR の状態を読む（PBI-331）。答えは DRAFT_TIMEOUT_MS まで待ち、過ぎたら通信を中断して失敗にする（待つのをやめた通信を
   * 残さない）。
   */
  private statusWithin(input: { repo: string; token: string; number: number }) {
    const abort = new AbortController();
    return withDeadline(
      this.deps.pulls.status({ ...input, signal: abort.signal }),
      this.draftTimeoutMs(),
    ).catch((error: unknown) => {
      abort.abort();
      throw error;
    });
  }

  /**
   * PR のドラフトを切り替える（PBI-331）。答えは DRAFT_TIMEOUT_MS まで待ち、過ぎたら通信を中断して失敗にする。要求が終わるまでは、
   * 終わっていない要求として数える（draftRequests）。中断しても終わらない要求も、DRAFT_SETTLE_MS を過ぎたら数えない（GitHub が
   * 復旧した後に、ドラフトを外せないままにしない）。
   */
  private setDraftWithin(
    taskId: string,
    input: Omit<Parameters<PullRequests["setDraft"]>[0], "signal">,
  ): Promise<{ draft: boolean }> {
    const key = `${taskId}:${input.number}`;
    this.draftRequests.set(key, (this.draftRequests.get(key) ?? 0) + 1);
    const abort = new AbortController();
    const request = this.deps.pulls.setDraft({ ...input, signal: abort.signal });
    let counted = true;
    const ms = this.draftTimeoutMs();
    const settle = setTimeout(() => done(), ms * DRAFT_SETTLE_FACTOR);
    settle.unref?.();
    const done = () => {
      if (!counted) return;
      counted = false;
      clearTimeout(settle);
      const left = (this.draftRequests.get(key) ?? 1) - 1;
      if (left > 0) this.draftRequests.set(key, left);
      else this.draftRequests.delete(key);
    };
    request.then(done, done);
    return withDeadline(request, ms).catch((error: unknown) => {
      abort.abort();
      throw error;
    });
  }

  /**
   * PR の確認で読んだ GitHub のドラフトの状態を、台帳に合わせる（PBI-331）。答えを待つのをやめた・中断した・数えるのをやめた
   * 切り替えの要求が後から GitHub に届いても、デーモンが覚えていなくても（再起動の後も）、次の確認で直す。
   * - 指摘なしを待つ PR（重ねた PR を除く。人がドラフトを外してマージしてよいため）がドラフトでなければ、ドラフトに戻す。
   * - 指摘なしで外して記録した PR（人の承認待ち）がドラフトなら、外し直す（undraftMarkedReady）。
   */
  private async settleDraft(
    taskId: string,
    repo: string,
    number: number,
    commit: string,
    token: string,
    github: { draft: boolean; head?: string },
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    const pr = task?.pullRequest;
    if (task?.status !== "awaiting_approval" || this.cancelling.has(taskId)) return;
    if (pr?.number !== number || pr.commit !== commit || this.readying.has(taskId)) return;
    if (this.draftRequests.has(`${taskId}:${number}`)) return;
    const wants = this.wantsDraft(task, repo, github.head);
    if (wants === true && !github.draft) {
      await this.redraftFor(taskId, repo, number, token, "指摘なしになっていない");
    } else if (wants === false && github.draft && github.head) {
      await this.undraftMarkedReady(taskId, repo, number, commit, token, github.head);
    }
  }

  /**
   * 実装の PR が、今ドラフトであるべきか（PBI-331）。指摘なしを待つ PR（重ねた PR を除く）はドラフト。指摘なしで外して記録
   * した PR は、GitHub の先頭（head）をレビューの子タスクが指摘なしにしていればドラフトでなく、そうでなければ（外した後に人が
   * コミットを足した・再レビューの途中）ドラフト。先頭が分からない・どちらでもない PR は undefined（何もしない）。
   */
  private wantsDraft(task: Task, repo: string, head: string | undefined): boolean | undefined {
    const pr = task.pullRequest;
    if (!pr?.number) return undefined;
    if (pr.awaitingReview) return task.stack ? undefined : true;
    if (pr.reviewedCommit === undefined || !head) return undefined;
    const child = this.reviewerOf(task, repo, pr.number);
    return !(child && child.reviewTarget?.headCommit === head && reviewCleared(child));
  }

  /** 実装の PR のレビューの子タスク（PBI-331）。 */
  private reviewerOf(task: Task, repo: string, number: number): Task | undefined {
    const record = (task.reviewTasks ?? []).findLast(
      (r) => r.number === number && sameRepo(r.repo, repo),
    );
    return record && this.tasks.get(record.taskId);
  }

  /** 実装の PR をドラフトに戻す（PBI-331）。戻せなければ、デーモンのログに残す（次の確認でやり直す）。 */
  private async redraftFor(
    taskId: string,
    repo: string,
    number: number,
    token: string,
    why: string,
  ): Promise<void> {
    await this.setDraftWithin(taskId, { repo, token, number, draft: true }).catch(
      (error: unknown) => {
        console.warn(
          `[daemon] PR #${number}（${repo}）は${why}ので、ドラフトに戻そうとしましたが、戻せませんでした（次の確認でやり直します）：${renderMessage(redactText(errorText(error), [token]), "ja")}`,
        );
      },
    );
  }

  /**
   * 一時停止したタスクの実装の PR がドラフトでなければ、ドラフトに戻す（PBI-331。一時停止の間はマージさせない。外し直す間・
   * 外す間に一時停止した、などのときも。再開したら、指摘なしで記録した PR は PR の確認で外し直す）。GitHub の状態で決めるので、
   * 再起動の後も、戻せなかった・答えが返らなかったときも次の確認でやり直す。依存先の PR に重ねた、指摘なしを待つ PR は除く。
   */
  private async settlePausedDrafts(): Promise<void> {
    const paused = [...this.tasks.values()].filter((task) => {
      const pr = task.pullRequest;
      if (task.status !== "paused" || this.cancelling.has(task.id)) return false;
      if (!pr?.number || !pr.repo || (!pr.awaitingReview && pr.reviewedCommit === undefined)) {
        return false;
      }
      return !this.readying.has(task.id) && !this.draftRequests.has(`${task.id}:${pr.number}`);
    });
    // 答えが返らない PR があっても全体が長く待たないよう、DRAFT_CHECK_CONCURRENCY 件ずつ並べて確かめる
    await inParallel(paused, DRAFT_CHECK_CONCURRENCY, (task) => this.settlePausedDraft(task));
  }

  /** 一時停止したタスクの実装の PR を1つ確かめ、ドラフトでなければ戻す（PBI-331。settlePausedDrafts）。 */
  private async settlePausedDraft(task: Task): Promise<void> {
    const pr = task.pullRequest;
    if (!pr?.number || !pr.repo) return;
    const usedSecrets: string[] = [];
    try {
      const token = await this.githubToken(task, pr.repo, usedSecrets);
      // 答えが返らなくても PR の確認全体を止めない（時間切れは次の確認でやり直す）
      const status = await this.statusWithin({ repo: pr.repo, token, number: pr.number });
      if (status.state !== "open") return;
      if (status.draft === undefined) {
        warnDraftUnknown(pr.number, pr.repo);
        return;
      }
      if (status.draft) return;
      const latest = this.tasks.get(task.id);
      if (latest?.status !== "paused" || latest.pullRequest?.number !== pr.number) return;
      // 依存先の PR に重ねた、指摘なしを待つ PR は、人がドラフトを外してマージしてよい
      if (latest.pullRequest.awaitingReview && latest.stack) return;
      await this.redraftFor(task.id, pr.repo, pr.number, token, "タスクが一時停止している");
    } catch (error) {
      console.warn(
        `[daemon] 一時停止したタスクの PR #${pr.number}（${pr.repo}）のドラフトを確かめられませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    }
  }

  /**
   * 指摘なしでドラフトを外して記録した実装の PR（人の承認待ち）が、GitHub でドラフトになっていたら外し直す（PBI-331）。
   * GitHub の先頭（head）が指摘なしにした先頭と違えば（外した後に人がコミットを足してドラフトにした）、ドラフトのままにし、
   * レビューの子タスクにその先頭を再レビューさせる（reconcileReviewTasks）。子タスクがその先頭を指摘なしにしたら、外して
   * その先頭で記録し直す。外す間に差し戻された・PR を更新した・子タスクの再レビューが始まった・先頭が変わったら、ドラフトに
   * 戻す。外した答えを今の記録のまま受け取れなければ、外す要求が後から届くかもしれないので、次の提出でも指摘なしで外すまで
   * 確認のたびにドラフトに戻す（undraftUnsettled）。
   */
  private async undraftMarkedReady(
    taskId: string,
    repo: string,
    number: number,
    commit: string,
    token: string,
    head: string,
  ): Promise<void> {
    const marked = (): Task | undefined => {
      const latest = this.tasks.get(taskId);
      const pr = latest?.pullRequest;
      return latest?.status === "awaiting_approval" &&
        !this.cancelling.has(taskId) &&
        pr?.number === number &&
        pr.commit === commit &&
        !pr.awaitingReview &&
        pr.reviewedCommit !== undefined
        ? latest
        : undefined;
    };
    const reviewerOf = (task: Task): Task | undefined => this.reviewerOf(task, repo, number);
    const task = marked();
    if (!task) return;
    // 先頭は PR の確認で読んだ GitHub の先頭（読めなければ外さない。記録したコミットで代えると、足されたコミットを外しうる）
    const target = head;
    const child = reviewerOf(task);
    // 子タスクがその先頭を指摘なしにしていなければ、ドラフトのまま再レビューを待つ
    if (!child || child.reviewTarget?.headCommit !== target || !reviewCleared(child)) return;
    const round = child.reviewRound;
    const verdicts = child.reviewVerdicts?.length;
    const unchanged = (): Task | undefined => {
      const latest = marked();
      const reviewer = latest && reviewerOf(latest);
      return latest &&
        reviewer?.id === child.id &&
        reviewer.reviewTarget?.headCommit === target &&
        reviewer.reviewRound === round &&
        reviewer.reviewVerdicts?.length === verdicts &&
        reviewCleared(reviewer)
        ? latest
        : undefined;
    };
    const key = `${taskId}:${number}`;
    this.undraftUnsettled.add(key);
    this.readying.add(taskId);
    try {
      let result: { draft: boolean } | undefined;
      try {
        result = await this.setDraftWithin(taskId, { repo, token, number, draft: false });
      } catch (error) {
        console.warn(
          `[daemon] 指摘なしで外した PR #${number}（${repo}）がドラフトに戻っていたので外し直そうとしましたが、外せませんでした（次の確認でやり直します）：${renderMessage(redactText(errorText(error), [token]), "ja")}`,
        );
      }
      const current = result && unchanged();
      if (current && (await this.pullRequestHead(current, repo, number)) === target) {
        const latest = unchanged();
        if (latest) {
          // 外した後に足された先頭を指摘なしにして外したなら、その先頭で記録し直す
          if (latest.pullRequest?.reviewedCommit !== target) {
            this.append(latest, [
              {
                actor: "sacty",
                event: {
                  type: "PullRequestMarkedReady",
                  payload: { number, commit: target, reviewTaskId: child.id },
                },
              },
            ]);
          }
          if (result && !result.draft) this.undraftUnsettled.delete(key);
          return;
        }
      }
      // 外せなかった（答えを受け取れなかったときも）・外す間に変わった：外れているかもしれないので、終わっていないタスクの同じ PR
      // ならドラフトに戻す（指摘なしで外したままでよいときは、次の確認で GitHub の状態を読んで外し直す。一時停止の間も、
      // 確認のたびに戻す。settlePausedDrafts）
      const latest = this.tasks.get(taskId);
      if (latest && !isFinished(latest) && latest.pullRequest?.number === number) {
        await this.redraftFor(taskId, repo, number, token, "外す間に変わった");
      }
    } finally {
      this.readying.delete(taskId);
    }
  }

  /** PR の GitHub の今の先頭（PBI-331）。開いていない・読めなければ undefined。 */
  private async pullRequestHead(
    task: Task,
    repo: string,
    number: number,
  ): Promise<string | undefined> {
    const usedSecrets: string[] = [];
    try {
      const token = await this.githubToken(task, repo, usedSecrets);
      const status = await this.statusWithin({ repo, token, number });
      return status.state === "open" ? status.headSha : undefined;
    } catch (error) {
      console.warn(
        `[daemon] PR #${number}（${repo}）の先頭を読めませんでした：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
      return undefined;
    }
  }

  /**
   * PR のレビューの子タスクが GitHub の今の先頭（commit）を指摘なしにした、レビューを待つ実装の PR のドラフトを外し、人の承認
   * （マージ）待ちにする（PBI-331）。台帳の draft にかかわらず GitHub の状態を読んで外し（すでに外れていれば何もしない）、外せた
   * ときだけ記録する。外せなければ、記録せずに次の確認でやり直す。次のときは記録せず、まだレビューを待つ PR ならドラフトに戻す。
   * - 外す間にタスクが変わった（差し戻し・PR の更新。外す要求が、次の提出のドラフトに戻す要求より後に届いたときのため）
   * - 外した後の GitHub の先頭が、指摘なしにした先頭と違う・読めない（外す間に人がコミットを足した。次の確認で再レビューする）
   * - 外す要求の答えを受け取れなかった（GitHub では外れているかもしれない。時間切れも。外す要求が後から届くかもしれないので、
   *   指摘なしで外すまで確認のたびに戻す）
   */
  private async markReady(parent: Task, child: Task, commit: string): Promise<void> {
    const pr = parent.pullRequest;
    if (
      parent.status !== "awaiting_approval" ||
      !pr?.awaitingReview ||
      !pr.number ||
      !pr.repo ||
      parent.stack
    ) {
      return;
    }
    if (this.readying.has(parent.id)) return;
    // 前の切り替えの要求が終わっていなければ、終わってから外す（次の確認でやり直す）
    if (this.draftRequests.has(`${parent.id}:${pr.number}`)) return;
    this.readying.add(parent.id);
    const { number, repo } = pr;
    const usedSecrets: string[] = [];
    const warn = (what: string, error: unknown) =>
      console.warn(
        `[daemon] PR #${number}（${repo}）${what}：${renderMessage(redactText(errorText(error), usedSecrets), "ja")}`,
      );
    let token: string | undefined;
    // ドラフトに戻す（戻せなくても、次の提出・次の確認が戻す）
    const key = `${parent.id}:${pr.commit}`;
    const redraft = async () => {
      if (token === undefined) return;
      // 戻せたと確かめられるまで、次の確認でも戻す（台帳には draft が残るため）
      this.redraftPending.add(key);
      await this.setDraftWithin(parent.id, { repo, token, number, draft: true })
        .then((r) => {
          if (r.draft) this.redraftPending.delete(key);
        })
        .catch((error: unknown) => warn("をドラフトに戻せませんでした", error));
    };
    try {
      token = await this.githubToken(parent, repo, usedSecrets);
      try {
        const undrafted = await this.setDraftWithin(parent.id, {
          repo,
          token,
          number,
          draft: false,
        });
        // GitHub の答えがまだドラフトなら、記録せずに次の確認でやり直す
        if (undrafted.draft) {
          warn("のドラフトが外れていません", "GitHub の答えがドラフトのまま");
          return;
        }
      } catch (error) {
        warn("のドラフトを外せませんでした", error);
        // 外す要求が後から届くかもしれないので、指摘なしで外すまで確認のたびに戻す
        this.undraftUnsettled.add(`${parent.id}:${number}`);
        await redraft();
        return;
      }
      // 外す間にタスクが変わっていないか。変わっていたら、まだレビューを待つ PR ならドラフトに戻す
      const unchanged = async (): Promise<Task | undefined> => {
        const latest = this.tasks.get(parent.id);
        const now = latest?.pullRequest;
        if (
          latest?.status === "awaiting_approval" &&
          !this.cancelling.has(latest.id) &&
          now?.awaitingReview &&
          now.number === number &&
          now.commit === pr.commit
        ) {
          return latest;
        }
        const reworking = latest?.status === "queued" || latest?.status === "running";
        if (latest && (reworking || now?.awaitingReview) && now?.number === number) await redraft();
        return undefined;
      };
      const latest = await unchanged();
      if (!latest) return;
      if ((await this.pullRequestHead(latest, repo, number)) !== commit) {
        await redraft();
        return;
      }
      const current = await unchanged();
      if (!current) return;
      // 外す間に子タスクの再レビューが始まった・判定が変わったら、古い指摘なしで記録せず、ドラフトに戻す（次の確認でやり直す）
      const reviewer = this.tasks.get(child.id);
      if (
        !reviewer ||
        reviewer.reviewTarget?.headCommit !== commit ||
        reviewer.reviewRound !== child.reviewRound ||
        reviewer.reviewVerdicts?.length !== child.reviewVerdicts?.length ||
        !reviewCleared(reviewer)
      ) {
        await redraft();
        return;
      }
      this.append(current, [
        {
          actor: "sacty",
          event: {
            type: "PullRequestMarkedReady",
            payload: { number, commit, reviewTaskId: child.id },
          },
        },
      ]);
      this.undraftUnsettled.delete(`${parent.id}:${number}`);
    } catch (error) {
      warn("のドラフトを外せませんでした", error);
    } finally {
      this.readying.delete(parent.id);
    }
  }

  /**
   * 検証が続けて通らなければ、実装のやり直しを止めて人間に判断してもらう。実装をやり直しても前回の失敗が1つも
   * 直らなかったときは、回数を待たずに止める（やり直しても直らない失敗なので。PBI-308）。
   */
  private pauseIfVerificationKeepsFailing(task: Task): void {
    const stalled = task.verifyStalled ?? [];
    if (task.verifyFailures < MAX_VERIFY_ATTEMPTS && stalled.length === 0) return;
    // 競合の目印が残って通らなかったときは、そう伝える（目印のあるファイルを、レビューへ進められない理由と一緒に示す）
    const feedback = task.verifyFeedback;
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: {
            reason: "verification",
            message:
              feedback?.kind === "merge"
                ? message("verify.mergeConflictsRemain", {
                    count: MAX_VERIFY_ATTEMPTS,
                    files: feedback.files.slice(0, 5).join(", "),
                    total: feedback.files.length,
                  })
                : stalled.length > 0
                  ? message("verify.sameFailureRemains", {
                      names: stalled.slice(0, 5).join(", "),
                      total: stalled.length,
                    })
                  : message("verify.tooManyAttempts", { count: MAX_VERIFY_ATTEMPTS }),
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
    // エスカレーション（人の判断待ち）は、止める作業が無いので止めない。承認待ち（マージ待ち）は止められる（PBI-301）
    if (task.status === "escalated") {
      throw new InvalidOperationError(message("pause.awaitingPerson"));
    }
    if (task.status === "blocked" || task.status === "waiting_children") {
      throw new InvalidOperationError(message("pause.waitingTasks"));
    }
    if (task.status === "awaiting_approval") {
      // 実行中の処理は無いので、その場で一時停止を記録する。承認ゲートと PR の見守りは、再開するまで止まる。実装の PR は
      // 作り直しの間と同じ扱いで、一時停止の間のマージは承認として進め、届いた指摘は残して再開のあとに反映する
      if (this.cancelling.has(id) || this.mergeStopping.has(id)) {
        throw new InvalidOperationError(message("pause.awaitingPerson"));
      }
      this.append(task, [
        { actor: "person", event: { type: "TaskPaused", payload: { reason: "manual" } } },
      ]);
      return this.mustGet(id);
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
        present:
          existsSync(workspace) ||
          existsSync(this.trustedGitDir(task)) ||
          existsSync(taskCachePath(this.deps.workspaceRoot, task.id)),
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
    /**
     * sacty が中止する理由（レビューの PR がマージされた・閉じられた。PBI-44。PR のレビューの子タスクの親が中止された。
     * PBI-330）。人間の中止では無い。
     */
    reason?: "pull_request_merged" | "pull_request_closed" | "parent_cancelled",
  ): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled")
      throw new InvalidOperationError(message("cancel.alreadyCancelled"));
    if (this.cancelling.has(id)) throw new InvalidOperationError(message("cancel.cleaningUp"));
    this.cancelling.add(id);
    try {
      // 質問に答えている実行は止めて、答えの記録（中断・費用）を待つ（PBI-54）
      const chat = this.chats.get(id);
      if (chat) {
        this.deps.executor.kill(chat.runId);
        await chat.done;
      }
      // エラーを分析している実行も、同じく止めて記録を待つ
      const analysis = this.analyses.get(id);
      if (analysis) {
        this.deps.executor.kill(analysis.runId);
        await analysis.done;
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
      // 引き継いだ既存の PR（人が作った PR）は閉じない。sacty が積んだコミットも PR に残る
      if (pr?.number && latest.pullRequestState !== "merged" && !latest.continuedPullRequest) {
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
      // 完了の後に作業領域を消したタスク（作業領域と退避した git のメタデータが両方とも無い。PBI-157）は、ブランチを
      // 消すために、同じ起点で用意し直す。用意できなければ、その理由をブランチの片付けの結果に残す
      await this.workspaceSettled(id);
      const workspace = join(this.deps.workspaceRoot, latest.id);
      const existed = existsSync(workspace) || existsSync(gitDir);
      let unprepared: DaemonText | undefined;
      if (branches.length > 0 && latest.repository && !existed) {
        const loaded = this.deps.config();
        const ready = loaded.ok
          ? await this.prepareRepository(latest, loaded.config)
          : { ok: false as const, message: loaded.problem };
        if (!ready.ok) unprepared = ready.message;
      }
      for (const branch of branches) {
        if (unprepared !== undefined) {
          cleanup.push({ target: "branch", result: "failed", detail: unprepared });
          continue;
        }
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
      // 作業領域：タスクの作業領域と、退避した git のメタデータ（ブランチを消すために用意し直したものは、無かったものとする）
      if (!containerStopped) {
        cleanup.push({
          target: "workspace",
          result: "failed",
          detail: message("cleanup.containerUnconfirmed"),
        });
      } else {
        try {
          await rm(workspace, { recursive: true, force: true });
          await rm(gitDir, { recursive: true, force: true });
          // タスクごとの依存のキャッシュも消す（PBI-319）。リンクならリンクだけを消し、途中の _task-cache がリンクなら
          // その先を消さずに失敗にする
          const cached = await (this.deps.removeWorkspaceEntry ?? removeEntry)(
            this.deps.workspaceRoot,
            taskCachePath(this.deps.workspaceRoot, latest.id),
          );
          cleanup.push({
            target: "workspace",
            result: existed || cached ? "done" : "skipped",
          });
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
   * 再現の確かめを待ったままのタスク（それより前の版で、再現の工程の後に sacty がテストを実行するのを待っていた。PBI-29）。
   * 今の版は、再現の工程のエージェントの申告を工程の完了と一緒に記録するので、待っているものは申告が無いものとして、
   * 再現できなかったと記録する（人間が差し戻すと、再現をやり直す）。
   */
  private checkReproduction(task: Task): void {
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "ReproductionChecked",
          payload: reproductionChecked(task.reproductionTests, undefined),
        },
      },
    ]);
  }

  /**
   * 統合レビュー（PBI-31）。子タスクの PR がマージされた後のベースブランチの最新を取得し、ゴールガーディアンが
   * 新しいセッションで、そのコード（使い捨ての写し）と親の承認済みの要求要件・設計から判定する。合格、または
   * 続けて通らない上限に達したら統合レビューの承認待ちにする。上限の前に不合格なら、作業履歴の適用で
   * タスク分割の工程に戻り、修正の子タスクを追加する。実行できなければ理由を記録して止める（再開でやり直す）。
   */
  private async integrate(task: Task, config: SactyConfig): Promise<void> {
    const step = "integrate" as const;
    const selected = agentFor(config, step);
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で実行する
    const agent = this.usableAgent(config, selected, task.id, step);
    const runId = randomUUID();
    // 統合レビューのイメージは、実行を始めたときのものに決める（実行の間に変えても、次の実行から。PBI-106・PBI-318）。
    // 使う名前を実行の記録に残す
    const runImageName = stepImageOf(this.mustGet(task.id), step);
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "AgentRunStarted",
          payload: {
            runId,
            step,
            agentId: agent.id,
            ...agentSetting(agent),
            image: runImageName ?? DEFAULT_IMAGE_NAME,
          },
        },
      },
    ]);
    const workspaceDir = join(this.deps.workspaceRoot, CODE_COPY_DIR, runId);
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
      const stepImage = resolveImage(
        this.projectImagesConfig(config, task.projectId),
        runImageName,
      );
      if (!stepImage.ok) executed ??= failed(stepImage.message);
      executed ??= await this.execute({
        agent,
        taskId: task.id,
        image: stepImage.ok ? stepImage.image : config.image,
        ...(stepImage.ok ? { imageEnv: stepImage.env } : {}),
        taskCache: true,
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
      await rm(workspaceDir, { recursive: true, force: true });
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
              ...unknownCost(executed),
            },
          },
        },
        this.pauseOrFallBack(
          task.id,
          { runId, role: step, agent, selected },
          outcome.reason,
          {
            actor: "sacty",
            event: {
              type: "TaskPaused",
              payload: { reason: this.stopReason(task.id, outcome.reason), ...manual },
            },
          },
          config,
        ),
      ]);
      this.warnIfNeeded(this.mustGet(task.id));
      return;
    }
    const latest = this.mustGet(task.id);
    // 判定に当てる、秘密情報を伏せる関数（PBI-298）。取り出しを待つ間に人間が止めたなら、判定を記録しない（使った分の
    // 費用だけ記録する。一時停止・中止は runNext の後始末が記録し、再開すると統合レビューからやり直す）
    const hide = await this.reviewRedactor(latest, config);
    if (this.stopRequested(task.id)) {
      this.append(this.mustGet(task.id), [
        {
          actor: "sacty",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId,
              step,
              agentId: agent.id,
              reason: "error",
              message: message("run.stoppedByPerson"),
              usage: outcome.usage,
              costUsd,
              estimated,
              ...unknownCost(executed),
            },
          },
        },
      ]);
      return;
    }
    const { output, ...review } = extractIntegrationReview(
      outcome.output,
      integrationViewpointIds(latest),
      latest.remarks.filter((r) => !r.voided).map((r) => r.id),
      hide,
    );
    const events: ActivityItem[] = [
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
          },
        },
      },
      {
        actor: "agent",
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
      // 読んでいる間は、子タスクの作業領域を消さない。完了の後に消した子タスクのものを用意し直したなら、読み終えたら
      // （失敗しても）また消す（PBI-157 レビュー指摘）
      this.borrowed.set(child.id, (this.borrowed.get(child.id) ?? 0) + 1);
      try {
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
      } finally {
        const left = (this.borrowed.get(child.id) ?? 1) - 1;
        if (left > 0) this.borrowed.set(child.id, left);
        else this.borrowed.delete(child.id);
        void this.retireWorkspace(child.id);
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
          this.blockedStart(task, c) !== undefined,
      )
    );
  }

  /**
   * 依存のある子タスク（blocked）を、いま始められるか（PBI-27・PBI-317）。始められるなら TaskUnblocked の payload、まだ
   * 待つなら undefined。確かめられなければ待つ。
   * - 依存先がすべてベースブランチに入った（`landed`）なら、ベースブランチから始める（重ねない）
   * - 依存先のうち1つ（X）が重ねられ（最終レビューに合格して承認待ち。`reviewedPullRequest`）、子と同じリポジトリで、
   *   ほかの依存先の今の変更がすべて X の合格したコミットに入っていると、記録から確かめられる（`covers`）なら、X の PR の
   *   ブランチの合格したコミットに重ねて始める
   * - それ以外は待つ
   */
  private blockedStart(
    parent: Task,
    child: { taskId: string; dependsOn: string[] },
  ): Extract<EventInput, { type: "TaskUnblocked" }>["payload"] | undefined {
    if (child.dependsOn.every((d) => this.landed(parent, d))) return {};
    const current = this.tasks.get(child.taskId);
    const repo = current && this.taskRepo(current);
    for (const id of child.dependsOn) {
      if (this.landed(parent, id)) continue;
      const dep = this.tasks.get(id);
      const reviewed = dep && reviewedPullRequest(dep);
      if (!dep || !reviewed || dep.status !== "awaiting_approval") continue;
      if (dep.gate?.step !== "implement" || !dep.repository) continue;
      if (!repo || this.taskRepo(dep) !== repo) continue;
      if (!child.dependsOn.every((d) => d === id || this.covers(parent, dep, d))) continue;
      return {
        stackedOn: { taskId: dep.id, branch: reviewed.branch, commit: reviewed.commit },
      };
    }
    return undefined;
  }

  /**
   * 承認待ちの X の合格したコミットに、依存先の子タスク d の今の変更が入っていると、記録から確かめられるか（PBI-317）。
   * - d がベースブランチに入った：X が d を（依存の依存も含めて）待ち、一度も重ねずにベースブランチから始めたとき（X を
   *   始めた時点で、d はもうベースブランチに入っていた）。X が重ねて始めたなら、確かめられない（重ねた先の古い内容から
   *   作ったかもしれない）
   * - d がまだ入っていない：X から重ねた先をたどって d に着き、各段の作業領域のベースが、1つ下の依存先の今の合格した
   *   コミットと同じとき（下の依存先が直されて合格し直したのに、まだ取り込んでいなければ、確かめられない）
   */
  private covers(parent: Task, x: Task, d: string): boolean {
    if (this.landed(parent, d)) {
      return this.waitedOn(parent, x.id).has(d) && !x.stack && x.stackedBase === undefined;
    }
    const seen = new Set<string>();
    let current = x;
    while (current.stack && !seen.has(current.id)) {
      seen.add(current.id);
      const below = this.tasks.get(current.stack.taskId);
      const reviewed = below && reviewedPullRequest(below);
      if (!below || !reviewed || !current.repository) return false;
      if (workBaseCommit(current.repository, current.baseMerge) !== reviewed.commit) return false;
      if (below.id === d) return true;
      current = below;
    }
    return false;
  }

  /**
   * 依存先の子タスクの変更が、ベースブランチに入ったか（PBI-317）。完了・中止を認めた（片付いた）か、実装の PR がマージ
   * された（マージの後の監視の途中）もので、ほかの PR に重ねていないもの。重ねたまま PR がマージされた（人が依存先より先に
   * マージした）なら、変更は重ねた先の PR のブランチにしか入っていないので、まだ入っていない（重ねた先がマージされて、
   * 付け替えると入る）。
   */
  private landed(parent: Task, childId: string): boolean {
    if (parent.split?.acceptedCancellations.includes(childId)) return true;
    const dep = this.tasks.get(childId);
    if (!dep || dep.stack) return false;
    return isCompleted(dep) || (dep.status !== "cancelled" && implementationMerged(dep));
  }

  /** 子タスクが（依存の依存も含めて）待った依存先の子タスク（PBI-317）。 */
  private waitedOn(parent: Task, childId: string): Set<string> {
    const children = new Map((parent.split?.children ?? []).map((c) => [c.taskId, c.dependsOn]));
    const waited = new Set<string>();
    const next = [...(children.get(childId) ?? [])];
    while (next.length > 0) {
      const id = next.pop() as string;
      if (waited.has(id)) continue;
      waited.add(id);
      next.push(...(children.get(id) ?? []));
    }
    return waited;
  }

  /** タスクが重ねている依存先を、近い順にたどった ID（重ねていなければ空。PBI-317）。 */
  private stackChain(task: Task): string[] {
    const chain: string[] = [];
    let next = task.stack?.taskId;
    while (next && !chain.includes(next)) {
      chain.push(next);
      next = this.tasks.get(next)?.stack?.taskId;
    }
    return chain;
  }

  /** 重ねている依存先の連なりのうち、中止されたもの（PBI-317）。 */
  private cancelledInStack(task: Task): Task | undefined {
    return this.stackChain(task)
      .map((id) => this.tasks.get(id))
      .find((t) => t?.status === "cancelled");
  }

  /**
   * 依存先の PR に重ねた子タスクで、sacty が進めることがあるか（PBI-317）。
   * - merged：重ねていた依存先の PR が、ベースブランチにマージされた（起点のブランチを付け替える。依存先も重ねたまま先に
   *   マージされたときは、その依存先が付け替わるまで待つ）
   * - cancelled：重ねている依存先の連なりに、中止されたものがある（子タスクを止める）
   * どちらも記録するだけ（GitHub の PR の向き先の付け替えは、PR の確認で行う。`retargetDue`）。
   */
  private stackAction(task: Task): "merged" | "cancelled" | undefined {
    if (task.status === "cancelled") return undefined;
    const dep = task.stack && this.tasks.get(task.stack.taskId);
    // 依存先も重ねたまま先にマージされた（変更は、依存先が重ねた先の PR のブランチに入った）ときは、付け替えずに待つ。
    // 重ねた先がマージされて、依存先が付け替わったら付け替える（重ね直すと、作業領域のベースと取り込む先が合わない）
    if (dep?.repository && !dep.stack && dep.status !== "cancelled" && implementationMerged(dep)) {
      return "merged";
    }
    if (
      task.stack &&
      this.cancelledInStack(task) &&
      (task.status === "queued" || task.status === "idle" || task.status === "awaiting_approval")
    ) {
      return "cancelled";
    }
    return undefined;
  }

  /**
   * 承認待ちの実装の PR の向き先が、今の起点のブランチと違うか（重ねた子タスクの、依存先の PR のマージの後。PBI-317）。
   * PR の確認（60秒ごと）で、GitHub の向き先を付け替える（`retargetPullRequest`）。
   */
  private retargetDue(task: Task): boolean {
    const pr = task.pullRequest;
    return Boolean(
      task.status === "awaiting_approval" &&
        pr?.number &&
        pr.repo &&
        pr.baseBranch !== undefined &&
        task.repository &&
        pr.baseBranch !== task.repository.baseBranch &&
        task.pullRequestState === "open",
    );
  }

  /** 依存先の PR に重ねた子タスクを進める（`stackAction`。PBI-317）。 */
  private settleStack(task: Task): void {
    const action = this.stackAction(task);
    if (action === "merged" && task.stack) {
      const dep = this.mustGet(task.stack.taskId);
      // 依存先の PR が入ったブランチ（依存先は、もう重ねていない）
      const baseBranch = dep.repository?.baseBranch;
      if (!baseBranch) return;
      this.append(task, [
        {
          actor: "sacty",
          event: { type: "StackedDependencyMerged", payload: { taskId: dep.id, baseBranch } },
        },
      ]);
      return;
    }
    if (action === "cancelled") {
      this.append(task, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: message("stack.dependencyCancelled", {
                title: this.cancelledInStack(task)?.title ?? "",
              }),
            },
          },
        },
      ]);
      return;
    }
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
      // 依存先が片付いたら・依存先の PR が最終レビューに合格したら（重ねる。PBI-317）始める
      const start = this.blockedStart(parent, child);
      if (!start) continue;
      this.append(current, [{ actor: "sacty", event: { type: "TaskUnblocked", payload: start } }]);
    }
    if (split.children.every((c) => this.childSettled(parent, c.taskId))) {
      this.append(parent, [{ actor: "sacty", event: { type: "SplitCompleted", payload: {} } }]);
    }
  }

  /**
   * 秘密情報を取り出してエージェントを実行し、出力やエラー文から秘密情報を取り除いて返す。オーケストレーター（質問への答えも）
   * は、タスクのセッションを使い回す（PBI-67）。返す runId は、最後に実行したもの（再開できずに新しく始め直したら変わる）。
   */
  private async execute(original: ExecuteRun): Promise<Executed & { runId: string }> {
    const run = this.withMemory(original);
    let executed: Executed & { runId: string };
    if (run.role === "orchestrator") {
      // 同じタスクで、オーケストレーターの実行は同時に1つだけ（並ぶ）
      executed = await this.withOrchestratorLock(run.taskId, () => this.executeWithSession(run));
    } else if (run.role === "chat") {
      executed = await this.executeWithSession(run);
    } else {
      executed = await this.executeResumable(run);
    }
    // 利用制限に達したエージェントは、しばらく使わない（代わりのエージェントがあれば、次からそれを使う）
    this.markLimited(run.agent, executed.outcome);
    if (notConfirmed(executed.outcome)) {
      this.unconfirmedRuns.add(run.runId);
      this.unconfirmedRuns.add(executed.runId);
    }
    return executed;
  }

  /**
   * 工程などの1回の実行（オーケストレーターと質問への答え以外）。直前の実行が時間切れで止まったものなら、同じエージェントの
   * セッションの続きから進め、続けられなければ最初から実行し直す。どちらも作業履歴に残す。時間切れで止めた実行も、次に続けられる
   * ように作業履歴に残す（PBI-280）。
   */
  private async executeResumable(run: ExecuteRun): Promise<Executed & { runId: string }> {
    const runtime = run.agent.runtime;
    let plan: ContinuePlan | undefined;
    if (runtime === "claude-code" || runtime === "codex") {
      try {
        plan = await planTimeoutResume(
          this.deps.activity.forTask(run.taskId),
          { role: run.role, agentId: run.agent.id, runtime, runId: run.runId },
          (runId) => this.deps.sessionLogs?.agentFilesDir(run.taskId, runId),
        );
      } catch (error) {
        console.warn(
          `[daemon] 時間切れで止めた実行のセッションを確かめられませんでした（${run.taskId}）：`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    const resuming = plan?.mode === "resume" ? plan : undefined;
    // 続ける・続けない判断は、実行の前に記録する。実行の途中でデーモンが止まると、実行の後の記録も写したファイルの記録も残らず、
    // 開始を残さない役割（最終レビュー・ゴールガーディアンなど）は、次の実行が古い会話をもう一度続けてしまうため
    const continued = (mode: "resumed" | "restarted", reason?: AgentRunContinuedReason) =>
      plan && (runtime === "claude-code" || runtime === "codex")
        ? this.recordTimeoutEvent(run.taskId, {
            type: "AgentRunContinued",
            payload: {
              runId: run.runId,
              role: run.role,
              agentId: run.agent.id,
              runtime,
              stoppedRunId: plan.stopped.runId,
              mode,
              ...(mode === "resumed" && resuming ? { sessionId: resuming.sessionId } : {}),
              ...(reason ? { reason } : {}),
            },
          })
        : undefined;
    if (plan) {
      if (resuming) continued("resumed");
      else if (plan.mode === "restart") continued("restarted", plan.reason);
    }
    const { archived, ...executed } = await this.executeOnce(
      resuming
        ? {
            ...run,
            prompt: [...timeoutResumeLines(run.role, resuming.stopped.minutes), run.prompt].join(
              "\n",
            ),
            session: { resume: resuming.sessionId, filesDir: resuming.filesDir },
          }
        : run,
    );
    // AI が再開を受け付けなかった・別のセッションで始めた（再開したつもりが、続きではない）なら、続けたとは言えないので、
    // 理由を記録し直す（新しい記録が優先される）
    if (
      resuming &&
      (runtime === "claude-code" || runtime === "codex") &&
      (resumeRejected(runtime, executed.outcome) ||
        (archived?.sessionId !== undefined && archived.sessionId !== resuming.sessionId))
    ) {
      continued("restarted", "resume_failed");
    }
    const minutes =
      executed.outcome.kind === "failed" ? timeoutMinutes(executed.outcome.message) : undefined;
    if ((runtime === "claude-code" || runtime === "codex") && minutes !== undefined) {
      this.recordTimeoutEvent(run.taskId, {
        type: "AgentRunTimedOut",
        payload: {
          runId: run.runId,
          role: run.role,
          agentId: run.agent.id,
          runtime,
          minutes,
        },
      });
    }
    return { ...executed, runId: run.runId };
  }

  /** 時間切れの実行と、その続きの記録を作業履歴に残す。記録できなくても、実行の結果は変えない（中止したタスクなど）。 */
  private recordTimeoutEvent(
    taskId: string,
    event: Extract<EventInput, { type: "AgentRunTimedOut" | "AgentRunContinued" }>,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    try {
      this.append(task, [{ actor: "sacty", event }]);
    } catch (error) {
      console.warn(
        `[daemon] 時間切れの実行の記録を作業履歴に残せませんでした（${event.payload.runId}）：`,
        error instanceof Error ? error.message : error,
      );
    }
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
  private async executeWithSession(run: ExecuteRun): Promise<Executed & { runId: string }> {
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
    // 別のエージェントのセッション（失敗して代わりのエージェントに切り替えたなど）は再開できないので、そのやり取りを
    // 読み取り専用で渡して引き継ぐ
    const handoffDir = join(this.deps.workspaceRoot, "_handoff", run.runId);
    const handoff =
      plan.mode === "new" && plan.handoff ? stageHandoff(handoffDir, plan.handoff) : undefined;
    const fresh: ExecuteRun = handoff
      ? {
          ...run,
          prompt: [run.prompt, ...handoff.promptLines].join("\n"),
          mounts: [...(run.mounts ?? []), handoff.mount],
          readDirs: [...(run.readDirs ?? []), CONTAINER_HANDOFF_DIR],
        }
      : run;
    let executed: Awaited<ReturnType<TaskService["executeOnce"]>>;
    try {
      executed = await this.executeOnce(
        plan.mode === "resume"
          ? { ...run, session: { resume: plan.sessionId, filesDir: plan.filesDir, fork: chat } }
          : fresh,
      );
    } finally {
      // 消せなくても、実行の結果（答え・分析と費用）は失わない（残ったものは、起動のときの片付けで消す）
      if (handoff) {
        try {
          rmSync(handoffDir, { recursive: true, force: true });
        } catch (error) {
          console.warn(
            `[daemon] 引き継ぎのために書いたファイルを消せませんでした（${run.taskId}）：`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
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
      executed = {
        ...executed,
        costUsd: executed.costUsd + first.costUsd,
        ...(first.costUnknown ? { costUnknown: true as const } : {}),
      };
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
                ...(handoff && plan.mode === "new" && plan.handoff
                  ? {
                      handoffFrom: {
                        agentId: plan.handoff.agentId,
                        sessionId: plan.handoff.sessionId,
                        truncated: handoff.truncated,
                      },
                    }
                  : {}),
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
  ): Promise<Executed & { archived: ArchivedAgentSession | undefined }> {
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
  ): Promise<Executed> {
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
      // GitHub の読み取りの中継は、タスクのプロジェクトで gh のアカウントを選んだホストなら、どの実行でも使える
      // （設定で切れない）。トークンはゲートウェイがホストで付ける
      const github = this.deps.gateway ? this.githubRelayHosts(run.taskId) : {};
      const githubHosts = Object.keys(github);
      if (viaGateway || platforms.length > 0 || tokenEnvs.length > 0 || githubHosts.length > 0) {
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
          // 接続先を決めて使う実行（操作・書き出し）は、決めた PF・MCP だけを使える。書き出しは、選んだ PF か、
          // 選んだ MCP だけを置いたコンテキストを渡すので、その範囲に縛る（PBI-131）
          run.role === "operation" || run.role === "export"
            ? { platforms: platforms.map((p) => p.name), hostMcp: run.context?.mcpServers ?? [] }
            : undefined,
          github,
          // 情報収集は読むだけ。外部の本文に書かれた指示に誘導されても書き込めないよう、外部 PF を GET・HEAD に限る
          run.role === "gather" ? { readOnly: true } : undefined,
        );
        usedSecrets.push(gatewayRun.token);
        if (viaGateway) {
          gateway = { origin: this.deps.gateway.containerOrigin(), token: gatewayRun.token };
        }
      }
      // タスクごとの依存のキャッシュ（PBI-319）。用意できなければ、キャッシュを使わずに実行する。渡すときは、使い方の案内を
      // 指示に足す（既定の規則が渡らない最終レビュー・統合レビューにも届くように）
      const taskCache = run.taskCache
        ? await prepareTaskCache(this.deps.workspaceRoot, run.taskId)
        : undefined;
      const invocation = await buildInvocation(
        run.agent,
        [
          run.prompt,
          ...(gatewayRun && githubHosts.length > 0
            ? ["", ...githubPromptLines(githubHosts, run.role)]
            : []),
          ...(taskCache ? ["", ...taskCachePromptLines()] : []),
        ].join("\n"),
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
      if (gatewayRun && githubHosts.length > 0 && this.deps.gateway) {
        Object.assign(
          invocation.env,
          githubRelayEnv(
            this.deps.gateway.githubUrl(gatewayRun.token),
            githubHosts,
            this.githubDefaultHost(run.taskId, githubHosts),
          ),
        );
        invocation.hostGateway = true;
      }
      if (gatewayRun && tokenEnvs.length > 0) {
        for (const s of tokenEnvs) invocation.env[s.env] = `${s.prefix}${gatewayRun.token}`;
        invocation.hostGateway = true;
      }
      if (run.mounts && run.mounts.length > 0) invocation.mounts = [...run.mounts];
      if (taskCache) invocation.taskCache = taskCache;
      // 決まった見出しの塊を答えに含める役割は、その塊を含む最後の result を答えにする（最終の答えの後の通知への返答を、
      // 答えや投稿の本文にしない。PBI-154・PR #213 レビュー指摘）
      const marker = answerMarker(run.role);
      if (marker) invocation.preferResult = marker;
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
        // その役割の実行の上限（config.yaml の run_timeout。PBI-150）
        timeoutMs: agentTimeoutMs(config.ok ? config.config.runTimeouts : undefined, run.role),
      });
    } catch (error) {
      outcome = {
        kind: "failed",
        reason: error instanceof SecretNotFoundError ? "auth" : "error",
        // 時間切れで止めても、コンテナが止まったことを確かめられなかったなら、その結果にする（動いたままかもしれないので、
        // 代わりのエージェントに切り替えず、同じ作業領域で操作が重ならないように止める）
        message:
          error instanceof AgentTimeoutError && error.unconfirmedContainer
            ? message("run.containerNotConfirmed", { name: error.unconfirmedContainer })
            : errorText(error),
        // 時間切れで止めた実行は、止めるまでに読めた使用量を費用にする。読めなければ不明（0 とは記録しない。PBI-281）
        ...(error instanceof AgentTimeoutError && error.usage ? { usage: error.usage } : {}),
        ...(error instanceof AgentTimeoutError && error.costUnknown
          ? { costUnknown: true as const }
          : {}),
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
    // CLI が実行の費用を報告していれば、それを使う。無ければ、モデルごとの使用量をそのモデルの単価で換算する（PBI-301）
    const cost = runCost(run.agent, outcome);
    const costUsd = cost.costUsd;
    // 費用の出どころ（CLI の報告か、使用量の換算か）を、すべての実行について記録する。Codex など、CLI が費用を報告しない
    // エージェントの実行も、「換算した額」と分かるようにする（PBI-302 D2。以前は報告とモデルごとの換算だけ記録した）
    if (cost.source) this.recordRunCost(run.runId, run.agent.id, cost);
    return {
      outcome,
      costUsd,
      estimated,
      ...(outcome.kind === "failed" && outcome.costUnknown ? { costUnknown: true as const } : {}),
    };
  }

  /** 実行の費用の出どころ（報告か換算か）を、実行中のタスクの作業履歴に記録する（PBI-301）。 */
  private recordRunCost(runId: string, agentId: string, cost: RunCost): void {
    const taskId = this.runningTask.getStore();
    const task = taskId ? this.tasks.get(taskId) : undefined;
    if (!task || task.status === "cancelled" || !cost.source) return;
    this.append(task, [
      {
        actor: "sacty",
        event: {
          type: "RunCostRecorded",
          payload: {
            runId,
            agentId,
            source: cost.source,
            amountUsd: cost.costUsd,
            convertedUsd: cost.convertedUsd,
            ...(cost.unpricedModels.length > 0 ? { unpricedModels: cost.unpricedModels } : {}),
          },
        },
      },
    ]);
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
    // 実装は、PR を作ってから承認待ちにする（PBI-110。publish の implementSubmitted）
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

  /**
   * 待つ間に人がタスクの題を変えていれば（PBI-323）、題だけを最新にしたタスク。公開は始めたときのタスクを持ったまま
   * 認証・プッシュなどを待つので、コミットのメッセージ・PR の題と本文を作る直前に、題を読み直す。
   */
  private latestTitled(task: Task): Task {
    const title = this.tasks.get(task.id)?.title;
    return title === undefined || title === task.title ? task : { ...task, title };
  }

  /**
   * その時刻（at）のタスクの題（PBI-323）。コミットは、提出ごとに決まる日時で作り、再試行しても同じコミットになるように
   * している。メッセージの題も、その日時のときの題にする（日時より後に人が題を変えても、同じ提出の再試行で別のコミットに
   * ならないように。別のコミットになると、プッシュ済みのブランチに積めない）。日時より後の最初の変更の前の題を使う。
   * 「後」は、日時の元になった記録（その日時の、題の変更でない最初の記録）より後に足した記録かで決める（時計が戻った・同じミリ秒の
   * 変更でも、同じ提出の再試行で題が変わらないように）。元の記録が見つからなければ、日時が同じか後の変更を使う。
   */
  private titleAt(task: Task, at: string): string {
    const events = this.deps.activity.forTask(task.id);
    const anchor = events.find((e) => e.type !== "TaskRenamed" && e.at === at);
    const later = events.find(
      (e) => e.type === "TaskRenamed" && (anchor ? e.seq > anchor.seq : e.at >= at),
    );
    if (later?.type === "TaskRenamed") return later.payload.from;
    return this.latestTitled(task).title;
  }

  /**
   * 人が、タスクの詳細でタスクの題を変える（PBI-323）。中止したタスク（以降の操作は受け付けない）のほかは、状態を問わない
   * （実行中・承認待ち・一時停止中・終わったタスクも変えられる）。今の実行は止めず、この後に題を使うもの（工程の指示・コミット・通知・PR の本文など）から使う。
   * すでに作った PR の題は書き換えない。空・長すぎる題は入力の誤り、今と同じ題は理由を示して断る。
   */
  renameTask(id: string, raw: unknown): Task {
    const { title } = RenameTaskInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    if (task.title === title) throw new InvalidOperationError(message("title.unchanged"));
    // 題にある PR のリンクは、レビュー・引き継ぎの対象を決める（referencedPullRequest）。題を変えて対象の PR が変わる・
    // 無くなると、途中から別の PR を扱うことになるので断る（PR から取り込んだタスクは、取り込んだ PR が対象なので問わない）
    // 作業するリポジトリを用意する前（作成の直後・準備に失敗した後）も、決まっているリポジトリ（repo）で確かめる
    const repoUrl = task.repository?.url ?? task.repo ?? task.source?.repo;
    if (repoUrl && task.source?.kind !== "github_pull_request") {
      const before = pullRequestInText(repoUrl, `${task.title}\n${task.body}`);
      const after = pullRequestInText(repoUrl, `${title}\n${task.body}`);
      if (before?.number !== after?.number) {
        throw new InvalidOperationError(
          message("title.pullRequestChanged", { number: before?.number ?? after?.number ?? 0 }),
        );
      }
    }
    return this.append(task, [
      { actor: "person", event: { type: "TaskRenamed", payload: { from: task.title, to: title } } },
    ]);
  }

  /**
   * 人が、タスクの詳細でタスクのイメージを変える（PBI-318）。工程の状態は問わない（実行中・終わった工程があっても変えられる）。
   * 今の実行は止めず、すべての工程の次の実行から使う（実行の開始で、そのときのイメージを決める）。テスト・最終レビューも、
   * 実行を始めるときのタスクのイメージを使う。再実行・作成時・プロジェクトの対象の指定より、人の変更を優先する。
   * images に無い名前（config.yaml から消した名前など）は、理由を示して断る。
   */
  changeTaskImage(id: string, raw: unknown): Task {
    const { image } = ChangeTaskImageInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    const event = this.taskImageChange(task, image);
    if (!event) throw new InvalidOperationError(message("image.unchanged", { name: image }));
    return this.append(task, [{ actor: "person", event }]);
  }

  /**
   * タスクのイメージを変えるイベント（タスクの詳細で変えるときと、再開・差し戻しと一緒に変えるときで共通）。今と同じ名前なら
   * undefined。工程が決まっていない・images に無い名前・設定を読めないときは、理由を示して断る。古い版の作業履歴で工程ごとの
   * イメージを持ち、タスクのイメージが無ければ、変える前の名前を持たない（工程ごとに違いうるため）。
   */
  private taskImageChange(task: Task, image: string): EventInput | undefined {
    if (task.steps.length === 0) {
      throw new InvalidOperationError(message("image.stepsNotChosen"));
    }
    const config = this.deps.config();
    // 設定を読めない・解析できなければ、名前を確かめられないので、その理由を示して断る（名前の誤りと取り違えないため）
    if (!config.ok) {
      throw new InvalidOperationError(
        message("image.configUnavailable", { detail: config.problem }),
      );
    }
    if (!imageDefined(this.projectImagesConfig(config.config, task.projectId), image)) {
      throw new InvalidOperationError(message("image.notInImages", { name: image }));
    }
    const legacy = task.image === undefined && Object.keys(task.images ?? {}).length > 0;
    const from = task.image ?? (legacy ? undefined : DEFAULT_IMAGE_NAME);
    if (from === image) return undefined;
    return { type: "TaskImageChanged", payload: { ...(from ? { from } : {}), to: image } };
  }

  /**
   * 人が、タスクの詳細で工程のエージェントを変える（PBI-121）。タスクのイメージ（PBI-318）と同じく、工程の状態は問わず、
   * 今の実行は止めず、その工程を次に実行するときから使う。config.yaml の step_agents より優先する。agents に無い名前は断る。
   */
  changeStepAgent(id: string, raw: unknown): Task {
    const { step, agent } = ChangeStepAgentInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (task.status === "cancelled") throw new InvalidOperationError(message("task.cancelled"));
    const event = this.stepAgentChange(task, step, agent);
    if (!event) throw new InvalidOperationError(message("agent.unchanged", { name: agent }));
    return this.append(task, [{ actor: "person", event }]);
  }

  /**
   * 工程のエージェントを変えるイベント（タスクの詳細で変えるときと、再開と一緒に変えるときで共通）。今と同じ名前なら
   * undefined。選んでいない工程・統合レビュー・agents に無い名前・設定を読めないときは、理由を示して断る。
   */
  private stepAgentChange(task: Task, step: StepKey, agent: string): EventInput | undefined {
    if (!task.steps.some((s) => s.key === step)) {
      throw new InvalidOperationError(message("agent.stepMissing"));
    }
    // 統合レビューのエージェントは、config.yaml の step_agents.integrate で決める。画面で出さないだけでなく、API でも断る
    // （PR #131 レビュー指摘）
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
    if (from === agent) return undefined;
    return { type: "StepAgentChanged", payload: { step, from, to: agent } };
  }

  /**
   * 再開・差し戻しと一緒に変えるタスクのイメージ（PBI-318）・工程のエージェントのイベント（今と同じ名前は除く）。誤った
   * 名前・工程があれば、理由を示して断る（何も記録しない）。
   */
  private stepSettingChanges(
    task: Task,
    input: { image?: string; agents?: Partial<Record<StepKey, string>> },
  ): { actor: Actor; event: EventInput }[] {
    const events: { actor: Actor; event: EventInput }[] = [];
    if (input.image !== undefined) {
      const event = this.taskImageChange(task, input.image);
      if (event) events.push({ actor: "person", event });
    }
    for (const [step, agent] of Object.entries(input.agents ?? {}) as [StepKey, string][]) {
      const event = this.stepAgentChange(task, step, agent);
      if (event) events.push({ actor: "person", event });
    }
    return events;
  }

  /** 人が選んだ工程のエージェントが config.yaml から消えていたら、理由を示して一時停止する（PBI-121）。 */
  /**
   * 人が選んだエージェントが設定から消えていたので、理由を示して一時停止する。awaiting なら、承認待ち（PR の指摘の戻し先の判断。
   * PBI-332）からも止める。
   */
  private pauseForMissingAgent(
    task: Task,
    step: StepKey,
    name: string,
    options: { awaiting?: boolean } = {},
  ): void {
    const latest = this.mustGet(task.id);
    const pausable =
      latest.status === "queued" ||
      latest.status === "idle" ||
      (options.awaiting === true && latest.status === "awaiting_approval");
    if (!pausable || this.cancelling.has(task.id)) return;
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
    if (task.status !== "escalated" || open?.id !== proposalId) {
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

  /** 画面のデスクトップ通知のための、after より後の通知（PBI-38 の通知と同じもの）。 */
  notificationFeed(after: number | undefined): FeedReply {
    return this.deps.feed?.since(after) ?? { boot: "", latest: 0, items: [] };
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
        // 完了したタスクの作業領域を、答えるために用意し直したなら、また消す（PBI-157）
        void this.retireWorkspace(id);
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
    // オーケストレーターに使う AI（step_agents.orchestrator か default_agent。PBI-40）。利用制限中か、このタスクで失敗したなら、代わりの
    // エージェント（agents の fallback）
    const agent = this.usableAgent(config, agentFor(config, "orchestrator"), task.id, "chat");
    const setting = { agentId: agent.id, ...agentSetting(agent), runId: chat.runId };
    let payload: Extract<EventInput, { type: "QuestionAnswered" }>["payload"];
    // 各実行のセッションログを、答えの実行ごとの場所に並べて、読み取り専用でマウントする（PBI-91）
    const logsDir = join(this.deps.workspaceRoot, "_question-logs", chat.runId);
    try {
      const activity = this.deps.activity.forTask(task.id);
      // 実行中の工程のログも、いまの写しを読ませる（処理が長引いているときに、いまの様子を答えられるように）
      const logs = this.stageQuestionLogs(task.id, activity, logsDir, chat.runId, true);
      // オーケストレーターのセッションを複製して答える（作業中のセッションには話しかけない。PBI-67）
      const { outcome, costUsd, estimated, costUnknown, runId } = await this.runGuardian(
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
        ...unknownCost({ costUnknown }),
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

  // ─── エラーレポート ───────────────────────────────────────────────────────────

  /**
   * タスクのエラーレポート（Markdown）。sacty の処理（作業履歴）・各実行のエージェントの動き（セッションログ）・エラーの詳細と、
   * あればオーケストレーターの分析をまとめる。タスクが無ければ undefined。
   */
  errorReport(id: string, locale: ReportLocale): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return buildErrorReport({
      task,
      activity: this.deps.activity.forTask(id),
      projectName: this.deps.projects.get(task.projectId)?.name,
      ...(this.deps.sessionLogs ? { logs: this.deps.sessionLogs } : {}),
      generatedAt: new Date().toISOString(),
      locale,
    });
  }

  /**
   * エラーレポートのために、オーケストレーターにエラーを分析させる。求めを記録し、分析は待たずに返す（analyzed で待てる）。
   * 作業中のタスクでも求められ、タスクの状態・工程・承認済みの内容は変えない。中止したタスク・予算の上限に達したタスクでは
   * 求められない。分析を待つ求めは、1タスクに1件まで。
   */
  analyzeErrors(id: string): { task: Task; analyzed: Promise<void> } {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    const blocked = errorAnalysisBlocked(task);
    if (blocked) throw new InvalidOperationError(blocked);
    if (this.cancelling.has(id)) throw new InvalidOperationError(message("task.cancelled"));
    if (this.stopping) throw new InvalidOperationError(message("errorReport.stopping"));
    const config = this.deps.config();
    if (!config.ok) throw new InvalidOperationError(message("errorReport.unavailable"));
    const analysisId = `A-${task.errorAnalyses.length + 1}`;
    const requested = this.append(task, [
      { actor: "person", event: { type: "ErrorAnalysisRequested", payload: { analysisId } } },
    ]);
    const entry: { runId: string; done: Promise<void> } = {
      runId: randomUUID(),
      done: Promise.resolve(),
    };
    const analyzed = this.runErrorAnalysis(requested, analysisId, entry, config.config)
      .catch((error) => {
        console.error(`[daemon] could not record the error analysis for task ${id}:`, error);
      })
      .finally(() => {
        if (this.analyses.get(id) === entry) this.analyses.delete(id);
        void this.retireWorkspace(id);
      });
    entry.done = analyzed;
    this.analyses.set(id, entry);
    return { task: requested, analyzed };
  }

  /**
   * オーケストレーターに、エラーレポートとセッションログを読ませてエラーを分析させる。質問への答えと同じく、オーケストレーターの
   * セッションの複製で実行し（role は chat）、用意済みのタスクは起点のコードの使い捨ての写しを渡す。分析から秘密情報を
   * 取り除いてから、長ければ切り詰める。分析できなくても、使った分の費用は記録する。
   */
  private async runErrorAnalysis(
    task: Task,
    analysisId: string,
    run: { runId: string },
    config: SactyConfig,
  ): Promise<void> {
    const agent = this.usableAgent(config, agentFor(config, "orchestrator"), task.id, "chat");
    const setting = { agentId: agent.id, ...agentSetting(agent), runId: run.runId };
    let payload: Extract<EventInput, { type: "ErrorAnalyzed" }>["payload"];
    const logsDir = join(this.deps.workspaceRoot, "_question-logs", run.runId);
    try {
      const activity = this.deps.activity.forTask(task.id);
      const logs = this.stageQuestionLogs(task.id, activity, logsDir, run.runId, true);
      const report = buildErrorReport({
        task,
        activity,
        projectName: this.deps.projects.get(task.projectId)?.name,
        ...(this.deps.sessionLogs ? { logs: this.deps.sessionLogs } : {}),
        generatedAt: new Date().toISOString(),
        locale: "ja",
        includeAnalysis: false,
        // 伏せ直しを経ていない（デーモンが止まって閉じられなかった）実行のログは、AI に渡さない
        omitStaleLogs: true,
      });
      let reportFile = false;
      if ("runs" in logs) {
        try {
          writeFileSync(join(logsDir, ERROR_REPORT_FILE), report, { mode: 0o600 });
          reportFile = true;
        } catch {
          reportFile = false;
        }
      }
      const { outcome, costUsd, estimated, costUnknown, runId } = await this.runGuardian(
        task,
        {
          agent,
          image: config.image,
          prompt: buildErrorAnalysisPrompt(task, report, logs, reportFile),
          role: "chat",
          ...("runs" in logs
            ? {
                mounts: [{ hostPath: logsDir, containerPath: CONTAINER_LOGS_DIR, readOnly: true }],
                readDirs: [CONTAINER_LOGS_DIR],
              }
            : {}),
          runId: run.runId,
          stopped: () => this.cancelling.has(task.id),
          onRunId: (next) => {
            run.runId = next;
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
        ...unknownCost({ costUnknown }),
      };
      const text = outcome.kind === "completed" ? outcome.output.trim() : "";
      if (this.cancelling.has(task.id)) {
        payload = {
          analysisId,
          failed: message("errorReport.cancelled"),
          runResult: "interrupted",
          ...cost,
        };
      } else if (this.stopping && outcome.kind === "failed") {
        // デーモンを止めるために止めた実行は、中断として記録する（費用は残す）
        payload = {
          analysisId,
          failed: message("run.daemonStopped"),
          runResult: "interrupted",
          ...cost,
        };
      } else if (outcome.kind === "failed") {
        payload = {
          analysisId,
          failed: message("errorReport.failed", { detail: outcome.message }),
          runResult: "failed",
          ...cost,
        };
      } else if (!text) {
        payload = {
          analysisId,
          failed: message("errorReport.empty"),
          runResult: "failed",
          ...cost,
        };
      } else {
        payload = {
          analysisId,
          analysis:
            text.length > ERROR_ANALYSIS_MAX ? `${text.slice(0, ERROR_ANALYSIS_MAX - 1)}…` : text,
          runResult: "completed",
          ...cost,
        };
      }
    } catch (error) {
      payload = {
        analysisId,
        failed: message("errorReport.failed", { detail: errorText(error) }),
        runResult: "failed",
        ...setting,
      };
    } finally {
      // 消せなくても、結果と費用は記録する（分析待ちを残さない）
      try {
        rmSync(logsDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[daemon] エラーの分析に並べたセッションログを消せませんでした（${task.id}）：`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    const latest = this.tasks.get(task.id);
    if (
      !latest ||
      latest.status === "cancelled" ||
      pendingErrorAnalysis(latest)?.id !== analysisId
    ) {
      return;
    }
    try {
      this.append(latest, [{ actor: "orchestrator", event: { type: "ErrorAnalyzed", payload } }]);
    } catch (error) {
      const { analysis: _analysis, failed: _failed, ...rest } = payload;
      this.append(this.mustGet(task.id), [
        {
          actor: "orchestrator",
          event: {
            type: "ErrorAnalyzed",
            payload: {
              ...rest,
              failed: message("errorReport.failed", { detail: errorText(error) }),
              runResult: "failed",
            },
          },
        },
      ]);
    }
    this.warnIfNeeded(this.mustGet(task.id));
  }

  // ─── 完了したタスクの監査（PBI-125） ───────────────────────────────────────────────

  /** デーモンを止めている（止めるときの実行の失敗を、監査の失敗として記録しない）。 */
  private stopping = false;

  /** デーモンを止め始めた（main.ts が、実行中のコンテナを止める前に呼ぶ）。 */
  beginShutdown(): void {
    this.stopping = true;
  }

  /**
   * 画面から始めたエラーの分析の、結果・費用の記録と後片付けの終わり（ワーカーの外で動くので、デーモンを止めるときに
   * 作業履歴を閉じる前に待つ）。
   */
  analysesSettled(): Promise<void> {
    return Promise.all([...this.analyses.values()].map((a) => a.done)).then(() => {});
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
    // 利用制限中か、このタスクで失敗したエージェントなら、代わりのエージェント（agents の fallback）で監査する
    const agent = this.usableAgent(
      config,
      config.auditAgent,
      task.id,
      step ? "audit-dive" : "audit",
    );
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
            adoptNotes: known.adoptNotes.map((n) => ({
              ...n,
              title: hide(n.title),
              text: hide(n.text),
            })),
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
                  // 登録の前に、依頼者の答えを写していないか検査する（PBI-302 B6）
                  requesterTexts: requesterTexts(task),
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
                      ? {
                          memories: dive.memories.map((m) => ({ ...m, id: randomUUID() })),
                          ...(dive.skippedMemories.length > 0
                            ? { skippedMemories: dive.skippedMemories }
                            : {}),
                        }
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
   * 最終レビュー・統合レビューの出力から読んだ文字列に当てる、秘密情報を伏せる関数（PBI-298）。崩れを直して読んだ判定の
   * 復号した文字列と、読めなかった理由の前後の文字に使う。設定の秘密情報を取り出せなくても、よくある秘密情報の形は伏せる。
   */
  private async reviewRedactor(task: Task, config: SactyConfig): Promise<(text: string) => string> {
    try {
      return await this.auditRedactor(task, config);
    } catch {
      return (text) => redactLog(text, []);
    }
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
  /**
   * プロジェクトの不安定なテストの台帳（PBI-312）。作業履歴から導くだけで、何も記録しない。プロジェクトが無ければ null。
   */
  async projectFlakyTests(projectId: string): Promise<ProjectFlakyTests | null> {
    if (!this.deps.projects.get(projectId)) return null;
    const hide = await this.auditHide(projectId);
    return { projectId, tests: flakyTests([...this.tasks.values()], projectId, hide) };
  }

  async auditHide(projectId: string): Promise<(text: string) => string> {
    const values = await this.auditSecretValues(projectId);
    return (text: string) => redactLog(text, values);
  }

  /** プロジェクトの既存の原因（鍵・題・状態）と、人が却下した提案と理由（監査に渡す）。 */
  private knownAuditCauses(projectId: string): {
    causes: KnownAuditCause[];
    rejected: RejectedAuditProposal[];
    adoptNotes: AdoptedAuditProposalNote[];
  } {
    const causes = new Map<string, KnownAuditCause>();
    const rejected: RejectedAuditProposal[] = [];
    const adoptNotes: AdoptedAuditProposalNote[] = [];
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
          // 採用のときの手入れも渡し、同じ手入れが要る提案を繰り返させない（PBI-151）
          if (p.decision?.kind === "adopted" && p.decision.note) {
            adoptNotes.push({ title: p.title, ...p.decision.note });
          }
        }
      }
    }
    return { causes: [...causes.values()], rejected, adoptNotes };
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
   * 人が手入れ（改善案への補足か、人の案への差し替え）を添えていれば、却下の理由と同じく、記録する前に秘密情報を
   * 伏せる（手入れは監査の画面・レポートと、改修のタスクの説明に出る。PBI-151）。
   */
  async adoptAuditProposal(proposalId: string, raw: unknown): Promise<Task> {
    const { target, note } = AdoptAuditProposalInput.parse(raw);
    const check = () => {
      const found = this.findAuditProposal(proposalId);
      if (!found) throw new InvalidOperationError(message("audit.proposalNotFound"));
      // 消したプロジェクトに改修のタスクを作らない（秘密情報を取り出す間に消されたときも、確かめ直しで断る）
      if (!this.deps.projects.get(found.task.projectId)) {
        throw new InvalidOperationError(message("project.notFound"));
      }
      if (found.task.status === "cancelled") {
        throw new InvalidOperationError(message("audit.notAdoptable"));
      }
      if (found.proposal.decision) throw new InvalidOperationError(message("audit.alreadyDecided"));
      if (!found.proposal.candidates.some((c) => sameAuditTarget(c, target))) {
        throw new InvalidOperationError(message("audit.targetNotCandidate"));
      }
      return found;
    };
    let hidden = note;
    if (note) {
      const config = this.deps.config();
      const hide = config.ok
        ? await this.auditRedactor(check().task, config.config)
        : (text: string) => redactLog(text, []);
      hidden = { ...note, text: hide(note.text) };
    }
    // 秘密情報を取り出す間に、ほかの操作が判断していないかを確かめ直す
    const { task } = check();
    const fixTaskId = target.kind === "sacty" ? undefined : randomUUID();
    const updated = this.append(task, [
      {
        actor: "person",
        event: {
          type: "AuditProposalAdopted",
          payload: {
            proposalId,
            target,
            ...(fixTaskId ? { fixTaskId } : {}),
            ...(hidden ? { note: hidden } : {}),
          },
        },
      },
    ]);
    this.createAuditFixTask(updated, proposalId);
    return this.mustGet(task.id);
  }

  /** 採用した提案の改修のタスクを作る（作ってあれば・プロジェクトを消していれば何もしない）。 */
  private createAuditFixTask(task: Task, proposalId: string): void {
    if (!this.deps.projects.get(task.projectId)) return;
    const finding = task.audit?.findings.find((f) => f.proposals.some((p) => p.id === proposalId));
    const proposal = finding?.proposals.find((p) => p.id === proposalId);
    const decision = proposal?.decision;
    if (!finding || !proposal || decision?.kind !== "adopted" || !decision.fixTaskId) return;
    if (decision.target.kind === "sacty" || this.tasks.has(decision.fixTaskId)) return;
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    const title = `改修：${proposal.title}`;
    // 人が手入れを添えていれば、改修の指示に入れる。差し替えなら人の案を指示にし、監査の改善案は記録として
    // 添える（原因は認めているので、改善案だけを人のものに替える。PBI-151）
    const note = decision.note;
    const plan = note?.kind === "replace" ? note.text : proposal.body;
    const human =
      note === undefined
        ? []
        : note.kind === "replace"
          ? ["", "---", "人が改善案を差し替えました。監査が出した改善案：", "", proposal.body]
          : ["", "---", "人が足した補足：", "", note.text];
    // コンテキストにする提案は、元のメモリーを欠けずに添える（PBI-128。PR #138 レビュー指摘）
    const original = proposal.memoryOriginal;
    const body = [
      plan,
      ...human,
      "",
      "---",
      ...(original
        ? [
            `コンテキストにする元のメモリー：${original.title}（${original.summary}）`,
            "",
            original.body,
          ]
        : [`監査で見つけた原因：${finding.title}`, "", finding.detail]),
    ].join("\n");
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

  /**
   * 承認したセキュリティチェックのレポートの区分から、対応のタスク（進め方 security-fix）を作る。区分ごとに1回だけ。
   * 先に頼んだこと（ID・題・本文）を記録してから作り、途中で止まっても起動のときに作る。説明には、その区分の指摘だけを
   * 入れる（ほかの区分を混ぜると、PR が最小限でなくなるため）。
   */
  requestSecurityFix(id: string, raw: unknown): Task {
    const { category } = RequestSecurityFixInput.parse(raw);
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (!this.deps.projects.get(task.projectId)) {
      throw new InvalidOperationError(message("project.notFound"));
    }
    const findings = securityFindings(task);
    if (!findings) throw new InvalidOperationError(message("security.notReport"));
    if (task.securityFixes?.[category]) {
      throw new InvalidOperationError(message("security.alreadyRequested"));
    }
    if (!findings.some((f) => f.category === category)) {
      throw new InvalidOperationError(message("security.noFindings"));
    }
    const { title, body } = securityFixTask(task, category, findings);
    const listed = findings.filter((f) => f.category === category);
    const updated = this.append(task, [
      {
        actor: "person",
        event: {
          type: "SecurityFixRequested",
          payload: { category, taskId: randomUUID(), title, body, findings: listed },
        },
      },
    ]);
    this.createSecurityFixTask(updated, category);
    return this.mustGet(task.id);
  }

  /** 承認したセキュリティチェックのレポートの指摘。レポートでない・一覧を読めなければ空。 */
  securityFindings(id: string): SecurityFinding[] {
    const task = this.tasks.get(id);
    return (task && securityFindings(task)) ?? [];
  }

  /** 頼んだセキュリティ対応のタスクがまだ無ければ作る（作ってあれば・プロジェクトを消していれば何もしない）。 */
  private createSecurityFixTask(task: Task, category: SecurityCategory): void {
    const requested = task.securityFixes?.[category];
    if (!requested || this.tasks.has(requested.taskId)) return;
    if (!this.deps.projects.get(task.projectId)) return;
    const repo = task.repo ?? task.repository?.url;
    const config = this.deps.config();
    const budgetCapUsd = config.ok ? config.config.budgetPerTaskUsd : DEFAULT_BUDGET_USD;
    this.append({ id: requested.taskId, projectId: task.projectId }, [
      {
        actor: "sacty",
        event: {
          type: "TaskCreated",
          payload: {
            title: requested.title,
            body: requested.body,
            start: "security",
            ...(repo ? { repo } : { noRepo: true as const }),
            budgetCapUsd,
            plan: "security-fix",
            securityFix: { taskId: task.id, category, findings: requested.findings },
          },
        },
      },
    ]);
  }

  /** 頼んだことを記録したが、作る前に止まったセキュリティ対応のタスクを作る（起動のとき）。 */
  resumeSecurityFixTasks(): void {
    for (const task of [...this.tasks.values()]) {
      for (const category of Object.keys(task.securityFixes ?? {}) as SecurityCategory[]) {
        this.createSecurityFixTask(this.mustGet(task.id), category);
      }
    }
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
   * ときは、理由を返す（答えは台帳だけで作る）。並べるのは、このタスクの終わった実行の分と、includeRunning なら
   * 実行中の実行のいまの写し。
   */
  private stageQuestionLogs(
    taskId: string,
    activity: readonly ActivityEvent[],
    dest: string,
    chatRunId: string,
    includeRunning = false,
  ): ChatLogs {
    const store = this.deps.sessionLogs;
    if (!store) return { unavailable: "セッションログを残していない" };
    try {
      return stageQuestionLogs({
        store,
        taskId,
        activity,
        dest,
        exclude: [chatRunId],
        includeRunning,
      });
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
    // 重ねていた依存先が中止された子タスクは、依存先の変更の上に作ったので進めない（PBI-317。中止はできる）
    const cancelledDependency = this.cancelledInStack(task);
    if (cancelledDependency) {
      throw new InvalidOperationError(
        message("stack.dependencyCancelled", { title: cancelledDependency.title }),
      );
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
    // テストのコマンドが決まらずに止まったタスクは、人がテストの扱いを決めて再開できる。決めずに再開したら、まだどの
    // 工程も始めていなければ、工程の選択からやり直す（同じ工程のまま進めて、費用をかけた後の検証で同じ理由で止まらないように）
    if (input.tests) {
      if (!canDecideTests(task)) {
        throw new InvalidOperationError(message("resume.testsNotUndecided"));
      }
      if (
        input.tests.noTestsReason !== undefined &&
        task.steps.some((s) => s.key === "reproduce")
      ) {
        throw new InvalidOperationError(message("resume.bugfixNeedsTestCommand"));
      }
      events.push({ actor: "person", event: { type: "TestsDecided", payload: input.tests } });
    }
    // 再開と一緒に、タスクのイメージ・工程のエージェントを変える（タスクの詳細で変えるのと同じ）。テストが決まらないことで
    // 止めない（PBI-331）ので、それを理由に工程の選択からやり直すことはない
    events.push(...this.stepSettingChanges(task, input));
    // 補足を足した説明が、再実行の画面で直す説明の上限を超えるなら断る（人が自分の補足を削らないと再実行できなくなる）。
    // 確かめるのは再開の時点の説明（チケットのトリアージで説明を書き換えるタスクは、その後に超えることがある）
    if (input.note) {
      const room = resumeNoteRoom(task);
      if (input.note.length > room) {
        throw new InvalidOperationError(message("resume.bodyTooLong", { room: Math.max(room, 0) }));
      }
    }
    events.push({
      actor: "person",
      event: {
        type: "TaskResumed",
        payload: {
          retry: task.resumeTo === "queued",
          ...(input.note ? { note: input.note } : {}),
        },
      },
    });
    // 人が再開したら、代わりのエージェントを試し終えたことを忘れる（もう一度、選んだエージェントから順に試す）
    this.fallbackTried.delete(id);
    const resumed = this.append(task, events);
    // 実装の作り直しの途中で止まっていたなら、走り直す前に、PR に届いた指摘をもう一度読む（PBI-279）
    if (reworkingPullRequest(resumed)) this.heldRecheck.add(id);
    return resumed;
  }

  /**
   * 実装の検証が続けて通らずに止まったタスクを、人の判断で、ゴールガーディアンの不合格のまま実装の承認（PR のレビュー）へ
   * 進める。sacty が実装の PR のドラフトを外し、レビュー用のラベルを付けて、実装の承認待ちにする（検証に通ったときと同じ）。
   * 最終レビューはやり直さない。
   */
  submitForReview(id: string, options: { containersConfirmed?: boolean } = {}): Task {
    const task = this.tasks.get(id);
    if (!task) throw new InvalidOperationError(message("task.notFound"));
    if (!canOverrideVerification(task)) {
      throw new InvalidOperationError(message("override.notAllowed"));
    }
    // 止めたコンテナがまだ残っているかもしれないうちは、進めない（作業領域を取り合うため）
    if (task.unstoppedRuns?.length && !options.containersConfirmed) {
      throw new InvalidOperationError(this.notStopped(task.unstoppedRuns));
    }
    return this.append(task, [
      { actor: "person", event: { type: "VerificationOverridden", payload: {} } },
    ]);
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
   * options.aiReview は、comments のうち、AI のレビュー（sacty のレビューのタスクが PR に投稿したもの）の指摘の位置
   * （PR の指摘の取り込みだけが渡す。PBI-275）。AI のレビューの指摘だけの差し戻しは、人の差し戻しの回数と上限に数えない
   * （人の指摘が1件でも混ざれば数える）。
   */
  requestChanges(id: string, raw: unknown, options: { aiReview?: readonly number[] } = {}): Task {
    const input = RequestChangesInput.parse(raw);
    const task = this.gateTask(id, input.step, input.submission);
    // やり直す工程は、ゲートの工程か、それより前の工程エージェントが作る工程。
    // 実装のゲートでは、省略すると実装をやり直す
    const targets = reworkTargets(task, input.step);
    const target = input.target ?? targets[0];
    if (!target || !targets.includes(target)) {
      throw new InvalidOperationError(message("gate.invalidTarget"));
    }
    // 人が差し戻した回数（上限に数える）。AI のレビューの指摘だけの回は含めない（PBI-275）
    const rounds = changeRounds(task, target);
    const aiIndexes = new Set(options.aiReview ?? []);
    const comments = input.comments.map((text, i) => ({
      text,
      ...(aiIndexes.has(i) ? { source: "sacty_review" as const } : {}),
    }));
    const onlyAiReview = comments.length > 0 && comments.every((c) => c.source === "sacty_review");

    if (task.status === "awaiting_approval" && input.comments.length === 0) {
      throw new InvalidOperationError(message("gate.remarksRequired"));
    }
    // 差し戻しと一緒に、タスクのイメージ・工程のエージェントを変える（タスクの詳細で変えるのと同じ）。差し戻しの前に同じ書き込みで
    // 記録し、やり直す工程から使う。上限でエスカレーションするときも記録する（人の指定を黙って失わないため）
    const settings = this.stepSettingChanges(task, input);
    // 回の番号と指摘の ID は、AI のレビューだけの回も含めて続ける（人の差し戻しの回数とは別）
    const round = lastChangeRound(task, target) + 1;
    const toRemarks = (list: { text: string; source?: "sacty_review" }[]) =>
      list.map(({ text, source }, i) => ({
        id: `${target}-${round}-${i + 1}`,
        text,
        ...(source ? { source } : {}),
      }));

    if (task.status === "awaiting_approval" && !onlyAiReview && rounds >= MAX_CHANGE_REQUESTS) {
      return this.append(task, [
        ...settings,
        {
          actor: "sacty",
          event: {
            type: "TaskEscalated",
            payload: {
              step: input.step,
              target,
              reason: "too_many_changes",
              pendingRemarks: toRemarks(comments),
            },
          },
        },
      ]);
    }

    let remarks = toRemarks(comments);
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
        remarks = toRemarks(task.escalation.pendingRemarks);
      }
      if (remarks.length === 0) {
        throw new InvalidOperationError(message("gate.remarksRequired"));
      }
    }
    // ゴールガーディアンが最終レビューで合格にした成果物を、見逃しが原因として差し戻したら、見逃しとして記録する
    // 統合レビュー（PBI-31）で合格にしたものを差し戻した場合も、見逃しとして記録する。base の変化による競合や、
    // 新しく足した要望・方針の変更による差し戻し、原因を決めていない差し戻しは、見逃しにしない（PBI-268）
    const review =
      input.step === "implement"
        ? task.lastReview
        : input.step === "integrate"
          ? task.integration
          : undefined;
    const missed =
      input.cause === "guardian_missed" &&
      review?.passed &&
      !task.misses.some((m) => m.reviewAt === review.at)
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
      ...settings,
      ...missed,
      {
        // AI のレビューの指摘だけの差し戻しは、人の操作にしない（作業履歴・監査で人の差し戻しと分けるため。PBI-275）
        actor:
          remarks.length > 0 && remarks.every((r) => r.source === "sacty_review")
            ? "sacty"
            : "person",
        event: {
          type: "ChangesRequested",
          payload: {
            step: input.step,
            target,
            round,
            remarks,
            overLimit,
            ...(input.cause ? { cause: input.cause } : {}),
            ...(input.cause === "question_answer" && input.answer ? { answer: input.answer } : {}),
          },
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
      // コメントが付いた行の内容と直前の行を添える（行番号だけに頼って 1 行ずれて読まないため。PBI-302 B3）。添える分は
      // 切らない（指摘の文を、その分だけ短くして上限に収める）
      const context = item.lineContext ? `\n${lineContextText(item.lineContext)}` : "";
      const text = `${item.path}${item.line ? `:${item.line}` : ""}：${body}`;
      return context
        ? `${text.length + context.length > REMARK_MAX ? `${text.slice(0, Math.max(0, REMARK_MAX - context.length - 1))}…` : text}${context}`
        : cut(text);
    }
    return cut(body || `${item.author} が PR の変更を求めました（コメントなし）。`);
  });
}

/** 捨てた AI のレビューの指摘の要点として、承認の画面に出す本文の長さ（文字数）。 */
const DISCARDED_SUMMARY_MAX = 400;

/**
 * 古い head へのレビューとして捨てた AI のレビューの指摘の、要点（PBI-291）。取り込む指摘と同じ文（行へのコメントはファイルと
 * 行つき）の先頭を、目印と見出しを除き、空白をそろえて切る。人に届けるための表示用で、作り直しには渡さない。
 */
function discardedSummary(item: PullRequestFeedback): string {
  // 投稿の先頭の目印（HTML のコメント）と見出しは、人が読む要点に要らない
  // 行の内容の添え書きは、表示用の要点には要らない
  const text = (feedbackRemarks([{ ...item, lineContext: undefined }])[0] ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*#+\s*sacty のレビュー\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > DISCARDED_SUMMARY_MAX
    ? `${text.slice(0, DISCARDED_SUMMARY_MAX - 1)}…`
    : text;
}

/**
 * オーケストレーターが選んだ工程（作業履歴の StepsChosen）と、ベースブランチ（PBI-25）。ベースブランチは、
 * 既定のブランチと違えば用意し直して RepositoryPrepared として記録する。
 */
type ChosenSteps = Extract<EventInput, { type: "StepsChosen" }>["payload"] & {
  baseBranch?: string;
  /**
   * タスクにある既存の PR を引き継いで直す（オーケストレーターの判断）。sacty が PR を確かめて、StepsChosen の
   * continuedPullRequest にする。
   */
  continuePullRequest?: true;
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
 * 古い版（PBI-318 より前）の作業履歴で、人が作成時に、進め方のすべての工程のイメージを指定したタスクか。工程を選び直すときは、
 * その指定を工程のイメージにする（投影が入れる）ので、タスクのイメージを決めない。
 */
function legacyAllRequested(task: Task): boolean {
  return (
    task.requestedImage === undefined &&
    task.requestedPlan !== undefined &&
    STEP_PLANS[task.requestedPlan].every((step) => task.requestedImages?.[step])
  );
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

/**
 * 作業領域に残っているかを確かめる、取り込みで競合したファイル（ベースブランチの取り込みと、まだ提出していない、人が PR に
 * 足したコミットの取り込み。PBI-334）。
 */
function pendingConflicts(task: Task): string[] {
  return [
    ...new Set([
      ...(task.baseMerge?.conflicts ?? []),
      ...(pendingHeadMerge(task)?.conflicts ?? []),
    ]),
  ];
}

function sameRepo(a: string, b: string): boolean {
  return repoKey(a) === repoKey(b);
}

/**
 * PR のレビューの取り込みのタスクの工程（レビューだけ。工程の選択にオーケストレーターは使わないので費用は無い。PBI-44）。
 * imageChosen は、レビューの工程のイメージだけをオーケストレーターに選ばせたとき（費用は、選ばせた実行の分を足す）。
 */
function reviewOnlySteps(via: "requested" | "label" | "sacty", imageChosen = false): ChosenSteps {
  return {
    steps: [...STEP_PLANS.review],
    plan: "review",
    reason: message(imageChosen ? "review.reviewOnlyImageChosen" : "review.reviewOnly", { via }),
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
/**
 * 引き継いだ既存の PR で、実装の工程の指示に渡した指摘か（ContinuedFeedbackPassed）。実装に対応させたので、PR の指摘として
 * 取り込み直さない（取り込むと、対応した指摘で差し戻しを繰り返す）。渡していない指摘は、ほかの PR と同じく取り込む。
 */
function handedOverFeedback(
  task: Task,
  pr: { repo?: string; number?: number },
  item: { key: string },
): boolean {
  const continued = task.continuedPullRequest;
  if (!continued || pr.number !== continued.number) return false;
  if (!pr.repo || !sameRepo(pr.repo, continued.repo)) return false;
  return (task.handedOverFeedback ?? []).includes(item.key);
}

/**
 * 人に確かめてほしいことを、PR に知らせる機会か（PBI-301）。承認待ちに入ったとき、または一時停止から同じ提出の承認待ちに
 * 戻ったとき。承認待ちの間に別の記録が増えただけの変化では知らせ直さない。一時停止のあいだに知らせを書けなかった提出は、
 * 再開のときにもう一度試す（書く前に目印で見つけたコメントを確かめるので、書き直さない）。
 */
function humanAskDue(before: Task | undefined, after: Task): boolean {
  if (after.status !== "awaiting_approval" || !after.gate) return false;
  const same =
    before?.gate?.step === after.gate.step && before.gate.submission === after.gate.submission;
  return !(before?.status === "awaiting_approval" && same);
}

/** 2つのコミットが同じか（長さが違っても、短い方が先頭に一致すれば同じ。大文字・小文字は区別しない）。 */
function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/** PR をレビューした sacty のタスクの回を、指摘の有無にかかわらず含めるものにする（引き継いだ PR の指摘を工程に渡すため）。 */
function allSactyReviews(reviews: { sactyReviews?: SactyReviewRound[] }): {
  sactyReviews?: SactyReviewRound[];
} {
  return reviews.sactyReviews
    ? { sactyReviews: reviews.sactyReviews.map((r) => ({ ...r, allowed: true })) }
    : {};
}

function sactyBranches(task: Task): string[] {
  const branches = [
    (task.pushedBranch ?? task.pullRequest)?.branch,
    task.taskBranch?.branch,
    ...task.stepBranches,
  ];
  // 引き継いだ既存の PR のブランチは、人のブランチなので消さない
  const continued = task.continuedPullRequest?.branch;
  return [...new Set(branches.filter((b): b is string => Boolean(b) && b !== continued))];
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

/**
 * 再現の工程のエージェントの申告から、再現の確かめの記録を作る（PBI-29）。再現のテストを申告し、そのテストが不具合のために
 * 失敗したことを確かめたと申告したときだけ、再現できたとする。
 */
function reproductionChecked(
  tests: string[],
  check: ReturnType<typeof extractReproduction>["check"],
): Extract<EventInput, { type: "ReproductionChecked" }>["payload"] {
  if (tests.length === 0) return { reproduced: false, tests, note: message("reproduce.noTests") };
  if (!check) return { reproduced: false, tests, note: message("reproduce.notChecked") };
  // 失敗した（0 でない整数の）終了コードの申告があるときだけ、再現できたとする（申告が無い・0 なら確かめていない）
  const reproduced = check.reproduced && check.exitCode !== undefined && check.exitCode !== 0;
  return {
    reproduced,
    tests,
    ...(check.command ? { command: check.command } : {}),
    ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
    output: check.output,
    ...(reproduced ? {} : { note: message("reproduce.notChecked") }),
    durationMs: 0,
  };
}

/** 再現の工程が終わり、再現の確かめの記録を待っている（PBI-29。それより前の版の記録だけ）。 */
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

/**
 * 承認した工程の成果で頼まれた PR・Issue へのコメントを、まだ投稿していない工程（承認し直したら、その版を投稿する）。
 * レビューは、書いたレビューを投稿するので除く。中止・一時停止中・実行中は投稿しない。
 */
export function awaitingGitHubComments(task: Task): StepKey | undefined {
  if (task.status === "cancelled" || task.status === "paused" || task.status === "running") {
    return undefined;
  }
  // セキュリティのタスクの成果（レポート・修正の範囲）は、攻撃の手がかりになるので、PR・Issue に投稿しない
  if (isSecurityTask(task)) return undefined;
  return task.steps
    .map((s) => s.key)
    .find((step) => {
      const approved = task.approved[step];
      return (
        step !== "review" &&
        approved !== undefined &&
        mentionsGitHubComments(approved.output) &&
        task.githubComments?.[step]?.approvedAt !== approved.at &&
        // 承認を待つ間に、その提出の頼みを投稿済みなら、承認の後に重ねて投稿しない（PBI-301）
        task.githubComments?.[step]?.submission !== approved.submission
      );
    });
}

/**
 * PR のマージで承認する工程（実装・要求要件・設計）の、承認を待つ提出の成果で頼まれた PR・Issue へのコメントを、まだ
 * 投稿していない工程（PBI-301）。マージを待たずに、指摘への返信などを、PR を見ている人が読めるようにする。承認の後の投稿
 * （awaitingGitHubComments）と同じく、レビューの工程・セキュリティのタスク・中止・一時停止中・実行中は投稿しない。
 * その提出の頼みは、1回だけ投稿する（承認されたら、承認の後には重ねて投稿しない）。
 */
export function awaitingSubmittedGitHubComments(task: Task): StepKey | undefined {
  if (task.status !== "awaiting_approval" || isSecurityTask(task)) return undefined;
  const gate = task.gate;
  const pr = gatePullRequest(task);
  if (!gate || gate.step === "review" || pr?.step !== gate.step || pr.state !== "open") {
    return undefined;
  }
  const output = task.outputs[gate.step];
  return output !== undefined &&
    mentionsGitHubComments(output) &&
    task.githubComments?.[gate.step]?.submission !== gate.submission
    ? gate.step
    : undefined;
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
    // セキュリティチェックのレポートは、攻撃の手がかりになるので、取り込み元に返さない
    !isSecurityTask(task) &&
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

/** コンテナが止まったことを確かめられずに失敗した実行の結果か（run.containerNotConfirmed）。 */
function notConfirmed(outcome: AgentOutcome): boolean {
  return (
    outcome.kind === "failed" &&
    typeof outcome.message === "object" &&
    outcome.message.code === "run.containerNotConfirmed"
  );
}

/**
 * signal が中断されたら、work の結果を待たずに、中断の理由で失敗する（PBI-292。通信が signal を無視しても、待ちから戻れるように）。
 * 中断した後の work の失敗は、ここでは扱わない（呼ぶ側が、signal を通信に渡して止める）。
 */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * レビューの子タスクの題（PBI-330）。親の題と PR の番号から作る（題は 200 文字までに切る）。
 */
export function reviewTaskTitle(parentTitle: string, number: number): string {
  // 言語に依存しない形にする（画面の言語を変えても、英語の画面に日本語の語が出ない。PBI-330 レビュー指摘）
  const head = `[PR #${number}] `;
  const room = 200 - head.length;
  // 文字の途中（サロゲートペアの間）で切らない
  let cut = room - 1;
  if (parentTitle.length > room && /[\uDC00-\uDFFF]/.test(parentTitle[cut] ?? "")) cut--;
  const title = parentTitle.length > room ? `${parentTitle.slice(0, cut)}…` : parentTitle;
  return `${head}${title}`;
}
