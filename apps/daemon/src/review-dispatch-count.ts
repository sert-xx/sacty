import { createReadStream, type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TRUNCATED_EVENT } from "./session-logs.js";

/**
 * PR のレビューの実行が、観点ごとの担当（サブエージェント）を何件起動したかを、実行の記録から数える（PBI-379）。
 *
 * 数えるのは、実行の後に sacty が写した、エージェントのセッションのファイル（runs/<タスク>/<実行>/agent。PBI-66）。
 * エージェントの種類ごとに形が違う。
 * - Claude Code：親のセッション（projects/<作業ディレクトリ>/<セッション>.jsonl）の中の、担当を起動するツール
 *   （`Agent`・`Task`）の呼び出しを、呼び出しの ID で重複を除いて数える。担当ごとのセッション
 *   （…/<セッション>/subagents/*.jsonl）の数も数え、多い方を使う
 * - Codex：rollout のファイルのうち、先頭の `session_meta` の `source` が `exec` のものが親。親の中の `spawn_agent` の
 *   呼び出しを数える（担当ごとにも rollout ができ、親の履歴を引き継ぐので、全部のファイルで数えると重複する）
 *
 * 「起動が 0 件」をやり直しにするのは、担当を起動する手段がその実行にあったと確かめられたときだけ。
 * - Claude Code：実行の出力の最初の出来事（`system`・`init`）の `tools` に、`Agent` か `Task` がある
 * - Codex：親の `turn_context` に `multi_agent_version` がある
 * 確かめられなければ（手段が無い環境。スキルの逐次モードで見る）、0 件でもやり直しにしない。
 *
 * 数えられないとき（ファイルが無い・読めない・間を省いたファイルで 0 件・知らない種類のエージェント）は、subagents を
 * undefined（分からない）にする。担当の中身や質は見ない。
 */
export type ReviewDispatchCount = {
  /** 起動した担当の数。数えられなければ undefined。 */
  subagents: number | undefined;
  /** 担当を起動する手段が、その実行にあったと確かめられたか。 */
  canDispatch: boolean;
};

const UNKNOWN: ReviewDispatchCount = { subagents: undefined, canDispatch: false };

/** Claude Code の、担当を起動するツールの名前（版によって `Task` か `Agent`）。 */
const CLAUDE_DISPATCH_TOOLS = new Set(["Agent", "Task"]);

/** 実行の出力の先頭から、最初の出来事（init）を探す行数の上限。 */
const INIT_LINES = 50;

/** ファイルを1行ずつ読む。each が false を返したら、そこでやめる。 */
async function eachLine(path: string, each: (line: string) => boolean | undefined): Promise<void> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (each(line) === false) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上限で間を省いたことの目印の行か（sacty が写すときに入れる）。目印の名前が、指示や差分の文字列の中にあるだけの行は、
 * 目印として扱わない。
 */
function isTruncationMark(line: string): boolean {
  return line.includes(TRUNCATED_EVENT) && parse(line)?.type === TRUNCATED_EVENT;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** dir の下の通常のファイル（シンボリックリンクは辿らない）を、dir からの相対パス（区切りは /）で返す。 */
function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(dir, "");
  return found.sort();
}

async function countClaude(
  agentDir: string,
  eventsPath: string | undefined,
): Promise<ReviewDispatchCount> {
  const files = listFiles(join(agentDir, "projects"));
  // 親：projects/<作業ディレクトリ>/<セッション>.jsonl。担当：projects/<作業ディレクトリ>/<セッション>/subagents/*.jsonl
  const parents = files.filter((f) => f.split("/").length === 2 && f.endsWith(".jsonl"));
  const children = files.filter((f) => {
    const parts = f.split("/");
    return parts.length === 4 && parts[2] === "subagents" && f.endsWith(".jsonl");
  });
  if (parents.length === 0) return UNKNOWN;
  const calls = new Set<string>();
  let truncated = false;
  for (const parent of parents) {
    await eachLine(join(agentDir, "projects", parent), (line) => {
      if (isTruncationMark(line)) truncated = true;
      if (!line.includes('"tool_use"')) return undefined;
      const content = record(parse(line)?.message)?.content;
      if (!Array.isArray(content)) return undefined;
      for (const block of content) {
        const b = record(block);
        if (
          b?.type === "tool_use" &&
          typeof b.name === "string" &&
          CLAUDE_DISPATCH_TOOLS.has(b.name) &&
          typeof b.id === "string"
        ) {
          calls.add(b.id);
        }
      }
      return undefined;
    });
  }
  const subagents = Math.max(calls.size, children.length);
  // 間を省いたファイル（上限を超えた実行）で 0 件なら、省いた所に呼び出しがあったかもしれない
  if (subagents === 0 && truncated) return UNKNOWN;
  return { subagents, canDispatch: eventsPath ? await claudeCanDispatch(eventsPath) : false };
}

