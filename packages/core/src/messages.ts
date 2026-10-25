import { z } from "zod";
import { formatUsd } from "./cost.js";
import {
  AUDIT_ADOPT_NOTE_MAX,
  QUESTION_MAX,
  RERUN_NOTE_MAX,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
} from "./events.js";
import { DaemonText } from "./message-code.js";
import { PROJECT_EXPORT_VERSION } from "./projects.js";
import { SCHEDULE_NAME_MAX } from "./schedules.js";

/** 英語の分の数（1 なら単数。PBI-150 で 1 分を設定できるようになったため。PR #169 レビュー提案）。 */
const minutesEn = (n: number) => `${n} ${n === 1 ? "minute" : "minutes"}`;

const Scope = z.enum(["org", "repo"]);
const Count = z.number().int().nonnegative();

/** 引数のうち、それ自体が文（外から来た文か、コードと引数の文言）であるもの。表示の前に文にする。 */
const TextParam = DaemonText;

/**
 * デーモンが利用者に向けて返す文言のコードと、その引数の形（PBI-11）。デーモンはコードと引数で返し、
 * 画面が画面の言語の文言にする。引数の無いコードは null。引数は表示の前にこの形で確かめ、
 * 合わなければ（版の違いなど）コードを出す。
 * 外から来た文（git や GitHub のエラーなど）は、引数としてそのまま渡し、翻訳しない。
 */
const PARAMS = {
  "task.notFound": null,
  "task.repositoryMissing": z.object({ project: z.string() }),
  "task.repositoryUnknown": z.object({ project: z.string() }),
  "task.templateRepositoryRequired": null,
  "task.reviewPlanNeedsPullRequest": null,
  "task.cancelled": null,
  "task.invalidState": null,
  "project.notFound": null,
  "project.targetDuplicated": z.object({ scope: Scope, target: z.string() }),
  "project.targetTaken": z.object({ scope: Scope, target: z.string(), project: z.string() }),
  "project.ticketKeyDuplicated": z.object({ platform: z.string(), key: z.string() }),
  "project.ticketKeyTaken": z.object({
    platform: z.string(),
    key: z.string(),
    project: z.string(),
  }),
  "project.sharedComposeDuplicated": z.object({ name: z.string() }),
  "project.hasActiveTasks": z.object({ count: Count }),
  "pause.alreadyPaused": null,
  "pause.awaitingPerson": null,
  "pause.waitingTasks": null,
  "pause.guardianJudging": null,
  "pause.reachedApproval": null,
  "cancel.alreadyCancelled": null,
  "cancel.cleaningUp": null,
  "cancel.guardianJudging": null,
  "rerun.notCancelled": null,
  "rerun.notRerunnable": null,
  "rerun.alreadyRerun": null,
  "resume.notPaused": null,
  "resume.testsNotUndecided": null,
  "resume.bugfixNeedsTestCommand": null,
  "operation.incomplete": null,
  "operation.attempted": null,
  "operation.unconfirmed": null,
  "operation.connectionMissing": null,
  "resume.capRequired": null,
  "resume.capTooLow": z.object({ usedUsd: z.number().nonnegative() }),
  "containers.notStopped": z.object({ names: z.string() }),
  "change.notAwaiting": null,
  "gate.notAwaiting": null,
  "gate.stepNotAwaiting": null,
  "gate.staleSubmission": z.object({ submission: Count, current: Count }),
  "gate.invalidTarget": null,
  "gate.approveOnPullRequest": z.object({ url: z.string() }),
  "gate.reproduceNotApprovable": null,
  "reproduce.noTests": null,
  "reproduce.notChecked": null,
  "reproduce.runFailed": z.object({ detail: TextParam }),
  "gate.remarksRequired": null,
  "gate.overLimit": z.object({ limit: Count }),
  "remark.notFound": null,
  // 入力の検査（zod の検査の文言に、このコードを入れる）
  // スケジュールタスク
  "schedule.notFound": null,
  "schedule.nameRequired": null,
  "schedule.nameTooLong": null,
  "schedule.timeInvalid": null,
  "schedule.daysRequired": null,
  "schedule.dayInvalid": null,
  "schedule.projectMissing": null,
  "input.titleRequired": null,
  "input.titleTooLong": null,
  "input.bodyTooLong": null,
  "input.noteTooLong": null,
  "input.auditNoteTooLong": null,
  "input.remarkTooLong": null,
  // オーケストレーターへの質問（PBI-54）
  "input.questionRequired": null,
  "input.questionTooLong": null,
  "chat.answering": null,
  "chat.budgetExceeded": z.object({
    usedUsd: z.number().nonnegative(),
    capUsd: z.number().nonnegative(),
  }),
  "chat.unavailable": null,
  "chat.failed": z.object({ detail: TextParam }),
  "chat.emptyAnswer": null,
  "chat.cancelled": null,
  // 成果の書き出し（PBI-56）
  "export.notDecided": null,
  "export.destinationUnknown": z.object({ name: z.string() }),
  "export.destinationMissing": z.object({ name: z.string() }),
  "export.failed": z.object({ detail: TextParam }),
  "export.unreadable": null,
  "export.budgetExceeded": null,
  "deploy.skillMissing": null,
  "deploy.skillOutside": z.object({ path: z.string() }),
  "deploy.skillUnreadable": z.object({ path: z.string(), detail: TextParam }),
  "deploy.budgetExceeded": null,
  "deploy.checkFailed": z.object({ detail: TextParam }),
  "deploy.unreadable": null,
  "deploy.undetermined": null,
  "deploy.stopped": null,
  "deploy.noSkill": null,
  "deploy.skillLookupFailed": z.object({ detail: TextParam }),
  "deploy.stepSkipped": z.object({ detail: TextParam }),
  "export.stopped": null,
  "export.notRetryable": null,
  "input.tooManyRemarks": null,
  "input.nameRequired": null,
  "input.invalidGithubName": null,
  "input.invalidRepo": null,
  "input.invalidOrg": null,
  "input.urlSsh": null,
  "input.urlNotHttps": null,
  "input.urlCredentials": null,
  "input.urlHost": null,
  "input.urlExtraPath": null,
  "input.repoLooksLikeOrg": null,
  "input.orgLooksLikeRepo": null,
  "input.invalidHost": null,
  "input.contextRepoRequired": null,
  // 共用の compose（PBI-70）
  "input.sharedComposeName": null,
  "input.sharedComposeRepoRequired": null,
  "input.sharedComposeRepoCredential": null,
  "input.sharedComposeRepoForm": null,
  "input.sharedComposeFile": null,
  "input.invalidRef": null,
  "input.invalidContextPath": null,
  "input.invalidLabel": null,
  "input.issueIntervalInvalid": null,
  "input.reviewIntervalInvalid": null,
  "input.ticketIntervalInvalid": null,
  "input.notExportFile": null,
  "input.unsupportedVersion": null,
  "input.exportVersionWithNotification": null,
  // 入力の検査のうち、コードを指定していない検査（zod の標準の検査。issueMessage で変換する）
  "input.required": null,
  "input.tooShort": z.object({ minimum: Count }),
  "input.tooLong": z.object({ maximum: Count }),
  "input.tooFew": z.object({ minimum: Count }),
  "input.tooMany": z.object({ maximum: Count }),
  "input.numberTooSmall": z.object({ minimum: z.number(), inclusive: z.boolean() }),
  "input.numberTooLarge": z.object({ maximum: z.number(), inclusive: z.boolean() }),
  "input.invalidType": null,
  "input.invalidFormat": null,
  "input.invalidValue": null,
  "input.unknownKeys": z.object({ keys: z.string() }),
  "input.invalid": null,
  "input.secretName": null,
  "input.secretRef": null,
  "input.invalidUrl": null,
  "input.reasoningEffort": null,
  "input.imageName": null,
  "config.hostAddress": null,
  "config.npmVersion": null,
  "config.agentNameEmpty": null,
  "config.npmConfigKey": null,
  "config.npmConfigSecret": null,
  // 言語ごとのイメージ（PBI-41）
  "config.imageName": null,
  "config.imageEnvName": null,
  "config.imageEnvSecret": null,
  "config.imageEnvReserved": null,
  "config.mavenMirror": null,
  "config.imagePackage": null,
  "config.imageRun": null,
  "config.imageRepo": null,
  "config.imageRepoPackages": null,
  "image.unknown": z.object({ name: z.string() }),
  // 工程のイメージを人が変える（PBI-106）
  "image.notInImages": z.object({ name: z.string() }),
  "image.unchanged": z.object({ name: z.string() }),
  "image.configUnavailable": z.object({ detail: TextParam }),
  "image.stepMissing": null,
  // docker compose のサービス（PBI-47）
  "services.unsafe": z.object({ file: z.string(), detail: z.string() }),
  "services.failed": z.object({ file: z.string(), detail: z.string() }),
  // 共用の compose（PBI-70）
  "services.sharedUnknown": z.object({ name: z.string() }),
  "services.sharedFetchFailed": z.object({ name: z.string(), repo: z.string(), detail: TextParam }),
  "services.sharedMissing": z.object({ name: z.string(), file: z.string() }),
  "services.sharedUnsafe": z.object({ name: z.string(), file: z.string(), detail: z.string() }),
  "services.sharedFailed": z.object({ name: z.string(), file: z.string(), detail: z.string() }),
  "input.channelRequired": null,
  // Slack の通知のメンション（PBI-69）
  "input.slackMention": null,
  "input.mentionKinds": null,
  // Slack の通知（PBI-38）
  "notify.failed": z.object({ detail: TextParam }),
  "notify.notConfigured": null,
  "input.allowRule": null,
  "input.platformName": null,
  "input.ticketKey": null,
  // チケットの取り込み（PBI-52）
  "ticket.platformMissing": z.object({ platform: z.string() }),
  "ticket.notAllowed": z.object({ platform: z.string(), method: z.string(), path: z.string() }),
  "ticket.requestFailed": z.object({
    platform: z.string(),
    status: z.number(),
    detail: z.string(),
  }),
  // タスクの開始時の情報収集
  "gather.failed": z.object({ detail: TextParam }),
  "gather.unreadable": null,
  "ticket.triageFailed": z.object({ detail: TextParam }),
  "ticket.triageUnreadable": null,
  "ticket.repoNotCandidate": z.object({ repo: z.string() }),
  "ticket.noCandidates": null,
  "ticket.repoChosenByPerson": null,
  "ticket.notTriageable": null,
  // リポジトリを指定せずに作ったタスク（PBI-73）
  "repo.chooseFailed": z.object({ detail: TextParam }),
  "repo.notChosen": null,
  "repo.notCandidate": z.object({ repo: z.string() }),
  "repo.chosenByPerson": null,
  "repo.notChoosable": null,
  "repo.stepNeedsRepository": z.object({ step: z.string() }),
  "input.envName": null,
  "input.headerName": null,
  "input.mcpName": null,
  "input.dollarBrace": null,
  // 実行（PBI-11b。作業履歴に記録する）
  "run.daemonStopped": null,
  "run.guardianInterrupted": null,
  "run.stoppedByPerson": null,
  "run.timeout": z.object({ minutes: z.number() }),
  "run.testTimeout": z.object({ minutes: z.number() }),
  "run.dockerUnavailable": z.object({ detail: TextParam }),
  "run.dockerFailed": null,
  "run.imageMissing": z.object({ image: z.string() }),
  // 起動のときのイメージの確かめ（PBI-148）
  "image.missing": z.object({ image: z.string(), command: z.string() }),
  "image.notLocal": z.object({ image: z.string(), command: z.string() }),
  "image.dockerUnreachable": null,
  "image.dockerNotInstalled": null,
  "image.outdated": z.object({
    image: z.string(),
    expected: z.string(),
    key: z.string(),
    command: z.string(),
  }),
  "run.authFileUnreadable": z.object({ path: z.string() }),
  "run.containerNotConfirmed": z.object({ name: z.string() }),
  // オーケストレーターのセッションを、実行の設定の場所に戻せなかった（PBI-67）
  "run.sessionRestoreFailed": z.object({ detail: TextParam }),
  "run.secretNotFound": z.object({ name: z.string() }),
  // 1Password（PBI-34）
  "secret.opMissing": null,
  "secret.opSignedOut": z.object({ ref: z.string() }),
  "secret.opFailed": z.object({ ref: z.string(), detail: z.string() }),
  // 起動時にまとめて取り出す（PBI-48）
  "secret.prefetchFailed": z.object({ where: z.string(), detail: TextParam }),
  // プロジェクトのコンテキストの秘密情報も、まとめて取り出す（PBI-107）
  "secret.savePrefetchFailed": z.object({ where: z.string(), detail: TextParam }),
  // sacty の設定（通知先）を保存したときの取り出し（PBI-115）
  "secret.settingsSavePrefetchFailed": z.object({ where: z.string(), detail: TextParam }),
  "secret.contextUnavailable": z.object({ project: z.string(), detail: TextParam }),
  "secret.contextTimedOut": z.object({ seconds: z.number() }),
  "run.repositoryNotConfigured": null,
  "guardian.verdictUnreadable": null,
  "guardian.reworkUnreadable": null,
  "orchestrator.fallback": z.object({ detail: TextParam }),
  "orchestrator.unreadable": null,
  "orchestrator.testCommandUnknown": null,
  "orchestrator.noTestsContradicted": z.object({ reason: z.string(), files: z.string() }),
  "orchestrator.noTestsUncertain": z.object({ reason: z.string() }),
  "orchestrator.noTestsUnreadable": z.object({
    reason: z.string(),
    path: z.string(),
    detail: z.string(),
  }),
  "orchestrator.bugfixNeedsTests": z.object({ reason: z.string() }),
  "implement.testCommandInvalid": null,
  "orchestrator.failed": z.object({ detail: TextParam }),
  "orchestrator.baseBranchUnavailable": z.object({ branch: z.string(), detail: TextParam }),
  // 工程の見直し：オーケストレーターを実行できなかった・答えを読めなかったので、飛ばさずに進める
  "orchestrator.stepReviewFailed": z.object({ detail: TextParam }),
  // タスク分割（PBI-27）
  "split.unreadable": null,
  "split.childCount": z.object({ min: Count, max: Count, count: Count }),
  "split.duplicateKey": z.object({ key: z.string() }),
  "split.unknownDependency": z.object({ key: z.string(), dependsOn: z.string() }),
  "split.cycle": z.object({ keys: z.string() }),
  "split.childCancelled": z.object({ titles: z.string() }),
  "split.repoMissing": z.object({ key: z.string() }),
  "split.repoNotCandidate": z.object({ key: z.string(), repo: z.string() }),
  // 統合レビュー（PBI-31）
  "integrate.baseUnavailable": z.object({ branch: z.string(), detail: TextParam }),
  "integrate.unreadable": null,
  "review.pullRequestMissing": z.object({ repo: z.string() }),
  // PR のレビューだけを行う取り込み（PBI-44）
  "review.reviewOnly": z.object({ via: z.enum(["requested", "label", "sacty"]) }),
  // レビューだけのタスクで、レビューの工程のイメージだけをオーケストレーターが選んだ（PBI-44 の続き）
  "review.reviewOnlyImageChosen": z.object({ via: z.enum(["requested", "label", "sacty"]) }),
  "review.notRereviewable": null,
  // 投稿の直前に PR の先頭を確かめられなかった（PBI-111）
  "review.headUnknown": null,
  "github.ghMissing": null,
  "github.accountRequired": z.object({ project: z.string(), host: z.string() }),
  "github.accountUnavailable": z.object({ account: z.string(), host: z.string() }),
  "github.ghFailed": z.object({ detail: z.string() }),
  // 工程の出力で頼まれた、PR・Issue へのコメント（sacty-github-comments）
  "githubComments.unreadable": null,
  "githubComments.tooMany": z.object({ max: z.number() }),
  "githubComments.tooLong": z.object({ max: z.number() }),
  "githubComments.targetInvalid": null,
  "githubComments.targetNotAllowed": null,
  "review.verdictMissing": null,
  "review.verdictIdMismatch": z.object({ expected: z.string(), answered: z.string() }),
  "review.unreadable": null,
  "review.viewpointUnmapped": null,
  "run.guardianFailed": z.object({ detail: TextParam }),
  "verify.testsUnavailable": z.object({ detail: TextParam }),
  "verify.workspaceMissing": null,
  "verify.commandMissing": z.object({
    commands: z.array(z.string()).min(1),
    image: z.string(),
    step: z.enum(["implement", "reproduce"]),
  }),
  "verify.diffUnavailable": z.object({ detail: TextParam }),
  "verify.finalReviewFailed": z.object({ detail: TextParam }),
  "verify.tooManyAttempts": z.object({ count: Count }),
  "pr.unavailable": z.object({ detail: TextParam }),
  "pr.workspaceMissing": null,
  "pr.taskBranchChanged": z.object({ branch: TextParam, paths: TextParam, count: z.number() }),
  "pr.failed": z.object({ detail: TextParam }),
  // PR テンプレート（PBI-87）。status が 0 なら、HTTP の応答が無かった（通信の失敗・時間切れ）
  "pr.templateFailed": z.object({ path: z.string(), status: z.number(), detail: TextParam }),
  "pr.templateTooLarge": z.object({ path: z.string(), size: Count, limit: Count }),
  "pr.templateInvalid": z.object({ path: z.string() }),
  "pr.templateEmpty": z.object({ path: z.string() }),
  "pr.templateOrgPrivate": z.object({ repo: z.string() }),
  "cleanup.prRepoUnknown": null,
  "cleanup.noWorkspace": null,
  "cleanup.containerUnconfirmed": null,
  "git.unavailable": z.object({ detail: z.string() }),
  "git.failed": z.object({ command: z.string(), detail: z.string() }),
  "git.exitCode": z.object({ command: z.string(), code: z.number().nullable() }),
  // 上限の時間を過ぎて、git を止めた（PBI-107）
  "git.aborted": null,
  "git.invalidBaseCommit": null,
  "git.baseCommitMissing": z.object({ commit: z.string() }),
  "git.invalidParentCommit": null,
  "git.invalidBranch": null,
  "git.invalidPath": null,
  "git.nothingToCommit": null,
  "git.notSactyBranch": null,
  "git.fileNotRegular": z.object({ path: z.string() }),
  "git.fileTooLarge": z.object({ path: z.string(), limit: Count }),
  "git.fileNotText": z.object({ path: z.string() }),
  "github.failed": z.object({
    action: z.enum([
      "updatePr",
      "createPr",
      "closePr",
      "getPr",
      "getReviews",
      "commentIssue",
      "listIssueComments",
      "listRepositories",
      "postReview",
      "searchIssues",
      "getLabel",
      "createLabel",
      "addLabel",
      "readChecks",
      "listEvents",
    ]),
    status: z.number(),
    detail: z.string(),
    hint: z.enum(["none", "token", "permission"]),
  }),
  "github.eventsIncomplete": null,
  "intake.searchTimedOut": null,
  "intake.tooManySameTime": null,
  "intake.partial": null,
  "intake.rateLimited": null,
  "intake.skippedRateLimited": null,
  "intake.rerequestUnchecked": z.object({ pr: z.string(), detail: TextParam }),
  "context.cycle": z.object({ key: z.string() }),
  "context.tooDeep": z.object({ max: Count }),
  "context.fetchFailed": z.object({ key: z.string(), detail: TextParam }),
  "context.fileUnreadable": z.object({ key: z.string(), file: z.string(), detail: z.string() }),
  "context.fileInvalid": z.object({
    key: z.string(),
    file: z.string(),
    path: z.string(),
    detail: TextParam,
  }),
  "context.notPlainFile": z.object({ key: z.string(), path: z.string(), symlink: z.boolean() }),
  "context.pathMissing": z.object({ key: z.string(), path: z.string() }),
  "context.copyAborted": z.object({ key: z.string() }),
  "context.submoduleNotCheckedOut": z.object({ key: z.string(), path: z.string() }),
  "context.extendsOutside": z.object({ key: z.string(), value: z.string() }),
  "context.localExtendsFromRemote": z.object({ key: z.string(), value: z.string() }),
  "context.lockedOverride": z.object({
    from: z.string(),
    kind: z.enum(["skills", "mcp", "platforms"]),
    name: z.string(),
    lockedBy: z.string(),
  }),
  "context.lockedRemove": z.object({
    from: z.string(),
    kind: z.enum(["skills", "mcp", "platforms"]),
    name: z.string(),
    lockedBy: z.string(),
  }),
  "context.reservedSetting": z.object({ from: z.string(), file: z.string(), key: z.string() }),
  "context.hostPlatform": z.object({ from: z.string(), name: z.string() }),
  "context.hostMcpOverride": z.object({ from: z.string(), name: z.string() }),
  // project はどのプロジェクトのものか（PBI-92。それより前の記録には無い）
  "context.mcpHostUnavailable": z.object({
    name: z.string(),
    from: z.string(),
    project: z.string().optional(),
    detail: TextParam,
  }),
  "context.mcpHostReadyTimeout": z.object({
    name: z.string(),
    from: z.string(),
    project: z.string().optional(),
    seconds: z.number(),
  }),
  "context.mcpHostCommandMissing": z.object({
    name: z.string(),
    from: z.string(),
    project: z.string().optional(),
    command: z.string(),
  }),
  "context.duplicateSkill": z.object({
    from: z.string(),
    name: z.string(),
    path: z.string(),
    usedPath: z.string(),
  }),
  "context.mcpTimeoutOverRun": z.object({
    name: z.string(),
    key: z.enum(["startup_timeout_sec", "tool_timeout_sec"]),
    seconds: z.number(),
    minutes: z.number(),
  }),
  // 設定ファイル（config.yaml）
  "config.missing": z.object({ path: z.string() }),
  "config.unreadable": z.object({ detail: z.string() }),
  "config.stepAgentsPrRemoved": null,
  "config.invalid": z.object({ path: z.string(), detail: TextParam }),
  "config.authUnsupported": z.object({
    runtime: z.string(),
    mode: z.string(),
    supported: z.string(),
  }),
  "config.subscriptionSecret": null,
  "config.bedrockEndpointCodexOnly": null,
  "config.gatewayUnsupported": null,
  // エージェントの既定と接続先（PBI-134）
  "config.providerLegacyName": z.object({ name: z.string() }),
  "config.agentLegacyKey": z.object({ key: z.string() }),
  "config.defaultsUnreadable": z.object({ path: z.string(), detail: z.string() }),
  "config.agentUnavailable": z.object({ key: z.string(), id: z.string(), reason: TextParam }),
  "config.noDefaultAgent": null,
  "config.agentRuntimeRequired": null,
  "config.agentModelRequired": null,
  "config.agentProviderMissing": z.object({ id: z.string(), provider: z.string() }),
  "config.modelPriceMissing": z.object({
    provider: z.string(),
    model: z.string(),
    agents: z.string(),
  }),
  "config.platformAuth": null,
  // トークンの取得のクエリ（PBI-93）
  "config.platformTokenQuery": null,
  "config.platformTokenUrlSecret": null,
  "config.platformTokenBody": null,
  "gateway.platformUnavailable": z.object({ name: z.string(), detail: TextParam }),
  "gateway.mcpUnavailable": z.object({ name: z.string(), detail: TextParam }),
  "gateway.mcpReadyTimeout": z.object({ name: z.string(), seconds: z.number() }),
  "gateway.unavailable": null,
  "config.agentMissing": z.object({ key: z.string(), id: z.string() }),
  // 利用制限のときの代わりのエージェント
  "config.agentFallbackSelf": z.object({ id: z.string() }),
  "config.agentFallbackUnavailable": z.object({
    id: z.string(),
    fallback: z.string(),
    reason: TextParam,
  }),
  // 工程のエージェントを人が変える（PBI-121）
  "agent.stepMissing": null,
  "agent.stepNotChangeable": null,
  "agent.notInAgents": z.object({ name: z.string() }),
  "agent.unchanged": z.object({ name: z.string() }),
  "agent.configUnavailable": z.object({ detail: TextParam }),
  "agent.chosenMissing": z.object({ step: z.string(), name: z.string() }),
  // 完了したタスクの監査（PBI-124）
  "audit.notFound": null,
  "audit.proposalNotFound": null,
  "audit.alreadyDecided": null,
  "audit.memoryNotFound": null,
  "audit.memoryDeleted": null,
  "audit.targetNotCandidate": null,
  "audit.notPaused": null,
  "audit.runFailed": z.object({ detail: TextParam }),
  "audit.unreadable": null,
  "audit.interrupted": null,
  "audit.notAdoptable": null,
  // エージェントの段階（PBI-119）
  "config.tierRuntime": z.object({ id: z.string(), runtime: z.string(), expected: z.string() }),
  "agents.tierConnectionDiffers": z.object({
    tier: z.string(),
    id: z.string(),
    parent: z.string(),
  }),
  "context.reservedTierFile": z.object({ from: z.string(), path: z.string() }),
} as const satisfies Record<string, z.ZodType | null>;

