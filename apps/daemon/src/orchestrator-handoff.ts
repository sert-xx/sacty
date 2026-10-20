import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionRuntime } from "./agent-sessions.js";

/**
 * オーケストレーターのエージェントが変わったとき（利用制限で代わりのエージェントに切り替えた・設定を変えた）に、前の
 * エージェントのセッションのやり取りを、次のエージェントに引き継ぐ。セッションのファイルは AI の種類ごとの形で、別の
 * エージェントでは再開できないので、やり取り（人とエージェントの発言）だけを文にして、読み取り専用で渡す。保存した
 * セッションのファイルは、秘密情報を伏せた後のもの。
 */

/** コンテナの中で、引き継ぐやり取りを置く場所（作業領域の外）。 */
export const CONTAINER_HANDOFF_DIR = "/sacty-handoff";

/** 引き継ぐやり取りのファイルの名前。 */
export const HANDOFF_FILE = "previous-session.md";

/** 1つの発言の上限（文字数）。長い発言（最初の指示など）は、先頭だけを残す。 */
export const HANDOFF_MESSAGE_LIMIT = 8_000;

/** やり取り全体の上限（文字数）。超えたら、古い発言から省く。 */
export const HANDOFF_TOTAL_LIMIT = 200_000;

/**
 * セッションの本体のファイルから読む上限（バイト）。保存するファイルは最大 200MiB なので、全体は読まず、末尾のこの分だけを
 * 読む（引き継ぐのは新しい発言なので、最後に捨てる部分まで読まない。デーモンを長く止めないため。PR #172 レビュー提案）。
 */
export const HANDOFF_READ_LIMIT = 8 * 1024 * 1024;

type Turn = { role: "user" | "assistant"; text: string };

/** 発言の中身（文字列か、種類つきの部分の並び）から、文の部分だけを取り出す。ツールの呼び出し・結果は入れない。 */
function textOf(content: unknown, types: readonly string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      types.includes(String((part as { type?: unknown }).type)) &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter((text) => text.trim())
    .join("\n");
}

/** セッションの本体のファイル（JSONL）の1行から、発言を読む。発言でない行は undefined。 */
function turnOf(runtime: AgentSessionRuntime, line: string): Turn | undefined {
  let event: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    event = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (runtime === "claude-code") {
    // projects/<作業ディレクトリ>/<ID>.jsonl：{ type: "user" | "assistant", message: { content } }
    if (event.type !== "user" && event.type !== "assistant") return undefined;
    const message = event.message as { content?: unknown } | undefined;
    const text = textOf(message?.content, ["text"]);
    return text.trim() ? { role: event.type, text } : undefined;
  }
  // sessions/…/rollout-…-<ID>.jsonl：{ type: "response_item", payload: { type: "message", role, content } }
  const item = (event.type === "response_item" ? event.payload : event) as
    | Record<string, unknown>
    | undefined;
  if (item?.type !== "message") return undefined;
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  const text = textOf(item.content, ["input_text", "output_text", "text"]);
  return text.trim() ? { role: item.role, text } : undefined;
}

/** 先頭から limit 文字（UTF-16 のコード単位）まで。サロゲートペアの途中では切らない（PR #172 レビュー提案）。 */
export function headOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/**
 * セッションの本体のファイルから、やり取りを Markdown の文にする。1つの発言は HANDOFF_MESSAGE_LIMIT まで、全体は
 * HANDOFF_TOTAL_LIMIT まで（超えたら古い発言から省く。読みながら省き、上限を超えて持たない）。headOmitted は、ファイルの
 * 先頭を読まなかった（古い発言の数が分からない）とき。発言が無ければ undefined。
 */
export function sessionTranscript(
  runtime: AgentSessionRuntime,
  jsonl: string,
  limits: { message: number; total: number } = {
    message: HANDOFF_MESSAGE_LIMIT,
    total: HANDOFF_TOTAL_LIMIT,
  },
  headOmitted = false,
): { text: string; truncated: boolean } | undefined {
  const turns: string[] = [];
  let total = 0;
  let dropped = 0;
  let truncated = headOmitted;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const turn = turnOf(runtime, line);
    if (!turn) continue;
    let text = turn.text.trim();
    if (text.length > limits.message) {
      text = `${headOf(text, limits.message)}\n\n（以下略）`;
      truncated = true;
    }
    const entry = `## ${turn.role === "user" ? "指示" : "エージェント"}\n\n${text}\n`;
    turns.push(entry);
    total += entry.length;
    // 最後の発言は、上限を超えても残す
    while (turns.length > 1 && total > limits.total) {
      total -= (turns.shift() as string).length;
      dropped++;
    }
  }
  if (turns.length === 0) return undefined;
  if (dropped > 0) truncated = true;
  const note = headOmitted
    ? "（古い発言は省いた）"
    : dropped > 0
      ? `（古い発言 ${dropped} 件は省いた）`
      : undefined;
  return {
    text: [
      "# 前のエージェントのセッションのやり取り",
      "",
      ...(note ? [note, ""] : []),
      ...turns,
    ].join("\n"),
    truncated,
  };
}

/**
 * ファイルの末尾の limit バイトまでを読む。全体を読まなかったら、途中から始まる最初の行を捨てる（headOmitted）。
 */
export function readTail(path: string, limit: number): { text: string; headOmitted: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    if (length === size) return { text, headOmitted: false };
    const newline = text.indexOf("\n");
    return { text: newline >= 0 ? text.slice(newline + 1) : "", headOmitted: true };
  } finally {
    closeSync(fd);
  }
}

/**
 * 引き継ぐやり取りを dir に書き、コンテナに渡すもの（マウント・読める場所・指示に足す文）を返す。セッションの本体の
 * ファイルを読めない・発言が無ければ undefined（引き継がずに、台帳から作る指示だけで始める）。
 */
export function stageHandoff(
  dir: string,
  previous: { agentId: string; runtime: AgentSessionRuntime; sessionId: string; mainFile: string },
):
  | {
      mount: { hostPath: string; containerPath: string; readOnly: true };
      promptLines: string[];
      truncated: boolean;
    }
  | undefined {
  let tail: ReturnType<typeof readTail>;
  try {
    tail = readTail(previous.mainFile, HANDOFF_READ_LIMIT);
  } catch {
    return undefined;
  }
  const transcript = sessionTranscript(previous.runtime, tail.text, undefined, tail.headOmitted);
  if (!transcript) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, HANDOFF_FILE), transcript.text, { mode: 0o600 });
  return {
    mount: { hostPath: dir, containerPath: CONTAINER_HANDOFF_DIR, readOnly: true },
    promptLines: [
      "",
      "## 前のエージェントからの引き継ぎ",
      "",
      `このタスクのオーケストレーターは、これまで別のエージェント（${previous.agentId}）が務めていた（利用制限などで切り替えた）。`,
      `そのセッションのやり取りを ${CONTAINER_HANDOFF_DIR}/${HANDOFF_FILE} に置いた（読み取り専用）。`,
      "上の指示とタスクの台帳が正しい状態なので、それに従う。経緯（前に何を考え、何を決めたか）を確かめたいときに読む。",
    ],
    truncated: transcript.truncated,
  };
}
