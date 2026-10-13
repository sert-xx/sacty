import { z } from "zod";
import { formatUsd } from "./cost.js";
import { QUESTION_MAX, TASK_BODY_MAX, TASK_TITLE_MAX } from "./events.js";
import { DaemonText } from "./message-code.js";
import { PROJECT_EXPORT_VERSION } from "./projects.js";

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
  "pause.alreadyPaused": null,
  "pause.awaitingPerson": null,
  "pause.waitingTasks": null,
  "pause.guardianJudging": null,
  "cancel.alreadyCancelled": null,
  "cancel.cleaningUp": null,
  "cancel.guardianJudging": null,
  "resume.notPaused": null,
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
  "reproduce.runFailed": z.object({ detail: TextParam }),
  "gate.remarksRequired": null,
  "gate.overLimit": z.object({ limit: Count }),
  "remark.notFound": null,
  // 入力の検査（zod の検査の文言に、このコードを入れる）
  "input.titleRequired": null,
  "input.titleTooLong": null,
  "input.bodyTooLong": null,
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
  "input.tooManyRemarks": null,
  "input.nameRequired": null,
  "input.invalidGithubName": null,
  "input.invalidRepo": null,
  "input.invalidOrg": null,
  "input.invalidHost": null,
  "input.contextRepoRequired": null,
  "input.invalidRef": null,
  "input.invalidLabel": null,
  "input.notExportFile": null,
  "input.unsupportedVersion": null,
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
  "input.providerName": null,
  "input.imageName": null,
  "config.providerMissing": z.object({ id: z.string() }),
  "config.hostAddress": null,
  "config.npmVersion": null,
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
  "image.unknown": z.object({ name: z.string() }),
  // docker compose のサービス（PBI-47）
  "services.unsafe": z.object({ file: z.string(), detail: z.string() }),
  "services.failed": z.object({ file: z.string(), detail: z.string() }),
  "input.channelRequired": null,
  // Slack の通知（PBI-38）
  "notify.failed": z.object({ project: z.string(), detail: TextParam }),
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
  "ticket.triageFailed": z.object({ detail: TextParam }),
  "ticket.triageUnreadable": null,
  "ticket.repoNotCandidate": z.object({ repo: z.string() }),
  "ticket.noCandidates": null,
  "ticket.repoChosenByPerson": null,
  "ticket.notTriageable": null,
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
  "run.authFileUnreadable": z.object({ path: z.string() }),
  "run.containerNotConfirmed": z.object({ name: z.string() }),
  "run.secretNotFound": z.object({ name: z.string() }),
  // 1Password（PBI-34）
  "secret.opMissing": null,
  "secret.opSignedOut": z.object({ ref: z.string() }),
  "secret.opFailed": z.object({ ref: z.string(), detail: z.string() }),
  // 起動時にまとめて取り出す（PBI-48）
  "secret.prefetchFailed": z.object({ where: z.string(), detail: TextParam }),
  "run.repositoryNotConfigured": null,
  "guardian.verdictUnreadable": null,
  "guardian.reworkUnreadable": null,
  "orchestrator.fallback": z.object({ detail: TextParam }),
  "orchestrator.unreadable": null,
  "orchestrator.testCommandUnknown": null,
  "orchestrator.failed": z.object({ detail: TextParam }),
  "orchestrator.baseBranchUnavailable": z.object({ branch: z.string(), detail: TextParam }),
  // タスク分割（PBI-27）
  "split.unreadable": null,
  "split.childCount": z.object({ min: Count, max: Count, count: Count }),
  "split.duplicateKey": z.object({ key: z.string() }),
  "split.unknownDependency": z.object({ key: z.string(), dependsOn: z.string() }),
  "split.cycle": z.object({ keys: z.string() }),
  "split.childCancelled": z.object({ titles: z.string() }),
  // 統合レビュー（PBI-31）
  "integrate.baseUnavailable": z.object({ branch: z.string(), detail: TextParam }),
  "integrate.unreadable": null,
  "review.pullRequestMissing": z.object({ repo: z.string() }),
  // PR のレビューだけを行う取り込み（PBI-44）
  "review.reviewOnly": z.object({ via: z.enum(["requested", "label"]) }),
  "review.notRereviewable": null,
  "github.ghMissing": null,
  "github.accountRequired": z.object({ project: z.string(), host: z.string() }),
  "github.accountUnavailable": z.object({ account: z.string(), host: z.string() }),
  "github.ghFailed": z.object({ detail: z.string() }),
  "review.verdictMissing": null,
  "review.unreadable": null,
  "run.guardianFailed": z.object({ detail: TextParam }),
  "verify.testsUnavailable": z.object({ detail: TextParam }),
  "verify.workspaceMissing": null,
  "verify.diffUnavailable": z.object({ detail: TextParam }),
  "verify.finalReviewFailed": z.object({ detail: TextParam }),
  "verify.tooManyAttempts": z.object({ count: Count }),
  "pr.unavailable": z.object({ detail: TextParam }),
  "pr.workspaceMissing": null,
  "pr.failed": z.object({ detail: TextParam }),
  "cleanup.prRepoUnknown": null,
  "cleanup.noWorkspace": null,
  "cleanup.containerUnconfirmed": null,
  "git.unavailable": z.object({ detail: z.string() }),
  "git.failed": z.object({ command: z.string(), detail: z.string() }),
  "git.exitCode": z.object({ command: z.string(), code: z.number().nullable() }),
  "git.invalidBaseCommit": null,
  "git.baseCommitMissing": z.object({ commit: z.string() }),
  "git.invalidParentCommit": null,
  "git.invalidBranch": null,
  "git.nothingToCommit": null,
  "git.notSactyBranch": null,
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
    ]),
    status: z.number(),
    detail: z.string(),
    hint: z.enum(["none", "token", "permission"]),
  }),
  "intake.searchTimedOut": null,
  "intake.tooManySameTime": null,
  "intake.partial": null,
  "intake.rateLimited": null,
  "intake.skippedRateLimited": null,
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
  "context.lockedOverride": z.object({
    from: z.string(),
    kind: z.enum(["skills", "mcp"]),
    name: z.string(),
    lockedBy: z.string(),
  }),
  "context.lockedRemove": z.object({
    from: z.string(),
    kind: z.enum(["skills", "mcp"]),
    name: z.string(),
    lockedBy: z.string(),
  }),
  "context.reservedSetting": z.object({ from: z.string(), file: z.string(), key: z.string() }),
  // 設定ファイル（config.yaml）
  "config.missing": z.object({ path: z.string() }),
  "config.unreadable": z.object({ detail: z.string() }),
  "config.invalid": z.object({ path: z.string(), detail: TextParam }),
  "config.authUnsupported": z.object({
    runtime: z.string(),
    mode: z.string(),
    supported: z.string(),
  }),
  "config.subscriptionSecret": null,
  "config.bedrockEndpointCodexOnly": null,
  "config.gatewayCodexBedrockOnly": null,
  "config.platformAuth": null,
  "gateway.platformUnavailable": z.object({ name: z.string(), detail: TextParam }),
  "gateway.mcpUnavailable": z.object({ name: z.string(), detail: TextParam }),
  "gateway.unavailable": null,
  "config.agentMissing": z.object({ key: z.string(), id: z.string() }),
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
const contextKindJa = { skills: "スキル", mcp: "MCP サーバー" } as const;
const contextKindEn = { skills: "skill", mcp: "MCP server" } as const;

