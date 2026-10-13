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
 * 秘密情報は書く前に伏せ、伏せた後の大きさで上限を超えたら、先頭と末尾を残して間を捨てる（捨てたことを残す）。
 * エラーで止まった原因や最後の result の行は末尾に出るので、末尾も残す（監査と原因の調査のため）。
 */

const MB = 1024 * 1024;

/** 残す先頭と末尾の大きさ（バイト）。 */
export type HeadTail = { head: number; tail: number };

/**
 * 1実行あたりの上限。途中の出来事は先頭 15MB・末尾 3MB、標準エラー出力は先頭 1MB・末尾 1MB（合わせて 20MB）。
 */
export const SESSION_LOG_LIMITS: Record<SessionLogFile, HeadTail> = {
  events: { head: 15 * MB, tail: 3 * MB },
  stderr: { head: MB, tail: MB },
};

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
  /** 上限で間を省いたファイルと、省いた大きさ（バイト）・行数（改行の数）。 */
  truncated?: Partial<Record<SessionLogFile, { droppedBytes: number; droppedLines: number }>>;
  limits: Record<SessionLogFile, HeadTail>;
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

const NEWLINE = 0x0a;

function newlines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(NEWLINE); i >= 0; i = buf.indexOf(NEWLINE, i + 1)) n++;
  return n;
}

/** UTF-8 の1文字の途中で切らない位置（at から前に戻す）。 */
function charStartBefore(buf: Buffer, at: number): number {
  let cut = Math.max(0, Math.min(at, buf.length));
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return cut;
}

/**
 * 先頭と末尾を残すファイル。先頭の上限までは書きながらファイルに足し、超えた後は末尾の上限の分だけをメモリに持つ
 * （全体は持たない）。閉じるときに、省いたことの目印と末尾を書く。
 * lines（途中の出来事の JSONL）なら、先頭は行の切れ目で終え、末尾は行の頭から始める（壊れた JSON の行を残さない）。
 * 先頭の途中の行は、改行が届くまで書かずに持つ。
 */
class HeadTailFile {
  private fd: number | undefined;
  private written = 0;
  private headFull = false;
  private endsWithNewline = true;
  /** lines で、まだ改行が届いていない先頭の行。 */
  private pending: Buffer = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailSize = 0;
  private evictedBytes = 0;
  private evictedLines = 0;
  /** 末尾から押し出した最後のバイト（末尾が行の頭から始まっているかを知るため）。 */
  private lastEvicted: number | undefined;
  /** 閉じた後の、省いた大きさ・行数。 */
  dropped = { bytes: 0, lines: 0 };

  constructor(
    readonly path: string,
    private readonly limits: HeadTail,
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
    if (this.headFull) {
      this.toTail(buf);
      return;
    }
    const room = this.limits.head - this.written;
    if (this.lines) {
      const data = this.pending.length > 0 ? Buffer.concat([this.pending, buf]) : buf;
      const complete = data.lastIndexOf(NEWLINE) + 1;
      if (complete <= room) {
        this.put(data.subarray(0, complete));
        this.pending = Buffer.from(data.subarray(complete));
        // 終わっていない行が、先頭に収まらないなら、その行からは末尾に回す
        if (this.pending.length > this.limits.head - this.written) {
          this.headFull = true;
          const rest = this.pending;
          this.pending = Buffer.alloc(0);
          this.toTail(rest);
        }
        return;
      }
      const cut = room > 0 ? data.subarray(0, room).lastIndexOf(NEWLINE) + 1 : 0;
      this.put(data.subarray(0, cut));
      this.pending = Buffer.alloc(0);
      this.headFull = true;
      this.toTail(data.subarray(cut));
      return;
    }
    if (buf.length <= room) {
      this.put(buf);
      return;
    }
    const cut = charStartBefore(buf, room);
    this.put(buf.subarray(0, cut));
    this.headFull = true;
    this.toTail(buf.subarray(cut));
  }

