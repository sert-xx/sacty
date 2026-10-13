import { createHash } from "node:crypto";
import { createReadStream, type Dirent, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ArchivedAgentFile } from "@sacty/core";
import { redact } from "./agents/redact.js";
import { HeadTailFile, secretForms, TRUNCATED_EVENT } from "./session-logs.js";

/**
 * エージェント（Claude Code・Codex）が自分で書いた元のセッションのファイルを、実行ごとに写す（PBI-66）。
 * 実行ごとの設定の場所（Claude Code の CLAUDE_CONFIG_DIR・Codex の CODEX_HOME）から、セッションのファイルだけを選び、
 * 秘密情報を伏せてから、SACTY_HOME/runs/<タスク>/<実行>/agent/ に、設定の場所からの相対パスのまま写す
 * （そのまま設定の場所に戻せば、セッションを再開できる形。PBI-67）。認証の情報・キャッシュは写さない。
 */

export type AgentSessionRuntime = "claude-code" | "codex";

const MB = 1024 * 1024;

/** 1実行あたりの上限（伏せた後の大きさの合計）。超えたら、ファイルごとに先頭と末尾を残して間を省く。 */
export const AGENT_FILES_LIMIT = 200 * MB;

/** 実行の場所の下の、写したファイルを置く場所の名前。 */
export const AGENT_FILES_DIR = "agent";

/**
 * 写すもの：設定の場所の下の、セッションのファイルの場所（サブエージェントのものも、この下にある）と、履歴。
 * - Claude Code：projects/<作業ディレクトリ>/<セッション>.jsonl、サブエージェントは
 *   projects/<作業ディレクトリ>/<セッション>/subagents/agent-*.jsonl、大きなツールの結果は …/<セッション>/tool-results/
 * - Codex：sessions/<年>/<月>/<日>/rollout-<日時>-<スレッド>.jsonl（サブエージェントのスレッドも同じ場所）
 * 設定・認証（.claude.json・.credentials.json・auth.json・config.toml）、キャッシュ・データベース（Codex の *.sqlite）、
 * スキル・シェルの写しは写さない。
 */
const SOURCES: Record<AgentSessionRuntime, { dirs: string[]; files: string[] }> = {
  "claude-code": { dirs: ["projects"], files: ["history.jsonl"] },
  codex: { dirs: ["sessions", "archived_sessions"], files: ["history.jsonl"] },
};

/** 選んだ場所の下にあっても写さない、認証の情報のファイルの名前。 */
const CREDENTIAL_NAME = /^(?:\.?credentials(?:\..*)?|auth\.json|\.claude\.json.*|config\.toml)$/i;

export type AgentSourceFile = { path: string; size: number };

/** 相対パス（区切りは /）。 */
function slash(path: string): string {
  return path.split(sep).join("/");
}

/**
 * 写す元のファイルを選ぶ（相対パスの順）。通常のファイルだけ（シンボリックリンクは辿らない。コンテナが、ホストの
 * ほかのファイルを指すリンクを置いても、写さないため）。
 */