export type MessageParams = {
  [K in keyof typeof PARAMS]: (typeof PARAMS)[K] extends z.ZodType
    ? z.infer<(typeof PARAMS)[K]>
    : undefined;
};

export type MessageCode = keyof MessageParams;

/** コードと引数の文言。 */
export type DaemonMessage = {
  [K in MessageCode]: MessageParams[K] extends undefined
    ? { code: K }
    : { code: K; params: MessageParams[K] };
}[MessageCode];

/**
 * 言語ごとの文言。引数のあるコードは関数。引数のうち文であるもの（detail など）は、
 * 2つ目の引数（text）で画面の言語の文にする。
 */
export type MessageDictionary = {
  [K in MessageCode]: MessageParams[K] extends undefined
    ? string
    : (params: MessageParams[K], text: (value: DaemonText) => string) => string;
};

const scopeJa = { org: "Org", repo: "リポジトリ" } as const;
const scopeEn = { org: "Org", repo: "repository" } as const;
const githubActionJa = {
  updatePr: "PRを更新できませんでした",
  createPr: "PRを作れませんでした",
  closePr: "PRを閉じられませんでした",
  getPr: "PRの状態を確認できませんでした",
  getReviews: "PRのレビューを確認できませんでした",
  commentIssue: "Issue にコメントできませんでした",
  listIssueComments: "Issue のコメントを確認できませんでした",
  listRepositories: "リポジトリの一覧を読めませんでした",
  postReview: "PR にレビューを投稿できませんでした",
  searchIssues: "Issue を検索できませんでした",
  getLabel: "リポジトリのラベルを確かめられませんでした",
  createLabel: "リポジトリにラベルを作れませんでした",
  addLabel: "PR にラベルを付けられませんでした",
  readChecks: "CI/CD の状態を読めませんでした",
  listEvents: "PR のできごと（レビューの依頼など）を読めませんでした",
} as const;
const githubActionEn = {
  updatePr: "Could not update the PR",
  createPr: "Could not open the PR",
  closePr: "Could not close the PR",
  getPr: "Could not check the PR",
  getReviews: "Could not check the PR reviews",
  commentIssue: "Could not comment on the issue",
  listIssueComments: "Could not check the issue comments",
  listRepositories: "Could not list the repositories",
  postReview: "Could not post the review to the PR",
  searchIssues: "Could not search issues",
  getLabel: "Could not check the label of the repository",
  createLabel: "Could not create the label in the repository",
  addLabel: "Could not add the label to the PR",
  readChecks: "Could not read the CI/CD status",
  listEvents: "Could not read the PR events (such as review requests)",
} as const;
const githubHintJa = {
  none: "",
  token: "（トークンが無効です）",
  permission: "（トークンの権限か、リポジトリ名を確認してください）",
} as const;
const githubHintEn = {
  none: "",
  token: " (the token is invalid)",
  permission: " (check the token's permissions or the repository name)",
} as const;
const contextKindJa = { skills: "スキル", mcp: "MCP サーバー", platforms: "外部 PF" } as const;

/** どのプロジェクトのコンテキストの MCP サーバーか（PBI-92。古い記録には無い）。 */
const projectJa = (project: string | undefined) =>
  project !== undefined ? `プロジェクト「${project}」の ` : "";
const projectEn = (project: string | undefined) =>
  project !== undefined ? ` (project "${project}")` : "";
const contextKindEn = {
  skills: "skill",
  mcp: "MCP server",
  platforms: "external platform",
} as const;