const ja: MessageDictionary = {
  "task.notFound": "タスクが見つかりません。",
  "task.repositoryMissing": ({ project }) =>
    `プロジェクト「${project}」に対象（Org・リポジトリ）がありません。プロジェクトの設定で対象を追加してから、タスクを作ってください。`,
  "task.repositoryUnknown": ({ project }) =>
    `対象リポジトリを、プロジェクト「${project}」の対象（Org・リポジトリ）の中から選んでください。`,
  "task.cancelled": "中止したタスクです。",
  "task.invalidState": "このタスクの状態では、その操作はできません。画面を更新してください。",
  "project.notFound": "プロジェクトが見つかりません。",
  "project.targetDuplicated": ({ scope, target }) =>
    `${scopeJa[scope]}「${target}」が重複しています。`,
  "project.ticketKeyDuplicated": ({ platform, key }) =>
    `チケットの取り込み先（${platform}）のキー「${key}」が重複しています。`,
  "project.ticketKeyTaken": ({ platform, key, project }) =>
    `チケットの取り込み先（${platform}）のキー「${key}」は、プロジェクト「${project}」が取り込んでいます。`,
  "project.targetTaken": ({ scope, target, project }) =>
    `${scopeJa[scope]}「${target}」は、プロジェクト「${project}」に登録されています。`,
  "pause.alreadyPaused": "すでに一時停止しています。",
  "pause.awaitingPerson": "人間の判断待ちのため、一時停止する必要はありません。",
  "pause.waitingTasks": "ほかのタスクの完了を待っているため、一時停止する必要はありません。",
  "pause.guardianJudging":
    "ゴールガーディアンが変更の申し出を判定しているため、終わるまで一時停止できません。",
  "cancel.alreadyCancelled": "すでに中止しています。",
  "cancel.cleaningUp": "中止の後片付けをしています。",
  "cancel.guardianJudging":
    "ゴールガーディアンが変更の申し出を判定しているため、終わるまで中止できません。",
  "resume.notPaused": "一時停止中のタスクではありません。",
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
  "reproduce.runFailed": ({ detail }, text) =>
    `再現のテストを実行できませんでした（${text(detail)}）。再現できたかは確かめていません。原因を確かめてから再開すると、テストを実行し直します。`,
  "gate.overLimit": ({ limit }) =>
    `差し戻しが上限（${limit}回）に達しています。続ける場合は、上限を超えて差し戻すことを選んでください。`,
  "remark.notFound": "指摘が見つかりません。",
  "input.titleRequired": "タイトルを入力してください。",
  "input.titleTooLong": `タイトルは${TASK_TITLE_MAX}文字以内で入力してください。`,
  "input.bodyTooLong": `内容は${TASK_BODY_MAX.toLocaleString("ja-JP")}文字以内で入力してください。`,
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
  "input.tooManyRemarks": "指摘は一度に50件までにしてください。",
  "input.nameRequired": "名前を入力してください。",
  "input.invalidGithubName": "GitHub の名前として正しくありません。",
  "input.invalidRepo": "リポジトリは URL（例 https://github.com/acme/app）で入力してください。",
  "input.invalidOrg": "Org は URL（例 https://github.com/acme）で入力してください。",
  "input.invalidHost": "ホスト名として正しくありません。",
  "input.contextRepoRequired": "コンテキストリポジトリを入力してください。",
  "input.invalidRef": "ref はブランチ名かタグ名で入力してください。",
  "input.invalidLabel": 'ラベルに " と \\ は使えません。',
  "input.notExportFile": "sacty のプロジェクト定義のファイルではありません。",
  "input.unsupportedVersion": `対応していない版です（対応している版：${PROJECT_EXPORT_VERSION}）。`,
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
    `チケットの取り込み先の接続先「${platform}」が、config.yaml の gateway.platforms にありません。`,
  "ticket.notAllowed": ({ platform, method, path }) =>
    `接続先「${platform}」の allow に「${method} ${path}」がありません。config.yaml の gateway.platforms.${platform}.allow に足してください。`,
  "ticket.requestFailed": ({ platform, status, detail }) =>
    `接続先「${platform}」の API が失敗しました（${status}）：${detail}`,
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
  "input.platformName":
    "組織内 PF の名前は、英小文字・数字・ハイフンで書いてください（先頭は英小文字か数字）。",
  "input.allowRule":
    "使える API は「メソッド パス」で書いてください（例 GET /api/v1/tickets/**。メソッドは GET・POST・PUT・PATCH・DELETE・HEAD）。",
  "input.invalidUrl": "URL（http または https）を書いてください。",
  "input.reasoningEffort":
    "リーズニングエフォートは、英小文字で書いてください（例：low・medium・high・xhigh）。",
  "input.providerName": "接続先の名前は、英数字・_・- で書いてください。",
  "input.imageName":
    "イメージの名前は、英小文字・数字・_・- で書いてください（config.yaml の images の名前か default）。",
  "config.providerMissing": ({ id }) => `providers に "${id}" がありません。`,
  "config.hostAddress":
    "gateway.host_address は、ホスト名か IP アドレス（または host-gateway）で書いてください。",
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
    "images の env には、PATH・HOME や、DOCKER_・SACTY_・CODEX_・CLAUDE_・ANTHROPIC_・OPENAI_・NPM_CONFIG_ で始まる名前は書けません（sacty と docker の設定とぶつかるため）。",
  "config.imagePackage":
    "images の packages には、パッケージの名前（英数字と . _ + : @ ~ = -）を書いてください。",
  "config.imageRun":
    "images の run には、1行のコマンドを書いてください（複数のコマンドは、項目を分けて書く）。",
  "config.mavenMirror":
    "images の maven_mirror は、ユーザー名・パスワードを含まない URL（http または https）で書いてください。",
  "services.unsafe": ({ file, detail }) =>
    `compose ファイル（${file}）に、sacty が起動できない設定があります：${detail}。エージェントにホストの権限を渡さないため、privileged・ホストのネットワーク・作業領域の外のマウントなどは使えません。`,
  "services.failed": ({ file, detail }) =>
    `compose ファイル（${file}）のサービスを起動できませんでした。出力の末尾：${detail}`,
  "image.unknown": ({ name }) =>
    `イメージ「${name}」は config.yaml の images にありません。images に書くか、プロジェクトの対象のイメージの指定を直してから、再開してください。`,
  "input.channelRequired": "チャンネルを書いてください。",
  "notify.failed": ({ project, detail }, text) =>
    `プロジェクト「${project}」の Slack の通知を送れませんでした：${text(detail)}（タスクは止めていません）`,
  "notify.notConfigured": "このプロジェクトには、通知先が設定されていません。",
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
  "run.authFileUnreadable": ({ path }) =>
    `認証ファイル（${path}）を読めません。ログインしているか確認してください。`,
  "run.containerNotConfirmed": ({ name }) =>
    `コンテナ（${name}）の停止を確認できませんでした。docker ps で確認してください。`,
  "run.secretNotFound": ({ name }) =>
    `秘密情報「${name}」が見つかりません。\`sacty secret set ${name}\` で保存してください。`,
  "secret.opMissing":
    "1Password の op コマンドが見つかりません。1Password CLI をインストールし、サインインしてから再開してください。",
  "secret.prefetchFailed": ({ where, detail }, text) =>
    `起動のときに、秘密情報（${where}）を取り出せませんでした：${text(detail)}用意してから、「sacty の設定」の「秘密情報を取り出し直す」を押してください（使うときにも、もう一度取り出します）。`,
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
  "split.childCancelled": ({ titles }) =>
    `子タスク（${titles}）が中止されました。再開すると、中止した子タスクを除いて進めます（中止した子タスクに依存する子タスクも始めます）。中止すると、終わっていない子タスクも中止します。`,
  "integrate.baseUnavailable": ({ branch, detail }, text) =>
    `統合レビューのため、ベースブランチ（${branch}）の最新を取得できませんでした：${text(detail)}。再開すると、統合レビューをやり直します。`,
  "integrate.unreadable": "統合レビューの出力から、判定を読み取れませんでした。",
  "orchestrator.failed": ({ detail }, text) =>
    `オーケストレーターを実行できませんでした：${text(detail).replace(/[。.]\s*$/, "")}。再開すると、工程の選択からやり直します。`,
  "orchestrator.testCommandUnknown":
    "オーケストレーターが、対象リポジトリのテストのコマンドを決められませんでした。実装を検証できないので止めます。タスクの内容にテストの実行方法を書いて、作り直してください。",
  "orchestrator.baseBranchUnavailable": ({ branch, detail }, text) =>
    `オーケストレーターが選んだベースブランチ（${branch}）を用意できなかったため、既定のブランチで進めます（${text(detail)}）。`,
  "review.pullRequestMissing": ({ repo }) =>
    `タスクに、レビューする PR（${repo} の PR の URL）がありません。`,
  "review.reviewOnly": ({ via }) =>
    `${via === "requested" ? "自分にレビューが依頼された" : "レビュー用のラベルの付いた"} PR なので、レビューだけを行います（オーケストレーターは使いません）。`,
  "review.notRereviewable":
    "再レビューできるのは、レビューを PR に投稿して完了したタスクだけです。",
  "github.ghMissing":
    "gh コマンドが見つかりません。GitHub CLI をインストールし、gh auth login でログインしてください。",
  "github.accountRequired": ({ project, host }) =>
    `プロジェクト「${project}」の ${host} の GitHub アカウントが選ばれていません。プロジェクトの設定で選んでから再開してください。`,
  "github.accountUnavailable": ({ account, host }) =>
    `${host} のアカウント「${account}」で gh にログインしていません。gh auth login --hostname ${host} でログインするか、プロジェクトの設定でアカウントを選び直してください。`,
  "github.ghFailed": ({ detail }) => `gh コマンドが失敗しました：${detail}`,
  "review.verdictMissing": "判定がありません。",
  "review.unreadable": "最終レビューの出力から、判定を読み取れませんでした。",
  "run.guardianFailed": ({ detail }, text) =>
    `ゴールガーディアンの実行に失敗しました：${text(detail)}`,
  "verify.testsUnavailable": ({ detail }, text) => `テストを実行できません：${text(detail)}`,
  "verify.workspaceMissing": "実装の作業領域が見つからないため、検証できません。",
  "verify.diffUnavailable": ({ detail }, text) =>
    `差分を取得できないため、最終レビューをしていません：${text(detail)}`,
  "verify.finalReviewFailed": ({ detail }, text) =>
    `ゴールガーディアンの最終レビューを実行できませんでした：${text(detail)}`,
  "verify.tooManyAttempts": ({ count }) =>
    `実装の検証（テストと最終レビュー）に、${count}回続けて通りませんでした。`,
  "pr.unavailable": ({ detail }, text) => `PRを作れません：${text(detail)}`,
  "pr.workspaceMissing": "実装の作業領域が無いため、PRを作れません。",
  "pr.failed": ({ detail }, text) => `PRを作れませんでした：${text(detail)}`,
  "cleanup.prRepoUnknown": "PRを作ったリポジトリの記録が無いため、閉じませんでした。",
  "cleanup.noWorkspace": "作業領域が無いため、ブランチを消せません。",
  "cleanup.containerUnconfirmed":
    "コンテナが止まったことを確かめられないため、作業領域は消していません。",
  "git.unavailable": ({ detail }) => `gitを実行できません（${detail}）。`,
  "git.failed": ({ command, detail }) => `git ${command} に失敗しました：${detail}`,
  "git.exitCode": ({ command, code }) => `git ${command} に失敗しました：終了コード ${code}`,
  "git.invalidBaseCommit": "起点のコミットが不正です。",
  "git.baseCommitMissing": ({ commit }) =>
    `作業領域を用意し直そうとしましたが、タスクの起点のコミット（${commit.slice(0, 7)}）を取得できません。起点を変えずに止めました。`,
  "git.invalidParentCommit": "積む先のコミットが不正です。",
  "git.invalidBranch": "ブランチ名が不正です。",
  "git.nothingToCommit": "起点から変更がないため、コミットできません。",
  "git.notSactyBranch": "sacty のブランチではありません。",
  "github.failed": ({ action, status, detail, hint }) =>
    `${githubActionJa[action]}：GitHub API ${status} ${detail}${githubHintJa[hint]}`,
  "intake.searchTimedOut":
    "GitHub の検索が時間内に終わらず、結果の一部しか得られませんでした（次の取り込みで、この範囲を検索し直します）。",
  "intake.tooManySameTime":
    "同じ日時に更新された Issue が多すぎるため、すべてを検索できませんでした。",
  "intake.partial":
    "Issue が多すぎるため、この取り込みでは途中までしか検索していません（次の取り込みで続きを検索します）。",
  "intake.rateLimited":
    "GitHub の検索のレート制限に達しました。次の取り込みで、続きから検索します。",
  "intake.skippedRateLimited": "レート制限のため、次の取り込みで検索します。",
  "context.cycle": ({ key }) => `コンテキストの継承が循環しています（${key}）。`,
  "context.tooDeep": ({ max }) => `コンテキストの継承が深すぎます（上限 ${max} 段）。`,
  "context.fetchFailed": ({ key, detail }, text) =>
    `コンテキストリポジトリ（${key}）を取得できません：${text(detail)}`,
  "context.fileUnreadable": ({ key, file, detail }) => `${key} の ${file} を読めません：${detail}`,
  "context.fileInvalid": ({ key, file, path, detail }, text) =>
    `${key} の ${file} に誤りがあります（${path}）：${text(detail)}`,
  "context.notPlainFile": ({ key, path, symlink }) =>
    `${key} の ${path} は${symlink ? "シンボリックリンク" : "通常のファイルでないもの"}です。コンテキストリポジトリでは、設定・規約・スキルに通常のファイルとディレクトリだけを使えます。`,
  "context.lockedOverride": ({ from, kind, name, lockedBy }) =>
    `${from} は${contextKindJa[kind]}「${name}」を上書きしようとしましたが、${lockedBy} で上書き禁止のため上位のものを使いました。`,
  "context.lockedRemove": ({ from, kind, name, lockedBy }) =>
    `${from} は${contextKindJa[kind]}「${name}」を取り除こうとしましたが、${lockedBy} で上書き禁止のため残しました。`,
  "context.reservedSetting": ({ from, file, key }) =>
    `${from} の ${file} の「${key}」は sacty が決める項目のため、使いませんでした。`,
  "config.missing": ({ path }) =>
    `設定ファイルがありません（${path}）。\`sacty config init\` で作成してください。`,
  "config.unreadable": ({ detail }) => `設定ファイルのYAMLを読めません：${detail}`,
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
  "gateway.mcpUnavailable": ({ name, detail }, text) =>
    `ホストの MCP サーバー「${name}」の準備ができません（起動・認証に失敗）：${text(detail)}。1分ごとに起動し直します。`,
  "gateway.platformUnavailable": ({ name, detail }, text) =>
    `組織内 PF「${name}」の認証情報を用意できません：${text(detail)}（ほかの PF は使えます）`,
  "config.gatewayCodexBedrockOnly":
    "ゲートウェイ経由（via_gateway）は、いまは Codex × Bedrock（auth.mode: bedrock）だけで使えます。",
  "gateway.unavailable":
    "ホストのゲートウェイが起動していないため、ゲートウェイ経由のエージェントを実行できません。sacty を起動し直してください。",
  "config.agentMissing": ({ key, id }) => `${key} の "${id}" が agents にありません。`,
};

