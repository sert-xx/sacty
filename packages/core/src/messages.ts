import { formatUsd } from "./cost.js";
import { TICKET_BODY_MAX, TICKET_TITLE_MAX } from "./events.js";
import { PROJECT_EXPORT_VERSION } from "./projects.js";

/**
 * デーモンが利用者に向けて返す文言のコードと引数（PBI-11）。デーモンはコードと引数で返し、
 * 画面が画面の言語の文言にする。引数の無いコードは undefined。
 * 外から来た文（git や GitHub のエラーなど）は、引数としてそのまま渡し、翻訳しない。
 */
export type MessageParams = {
  "task.notFound": undefined;
  "task.cancelled": undefined;
  "task.invalidState": undefined;
  "project.notFound": undefined;
  "project.sourceDuplicated": { scope: "org" | "repo"; target: string };
  "project.sourceTaken": { scope: "org" | "repo"; target: string; project: string };
  "project.repositoryDuplicated": { repo: string };
  "pause.alreadyPaused": undefined;
  "pause.awaitingPerson": undefined;
  "pause.guardianJudging": undefined;
  "cancel.alreadyCancelled": undefined;
  "cancel.cleaningUp": undefined;
  "cancel.guardianJudging": undefined;
  "resume.notPaused": undefined;
  "resume.capRequired": undefined;
  "resume.capTooLow": { usedUsd: number };
  "containers.notStopped": { names: string };
  "change.notAwaiting": undefined;
  "gate.notAwaiting": undefined;
  "gate.stepNotAwaiting": undefined;
  "gate.staleSubmission": { submission: number; current: number };
  "gate.invalidTarget": undefined;
  "gate.remarksRequired": undefined;
  "gate.overLimit": { limit: number };
  "remark.notFound": undefined;
  // 入力の検査（zod の検査の文言に、このコードを入れる）
  "input.titleRequired": undefined;
  "input.titleTooLong": undefined;
  "input.bodyTooLong": undefined;
  "input.remarkTooLong": undefined;
  "input.tooManyRemarks": undefined;
  "input.nameRequired": undefined;
  "input.invalidGithubName": undefined;
  "input.invalidRepo": undefined;
  "input.testCommandRequired": undefined;
  "input.contextRepoRequired": undefined;
  "input.invalidRef": undefined;
  "input.notExportFile": undefined;
  "input.unsupportedVersion": undefined;
};

export type MessageCode = keyof MessageParams;

/** コードと引数の文言。 */
export type DaemonMessage = {
  [K in MessageCode]: MessageParams[K] extends undefined
    ? { code: K }
    : { code: K; params: MessageParams[K] };
}[MessageCode];

/** 言語ごとの文言。引数のあるコードは関数。 */
export type MessageDictionary = {
  [K in MessageCode]: MessageParams[K] extends undefined
    ? string
    : (params: MessageParams[K]) => string;
};

const scopeJa = { org: "Org", repo: "リポジトリ" } as const;
const scopeEn = { org: "Org", repo: "repository" } as const;