const ja: MessageDictionary = {
  "task.notFound": "タスクが見つかりません。",
  "task.repositoryMissing": ({ project }) =>
    `プロジェクト「${project}」に対象（Org・リポジトリ）がありません。プロジェクトの設定で対象を追加してから、タスクを作ってください。`,
  "task.repositoryUnknown": ({ project }) =>
    `対象リポジトリを、プロジェクト「${project}」の対象（Org・リポジトリ）の中から選んでください。`,
  "task.templateRepositoryRequired":
    "このテンプレートでは、対象リポジトリを選んでください（リポジトリを指定せずには作れません）。",
  "task.reviewPlanNeedsPullRequest":
    "進め方「レビューだけ」は、対象リポジトリを選び、そのリポジトリの PR のリンクを題か内容に書いたときだけ選べます。",
  "task.cancelled": "中止したタスクです。",
  "task.invalidState": "このタスクの状態では、その操作はできません。画面を更新してください。",
  "project.notFound": "プロジェクトが見つかりません。",
  "project.targetDuplicated": ({ scope, target }) =>
    `${scopeJa[scope]}「${target}」が重複しています。`,
  "project.ticketKeyDuplicated": ({ platform, key }) =>
    `チケットの取り込み先（${platform}）のキー「${key}」が重複しています。`,
  "project.ticketKeyTaken": ({ platform, key, project }) =>
    `チケットの取り込み先（${platform}）のキー「${key}」は、プロジェクト「${project}」が取り込んでいます。`,
  "project.sharedComposeDuplicated": ({ name }) =>
    `共用の compose の名前「${name}」が重複しています。`,
  "project.hasActiveTasks": ({ count }) =>
    `終わっていないタスク（または、実行中・実行待ちの処理）が${count}件あるため、プロジェクトを削除できません。タスクを完了するか中止してから、削除してください。`,
  "project.targetTaken": ({ scope, target, project }) =>
    `${scopeJa[scope]}「${target}」は、プロジェクト「${project}」に登録されています。`,
  "pause.alreadyPaused": "すでに一時停止しています。",
  "pause.awaitingPerson": "人間の判断待ちのため、一時停止する必要はありません。",
  "pause.reachedApproval":
    "止める前に作業が終わり、承認待ちになったため、一時停止しませんでした（PR を作った工程は、PR で判断してください。止めるなら中止してください）。",
  "pause.waitingTasks": "ほかのタスクの完了を待っているため、一時停止する必要はありません。",
  "pause.guardianJudging":
    "ゴールガーディアンが変更の申し出を判定しているため、終わるまで一時停止できません。",
  "cancel.alreadyCancelled": "すでに中止しています。",
  "cancel.cleaningUp": "中止の後片付けをしています。",
  "cancel.guardianJudging":
    "ゴールガーディアンが変更の申し出を判定しているため、終わるまで中止できません。",
  "rerun.notCancelled": "中止したタスクだけを再実行できます。",
  "rerun.notRerunnable":
    "このタスクは再実行できません（分割で作った子タスクは親から、PR のレビューは PR から依頼し直してください）。",
  "rerun.alreadyRerun": "このタスクは再実行済みです。再実行で作ったタスクを確かめてください。",
  "resume.notPaused": "一時停止中のタスクではありません。",
  "resume.testsNotUndecided":
    "このタスクは、テストのコマンドが決まらずに止まったタスクではありません。テストの扱いを指定せずに再開してください。",
  "resume.bugfixNeedsTestCommand":
    "不具合の修正（再現の工程がある）は、テストなしでは進められません。テストのコマンドを指定してください。",
  "operation.incomplete":
    "外部作業は開始していません。対象・変更内容・確認方法・接続先が未確定です。依頼を具体的にした新しいタスクを作成してください。",
  "operation.attempted":
    "外部作業はすでに実行を開始しています。重複を避けるため再実行しません。接続先の状態と実行ログを確認し、このタスクを中止して、必要なら未実施分だけを新しいタスクにしてください。",
  "operation.unconfirmed":
    "外部作業の成功を確認できません。自動再実行はしません。実行ログと接続先の状態を確認し、中止後に必要なら未実施分のタスクを作成してください。",
  "operation.connectionMissing":
    "外部作業は開始していません。選択された接続先が利用できません。設定を確認してから再開してください。",
  "resume.capRequired": "予算で止まったタスクを再開するには、新しい上限が必要です。",
  "resume.capTooLow": ({ usedUsd }) =>
    `新しい上限は、使用済み（${formatUsd(usedUsd)}）より大きい金額にしてください。`,
  "containers.notStopped": ({ names }) =>
    `コンテナ（${names}）の停止を確認できませんでした。docker ps で止まっていることを確かめてから再開してください。`,
  "change.notAwaiting": "この変更の申し出は、判断待ちではありません。",
  "gate.notAwaiting": "承認待ちのタスクではありません。",
  "gate.stepNotAwaiting": "この工程は承認待ちではありません。",
  "gate.staleSubmission": ({ submission, current }) =>
    `表示している成果物（${submission}回目の提出）は最新ではありません。画面を更新して、最新の提出（${current}回目）を確認してください。`,
  "gate.invalidTarget": "この工程には差し戻せません。",
  "gate.approveOnPullRequest": ({ url }) =>
    `PR を作ったタスクは、PR をマージすると承認になります。GitHub で PR をレビューしてマージしてください（${url}）。`,
  "gate.remarksRequired": "差し戻すには、指摘を1件以上入力してください。",
  "gate.reproduceNotApprovable":
    "再現できなかったので、先へは進めません。再現の手がかりを指摘に書いて差し戻すと、再現をやり直します。不要なら中止してください。",
  "reproduce.noTests":
    "再現のエージェントが、再現のテストを申告しませんでした（再現できなかった）。",
  "reproduce.notChecked":
    "再現のエージェントが、書いたテストが不具合のために失敗することを確かめたと申告しませんでした（再現できなかった）。",
  "reproduce.runFailed": ({ detail }, text) =>
    `再現のテストを実行できませんでした（${text(detail)}）。再現できたかは確かめていません。原因を確かめてから再開すると、テストを実行し直します。`,
  "gate.overLimit": ({ limit }) =>
    `差し戻しが上限（${limit}回）に達しています。続ける場合は、上限を超えて差し戻すことを選んでください。`,
  "remark.notFound": "指摘が見つかりません。",
  "schedule.notFound": "スケジュールタスクが見つかりません。",
  "schedule.nameRequired": "名前を入力してください。",
  "schedule.nameTooLong": `名前は${SCHEDULE_NAME_MAX}文字以内で入力してください。`,
  "schedule.timeInvalid": "時刻を HH:MM（24時間制）で入力してください。",
  "schedule.daysRequired": "曜日を1つ以上選んでください。",
  "schedule.dayInvalid": "日は1から31の間で入力してください。",
  "schedule.projectMissing": "スケジュールタスクのプロジェクトが見つかりません。",
  "input.titleRequired": "タイトルを入力してください。",
  "input.titleTooLong": `タイトルは${TASK_TITLE_MAX}文字以内で入力してください。`,
  "input.bodyTooLong": `内容は${TASK_BODY_MAX.toLocaleString("ja-JP")}文字以内で入力してください。`,
  "input.noteTooLong": `補足は${RERUN_NOTE_MAX.toLocaleString("ja-JP")}文字以内で入力してください。`,
  "input.auditNoteTooLong": `採用に添える手入れは${AUDIT_ADOPT_NOTE_MAX.toLocaleString("ja-JP")}文字以内で入力してください。`,
  "input.remarkTooLong": "指摘は1件あたり2,000文字以内にしてください。",
  "input.questionRequired": "質問を入力してください。",
  "input.questionTooLong": `質問は${QUESTION_MAX.toLocaleString("ja-JP")}文字以内にしてください。`,
  "chat.answering": "前の質問に答えているところです。答えが出てから質問してください。",
  "chat.budgetExceeded": ({ usedUsd, capUsd }) =>
    `予算の上限に達しているため、質問できません（${formatUsd(usedUsd)} / ${formatUsd(capUsd)}）。答えの費用もタスクの予算に入ります。`,
  "chat.unavailable":
    "設定（config.yaml）に問題があるため、質問できません。画面の上の問題を確かめてください。",
  "chat.failed": ({ detail }, text) =>
    `オーケストレーターが質問に答えられませんでした：${text(detail).replace(/[。.]\s*$/, "")}。`,
  "chat.emptyAnswer": "オーケストレーターの答えが空でした。",
  "chat.cancelled": "タスクを中止したため、答えるのをやめました。",
  "export.notDecided": "オーケストレーターが書き出し先を決めなかったため、書き出しません。",
  "export.destinationUnknown": ({ name }) =>
    `オーケストレーターが選んだ書き出し先「${name}」は、使える接続先（gateway.platforms・MCP サーバー）に無いため、書き出しません。`,
  "export.destinationMissing": ({ name }) =>
    `書き出し先「${name}」が、使える接続先（gateway.platforms・MCP サーバー）にありません。`,
  "export.failed": ({ detail }, text) =>
    `書き出せませんでした：${text(detail).replace(/[。.]\s*$/, "")}。`,
  "export.unreadable":
    "書き出しのエージェントの出力から、書き出した先の URL を読み取れませんでした。",
  "deploy.skillMissing":
    "デプロイの確認のスキル（.agents/skills/deployment-observer/SKILL.md か .claude/skills/deployment-observer/SKILL.md）が無いため、スキルに従った確認を飛ばしました。",
  "deploy.skillOutside": ({ path }) =>
    `デプロイの確認のスキル（${path}）のシンボリックリンクがリポジトリの外を指す（またはたどりすぎる）ため、使いませんでした。`,
  "deploy.skillUnreadable": ({ path, detail }, text) =>
    `デプロイの確認のスキル（${path}）を読めないため、使いませんでした：${text(detail)}`,
  "deploy.budgetExceeded": "予算の上限に達しているため、スキルに従った確認を実行しませんでした。",
  "deploy.checkFailed": ({ detail }, text) =>
    `スキルに従った確認を実行できませんでした：${text(detail)}`,
  "deploy.unreadable": "スキルに従った確認の結果（sacty-deployment）を読み取れませんでした。",
  "deploy.undetermined":
    "エージェントが、スキルに従った確認（CI/CD・デプロイ後のアプリ）の結果を判断できませんでした。",
  "deploy.stopped": "スキルに従った確認を中断しました（止めた・中止した）。",
  "deploy.noSkill":
    "対象のリポジトリに、デプロイの確認のスキル（.agents/skills/deployment-observer/SKILL.md か .claude/skills/deployment-observer/SKILL.md）がありません。",
  "deploy.skillLookupFailed": ({ detail }, text) =>
    `デプロイの確認のスキルを探せませんでした：${text(detail)}`,
  "deploy.stepSkipped": ({ detail }, text) =>
    `マージの後の監視の工程を飛ばします（CI/CD も見ません）。${text(detail)}`,
  "export.budgetExceeded":
    "予算の上限に達しているため、書き出しませんでした。予算の上限を上げてから、書き出し直してください。",
  "export.stopped": "人間が止めたため、書き出しを中断しました。",
  "export.notRetryable": "書き出し直せるのは、書き出せなかった承認済みの成果だけです。",
  "input.tooManyRemarks": "指摘は一度に50件までにしてください。",
  "input.nameRequired": "名前を入力してください。",
  "input.invalidGithubName": "GitHub の名前として正しくありません。",
  "input.invalidRepo": "リポジトリは URL（例 https://github.com/acme/app）で入力してください。",
  "input.invalidOrg": "Org は URL（例 https://github.com/acme）で入力してください。",
  "input.urlSsh":
    "SSH の URL は使えません。https://<ホスト>/<owner>/<name> の形で入力してください（clone は gh のアカウントのトークンで行います）。",
  "input.urlNotHttps": "http の URL は使えません。https で入力してください。",
  "input.urlCredentials": "URL に、ユーザー名・パスワード・トークンを書かないでください。",
  "input.urlHost": "URL のホストを読めません（使える文字は英数字・.・- と、:ポート番号）。",
  "input.urlExtraPath":
    "URL の余分な部分を外してください（リポジトリは https://<ホスト>/<owner>/<name>、Org は https://<ホスト>/<owner> まで。/tree/… などは付けません）。",
  "input.repoLooksLikeOrg":
    "Org の URL です。単位を「Org」にするか、リポジトリの URL を入力してください。",
  "input.orgLooksLikeRepo":
    "リポジトリの URL です。単位を「リポジトリ」にするか、Org の URL を入力してください。",
  "input.invalidHost": "ホスト名として正しくありません。",
  "input.contextRepoRequired": "コンテキストリポジトリを入力してください。",
  "input.sharedComposeName":
    "共用の compose の名前は、英小文字・数字で始まり、英小文字・数字・_・- だけ（40文字まで）で入力してください。",
  "input.sharedComposeRepoRequired": "共用の compose のリポジトリを入力してください。",
  "input.sharedComposeRepoCredential":
    "共用の compose のリポジトリの URL には、ユーザー名・パスワード・トークンを書かないでください（HTTPS の GitHub は、プロジェクトの GitHub のアカウントで取得します）。",
  "input.sharedComposeRepoForm":
    "共用の compose のリポジトリは、git の URL（https://…・ssh://…・git@host:…）か、ローカルの絶対パスで入力してください。",
  "input.sharedComposeFile":
    "共用の compose の compose ファイルは、リポジトリの根からの相対パス（.. や $ を含まない）で入力してください。",
  "input.invalidRef": "ref はブランチ名かタグ名で入力してください。",
  "input.invalidContextPath":
    "パスは、リポジトリの根からの相対パス（例 contexts/team。. と .. の部分は使えない）で入力してください。",
  "input.invalidLabel": 'ラベルに " と \\ は使えません。',
  // 取り込みの間隔（PBI-100）。60 と 300 は MIN_INTAKE_INTERVAL_SEC・DEFAULT_INTAKE_INTERVAL_SEC（テストで一致を確かめる）
  "input.issueIntervalInvalid":
    "Issue の取り込みの間隔は、60 以上の整数（秒）を書いてください（空なら 300 秒）。",
  "input.reviewIntervalInvalid":
    "PR のレビューの取り込みの間隔は、60 以上の整数（秒）を書いてください（空なら 300 秒）。",
  "input.ticketIntervalInvalid":
    "チケットの取り込みの間隔は、60 以上の整数（秒）を書いてください（空なら 300 秒）。",
  "input.notExportFile": "Sacty のプロジェクト定義のファイルではありません。",
  "input.unsupportedVersion": `対応していない版です（対応している版：${PROJECT_EXPORT_VERSION}）。`,
  "input.exportVersionWithNotification": `版 3・4 のファイルは読めません。版 ${PROJECT_EXPORT_VERSION} から、Slack の通知先をプロジェクトに含めなくなりました（通知先は Sacty の設定にあります）。今の Sacty でエクスポートし直してください。`,
  "input.required": "入力してください。",
  "input.tooShort": ({ minimum }) => `${minimum}文字以上で入力してください。`,
  "input.tooLong": ({ maximum }) =>
    `${maximum.toLocaleString("ja-JP")}文字以内で入力してください。`,
  "input.tooFew": ({ minimum }) => `${minimum}件以上にしてください。`,
  "input.tooMany": ({ maximum }) => `${maximum}件までにしてください。`,
  "input.numberTooSmall": ({ minimum, inclusive }) =>
    `${minimum}${inclusive ? "以上" : "より大きい"}値にしてください。`,
  "input.numberTooLarge": ({ maximum, inclusive }) =>
    `${maximum}${inclusive ? "以下" : "より小さい"}値にしてください。`,
  "input.invalidType": "値の種類が正しくありません。",
  "input.invalidFormat": "形式が正しくありません。",
  "input.invalidValue": "値が正しくありません。",
  "input.unknownKeys": ({ keys }) => `知らない項目があります（${keys}）。`,
  "input.invalid": "入力が正しくありません。",
  "input.secretName": "秘密情報の名前は英数字と . _ - だけで書いてください。",
  "input.ticketKey":
    "JIRA のプロジェクトのキーは、英大文字で始まる英大文字・数字・_ で書いてください（例 PAY）。1つ以上書きます。",
  "ticket.platformMissing": ({ platform }) =>
    `チケットの取り込み先の接続先「${platform}」が、config.yaml の gateway.platforms にも、プロジェクトのコンテキストの platforms.yaml にもありません。`,
  "ticket.notAllowed": ({ platform, method, path }) =>
    `接続先「${platform}」の allow に「${method} ${path}」がありません。config.yaml の gateway.platforms.${platform}.allow（プロジェクトのコンテキストの PF なら、platforms.yaml の platforms.${platform}.allow）に足してください。`,
  "ticket.requestFailed": ({ platform, status, detail }) =>
    `接続先「${platform}」の API が失敗しました（${status}）：${detail}`,
  "gather.failed": ({ detail }, text) =>
    `情報収集のエージェントが、タスクに関係する情報をまとめられませんでした：${text(detail)} 再開すると、もう一度集めます。`,
  "gather.unreadable":
    "情報収集のエージェントの出力から、集めた情報のまとめを読み取れませんでした。",
  "ticket.triageFailed": ({ detail }, text) =>
    `オーケストレーターが、チケットを読んで作業するリポジトリを決められませんでした：${text(detail)} リポジトリを選んで再開してください。`,
  "ticket.triageUnreadable":
    "オーケストレーターの出力から、作業するリポジトリ・題・概要を読み取れませんでした。",
  "ticket.repoNotCandidate": ({ repo }) =>
    `オーケストレーターが選んだリポジトリ（${repo}）は、プロジェクトの対象にありません。`,
  "ticket.noCandidates":
    "プロジェクトの対象に、作業するリポジトリの候補がありません（Org の対象のリポジトリを読めなかった可能性があります）。",
  "ticket.repoChosenByPerson": "人がリポジトリを選びました。",
  "ticket.notTriageable":
    "リポジトリを選べるのは、チケットから取り込み、まだリポジトリが決まっていないタスクだけです。",
  "repo.chooseFailed": ({ detail }, text) =>
    `オーケストレーターが、作業するリポジトリを決められませんでした：${text(detail)} プロジェクトの対象からリポジトリを選んで再開してください。`,
  "repo.notChosen": "コードの変更が要る進め方を選びましたが、作業するリポジトリを書いていません。",
  "repo.notCandidate": ({ repo }) => `リポジトリ（${repo}）は、プロジェクトの対象にありません。`,
  "repo.chosenByPerson": "人がリポジトリを選びました。",
  "repo.notChoosable":
    "リポジトリを選べるのは、リポジトリを指定せずに作り、まだ工程が決まっていない、止まっているタスクだけです。",
  "repo.stepNeedsRepository": ({ step }) =>
    `工程（${step}）には対象リポジトリが要りますが、このタスクにはリポジトリがありません。`,
  "input.platformName":
    "組織内 PF の名前は、英小文字・数字・ハイフンで書いてください（先頭は英小文字か数字）。",
  "input.allowRule":
    "使える API は「メソッド パス」で書いてください（例 GET /api/v1/tickets/**。メソッドは GET・POST・PUT・PATCH・DELETE・HEAD）。",
  "input.invalidUrl": "URL（http または https）を書いてください。",
  "input.reasoningEffort":
    "リーズニングエフォートは、英小文字で書いてください（例：low・medium・high・xhigh）。",
  "input.imageName":
    "イメージの名前は、英小文字・数字・_・- で書いてください（config.yaml の images の名前か default）。",
  "config.hostAddress":
    "gateway.host_address は、ホスト名か IP アドレス（または host-gateway）で書いてください。",
  "config.agentNameEmpty": "agents の名前は空にできません。エージェントに名前を付けてください。",
  "config.npmVersion":
    "image_build.npm_version は、版（例 11、11.6.2）か latest で書いてください。",
  "config.npmConfigKey":
    "image_build.npm_config の項目は、npm の設定の名前と、1行の値で書いてください。",
  "config.npmConfigSecret":
    "image_build.npm_config には、認証の項目（_authToken など）は書けません（イメージに残るため）。認証は image_build.npm_token か、対象リポジトリの設定で行ってください。",
  "config.imageName":
    "images の名前は、英小文字・数字・_・- で書いてください（default は既定のイメージの名前なので使えません）。",
  "config.imageEnvName": "images の env の名前は、英大文字・数字・_ で書いてください（値は1行）。",
  "config.imageEnvSecret":
    "images の env には、認証の値（TOKEN・PASSWORD などを含む名前や、ユーザー名・パスワードを含む URL）は書けません（コンテナの中のすべてのコマンドに見えるため）。",
  "config.imageEnvReserved":
    "images の env には、PATH・HOME や、DOCKER_・SACTY_・CODEX_・CLAUDE_・ANTHROPIC_・OPENAI_・NPM_CONFIG_ で始まる名前は書けません（Sacty と docker の設定とぶつかるため）。",
  "config.imagePackage":
    "images の packages には、パッケージの名前（英数字と . _ + : @ ~ = -）を書いてください。",
  "config.imageRun":
    "images の run には、1行のコマンドを書いてください（複数のコマンドは、項目を分けて書く）。",
  "config.imageRepo":
    "images の enable_repos には、パッケージのリポジトリの ID（英数字で始まり、英数字と . _ : - だけ）を書いてください。",
  "config.imageRepoPackages":
    "images の enable_repos は、packages を入れるときに有効にするリポジトリです。packages も書いてください。",
  "config.mavenMirror":
    "images の maven_mirror は、ユーザー名・パスワードを含まない URL（http または https）で書いてください。",
  "services.unsafe": ({ file, detail }) =>
    `compose ファイル（${file}）に、Sacty が起動できない設定があります：${detail}。エージェントにホストの権限を渡さないため、privileged・ホストのネットワーク・作業領域の外のマウントなどは使えません。`,
  "services.failed": ({ file, detail }) =>
    `compose ファイル（${file}）のサービスを起動できませんでした。出力の末尾：${detail}`,
  "services.sharedUnknown": ({ name }) =>
    `共用の compose「${name}」は、プロジェクトの設定にありません。プロジェクトの設定に書くか、再開して選び直してください。`,
  "services.sharedFetchFailed": ({ name, repo, detail }, text) =>
    `共用の compose「${name}」のリポジトリ（${repo}）を取得できませんでした：${text(detail)}`,
  "services.sharedMissing": ({ name, file }) =>
    `共用の compose「${name}」のリポジトリに、compose ファイル（${file}）がありません。プロジェクトの設定の compose ファイルのパスを確かめてください。`,
  "services.sharedUnsafe": ({ name, file, detail }) =>
    `共用の compose「${name}」の compose ファイル（${file}）に、Sacty が起動できない設定があります：${detail}。エージェントにホストの権限を渡さないため、privileged・ホストのネットワーク・取得したリポジトリの外のマウントなどは使えません。`,
  "services.sharedFailed": ({ name, file, detail }) =>
    `共用の compose「${name}」の compose ファイル（${file}）のサービスを起動できませんでした。出力の末尾：${detail}`,
  "image.notInImages": ({ name }) =>
    `イメージ「${name}」は config.yaml の images にありません。images の名前か default を選んでください。`,
  "image.unchanged": ({ name }) => `工程のイメージは、すでに「${name}」です。`,
  "image.configUnavailable": ({ detail }, text) =>
    `config.yaml を読めないため、工程のイメージを変えられません（images の名前を確かめられません）。設定を直してから、もう一度変えてください：${text(detail)}`,
  "image.stepMissing": "その工程は、このタスクの工程にありません。",
  "image.unknown": ({ name }) =>
    `イメージ「${name}」は config.yaml の images にありません。images に書くか、プロジェクトの対象のイメージの指定を直してから、再開してください。`,
  "input.channelRequired": "チャンネルを書いてください。",
  "input.slackMention":
    "メンションする相手は、Slack のメンバー ID（U… か W…）、ユーザーグループの ID（S…）、@here、@channel のどれかで書いてください（@表示名では届きません）。",
  "input.mentionKinds": "メンションする通知の種類を、1つ以上選んでください。",
  "notify.failed": ({ detail }, text) =>
    `Slack の通知を送れませんでした：${text(detail)}（タスクは止めていません）`,
  "notify.notConfigured": "Sacty の設定に、Slack の通知先が設定されていません。",
  "input.secretRef":
    "秘密情報は、キーチェーンの名前（英数字と . _ -）か、1Password の参照（op://保管庫/アイテム/フィールド）で書いてください。",
  "input.envName": "環境変数の名前が正しくありません。",
  "input.headerName": "ヘッダーの名前が正しくありません。",
  "input.mcpName": "MCP サーバーの名前は英数字と _ - だけで書いてください。",
  "input.dollarBrace":
    "「$\u007b」は使えません（秘密情報は { secret: 名前 } で参照してください）。",
  "run.daemonStopped": "デーモンが停止したため、実行が中断されました。",
  "run.guardianInterrupted": "デーモンが停止したため、ゴールガーディアンの判定が中断されました。",
  "run.stoppedByPerson": "人間が止めたため、実行しませんでした。",
  "run.timeout": ({ minutes }) => `エージェントの実行が ${minutes} 分を超えたため止めました。`,
  "run.testTimeout": ({ minutes }) => `テストの実行が ${minutes} 分を超えたため止めました。`,
  "run.dockerUnavailable": ({ detail }, text) =>
    `dockerを実行できません。Dockerが起動しているか確認してください（${text(detail)}）。`,
  "run.dockerFailed":
    "Docker がコンテナを実行できませんでした（docker run の終了コード 125）。Docker の起動・接続やイメージを確認してください。",
  "run.imageMissing": ({ image }) =>
    `エージェント用のイメージ（${image}）がありません。\`sacty image build\` で作成してください。`,
  "image.missing": ({ image, command }) =>
    `エージェント用のイメージ（${image}）がありません。\`${command}\` で作成してください。`,
  "image.notLocal": ({ image, command }) =>
    `エージェント用のイメージ（${image}）が手元にありません。実行のときにレジストリから取得を試みます。取得できなければ \`${command}\` で作成してください。`,
  "image.dockerUnreachable":
    "Docker に接続できません。Docker が起動しているか確認してください。接続できるまで、タスクを実行できません（エージェント用のイメージがあるかも確かめられません）。",
  "image.dockerNotInstalled":
    "docker コマンドが見つかりません。Docker をインストールし、docker コマンドを PATH に通してください。それまで、タスクを実行できません。",
  "image.outdated": ({ image, expected, key, command }) =>
    `config.yaml の ${key}（${image}）が、動いている Sacty の版のイメージ（${expected}）と違います。config.yaml の ${key} の値を \`${expected}\` に直してから \`${command}\` で作成してください。`,
  "run.authFileUnreadable": ({ path }) =>
    `認証ファイル（${path}）を読めません。ログインしているか確認してください。`,
  "run.containerNotConfirmed": ({ name }) =>
    `コンテナ（${name}）の停止を確認できませんでした。docker ps で確認してください。`,
  "run.sessionRestoreFailed": ({ detail }) =>
    `保存したオーケストレーターのセッションを、実行の設定の場所に戻せませんでした：${detail}`,
  "run.secretNotFound": ({ name }) =>
    `秘密情報「${name}」が見つかりません。\`sacty secret set ${name}\` で保存してください。`,
  "secret.opMissing":
    "1Password の op コマンドが見つかりません。1Password CLI をインストールし、サインインしてから再開してください。",
  "secret.prefetchFailed": ({ where, detail }, text) =>
    `起動のときに、秘密情報（${where}）を取り出せませんでした：${text(detail)}用意してから、「Sacty の設定」の「秘密情報を取り出し直す」を押してください（使うときにも、もう一度取り出します）。`,
  "secret.savePrefetchFailed": ({ where, detail }, text) =>
    `プロジェクトの設定を保存したときに、秘密情報（${where}）を取り出せませんでした：${text(detail)}用意してから、「Sacty の設定」の「秘密情報を取り出し直す」を押してください（使うときにも、もう一度取り出します）。`,
  "secret.settingsSavePrefetchFailed": ({ where, detail }, text) =>
    `Sacty の設定を保存したときに、秘密情報（${where}）を取り出せませんでした：${text(detail)}用意してから、「Sacty の設定」の「秘密情報を取り出し直す」を押してください（使うときにも、もう一度取り出します）。`,
  "secret.contextUnavailable": ({ project, detail }, text) =>
    `プロジェクト「${project}」のコンテキストを読めず、その秘密情報を前もって取り出せませんでした（使うときに、その場で取り出します）：${text(detail)}`,
  "secret.contextTimedOut": ({ seconds }) => `${seconds} 秒のうちに取得できませんでした。`,
  "secret.opSignedOut": ({ ref }) =>
    `1Password にサインインしていないため、「${ref}」を取り出せません。op signin（または 1Password のアプリとの連携）でサインインしてから再開してください。`,
  "secret.opFailed": ({ ref, detail }) =>
    `1Password から「${ref}」を取り出せませんでした（${detail}）。参照（保管庫・アイテム・フィールド）を確かめてから再開してください。`,
  "run.repositoryNotConfigured":
    "このタスクには対象リポジトリがありません（対象リポジトリを選ぶ前の版で作ったタスクです）。中止して、タスクを作り直してください。",
  "guardian.verdictUnreadable": "ゴールガーディアンの出力から、判定を読み取れませんでした。",
  "guardian.reworkUnreadable": "ゴールガーディアンの出力から、戻し先の判断を読み取れませんでした。",
  "orchestrator.fallback": ({ detail }, text) =>
    `オーケストレーターが工程を選べなかったため、標準の工程で進めます（${text(detail)}）。`,
  "orchestrator.unreadable": "オーケストレーターの出力から、選んだ工程を読み取れませんでした。",
  "split.unreadable":
    "タスク分割の出力から、子タスクの一覧を読み取れませんでした。再開すると、分割をやり直します。",
  "split.childCount": ({ min, max, count }) =>
    `子タスクは${min}〜${max}件にしてください（分割案は${count}件）。再開すると、分割をやり直します。`,
  "split.duplicateKey": ({ key }) =>
    `分割案の子タスクの key「${key}」が重複しています。再開すると、分割をやり直します。`,
  "split.unknownDependency": ({ key, dependsOn }) =>
    `分割案の子タスク「${key}」が、存在しない子タスク「${dependsOn}」に依存しています。再開すると、分割をやり直します。`,
  "split.cycle": ({ keys }) =>
    `分割案の子タスクの依存が循環しています（${keys}）。再開すると、分割をやり直します。`,
  "split.repoMissing": ({ key }) =>
    `リポジトリの無いタスクを分けるときは、子タスクごとにプロジェクトの対象からリポジトリを付けてください（子タスク「${key}」にありません）。再開すると、分割をやり直します。`,
  "split.repoNotCandidate": ({ key, repo }) =>
    `子タスク「${key}」に付けたリポジトリ（${repo}）は、プロジェクトの対象にありません。再開すると、分割をやり直します（対象のリポジトリから選び直します）。`,
  "split.childCancelled": ({ titles }) =>
    `子タスク（${titles}）が中止されました。再開すると、中止した子タスクを除いて進めます（中止した子タスクに依存する子タスクも始めます）。中止すると、終わっていない子タスクも中止します。`,
  "integrate.baseUnavailable": ({ branch, detail }, text) =>
    `統合レビューのため、ベースブランチ（${branch}）の最新を取得できませんでした：${text(detail)}。再開すると、統合レビューをやり直します。`,
  "integrate.unreadable": "統合レビューの出力から、判定を読み取れませんでした。",
  "orchestrator.failed": ({ detail }, text) =>
    `オーケストレーターを実行できませんでした：${text(detail).replace(/[。.]\s*$/, "")}。再開すると、工程の選択からやり直します。`,
  "orchestrator.testCommandUnknown":
    "オーケストレーターが、対象リポジトリのテストのコマンドを決められませんでした。実装を検証できないので、費用をかける前に止めます。再開するときに、テストのコマンドを指定するか、テストを書かないリポジトリなら「テストなしで進める」（ゴールガーディアンがタスクの目的から判定します）を選んでください。どちらも選ばずに再開すると、まだ工程を始めていなければ、工程の選択からやり直します。",
  "orchestrator.noTestsContradicted": ({ reason, files }) =>
    `オーケストレーターは、対象リポジトリにテストの仕組みが無いと判断しました（${reason}）が、テストのように見えるファイルがあります（${files}）。テストなしでは進めずに止めます。ファイルが本当にテストなら、再開するときにそのテストのコマンドを指定してください。テストではないなら、「テストなしで進める」を選んでください。どちらも選ばずに再開すると、まだ工程を始めていなければ、工程の選択からやり直します。`,
  "orchestrator.noTestsUncertain": ({ reason }) =>
    `オーケストレーターは、対象リポジトリにテストの仕組みが無いと判断しました（${reason}）が、ファイルが多く、テストのファイルが無いことを確かめきれませんでした。テストなしでは進めずに止めます。再開するときに、テストのコマンドを指定するか、テストを書かないリポジトリなら「テストなしで進める」（ゴールガーディアンがタスクの目的から判定します）を選んでください。どちらも選ばずに再開すると、まだ工程を始めていなければ、工程の選択からやり直します。`,
  "orchestrator.noTestsUnreadable": ({ reason, path, detail }) =>
    `オーケストレーターは、対象リポジトリにテストの仕組みが無いと判断しました（${reason}）が、作業領域のディレクトリ（${path}）を読めず（${detail}）、テストのファイルが無いことを確かめきれませんでした。テストなしでは進めずに止めます。Sacty を動かしているユーザーがそのディレクトリを読めるか（権限・ディスクの状態）を確かめてください。再開するときに、テストのコマンドを指定するか、テストを書かないリポジトリなら「テストなしで進める」（ゴールガーディアンがタスクの目的から判定します）を選んでください。どちらも選ばずに再開すると、まだ工程を始めていなければ、工程の選択からやり直します。`,
  "orchestrator.bugfixNeedsTests": ({ reason }) =>
    `オーケストレーターは、対象リポジトリにテストの仕組みが無いと判断しました（${reason}）が、不具合の修正（再現 → 実装）を選びました。再現はテストで確かめるので、テストのコマンドが要ります。再開するときに、テストのコマンドを指定してください（不具合の修正は、テストなしでは進められません）。指定せずに再開すると、まだ工程を始めていなければ、工程の選択からやり直します。`,
  "implement.testCommandInvalid":
    "実装の工程が申告したテストのコマンド（sacty-test-command）の形が正しくありません（JSON として読めない、または command が空・文字列でない・1000 文字を超える）。用意したテストを飛ばさないように止めます。再開すると、実装をやり直します。",
  "orchestrator.baseBranchUnavailable": ({ branch, detail }, text) =>
    `オーケストレーターが選んだベースブランチ（${branch}）を用意できなかったため、既定のブランチで進めます（${text(detail)}）。`,
  "orchestrator.stepReviewFailed": ({ detail }, text) =>
    `オーケストレーターが残りの工程を見直せなかったため、工程を飛ばさずに進めます（${text(detail).replace(/[。.]\s*$/, "")}）。`,
  "review.pullRequestMissing": ({ repo }) =>
    `タスクに、レビューする PR（${repo} の PR の URL）がありません。`,
  "review.reviewOnly": ({ via }) =>
    `${via === "requested" ? "自分にレビューが依頼された" : via === "sacty" ? "Sacty がほかのタスクで作った" : "レビュー用のラベルの付いた"} PR なので、レビューだけを行います（オーケストレーターは使いません）。`,
  "review.reviewOnlyImageChosen": ({ via }) =>
    `${via === "requested" ? "自分にレビューが依頼された" : via === "sacty" ? "Sacty がほかのタスクで作った" : "レビュー用のラベルの付いた"} PR なので、レビューだけを行います（オーケストレーターは、レビューの工程のイメージだけを選びます）。`,
  "review.notRereviewable":
    "再レビューできるのは、レビューを PR に投稿して完了したタスクだけです。",
  "review.headUnknown":
    "投稿の前に、PR の先頭のコミットを確かめられませんでした（GitHub の応答にコミットがありません）。再開すると確かめ直します。",
  "github.ghMissing":
    "gh コマンドが見つかりません。GitHub CLI をインストールし、gh auth login でログインしてください。",
  "github.accountRequired": ({ project, host }) =>
    `プロジェクト「${project}」の ${host} の GitHub アカウントが選ばれていません。プロジェクトの設定で選んでから再開してください。`,
  "github.accountUnavailable": ({ account, host }) =>
    `${host} のアカウント「${account}」で gh にログインしていません。gh auth login --hostname ${host} でログインするか、プロジェクトの設定でアカウントを選び直してください。`,
  "github.ghFailed": ({ detail }) => `gh コマンドが失敗しました：${detail}`,
  "githubComments.unreadable":
    '出力の sacty-github-comments を読めませんでした（1つだけ、{"comments": [{"url": …, "body": …}]} の形で書く）。どのコメントも投稿していません。',
  "githubComments.tooMany": ({ max }) =>
    `頼まれたコメントが ${max} 件より多いので、どれも投稿していません。`,
  "githubComments.tooLong": ({ max }) =>
    `コメントの本文が ${max} 文字より長いので、どれも投稿していません。`,
  "githubComments.targetInvalid":
    "投稿先が、PR（https://<ホスト>/<owner>/<repo>/pull/<番号>）か Issue（…/issues/<番号>）の URL ではありません。",
  "githubComments.targetNotAllowed":
    "投稿先が、プロジェクトの対象のリポジトリではありません（対象の外には投稿しません）。",
  "review.verdictMissing": "判定がありません。",
  "review.verdictIdMismatch": ({ expected, answered }) =>
    `観点 ${expected} の判定がありません（ゴールガーディアンは、判定する観点に無い ID ${answered} で答えました）。`,
  "review.unreadable": "最終レビューの出力から、判定を読み取れませんでした。",
  "review.viewpointUnmapped": "実装が、この観点にテストを対応させていません。",
  "run.guardianFailed": ({ detail }, text) =>
    `ゴールガーディアンの実行に失敗しました：${text(detail)}`,
  "verify.testsUnavailable": ({ detail }, text) => `テストを実行できません：${text(detail)}`,
  "verify.workspaceMissing": "実装の作業領域が見つからないため、検証できません。",
  "verify.commandMissing": ({ commands: names, image, step }) => {
    const label = step === "reproduce" ? "再現" : "実装";
    const commands = names.join("・");
    return image === "default"
      ? `テスト（検証）のコマンドに書いた ${commands} が、テストを実行するイメージ（既定のイメージ）に入っていません。既定のイメージは最低限のものです。config.yaml の images に、${commands} を入れたイメージ（packages に OS のパッケージを、無ければ run に導入のコマンドを書き、description にもそのツールを書く）を足し、npx sacty image build <名前> で作ってから、タスクの詳細の「工程のイメージ」で${label}の工程をそのイメージに変えて、再開してください（再開すると、テストを実行し直します）。`
      : `テスト（検証）のコマンドに書いた ${commands} が、テストを実行するイメージ（${image}）に入っていません。config.yaml の images.${image} の packages（OS のパッケージ）か run（導入のコマンド）で入れ、npx sacty image build ${image} で作り直してから、再開してください（再開すると、テストを実行し直します）。入っているイメージがほかにあれば、タスクの詳細の「工程のイメージ」で${label}の工程のイメージを変えてから再開してもかまいません。`;
  },
  "verify.diffUnavailable": ({ detail }, text) =>
    `差分を取得できないため、最終レビューをしていません：${text(detail)}`,
  "verify.finalReviewFailed": ({ detail }, text) =>
    `ゴールガーディアンの最終レビューを実行できませんでした：${text(detail)}`,
  "verify.tooManyAttempts": ({ count }) =>
    `実装の検証（テストと最終レビュー）に、${count}回続けて通りませんでした。`,
  "pr.unavailable": ({ detail }, text) => `PRを作れません：${text(detail)}`,
  "pr.workspaceMissing": "実装の作業領域が無いため、PRを作れません。",
  "pr.taskBranchChanged": ({ branch, paths, count }, text) =>
    `タスクブランチ ${text(branch)} に、Sacty が積んでいない変更があります（${text(paths)}${count > 10 ? ` ほか、全${count}件` : ""}）。実装の作業領域には含まれていないので、このまま実装を積むと消えてしまうため、PR を出すのを止めました。タスクブランチからその変更を取り除いてから再開してください（変更が必要なら、PR の指摘として書くと、Sacty が実装に反映します）。`,
  "pr.failed": ({ detail }, text) => `PRを作れませんでした：${text(detail)}`,
  "pr.templateFailed": ({ path, status, detail }, text) =>
    `PR テンプレート${path ? `（${path}）` : ""}を確かめられませんでした${status ? `（HTTP ${status}）` : ""}${text(detail) ? `：${text(detail)}` : ""}`,
  "pr.templateTooLarge": ({ path, size, limit }) =>
    `PR テンプレート（${path}）が大きすぎるので使いませんでした（${size} バイト。上限 ${limit} バイト）。`,
  "pr.templateInvalid": ({ path }) =>
    `PR テンプレート（${path}）の中身を読めなかったので使いませんでした（UTF-8 のテキストではない）。`,
  "pr.templateEmpty": ({ path }) => `PR テンプレート（${path}）が空なので使いませんでした。`,
  "pr.templateOrgPrivate": ({ repo }) =>
    `Org の .github リポジトリ（${repo}）は非公開なので、そのテンプレートは使いません（GitHub と同じく、公開のものだけを使います）。`,
  "cleanup.prRepoUnknown": "PRを作ったリポジトリの記録が無いため、閉じませんでした。",
  "cleanup.noWorkspace": "作業領域が無いため、ブランチを消せません。",
  "cleanup.containerUnconfirmed":
    "コンテナが止まったことを確かめられないため、作業領域は消していません。",
  "git.unavailable": ({ detail }) => `gitを実行できません（${detail}）。`,
  "git.failed": ({ command, detail }) => `git ${command} に失敗しました：${detail}`,
  "git.exitCode": ({ command, code }) => `git ${command} に失敗しました：終了コード ${code}`,
  "git.aborted": "上限の時間を過ぎたので、git を止めました。",
  "git.invalidBaseCommit": "起点のコミットが不正です。",
  "git.baseCommitMissing": ({ commit }) =>
    `作業領域を用意し直そうとしましたが、タスクの起点のコミット（${commit.slice(0, 7)}）を取得できません。起点を変えずに止めました。`,
  "git.invalidParentCommit": "積む先のコミットが不正です。",
  "git.invalidBranch": "ブランチ名が不正です。",
  "git.invalidPath": "コミットするファイルのパスが不正です。",
  "git.nothingToCommit": "起点から変更がないため、コミットできません。",
  "git.notSactyBranch": "Sacty のブランチではありません。",
  "git.fileNotRegular": ({ path }) => `${path} は通常のファイルではありません。`,
  "git.fileTooLarge": ({ path, limit }) => `${path} が大きすぎます（上限 ${limit} バイト）。`,
  "git.fileNotText": ({ path }) => `${path} は UTF-8 のテキストではありません。`,
  "github.failed": ({ action, status, detail, hint }) =>
    `${githubActionJa[action]}：GitHub API ${status} ${detail}${githubHintJa[hint]}`,
  "github.eventsIncomplete":
    "ページ数の上限に達したため、PR のできごとを最後まで読めませんでした。",
  "intake.searchTimedOut":
    "GitHub の検索が時間内に終わらず、結果の一部しか得られませんでした（次の取り込みで、この範囲を検索し直します）。",
  "intake.tooManySameTime":
    "同じ日時に更新された Issue が多すぎるため、すべてを検索できませんでした。",
  "intake.partial":
    "Issue が多すぎるため、この取り込みでは途中までしか検索していません（次の取り込みで続きを検索します）。",
  "intake.rateLimited":
    "GitHub の検索のレート制限に達しました。次の取り込みで、続きから検索します。",
  "intake.skippedRateLimited": "レート制限のため、次の取り込みで検索します。",
  "intake.rerequestUnchecked": ({ pr, detail }, text) =>
    `${pr} でレビューが再依頼されたかを確かめられませんでした（次の取り込みで確かめ直します）：${text(detail)}`,
  "context.cycle": ({ key }) => `コンテキストの継承が循環しています（${key}）。`,
  "context.tooDeep": ({ max }) => `コンテキストの継承が深すぎます（上限 ${max} 段）。`,
  "context.fetchFailed": ({ key, detail }, text) =>
    `コンテキストリポジトリ（${key}）を取得できません：${text(detail)}`,
  "context.fileUnreadable": ({ key, file, detail }) => `${key} の ${file} を読めません：${detail}`,
  "context.fileInvalid": ({ key, file, path, detail }, text) =>
    `${key} の ${file} に誤りがあります（${path}）：${text(detail)}`,
  "context.notPlainFile": ({ key, path, symlink }) =>
    `${key} の ${path} は${symlink ? "シンボリックリンク" : "通常のファイルでないもの"}です。コンテキストリポジトリでは、設定・規約・スキルに通常のファイルとディレクトリだけを使えます。`,
  "context.pathMissing": ({ key, path }) =>
    `${key} に、コンテキストのディレクトリ ${path} がありません（ディレクトリの途中にシンボリックリンクも使えません）。`,
  "context.copyAborted": ({ key }) =>
    `上限の時間を過ぎたので、ローカルのディレクトリ（${key}）を写すのを止めました。`,
  "context.submoduleNotCheckedOut": ({ key, path }) =>
    `${key} のサブモジュール ${path} を取り込んでいません。そのディレクトリで git submodule update --init --recursive を実行してから、やり直してください。`,
  "context.extendsOutside": ({ key, value }) =>
    `${key} の sacty-context.yaml の extends（${value}）は、リポジトリの外を指しています。`,
  "context.localExtendsFromRemote": ({ key, value }) =>
    `${key} は git で取得した層のため、ローカルのパス（${value}）を継承できません。ローカルのパスは、プロジェクトの設定か、ブランチ・タグの無いローカルのパスの層の extends にだけ書けます。`,
  "context.lockedOverride": ({ from, kind, name, lockedBy }) =>
    `${from} は${contextKindJa[kind]}「${name}」を上書きしようとしましたが、${lockedBy} で上書き禁止のため上位のものを使いました。`,
  "context.lockedRemove": ({ from, kind, name, lockedBy }) =>
    `${from} は${contextKindJa[kind]}「${name}」を取り除こうとしましたが、${lockedBy} で上書き禁止のため残しました。`,
  "context.reservedSetting": ({ from, file, key }) =>
    `${from} の ${file} の「${key}」は Sacty が決める項目のため、使いませんでした。`,
  "context.hostPlatform": ({ from, name }) =>
    `${from} の platforms.yaml の外部 PF「${name}」は、config.yaml の gateway.platforms に同じ名前があるため、config.yaml のものを使いました。`,
  "context.hostMcpOverride": ({ from, name }) =>
    `${from} の mcp.yaml の MCP サーバー「${name}」は、config.yaml の gateway.mcp_servers に同じ名前があるため、config.yaml のもの（ホストの MCP サーバー）を使いました。`,
  "context.mcpHostUnavailable": ({ name, from, project, detail }, text) =>
    `${projectJa(project)}${from} の mcp.yaml の MCP サーバー「${name}」をホストで起動できません：${text(detail)}。1分ごとに起動し直します（準備ができるまで、エージェントはこの MCP を使えません）。`,
  "context.mcpHostReadyTimeout": ({ name, from, project, seconds }) =>
    `${projectJa(project)}${from} の mcp.yaml の MCP サーバー「${name}」の準備が、ホストで ${seconds} 秒待ってもできません（起動の途中）。準備ができるまで、エージェントはこの MCP を使えません。`,
  "context.mcpHostCommandMissing": ({ name, from, project, command }) =>
    `${projectJa(project)}${from} の mcp.yaml の MCP サーバー「${name}」のコマンド「${command}」が、Sacty を動かすホストに見つかりません。ホストに入れるか、コンテナの中で起動するなら、このサーバーに via_gateway: false を書いてください。`,
  "context.duplicateSkill": ({ from, name, path, usedPath }) =>
    `${from} のスキル「${name}」が skills/${usedPath} と skills/${path} の両方にあるため、skills/${usedPath} を使いました。`,
  "context.mcpTimeoutOverRun": ({ name, key, seconds, minutes }) =>
    `MCP サーバー「${name}」の ${key}（${seconds} 秒）は、エージェントの実行全体の上限（${minutes} 分）以上です。実行全体が先に止まるため、上限より短くしないと意味がありません。`,
  "config.missing": ({ path }) =>
    `設定ファイルがありません（${path}）。\`sacty config init\` で作成してください。`,
  "config.unreadable": ({ detail }) => `設定ファイルのYAMLを読めません：${detail}`,
  "config.stepAgentsPrRemoved":
    "設定ファイルの step_agents に pr があります。「PR作成」の工程は無くなりました（実装の工程の中で PR を作ります）。step_agents から pr を消してください。",
  "config.invalid": ({ path, detail }, text) =>
    `設定ファイルに誤りがあります（${path}）：${text(detail)}`,
  "config.authUnsupported": ({ runtime, mode, supported }) =>
    `${runtime} では ${mode} を使えません（使えるもの：${supported}）。`,
  "config.subscriptionSecret":
    "Claude Code のサブスクリプションには、トークンの秘密情報名（secret）が必要です。",
  "config.bedrockEndpointCodexOnly":
    "Bedrock の接続先（endpoint）は Codex だけで選べます。Claude Code では書かないでください。",
  "config.platformAuth":
    "組織内 PF の認証には、secret（固定のキー）か token（トークンの取得）のどちらか一方を書いてください。",
  "config.platformTokenQuery":
    'トークンの取得の query は「名前: 値」で書いてください（名前は空にできず、値は文字列。例 api_token: "{{secret}}"）。',
  "config.platformTokenUrlSecret":
    'トークンの取得の url には {{secret}} を書けません。キーをクエリで送るときは query に書いてください（例 query: { api_token: "{{secret}}" }）。',
  "config.platformTokenBody":
    "トークンの取得の method が GET・HEAD のときは、json・form（本文）を書けません。キーは query か headers で送ってください。",
  "gateway.mcpUnavailable": ({ name, detail }, text) =>
    `ホストの MCP サーバー「${name}」の準備ができません（起動・認証に失敗）：${text(detail)}。1分ごとに起動し直します。`,
  "gateway.mcpReadyTimeout": ({ name, seconds }) =>
    `ホストの MCP サーバー「${name}」の準備が ${seconds} 秒待ってもできません（起動・認証の途中）。準備ができるまで、エージェントはこの MCP を使えません。`,
  "gateway.platformUnavailable": ({ name, detail }, text) =>
    `組織内 PF「${name}」の認証情報を用意できません：${text(detail)}（ほかの PF は使えます）`,
  "config.gatewayUnsupported":
    "ゲートウェイ経由（via_gateway）は、providers.codex の auth.mode が bedrock か openai-compatible のときだけ使えます。",
  "config.providerLegacyName": ({ name }) =>
    `providers に書けるのは codex と claude だけです（"${name}" があります）。名前を付けた接続先は providers.codex の auth（mode: openai-compatible、base_url、secret）に書き直してください。`,
  "config.agentLegacyKey": ({ key }) =>
    `エージェントには ${key} を書けません。認証・接続先は providers.codex・providers.claude の auth・via_gateway に、単価は providers.<runtime>.available_models にモデルごとに書いてください。`,
  "config.defaultsUnreadable": ({ path, detail }) =>
    `Sacty のエージェントの既定（${path}）を読めません：${detail}。Sacty を入れ直してください。`,
  "config.agentUnavailable": ({ key, id, reason }, text) =>
    `${key} の "${id}" は使えません：${text(reason)}`,
  "config.noDefaultAgent":
    "工程を動かす AI がありません。providers.codex か providers.claude に、接続先と既定のモデルの単価（available_models）を書いてください（default_agent を書いて選ぶこともできます）。",
  "config.agentRuntimeRequired":
    "Sacty の既定に無い名前のエージェントには、runtime（claude-code・codex・stub）を書いてください。",
  "config.agentModelRequired":
    "エージェントには model を書いてください（単価を providers の available_models から引くため）。",
  "config.agentProviderMissing": ({ id, provider }) =>
    `エージェント「${id}」は、providers.${provider} が無いので使えません。`,
  "config.modelPriceMissing": ({ provider, model, agents }) =>
    `providers.${provider}.available_models に ${model} の単価が無いので、${agents} を使えません。単価を足してください。`,
  "gateway.unavailable":
    "ホストのゲートウェイが起動していないため、ゲートウェイ経由のエージェントを実行できません。Sacty を起動し直してください。",
  "config.agentMissing": ({ key, id }) => `${key} の "${id}" が agents にありません。`,
  "config.agentFallbackSelf": ({ id }) =>
    `エージェント「${id}」の fallback に、そのエージェント自身は書けません。`,
  "config.agentFallbackUnavailable": ({ id, fallback, reason }, text) =>
    `エージェント「${id}」の代わり（fallback）の「${fallback}」は使えないので、利用制限のときに切り替えません：${text(reason)}`,
  "agent.stepMissing": "その工程は、このタスクの工程にありません。",
  "agent.stepNotChangeable":
    "統合レビューは、ゴールガーディアン（config.yaml の guardian_agent）が実行するため、工程のエージェントを変えられません。",
  "agent.notInAgents": ({ name }) =>
    `エージェント「${name}」は使えるエージェントにありません。画面に出ているエージェントから選んでください。`,
  "agent.unchanged": ({ name }) => `工程のエージェントは、すでに「${name}」です。`,
  "audit.notFound": "このタスクの監査はありません。",
  "audit.proposalNotFound": "その提案はありません。",
  "audit.alreadyDecided": "その提案は、すでに採用か却下をしています。",
  "audit.memoryNotFound": "そのメモリーはありません。",
  "audit.memoryDeleted": "そのメモリーは、すでに消しています。",
  "audit.targetNotCandidate":
    "その宛先は、この提案の宛先の候補にありません。候補から選んでください。",
  "audit.notPaused": "予算で一時停止している監査ではありません。",
  "audit.runFailed": ({ detail }, text) => `監査を実行できませんでした：${text(detail)}`,
  "audit.unreadable": "監査のエージェントの出力を、決まった形で読めませんでした。",
  "audit.interrupted": "デーモンが止まったため、監査が途中で終わりました。",
  "audit.notAdoptable": "このタスクは中止されたため、提案を採用・却下できません。",
  "agent.configUnavailable": ({ detail }, text) =>
    `config.yaml を読めないため、工程のエージェントを変えられません。設定を直してから、もう一度変えてください：${text(detail)}`,
  "agent.chosenMissing": ({ step, name }) =>
    `工程（${step}）に選んだエージェント「${name}」が使えるエージェントにありません（設定から消した・接続先や単価が無いなど）。タスクの詳細でエージェントを選び直してから、再開してください。`,
  "config.tierRuntime": ({ id, runtime, expected }) =>
    `agents の "${id}" は段階のエージェントなので、runtime を ${expected} にしてください（${runtime} になっています）。`,
  "agents.tierConnectionDiffers": ({ tier, id, parent }) =>
    `段階「${tier}」（${id}）は、工程のエージェント（${parent}）と認証・接続先が違うため、サブエージェントの定義を置きませんでした。`,
  "context.reservedTierFile": ({ from, path }) =>
    `${from} の ${path} は、Sacty が段階のサブエージェントの定義として作るため、写しませんでした。`,
};

