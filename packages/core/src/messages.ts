import { z } from "zod";
import { formatUsd } from "./cost.js";
import { TICKET_BODY_MAX, TICKET_TITLE_MAX } from "./events.js";
import { PROJECT_EXPORT_VERSION } from "./projects.js";

const Scope = z.enum(["org", "repo"]);
const Count = z.number().int().nonnegative();

/**
 * デーモンが利用者に向けて返す文言のコードと、その引数の形（PBI-11）。デーモンはコードと引数で返し、
 * 画面が画面の言語の文言にする。引数の無いコードは null。引数は表示の前にこの形で確かめ、
 * 合わなければ（版の違いなど）コードを出す。
 * 外から来た文（git や GitHub のエラーなど）は、引数としてそのまま渡し、翻訳しない。
 */
const PARAMS = {
  "task.notFound": null,
  "task.cancelled": null,
  "task.invalidState": null,
  "project.notFound": null,
  "project.sourceDuplicated": z.object({ scope: Scope, target: z.string() }),
  "project.sourceTaken": z.object({ scope: Scope, target: z.string(), project: z.string() }),
  "project.repositoryDuplicated": z.object({ repo: z.string() }),
  "pause.alreadyPaused": null,
  "pause.awaitingPerson": null,
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
  "input.testCommandRequired": null,
  "input.contextRepoRequired": null,
  "input.invalidRef": null,
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
    // 引数が無い・一部が欠けている・形が合わないときも、コードを出す（例外にしない）
    const parsed = PARAMS[value.code]?.safeParse((value as { params?: unknown }).params);
    if (!parsed?.success) return value.code;
    try {
      return entry(parsed.data);
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
  if (isMessageCode(issue.message) && PARAMS[issue.message] === null) {
    return { code: issue.message } as DaemonMessage;
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
