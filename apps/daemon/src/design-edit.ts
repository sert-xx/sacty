import type { DesignEditItem, DesignEditRejected, Task, TestViewpoint } from "@sacty/core";
import { redact } from "./agents/redact.js";
import { DESIGN_EDIT_FIELDS, withoutInternalPaths } from "./prompts.js";

/*
 * 実装の工程が出す、承認済みの設計の局所の直し（sacty-design-edit。PBI-446）の検査と適用。
 * 直しは置き換え（before を after にする）の形で、実装の PR の指摘が求めた局所の変更に限る。検査に通らない直しは反映せず、
 * 理由を残す（実装の提出は続ける）。直しの内容が指摘の求めた範囲に収まるかは、機械では見ない（次の回の AI のレビューと、
 * 人のマージで見る）。ここは副作用の無い関数だけ（記録・コミットは service が行う）。
 */

/** 1 回の出力で反映できる直しの件数と、before・after の文字数の上限。 */
export const DESIGN_EDIT_MAX = 10;
export const DESIGN_EDIT_TEXT_MAX = 2_000;
/** 記録する、反映しなかった直しの件数の上限（イベントの形の上限と同じ）。 */
const REJECTED_MAX = 50;

/** 形に合わない remarks・viewpoint・field の値の代わりに載せる文。 */
export const INVALID_VALUE = "（不正な値）";

/** 本文の直しで、直せない節（見出しの名前の頭）。テスト観点の節は、観点の直しで直す。 */
const FROZEN_SECTIONS = ["スコープ", "確認したいこと", "既定で決めたこと", "テスト観点"];

/** 直しのブロックを読んだ結果。 */
export type DesignEditRead = { kind: "read"; edits: unknown[] } | { kind: "unreadable" };

/** `{"sacty-design-edit": {"edits": [...]}}` の値を読む。形が違えば読めなかったものとして扱う。 */
export function readDesignEditBlock(value: unknown): DesignEditRead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unreadable" };
  const edits = (value as Record<string, unknown>).edits;
  if (!Array.isArray(edits)) return { kind: "unreadable" };
  return { kind: "read", edits };
}

export type DesignEditInput = {
  /** 今回の対応する指摘の ID。 */
  remarkIds: ReadonlySet<string>;
  /** 承認済みの設計の本文とテスト観点。 */
  output: string;
  viewpoints: readonly TestViewpoint[];
  /** タスクブランチの設計のファイル（まだコミットに入れていない直しを当てた後）。ファイルが無いタスクは undefined。 */
  file?: string;
  /** 伏せる秘密情報の値。 */
  secrets: readonly string[];
  /** 渡すと、すべての直しをこの理由で反映しない（同じ出力に変更の申し出がある・設計のファイルを読めないとき）。 */
  rejectAll?: string;
};

export type DesignEditResult = {
  output: string;
  viewpoints: TestViewpoint[];
  applied: DesignEditItem[];
  rejected: DesignEditRejected[];
};

type Heading = { level: number; title: string; index: number };

/** 見出しの行（`#` の並びで始まる行）の位置。 */
function headingsOf(doc: string): Heading[] {
  const found: Heading[] = [];
  for (const m of doc.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm)) {
    found.push({ level: m[1]?.length ?? 1, title: m[2] ?? "", index: m.index ?? 0 });
  }
  return found;
}

/** 見出しの行だけを並べた列（直しが見出しを足す・消す・変えないことの検査に使う）。 */
function headingLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => /^#{1,6}[ \t]/.test(l));
}

/** index の位置が、直せない節（その節の中の小見出しを含む）にあるか。 */
function inFrozenSection(doc: string, index: number): boolean {
  const stack: Heading[] = [];
  for (const h of headingsOf(doc)) {
    if (h.index > index) break;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.some((h) => FROZEN_SECTIONS.some((name) => h.title.startsWith(name)));
}

/** text の中の needle の位置（重ならない出現）。 */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
}

