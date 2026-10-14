import type { ActivityEvent } from "@sacty/core";

/**
 * エージェントの実行のセッションログ（PBI-62）を、画面に並べる出来事にする。Claude Code（stream-json）と
 * Codex（exec --json）の主な出来事を読み、知らない形の行・JSON でない行は、そのまま生の行として出す。
 */

/** 作業履歴のうち、エージェントの実行の行（ログを見られる行）。 */
const RUN_EVENTS = new Set<ActivityEvent["type"]>([
  "AgentRunStarted",
  "AgentRunCompleted",
  "AgentRunFailed",
  "StepsChosen",
  "OrchestratorFailed",
  "TicketTriaged",
  "ChangeJudged",
  "ReworkJudged",
  "FinalReviewed",
  "FinalReviewFailed",
  "QuestionAnswered",
  "ExportStarted",
  "OutputExported",
  "AgentSessionArchived",
  "OrchestratorSessionUsed",
]);

/** 作業履歴の行から、ログを見られる実行の ID。実行の行でない・ID の無い古い行なら undefined。 */
export function runLogId(event: ActivityEvent): string | undefined {
  if (!RUN_EVENTS.has(event.type)) return undefined;
  const runId = (event.payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId ? runId : undefined;
}

export type LogEntry = { line: number } & (
  | { kind: "session"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "message"; text: string }
  | { kind: "toolCall"; name: string; input: string; unfinished?: boolean }
  | { kind: "toolResult"; text: string; isError: boolean }
  | { kind: "result"; isError: boolean; text: string; detail: string }
  | { kind: "turn"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "truncated";
      droppedBytes: number;
      droppedLines: number;
      headBytes: number;
      tailBytes: number;
    }
  | { kind: "raw"; text: string }
);

type Json = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const pretty = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");

/** ツールの結果（文字列か、text の部品の配列）を文にする。 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as Json).type === "text"
          ? str((c as Json).text)
          : pretty(c),
      )
      .join("\n");
  }
  return content === undefined ? "" : pretty(content);
}

function usageText(usage: unknown): string {
  if (!usage || typeof usage !== "object") return "";
  return Object.entries(usage as Json)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/** Claude Code の1行。読めない形なら undefined（生の行として出す）。 */
function claudeEntries(event: Json, line: number): LogEntry[] | undefined {
  if (event.type === "system") {
    if (event.subtype === "init") {
      const tools = Array.isArray(event.tools) ? event.tools.length : 0;
      const text = [str(event.model), tools ? `tools=${tools}` : "", str(event.cwd)]
        .filter(Boolean)
        .join(" · ");
      return [{ line, kind: "session", text }];
    }
    return undefined;
  }
  if (event.type === "assistant" || event.type === "user") {
    const content = (event.message as Json | undefined)?.content;
    if (typeof content === "string") {
      return event.type === "assistant" ? [{ line, kind: "message", text: content }] : undefined;
    }
    if (!Array.isArray(content)) return undefined;
    const entries: LogEntry[] = [];
    for (const part of content) {
      const c = (part ?? {}) as Json;
      if (c.type === "text") entries.push({ line, kind: "message", text: str(c.text) });
      else if (c.type === "thinking")
        entries.push({ line, kind: "thinking", text: str(c.thinking) });
      else if (c.type === "redacted_thinking") entries.push({ line, kind: "thinking", text: "" });
      else if (c.type === "tool_use") {
        entries.push({ line, kind: "toolCall", name: str(c.name), input: pretty(c.input ?? {}) });
      } else if (c.type === "tool_result") {
        entries.push({
          line,
          kind: "toolResult",
          text: resultText(c.content),
          isError: c.is_error === true,
        });
      } else entries.push({ line, kind: "raw", text: JSON.stringify(c) });
    }
    return entries;
  }
  if (event.type === "result") {
    const errors = Array.isArray(event.errors) ? event.errors.map(pretty).join("\n") : "";
    const detail = [
      str(event.subtype),
      typeof event.num_turns === "number" ? `turns=${event.num_turns}` : "",
      typeof event.total_cost_usd === "number" ? `cost=$${event.total_cost_usd}` : "",
      usageText(event.usage),
    ]
      .filter(Boolean)
      .join(" · ");
    return [
      {
        line,
        kind: "result",
        isError: event.is_error === true,
        text: str(event.result) || errors,
        detail,
      },
    ];
  }
  return undefined;
}

/** Codex の項目（item）。 */
function codexItem(item: Json, line: number, unfinished: boolean): LogEntry[] | undefined {
  const type = item.type ?? item.item_type;
  switch (type) {
    case "agent_message":
    case "assistant_message":
      return [{ line, kind: "message", text: str(item.text) }];
    case "reasoning":
      return [{ line, kind: "thinking", text: str(item.text) }];
    case "command_execution": {
      const call: LogEntry = {
        line,
        kind: "toolCall",
        name: "command",
        input: str(item.command),
        ...(unfinished ? { unfinished } : {}),
      };
      if (unfinished) return [call];
      const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
      return [
        call,
        {
          line,
          kind: "toolResult",
          text: `${str(item.aggregated_output)}${exit !== undefined ? `\n(exit ${exit})` : ""}`.trim(),
          isError: (exit !== undefined && exit !== 0) || item.status === "failed",
        },
      ];
    }
    case "mcp_tool_call": {
      const call: LogEntry = {
        line,
        kind: "toolCall",
        name: [str(item.server), str(item.tool)].filter(Boolean).join("."),
        input: pretty(item.arguments ?? {}),
        ...(unfinished ? { unfinished } : {}),
      };
      if (unfinished) return [call];
      const error = item.error as Json | undefined;
      return [
        call,
        {
          line,
          kind: "toolResult",
          text: error ? str(error.message) || pretty(error) : resultText(item.result ?? ""),
          isError: Boolean(error) || item.status === "failed",
        },
      ];
    }
    case "file_change":
      return [
        {
          line,
          kind: "toolCall",
          name: "file_change",
          input: pretty(item.changes ?? []),
          ...(unfinished ? { unfinished } : {}),
        },
      ];
    case "web_search":
      return [{ line, kind: "toolCall", name: "web_search", input: str(item.query) }];
    case "error":
      return [{ line, kind: "error", text: str(item.message) }];
    default:
      return undefined;
  }
}

function itemId(event: Json): string | undefined {
  const id = (event.item as Json | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/** Codex の1行。 */
function codexEntries(event: Json, line: number, completed: Set<string>): LogEntry[] | undefined {
  switch (event.type) {
    case "thread.started":
      return [{ line, kind: "session", text: str(event.thread_id) }];
    case "turn.started":
      return [];
    case "turn.completed":
      return [{ line, kind: "turn", text: usageText(event.usage) }];
    case "turn.failed":
    case "error": {
      const err = event.error as Json | undefined;
      return [{ line, kind: "error", text: str(err?.message) || str(event.message) }];
    }
    case "item.completed":
      return codexItem((event.item ?? {}) as Json, line, false);
    case "item.started":
    case "item.updated": {
      // 終わった項目は、終わった行で出す。終わらないまま止まった項目だけ、始まった行で出す（同じ項目の最後の行）
      const id = itemId(event);
      if (id && completed.has(id)) return [];
      return codexItem((event.item ?? {}) as Json, line, true);
    }
    default:
      return undefined;
  }
}

export function parseSessionLog(text: string): LogEntry[] {
  const lines = text.split("\n");
  const parsed: (Json | undefined)[] = lines.map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const value: unknown = JSON.parse(trimmed);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Json)
        : undefined;
    } catch {
      return undefined;
    }
  });
  // Codex の、終わった項目（始まった行・途中の行は出さない）と、終わらなかった項目の最後の行
  const completed = new Set<string>();
  const lastSeen = new Map<string, number>();
  parsed.forEach((event, i) => {
    const id = event ? itemId(event) : undefined;
    if (!event || !id) return;
    if (event.type === "item.completed") completed.add(id);
    lastSeen.set(id, i);
  });

  const entries: LogEntry[] = [];
  parsed.forEach((event, i) => {
    const line = i + 1;
    const raw = lines[i] ?? "";
    if (!event) {
      if (raw.trim()) entries.push({ line, kind: "raw", text: raw });
      return;
    }
    if (event.type === "sacty.truncated") {
      entries.push({
        line,
        kind: "truncated",
        droppedBytes: Number(event.droppedBytes) || 0,
        droppedLines: Number(event.droppedLines) || 0,
        headBytes: Number(event.headBytes) || 0,
        tailBytes: Number(event.tailBytes) || 0,
      });
      return;
    }
    const id = itemId(event);
    if (id && !completed.has(id) && lastSeen.get(id) !== i) return;
    const found =
      typeof event.type === "string" && /^(thread|turn|item)\.|^error$/.test(event.type)
        ? codexEntries(event, line, completed)
        : claudeEntries(event, line);
    if (found) entries.push(...found);
    else entries.push({ line, kind: "raw", text: raw });
  });
  return entries;
}