  /** 省いたことの目印（省いた大きさ・行数から作る）を間に入れ、末尾を書いて閉じる。 */
  close(marker: (droppedBytes: number, droppedLines: number) => string): void {
    if (this.pending.length > 0) this.put(this.pending); // 改行で終わらない最後の行
    this.pending = Buffer.alloc(0);
    if (this.headFull) {
      const tail = Buffer.concat(this.tail);
      if (this.evictedBytes === 0) {
        this.raw(tail); // 省いたものは無い（先頭と末尾がつながっている）
      } else {
        let start = 0;
        if (this.lines) {
          // 末尾は行の頭から始める（途中から始まる行は捨てる）
          if (this.lastEvicted !== NEWLINE) {
            const i = tail.indexOf(NEWLINE);
            start = i < 0 ? tail.length : i + 1;
          }
        } else {
          while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
        }
        this.dropped = {
          bytes: this.evictedBytes + start,
          lines: this.evictedLines + newlines(tail.subarray(0, start)),
        };
        const text = marker(this.dropped.bytes, this.dropped.lines);
        this.raw(Buffer.from(`${this.endsWithNewline ? "" : "\n"}${text}`, "utf8"));
        this.raw(tail.subarray(start));
      }
    }
    this.tail = [];
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // 閉じられなくても、書いた分は残る
      }
      this.fd = undefined;
    }
  }

  private toTail(buf: Buffer): void {
    if (buf.length === 0) return;
    this.tail.push(Buffer.from(buf));
    this.tailSize += buf.length;
    // 末尾の上限を超えた分は、前から捨てる
    while (this.tailSize > this.limits.tail) {
      const first = this.tail[0];
      if (!first) break;
      const over = this.tailSize - this.limits.tail;
      const out = over >= first.length ? first : first.subarray(0, over);
      this.evictedBytes += out.length;
      this.evictedLines += newlines(out);
      this.lastEvicted = out[out.length - 1];
      this.tailSize -= out.length;
      if (out === first) this.tail.shift();
      else this.tail[0] = first.subarray(over);
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
      this.endsWithNewline = buf[buf.length - 1] === NEWLINE;
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
  private readonly files: Record<SessionLogFile, HeadTailFile>;
  private readonly redactors: Record<SessionLogFile, StreamRedactor>;
  /** 書き始めた時点の秘密情報の数（後から増えたら、閉じるときに全体を伏せ直す）。 */
  private secretsAtFirstWrite: number | undefined;
  private warned = false;
  private closed = false;

  constructor(
    private readonly base: string,
    private readonly meta: SessionLogMeta,
    private readonly secrets: () => readonly string[],
    limits: Record<SessionLogFile, HeadTail>,
  ) {
    const onError = (error: unknown) => this.warn(error);
    this.files = {
      events: new HeadTailFile(`${base}${EXTENSIONS.events}`, limits.events, true, onError),
      stderr: new HeadTailFile(`${base}${EXTENSIONS.stderr}`, limits.stderr, false, onError),
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
      (droppedBytes, droppedLines) =>
        `${JSON.stringify({
          type: TRUNCATED_EVENT,
          droppedBytes,
          droppedLines,
          headBytes: limits.events.head,
          tailBytes: limits.events.tail,
        })}\n`,
    );
    this.files.stderr.close(
      (droppedBytes, droppedLines) =>
        `[sacty] truncated: ${droppedBytes} bytes (${droppedLines} lines) between the first ${limits.stderr.head} bytes and the last ${limits.stderr.tail} bytes were omitted.\n`,
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
    const truncated: NonNullable<SessionLogMeta["truncated"]> = {};
    for (const file of ["events", "stderr"] as const) {
      const { bytes, lines } = this.files[file].dropped;
      if (bytes > 0) truncated[file] = { droppedBytes: bytes, droppedLines: lines };
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
    private readonly limits: Record<SessionLogFile, HeadTail> = SESSION_LOG_LIMITS,
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