const ja: MessageDictionary = {
  "task.notFound": "タスクが見つかりません。",
  "task.cancelled": "中止したタスクです。",
  "task.invalidState": "このタスクの状態では、その操作はできません。画面を更新してください。",
  "project.notFound": "プロジェクトが見つかりません。",
  "project.sourceDuplicated": ({ scope, target }) =>
    `${scopeJa[scope]}「${target}」が重複しています。`,
  "project.sourceTaken": ({ scope, target, project }) =>
    `${scopeJa[scope]}「${target}」は、プロジェクト「${project}」に登録されています。`,
  "project.repositoryDuplicated": ({ repo }) => `リポジトリの設定「${repo}」が重複しています。`,
  "pause.alreadyPaused": "すでに一時停止しています。",
  "pause.awaitingPerson": "人間の判断待ちのため、一時停止する必要はありません。",
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
  "gate.remarksRequired": "差し戻すには、指摘を1件以上入力してください。",
  "gate.overLimit": ({ limit }) =>
    `差し戻しが上限（${limit}回）に達しています。続ける場合は、上限を超えて差し戻すことを選んでください。`,
  "remark.notFound": "指摘が見つかりません。",
  "input.titleRequired": "タイトルを入力してください。",
  "input.titleTooLong": `タイトルは${TICKET_TITLE_MAX}文字以内で入力してください。`,
  "input.bodyTooLong": `内容は${TICKET_BODY_MAX.toLocaleString("ja-JP")}文字以内で入力してください。`,
  "input.remarkTooLong": "指摘は1件あたり2,000文字以内にしてください。",
  "input.tooManyRemarks": "指摘は一度に50件までにしてください。",
  "input.nameRequired": "名前を入力してください。",
  "input.invalidGithubName": "GitHub の名前として正しくありません。",
  "input.invalidRepo": "リポジトリは owner/name の形で入力してください。",
  "input.testCommandRequired": "テストのコマンドを入力してください。",
  "input.contextRepoRequired": "コンテキストリポジトリを入力してください。",
  "input.invalidRef": "ref はブランチ名かタグ名で入力してください。",
  "input.notExportFile": "sacty のプロジェクト定義のファイルではありません。",
  "input.unsupportedVersion": `対応していない版です（対応している版：${PROJECT_EXPORT_VERSION}）。`,
};

/** 英語。用語は画面の用語集（apps/web の labels.ts）に合わせる。 */
const en: MessageDictionary = {
  "task.notFound": "Task not found.",
  "task.cancelled": "This task has been cancelled.",
  "task.invalidState": "This action is not available in the task's current state. Reload the page.",
  "project.notFound": "Project not found.",
  "project.sourceDuplicated": ({ scope, target }) =>
    `The ${scopeEn[scope]} "${target}" is listed more than once.`,
  "project.sourceTaken": ({ scope, target, project }) =>
    `The ${scopeEn[scope]} "${target}" is already registered in the project "${project}".`,
  "project.repositoryDuplicated": ({ repo }) =>
    `Repository settings for "${repo}" are listed more than once.`,
  "pause.alreadyPaused": "The task is already paused.",
  "pause.awaitingPerson": "The task is waiting for your decision, so there is no need to pause it.",
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
  "gate.remarksRequired": "Enter at least one comment to request changes.",
  "gate.overLimit": ({ limit }) =>
    `Change requests reached the limit (${limit}). To continue, choose to request changes over the limit.`,
  "remark.notFound": "Comment not found.",
  "input.titleRequired": "Enter a title.",
  "input.titleTooLong": `Keep the title within ${TICKET_TITLE_MAX} characters.`,
  "input.bodyTooLong": `Keep the details within ${TICKET_BODY_MAX.toLocaleString("en-US")} characters.`,
  "input.remarkTooLong": "Keep each comment within 2,000 characters.",
  "input.tooManyRemarks": "Enter up to 50 comments at a time.",
  "input.nameRequired": "Enter a name.",
  "input.invalidGithubName": "This is not a valid GitHub name.",
  "input.invalidRepo": "Enter the repository as owner/name.",
  "input.testCommandRequired": "Enter the test command.",
  "input.contextRepoRequired": "Enter the context repository.",
  "input.invalidRef": "Enter a branch or tag name as the ref.",
  "input.notExportFile": "This is not a sacty project definition file.",
  "input.unsupportedVersion": `Unsupported version (supported: ${PROJECT_EXPORT_VERSION}).`,
};

export const DAEMON_MESSAGES = { ja, en } as const;

/** 文言のコードか。 */
export function isMessageCode(value: unknown): value is MessageCode {
  return typeof value === "string" && Object.hasOwn(ja, value);
}

/**
 * デーモンの文言を、指定した言語の文にする。コードと引数でない値（古い台帳の文や、
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
    const entry = dictionary[value.code] as string | ((params: unknown) => string);
    if (typeof entry === "string") return entry;
    const params = (value as { params?: unknown }).params;
    // 引数が無い・形が合わないときも、コードを出す（例外にしない）
    if (!params || typeof params !== "object") return value.code;
    try {
      return entry(params);
    } catch {
      return value.code;
    }
  }
  return typeof value === "string" ? value : String(value ?? "");
}