/** 英語。用語は画面の用語集（apps/web の labels.ts）に合わせる。 */
const en: MessageDictionary = {
  "task.notFound": "Task not found.",
  "task.repositoryMissing": ({ project }) =>
    `The project "${project}" has no targets (organizations or repositories). Add one in the project settings, then create the task.`,
  "task.repositoryUnknown": ({ project }) =>
    `Choose the target repository from the targets (organizations or repositories) of the project "${project}".`,
  "task.templateRepositoryRequired":
    "Choose a target repository for this template (it cannot be created without one).",
  "task.reviewPlanNeedsPullRequest":
    'The plan "Review only" needs a target repository and a link to a pull request of that repository in the title or description.',
  "task.cancelled": "This task has been cancelled.",
  "task.invalidState": "This action is not available in the task's current state. Reload the page.",
  "project.notFound": "Project not found.",
  "project.targetDuplicated": ({ scope, target }) =>
    `The ${scopeEn[scope]} "${target}" is listed more than once.`,
  "project.ticketKeyDuplicated": ({ platform, key }) =>
    `The key "${key}" of the ticket source (${platform}) is duplicated.`,
  "project.ticketKeyTaken": ({ platform, key, project }) =>
    `The key "${key}" of the ticket source (${platform}) is already imported by the project "${project}".`,
  "project.sharedComposeDuplicated": ({ name }) =>
    `The shared compose name "${name}" is duplicated.`,
  "project.hasActiveTasks": ({ count }) =>
    `The project cannot be deleted because ${count} task(s) are unfinished (or still running or queued). Complete or cancel them, then delete the project.`,
  "project.targetTaken": ({ scope, target, project }) =>
    `The ${scopeEn[scope]} "${target}" is already registered in the project "${project}".`,
  "pause.alreadyPaused": "The task is already paused.",
  "pause.awaitingPerson": "The task is waiting for your decision, so there is no need to pause it.",
  "pause.reachedApproval":
    "The work finished before it could stop and the task is now waiting for approval, so it was not paused (decide on the PR for a step that opened one, or cancel the task to stop it).",
  "pause.waitingTasks":
    "The task is waiting for other tasks to finish, so there is no need to pause it.",
  "pause.guardianJudging":
    "The Goal Guardian is judging a change request. You can pause once it finishes.",
  "cancel.alreadyCancelled": "The task is already cancelled.",
  "cancel.cleaningUp": "Cleaning up after cancellation.",
  "cancel.guardianJudging":
    "The Goal Guardian is judging a change request. You can cancel once it finishes.",
  "rerun.notCancelled": "Only a cancelled task can be rerun.",
  "rerun.notRerunnable":
    "This task can't be rerun (rerun a subtask from its parent, and request a PR review again on the PR).",
  "rerun.alreadyRerun": "This task has already been rerun. Check the task created by the rerun.",
  "resume.notPaused": "The task is not paused.",
  "resume.testsNotUndecided":
    "This task did not stop because its test command was undetermined. Resume without specifying how to handle tests.",
  "resume.bugfixNeedsTestCommand":
    "A bug fix (with a reproduce step) cannot proceed without tests. Specify the test command.",
  "operation.incomplete":
    "The operation has not started. The target, changes, verification, or connection is missing. Create a new task with the missing details.",
  "operation.attempted":
    "The operation has already started and will not be repeated. Check the external state and execution log, cancel this task, and create a new task only for any remaining work.",
  "operation.unconfirmed":
    "The operation could not be confirmed successful and will not be retried automatically. Check the execution log and external state, cancel this task, and create a task for remaining work if needed.",
  "operation.connectionMissing":
    "The operation has not started. The selected connection is unavailable. Check its configuration before resuming.",
  "resume.capRequired": "To resume a task stopped by its budget, set a new cap.",
  "resume.capTooLow": ({ usedUsd }) =>
    `Set a new cap greater than the amount used (${formatUsd(usedUsd)}).`,
  "containers.notStopped": ({ names }) =>
    `Could not confirm that the containers (${names}) stopped. Check with docker ps that they are stopped, then resume.`,
  "change.notAwaiting": "This change request is not awaiting a decision.",
  "gate.notAwaiting": "The task is not awaiting approval.",
  "gate.stepNotAwaiting": "This step is not awaiting approval.",
  "gate.staleSubmission": ({ submission, current }) =>
    `The deliverable you are viewing (submission ${submission}) is not the latest. Reload the page and review the latest submission (${current}).`,
  "gate.invalidTarget": "Changes cannot be requested on this step.",
  "gate.approveOnPullRequest": ({ url }) =>
    `For a task with a PR, merging the PR approves it. Review and merge the PR on GitHub (${url}).`,
  "gate.remarksRequired": "Enter at least one comment to request changes.",
  "gate.reproduceNotApprovable":
    "The bug was not reproduced, so the task can't move on. Request changes with hints for reproducing it to try again, or cancel the task.",
  "reproduce.noTests":
    "The reproduce agent did not report a test that reproduces the bug (not reproduced).",
  "reproduce.notChecked":
    "The reproduce agent did not report that it ran its test and saw it fail because of the bug (not reproduced).",
  "reproduce.runFailed": ({ detail }, text) =>
    `Could not run the reproduction test (${text(detail)}), so the reproduction is not confirmed. Check the cause, then resume to run the test again.`,
  "gate.overLimit": ({ limit }) =>
    `Change requests reached the limit (${limit}). To continue, choose to request changes over the limit.`,
  "remark.notFound": "Comment not found.",
  "schedule.notFound": "Scheduled task not found.",
  "schedule.nameRequired": "Enter a name.",
  "schedule.nameTooLong": `Keep the name within ${SCHEDULE_NAME_MAX} characters.`,
  "schedule.timeInvalid": "Enter the time as HH:MM (24-hour clock).",
  "schedule.daysRequired": "Choose at least one day of the week.",
  "schedule.dayInvalid": "Enter a day between 1 and 31.",
  "schedule.projectMissing": "The project of this scheduled task was not found.",
  "input.titleRequired": "Enter a title.",
  "input.titleTooLong": `Keep the title within ${TASK_TITLE_MAX} characters.`,
  "input.bodyTooLong": `Keep the details within ${TASK_BODY_MAX.toLocaleString("en-US")} characters.`,
  "input.noteTooLong": `Keep the additional notes within ${RERUN_NOTE_MAX.toLocaleString("en-US")} characters.`,
  "input.auditNoteTooLong": `Keep the note you attach to the adoption within ${AUDIT_ADOPT_NOTE_MAX.toLocaleString("en-US")} characters.`,
  "input.remarkTooLong": "Keep each comment within 2,000 characters.",
  "input.questionRequired": "Enter a question.",
  "input.questionTooLong": `Keep the question within ${QUESTION_MAX.toLocaleString("en-US")} characters.`,
  "chat.answering":
    "The previous question is still being answered. Ask again after the answer appears.",
  "chat.budgetExceeded": ({ usedUsd, capUsd }) =>
    `You can't ask because the budget cap has been reached (${formatUsd(usedUsd)} / ${formatUsd(capUsd)}). The cost of answers is part of the task's budget.`,
  "chat.unavailable":
    "You can't ask because of a problem in the settings (config.yaml). Check the problem shown at the top of the page.",
  "chat.failed": ({ detail }, text) =>
    `The Orchestrator could not answer the question: ${text(detail).replace(/[。.]\s*$/, "")}.`,
  "chat.emptyAnswer": "The Orchestrator's answer was empty.",
  "chat.cancelled": "Stopped answering because the task was cancelled.",
  "export.notDecided": "Not exported because the Orchestrator did not choose where to export.",
  "export.destinationUnknown": ({ name }) =>
    `Not exported because "${name}", chosen by the Orchestrator, is not an available connection (gateway.platforms or an MCP server).`,
  "export.destinationMissing": ({ name }) =>
    `The export destination "${name}" is not an available connection (gateway.platforms or an MCP server).`,
  "export.failed": ({ detail }, text) =>
    `Could not export: ${text(detail).replace(/[。.]\s*$/, "")}.`,
  "export.unreadable": "Could not read the exported URL from the export agent's output.",
  "deploy.skillMissing":
    "Skipped the check by the skill because there is no deployment check skill (.agents/skills/deployment-observer/SKILL.md or .claude/skills/deployment-observer/SKILL.md).",
  "deploy.skillOutside": ({ path }) =>
    `Did not use the deployment check skill (${path}) because its symbolic link points outside the repository (or is followed too many times).`,
  "deploy.skillUnreadable": ({ path, detail }, text) =>
    `Did not use the deployment check skill (${path}) because it could not be read: ${text(detail)}`,
  "deploy.budgetExceeded":
    "Did not run the check by the skill because the budget cap has been reached.",
  "deploy.checkFailed": ({ detail }, text) =>
    `Could not run the check by the skill: ${text(detail)}`,
  "deploy.unreadable": "Could not read the result of the check by the skill (sacty-deployment).",
  "deploy.undetermined":
    "The agent could not determine the result of the check by the skill (CI/CD and the deployed app).",
  "deploy.stopped": "Stopped the check by the skill (paused or cancelled).",
  "deploy.noSkill":
    "The repository has no deployment check skill (.agents/skills/deployment-observer/SKILL.md or .claude/skills/deployment-observer/SKILL.md).",
  "deploy.skillLookupFailed": ({ detail }, text) =>
    `Could not look for the deployment check skill: ${text(detail)}`,
  "deploy.stepSkipped": ({ detail }, text) =>
    `Skipping the after-merge watch step (CI/CD is not watched either). ${text(detail)}`,
  "export.budgetExceeded":
    "Not exported because the budget cap has been reached. Raise the cap, then export again.",
  "export.stopped": "The export was interrupted because a person stopped it.",
  "export.notRetryable": "Only approved outputs that could not be exported can be exported again.",
  "input.tooManyRemarks": "Enter up to 50 comments at a time.",
  "input.nameRequired": "Enter a name.",
  "input.invalidGithubName": "This is not a valid GitHub name.",
  "input.invalidRepo": "Enter the repository as a URL (e.g. https://github.com/acme/app).",
  "input.invalidOrg": "Enter the org as a URL (e.g. https://github.com/acme).",
  "input.urlSsh":
    "SSH URLs can't be used. Enter https://<host>/<owner>/<name> (cloning uses the token of the gh account).",
  "input.urlNotHttps": "http URLs can't be used. Enter an https URL.",
  "input.urlCredentials": "Don't put a user name, password or token in the URL.",
  "input.urlHost":
    "Can't read the host of the URL (use letters, digits, '.', '-', and an optional :port).",
  "input.urlExtraPath":
    "Remove the extra part of the URL (a repository is https://<host>/<owner>/<name> and an org is https://<host>/<owner>; no /tree/… and so on).",
  "input.repoLooksLikeOrg": 'This is an org URL. Set the scope to "Org" or enter a repository URL.',
  "input.orgLooksLikeRepo":
    'This is a repository URL. Set the scope to "Repository" or enter an org URL.',
  "input.invalidHost": "This is not a valid host name.",
  "input.contextRepoRequired": "Enter the context repository.",
  "input.sharedComposeName":
    "Enter the shared compose name with lowercase letters, digits, _ and - only, starting with a letter or digit (up to 40 characters).",
  "input.sharedComposeRepoRequired": "Enter the repository of the shared compose.",
  "input.sharedComposeRepoCredential":
    "Don't put a user name, password or token in the repository URL of the shared compose (HTTPS GitHub is fetched with the project's GitHub account).",
  "input.sharedComposeRepoForm":
    "Enter the repository of the shared compose as a git URL (https://…, ssh://…, git@host:…) or an absolute local path.",
  "input.sharedComposeFile":
    "Enter the compose file of the shared compose as a path relative to the repository root (without .. or $).",
  "input.invalidRef": "Enter a branch or tag name as the ref.",
  "input.invalidContextPath":
    "Enter the path relative to the repository root (e.g. contexts/team, without . or .. parts).",
  "input.invalidLabel": "A label can't contain \" or \\.",
  "input.issueIntervalInvalid":
    "Enter a whole number of 60 or more (seconds) for the issue intake interval (300 seconds if empty).",
  "input.reviewIntervalInvalid":
    "Enter a whole number of 60 or more (seconds) for the PR review intake interval (300 seconds if empty).",
  "input.ticketIntervalInvalid":
    "Enter a whole number of 60 or more (seconds) for the ticket intake interval (300 seconds if empty).",
  "input.notExportFile": "This is not a Sacty project definition file.",
  "input.unsupportedVersion": `Unsupported version (supported: ${PROJECT_EXPORT_VERSION}).`,
  "input.exportVersionWithNotification": `Version 3 and 4 files cannot be imported. Since version ${PROJECT_EXPORT_VERSION}, the Slack notification destination is no longer part of a project (it is in the Sacty settings). Export the project again with the current Sacty.`,
  "input.required": "This field is required.",
  "input.tooShort": ({ minimum }) => `Enter at least ${minimum} characters.`,
  "input.tooLong": ({ maximum }) => `Keep it within ${maximum.toLocaleString("en-US")} characters.`,
  "input.tooFew": ({ minimum }) => `Add at least ${minimum}.`,
  "input.tooMany": ({ maximum }) => `Add up to ${maximum}.`,
  "input.numberTooSmall": ({ minimum, inclusive }) =>
    `Enter a value ${inclusive ? "of at least" : "greater than"} ${minimum}.`,
  "input.numberTooLarge": ({ maximum, inclusive }) =>
    `Enter a value ${inclusive ? "of at most" : "less than"} ${maximum}.`,
  "input.invalidType": "The value has the wrong type.",
  "input.invalidFormat": "The format is not valid.",
  "input.invalidValue": "The value is not valid.",
  "input.unknownKeys": ({ keys }) => `Unknown fields: ${keys}.`,
  "input.invalid": "The input is not valid.",
  "input.secretName": "Use only letters, digits, and . _ - in secret names.",
  "input.ticketKey":
    "Write JIRA project keys in uppercase letters, digits and _, starting with a letter (e.g. PAY). Write at least one.",
  "ticket.platformMissing": ({ platform }) =>
    `The ticket source "${platform}" is neither in gateway.platforms in config.yaml nor in platforms.yaml of the project's context.`,
  "ticket.notAllowed": ({ platform, method, path }) =>
    `"${method} ${path}" is not in the allow list of "${platform}". Add it to gateway.platforms.${platform}.allow in config.yaml (for a platform of the project's context, platforms.${platform}.allow in platforms.yaml).`,
  "ticket.requestFailed": ({ platform, status, detail }) =>
    `The API of "${platform}" failed (${status}): ${detail}`,
  "gather.failed": ({ detail }, text) =>
    `The information gatherer could not summarize the information related to the task: ${text(detail)} Resume to gather again.`,
  "gather.unreadable":
    "Could not read the summary of the gathered information from the gatherer's output.",
  "ticket.triageFailed": ({ detail }, text) =>
    `The Orchestrator could not decide the repository from the ticket: ${text(detail)} Choose a repository and resume.`,
  "ticket.triageUnreadable":
    "Could not read the repository, title and summary from the Orchestrator's output.",
  "ticket.repoNotCandidate": ({ repo }) =>
    `The repository the Orchestrator chose (${repo}) is not a target of the project.`,
  "ticket.noCandidates":
    "The project has no candidate repository (the repositories of org targets may not be readable).",
  "ticket.repoChosenByPerson": "A person chose the repository.",
  "ticket.notTriageable":
    "A repository can be chosen only for a task imported from a ticket whose repository is not decided yet.",
  "repo.chooseFailed": ({ detail }, text) =>
    `The Orchestrator could not decide the repository to work in: ${text(detail)} Choose a repository from the project's targets and resume.`,
  "repo.notChosen":
    "The Orchestrator chose a plan that changes code but did not name the repository to work in.",
  "repo.notCandidate": ({ repo }) => `The repository (${repo}) is not a target of the project.`,
  "repo.chosenByPerson": "A person chose the repository.",
  "repo.notChoosable":
    "A repository can be chosen only for a paused task created without a repository whose steps are not decided yet.",
  "repo.stepNeedsRepository": ({ step }) =>
    `The step (${step}) needs a target repository, but this task has none.`,
  "input.platformName":
    "Write an internal platform name in lowercase letters, digits, and hyphens (starting with a letter or digit).",
  "input.allowRule":
    'Write an allowed API as "METHOD path" (e.g. GET /api/v1/tickets/**; methods: GET, POST, PUT, PATCH, DELETE, HEAD).',
  "input.invalidUrl": "Write a URL (http or https).",
  "input.reasoningEffort":
    "Write the reasoning effort in lowercase letters (e.g. low, medium, high, xhigh).",
  "input.imageName":
    "Use only lowercase letters, digits, _ and - in image names (a name in images in config.yaml, or default).",
  "config.hostAddress":
    "Write gateway.host_address as a host name or IP address (or host-gateway).",
  "config.npmVersion": "Write image_build.npm_version as a version (e.g. 11, 11.6.2) or latest.",
  "config.agentNameEmpty": "The names in agents cannot be empty. Give each agent a name.",
  "config.npmConfigKey":
    "Write each image_build.npm_config item as an npm config name and a one-line value.",
  "config.npmConfigSecret":
    "image_build.npm_config can't contain authentication items (such as _authToken), because they would stay in the image. Use image_build.npm_token or the target repository's settings.",
  "config.imageName":
    "Use only lowercase letters, digits, _ and - in image names (default is reserved for the default image).",
  "config.imageEnvName":
    "Write images env names in uppercase letters, digits and _ (values on one line).",
  "config.imageEnvSecret":
    "images env can't contain credentials (names with TOKEN, PASSWORD and so on, or URLs with a user name or password), because every command in the container can read them.",
  "config.imageEnvReserved":
    "images env can't use PATH, HOME, or names starting with DOCKER_, SACTY_, CODEX_, CLAUDE_, ANTHROPIC_, OPENAI_ or NPM_CONFIG_ (they would clash with Sacty and docker settings).",
  "config.imagePackage":
    "Write package names in images packages (letters, digits and . _ + : @ ~ = -).",
  "config.imageRun":
    "Write one command per line in images run (use separate items for several commands).",
  "config.imageRepo":
    "Write package repository IDs in images enable_repos (starting with a letter or digit; letters, digits and . _ : - only).",
  "config.imageRepoPackages":
    "images enable_repos are the repositories enabled while installing packages. Write packages as well.",
  "config.mavenMirror":
    "Write images maven_mirror as a URL (http or https) without a user name or password.",
  "services.unsafe": ({ file, detail }) =>
    `The compose file (${file}) has settings Sacty can't start: ${detail}. To keep host privileges away from agents, privileged, host networking, mounts outside the workspace and so on are not allowed.`,
  "services.failed": ({ file, detail }) =>
    `Could not start the services in the compose file (${file}). End of the output: ${detail}`,
  "services.sharedUnknown": ({ name }) =>
    `The shared compose "${name}" is not in the project settings. Add it to the project settings, or resume to choose again.`,
  "services.sharedFetchFailed": ({ name, repo, detail }, text) =>
    `Could not fetch the repository (${repo}) of the shared compose "${name}": ${text(detail)}`,
  "services.sharedMissing": ({ name, file }) =>
    `The repository of the shared compose "${name}" has no compose file (${file}). Check the compose file path in the project settings.`,
  "services.sharedUnsafe": ({ name, file, detail }) =>
    `The compose file (${file}) of the shared compose "${name}" has settings Sacty can't start: ${detail}. To keep host privileges away from agents, privileged, host networking, mounts outside the fetched repository and so on are not allowed.`,
  "services.sharedFailed": ({ name, file, detail }) =>
    `Could not start the services in the compose file (${file}) of the shared compose "${name}". End of the output: ${detail}`,
  "image.notInImages": ({ name }) =>
    `The image "${name}" is not in images in config.yaml. Choose a name in images, or default.`,
  "image.unchanged": ({ name }) => `The step already uses the image "${name}".`,
  "image.configUnavailable": ({ detail }, text) =>
    `The step image can't be changed because config.yaml can't be read (the names in images can't be checked). Fix the settings, then change it again: ${text(detail)}`,
  "image.stepMissing": "This task does not have that step.",
  "image.unknown": ({ name }) =>
    `The image "${name}" is not in images in config.yaml. Add it to images, or fix the image of the project target, then resume.`,
  "input.channelRequired": "Write a channel.",
  "input.slackMention":
    "Write each person to mention as a Slack member ID (U… or W…), a user group ID (S…), @here, or @channel (display names don't notify anyone).",
  "input.mentionKinds": "Choose at least one kind of notification to mention in.",
  "notify.failed": ({ detail }, text) =>
    `Could not send the Slack notification: ${text(detail)} (tasks keep running)`,
  "notify.notConfigured": "No Slack notification destination is set in the Sacty settings.",
  "input.secretRef":
    "Write a secret as a keychain name (letters, digits, and . _ -) or a 1Password reference (op://vault/item/field).",
  "input.envName": "The environment variable name is not valid.",
  "input.headerName": "The header name is not valid.",
  "input.mcpName": "Use only letters, digits, and _ - in MCP server names.",
  "input.dollarBrace": "“$\u007b” is not allowed (refer to secrets with { secret: name }).",
  "run.daemonStopped": "The daemon stopped, so the run was interrupted.",
  "run.guardianInterrupted":
    "The daemon stopped, so the Goal Guardian's judgement was interrupted.",
  "run.stoppedByPerson": "Not run because it was stopped by a person.",
  "run.timeout": ({ minutes }) =>
    `Stopped the agent because it ran longer than ${minutesEn(minutes)}.`,
  "run.testTimeout": ({ minutes }) =>
    `Stopped the tests because they ran longer than ${minutesEn(minutes)}.`,
  "run.dockerUnavailable": ({ detail }, text) =>
    `Cannot run docker. Check that Docker is running (${text(detail)}).`,
  "run.dockerFailed":
    "Docker could not run the container (docker run exit code 125). Check that Docker is running and reachable, and check the image.",
  "run.imageMissing": ({ image }) =>
    `The agent image (${image}) is missing. Build it with \`sacty image build\`.`,
  "image.missing": ({ image, command }) =>
    `The agent image (${image}) is missing. Create it with \`${command}\`.`,
  "image.notLocal": ({ image, command }) =>
    `The agent image (${image}) is not on this machine. Runs will try to pull it from the registry. If that fails, create it with \`${command}\`.`,
  "image.dockerUnreachable":
    "Docker is not reachable. Check that Docker is running. Tasks cannot run until Sacty can reach Docker (and the agent images cannot be checked).",
  "image.dockerNotInstalled":
    "The docker command was not found. Install Docker and put the docker command on PATH. Tasks cannot run until then.",
  "image.outdated": ({ image, expected, key, command }) =>
    `${key} in config.yaml (${image}) does not match the image for the running version of Sacty (${expected}). Change the value of ${key} in config.yaml to \`${expected}\`, then create it with \`${command}\`.`,
  "run.authFileUnreadable": ({ path }) =>
    `Cannot read the auth file (${path}). Check that you are signed in.`,
  "run.containerNotConfirmed": ({ name }) =>
    `Could not confirm that the container (${name}) stopped. Check with docker ps.`,
  "run.sessionRestoreFailed": ({ detail }) =>
    `Could not restore the saved orchestrator session into the run's config directory: ${detail}`,
  "run.secretNotFound": ({ name }) =>
    `Secret "${name}" not found. Save it with \`sacty secret set ${name}\`.`,
  "secret.opMissing":
    "The 1Password op command was not found. Install 1Password CLI, sign in, and resume.",
  "secret.prefetchFailed": ({ where, detail }, text) =>
    `Could not get the secret (${where}) at startup: ${text(detail)} Set it up, then press "Get secrets again" in Sacty settings (Sacty also tries again when it is used).`,
  "secret.savePrefetchFailed": ({ where, detail }, text) =>
    `Could not get the secret (${where}) when the project settings were saved: ${text(detail)} Set it up, then press "Get secrets again" in Sacty settings (Sacty also tries again when it is used).`,
  "secret.settingsSavePrefetchFailed": ({ where, detail }, text) =>
    `Could not get the secret (${where}) when the Sacty settings were saved: ${text(detail)} Set it up, then press "Get secrets again" in Sacty settings (Sacty also tries again when it is used).`,
  "secret.contextUnavailable": ({ project, detail }, text) =>
    `Could not read the context of project "${project}", so its secrets were not fetched in advance (Sacty gets them when they are used): ${text(detail)}`,
  "secret.contextTimedOut": ({ seconds }) => `It could not be fetched within ${seconds} seconds.`,
  "secret.opSignedOut": ({ ref }) =>
    `Cannot read "${ref}" because 1Password is not signed in. Sign in with op signin (or the 1Password app integration) and resume.`,
  "secret.opFailed": ({ ref, detail }) =>
    `Could not read "${ref}" from 1Password (${detail}). Check the reference (vault, item, and field) and resume.`,
  "run.repositoryNotConfigured":
    "This task has no target repository (it was created before tasks chose one). Cancel it and create the task again.",
  "guardian.verdictUnreadable": "Could not read a verdict from the Goal Guardian's output.",
  "guardian.reworkUnreadable": "Could not read the step to redo from the Goal Guardian's output.",
  "orchestrator.fallback": ({ detail }, text) =>
    `The Orchestrator could not choose the steps, so the standard steps are used (${text(detail)}).`,
  "orchestrator.unreadable": "Could not read the chosen steps from the Orchestrator's output.",
  "split.unreadable":
    "Could not read the list of subtasks from the task split output. Resume to split again.",
  "split.childCount": ({ min, max, count }) =>
    `Split into ${min}–${max} subtasks (the split has ${count}). Resume to split again.`,
  "split.duplicateKey": ({ key }) =>
    `The subtask key "${key}" is used more than once. Resume to split again.`,
  "split.unknownDependency": ({ key, dependsOn }) =>
    `Subtask "${key}" depends on "${dependsOn}", which is not in the split. Resume to split again.`,
  "split.cycle": ({ keys }) =>
    `The subtask dependencies form a cycle (${keys}). Resume to split again.`,
  "split.repoMissing": ({ key }) =>
    `When splitting a task without a repository, give each subtask a repository from the project's targets (subtask "${key}" has none). Resume to redo the split.`,
  "split.repoNotCandidate": ({ key, repo }) =>
    `The repository given to subtask "${key}" (${repo}) is not a target of the project. Resume to redo the split (choosing from the target repositories).`,
  "split.childCancelled": ({ titles }) =>
    `Subtasks were cancelled (${titles}). Resume to continue without them (subtasks that depend on them also start). Cancel to also cancel the unfinished subtasks.`,
  "integrate.baseUnavailable": ({ branch, detail }, text) =>
    `Could not fetch the latest base branch (${branch}) for the integration review: ${text(detail)}. Resume to run the integration review again.`,
  "integrate.unreadable": "Could not read the verdicts from the integration review output.",
  "orchestrator.failed": ({ detail }, text) =>
    `Could not run the Orchestrator: ${text(detail).replace(/[。.]\s*$/, "")}. Resume to choose the steps again.`,
  "orchestrator.testCommandUnknown":
    'The Orchestrator could not determine the test command of the target repository, so the implementation cannot be verified. Stopping before spending on the steps. When resuming, specify the test command, or choose "Proceed without tests" if the repository does not have tests (the Goal Guardian judges by the purpose of the task). Resuming without either chooses the steps again if no step has started yet.',
  "orchestrator.noTestsContradicted": ({ reason, files }) =>
    `The Orchestrator judged that the target repository has no tests (${reason}), but some files look like tests (${files}). Stopping instead of proceeding without tests. If the files really are tests, specify their test command when resuming. If they are not, choose "Proceed without tests". Resuming without either chooses the steps again if no step has started yet.`,
  "orchestrator.noTestsUncertain": ({ reason }) =>
    `The Orchestrator judged that the target repository has no tests (${reason}), but the repository has too many files to confirm that there are no test files. Stopping instead of proceeding without tests. When resuming, specify the test command, or choose "Proceed without tests" if the repository does not have tests (the Goal Guardian judges by the purpose of the task). Resuming without either chooses the steps again if no step has started yet.`,
  "orchestrator.noTestsUnreadable": ({ reason, path, detail }) =>
    `The Orchestrator judged that the target repository has no tests (${reason}), but the workspace directory (${path}) could not be read (${detail}), so it could not be confirmed that there are no test files. Stopping instead of proceeding without tests. Check that the user running Sacty can read that directory (permissions, disk state). When resuming, specify the test command, or choose "Proceed without tests" if the repository does not have tests (the Goal Guardian judges by the purpose of the task). Resuming without either chooses the steps again if no step has started yet.`,
  "orchestrator.bugfixNeedsTests": ({ reason }) =>
    `The Orchestrator judged that the target repository has no tests (${reason}), but chose a bug fix (reproduce → implement). A reproduction is confirmed by tests, so a test command is required. Specify the test command when resuming (a bug fix cannot proceed without tests). Resuming without it chooses the steps again if no step has started yet.`,
  "implement.testCommandInvalid":
    "The test command the implementation reported (sacty-test-command) is malformed (not readable as JSON, or command is empty, not a string, or longer than 1000 characters). Stopping so that the added tests are not skipped. Resume to run the implementation again.",
  "orchestrator.baseBranchUnavailable": ({ branch, detail }, text) =>
    `Could not prepare the base branch the Orchestrator chose (${branch}), so the default branch is used (${text(detail)}).`,
  "orchestrator.stepReviewFailed": ({ detail }, text) =>
    `The Orchestrator could not review the remaining steps, so no step is skipped (${text(detail).replace(/[。.]\s*$/, "")}).`,
  "review.pullRequestMissing": ({ repo }) =>
    `The task has no PR to review (a URL of a PR in ${repo}).`,
  "review.reviewOnly": ({ via }) =>
    `The PR ${via === "requested" ? "requests your review" : via === "sacty" ? "was created by Sacty in another task" : "has the review label"}, so Sacty only reviews it (the Orchestrator is not used).`,
  "review.reviewOnlyImageChosen": ({ via }) =>
    `The PR ${via === "requested" ? "requests your review" : via === "sacty" ? "was created by Sacty in another task" : "has the review label"}, so Sacty only reviews it (the Orchestrator only chooses the image for the review step).`,
  "review.notRereviewable": "Only a task that posted its review to the PR can be reviewed again.",
  "review.headUnknown":
    "Could not check the PR's head commit before posting (the GitHub response has no commit). Resuming checks again.",
  "github.ghMissing":
    "The gh command was not found. Install GitHub CLI and sign in with gh auth login.",
  "github.accountRequired": ({ project, host }) =>
    `No GitHub account for ${host} is chosen for the project "${project}". Choose one in the project settings, then resume.`,
  "github.accountUnavailable": ({ account, host }) =>
    `The account "${account}" on ${host} is not signed in to gh. Sign in with gh auth login --hostname ${host}, or choose another account in the project settings.`,
  "github.ghFailed": ({ detail }) => `The gh command failed: ${detail}`,
  "githubComments.unreadable":
    'Could not read sacty-github-comments in the output (write exactly one, in the form {"comments": [{"url": …, "body": …}]}). No comment was posted.',
  "githubComments.tooMany": ({ max }) =>
    `More than ${max} comments were requested, so none was posted.`,
  "githubComments.tooLong": ({ max }) =>
    `A comment body is longer than ${max} characters, so none was posted.`,
  "githubComments.targetInvalid":
    "The target is not the URL of a PR (https://<host>/<owner>/<repo>/pull/<number>) or an issue (…/issues/<number>).",
  "githubComments.targetNotAllowed":
    "The target is not a repository of the project's targets (sacty does not post outside them).",
  "review.verdictMissing": "No verdict was given.",
  "review.verdictIdMismatch": ({ expected, answered }) =>
    `No verdict for the viewpoint ${expected} (the goal guardian answered with ${answered}, which is not a viewpoint under review).`,
  "review.unreadable": "Could not read the verdicts from the final review output.",
  "review.viewpointUnmapped": "The implementation did not map a test to this viewpoint.",
  "run.guardianFailed": ({ detail }, text) => `The Goal Guardian run failed: ${text(detail)}`,
  "verify.testsUnavailable": ({ detail }, text) => `Cannot run the tests: ${text(detail)}`,
  "verify.workspaceMissing":
    "The implementation workspace was not found, so it cannot be verified.",
  "verify.commandMissing": ({ commands: names, image, step }) => {
    const label = step === "reproduce" ? "reproduction" : "implementation";
    const commands = names.join(", ");
    return image === "default"
      ? `The test (verification) command uses ${commands}, which is not in the image that runs the tests (the default image). The default image is minimal. Add an image with ${commands} to images in config.yaml (list OS packages in packages, or the install commands in run, and name the tool in description), build it with npx sacty image build <name>, change the image of the ${label} step to it under "Step images" in the task details, and resume (resuming runs the tests again).`
      : `The test (verification) command uses ${commands}, which is not in the image that runs the tests (${image}). Install it with packages (OS packages) or run (install commands) of images.${image} in config.yaml, rebuild with npx sacty image build ${image}, and resume (resuming runs the tests again). If another image has it, you can instead change the image of the ${label} step under "Step images" in the task details and resume.`;
  },
  "verify.diffUnavailable": ({ detail }, text) =>
    `Could not get the diff, so the final review was not done: ${text(detail)}`,
  "verify.finalReviewFailed": ({ detail }, text) =>
    `Could not run the Goal Guardian's final review: ${text(detail)}`,
  "verify.tooManyAttempts": ({ count }) =>
    `Verification of the implementation (tests and final review) failed ${count} times in a row.`,
  "pr.unavailable": ({ detail }, text) => `Cannot open a PR: ${text(detail)}`,
  "pr.workspaceMissing": "There is no implementation workspace, so a PR cannot be opened.",
  "pr.taskBranchChanged": ({ branch, paths, count }, text) =>
    `The task branch ${text(branch)} has changes that Sacty did not push (${text(paths)}${count > 10 ? ` and more, ${count} in total` : ""}). They are not in the implementation workspace and would be removed by the implementation commit, so the PR was not published. Remove those changes from the task branch, then resume (if the change is needed, write it as a PR comment and Sacty will apply it in the implementation).`,
  "pr.failed": ({ detail }, text) => `Could not open the PR: ${text(detail)}`,
  "pr.templateFailed": ({ path, status, detail }, text) =>
    `Could not check the PR template${path ? ` (${path})` : ""}${status ? ` (HTTP ${status})` : ""}${text(detail) ? `: ${text(detail)}` : ""}`,
  "pr.templateTooLarge": ({ path, size, limit }) =>
    `The PR template (${path}) was not used because it is too large (${size} bytes; the limit is ${limit} bytes).`,
  "pr.templateInvalid": ({ path }) =>
    `The PR template (${path}) was not used because its content could not be read (not UTF-8 text).`,
  "pr.templateEmpty": ({ path }) => `The PR template (${path}) was not used because it is empty.`,
  "pr.templateOrgPrivate": ({ repo }) =>
    `The .github repository of the Org (${repo}) is private, so its template is not used (like GitHub, only a public one is used).`,
  "cleanup.prRepoUnknown": "Not closed because the PR's repository was not recorded.",
  "cleanup.noWorkspace": "Cannot delete the branch because there is no workspace.",
  "cleanup.containerUnconfirmed":
    "The workspace was kept because the container could not be confirmed as stopped.",
  "git.unavailable": ({ detail }) => `Cannot run git (${detail}).`,
  "git.failed": ({ command, detail }) => `git ${command} failed: ${detail}`,
  "git.exitCode": ({ command, code }) => `git ${command} failed: exit code ${code}`,
  "git.aborted": "Stopped git because the time limit passed.",
  "git.invalidBaseCommit": "The base commit is not valid.",
  "git.baseCommitMissing": ({ commit }) =>
    `Tried to prepare the workspace again, but the task's base commit (${commit.slice(0, 7)}) could not be fetched. Stopped without changing the base.`,
  "git.invalidParentCommit": "The parent commit is not valid.",
  "git.invalidBranch": "The branch name is not valid.",
  "git.invalidPath": "The path of the file to commit is not valid.",
  "git.nothingToCommit": "Nothing changed since the base, so there is nothing to commit.",
  "git.notSactyBranch": "This is not a Sacty branch.",
  "git.fileNotRegular": ({ path }) => `${path} is not a regular file.`,
  "git.fileTooLarge": ({ path, limit }) => `${path} is too large (limit ${limit} bytes).`,
  "git.fileNotText": ({ path }) => `${path} is not UTF-8 text.`,
  "github.failed": ({ action, status, detail, hint }) =>
    `${githubActionEn[action]}: GitHub API ${status} ${detail}${githubHintEn[hint]}`,
  "github.eventsIncomplete": "Reached the page limit before all PR events could be read.",
  "intake.searchTimedOut":
    "The GitHub search did not finish in time and returned partial results (this range will be searched again next time).",
  "intake.tooManySameTime":
    "Too many issues were updated at the same time, so not all of them could be searched.",
  "intake.partial":
    "There are too many issues, so this intake searched only part of them (the rest will be searched next time).",
  "intake.rateLimited":
    "Reached the GitHub search rate limit. The search will continue from here next time.",
  "intake.skippedRateLimited": "Skipped because of the rate limit; it will be searched next time.",
  "intake.rerequestUnchecked": ({ pr, detail }, text) =>
    `Could not check whether a review was re-requested on ${pr} (it will be checked again next time): ${text(detail)}`,
  "context.cycle": ({ key }) => `The context inheritance has a cycle (${key}).`,
  "context.tooDeep": ({ max }) => `The context inheritance is too deep (limit ${max} levels).`,
  "context.fetchFailed": ({ key, detail }, text) =>
    `Cannot fetch the context repository (${key}): ${text(detail)}`,
  "context.fileUnreadable": ({ key, file, detail }) => `Cannot read ${file} in ${key}: ${detail}`,
  "context.fileInvalid": ({ key, file, path, detail }, text) =>
    `${file} in ${key} has an error (${path}): ${text(detail)}`,
  "context.notPlainFile": ({ key, path, symlink }) =>
    `${path} in ${key} is ${symlink ? "a symbolic link" : "not a regular file"}. Context repositories can use only regular files and directories for settings, rules, and skills.`,
  "context.pathMissing": ({ key, path }) =>
    `${key} has no context directory ${path} (symbolic links can't be used along the path either).`,
  "context.copyAborted": ({ key }) =>
    `Stopped copying the local directory (${key}) because the time limit passed.`,
  "context.submoduleNotCheckedOut": ({ key, path }) =>
    `The submodule ${path} in ${key} isn't checked out. Run git submodule update --init --recursive in that directory, then try again.`,
  "context.extendsOutside": ({ key, value }) =>
    `The extends (${value}) in sacty-context.yaml of ${key} points outside the repository.`,
  "context.localExtendsFromRemote": ({ key, value }) =>
    `${key} is a layer fetched with git, so it can't extend a local path (${value}). Local paths can be written only in the project settings or in the extends of a local path layer without a branch or tag.`,
  "context.lockedOverride": ({ from, kind, name, lockedBy }) =>
    `${from} tried to override the ${contextKindEn[kind]} "${name}", but ${lockedBy} locks it, so the upper one was used.`,
  "context.lockedRemove": ({ from, kind, name, lockedBy }) =>
    `${from} tried to remove the ${contextKindEn[kind]} "${name}", but ${lockedBy} locks it, so it was kept.`,
  "context.reservedSetting": ({ from, file, key }) =>
    `"${key}" in ${file} of ${from} is set by Sacty, so it was not used.`,
  "context.hostPlatform": ({ from, name }) =>
    `The external platform "${name}" in platforms.yaml of ${from} has the same name as one in gateway.platforms of config.yaml, so the one in config.yaml was used.`,
  "context.hostMcpOverride": ({ from, name }) =>
    `The MCP server "${name}" in mcp.yaml of ${from} has the same name as one in gateway.mcp_servers of config.yaml, so the one in config.yaml (the host MCP server) was used.`,
  "context.mcpHostUnavailable": ({ name, from, project, detail }, text) =>
    `The MCP server "${name}" in mcp.yaml of ${from}${projectEn(project)} could not be started on the host: ${text(detail)}. Sacty restarts it every minute (the agent cannot use it until it is ready).`,
  "context.mcpHostReadyTimeout": ({ name, from, project, seconds }) =>
    `The MCP server "${name}" in mcp.yaml of ${from}${projectEn(project)} is still not ready on the host after waiting ${seconds} seconds (it is starting). The agent cannot use it until it is ready.`,
  "context.mcpHostCommandMissing": ({ name, from, project, command }) =>
    `The command "${command}" of the MCP server "${name}" in mcp.yaml of ${from}${projectEn(project)} was not found on the host running Sacty. Install it on the host, or write via_gateway: false for this server to start it in the container.`,
  "context.duplicateSkill": ({ from, name, path, usedPath }) =>
    `${from} has the skill "${name}" in both skills/${usedPath} and skills/${path}, so skills/${usedPath} was used.`,
  "context.mcpTimeoutOverRun": ({ name, key, seconds, minutes }) =>
    `${key} (${seconds}s) of the MCP server "${name}" is not shorter than the limit for a whole agent run (${minutesEn(minutes)}). The run stops first, so it has no effect unless it is shorter.`,
  "config.missing": ({ path }) =>
    `The config file is missing (${path}). Create it with \`sacty config init\`.`,
  "config.unreadable": ({ detail }) => `Cannot read the config file as YAML: ${detail}`,
  "config.stepAgentsPrRemoved":
    'The config file has pr in step_agents. The "Open PR" step was removed (the PR is now opened inside the Implementation step). Delete pr from step_agents.',
  "config.invalid": ({ path, detail }, text) =>
    `The config file has an error (${path}): ${text(detail)}`,
  "config.authUnsupported": ({ runtime, mode, supported }) =>
    `${runtime} cannot use ${mode} (supported: ${supported}).`,
  "config.subscriptionSecret":
    "A Claude Code subscription needs the secret name of its token (secret).",
  "config.bedrockEndpointCodexOnly":
    "The Bedrock endpoint can only be chosen for Codex. Remove it for Claude Code.",
  "config.platformAuth":
    "For an internal platform, write either secret (a fixed key) or token (getting a token), not both.",
  "config.platformTokenQuery":
    'Write the query for getting a token as "name: value" (the name must not be empty and the value must be a string; e.g. api_token: "{{secret}}").',
  "config.platformTokenUrlSecret":
    'The url for getting a token cannot contain {{secret}}. To send the key as a query parameter, write it in query (e.g. query: { api_token: "{{secret}}" }).',
  "config.platformTokenBody":
    "When the method for getting a token is GET or HEAD, json and form (a body) cannot be written. Send the key in query or headers.",
  "gateway.mcpUnavailable": ({ name, detail }, text) =>
    `The host MCP server "${name}" is not ready (failed to start or authenticate): ${text(detail)}. Sacty restarts it every minute.`,
  "gateway.mcpReadyTimeout": ({ name, seconds }) =>
    `The host MCP server "${name}" is still not ready after waiting ${seconds} seconds (it is starting or authenticating). The agent cannot use it until it is ready.`,
  "gateway.platformUnavailable": ({ name, detail }, text) =>
    `Cannot prepare the credentials for the internal platform "${name}": ${text(detail)} (other platforms still work)`,
  "config.gatewayUnsupported":
    "via_gateway works only when auth.mode of providers.codex is bedrock or openai-compatible.",
  "config.providerLegacyName": ({ name }) =>
    `providers can contain only codex and claude (found "${name}"). Rewrite a named endpoint as the auth of providers.codex (mode: openai-compatible, base_url, secret).`,
  "config.agentLegacyKey": ({ key }) =>
    `Agents cannot contain ${key}. Write authentication and endpoints in auth and via_gateway of providers.codex or providers.claude, and prices per model in providers.<runtime>.available_models.`,
  "config.defaultsUnreadable": ({ path, detail }) =>
    `Cannot read Sacty's agent defaults (${path}): ${detail}. Reinstall Sacty.`,
  "config.agentUnavailable": ({ key, id, reason }, text) =>
    `${key} "${id}" cannot be used: ${text(reason)}`,
  "config.noDefaultAgent":
    "There is no AI to run steps. Write an endpoint and the prices of the default models (available_models) in providers.codex or providers.claude (you can also choose one with default_agent).",
  "config.agentRuntimeRequired":
    "An agent whose name is not in Sacty's defaults needs runtime (claude-code, codex, or stub).",
  "config.agentModelRequired":
    "Write model for the agent (its price is looked up in available_models of providers).",
  "config.agentProviderMissing": ({ id, provider }) =>
    `The agent "${id}" cannot be used because providers.${provider} is not written.`,
  "config.modelPriceMissing": ({ provider, model, agents }) =>
    `${agents} cannot be used because providers.${provider}.available_models has no price for ${model}. Add its price.`,
  "gateway.unavailable":
    "The host gateway is not running, so an agent that goes through it cannot run. Restart Sacty.",
  "config.agentMissing": ({ key, id }) => `${key} "${id}" is not in agents.`,
  "config.agentFallbackSelf": ({ id }) =>
    `The fallback of the agent "${id}" cannot be the agent itself.`,
  "config.agentFallbackUnavailable": ({ id, fallback, reason }, text) =>
    `The fallback "${fallback}" of the agent "${id}" cannot be used, so Sacty does not switch to it at a usage limit: ${text(reason)}`,
  "agent.stepMissing": "That step is not one of this task's steps.",
  "agent.stepNotChangeable":
    "The integration review is run by the goal guardian (guardian_agent in config.yaml), so its step agent cannot be changed.",
  "agent.notInAgents": ({ name }) =>
    `The agent "${name}" is not one of the usable agents. Choose one of the agents shown.`,
  "agent.unchanged": ({ name }) => `The step agent is already "${name}".`,
  "audit.notFound": "This task has no audit.",
  "audit.proposalNotFound": "That proposal does not exist.",
  "audit.alreadyDecided": "That proposal has already been adopted or rejected.",
  "audit.memoryNotFound": "That memory does not exist.",
  "audit.memoryDeleted": "That memory has already been deleted.",
  "audit.targetNotCandidate":
    "That target is not one of this proposal's candidates. Choose one of them.",
  "audit.notPaused": "The audit is not paused by its budget.",
  "audit.runFailed": ({ detail }, text) => `The audit could not run: ${text(detail)}`,
  "audit.unreadable": "The audit agent's output could not be read in the expected form.",
  "audit.interrupted": "The audit stopped partway because the daemon stopped.",
  "audit.notAdoptable": "This task was cancelled, so its proposals cannot be adopted or rejected.",
  "agent.configUnavailable": ({ detail }, text) =>
    `config.yaml cannot be read, so the step agent cannot be changed. Fix the settings and try again: ${text(detail)}`,
  "agent.chosenMissing": ({ step, name }) =>
    `The agent "${name}" chosen for the step (${step}) is not one of the usable agents (removed from the settings, or no endpoint or price). Choose the agent again in the task details, then resume.`,
  "config.tierRuntime": ({ id, runtime, expected }) =>
    `"${id}" in agents is a tier agent, so its runtime must be ${expected} (it is ${runtime}).`,
  "agents.tierConnectionDiffers": ({ tier, id, parent }) =>
    `The tier "${tier}" (${id}) uses a different authentication or endpoint from the step agent (${parent}), so its subagent definition was not placed.`,
  "context.reservedTierFile": ({ from, path }) =>
    `${path} of ${from} was not copied because Sacty writes it as the subagent definition of a tier.`,
};

