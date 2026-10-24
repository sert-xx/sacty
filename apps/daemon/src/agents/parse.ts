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

/** 1行の上限（文字数）。これより長い行は読まずに捨てる（デーモンのメモリを守るため。最後の答えはこれより十分短い）。 */
export const MAX_LINE = 16 * 1024 * 1024;
/** JSON の行が1つも無いときの理由・整形した JSON の読み取りに使う、出力の先頭の上限（文字数）。 */
const RAW_HEAD = 256 * 1024;

/** 1行の JSON オブジェクト（JSON でない行・壊れた行は undefined）。 */
function jsonObject(line: string): Record<string, unknown> | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * エージェントの標準出力を、届くたびに行ごとに読む（PBI-62）。出力の全体は持たず、最後の答えの読み取りに要るものだけを
 * 持つ（途中の出来事が大きくても、デーモンのメモリが出力の大きさに比例して増えないように）。
 */
export abstract class OutcomeReader {
  private partial = "";
  private skipping = false;
  /** JSON でない出力の先頭（JSON の行が無いときの理由・整形した JSON の読み取りに使う）。 */
  protected rawHead = "";
  protected rawOverflow = false;
  protected objects = 0;
  /**
   * エージェントのセッションの ID（Claude Code の session_id・Codex の thread_id。PBI-66）。最初に出たものを持つ
   * （サブエージェントの ID ではなく、再開に使う ID）。
   */
  sessionId: string | undefined;

  constructor(private readonly maxLine = MAX_LINE) {}

  /** いま持っている、改行が届いていない行の長さ（メモリの上限を確かめるため）。 */
  get buffered(): number {
    return this.partial.length;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.keepRaw(chunk);
    let rest = chunk;
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const piece = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (this.skipping) this.skipping = false;
      else if (this.partial.length + piece.length <= this.maxLine) this.line(this.partial + piece);
      this.partial = "";
    }
    if (this.skipping) return;
    if (this.partial.length + rest.length > this.maxLine) {
      // 長すぎる行は、改行まで読み飛ばす
      this.partial = "";
      this.skipping = true;
      return;
    }
    this.partial += rest;
  }

  /** 出力の終わり。最後の行を読んでから、結果を返す。 */
  finish(exitCode: number, stderr = ""): AgentOutcome {
    if (this.partial && !this.skipping) this.line(this.partial);
    this.partial = "";
    return this.outcome(exitCode, stderr);
  }

  private keepRaw(chunk: string): void {
    if (this.rawOverflow) return;
    const room = RAW_HEAD - this.rawHead.length;
    if (chunk.length > room) {
      this.rawHead += chunk.slice(0, room);
      this.rawOverflow = true;
    } else {
      this.rawHead += chunk;
    }
  }

  private line(line: string): void {
    const event = jsonObject(line);
    if (!event) return;
    this.objects++;
    this.event(event);
  }

  protected abstract event(event: Record<string, unknown>): void;
  protected abstract outcome(exitCode: number, stderr: string): AgentOutcome;
}

/**
 * `claude -p --output-format stream-json --verbose`（PBI-62）か `--output-format json` の結果を読む。
 * 最後の result の出来事を読む。json の形（type の無い1つのオブジェクト・整形された複数行）も読む（前に警告などが
 * 出ていても読めるように）。途中の出来事だけで result が無ければ（途中で落ちた）、失敗にする。
 * バックグラウンドの処理の通知が来るたびに番が進み、result は何回も出る（PBI-154）。本文は、prefer があればそれを含む最後の
 * result から読む（最終の答えの後の通知への返答で、本文が置き換わらないように）。使用量は、最後の result の modelUsage
 * （実行の全体。サブエージェントの分も含む）から読み、無ければ各 result の usage（その番の分）を合計する。
 * セッションを再開・複製した実行（resumed）は、modelUsage に前の実行の分も入るので、各 result の usage を合計する。
 */
export class ClaudeOutcomeReader extends OutcomeReader {
  private result: Record<string, unknown> | undefined;
  /** prefer を含む最後の result の文。 */
  private preferred: string | undefined;
  /** 各 result の usage の合計。 */
  private summed: TokenUsage = { ...ZERO };

  private readonly prefer: string | undefined;
  private readonly resumed: boolean;

  constructor(maxLine = MAX_LINE, options: { prefer?: string; resumed?: boolean } = {}) {
    super(maxLine);
    this.prefer = options.prefer;
    this.resumed = options.resumed === true;
  }
  /** 最後の行の JSON が type の無いオブジェクトなら、それ（json の形）。 */
  private untyped: Record<string, unknown> | undefined;
  /** 最後のエージェントの発言（result が無いときの理由。認証の失敗の文など）。 */
  private assistantText = "";

  protected event(event: Record<string, unknown>): void {
    this.untyped = event.type === undefined ? event : undefined;
    if (!this.sessionId && typeof event.session_id === "string" && event.session_id) {
      this.sessionId = event.session_id;
    }
    if (event.type === "result") {
      this.result = event;
      const u = claudeUsage(event.usage);
      this.summed = {
        input: this.summed.input + u.input,
        cacheRead: this.summed.cacheRead + u.cacheRead,
        cacheWrite: this.summed.cacheWrite + u.cacheWrite,
        output: this.summed.output + u.output,
      };
      if (this.prefer && typeof event.result === "string" && event.result.includes(this.prefer)) {
        this.preferred = event.result;
      }
    } else if (event.type === "assistant") {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      const text = content
        .map((c) => (c && typeof c === "object" && c.type === "text" ? String(c.text ?? "") : ""))
        .join("")
        .trim();
      if (text) this.assistantText = text;
    }
  }

