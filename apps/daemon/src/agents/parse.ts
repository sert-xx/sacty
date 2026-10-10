import type { DaemonText, TokenUsage } from "@sacty/core";

export type FailureReason = "usage_limit" | "auth" | "error";

export type AgentOutcome =
  | { kind: "completed"; output: string; usage: TokenUsage }
  | {
      kind: "failed";
      reason: FailureReason;
      /** エージェントや外から来た文はそのまま、sacty の文言はコードと引数（PBI-11）。 */
      message: DaemonText;
      usage?: TokenUsage;
    };

const ZERO: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** エラー文から、止まった理由を分類する。 */
export function classifyFailure(message: string): FailureReason {
  if (/usage limit|session limit|weekly limit|rate limit|\b429\b|quota/i.test(message)) {
    return "usage_limit";
  }
  if (
    /\b401\b|\b403\b|unauthori[sz]ed|invalid authentication|expired|revoked|please run \/login|not logged in/i.test(
      message,
    )
  ) {
    return "auth";
  }
  return "error";
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 出力の末尾にある最後のJSONオブジェクトを取り出す（前に警告などが出ていても読めるように）。 */
function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 次の行を試す
    }
  }
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** `claude -p --output-format json` の結果を読む。 */
export function parseClaudeResult(stdout: string, exitCode: number, stderr = ""): AgentOutcome {
  const json = lastJsonObject(stdout);
  if (!json) {
    const message = (stderr || stdout || `exit code ${exitCode}`).trim().slice(0, 2000);
    return { kind: "failed", reason: classifyFailure(message), message };
  }
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const usage: TokenUsage = {
    input: nonNegInt(u.input_tokens),
    cacheRead: nonNegInt(u.cache_read_input_tokens),
    cacheWrite: nonNegInt(u.cache_creation_input_tokens),
    output: nonNegInt(u.output_tokens),
  };
  const result = typeof json.result === "string" ? json.result : "";
  if (json.is_error === true || exitCode !== 0) {
    const message = (result || stderr || `exit code ${exitCode}`).trim().slice(0, 2000);
    return { kind: "failed", reason: classifyFailure(message), message, usage };
  }
  return { kind: "completed", output: result, usage };
}

/**
 * `codex exec --json` のJSONLを読む。turn.completed の usage を合計する。
 * Codexの cached_input_tokens は input_tokens の内数なので、入力からは差し引いて二重計上を防ぐ。
 */
export function parseCodexEvents(stdout: string, exitCode: number, stderr = ""): AgentOutcome {
  let usage: TokenUsage = { ...ZERO };
  let output = "";
  let errorMessage = "";
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "turn.completed") {
      const u = (event.usage ?? {}) as Record<string, unknown>;
      const input = nonNegInt(u.input_tokens);
      const cached = Math.min(nonNegInt(u.cached_input_tokens), input);
      usage = {
        input: usage.input + (input - cached),
        cacheRead: usage.cacheRead + cached,
        cacheWrite: usage.cacheWrite + nonNegInt(u.cache_write_input_tokens),
        output: usage.output + nonNegInt(u.output_tokens),
      };
    } else if (event.type === "item.completed") {
      const item = (event.item ?? {}) as Record<string, unknown>;
      const kind = item.type ?? item.item_type;
      if (kind === "agent_message" && typeof item.text === "string") output = item.text;
    } else if (event.type === "turn.failed" || event.type === "error") {
      const err = event.error as Record<string, unknown> | undefined;
      const message = typeof err?.message === "string" ? err.message : event.message;
      if (typeof message === "string") errorMessage = message;
    }
  }
  if (errorMessage || exitCode !== 0) {
    const message = (errorMessage || stderr || `exit code ${exitCode}`).trim().slice(0, 2000);
    return { kind: "failed", reason: classifyFailure(message), message, usage };
  }
  return { kind: "completed", output, usage };
}
