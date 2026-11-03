import { type DaemonText, message, type TokenUsage } from "@sacty/core";

export type FailureReason = "usage_limit" | "auth" | "error";

/** モデルごとの使用量（Claude Code の result の modelUsage。サブエージェントのモデルも入る。PBI-301）。 */
export type ModelUsage = { model: string; usage: TokenUsage };

/**
 * エージェントの CLI が報告した実行の費用と、モデルごとの使用量（PBI-301）。どちらも、報告があったときだけ持つ。
 * - reportedCostUsd：CLI が報告した実行の費用（Claude Code の result の total_cost_usd。実行の全体）。
 * - modelUsages：モデルごとの使用量。報告が無いとき、モデルごとの単価で換算するのに使う。
 * - unreportedUsage：報告した費用に入っていない使用量（最後の result の後に始まった番など。換算して足す）。
 */
export type CostReport = {
  reportedCostUsd?: number;
  modelUsages?: ModelUsage[];
  unreportedUsage?: TokenUsage;
};

export type AgentOutcome =
  | ({ kind: "completed"; output: string; usage: TokenUsage } & CostReport)
  | ({
      kind: "failed";
      reason: FailureReason;
      /** エージェントや外から来た文はそのまま、sacty の文言はコードと引数（PBI-11）。 */
      message: DaemonText;
      usage?: TokenUsage;
      /**
       * 実行の全体の使用量を読めなかった（PBI-281）。時間切れ・強制終了などで、最後の結果（使用量の合計）が出る前に
       * 止まった実行。usage があれば、読めた分（下限）で、無ければ何も読めなかった。
       */
      costUnknown?: true;
    } & CostReport);

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

  /** 出力の JSON の出来事が1つでも届いたか（エージェントが動き出したか。PBI-281）。 */
  get started(): boolean {
    return this.objects > 0;
  }

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
 * modelUsage は、項目ごとに各 result の usage の合計と大きいほうを取る（実行の全体が各番の合計より小さいことはない。
 * キーの名前が変わって読めなくても、0 にしない。PR #213 レビュー指摘）。
 * 最後の result が空（空白だけ）でも、その前に中身のある result があれば、その最後のものを答えにする（PBI-290。バックグラウンドの
 * 処理の完了通知に起きた番が、本文を出さずに終わると、空の result が最後に来る）。中身のある result がどこにも無ければ、
 * 空の成果物にせず、失敗にする（run.emptyResult）。
 */
