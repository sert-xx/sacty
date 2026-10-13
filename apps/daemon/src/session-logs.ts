import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DaemonText } from "@sacty/core";
import type { AgentOutcome } from "./agents/parse.js";
import { redact, redactText } from "./agents/redact.js";

/**
 * エージェントの実行ごとのセッションログ（PBI-62）。途中の出来事（エージェントの標準出力の JSONL）と標準エラー出力を、
 * sacty のデータの場所の下の runs/<タスク>/<実行>.jsonl・.stderr.log に残す（作業履歴には入れない。大きいため）。
 * 秘密情報は書く前に伏せ、伏せた後の大きさで上限を超えたら切り詰める（切り詰めたことを残す）。
 */

/** 1実行あたりの上限（途中の出来事 18MB・標準エラー出力 2MB。合わせて 20MB）。 */
export const SESSION_LOG_LIMITS = { events: 18 * 1024 * 1024, stderr: 2 * 1024 * 1024 };

export type SessionLogFile = "events" | "stderr";

const EXTENSIONS: Record<SessionLogFile, string> = { events: ".jsonl", stderr: ".stderr.log" };

/** タスク・実行の ID として受け付ける形（パスに使うので、区切りや「..」を含むものは受け付けない）。 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validLogId(id: string): boolean {
  return ID.test(id);
}

/** 切り詰めたときに、途中の出来事の末尾に足す行の type。 */
export const TRUNCATED_EVENT = "sacty.truncated";

export type SessionLogMeta = {
  runId: string;
  taskId: string;
  /** 何として実行したか（工程・orchestrator・guardian・chat・export など）。 */
  role: string;
  agentId: string;
  runtime: string;
  authMode: string;
  model?: string;
  startedAt: string;
  /** 無ければ、終わりを記録できなかった（デーモンが落ちたなど）。 */
  finishedAt?: string;
  outcome?: { kind: "completed" } | { kind: "failed"; reason: string; message: DaemonText };
  /** 上限で切り詰めたファイルと、捨てた大きさ（バイト）。 */
  truncated?: Partial<Record<SessionLogFile, number>>;
  limits: Record<SessionLogFile, number>;
};

/** 実行器が、出力を受け取るたびに渡す先。 */
export interface SessionLogSink {
  stdout(text: string): void;
  stderr(text: string): void;
  /** 実行の途中で分かった秘密情報（コンテナで更新された認証ファイルの値など）。 */
  addSecrets(values: readonly string[]): void;
}