export function selectAgentSessionFiles(
  runtime: AgentSessionRuntime,
  configDir: string,
): AgentSourceFile[] {
  const found: AgentSourceFile[] = [];
  const add = (abs: string) => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const name = abs.slice(abs.lastIndexOf(sep) + 1);
    if (CREDENTIAL_NAME.test(name)) return;
    found.push({ path: slash(relative(configDir, abs)), size: stat.size });
  };
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      // シンボリックリンク（ディレクトリを指すものも）は辿らない
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) add(abs);
    }
  };
  const source = SOURCES[runtime];
  for (const dir of source.dirs) {
    const abs = join(configDir, dir);
    try {
      if (!lstatSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(abs);
  }
  for (const file of source.files) add(join(configDir, file));
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * ファイルごとの上限（バイト）。合計が上限に収まれば省かない。超えたら、小さいファイルは丸ごと残し、残りを大きい
 * ファイルで等分する（1つの大きなファイルのせいで、ほかのファイルが残らないことのないように）。
 */
export function fileCaps(sizes: readonly number[], limit: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= limit) return sizes.map(() => Number.POSITIVE_INFINITY);
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  const caps = sizes.map(() => 0);
  let remaining = limit;
  for (const [k, { size, i }] of order.entries()) {
    const share = Math.floor(remaining / (order.length - k));
    if (size <= share) {
      caps[i] = Number.POSITIVE_INFINITY; // 丸ごと残す
      remaining -= size;
    } else {
      caps[i] = share;
      remaining -= share;
    }
  }
  return caps;
}

/**
 * バイト列から、秘密情報を伏せる（UTF-8 でないファイルも壊さないよう、1バイトを1文字として扱う）。届いた分の末尾
 * （一番長い秘密情報より1バイト短い分）は持っておき、次の分とつなげてから伏せる（値が読んだ分の境目をまたいでも伏せる）。
 */
export class ByteRedactor {
  private readonly forms: string[];
  private readonly keep: number;
  private pending = "";

  constructor(secrets: readonly string[]) {
    // 秘密情報（と JSON でエスケープされた形）を、UTF-8 のバイト列にしてから1バイト1文字にする
    this.forms = secretForms(secrets)
      .map((form) => Buffer.from(form, "utf8").toString("latin1"))
      .sort((a, b) => b.length - a.length);
    this.keep = Math.max(0, (this.forms[0]?.length ?? 0) - 1);
  }

  push(chunk: Buffer): Buffer {
    const redacted = redact(this.pending + chunk.toString("latin1"), this.forms);
    const cut = redacted.length - Math.min(redacted.length, this.keep);
    this.pending = redacted.slice(cut);
    return Buffer.from(redacted.slice(0, cut), "latin1");
  }

  flush(): Buffer {
    const rest = redact(this.pending, this.forms);
    this.pending = "";
    return Buffer.from(rest, "latin1");
  }
}

/** ファイルの SHA-256（16進）と大きさ。読めなければ undefined。 */
export function hashFile(path: string): Promise<{ sha256: string; bytes: number } | undefined> {
  return new Promise((done) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      bytes += buf.length;
    });
    stream.on("error", () => done(undefined));
    stream.on("end", () => done({ sha256: hash.digest("hex"), bytes }));
  });
}

const CHUNK = MB;

/** 省いたことの目印。JSONL なら、セッションログ（PBI-62）と同じ形の行。 */
function marker(path: string, cap: number, head: number) {
  return (droppedBytes: number, droppedLines: number) =>
    path.endsWith(".jsonl")
      ? `${JSON.stringify({ type: TRUNCATED_EVENT, droppedBytes, droppedLines, headBytes: head, tailBytes: cap - head })}\n`
      : `[sacty] truncated: ${droppedBytes} bytes (${droppedLines} lines) between the first ${head} bytes and the last ${cap - head} bytes were omitted.\n`;
}

/** 1つのファイルを、伏せてから（上限があれば先頭と末尾を残して）写す。 */
async function copyRedacted(
  source: string,
  dest: string,
  secrets: readonly string[],
  cap: number,
): Promise<{ truncated?: { droppedBytes: number; droppedLines: number } }> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  rmSync(dest, { force: true });
  const limited = Number.isFinite(cap);
  // 先頭を多めに残す（セッションの始まり・指示が先頭にあり、終わりの原因は末尾にある）
  const head = limited ? Math.floor(cap * 0.8) : Number.MAX_SAFE_INTEGER;
  const tail = limited ? cap - head : 0;
  let failure: unknown;
  const out = new HeadTailFile(dest, { head, tail }, dest.endsWith(".jsonl"), (error) => {
    failure ??= error;
  });
  const redactor = new ByteRedactor(secrets);
  const handle = await open(source, "r");
  try {
    for (;;) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      out.write(redactor.push(buf.subarray(0, bytesRead)));
    }
    out.write(redactor.flush());
  } finally {
    await handle.close();
    out.close(marker(dest, cap, head));
  }
  if (failure) throw failure;
  const { bytes, lines } = out.dropped;
  return bytes > 0 ? { truncated: { droppedBytes: bytes, droppedLines: lines } } : {};
}

export type AgentArchive = {
  files: ArchivedAgentFile[];
  /** 読めずに写せなかったファイル。 */
  skipped: string[];
  limitBytes: number;
};

/**
 * 設定の場所から、エージェントのセッションのファイルを dest に写す。秘密情報は写す前に伏せ（伏せてから切り詰める）、
 * 写した後のファイルの大きさと SHA-256 を返す（作業履歴に記録する）。写すファイルが無ければ、何も作らない。
 */