export const DAEMON_MESSAGES = { ja, en } as const;

/** 文言のコードか。 */
export function isMessageCode(value: unknown): value is MessageCode {
  return typeof value === "string" && Object.hasOwn(ja, value);
}

/**
 * デーモンの文言を、指定した言語の文にする。コードと引数でない値（古い作業履歴の文や、
 * 外から来た文）は、そのまま返す。文字列がコードそのものなら（zod の検査の文言）、その文言にする。
 */
export function renderMessage(value: unknown, locale: keyof typeof DAEMON_MESSAGES): string {
  const dictionary = DAEMON_MESSAGES[locale];
  if (isMessageCode(value)) {
    const entry = dictionary[value];
    return typeof entry === "string" ? entry : String(value);
  }
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    // 知らないコード（版の違いなど）は、コードを出す
    if (!isMessageCode(value.code)) return value.code;
    const entry = dictionary[value.code] as
      | string
      | ((params: unknown, text: (value: DaemonText) => string) => string);
    if (typeof entry === "string") return entry;
    // 引数が無い・一部が欠けている・形が合わないときも、コードを出す（例外にしない）
    const parsed = PARAMS[value.code]?.safeParse((value as { params?: unknown }).params);
    if (!parsed?.success) return value.code;
    try {
      return entry(parsed.data, (nested) => renderMessage(nested, locale));
    } catch {
      return value.code;
    }
  }
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * 入力の検査（zod）の誤りを、文言のコードと引数にする。検査にコードを指定していればそのコード、
 * 指定していない標準の検査は、誤りの種類ごとのコードにする（画面の言語の文言にできるように）。
 */