/** 英語。用語は画面の用語集（apps/web の labels.ts）に合わせる。 */
const en: MessageDictionary = {
  "task.notFound": "Task not found.",
  "task.repositoryMissing": ({ project }) =>
    `The project "${project}" has no targets (organizations or repositories). Add one in the project settings, then create the task.`,
  "task.repositoryUnknown": ({ project }) =>
    `Choose the target repository from the targets (organizations or repositories) of the project "${project}".`,
  "task.cancelled": "This task has been cancelled.",
  "task.invalidState": "This action is not available in the task's current state. Reload the page.",
  "project.notFound": "Project not found.",
  "project.targetDuplicated": ({ scope, target }) =>
    `The ${scopeEn[scope]} "${target}" is listed more than once.`,
  "project.ticketKeyDuplicated": ({ platform, key }) =>
    `The key "${key}" of the ticket source (${platform}) is duplicated.`,
  "project.ticketKeyTaken": ({ platform, key, project }) =>
    `The key "${key}" of the ticket source (${platform}) is already imported by the project "${project}".`,
  "project.targetTaken": ({ scope, target, project }) =>
    `The ${scopeEn[scope]} "${target}" is already registered in the project "${project}".`,
  "pause.alreadyPaused": "The task is already paused.",
  "pause.awaitingPerson": "The task is waiting for your decision, so there is no need to pause it.",
  "pause.waitingTasks":
    "The task is waiting for other tasks to finish, so there is no need to pause it.",
  "pause.guardianJudging":
    "The Goal Guardian is judging a change request. You can pause once it finishes.",
  "cancel.alreadyCancelled": "The task is already cancelled.",
  "cancel.cleaningUp": "Cleaning up after cancellation.",
  "cancel.guardianJudging":
    "The Goal Guardian is judging a change request. You can cancel once it finishes.",
  "resume.notPaused": "The task is not paused.",
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
  "reproduce.runFailed": ({ detail }, text) =>
    `Could not run the reproduction test (${text(detail)}), so the reproduction is not confirmed. Check the cause, then resume to run the test again.`,
  "gate.overLimit": ({ limit }) =>
    `Change requests reached the limit (${limit}). To continue, choose to request changes over the limit.`,
  "remark.notFound": "Comment not found.",
  "input.titleRequired": "Enter a title.",
  "input.titleTooLong": `Keep the title within ${TASK_TITLE_MAX} characters.`,
  "input.bodyTooLong": `Keep the details within ${TASK_BODY_MAX.toLocaleString("en-US")} characters.`,
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
  "input.tooManyRemarks": "Enter up to 50 comments at a time.",
  "input.nameRequired": "Enter a name.",
  "input.invalidGithubName": "This is not a valid GitHub name.",
  "input.invalidRepo": "Enter the repository as a URL (e.g. https://github.com/acme/app).",
  "input.invalidOrg": "Enter the org as a URL (e.g. https://github.com/acme).",
  "input.invalidHost": "This is not a valid host name.",
  "input.contextRepoRequired": "Enter the context repository.",
  "input.invalidRef": "Enter a branch or tag name as the ref.",
  "input.invalidLabel": "A label can't contain \" or \\.",
  "input.notExportFile": "This is not a sacty project definition file.",
  "input.unsupportedVersion": `Unsupported version (supported: ${PROJECT_EXPORT_VERSION}).`,
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
    `The ticket source "${platform}" is not in gateway.platforms in config.yaml.`,
  "ticket.notAllowed": ({ platform, method, path }) =>
    `"${method} ${path}" is not in the allow list of "${platform}". Add it to gateway.platforms.${platform}.allow in config.yaml.`,
  "ticket.requestFailed": ({ platform, status, detail }) =>
    `The API of "${platform}" failed (${status}): ${detail}`,
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
  "input.platformName":
    "Write an internal platform name in lowercase letters, digits, and hyphens (starting with a letter or digit).",
  "input.allowRule":
    'Write an allowed API as "METHOD path" (e.g. GET /api/v1/tickets/**; methods: GET, POST, PUT, PATCH, DELETE, HEAD).',
  "input.invalidUrl": "Write a URL (http or https).",
  "input.reasoningEffort":
    "Write the reasoning effort in lowercase letters (e.g. low, medium, high, xhigh).",
  "input.providerName": "Use only letters, digits, _ and - in provider names.",
  "input.imageName":
    "Use only lowercase letters, digits, _ and - in image names (a name in images in config.yaml, or default).",
  "config.providerMissing": ({ id }) => `"${id}" is not in providers.`,
  "config.hostAddress":
    "Write gateway.host_address as a host name or IP address (or host-gateway).",
  "config.npmVersion": "Write image_build.npm_version as a version (e.g. 11, 11.6.2) or latest.",
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
    "images env can't use PATH, HOME, or names starting with DOCKER_, SACTY_, CODEX_, CLAUDE_, ANTHROPIC_, OPENAI_ or NPM_CONFIG_ (they would clash with sacty and docker settings).",
  "config.imagePackage":
    "Write package names in images packages (letters, digits and . _ + : @ ~ = -).",
  "config.imageRun":
    "Write one command per line in images run (use separate items for several commands).",
  "config.mavenMirror":
    "Write images maven_mirror as a URL (http or https) without a user name or password.",
  "services.unsafe": ({ file, detail }) =>
    `The compose file (${file}) has settings sacty can't start: ${detail}. To keep host privileges away from agents, privileged, host networking, mounts outside the workspace and so on are not allowed.`,
  "services.failed": ({ file, detail }) =>
    `Could not start the services in the compose file (${file}). End of the output: ${detail}`,
  "image.unknown": ({ name }) =>
    `The image "${name}" is not in images in config.yaml. Add it to images, or fix the image of the project target, then resume.`,
  "input.channelRequired": "Write a channel.",
  "notify.failed": ({ project, detail }, text) =>
    `Could not send the Slack notification for the project "${project}": ${text(detail)} (tasks keep running)`,
  "notify.notConfigured": "No notification destination is set for this project.",
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
    `Stopped the agent because it ran longer than ${minutes} minutes.`,
  "run.testTimeout": ({ minutes }) =>
    `Stopped the tests because they ran longer than ${minutes} minutes.`,
  "run.dockerUnavailable": ({ detail }, text) =>
    `Cannot run docker. Check that Docker is running (${text(detail)}).`,
  "run.dockerFailed":
    "Docker could not run the container (docker run exit code 125). Check that Docker is running and reachable, and check the image.",
  "run.imageMissing": ({ image }) =>
    `The agent image (${image}) is missing. Build it with \`sacty image build\`.`,
  "run.authFileUnreadable": ({ path }) =>
    `Cannot read the auth file (${path}). Check that you are signed in.`,
  "run.containerNotConfirmed": ({ name }) =>
    `Could not confirm that the container (${name}) stopped. Check with docker ps.`,
  "run.secretNotFound": ({ name }) =>
    `Secret "${name}" not found. Save it with \`sacty secret set ${name}\`.`,
  "secret.opMissing":
    "The 1Password op command was not found. Install 1Password CLI, sign in, and resume.",
  "secret.prefetchFailed": ({ where, detail }, text) =>
    `Could not get the secret (${where}) at startup: ${text(detail)} Set it up, then press "Get secrets again" in sacty settings (sacty also tries again when it is used).`,
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
  "split.childCancelled": ({ titles }) =>
    `Subtasks were cancelled (${titles}). Resume to continue without them (subtasks that depend on them also start). Cancel to also cancel the unfinished subtasks.`,
  "integrate.baseUnavailable": ({ branch, detail }, text) =>
    `Could not fetch the latest base branch (${branch}) for the integration review: ${text(detail)}. Resume to run the integration review again.`,
  "integrate.unreadable": "Could not read the verdicts from the integration review output.",
  "orchestrator.failed": ({ detail }, text) =>
    `Could not run the Orchestrator: ${text(detail).replace(/[。.]\s*$/, "")}. Resume to choose the steps again.`,
  "orchestrator.testCommandUnknown":
    "The Orchestrator could not determine the test command of the target repository, so the implementation cannot be verified. Describe how to run the tests in the task and create it again.",
  "orchestrator.baseBranchUnavailable": ({ branch, detail }, text) =>
    `Could not prepare the base branch the Orchestrator chose (${branch}), so the default branch is used (${text(detail)}).`,
  "review.pullRequestMissing": ({ repo }) =>
    `The task has no PR to review (a URL of a PR in ${repo}).`,
  "review.reviewOnly": ({ via }) =>
    `The PR ${via === "requested" ? "requests your review" : "has the review label"}, so sacty only reviews it (the Orchestrator is not used).`,
  "review.notRereviewable": "Only a task that posted its review to the PR can be reviewed again.",
  "github.ghMissing":
    "The gh command was not found. Install GitHub CLI and sign in with gh auth login.",
  "github.accountRequired": ({ project, host }) =>
    `No GitHub account for ${host} is chosen for the project "${project}". Choose one in the project settings, then resume.`,
  "github.accountUnavailable": ({ account, host }) =>
    `The account "${account}" on ${host} is not signed in to gh. Sign in with gh auth login --hostname ${host}, or choose another account in the project settings.`,
  "github.ghFailed": ({ detail }) => `The gh command failed: ${detail}`,
  "review.verdictMissing": "No verdict was given.",
  "review.unreadable": "Could not read the verdicts from the final review output.",
  "run.guardianFailed": ({ detail }, text) => `The Goal Guardian run failed: ${text(detail)}`,
  "verify.testsUnavailable": ({ detail }, text) => `Cannot run the tests: ${text(detail)}`,
  "verify.workspaceMissing":
    "The implementation workspace was not found, so it cannot be verified.",
  "verify.diffUnavailable": ({ detail }, text) =>
    `Could not get the diff, so the final review was not done: ${text(detail)}`,
  "verify.finalReviewFailed": ({ detail }, text) =>
    `Could not run the Goal Guardian's final review: ${text(detail)}`,
  "verify.tooManyAttempts": ({ count }) =>
    `Verification of the implementation (tests and final review) failed ${count} times in a row.`,
  "pr.unavailable": ({ detail }, text) => `Cannot open a PR: ${text(detail)}`,
  "pr.workspaceMissing": "There is no implementation workspace, so a PR cannot be opened.",
  "pr.failed": ({ detail }, text) => `Could not open the PR: ${text(detail)}`,
  "cleanup.prRepoUnknown": "Not closed because the PR's repository was not recorded.",
  "cleanup.noWorkspace": "Cannot delete the branch because there is no workspace.",
  "cleanup.containerUnconfirmed":
    "The workspace was kept because the container could not be confirmed as stopped.",
  "git.unavailable": ({ detail }) => `Cannot run git (${detail}).`,
  "git.failed": ({ command, detail }) => `git ${command} failed: ${detail}`,
  "git.exitCode": ({ command, code }) => `git ${command} failed: exit code ${code}`,
  "git.invalidBaseCommit": "The base commit is not valid.",
  "git.baseCommitMissing": ({ commit }) =>
    `Tried to prepare the workspace again, but the task's base commit (${commit.slice(0, 7)}) could not be fetched. Stopped without changing the base.`,
  "git.invalidParentCommit": "The parent commit is not valid.",
  "git.invalidBranch": "The branch name is not valid.",
  "git.nothingToCommit": "Nothing changed since the base, so there is nothing to commit.",
  "git.notSactyBranch": "This is not a sacty branch.",
  "github.failed": ({ action, status, detail, hint }) =>
    `${githubActionEn[action]}: GitHub API ${status} ${detail}${githubHintEn[hint]}`,
  "intake.searchTimedOut":
    "The GitHub search did not finish in time and returned partial results (this range will be searched again next time).",
  "intake.tooManySameTime":
    "Too many issues were updated at the same time, so not all of them could be searched.",
  "intake.partial":
    "There are too many issues, so this intake searched only part of them (the rest will be searched next time).",
  "intake.rateLimited":
    "Reached the GitHub search rate limit. The search will continue from here next time.",
  "intake.skippedRateLimited": "Skipped because of the rate limit; it will be searched next time.",
  "context.cycle": ({ key }) => `The context inheritance has a cycle (${key}).`,
  "context.tooDeep": ({ max }) => `The context inheritance is too deep (limit ${max} levels).`,
  "context.fetchFailed": ({ key, detail }, text) =>
    `Cannot fetch the context repository (${key}): ${text(detail)}`,
  "context.fileUnreadable": ({ key, file, detail }) => `Cannot read ${file} in ${key}: ${detail}`,
  "context.fileInvalid": ({ key, file, path, detail }, text) =>
    `${file} in ${key} has an error (${path}): ${text(detail)}`,
  "context.notPlainFile": ({ key, path, symlink }) =>
    `${path} in ${key} is ${symlink ? "a symbolic link" : "not a regular file"}. Context repositories can use only regular files and directories for settings, rules, and skills.`,
  "context.lockedOverride": ({ from, kind, name, lockedBy }) =>
    `${from} tried to override the ${contextKindEn[kind]} "${name}", but ${lockedBy} locks it, so the upper one was used.`,
  "context.lockedRemove": ({ from, kind, name, lockedBy }) =>
    `${from} tried to remove the ${contextKindEn[kind]} "${name}", but ${lockedBy} locks it, so it was kept.`,
  "context.reservedSetting": ({ from, file, key }) =>
    `"${key}" in ${file} of ${from} is set by sacty, so it was not used.`,
  "config.missing": ({ path }) =>
    `The config file is missing (${path}). Create it with \`sacty config init\`.`,
  "config.unreadable": ({ detail }) => `Cannot read the config file as YAML: ${detail}`,
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
  "gateway.mcpUnavailable": ({ name, detail }, text) =>
    `The host MCP server "${name}" is not ready (failed to start or authenticate): ${text(detail)}. sacty restarts it every minute.`,
  "gateway.platformUnavailable": ({ name, detail }, text) =>
    `Cannot prepare the credentials for the internal platform "${name}": ${text(detail)} (other platforms still work)`,
  "config.gatewayCodexBedrockOnly":
    "via_gateway currently works only for Codex with Bedrock (auth.mode: bedrock).",
  "gateway.unavailable":
    "The host gateway is not running, so an agent that goes through it cannot run. Restart sacty.",
  "config.agentMissing": ({ key, id }) => `${key} "${id}" is not in agents.`,
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