export async function archiveAgentSessionFiles(input: {
  runtime: AgentSessionRuntime;
  configDir: string;
  dest: string;
  secrets: readonly string[];
  limit?: number;
}): Promise<AgentArchive> {
  const limit = input.limit ?? AGENT_FILES_LIMIT;
  const sources = selectAgentSessionFiles(input.runtime, input.configDir);
  const caps = fileCaps(
    sources.map((s) => s.size),
    limit,
  );
  const files: ArchivedAgentFile[] = [];
  const skipped: string[] = [];
  if (sources.length > 0) mkdirSync(input.dest, { recursive: true, mode: 0o700 });
  for (const [i, source] of sources.entries()) {
    const dest = join(input.dest, ...source.path.split("/"));
    try {
      const { truncated } = await copyRedacted(
        join(input.configDir, ...source.path.split("/")),
        dest,
        input.secrets,
        caps[i] ?? Number.POSITIVE_INFINITY,
      );
      const hashed = await hashFile(dest);
      if (!hashed) throw new Error(`cannot read ${dest}`);
      files.push({
        path: source.path,
        bytes: hashed.bytes,
        sha256: hashed.sha256,
        sourceBytes: source.size,
        ...(truncated ? { truncated } : {}),
      });
    } catch (error) {
      console.warn(
        `[daemon] エージェントのファイルを写せませんでした（${source.path}）：`,
        error instanceof Error ? error.message : error,
      );
      skipped.push(source.path);
      rmSync(dest, { force: true });
    }
  }
  return { files, skipped, limitBytes: limit };
}

/**
 * セッションの ID を、写したファイルの名前から推し量る（出力からセッションの ID を読めなかったとき。途中で止めた実行など）。
 * Claude Code は projects/<作業ディレクトリ>/<セッション>.jsonl、Codex は sessions/…/rollout-<日時>-<スレッド>.jsonl。
 * 1つに決まらなければ undefined。
 */
export function guessSessionId(
  runtime: AgentSessionRuntime,
  files: readonly { path: string }[],
): string | undefined {
  const ids = new Set<string>();
  for (const { path } of files) {
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "";
    if (runtime === "claude-code") {
      const m = parts.length === 3 && parts[0] === "projects" ? /^(.+)\.jsonl$/.exec(name) : null;
      if (m?.[1]) ids.add(m[1]);
    } else {
      const m =
        parts[0] === "sessions"
          ? /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(name)
          : null;
      if (m?.[1]) ids.add(m[1]);
    }
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** 相対パスが、写したファイルの場所の中を指すか（「..」・絶対パス・空の部分を含まないか）。 */
export function safeRelativePath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** 写したファイルの、いまの場所。場所の外を指す・通常のファイルでない（リンクなど）なら undefined。 */
export function archivedFilePath(root: string, path: string): string | undefined {
  if (!safeRelativePath(path)) return undefined;
  const base = resolve(root);
  const abs = resolve(base, ...path.split("/"));
  if (!abs.startsWith(`${base}${sep}`)) return undefined;
  try {
    // 途中のディレクトリもリンクでないこと
    let dir = dirname(abs);
    while (dir.startsWith(`${base}${sep}`)) {
      if (lstatSync(dir).isSymbolicLink()) return undefined;
      dir = dirname(dir);
    }
    return lstatSync(abs).isFile() ? abs : undefined;
  } catch {
    return undefined;
  }
}

export type CheckedAgentFile = ArchivedAgentFile & {
  /** いまのファイルが、記録したハッシュ・大きさと一致するか。missing はファイルが無い。 */
  status: "match" | "mismatch" | "missing";
  current?: { bytes: number; sha256: string };
};

/** 写したファイルを、作業履歴に記録したハッシュと比べる。 */
export async function checkArchivedFiles(
  root: string,
  files: readonly ArchivedAgentFile[],
): Promise<CheckedAgentFile[]> {
  const checked: CheckedAgentFile[] = [];
  for (const file of files) {
    const abs = archivedFilePath(root, file.path);
    const current = abs ? await hashFile(abs) : undefined;
    checked.push({
      ...file,
      status: !current
        ? "missing"
        : current.sha256 === file.sha256 && current.bytes === file.bytes
          ? "match"
          : "mismatch",
      ...(current ? { current } : {}),
    });
  }
  return checked;
}