  private final(): Record<string, unknown> | undefined {
    if (this.result) return this.result;
    if (this.untyped) return this.untyped;
    if (this.objects > 0 || this.rawOverflow) return undefined;
    // 整形された（複数行の）JSON
    return jsonObject(this.rawHead);
  }

  protected outcome(exitCode: number, stderr: string): AgentOutcome {
    const json = this.final();
    if (!json) {
      // 途中の出来事の JSON の行そのものは、理由にしない（長く、読みにくいため。全文はセッションログにある）
      const raw = this.objects > 0 ? "" : this.rawHead;
      const message = (stderr || this.assistantText || raw || `exit code ${exitCode}`)
        .trim()
        .slice(0, 2000);
      return { kind: "failed", reason: classifyFailure(message), message };
    }
    const usage =
      (this.resumed ? undefined : modelUsageTotal(json.modelUsage)) ??
      (json === this.result ? this.summed : claudeUsage(json.usage));
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
    return { kind: "completed", output: this.preferred ?? result, usage };
  }
}

/** Claude Code の result の usage（その番の分）。 */
function claudeUsage(value: unknown): TokenUsage {
  const u = (value ?? {}) as Record<string, unknown>;
  return {
    input: nonNegInt(u.input_tokens),
    cacheRead: nonNegInt(u.cache_read_input_tokens),
    cacheWrite: nonNegInt(u.cache_creation_input_tokens),
    output: nonNegInt(u.output_tokens),
  };
}

/** Claude Code の result の modelUsage（実行の全体の、モデルごとの使用量）の合計。読めるモデルが無ければ undefined。 */
function modelUsageTotal(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const models = Object.values(value).filter(
    (m): m is Record<string, unknown> => Boolean(m) && typeof m === "object" && !Array.isArray(m),
  );
  if (models.length === 0) return undefined;
  return models.reduce<TokenUsage>(
    (sum, m) => ({
      input: sum.input + nonNegInt(m.inputTokens),
      cacheRead: sum.cacheRead + nonNegInt(m.cacheReadInputTokens),
      cacheWrite: sum.cacheWrite + nonNegInt(m.cacheCreationInputTokens),
      output: sum.output + nonNegInt(m.outputTokens),
    }),
    { ...ZERO },
  );
}

/**
 * `codex exec --json` のJSONLを読む。turn.completed の usage を合計する。
 * Codexの cached_input_tokens は input_tokens の内数なので、入力からは差し引いて二重計上を防ぐ。
 */
export class CodexOutcomeReader extends OutcomeReader {
  private usage: TokenUsage = { ...ZERO };
  private output = "";
  private errorMessage = "";

  protected event(event: Record<string, unknown>): void {
    if (event.type === "thread.started") {
      if (!this.sessionId && typeof event.thread_id === "string" && event.thread_id) {
        this.sessionId = event.thread_id;
      }
    } else if (event.type === "turn.completed") {
      const u = (event.usage ?? {}) as Record<string, unknown>;
      const input = nonNegInt(u.input_tokens);
      const cached = Math.min(nonNegInt(u.cached_input_tokens), input);
      this.usage = {
        input: this.usage.input + (input - cached),
        cacheRead: this.usage.cacheRead + cached,
        cacheWrite: this.usage.cacheWrite + nonNegInt(u.cache_write_input_tokens),
        output: this.usage.output + nonNegInt(u.output_tokens),
      };
    } else if (event.type === "item.completed") {
      const item = (event.item ?? {}) as Record<string, unknown>;
      const kind = item.type ?? item.item_type;
      if (kind === "agent_message" && typeof item.text === "string") this.output = item.text;
    } else if (event.type === "turn.failed" || event.type === "error") {
      const err = event.error as Record<string, unknown> | undefined;
      const message = typeof err?.message === "string" ? err.message : event.message;
      if (typeof message === "string") this.errorMessage = message;
    }
  }

  protected outcome(exitCode: number, stderr: string): AgentOutcome {
    if (this.errorMessage || exitCode !== 0) {
      const message = (this.errorMessage || stderr || `exit code ${exitCode}`)
        .trim()
        .slice(0, 2000);
      return { kind: "failed", reason: classifyFailure(message), message, usage: this.usage };
    }
    return { kind: "completed", output: this.output, usage: this.usage };
  }
}

export function parseClaudeResult(stdout: string, exitCode: number, stderr = ""): AgentOutcome {
  const reader = new ClaudeOutcomeReader();
  reader.push(stdout);
  return reader.finish(exitCode, stderr);
}

export function parseCodexEvents(stdout: string, exitCode: number, stderr = ""): AgentOutcome {
  const reader = new CodexOutcomeReader();
  reader.push(stdout);
  return reader.finish(exitCode, stderr);
}