/** Claude Code の実行の出力の最初の出来事（init）の、使えるツールの一覧に、担当を起動するツールがあるか。 */
async function claudeCanDispatch(eventsPath: string): Promise<boolean> {
  let can = false;
  let read = 0;
  await eachLine(eventsPath, (line) => {
    read++;
    const event = line.includes('"init"') ? parse(line) : undefined;
    if (event?.type === "system" && event.subtype === "init") {
      can =
        Array.isArray(event.tools) &&
        event.tools.some((t) => typeof t === "string" && CLAUDE_DISPATCH_TOOLS.has(t));
      return false;
    }
    return read < INIT_LINES;
  });
  return can;
}

async function countCodex(agentDir: string): Promise<ReviewDispatchCount> {
  const rollouts = ["sessions", "archived_sessions"].flatMap((dir) =>
    listFiles(join(agentDir, dir))
      .filter((f) => /(^|\/)rollout-[^/]*\.jsonl$/.test(f))
      .map((f) => join(agentDir, dir, f)),
  );
  let parents = 0;
  let spawned = 0;
  let canDispatch = false;
  let truncated = false;
  for (const path of rollouts) {
    let first = true;
    let parent = false;
    const ids = new Set<string>();
    let anonymous = 0;
    await eachLine(path, (line) => {
      if (first) {
        first = false;
        const meta = parse(line);
        parent = meta?.type === "session_meta" && record(meta.payload)?.source === "exec";
        if (parent) parents++;
        return parent;
      }
      if (isTruncationMark(line)) truncated = true;
      if (line.includes('"multi_agent_version"')) {
        const event = parse(line);
        const version =
          event?.type === "turn_context" ? record(event.payload)?.multi_agent_version : undefined;
        if (typeof version === "string" && version) canDispatch = true;
      }
      if (!line.includes('"spawn_agent"')) return undefined;
      const event = parse(line);
      const payload = record(event?.payload);
      if (
        event?.type === "response_item" &&
        payload?.type === "function_call" &&
        payload.name === "spawn_agent"
      ) {
        const id = payload.call_id ?? payload.id;
        if (typeof id === "string" && id) ids.add(id);
        else anonymous++;
      }
      return undefined;
    });
    spawned += ids.size + anonymous;
  }
  if (parents === 0) return UNKNOWN;
  if (spawned === 0 && truncated) return UNKNOWN;
  return { subagents: spawned, canDispatch };
}

/**
 * 実行の記録から、起動した担当の数を数える。agentDir は写したセッションのファイルの場所、eventsPath は実行の出力
 * （セッションログの events）の場所。読めない・知らない種類のエージェントなら、分からない（subagents が undefined）。
 */
export async function countReviewDispatch(input: {
  runtime: string;
  agentDir: string | undefined;
  eventsPath: string | undefined;
}): Promise<ReviewDispatchCount> {
  if (!input.agentDir) return UNKNOWN;
  try {
    if (input.runtime === "claude-code") return await countClaude(input.agentDir, input.eventsPath);
    if (input.runtime === "codex") return await countCodex(input.agentDir);
  } catch {
    // 読めなければ、分からない（やり直しにしない）
  }
  return UNKNOWN;
}
