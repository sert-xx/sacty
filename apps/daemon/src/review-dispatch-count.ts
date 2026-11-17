import { createReadStream, type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TRUNCATED_EVENT } from "./session-logs.js";

/**
 * PR のレビューの実行が、観点ごとの担当（サブエージェント）を何件起動したかを、実行の記録から数える（PBI-379）。
 *
 * 数えるのは、実行の後に sacty が写した、エージェントのセッションのファイル（runs/<タスク>/<実行>/agent。PBI-66）。
 * エージェントの種類ごとに形が違う。
 * - Claude Code：担当ごとのセッションのファイル（projects/<作業ディレクトリ>/<セッション>/subagents/ の下。深さによらない。
 *   名前が `agent-<16進の ID>.jsonl` の形のものだけ）の数と、親のセッション（projects/<作業ディレクトリ>/<セッション>.jsonl）
 *   の中の、担当を起動するツール（`Agent`・`Task`・`Workflow`）の呼び出し（呼び出しの ID で重複を除く）の数の、多い方。
 *   担当のセッションのファイルは、名前を知らない起動のツールで起動しても残る。親の呼び出しは、担当のセッションのファイルの
 *   形が変わっても残る。どちらかが 1 件以上なら、0 件と数えない
 * - Codex：rollout のファイルのうち、先頭の `session_meta` の `source` が `exec` のものが親。親の中の `spawn_agent` の
 *   呼び出しを数える（担当ごとにも rollout ができ、親の履歴を引き継ぐので、全部のファイルで数えると重複する）
 *
 * 「起動が 0 件」をやり直しにするのは、担当を起動する手段がその実行にあったと確かめられたときだけ。
 * - Claude Code：実行の出力の最初の出来事（`system`・`init`）の `tools` に、上の担当を起動するツールのどれかがある
 * - Codex：親の `turn_context` に `multi_agent_version` がある
 * 確かめられなければ（手段が無い環境。スキルの逐次モードで見る）、0 件でもやり直しにしない。
 *
 * 数えられないとき（ファイルが無い・読めない・間を省いたファイルや写せなかったファイルのある実行で 0 件・知らない種類の
 * エージェント）は、subagents を
 * undefined（分からない）にする。担当の中身や質は見ない。
 *
 * エージェントの版が変わり、親の呼び出しと担当のセッションのファイルの両方が、上の形で残らなくなると、親のセッションが
 * 読める限り、担当を起動した実行も 0 件と数える（手段があったと確かめられれば、やり直しになり、続けば止まる）。片方だけなら、
 * もう片方で数える。上限で間を省いた親のセッションで 0 件のときは、「分からない」にする（担当のセッションのファイルは、
 * 間を省いていても、あれば数える）。
 */
export type ReviewDispatchCount = {
  /** 起動した担当の数。数えられなければ undefined。 */
  subagents: number | undefined;
  /** 担当を起動する手段が、その実行にあったと確かめられたか。 */
  canDispatch: boolean;
  /** 数えられなかった理由（subagents が undefined のときだけ）。 */
  unknown?: ReviewDispatchUnknown;
};

/** 数えられなかった理由（デーモンのログに出す。記録には残さない）。 */
export type ReviewDispatchUnknown =
  /** 写したセッションのファイルの場所が無い。 */
  | "no_files_dir"
  /** 数え方を知らない種類のエージェント。 */
  | "unknown_runtime"
  /** 親のセッションのファイルが無い。 */
  | "no_parent_session"
  /** 上限で間を省いたファイルで、0 件だった（省いた所に起動があったかもしれない）。 */
  | "truncated"
  /** 写せなかったファイルがある実行で、0 件だった（写せなかった所に起動があったかもしれない）。 */
  | "files_skipped"
  /** 読んでいる途中で失敗した。 */
  | "unreadable";

const unknown = (reason: ReviewDispatchUnknown): ReviewDispatchCount => ({
  subagents: undefined,
  canDispatch: false,
  unknown: reason,
});

/**
 * Claude Code の、担当を起動するツールの名前。1 件ずつ起動するツール（版によって `Task` か `Agent`）と、まとめて起動する
 * ツール（`Workflow`）。親の呼び出しを数えるのにも、手段があったかの確かめにも、同じものを使う（手段として認めるツールを
 * 親が呼んでいれば、担当のセッションのファイルの形が変わっても、0 件と数えない）。
 */
const CLAUDE_DISPATCH_TOOLS = new Set(["Agent", "Task", "Workflow"]);

/** Claude Code の、担当のセッションのファイルの名前（`agent-<16進の ID>.jsonl`）。 */
const CLAUDE_SUBAGENT_FILE = /^agent-[0-9a-f]+\.jsonl$/;

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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(line));
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
  // 親：projects/<作業ディレクトリ>/<セッション>.jsonl
  const parents = files.filter((f) => f.split("/").length === 2 && f.endsWith(".jsonl"));
  // 担当のセッションは、<セッション>/subagents/ の下に、深さによらず数える（起動のしかたによって、置かれる深さが違う。
  // まとめて起動するツールは subagents/workflows/<実行>/ の下に置く）。数えるのは、担当のセッションの名前の形のファイルだけ
  // （ほかの名前の記録は、担当として数えない）
  const children = files.filter((f) => {
    const parts = f.split("/");
    return (
      parts.length >= 4 &&
      parts[2] === "subagents" &&
      CLAUDE_SUBAGENT_FILE.test(parts[parts.length - 1] ?? "")
    );
  });
  if (parents.length === 0) return unknown("no_parent_session");
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
  if (subagents === 0 && truncated) return unknown("truncated");
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
  if (parents === 0) return unknown("no_parent_session");
  if (spawned === 0 && truncated) return unknown("truncated");
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
  /** セッションのファイルを写すときに、写せなかったファイルがあった（写しに欠けがある）。 */
  filesSkipped?: boolean;
}): Promise<ReviewDispatchCount> {
  if (!input.agentDir) return unknown("no_files_dir");
  let counted: ReviewDispatchCount;
  try {
    if (input.runtime === "claude-code") {
      counted = await countClaude(input.agentDir, input.eventsPath);
    } else if (input.runtime === "codex") {
      counted = await countCodex(input.agentDir);
    } else {
      return unknown("unknown_runtime");
    }
  } catch {
    // 読めなければ、分からない（やり直しにしない）
    return unknown("unreadable");
  }
  // 写しに欠けがある実行で 0 件なら、写せなかったファイルに起動があったかもしれない
  return counted.subagents === 0 && input.filesSkipped ? unknown("files_skipped") : counted;
}