export class ClaudeOutcomeReader extends OutcomeReader {
  private result: Record<string, unknown> | undefined;
  /** prefer を含む最後の result の文。 */
  private preferred: string | undefined;
  /** 中身のある（空白だけでない）最後の成功の result の文（PBI-290）。最後の result が空のときの代わり。 */
  private content: string | undefined;
  /** 各 result の usage の合計。 */
  private summed: TokenUsage = { ...ZERO };
  /** result の数。 */
  private results = 0;
  /** 答えの読み方の知らせ（prefer に当たらず最後の result に戻ったとき。PR #213 レビュー指摘）。 */
  private noticeText: string | undefined;
  /** 最後の result が空で、その前の中身のある result を答えにした知らせ（PBI-290）。 */
  private emptyNoticeText: string | undefined;
  /**
   * 発言（assistant）ごとの使用量（PBI-281）。最後の result の後に始まった番や、result が出る前に止まった実行の、読めた分の
   * 使用量に使う。同じ発言の内容ごとの出来事は、同じ id・同じ使用量を繰り返すので、id ごとに1つにする。settled は、
   * result が出て、その使用量に入った発言（二重に数えない）。メモリを守るため、id の長さと件数に上限がある。
   */
  private readonly messages = new Map<string, { usage: TokenUsage; settled: boolean }>();
  /** 上限のために、読まなかった発言がある（読めた分は下限）。 */
  private messagesTruncated = false;

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
      this.results++;
      // ここまでの発言の使用量は、この result の usage に入った
      for (const message of this.messages.values()) message.settled = true;
      // 上限で読まなかった発言があっても、ここまでの分は result の usage に入っている（この後の分だけを数え直す）
      this.messagesTruncated = false;
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
      if (
        event.is_error !== true &&
        typeof event.result === "string" &&
        event.result.trim() !== ""
      ) {
        this.content = event.result;
      }
    } else if (event.type === "assistant") {
      this.keepMessageUsage(event.message);
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      const text = content
        .map((c) => (c && typeof c === "object" && c.type === "text" ? String(c.text ?? "") : ""))
        .join("")
        .trim();
      if (text) this.assistantText = text;
    }
  }

  /** 答えの読み方の知らせ（finish の後。デーモンのログとセッションログに残す）。 */
  get notice(): string | undefined {
    const notices = [this.noticeText, this.emptyNoticeText].filter(Boolean);
    return notices.length > 0 ? notices.join(" / ") : undefined;
  }

  private keepMessageUsage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const { id, usage } = message as { id?: unknown; usage?: unknown };
    if (typeof id !== "string" || !id || !usage || typeof usage !== "object") return;
    if (id.length > MESSAGE_ID_MAX) {
      this.messagesTruncated = true;
      return;
    }
    const next = claudeUsage(usage);
    const previous = this.messages.get(id);
    if (previous) {
      // 出力のトークン数は、発言の途中の出来事ほど小さい値で出ることがある。大きいほうを取る（result に入った発言は触らない）
      if (!previous.settled) previous.usage = larger(previous.usage, next);
      return;
    }
    if (this.messages.size >= MESSAGE_KEEP_MAX) {
      this.messagesTruncated = true;
      return;
    }
    this.messages.set(id, { usage: next, settled: false });
  }

  /**
   * 最後の result の後に始まった発言（result が無ければ、すべての発言）の使用量の合計（PBI-281）。サブエージェントの内側の
   * 使用量と、発言の途中の出力のトークン数は読めないので、実際より小さい（下限）。そのような発言が無ければ undefined。
   */
  private unsettledUsage(): TokenUsage | undefined {
    let sum: TokenUsage | undefined;
    for (const { usage, settled } of this.messages.values()) {
      if (settled) continue;
      sum = sum
        ? {
            input: sum.input + usage.input,
            cacheRead: sum.cacheRead + usage.cacheRead,
            cacheWrite: sum.cacheWrite + usage.cacheWrite,
            output: sum.output + usage.output,
          }
        : { ...usage };
    }
    return sum;
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
      // 出来事が届いていたのに result が無い（時間切れ・強制終了など）なら、使った分の全体は分からない。読めた分は残す
      // （PBI-281）。出来事が1つも届かなかった（起動できなかった）なら、何も使っていない
      const usage = this.unsettledUsage();
      return {
        kind: "failed",
        reason: classifyFailure(message),
        message,
        ...(usage ? { usage } : {}),
        ...(this.objects > 0 ? { costUnknown: true as const } : {}),
      };
    }
    const turns = json === this.result ? this.summed : claudeUsage(json.usage);
    const total = this.resumed ? undefined : modelUsageTotal(json.modelUsage);
    const usage = total ? larger(total, turns) : turns;
    // CLI が報告した費用とモデルごとの使用量（PBI-301）。セッションを再開・複製した実行は、前の実行の分も入るので使わない
    const report: CostReport = this.resumed ? {} : costReport(json);
    if (this.prefer && this.preferred === undefined && this.results >= 2) {
      this.noticeText = `result が ${this.results} 回出ましたが、${this.prefer} を含むものが無いので、最後の result を答えにしました（使用量：${total ? "modelUsage" : "各 result の usage の合計"}）`;
    }
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
      // 最後の result の後に始まった番があれば（その後に強制終了・時間切れなど）、その分は result の usage に入っていない。
      // 読めた分を足し、全体は不明にする（PBI-281）
      const after = this.unsettledUsage();
      if (after || this.messagesTruncated) {
        return {
          kind: "failed",
          reason: classifyFailure(message),
          message,
          ...report,
          ...(after ? { unreportedUsage: after } : {}),
          usage: after
            ? {
                input: usage.input + after.input,
                cacheRead: usage.cacheRead + after.cacheRead,
                cacheWrite: usage.cacheWrite + after.cacheWrite,
                output: usage.output + after.output,
              }
            : usage,
          costUnknown: true,
        };
      }
      return { kind: "failed", reason: classifyFailure(message), message, usage, ...report };
    }
    // 最後の result が空なら、その前の中身のある result を使う（PBI-290）。json の形（result が1つ）では、前の result は無い
    const usedEarlier = result.trim() === "" && json === this.result && this.content !== undefined;
    const output = this.preferred ?? (usedEarlier ? (this.content ?? result) : result);
    if (output.trim() === "") {
      // 中身のある result がどこにも無い。空の成果物を提出せず、失敗にする（PBI-290）。使った分は残す
      const after = this.unsettledUsage();
      const unknown = Boolean(after) || this.messagesTruncated;
      return {
        kind: "failed",
        reason: "error",
        message: message("run.emptyResult"),
        ...report,
        ...(after ? { unreportedUsage: after } : {}),
        usage: after
          ? {
              input: usage.input + after.input,
              cacheRead: usage.cacheRead + after.cacheRead,
              cacheWrite: usage.cacheWrite + after.cacheWrite,
              output: usage.output + after.output,
            }
          : usage,
        ...(unknown ? { costUnknown: true as const } : {}),
      };
    }
    if (usedEarlier && this.preferred === undefined) {
      this.emptyNoticeText = `最後の result が空だったので、その前の中身のある result を答えにしました（result は ${this.results} 回）`;
    }
    return { kind: "completed", output, usage, ...report };
  }
}

