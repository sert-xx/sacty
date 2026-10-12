import { z } from "zod";
import { formatUsd } from "./cost.js";
import { TASK_BODY_MAX, TASK_TITLE_MAX } from "./events.js";
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
  "input.tooManyRemarks": null,
  "input.nameRequired": null,
  "input.invalidGithubName": null,
  "input.invalidRepo": null,
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
  "run.imageMissing": z.object({ image: z.string() }),
  "run.authFileUnreadable": z.object({ path: z.string() }),
  "run.containerNotConfirmed": z.object({ name: z.string() }),
  "run.secretNotFound": z.object({ name: z.string() }),
  "run.repositoryNotConfigured": null,
  "guardian.verdictUnreadable": null,
  "guardian.reworkUnreadable": null,
  "orchestrator.fallback": z.object({ detail: TextParam }),
  "orchestrator.unreadable": null,
  "orchestrator.testCommandUnknown": null,
  "orchestrator.baseBranchUnavailable": z.object({ branch: z.string(), detail: TextParam }),
  // タスク分割（PBI-27）
  "split.unreadable": null,
  "split.childCount": z.object({ min: Count, max: Count, count: Count }),
  "split.duplicateKey": z.object({ key: z.string() }),
  "split.unknownDependency": z.object({ key: z.string(), dependsOn: z.string() }),
  "split.cycle": z.object({ keys: z.string() }),
  "split.childCancelled": z.object({ titles: z.string() }),
  "review.pullRequestMissing": z.object({ repo: z.string() }),
  "github.ghMissing": null,
  "github.accountRequired": z.object({ project: z.string() }),
  "github.accountUnavailable": z.object({ account: z.string() }),
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
  "input.tooManyRemarks": "指摘は一度に50件までにしてください。",
  "input.nameRequired": "名前を入力してください。",
  "input.invalidGithubName": "GitHub の名前として正しくありません。",
  "input.invalidRepo": "リポジトリは owner/name の形で入力してください。",
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
  "run.imageMissing": ({ image }) =>
    `エージェント用のイメージ（${image}）がありません。\`sacty image build\` で作成してください。`,
  "run.authFileUnreadable": ({ path }) =>
    `認証ファイル（${path}）を読めません。ログインしているか確認してください。`,
  "run.containerNotConfirmed": ({ name }) =>
    `コンテナ（${name}）の停止を確認できませんでした。docker ps で確認してください。`,
  "run.secretNotFound": ({ name }) =>
    `秘密情報「${name}」が見つかりません。\`sacty secret set ${name}\` で保存してください。`,
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
  "orchestrator.testCommandUnknown":
    "オーケストレーターが、対象リポジトリのテストのコマンドを決められませんでした。実装を検証できないので止めます。タスクの内容にテストの実行方法を書いて、作り直してください。",
  "orchestrator.baseBranchUnavailable": ({ branch, detail }, text) =>
    `オーケストレーターが選んだベースブランチ（${branch}）を用意できなかったため、既定のブランチで進めます（${text(detail)}）。`,
  "review.pullRequestMissing": ({ repo }) =>
    `タスクに、レビューする PR（${repo} の PR の URL）がありません。`,
  "github.ghMissing":
    "gh コマンドが見つかりません。GitHub CLI をインストールし、gh auth login でログインしてください。",
  "github.accountRequired": ({ project }) =>
    `プロジェクト「${project}」の GitHub アカウントが選ばれていません。プロジェクトの設定で選んでから再開してください。`,
  "github.accountUnavailable": ({ account }) =>
    `GitHub のアカウント「${account}」で gh にログインしていません。gh auth login でログインするか、プロジェクトの設定でアカウントを選び直してください。`,
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
  "input.tooManyRemarks": "Enter up to 50 comments at a time.",
  "input.nameRequired": "Enter a name.",
  "input.invalidGithubName": "This is not a valid GitHub name.",
  "input.invalidRepo": "Enter the repository as owner/name.",
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
  "run.imageMissing": ({ image }) =>
    `The agent image (${image}) is missing. Build it with \`sacty image build\`.`,
  "run.authFileUnreadable": ({ path }) =>
    `Cannot read the auth file (${path}). Check that you are signed in.`,
  "run.containerNotConfirmed": ({ name }) =>
    `Could not confirm that the container (${name}) stopped. Check with docker ps.`,
  "run.secretNotFound": ({ name }) =>
    `Secret "${name}" not found. Save it with \`sacty secret set ${name}\`.`,
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
  "orchestrator.testCommandUnknown":
    "The Orchestrator could not determine the test command of the target repository, so the implementation cannot be verified. Describe how to run the tests in the task and create it again.",
  "orchestrator.baseBranchUnavailable": ({ branch, detail }, text) =>
    `Could not prepare the base branch the Orchestrator chose (${branch}), so the default branch is used (${text(detail)}).`,
  "review.pullRequestMissing": ({ repo }) =>
    `The task has no PR to review (a URL of a PR in ${repo}).`,
  "github.ghMissing":
    "The gh command was not found. Install GitHub CLI and sign in with gh auth login.",
  "github.accountRequired": ({ project }) =>
    `No GitHub account is chosen for the project "${project}". Choose one in the project settings, then resume.`,
  "github.accountUnavailable": ({ account }) =>
    `The GitHub account "${account}" is not signed in to gh. Sign in with gh auth login, or choose another account in the project settings.`,
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
