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
  // Bedrock は、混雑時に ThrottlingException・Too Many Requests を返す（PBI-32）
  if (
    /usage limit|session limit|weekly limit|rate limit|\b429\b|quota|throttl|too many requests/i.test(
      message,
    )
  ) {
    return "usage_limit";
  }
  if (
    // Bedrock は、API キーやモデルの権限が無いと AccessDeniedException を返す（PBI-32）
    /\b401\b|\b403\b|unauthori[sz]ed|invalid authentication|expired|revoked|please run \/login|not logged in|access ?denied/i.test(
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

/** 1行ずつ読んだ JSON オブジェクト（JSON でない行・壊れた行は飛ばす）。 */
function jsonLines(stdout: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        objects.push(value as Record<string, unknown>);
      }
    } catch {
      // 次の行を試す
    }
  }
  return objects;
}

/**
 * Claude Code の最終結果を取り出す。stream-json（PBI-62）では途中の出来事の後の、最後の result の出来事。
 * json の形（type の無い1つのオブジェクト・整形された複数行）も読む（前に警告などが出ていても読めるように）。
 * 途中の出来事だけで result が無ければ（途中で落ちた）、無いものとして扱う。
 */
function claudeResult(stdout: string): Record<string, unknown> | undefined {
  const objects = jsonLines(stdout);
  const result = objects.findLast((o) => o.type === "result");
  if (result) return result;
  const last = objects.at(-1);
  if (last && last.type === undefined) return last;
  if (objects.length > 0) return undefined;
  try {
    const value: unknown = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** result が無いときに、途中の出来事から分かる最後のエージェントの発言（認証の失敗の文など）。 */
function lastAssistantText(stdout: string): string {
  for (const event of jsonLines(stdout).reverse()) {
    if (event.type !== "assistant") continue;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((c) => (c && typeof c === "object" && c.type === "text" ? String(c.text ?? "") : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** `claude -p --output-format stream-json --verbose`（PBI-62）か `--output-format json` の結果を読む。 */
export function parseClaudeResult(stdout: string, exitCode: number, stderr = ""): AgentOutcome {
  const json = claudeResult(stdout);
  if (!json) {
    // 途中の出来事の JSON の行そのものは、理由にしない（長く、読みにくいため。全文はセッションログにある）
    const raw = jsonLines(stdout).length > 0 ? "" : stdout;
    const message = (stderr || lastAssistantText(stdout) || raw || `exit code ${exitCode}`)
      .trim()
      .slice(0, 2000);
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
    // stream-json の失敗の result には、result の文が無く、種類（error_max_turns など）と errors だけのことがある
    const errors = Array.isArray(json.errors)
      ? json.errors.filter((e): e is string => typeof e === "string").join("\n")
      : "";
    const subtype =
      typeof json.subtype === "string" && json.subtype !== "success" ? json.subtype : "";
    const message = (result || errors || stderr || subtype || `exit code ${exitCode}`)
      .trim()
      .slice(0, 2000);
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