/** 発言の id の長さと、覚える件数の上限（PBI-281。コンテナから届く値なので、メモリを守る）。 */
const MESSAGE_ID_MAX = 256;
const MESSAGE_KEEP_MAX = 4096;

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

/** 項目ごとに大きいほう。 */
function larger(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(a.input, b.input),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    output: Math.max(a.output, b.output),
  };
}

/**
 * Claude Code の result が報告した、実行の費用（total_cost_usd）とモデルごとの使用量（modelUsage）。読めないものは持たない
 * （PBI-301）。費用は 0 以上の有限の数だけ。0 の報告は、使用量があるのに 0 なら報告とせず、換算に任せる（呼び出し側で判断する）。
 */
function costReport(json: Record<string, unknown>): CostReport {
  const cost = json.total_cost_usd;
  const reported =
    typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  const modelUsages = modelUsageList(json.modelUsage);
  return {
    ...(reported !== undefined ? { reportedCostUsd: reported } : {}),
    ...(modelUsages.length > 0 ? { modelUsages } : {}),
  };
}

/** modelUsage のモデルごとの使用量（読める項目を持つモデルだけ）。 */
function modelUsageList(value: unknown): ModelUsage[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([model, m]) =>
    m &&
    typeof m === "object" &&
    !Array.isArray(m) &&
    MODEL_USAGE_KEYS.some((k) => typeof (m as Record<string, unknown>)[k] === "number")
      ? [
          {
            model,
            usage: {
              input: nonNegInt((m as Record<string, unknown>).inputTokens),
              cacheRead: nonNegInt((m as Record<string, unknown>).cacheReadInputTokens),
              cacheWrite: nonNegInt((m as Record<string, unknown>).cacheCreationInputTokens),
              output: nonNegInt((m as Record<string, unknown>).outputTokens),
            },
          },
        ]
      : [],
  );
}

const MODEL_USAGE_KEYS = [
  "inputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
];

/**
 * Claude Code の result の modelUsage（実行の全体の、モデルごとの使用量）の合計。読める項目を持つモデルが無ければ undefined
 * （キーの名前が変わったときに、全部 0 の合計を返さない）。
 */
function modelUsageTotal(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const models = Object.values(value).filter(
    (m): m is Record<string, unknown> =>
      Boolean(m) &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      MODEL_USAGE_KEYS.some((k) => typeof (m as Record<string, unknown>)[k] === "number"),
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
  /** 始まった番の数と、終わった番（turn.completed。使用量が出る）の数（PBI-281）。 */
  private turnsStarted = 0;
  private turnsCompleted = 0;
  private output = "";
  private errorMessage = "";

  protected event(event: Record<string, unknown>): void {
    if (event.type === "thread.started") {
      if (!this.sessionId && typeof event.thread_id === "string" && event.thread_id) {
        this.sessionId = event.thread_id;
      }
    } else if (event.type === "turn.started") {
      this.turnsStarted++;
    } else if (event.type === "turn.completed") {
      this.turnsCompleted++;
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
      // 空の発言は、その前の中身のある発言を置き換えない（PBI-290）
      if (kind === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
        this.output = item.text;
      }
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
      // Codex は番が終わるまで使用量を出さない。終わっていない番（時間切れ・失敗した番）の分は読めない（PBI-281）
      const unfinished = this.turnsStarted > this.turnsCompleted;
      return {
        kind: "failed",
        reason: classifyFailure(message),
        message,
        // 読めた使用量が無いのに 0 を入れない（不明を 0 と見せない）
        ...(unfinished && this.turnsCompleted === 0 ? {} : { usage: this.usage }),
        ...(unfinished ? { costUnknown: true as const } : {}),
      };
    }
    if (this.output.trim() === "") {
      // 中身のある発言がどこにも無い。空の成果物を提出せず、失敗にする（PBI-290）
      const unfinished = this.turnsStarted > this.turnsCompleted;
      return {
        kind: "failed",
        reason: "error",
        message: message("run.emptyResult"),
        ...(unfinished && this.turnsCompleted === 0 ? {} : { usage: this.usage }),
        ...(unfinished ? { costUnknown: true as const } : {}),
      };
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