/** 秘密情報と、JSON の文字列の中に書かれたときの形（エスケープされた形）。長い順。 */
function secretForms(secrets: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    forms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * 少しずつ届く出力から、秘密情報を伏せる。届いた分の末尾（一番長い秘密情報より1文字短い分）は書かずに持っておき、
 * 次に届いた分とつなげてから伏せる（値が、届いた分・行・JSON の出来事の境目をまたいでも伏せるため）。
 */
export class StreamRedactor {
  private pending = "";

  constructor(private readonly secrets: () => readonly string[]) {}

  push(text: string): string {
    const forms = secretForms(this.secrets());
    const longest = forms[0]?.length ?? 0;
    const redacted = redact(this.pending + text, forms);
    const keep = Math.min(redacted.length, Math.max(0, longest - 1));
    this.pending = redacted.slice(redacted.length - keep);
    return redacted.slice(0, redacted.length - keep);
  }

  flush(): string {
    const rest = redact(this.pending, secretForms(this.secrets()));
    this.pending = "";
    return rest;
  }
}

/**
 * 上限まで書くファイル。超えたら、行の切れ目（無ければ文字の切れ目）で切り、捨てた大きさを数える。
 * lines（途中の出来事の JSONL）なら、行の頭から上限をまたぐ行は、途中まで書かずに捨てる（壊れた JSON の行を残さない）。
 */
class CappedFile {
  private fd: number | undefined;
  written = 0;
  dropped = 0;
  private endsWithNewline = true;

  constructor(
    readonly path: string,
    private readonly limit: number,
    private readonly lines: boolean,
    private readonly onError: (error: unknown) => void,
  ) {
    try {
      this.fd = openSync(path, "a", 0o600);
    } catch (error) {
      onError(error);
    }
  }

  write(text: string): void {
    if (!text) return;
    const buf = Buffer.from(text, "utf8");
    if (this.dropped > 0) {
      this.dropped += buf.length;
      return;
    }
    const room = this.limit - this.written;
    if (buf.length <= room) {
      this.put(buf);
      return;
    }
    let cut = room <= 0 ? 0 : buf.subarray(0, room).lastIndexOf(0x0a) + 1;
    if (cut <= 0 && this.lines && this.endsWithNewline) cut = 0;
    else if (cut <= 0) {
      cut = Math.max(0, room);
      // UTF-8 の1文字の途中で切らない
      while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
    }
    this.put(buf.subarray(0, cut));
    this.dropped += buf.length - cut;
    // 捨てた大きさが 0 になる切り方は無い（room < buf.length）。0 バイトだけ超えた、は起きない
  }

  /** 切り詰めの目印を足して閉じる。 */
  close(marker: (dropped: number) => string): void {
    if (this.dropped > 0 && this.fd !== undefined) {
      const text = `${this.endsWithNewline ? "" : "\n"}${marker(this.dropped)}`;
      this.raw(Buffer.from(text, "utf8"));
    }
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // 閉じられなくても、書いた分は残る
      }
      this.fd = undefined;
    }
  }

  private put(buf: Buffer): void {
    if (buf.length === 0) return;
    this.raw(buf);
    this.written += buf.length;
  }

  private raw(buf: Buffer): void {
    if (this.fd === undefined || buf.length === 0) return;
    try {
      writeSync(this.fd, buf);
      this.endsWithNewline = buf[buf.length - 1] === 0x0a;
    } catch (error) {
      this.onError(error);
      try {
        closeSync(this.fd);
      } catch {
        // 何もしない
      }
      this.fd = undefined;
    }
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** 1回の実行のセッションログ。書き込みに失敗しても、実行は止めない（ログを残せなかったことをデーモンのログに出す）。 */
export class SessionLog implements SessionLogSink {
  private readonly extra = new Set<string>();
  private readonly files: Record<SessionLogFile, CappedFile>;
  private readonly redactors: Record<SessionLogFile, StreamRedactor>;
  /** 書き始めた時点の秘密情報の数（後から増えたら、閉じるときに全体を伏せ直す）。 */
  private secretsAtFirstWrite: number | undefined;
  private warned = false;
  private closed = false;

  constructor(
    private readonly base: string,
    private readonly meta: SessionLogMeta,
    private readonly secrets: () => readonly string[],
    limits: Record<SessionLogFile, number>,
  ) {
    const onError = (error: unknown) => this.warn(error);
    this.files = {
      events: new CappedFile(`${base}${EXTENSIONS.events}`, limits.events, true, onError),
      stderr: new CappedFile(`${base}${EXTENSIONS.stderr}`, limits.stderr, false, onError),
    };
    const all = () => this.allSecrets();
    this.redactors = { events: new StreamRedactor(all), stderr: new StreamRedactor(all) };
    this.writeMeta();
  }

  stdout(text: string): void {
    this.write("events", text);
  }

  stderr(text: string): void {
    this.write("stderr", text);
  }

  addSecrets(values: readonly string[]): void {
    for (const value of values) if (value) this.extra.add(value);
  }

  /** 実行の結果を残して閉じる（結果の文は、伏せた後のもの）。2回目以降は何もしない。 */
  close(outcome: AgentOutcome): void {
    if (this.closed) return;
    this.closed = true;
    for (const file of ["events", "stderr"] as const) {
      this.files[file].write(this.redactors[file].flush());
    }
    const limits = this.meta.limits;
    this.files.events.close(
      (dropped) =>
        `${JSON.stringify({ type: TRUNCATED_EVENT, limitBytes: limits.events, droppedBytes: dropped })}\n`,
    );
    this.files.stderr.close(
      (dropped) =>
        `[sacty] truncated: the log exceeded ${limits.stderr} bytes; ${dropped} bytes were dropped.\n`,
    );
    // 書き始めた後に分かった秘密情報（コンテナで更新されたトークンなど）は、書いたファイル全体から伏せ直す
    const all = this.allSecrets();
    if (this.secretsAtFirstWrite !== undefined && all.length > this.secretsAtFirstWrite) {
      const forms = secretForms(all);
      for (const file of Object.values(this.files)) {
        try {
          if (!existsSync(file.path)) continue;
          const text = readFileSync(file.path, "utf8");
          const redacted = redact(text, forms);
          if (redacted !== text) writeFileSync(file.path, redacted, { mode: 0o600 });
        } catch (error) {
          this.warn(error);
        }
      }
    }
    const truncated: Partial<Record<SessionLogFile, number>> = {};
    for (const file of ["events", "stderr"] as const) {
      if (this.files[file].dropped > 0) truncated[file] = this.files[file].dropped;
    }
    this.meta.finishedAt = new Date().toISOString();
    this.meta.outcome =
      outcome.kind === "completed"
        ? { kind: "completed" }
        : {
            kind: "failed",
            reason: outcome.reason,
            message: redactText(outcome.message, secretForms(all)),
          };
    if (Object.keys(truncated).length > 0) this.meta.truncated = truncated;
    this.writeMeta();
  }

  private write(file: SessionLogFile, text: string): void {
    if (this.closed || !text) return;
    this.secretsAtFirstWrite ??= this.allSecrets().length;
    this.files[file].write(this.redactors[file].push(text));
  }

  private allSecrets(): string[] {
    return [...new Set([...this.secrets(), ...this.extra])].filter((s) => s.length > 0);
  }

  private writeMeta(): void {
    try {
      writeJsonAtomic(`${this.base}.meta.json`, this.meta);
    } catch (error) {
      this.warn(error);
    }
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `[daemon] セッションログを残せませんでした（${this.meta.runId}）：`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** 何も残さないセッションログ（ログの場所を用意できないとき）。 */
const NOOP_LOG = {
  stdout() {},
  stderr() {},
  addSecrets() {},
  close() {},
} satisfies SessionLogSink & Pick<SessionLog, "close">;

export type SessionLogHandle = SessionLogSink & Pick<SessionLog, "close">;

export type StoredSessionLog = {
  meta: SessionLogMeta;
  events: string;
  stderr: string;
};

/** セッションログの置き場所（SACTY_HOME/runs）。 */
export class SessionLogStore {
  constructor(
    private readonly root: string,
    private readonly limits: Record<SessionLogFile, number> = SESSION_LOG_LIMITS,
  ) {}

  /** 実行の始めに開く。secrets は、実行に渡した秘密情報（呼ぶ側が実行の間に足していく配列でよい）。 */
  open(
    info: Omit<SessionLogMeta, "startedAt" | "limits" | "finishedAt" | "outcome" | "truncated">,
    secrets: () => readonly string[],
  ): SessionLogHandle {
    if (!validLogId(info.taskId) || !validLogId(info.runId)) return NOOP_LOG;
    const dir = join(this.root, info.taskId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.warn(
        `[daemon] セッションログの場所を用意できませんでした（${dir}）：`,
        error instanceof Error ? error.message : error,
      );
      return NOOP_LOG;
    }
    return new SessionLog(
      join(dir, info.runId),
      { ...info, startedAt: new Date().toISOString(), limits: this.limits },
      secrets,
      this.limits,
    );
  }

  /** 生のファイルの場所。ID の形が正しくなければ undefined（ファイルの有無は見ない）。 */
  path(taskId: string, runId: string, file: SessionLogFile): string | undefined {
    if (!validLogId(taskId) || !validLogId(runId)) return undefined;
    return join(this.root, taskId, `${runId}${EXTENSIONS[file]}`);
  }

  /** 実行のログ。記録が無ければ undefined（ログを残す前の実行・エージェントを起動する前に止まった実行など）。 */
  read(taskId: string, runId: string): StoredSessionLog | undefined {
    if (!validLogId(taskId) || !validLogId(runId)) return undefined;
    const base = join(this.root, taskId, runId);
    let meta: SessionLogMeta;
    try {
      meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8")) as SessionLogMeta;
    } catch {
      return undefined;
    }
    const text = (file: SessionLogFile) => {
      try {
        return readFileSync(`${base}${EXTENSIONS[file]}`, "utf8");
      } catch {
        return "";
      }
    };
    return { meta, events: text("events"), stderr: text("stderr") };
  }
}