export function issueMessage(issue: z.core.$ZodIssue): DaemonMessage {
  if (isMessageCode(issue.message)) {
    if (PARAMS[issue.message] === null) return { code: issue.message } as DaemonMessage;
    // 引数のあるコードは、検査が引数を添えたとき（custom の params）だけ使う
    if (issue.code === "custom" && issue.params) {
      return { code: issue.message, params: issue.params } as DaemonMessage;
    }
  }
  switch (issue.code) {
    case "too_small": {
      const minimum = Number(issue.minimum);
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return {
          code: "input.numberTooSmall",
          params: { minimum, inclusive: issue.inclusive ?? true },
        };
      }
      if (minimum <= 1) return { code: "input.required" };
      return issue.origin === "string"
        ? { code: "input.tooShort", params: { minimum } }
        : { code: "input.tooFew", params: { minimum } };
    }
    case "too_big": {
      const maximum = Number(issue.maximum);
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return {
          code: "input.numberTooLarge",
          params: { maximum, inclusive: issue.inclusive ?? true },
        };
      }
      return issue.origin === "string"
        ? { code: "input.tooLong", params: { maximum } }
        : { code: "input.tooMany", params: { maximum } };
    }
    case "invalid_type":
      return { code: "input.invalidType" };
    case "invalid_format":
      return { code: "input.invalidFormat" };
    case "invalid_value":
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
      return { code: "input.invalidValue" };
    case "unrecognized_keys":
      return { code: "input.unknownKeys", params: { keys: issue.keys.join(", ") } };
    default:
      return { code: "input.invalid" };
  }
}