const VIEWPOINT_TOKEN = /TV-\d+/g;

/** 観点の欄の文を、行の内容に当てる（行の頭の印を除いた部分）。 */
const FIELD_PREFIX = { input: "  - 入力：", expected: "  - 期待結果：" } as const;

/**
 * 設計のファイル（または、テスト観点の節を含む文書）の、観点の行の欄に、直しを当てる。当てられなければ undefined。
 * 観点の行は「テスト観点」の節の中の `- [ID] 題` と、続く `  - 入力：`・`  - 期待結果：` の行（複数あれば、最後のもの）。
 * 欄の中で before が 1 か所だけのときに当てる。
 */
export function applyViewpointToDocument(
  doc: string,
  edit: { viewpoint: string; field: string; before: string; after: string },
): string | undefined {
  const lines = doc.split("\n");
  const sectionStarts = headingsOf(doc)
    .filter((h) => h.title.startsWith("テスト観点"))
    .map((h) => h.index);
  if (sectionStarts.length === 0) return undefined;
  // 行ごとの、文書の先頭からの位置
  let offset = 0;
  const starts = lines.map((l) => {
    const at = offset;
    offset += l.length + 1;
    return at;
  });
  const sectionAt = (index: number) => {
    const heads = headingsOf(doc);
    const stack: Heading[] = [];
    for (const h of heads) {
      if (h.index > index) break;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= h.level) stack.pop();
      stack.push(h);
    }
    return stack.some((h) => h.title.startsWith("テスト観点"));
  };
  const head = `- [${edit.viewpoint}] `;
  let rowLine = -1;
  for (const [i, line] of lines.entries()) {
    if (line.startsWith(head) && sectionAt(starts[i] ?? 0)) rowLine = i;
  }
  if (rowLine < 0) return undefined;
  // 行の範囲は、次の `- [` の行か見出しの行まで
  let end = rowLine + 1;
  while (end < lines.length && !/^- \[|^#{1,6}[ \t]/.test(lines[end] ?? "")) end++;
  let target = -1;
  let prefix = head;
  if (edit.field === "title") {
    target = rowLine;
  } else if (edit.field === "input" || edit.field === "expected") {
    prefix = FIELD_PREFIX[edit.field];
    for (let i = rowLine + 1; i < end; i++) if ((lines[i] ?? "").startsWith(prefix)) target = i;
  }
  if (target < 0) return undefined;
  const text = (lines[target] ?? "").slice(prefix.length);
  const at = occurrences(text, edit.before);
  if (at.length !== 1) return undefined;
  const first = at[0] ?? 0;
  lines[target] =
    `${prefix}${text.slice(0, first)}${edit.after}${text.slice(first + edit.before.length)}`;
  return lines.join("\n");
}

/**
 * 反映した直しを、設計のファイルに順に当てる。当てられない直し（before が 1 か所でない。すでに当たっている場合を含む）は
 * 飛ばす。人が直した内容・テスト観点の節は、直しの箇所のほかは、そのまま残る。
 */
export function applyEditsToFile(file: string, edits: readonly DesignEditItem[]): string {
  let doc = file;
  for (const e of edits) {
    if (e.viewpoint !== undefined && e.field !== undefined) {
      doc = applyViewpointToDocument(doc, { ...e, viewpoint: e.viewpoint, field: e.field }) ?? doc;
      continue;
    }
    const at = occurrences(doc, e.before);
    if (at.length !== 1) continue;
    const first = at[0] ?? 0;
    doc = `${doc.slice(0, first)}${e.after}${doc.slice(first + e.before.length)}`;
  }
  return doc;
}

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** 載せる文（反映しなかった直し）：秘密情報の値・内部のパスを伏せ、長さを切る。 */
function shown(value: string | undefined, secrets: readonly string[]): string {
  const hidden = withoutInternalPaths(redact(value ?? "", secrets));
  return hidden.length > DESIGN_EDIT_TEXT_MAX
    ? `${hidden.slice(0, DESIGN_EDIT_TEXT_MAX)}…`
    : hidden;
}

/**
 * 実装が出した直しを検査して、承認済みの設計とテスト観点に当てる。直しは順に当てる（後の直しの before は、前の直しの
 * after の一部でもよい）。検査に通らない直しは反映せず、理由を添えて返す。
 */
export function applyDesignEdits(
  raw: readonly unknown[],
  input: DesignEditInput,
): DesignEditResult {
  let output = input.output;
  let file = input.file;
  const viewpoints = input.viewpoints.map((v) => ({ ...v }));
  const applied: DesignEditItem[] = [];
  const rejected: DesignEditRejected[] = [];
  const viewpointIds = new Set(viewpoints.map((v) => v.id));

  for (const [index, item] of raw.entries()) {
    const r =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const remarks = Array.isArray(r.remarks) ? r.remarks.map((x) => text(x) ?? INVALID_VALUE) : [];
    const shownRemarks = remarks
      .slice(0, 50)
      .map((x) => (input.remarkIds.has(x) ? x : INVALID_VALUE));
    const viewpoint = text(r.viewpoint);
    const field = text(r.field);
    const before = text(r.before);
    const after = text(r.after);
    const reason = text(r.reason);
    const reject = (why: string) => {
      if (rejected.length >= REJECTED_MAX) return;
      rejected.push({
        remarks: shownRemarks,
        ...(r.viewpoint !== undefined
          ? {
              viewpoint:
                viewpoint !== undefined && viewpointIds.has(viewpoint) ? viewpoint : INVALID_VALUE,
            }
          : {}),
        ...(r.field !== undefined
          ? {
              field:
                field !== undefined && (DESIGN_EDIT_FIELDS as readonly string[]).includes(field)
                  ? field
                  : INVALID_VALUE,
            }
          : {}),
        before: shown(before, input.secrets),
        after: shown(after, input.secrets),
        reason: shown(reason, input.secrets),
        rejection: why,
      });
    };

    if (input.rejectAll !== undefined) {
      reject(input.rejectAll);
      continue;
    }
    if (index >= DESIGN_EDIT_MAX) {
      reject(
        `直しは 1 回の出力で ${DESIGN_EDIT_MAX} 件までなので、${index + 1} 件目以降は反映しません。`,
      );
      continue;
    }
    if (remarks.length === 0 || !remarks.every((x) => input.remarkIds.has(x))) {
      reject("今回の対応する指摘の ID が付いていません（指摘の求めた直しではないため）。");
      continue;
    }
    if (r.sensitive === true || r.sensitive === "true") {
      reject(
        "セキュリティ・認可・保存するデータの形・移行に触れる直しは、設計の工程で承認を受けるため、反映しません。",
      );
      continue;
    }
    if (before === undefined || after === undefined || reason === undefined) {
      reject("before・after・reason が文字列ではありません。");
      continue;
    }
    if (before === "") {
      reject("before が空です。");
      continue;
    }
    if (before.length > DESIGN_EDIT_TEXT_MAX || after.length > DESIGN_EDIT_TEXT_MAX) {
      reject(`before・after が ${DESIGN_EDIT_TEXT_MAX} 文字を超えています。`);
      continue;
    }
    if (
      redact(before, input.secrets) !== before ||
      redact(after, input.secrets) !== after ||
      redact(reason, input.secrets) !== reason
    ) {
      reject("秘密情報の値を含むため、反映しません（値は載せていません）。");
      continue;
    }
    if (withoutInternalPaths(after) !== after) {
      reject("作業領域の内部のパスを含むため、反映しません（人が辿れないため）。");
      continue;
    }
    if (headingLines(before).join("\n") !== headingLines(after).join("\n")) {
      reject("見出しの行を足す・消す・変える直しは、反映しません。");
      continue;
    }

    if (viewpoint !== undefined || field !== undefined) {
      // テスト観点の文言の直し
      const target = viewpoints.find((v) => v.id === viewpoint);
      if (!target) {
        reject("直す観点が、承認済みのテスト観点にありません。");
        continue;
      }
      if (field !== "title" && field !== "input" && field !== "expected") {
        reject("field が title・input・expected のどれでもありません。");
        continue;
      }
      const value = target[field];
      const at = occurrences(value, before);
      if (at.length !== 1) {
        reject(
          at.length === 0
            ? "before が、その観点のその欄にありません。"
            : "before が、その観点のその欄の 2 か所以上にあります。",
        );
        continue;
      }
      const first = at[0] ?? 0;
      const next = `${value.slice(0, first)}${after}${value.slice(first + before.length)}`;
      if (
        next.trim() === "" ||
        /[\r\n]/.test(after) ||
        (before.match(VIEWPOINT_TOKEN) ?? []).join("|") !==
          (after.match(VIEWPOINT_TOKEN) ?? []).join("|")
      ) {
        reject(
          "観点の ID・観点の数を変える直し（または欄を空・複数行にする直し）は、反映しません。",
        );
        continue;
      }
      target[field] = next;
      output =
        applyViewpointToDocument(output, { viewpoint: target.id, field, before, after }) ?? output;
      if (file !== undefined) {
        file =
          applyViewpointToDocument(file, { viewpoint: target.id, field, before, after }) ?? file;
      }
      applied.push({
        remarks: remarks.slice(0, 50),
        viewpoint: target.id,
        field,
        before,
        after,
        reason,
      });
      continue;
    }

    // 本文の直し：承認済みの設計と、設計のファイルの両方に、1 か所だけあること
    const inOutput = occurrences(output, before);
    if (inOutput.length !== 1) {
      reject(
        inOutput.length === 0
          ? "before が、承認済みの設計にありません。"
          : "before が、承認済みの設計の 2 か所以上にあります。",
      );
      continue;
    }
    if (inFrozenSection(output, inOutput[0] ?? 0)) {
      reject(
        "スコープ・確認したいこと・既定で決めたこと・テスト観点の節は、実装の工程からは直せません。",
      );
      continue;
    }
    if (file !== undefined) {
      const inFile = occurrences(file, before);
      if (inFile.length !== 1) {
        reject(
          inFile.length === 0
            ? "before が、設計のファイルにありません。"
            : "before が、設計のファイルの 2 か所以上にあります。",
        );
        continue;
      }
      if (inFrozenSection(file, inFile[0] ?? 0)) {
        reject(
          "スコープ・確認したいこと・既定で決めたこと・テスト観点の節は、実装の工程からは直せません。",
        );
        continue;
      }
      const at = inFile[0] ?? 0;
      file = `${file.slice(0, at)}${after}${file.slice(at + before.length)}`;
    }
    const at = inOutput[0] ?? 0;
    output = `${output.slice(0, at)}${after}${output.slice(at + before.length)}`;
    applied.push({ remarks: remarks.slice(0, 50), before, after, reason });
  }
  return { output, viewpoints, applied, rejected };
}

/**
 * まだ実装の PR のコミットに入れていない、反映した直し（記録順）。現在の承認済みの設計に対する記録だけ（設計をやり直して
 * 承認し直したら、前の記録は当てない）。
 */
export function pendingDesignEdits(task: Task): DesignEditItem[] {
  const since = task.approved.design?.at ?? "";
  return (task.designEdits ?? [])
    .filter((e) => !e.committed && e.at >= since)
    .flatMap((e) => e.applied);
}

/** 設計のファイルのパス（設計の PR が置いたもの）。設計の PR が無いタスク（画面で承認した）は undefined。 */
export function designFilePath(task: Task): string | undefined {
  return task.stepPullRequests.filter((p) => p.step === "design").at(-1)?.path;
}