/**
 * 文のうち、外から来た文や自由に書ける引数（文字列の引数と、入れ子の文）だけに fn をかける
 * （秘密情報を取り除くためなど）。コードと、決まった値の引数（列挙・数値など）は変えない。
 * 知らないコードは、引数の文字列すべてにかける（コードはそのまま）。
 */
export function mapFreeText(value: DaemonText, fn: (text: string) => string): DaemonText {
  if (typeof value === "string") return fn(value);
  if (!value.params) return value;
  const schema = isMessageCode(value.code) ? PARAMS[value.code] : undefined;
  const shape = schema ? (schema as z.ZodObject).shape : undefined;
  const mapUnknown = (v: unknown): unknown =>
    typeof v === "string"
      ? fn(v)
      : Array.isArray(v)
        ? v.map(mapUnknown)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapUnknown(x)]))
          : v;
  const params = Object.fromEntries(
    Object.entries(value.params).map(([key, param]) => {
      const field = shape?.[key];
      if (!shape) return [key, mapUnknown(param)];
      // 入れ子の文
      if (field === TextParam && DaemonText.safeParse(param).success) {
        return [key, mapFreeText(param as DaemonText, fn)];
      }
      // 自由に書ける文字列の引数
      if (field instanceof z.ZodString && typeof param === "string") return [key, fn(param)];
      // 決まった値（列挙・数値・真偽）や、形を知らない引数はそのまま
      return [key, param];
    }),
  );
  return { ...value, params };
}
