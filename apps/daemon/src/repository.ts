import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, constants, cp, lstat, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { message } from "@sacty/core";
import { MessageError } from "./errors.js";

/** 差分は、先頭のこのバイト数だけゴールガーディアンに渡す。 */
export const DIFF_LIMIT = 200_000;

/** 起点からの変更の、ファイルごとの追加と削除の行の数。 */
export type FileChange = { path: string; added: number; removed: number };

/**
 * git diff --numstat -z の出力（名前の変更を分けたもの）を読む。行の数が `-` のもの（バイナリか、リポジトリの属性
 * `-diff` などで差分を出さないもの）は unknown にし、呼び出し側が中身から数える。
 */
export function parseNumstat(output: string): (FileChange & { unknown?: true })[] {
  return output
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
      if (!match) return [];
      const path = match[3] ?? "";
      if (match[1] === "-" || match[2] === "-")
        return [{ path, added: 0, removed: 0, unknown: true }];
      return [{ path, added: Number(match[1]), removed: Number(match[2]) }];
    });
}

/** git diff --name-status -z の出力（名前の変更を分けたもの）を、パスから状態（A・D・M など）への対応にする。 */
function parseNameStatus(output: string): Map<string, string> {
  const fields = output.split("\0");
  const statuses = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i];
    const path = fields[i + 1];
    if (status && path !== undefined) statuses.set(path, status.charAt(0));
  }
  return statuses;
}

/** 差分のファイル。status は git の状態（A・M・D・T・R089 など）。oldPath は、名前を変えた（R）・写した（C）元のパス。 */
export type DiffFile = { status: string; path: string; oldPath?: string };

/** `git diff -z --name-status` の出力を、ファイルの一覧にする。名前の変更・写しは、元と先の 2 つのパスが続く。 */
export function parseDiffFiles(output: string): DiffFile[] {
  const fields = output.split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] ?? "";
    if (status === "") break;
    if (/^[RC]/.test(status)) {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      if (oldPath === undefined || path === undefined) break;
      files.push({ status, path, oldPath });
      i += 3;
    } else {
      const path = fields[i + 1];
      if (path === undefined) break;
      files.push({ status, path });
      i += 2;
    }
  }
  return files;
}

/** 中身の行の数（最後の行に改行が無くても1行に数える）。 */
function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * 作業領域の写しで、読めないために写さなかったファイル・ディレクトリ（権限など。PBI-278）。paths は作業領域の根からの
 * 相対パスで、最初の SKIPPED_PATHS_MAX 件まで。count は写さなかった総数（ディレクトリは、その下を数えず1件）。
 */
export type WorkingTreeCopy = { skipped: { count: number; paths: string[] } };

/** 写さなかったファイルのうち、記録に残すパスの数の上限。 */
export const SKIPPED_PATHS_MAX = 20;
/** 記録に残す、パス1件の長さの上限（文字。作業履歴のイベントの形に合わせる）。 */
const SKIPPED_PATH_LENGTH_MAX = 500;

/**
 * エージェントが作業領域に入れたツール（環境に無いブラウザなど）の置き場所。リポジトリの .gitignore に頼らず、
 * PR・コミットには入れない（stage の除外。追跡しているファイルには効かない）。PBI-278。
 */
export const WORKSPACE_TOOLS_DIR = ".sacty-tools";
/**
 * 検証の記録（ログ・集計・差分の写し）や起点の写し、下書きなど、sacty とエージェントが作る作業用のファイルを置く、作業領域の外の
 * 場所（PBI-302 A1）。作業領域の中に置くと、リポジトリ全体を対象にするフォーマッター・リンター・テストの結果を変える。
 * `.sacty-tools/` は入れた道具の置き場だけで、記録は置かない。
 */
export const WORKSPACE_SCRATCH_DIR = "/tmp/agent-scratch";

/** 実装の対象リポジトリを扱う口。テストでは偽物に差し替える。 */
export interface RepositoryWorkspace {
  /**
   * 作業領域（dir）にリポジトリを clone し、起点のコミットを返す。
   * あわせて、clone した直後の git のメタデータを gitDir に退避する（差分を作るときの信頼できる元）。
   */
  prepare(
    dir: string,
    gitDir: string,
    url: string,
    /** ベースブランチ。省略すると、リポジトリの既定のブランチ（PBI-25）。 */
    baseBranch: string | undefined,
    /** HTTPS の GitHub に認証する環境変数（gh のトークン。PBI-13）。無ければホストの認証を使う。 */
    authEnv?: Record<string, string>,
    /**
     * 作業領域を用意し直すときの、記録済みの起点のコミット。ブランチの最新ではなく、このコミットで
     * 用意する（タスクの起点を最後まで変えないため。PBI-15）。取得できなければエラーにする。
     */
    baseCommit?: string,
  ): Promise<{ baseCommit: string; baseBranch: string }>;
  /** 起点からの差分（新しく作ったファイルを含む）。 */
  diff(dir: string, gitDir: string, baseCommit: string): Promise<string>;
  /**
   * diff と同じ差分の、ファイルの一覧（同じ並び。名前の変更を見つける）。パスは git が引用せずに出したまま（NUL 区切り）。
   * 差分の節をファイルに結び付けるために使う（PR #304 のレビュー）。
   */
  diffFiles(dir: string, gitDir: string, baseCommit: string): Promise<DiffFile[]>;
  /**
   * 起点からの変更を、ファイルごとの追加と削除の行の数で返す（切り詰めない）。名前の変更は、変更元の削除と変更先の追加に
   * 分ける。バイナリのファイルは、行の数を 0 にする。
   */
  diffStats(dir: string, gitDir: string, baseCommit: string): Promise<FileChange[]>;
  /**
   * 起点のコミットのファイルを、退避したメタデータから outDir に書き出す（.git は含めない）。
   * 要求要件・設計の工程で、実装の作業領域とは別に、起点のコードを読ませるため（PBI-15）。
   */
  snapshot(gitDir: string, baseCommit: string, outDir: string): Promise<void>;
  /**
   * 実装の作業領域の内容（.git を除く）を outDir に写す。PR の指摘の戻し先の判断・監査のエージェントに、実装後のコードを
   * 使い捨ての写しで読ませるため（PBI-16）。シンボリックリンクはたどらず、そのまま写す。gitDir があれば、写しの .git は、
   * 作業領域の .git（エージェントが書き換えられる）ではなく、退避したメタデータの写しにする（エージェントが git を参照できるように）。
   * 読めないファイル・ディレクトリ（権限 0000 のファイルなど。エージェントが展開したツールにある。PBI-278）は、全体を失敗に
   * せず、写さずに skipped で返す。
   */
  copyWorkingTree(dir: string, outDir: string, gitDir?: string): Promise<WorkingTreeCopy>;
  /**
   * 作業領域の内容をコミットし、ブランチにプッシュする。コミットは parent に積む
   * （前回プッシュしたコミットに積むので、強制プッシュはしない）。
   */
  publish(input: {
    dir: string;
    gitDir: string;
    baseCommit: string;
    parent: string;
    branch: string;
    message: string;
    /**
     * コミットの日時（ISO 8601）。同じ提出では同じ値を渡す。プッシュの後、作業履歴に記録する前に
     * 失敗して再開しても、同じコミットを作り直せる（前回プッシュしたものと枝分かれしない）ように。
     */
    date: string;
    /** HTTPS の GitHub に認証する環境変数（gh のトークン。PBI-13）。 */
    authEnv?: Record<string, string>;
    /**
     * このコミットから、そのまま引き継ぐパス（タスクブランチに積んだ要求要件・設計のファイル。PBI-57）。作業領域には
     * 無いので、コミットの内容はこのパスだけ commit のものにする（作業領域の変更が無ければ、これまでどおりエラー）。
     */
    keep?: { commit: string; paths: string[] };
    /**
     * ベースブランチから作業領域に取り込んだコミット（mergeBase。取得済みであること）。parent の履歴にまだ含まれていなければ、
     * これを第2の親にしたマージコミットにする（作業領域は、このコミットをマージした内容になっているので、コミットの内容は
     * そのまま作業領域の内容）。含まれていれば、これまでどおり parent だけを親にする。内容が parent と変わらなくても、
     * 含まれていなければ新しいコミットを作る（PR が、ベースブランチの先頭を含む履歴になるように）。
     */
    merge?: string;
  }): Promise<{ commit: string }>;
  /**
   * ベースブランチの先頭（target。取得済みであること）を、作業領域の内容に取り込む。作業領域は base（作業領域が今ベースに
   * している起点のコミット）に実装の変更を加えたものなので、base を共通の祖先にして、作業領域の内容と target を3方向で
   * マージし、結果を作業領域に書く（履歴は書き換えない。コミットは作らない）。競合したファイルには、目印
   * （<<<<<<<・=======・>>>>>>>。上が作業領域の側、下が target の側）を残し、conflicts にそのパスを返す。
   * target が既に base の履歴に含まれていれば何もしない（unchanged）。作業領域・利用者の git の設定は読まず、
   * 退避したメタデータの git で行う。
   */
  mergeBase(input: {
    dir: string;
    gitDir: string;
    base: string;
    target: string;
    /**
     * 競合したファイルの数の上限。超えるときは、作業領域を書き換えずに、理由を示して失敗する（全件の目印を検査できない
     * まま、解消したことにしない）。
     */
    maxConflicts?: number;
    /**
     * マージから外すパス（リポジトリの根からの相対パス）。base と target のツリーから除いてマージするので、作業領域の
     * そのパスは変わらない（人が PR に足したコミットを取り込むとき、タスクブランチから引き継ぐ要求要件・設計のファイルを
     * 外す。PBI-334）。
     */
    exclude?: string[];
  }): Promise<{ status: "unchanged" | "merged" | "conflicted"; conflicts: string[] }>;
  /**
   * paths（リポジトリの根からの相対パス）のうち、競合の目印（mergeBase が書く、ID のラベルの付いた <<<<<<< の行か
   * >>>>>>> の行。どちらか1つでも）が作業領域のファイルに残っているもの。ディレクトリとファイルの名前の衝突で git が避けた
   * 名前（`<名前>~<ID>`）のパスは、まだ存在するうちは残っているものとする。通常のファイルだけを読む（シンボリックリンクや、
   * 作業領域の外を指すものは読まない）。
   */
  conflictMarkers(dir: string, paths: string[]): Promise<string[]>;
  /** 既にあるコミットを、ブランチにプッシュする（タスクブランチを作る。PBI-57）。強制プッシュはしない。 */
  pushCommit(
    gitDir: string,
    commit: string,
    branch: string,
    authEnv?: Record<string, string>,
  ): Promise<void>;
  /**
   * parent のコミットに、files（リポジトリの根からの相対パス → 内容）を書いたコミットを作り、ブランチにプッシュする
   * （要求要件・設計の成果のファイル。PBI-57）。作業領域は使わない。内容が parent と変わらなければ parent をそのまま
   * 使う（allowEmpty なら、変わらなくても新しいコミットを作る。新しい PR に差分のコミットが要るため）。
   */
  commitFiles(input: {
    gitDir: string;
    parent: string;
    files: Record<string, string>;
    branch: string;
    message: string;
    /** コミットの日時（同じ提出では同じ値。再開しても同じコミットを作り直せるように）。 */
    date: string;
    allowEmpty?: boolean;
    authEnv?: Record<string, string>;
  }): Promise<{ commit: string }>;
  /**
   * コミットを、リモートから退避したメタデータに取得する（レビューの対象の PR のコミット。PBI-19）。
   * すでにあれば取得しない。
   */
  fetchCommits(gitDir: string, commits: string[], authEnv?: Record<string, string>): Promise<void>;
  /**
   * ブランチの最新のコミットを、リモートから退避したメタデータに取得して返す（統合レビューで、子タスクの
   * PR がマージされた後のベースブランチを読むため。PBI-31）。
   */
  fetchBranch(gitDir: string, branch: string, authEnv?: Record<string, string>): Promise<string>;
  /**
   * 2つのコミットの間で変わったパス（PBI-57）。タスクブランチに、sacty が積んでいない変更（人が直接積んだ・
   * ベースブランチをマージした）が無いかを、実装を積む前に確かめるために使う。どちらのコミットも取得済みであること。
   */
  changedPaths(gitDir: string, from: string, to: string): Promise<string[]>;
  /**
   * コミットにあるファイルの本文を、退避したメタデータから読む（人が PR の中で直してマージした、要求要件・設計の成果の
   * ファイル。PBI-63）。作業領域・利用者の git の設定は使わない。ファイルが無ければ undefined。通常のファイルでない・
   * 大きすぎる・UTF-8 のテキストでなければエラー。コミットは取得済みであること。
   */
  readFile(
    gitDir: string,
    commit: string,
    path: string,
    options?: ReadFileOptions,
  ): Promise<string | undefined>;
  /**
   * コミットのそのパスがシンボリックリンクなら、リンクの先（書かれたままの文字列）を返す。そうでなければ（無い・通常の
   * ファイル・ディレクトリ）undefined。デプロイの確認のスキル（PBI-89）のリンクを、リポジトリの中でたどるため。
   * コミットは取得済みであること。
   */
  readLink(gitDir: string, commit: string, path: string): Promise<string | undefined>;
  /** base と head の分岐点から head までの差分（PR の差分。PBI-19）。 */
  diffCommits(
    gitDir: string,
    baseCommit: string,
    headCommit: string,
    /** full：切り詰めない（レビューの工程で差分の全体をファイルで渡すため。PBI-65）。 */
    options?: { full?: boolean },
  ): Promise<string>;
  /** sacty のブランチを、リモートから消す（中止したとき）。 */
  deleteBranch(gitDir: string, branch: string, authEnv?: Record<string, string>): Promise<void>;
}

/** 起点から変更が無く、コミットするものが無い。 */
export class NothingToCommitError extends MessageError {}

const BASE_ENV_KEYS = ["PATH", "TMPDIR", "LANG"];

function pick(keys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * clone・プッシュの環境。エージェントが触る前のメタデータを使うので信頼できる。HTTPS の GitHub は
 * gh のトークン（authEnv）で、それ以外（SSH・ローカルのパス）はホストの認証（ssh-agent など）で認証する。
 */
function cloneEnv(authEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...pick([...BASE_ENV_KEYS, "HOME", "SSH_AUTH_SOCK"]),
    GIT_TERMINAL_PROMPT: "0",
    // HTTPS の GitHub は、gh のトークンで認証する（環境変数で渡し、コマンドラインには出さない）
    ...authEnv,
  };
}

/**
 * 差分を作るときの環境。作業領域はエージェントのコンテナが書き換えられるので、
 * そこにある git の設定は読まない（--git-dir で退避したメタデータを使う）。
 * 利用者やシステムの git の設定も読まない（フィルターなどの外部コマンドを、ホストで実行させないため）。
 */
function isolatedEnv(indexFile: string): Record<string, string> {
  return {
    ...pick(BASE_ENV_KEYS),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: indexFile,
  };
}

/** 外部コマンドを呼び出しうる設定を、コマンドラインで打ち消す。 */
const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.external=",
];

/**
 * `git add --ignore-errors` の標準エラー出力が、読めないファイルを載せられなかったことだけを言っているときの、そのファイルの
 * パス（根からの相対）。ほかの内容が混ざっている・パスを読めないときは undefined。
 */
function unreadablePaths(stderr: string): string[] | undefined {
  const paths: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (
      line === "" ||
      /^(?:error: unable to index file .*|fatal: adding files failed)$/.test(line)
    ) {
      continue;
    }
    const opened = /^error: open\("(.*)"\): Permission denied$/.exec(line);
    if (!opened?.[1]) return undefined;
    paths.push(opened[1]);
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * 写せるか（このプロセスの権限で読めるか）。ファイルは読み取り、ディレクトリは中身の一覧と辿り（読み取りと実行）が要る。
 * リンクは先をたどらず、そのまま写すので、常に写せる。調べる間に消えたものは、写す側の扱いに任せる。
 */
async function readable(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return true;
  const mode = stat.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK;
  return access(path, mode).then(
    () => true,
    () => false,
  );
}

function git(
  label: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  return gitBytes(label, args, env, cwd).then((out) => out.toString("utf8"));
}

/** git を実行し、標準出力をそのままのバイト列で返す（複数バイトの文字が、読み込みの区切りで壊れないように）。 */
function gitBytes(
  label: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) =>
      reject(new MessageError(message("git.unavailable", { detail: error.message }))),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else if (err.trim()) {
        reject(new MessageError(message("git.failed", { command: label, detail: err.trim() })));
      } else reject(new MessageError(message("git.exitCode", { command: label, code })));
    });
  });
}

/**
 * git を実行し、終了コードで失敗にしない（終了コードそのものが答えのコマンド用。merge-tree の競合は 1、
 * merge-base --is-ancestor の「祖先でない」は 1）。起動できなければエラー。
 */
function gitResult(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) =>
      reject(new MessageError(message("git.unavailable", { detail: error.message }))),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? -1, out: Buffer.concat(out).toString("utf8"), err: err.trim() }),
    );
  });
}

const COMMIT_RE = /^[0-9a-f]{40,64}$/;

/** 競合の目印を探すファイルの大きさの上限（これより大きいファイルは読まない）。 */
const MARKER_SCAN_LIMIT = 20 * 1024 * 1024;

/**
 * 競合の目印の行。git が書く、ツリーかコミットの ID のラベルが付いた始めの行と終わりの行。両側が同じファイルを別名へ
 * 改名して内容も競合したときなどは、目印が長くなり（`<<<<<<<<`。7 文字より多い）、ラベルにパスが付く（`<ID>:ours.txt`）。
 */
const CONFLICT_MARKER_RE = /^(<{7,}|>{7,}) [0-9a-f]{40,64}(?::[^\r\n]*)?\r?$/m;

/** ディレクトリとファイルの名前が衝突したときに、git が避けて付ける名前（`docs~<ID>`）。 */
const RENAMED_CONFLICT_RE = /~[0-9a-f]{40,64}$/;

/** ファイル・ディレクトリが無い（または、途中が通常のファイルに置き換わっている）ことを表すエラーか。 */
const isMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** 競合の目印を検査するために、ファイルを読めなかったときのエラー（対象のパスと原因を付ける）。 */
const markerReadError = (path: string, error: unknown) =>
  new MessageError(
    message("git.failed", {
      command: "conflictMarkers",
      detail: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );

/** コミットから読むファイルの大きさの上限（要求要件・設計の成果のファイル。PBI-63）。 */
const FILE_LIMIT = 1024 * 1024;

/** ブランチの名前として受け付けるか（オプションに見えるもの・使えない文字を除く）。 */
function validBranch(branch: string): boolean {
  return /^[\w./-]+$/.test(branch) && !branch.startsWith("-");
}

/** コミットに書くファイルのパスとして受け付けるか（リポジトリの中の相対パス。.git・. と .. を含まない）。 */
function validPath(path: string): boolean {
  if (!/^[\w./-]+$/.test(path)) return false;
  return safeSegments(path);
}

function safeSegments(path: string): boolean {
  return path
    .split("/")
    .every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
}

/**
 * リポジトリの中の相対パスとして読めるか（readFile の anyName。PR #304 のレビュー）。日本語・空白・記号を含む名前も受け付ける。
 * 外へ出られないこと（絶対パス・`..`・`.git`）、制御文字・オプションに見える先頭の `-` を含まないことは validPath と同じに守る。
 * 読むのは git のオブジェクトからで、作業領域のファイルシステムをたどらない（シンボリックリンクは通常のファイルでないので読まない）。
 */
function validRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("-")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するため
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return safeSegments(path);
}

/** readFile の読み方。 */
export type ReadFileOptions = {
  /**
   * パスに、英数字と `._/-` 以外（日本語・空白・記号）を含んでもよい（差分に出てきた、リポジトリの任意のファイルを読むとき。
   * PR #304 のレビュー）。リポジトリの外へ出るパスは、これまでどおり受け付けない。
   */
  anyName?: boolean;
};

export class GitRepositoryWorkspace implements RepositoryWorkspace {
  /**
   * 作業領域のファイルを、退避したメタデータの一時インデックスに載せる。
   * 作業領域・利用者・システムの git の設定は読まない（外部コマンドを実行させない）。
   */
  private async stage<T>(
    dir: string,
    gitDir: string,
    baseCommit: string,
    then: (git: (label: string, args: string[]) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    if (!COMMIT_RE.test(baseCommit)) throw new MessageError(message("git.invalidBaseCommit"));
    // インデックスは一時ファイルにする
    const temp = mkdtempSync(join(tmpdir(), "sacty-git-"));
    try {
      const env = isolatedEnv(join(temp, "index"));
      const base = ["--git-dir", gitDir, "--work-tree", dir, ...SAFE_CONFIG];
      const run = (label: string, args: string[]) => git(label, [...base, ...args], env);
      await run("read-tree", ["read-tree", baseCommit]);
      // 新しく作ったファイルも含めるため、すべてインデックスに載せる。エージェントが作業領域に入れたツールの置き場所
      // （根の .sacty-tools/）は、リポジトリの .gitignore の否定パターンでも戻らないよう、パス指定で必ず外す（起点で追跡している
      // ファイルは、インデックスに起点のまま残る。PBI-278）
      const added = await gitResult(
        [
          ...base,
          "add",
          "--all",
          "--ignore-errors",
          "--",
          ":/",
          `:(top,exclude)${WORKSPACE_TOOLS_DIR}`,
        ],
        env,
      );
      if (added.code !== 0) {
        // 読めないために載せられなかったのが、起点で追跡していない新しいファイル（権限 0000 のツールのファイルなど）だけなら
        // 進める。起点で追跡しているファイルを読めないと、その変更が黙って落ちるので、ほかの失敗と同じく失敗にする
        const unreadable = unreadablePaths(added.err);
        if (!unreadable || (await this.trackedAtBase(run, baseCommit, unreadable))) {
          throw new MessageError(
            message("git.failed", { command: "add", detail: added.err || `exit ${added.code}` }),
          );
        }
      }
      return await then(run);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /** paths のどれかが、起点のコミットで追跡しているファイルか（パスは文字どおりに照合する）。 */
  private async trackedAtBase(
    run: (label: string, args: string[]) => Promise<string>,
    baseCommit: string,
    paths: string[],
  ): Promise<boolean> {
    const listed = await run("ls-tree", [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      baseCommit,
      "--",
      ...paths.map((path) => `:(literal)${path}`),
    ]);
    return listed.split("\0").some(Boolean);
  }

  async prepare(
    dir: string,
    gitDir: string,
    url: string,
    baseBranch: string | undefined,
    authEnv?: Record<string, string>,
    recorded?: string,
  ) {
    if (recorded !== undefined && !COMMIT_RE.test(recorded)) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    // 前回の clone が途中で止まっていれば、作り直す。リポジトリの大きさに比例する写し・削除は、デーモンの
    // イベントループを止めないよう非同期で行う（画面や API に応答し続ける。PBI-156）
    for (const path of [dir, gitDir]) {
      if (existsSync(path)) await rm(path, { recursive: true, force: true });
    }
    const env = cloneEnv(authEnv);
    // ブランチの指定が無ければ、リポジトリの既定のブランチを clone する（PBI-25）
    if (
      baseBranch !== undefined &&
      (!/^[\w./-]+$/.test(baseBranch) || baseBranch.startsWith("-"))
    ) {
      throw new MessageError(message("git.invalidBranch"));
    }
    const clone = (branch: string | undefined) =>
      git(
        "clone",
        ["clone", ...(branch !== undefined ? ["--branch", branch] : []), "--", url, dir],
        env,
      );
    try {
      await clone(baseBranch);
    } catch (error) {
      // 用意し直すときは、ブランチが消えていても（引き継いだ PR のブランチがマージの後に消されたなど）、既定のブランチを
      // clone して記録済みの起点のコミットを取得する（ブランチの存続を前提にしない。PBI-157 レビュー指摘）
      if (!recorded || baseBranch === undefined) throw error;
      if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
      await clone(undefined);
    }
    if (recorded) {
      // 用意し直すときは、記録済みの起点のコミットにする（ブランチが進んでいても変えない）。
      // ブランチの履歴に無ければ（強制プッシュなど）、コミットを直接取得してみる
      const checkout = () =>
        git("checkout", ["checkout", "--quiet", "--detach", recorded], env, dir);
      try {
        await checkout();
      } catch {
        try {
          // git にオプションとして読まれる値（`--upload-pack=…` など）を渡さないよう、渡す直前の位置でも確かめる
          if (!COMMIT_RE.test(recorded)) throw new MessageError(message("git.invalidBaseCommit"));
          await git("fetch", ["fetch", "--quiet", "origin", recorded], env, dir);
          await checkout();
        } catch {
          throw new MessageError(message("git.baseCommitMissing", { commit: recorded }));
        }
      }
    }
    const baseCommit = (await git("rev-parse", ["rev-parse", "HEAD"], env, dir)).trim();
    // 用意したブランチ（指定が無ければ、clone した既定のブランチ）
    const branch =
      baseBranch ??
      (await git("symbolic-ref", ["symbolic-ref", "--short", "HEAD"], env, dir)).trim();
    // エージェントが触る前のメタデータを、どのコンテナにもマウントしない場所に退避する
    mkdirSync(dirname(gitDir), { recursive: true });
    await cp(join(dir, ".git"), gitDir, { recursive: true });
    return { baseCommit, baseBranch: branch };
  }

  async copyWorkingTree(dir: string, outDir: string, gitDir?: string) {
    if (!existsSync(dir)) throw new MessageError(message("verify.workspaceMissing"));
    mkdirSync(dirname(outDir), { recursive: true });
    const skipped = { count: 0, paths: [] as string[] };
    // 数 GB・数万ファイルになりうるので、非同期で写す（写す間もデーモンが応答し続ける。PBI-156）
    await cp(dir, outDir, {
      recursive: true,
      // リンクの先は写さない（ホストのファイルを取り込まない）。作業領域の .git は渡さない
      verbatimSymlinks: true,
      filter: async (src) => {
        const path = relative(dir, src);
        if (path.split(sep)[0] === ".git") return false;
        // 読めないもの（エージェントが展開したツールの権限 0000 のファイルなど）で、写し全体を失敗にしない（PBI-278）
        if (path === "" || (await readable(src))) return true;
        skipped.count++;
        if (skipped.paths.length < SKIPPED_PATHS_MAX)
          skipped.paths.push(path.split(sep).join("/").slice(0, SKIPPED_PATH_LENGTH_MAX));
        return false;
      },
    });
    // 退避したメタデータ（エージェントが触る前のもの）の写しを .git にする。写しなので、退避したものは書き換えられない
    if (gitDir) await cp(gitDir, join(outDir, ".git"), { recursive: true, verbatimSymlinks: true });
    return { skipped };
  }

  async snapshot(gitDir: string, baseCommit: string, outDir: string) {
    if (!COMMIT_RE.test(baseCommit)) throw new MessageError(message("git.invalidBaseCommit"));
    mkdirSync(outDir, { recursive: true });
    // 差分と同じく、利用者やシステムの git の設定を読まない環境で、一時インデックスから書き出す
    const temp = mkdtempSync(join(tmpdir(), "sacty-git-"));
    try {
      const env = isolatedEnv(join(temp, "index"));
      const base = ["--git-dir", gitDir, "--work-tree", outDir, ...SAFE_CONFIG];
      await git("read-tree", [...base, "read-tree", baseCommit], env);
      await git("checkout-index", [...base, "checkout-index", "--all", "--force"], env);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  async diff(dir: string, gitDir: string, baseCommit: string) {
    return this.stage(dir, gitDir, baseCommit, async (run) => {
      // 属性で差分を隠されないよう、外部の差分・変換を使わず、すべてテキストとして出す
      const diff = await run("diff", [
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        // 名前の変更の見つけ方を diffFiles とそろえる（節とファイルを同じ並びで結び付けるため）
        "-M",
        baseCommit,
      ]);
      return diff.length > DIFF_LIMIT
        ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
        : diff;
    });
  }

  async diffFiles(dir: string, gitDir: string, baseCommit: string) {
    return this.stage(dir, gitDir, baseCommit, async (run) =>
      parseDiffFiles(
        await run("diff", [
          "diff",
          "--cached",
          "--name-status",
          "-z",
          "--no-ext-diff",
          "--no-textconv",
          "-M",
          baseCommit,
        ]),
      ),
    );
  }

  async diffStats(dir: string, gitDir: string, baseCommit: string) {
    return this.stage(dir, gitDir, baseCommit, async (run) => {
      const listed = parseNumstat(
        await run("diff", [
          "diff",
          "--cached",
          "--numstat",
          "-z",
          // 名前の変更を、変更元の削除と変更先の追加に分ける（範囲の外のファイルを移して隠さないため）
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          baseCommit,
        ]),
      );
      // 行の数を出さないファイル（バイナリと、作業領域の .gitattributes の -diff などで隠したもの）は、変更前と変更後の
      // 中身の行の数を、すべて削除してすべて追加したものとして数える（リポジトリの属性で行の数を隠させないため）
      if (!listed.some((c) => c.unknown)) return listed;
      // 足した（A）ファイルには変更前が、消した（D）ファイルには変更後が無い。ある側の読み取りの失敗は、0 行にせずに
      // 呼び出し元へ伝える（行の数を少なく数えないため）
      const statuses = parseNameStatus(
        await run("diff", [
          "diff",
          "--cached",
          "--name-status",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          baseCommit,
        ]),
      );
      const lines = async (spec: string) =>
        lineCount(await run("cat-file", ["cat-file", "blob", spec]));
      // プロセスを一度に多く起動しないよう、1つずつ読む
      const changes: FileChange[] = [];
      for (const { unknown, ...change } of listed) {
        if (!unknown) {
          changes.push(change);
          continue;
        }
        const status = statuses.get(change.path);
        changes.push({
          path: change.path,
          added: status === "D" ? 0 : await lines(`:${change.path}`),
          removed: status === "A" ? 0 : await lines(`${baseCommit}:${change.path}`),
        });
      }
      return changes;
    });
  }

  async publish(input: Parameters<RepositoryWorkspace["publish"]>[0]) {
    if (!COMMIT_RE.test(input.parent)) throw new MessageError(message("git.invalidParentCommit"));
    if (!validBranch(input.branch)) throw new MessageError(message("git.invalidBranch"));
    const keep = input.keep;
    if (keep && !COMMIT_RE.test(keep.commit)) {
      throw new MessageError(message("git.invalidParentCommit"));
    }
    if (keep && !keep.paths.every(validPath)) throw new MessageError(message("git.invalidPath"));
    if (input.merge !== undefined && !COMMIT_RE.test(input.merge)) {
      throw new MessageError(message("git.invalidParentCommit"));
    }
    const author = await this.author();
    const commit = await this.stage(input.dir, input.gitDir, input.baseCommit, async (run) => {
      let tree = (await run("write-tree", ["write-tree"])).trim();
      const baseTree = (await run("rev-parse", ["rev-parse", `${input.baseCommit}^{tree}`])).trim();
      if (tree === baseTree) throw new NothingToCommitError(message("git.nothingToCommit"));
      if (keep && keep.paths.length > 0) {
        // 引き継ぐパスは、作業領域の内容ではなく、keep.commit の内容にする
        await run("rm", ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...keep.paths]);
        const listed = await run("ls-tree", [
          "ls-tree",
          "-r",
          "-z",
          keep.commit,
          "--",
          ...keep.paths,
        ]);
        for (const entry of listed.split("\0").filter(Boolean)) {
          const match = entry.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/s);
          if (!match) continue;
          await run("update-index", [
            "update-index",
            "--add",
            "--cacheinfo",
            `${match[1]},${match[2]},${match[3]}`,
          ]);
        }
        tree = (await run("write-tree", ["write-tree"])).trim();
      }
      const parentTree = (await run("rev-parse", ["rev-parse", `${input.parent}^{tree}`])).trim();
      // ベースブランチから取り込んだコミットが、まだ親の履歴に無ければ、第2の親にする（マージコミット）
      const merging =
        input.merge !== undefined &&
        !(await this.isAncestor(input.gitDir, input.merge, input.parent));
      // 前回プッシュした内容から変わっていなければ、同じコミットをそのまま使う
      if (tree === parentTree && input.parent !== input.baseCommit && !merging) return input.parent;
      return (
        await git(
          "commit-tree",
          [
            "--git-dir",
            input.gitDir,
            ...SAFE_CONFIG,
            "commit-tree",
            tree,
            "-p",
            input.parent,
            ...(merging && input.merge ? ["-p", input.merge] : []),
            "-m",
            input.message,
          ],
          {
            ...isolatedEnv("/dev/null"),
            ...author,
            GIT_AUTHOR_DATE: input.date,
            GIT_COMMITTER_DATE: input.date,
          },
        )
      ).trim();
    });
    // プッシュは、HTTPS の GitHub なら gh のトークン、それ以外はホストの認証（ssh-agent など）を使う。
    // 作業領域は読まない
    await git(
      "push",
      ["--git-dir", input.gitDir, "push", "--", "origin", `${commit}:refs/heads/${input.branch}`],
      cloneEnv(input.authEnv),
    );
    return { commit };
  }

  /** commit が ancestorOf の履歴に含まれるか（同じコミットも含む）。どちらも取得済みであること。 */
  private async isAncestor(gitDir: string, commit: string, ancestorOf: string): Promise<boolean> {
    if (!COMMIT_RE.test(commit) || !COMMIT_RE.test(ancestorOf)) {
      throw new MessageError(message("git.invalidParentCommit"));
    }
    const result = await gitResult(
      ["--git-dir", gitDir, ...SAFE_CONFIG, "merge-base", "--is-ancestor", commit, ancestorOf],
      isolatedEnv("/dev/null"),
    );
    // 0：含まれる、1：含まれない。それ以外（コミットが無いなど）は失敗
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new MessageError(
      message("git.failed", { command: "merge-base", detail: result.err || `exit ${result.code}` }),
    );
  }

  async mergeBase(input: Parameters<RepositoryWorkspace["mergeBase"]>[0]) {
    if (!COMMIT_RE.test(input.base) || !COMMIT_RE.test(input.target)) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    if (input.exclude && !input.exclude.every(validPath)) {
      throw new MessageError(message("git.invalidPath"));
    }
    // 取り込むものが無い（ベースブランチの先頭が、今の起点の履歴に含まれている）
    if (
      input.base === input.target ||
      (await this.isAncestor(input.gitDir, input.target, input.base))
    ) {
      return { status: "unchanged" as const, conflicts: [] };
    }
    return this.stage(input.dir, input.gitDir, input.base, async (run) => {
      // 作業領域の内容（新しく作ったファイルも含む）を、ツリーにする
      const mine = (await run("write-tree", ["write-tree"])).trim();
      if (!COMMIT_RE.test(mine)) {
        throw new MessageError(
          message("git.failed", { command: "write-tree", detail: "unexpected output" }),
        );
      }
      // 外すパスがあれば、共通の祖先と target を、そのパスを除いたツリーにしてマージする（作業領域の側からも除く）。ツリーの
      // 加工は別の一時インデックスで行う（作業領域のファイルの状態を持つインデックスを読み替えると、最後の read-tree -m -u が
      // 作業領域のファイルを最新でないと見なして失敗する）
      const exclude = input.exclude ?? [];
      const side = exclude.length > 0 ? mkdtempSync(join(tmpdir(), "sacty-git-")) : undefined;
      const sideRun = (label: string, args: string[]) =>
        git(
          label,
          // rm は作業ツリーを要るが、--cached なので作業領域のファイルには触れない
          ["--git-dir", input.gitDir, "--work-tree", input.dir, ...SAFE_CONFIG, ...args],
          isolatedEnv(join(side ?? "", "index")),
        );
      const without = async (treeish: string) => {
        await sideRun("read-tree", ["read-tree", treeish]);
        await sideRun("rm", [
          "rm",
          "--cached",
          "-r",
          "-q",
          "--ignore-unmatch",
          "--",
          ...exclude.map((p) => `:(literal)${p}`),
        ]);
        return (await sideRun("write-tree", ["write-tree"])).trim();
      };
      try {
        // git 2.40〜2.44 の merge-tree は、マージする側と共通の祖先にコミットしか受け付けないので、ツリーは一時的なコミット
        // （どのブランチにも付けない。日時と作者は固定）にして渡す（PBI-334。作業履歴の環境の git 2.43 で、ツリーを渡すと失敗した）
        const asCommit = async (tree: string) =>
          (
            await git(
              "commit-tree",
              ["--git-dir", input.gitDir, ...SAFE_CONFIG, "commit-tree", tree, "-m", "sacty merge"],
              {
                ...isolatedEnv("/dev/null"),
                GIT_AUTHOR_NAME: "sacty",
                GIT_AUTHOR_EMAIL: "sacty@localhost",
                GIT_COMMITTER_NAME: "sacty",
                GIT_COMMITTER_EMAIL: "sacty@localhost",
                GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
                GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
              },
            )
          ).trim();
        const mergeBaseTree =
          exclude.length > 0 ? await asCommit(await without(input.base)) : input.base;
        const targetTree =
          exclude.length > 0 ? await asCommit(await without(input.target)) : input.target;
        const mineTree = await asCommit(exclude.length > 0 ? await without(mine) : mine);
        // 起点を共通の祖先にして、作業領域のツリーと target を3方向でマージする（ブランチのコミットは作らない）。競合は終了コード 1 で、
        // 目印を入れたファイルを含む結果のツリーができる
        const merged = await gitResult(
          [
            "--git-dir",
            input.gitDir,
            ...SAFE_CONFIG,
            "merge-tree",
            "--write-tree",
            "--no-messages",
            "--name-only",
            "-z",
            `--merge-base=${mergeBaseTree}`,
            mineTree,
            targetTree,
          ],
          isolatedEnv("/dev/null"),
        );
        // 129 は使い方の誤り（--write-tree が無い古い git）
        if (merged.code === 129) throw new MessageError(message("git.mergeTreeUnsupported"));
        if (merged.code !== 0 && merged.code !== 1) {
          throw new MessageError(
            message("git.failed", {
              command: "merge-tree",
              detail: merged.err || `exit ${merged.code}`,
            }),
          );
        }
        const [tree, ...names] = merged.out.split("\0").filter((x) => x !== "");
        if (!tree || !COMMIT_RE.test(tree)) {
          throw new MessageError(
            message("git.failed", { command: "merge-tree", detail: "unexpected output" }),
          );
        }
        const conflicts = [...new Set(names)];
        // 競合したのに、競合したファイルが一覧に無い（ディレクトリの移動先を決められないなど、目印を入れられない競合）ときは、
        // 解消を確かめられないので、作業領域を書き換える前に止める（PBI-334。競合なしとして扱うと、未解消の結果を出してしまう）
        if (merged.code === 1 && conflicts.length === 0) {
          throw new MessageError(message("git.conflictWithoutFiles"));
        }
        // 多すぎるときは、作業領域を書き換える前に止める（書いてしまうと、記録できない競合の目印が作業領域に残る）
        if (input.maxConflicts !== undefined && conflicts.length > input.maxConflicts) {
          throw new MessageError(
            message("git.tooManyConflicts", { count: conflicts.length, limit: input.maxConflicts }),
          );
        }
        // 競合したのに目印を入れられなかったファイル（バイナリ・片方での削除など）は、目印の検査では解消を確かめられず、片側の
        // 内容だけが残る（人が足したコミットの変更が黙って消えうる）ので、作業領域を書き換える前に止める（PBI-334）。git が
        // 避けた名前（`<名前>~<ID>`）と、その元の名前は、残っているかで確かめるので除く
        const unmarked: string[] = [];
        for (const path of conflicts) {
          if (RENAMED_CONFLICT_RE.test(path)) continue;
          if (conflicts.some((c) => c.startsWith(`${path}~`) && RENAMED_CONFLICT_RE.test(c)))
            continue;
          const entry = (await run("ls-tree", ["ls-tree", "-z", tree, "--", path]))
            .split("\0")
            .find(Boolean);
          const match = entry?.match(/^\d+ (\w+) ([0-9a-f]+)\t/);
          if (!match) {
            // 結果に無い：両側とも消した（同じファイルを両側が別名へ改名した、など）なら、どちらの変更も消えない
            const has = async (treeish: string) =>
              (await run("ls-tree", ["ls-tree", "-z", treeish, "--", path])) !== "";
            if ((await has(mineTree)) || (await has(targetTree))) unmarked.push(path);
            continue;
          }
          if (match[1] !== "blob" || !match[2]) {
            unmarked.push(path);
            continue;
          }
          const size = Number((await run("cat-file", ["cat-file", "-s", match[2]])).trim());
          const text =
            size <= MARKER_SCAN_LIMIT ? await run("cat-file", ["cat-file", "blob", match[2]]) : "";
          if (!CONFLICT_MARKER_RE.test(text)) unmarked.push(path);
        }
        if (unmarked.length > 0) {
          throw new MessageError(
            message("git.conflictWithoutMarkers", {
              paths: unmarked.slice(0, 10).join(", "),
              count: unmarked.length,
            }),
          );
        }
        // 外したパスは、作業領域の内容（mine）のものを戻す（マージの結果のツリーには無い）
        let result = tree;
        if (exclude.length > 0) {
          await sideRun("read-tree", ["read-tree", tree]);
          const listed = await sideRun("ls-tree", ["ls-tree", "-r", "-z", mine, "--", ...exclude]);
          for (const entry of listed.split("\0").filter(Boolean)) {
            const match = entry.match(/^(\d+) (?:blob|commit) ([0-9a-f]+)\t(.+)$/s);
            if (!match) continue;
            await sideRun("update-index", [
              "update-index",
              "--add",
              "--cacheinfo",
              `${match[1]},${match[2]},${match[3]}`,
            ]);
          }
          result = (await sideRun("write-tree", ["write-tree"])).trim();
        }
        // 結果を作業領域に書く（作業領域の内容と同じなら書かない）。履歴は書き換えない
        if (result !== mine) await run("read-tree", ["read-tree", "-m", "-u", mine, result]);
        return {
          status: merged.code === 1 ? ("conflicted" as const) : ("merged" as const),
          conflicts,
        };
      } finally {
        if (side) rmSync(side, { recursive: true, force: true });
      }
    });
  }

  async conflictMarkers(dir: string, paths: string[]) {
    const root = await realpath(dir).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw markerReadError(dir, error);
    });
    if (!root) return [];
    const remaining: string[] = [];
    for (const path of paths) {
      if (await this.hasConflictMarkers(root, path)) remaining.push(path);
    }
    return remaining;
  }

  private async hasConflictMarkers(root: string, path: string): Promise<boolean> {
    const file = join(root, path);
    try {
      // ディレクトリとファイルの名前が衝突したとき、git は片方を `<名前>~<ID>` に避けて置く。それが残っているうちは
      // 解消していない（どちらを残すかを決め、内容を正しい名前に移して、避けた名前のものを消す）
      if (RENAMED_CONFLICT_RE.test(path)) {
        await lstat(file);
        return true;
      }
      // シンボリックリンクはたどらない。作業領域（エージェントが書き換えられる）の外のファイルを読まない
      if (!(await lstat(file)).isFile()) return false;
      const real = await realpath(file);
      if (relative(root, real).split(sep)[0] === ".." || relative(root, real) === "") return false;
      const stat = await lstat(real);
      if (stat.size > MARKER_SCAN_LIMIT) return false;
      const text = (await readFile(real)).toString("utf8");
      // sacty が書く目印は、始めの行（<<<<<<<）と終わりの行（>>>>>>>）にツリーかコミットの ID のラベルが付く。そのラベルの付いた
      // 行が1つでも残っていれば、残っているとする（片方だけ消し忘れた場合も）。ラベルの無い似た行や、単独の =======（Markdown の
      // 見出しの下線）は、目印にしない
      return CONFLICT_MARKER_RE.test(text);
    } catch (error) {
      // ファイルが無い（消した＝解消した）ときだけ、目印は無いとする。読めない（権限など）ときは、未検査のまま
      // 解消したことにしないよう、対象のパスと原因を付けて伝える（呼び出し側が、理由を示して止める）
      if (isMissing(error)) return false;
      throw markerReadError(path, error);
    }
  }

  async pushCommit(
    gitDir: string,
    commit: string,
    branch: string,
    authEnv?: Record<string, string>,
  ): Promise<void> {
    if (!COMMIT_RE.test(commit)) throw new MessageError(message("git.invalidParentCommit"));
    if (!validBranch(branch)) throw new MessageError(message("git.invalidBranch"));
    await git(
      "push",
      ["--git-dir", gitDir, "push", "--", "origin", `${commit}:refs/heads/${branch}`],
      cloneEnv(authEnv),
    );
  }

  async commitFiles(input: Parameters<RepositoryWorkspace["commitFiles"]>[0]) {
    if (!COMMIT_RE.test(input.parent)) throw new MessageError(message("git.invalidParentCommit"));
    if (!validBranch(input.branch)) throw new MessageError(message("git.invalidBranch"));
    const files = Object.entries(input.files);
    if (files.length === 0 || !files.every(([path]) => validPath(path))) {
      throw new MessageError(message("git.invalidPath"));
    }
    const author = await this.author();
    // 差分と同じく、利用者やシステムの git の設定を読まない環境で、一時インデックスにファイルを書く（作業領域は使わない）
    const temp = mkdtempSync(join(tmpdir(), "sacty-git-"));
    let commit: string;
    try {
      const env = isolatedEnv(join(temp, "index"));
      const run = (label: string, args: string[]) =>
        git(label, ["--git-dir", input.gitDir, ...SAFE_CONFIG, ...args], env);
      await run("read-tree", ["read-tree", input.parent]);
      for (const [i, [path, content]] of files.entries()) {
        const file = join(temp, `file-${i}`);
        writeFileSync(file, content);
        // 属性のフィルター（外部コマンド）を通さずに、そのままの内容で書く
        const blob = (
          await run("hash-object", ["hash-object", "-w", "--no-filters", "--", file])
        ).trim();
        await run("update-index", [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blob},${path}`,
        ]);
      }
      const tree = (await run("write-tree", ["write-tree"])).trim();
      const parentTree = (await run("rev-parse", ["rev-parse", `${input.parent}^{tree}`])).trim();
      commit =
        tree === parentTree && !input.allowEmpty
          ? input.parent
          : (
              await git(
                "commit-tree",
                [
                  "--git-dir",
                  input.gitDir,
                  ...SAFE_CONFIG,
                  "commit-tree",
                  tree,
                  "-p",
                  input.parent,
                  "-m",
                  input.message,
                ],
                {
                  ...isolatedEnv("/dev/null"),
                  ...author,
                  GIT_AUTHOR_DATE: input.date,
                  GIT_COMMITTER_DATE: input.date,
                },
              )
            ).trim();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    // プッシュは、HTTPS の GitHub なら gh のトークン、それ以外はホストの認証を使う。強制プッシュはしない
    await git(
      "push",
      ["--git-dir", input.gitDir, "push", "--", "origin", `${commit}:refs/heads/${input.branch}`],
      cloneEnv(input.authEnv),
    );
    return { commit };
  }

  async fetchCommits(gitDir: string, commits: string[], authEnv?: Record<string, string>) {
    if (!commits.every((c) => COMMIT_RE.test(c))) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    const env = cloneEnv(authEnv);
    const has = async (commit: string) => {
      try {
        await git(
          "cat-file",
          ["--git-dir", gitDir, ...SAFE_CONFIG, "cat-file", "-e", `${commit}^{commit}`],
          env,
        );
        return true;
      } catch {
        return false;
      }
    };
    const missing: string[] = [];
    for (const commit of commits) if (!(await has(commit))) missing.push(commit);
    if (missing.length === 0) return;
    await git(
      "fetch",
      ["--git-dir", gitDir, ...SAFE_CONFIG, "fetch", "--quiet", "--", "origin", ...missing],
      env,
    );
  }

  async changedPaths(gitDir: string, from: string, to: string) {
    if (!COMMIT_RE.test(from) || !COMMIT_RE.test(to)) {
      throw new MessageError(message("git.invalidParentCommit"));
    }
    const out = await git(
      "diff",
      [
        "--git-dir",
        gitDir,
        ...SAFE_CONFIG,
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        from,
        to,
        "--",
      ],
      isolatedEnv("/dev/null"),
    );
    return out.split("\0").filter(Boolean);
  }

  async readFile(gitDir: string, commit: string, path: string, options: ReadFileOptions = {}) {
    const blob = await this.readBlob(gitDir, commit, path, options.anyName === true);
    return blob && new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes);
  }

  /**
   * readFile と同じ検査（通常のファイルだけ・大きさの上限・テキスト）をして、内容をそのままのバイト列（UTF-8 の BOM も
   * 残す）と、ファイルの種類・オブジェクトの ID で返す。無ければ undefined。
   */
  private async readBlob(
    gitDir: string,
    commit: string,
    path: string,
    anyName = false,
  ): Promise<{ bytes: Buffer; mode: string; object: string } | undefined> {
    if (!COMMIT_RE.test(commit)) throw new MessageError(message("git.invalidBaseCommit"));
    if (!(anyName ? validRelativePath(path) : validPath(path))) {
      throw new MessageError(message("git.invalidPath"));
    }
    // 任意の名前は、パスの指定の特別な書き方（`:(glob)`・`*` など）として読まない
    const env = {
      ...isolatedEnv("/dev/null"),
      ...(anyName ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
    };
    const run = (label: string, args: string[]) =>
      git(label, ["--git-dir", gitDir, ...SAFE_CONFIG, ...args], env);
    // パスの種類を確かめる（シンボリックリンク・サブモジュール・ディレクトリは読まない）
    const listed = await run("ls-tree", ["ls-tree", "-z", "--full-tree", commit, "--", path]);
    const found = listed
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode = "", type = "", object = ""] = line.slice(0, tab).split(" ");
        return { mode, type, object, name: line.slice(tab + 1) };
      })
      .find((e) => e.name === path);
    if (!found) return undefined;
    if (found.type !== "blob" || (found.mode !== "100644" && found.mode !== "100755")) {
      throw new MessageError(message("git.fileNotRegular", { path }));
    }
    const size = Number((await run("cat-file", ["cat-file", "-s", found.object])).trim());
    if (!Number.isFinite(size) || size > FILE_LIMIT) {
      throw new MessageError(message("git.fileTooLarge", { path, limit: FILE_LIMIT }));
    }
    // 属性のフィルター・変換は通さず、そのままの内容を読む
    const bytes = await gitBytes(
      "cat-file",
      ["--git-dir", gitDir, ...SAFE_CONFIG, "cat-file", "blob", found.object],
      env,
    );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MessageError(message("git.fileNotText", { path }));
    }
    if (text.includes("\0")) throw new MessageError(message("git.fileNotText", { path }));
    return { bytes, mode: found.mode, object: found.object };
  }

  async readLink(gitDir: string, commit: string, path: string) {
    if (!COMMIT_RE.test(commit)) throw new MessageError(message("git.invalidBaseCommit"));
    if (!validPath(path)) throw new MessageError(message("git.invalidPath"));
    const env = isolatedEnv("/dev/null");
    const run = (label: string, args: string[]) =>
      git(label, ["--git-dir", gitDir, ...SAFE_CONFIG, ...args], env);
    const listed = await run("ls-tree", ["ls-tree", "-z", "--full-tree", commit, "--", path]);
    const entry = listed
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode = "", type = "", object = ""] = line.slice(0, tab).split(" ");
        return { mode, type, object, name: line.slice(tab + 1) };
      })
      .find((e) => e.name === path);
    if (entry?.mode !== "120000" || entry.type !== "blob") return undefined;
    return run("cat-file", ["cat-file", "blob", entry.object]);
  }

  async fetchBranch(gitDir: string, branch: string, authEnv?: Record<string, string>) {
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) {
      throw new MessageError(message("git.invalidBranch"));
    }
    // 取得したコミットは FETCH_HEAD に残る（退避したメタデータのブランチや設定は変えない）
    await git(
      "fetch",
      [
        "--git-dir",
        gitDir,
        ...SAFE_CONFIG,
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        "origin",
        `refs/heads/${branch}`,
      ],
      cloneEnv(authEnv),
    );
    const commit = (
      await git(
        "rev-parse",
        ["--git-dir", gitDir, ...SAFE_CONFIG, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        isolatedEnv("/dev/null"),
      )
    ).trim();
    if (!COMMIT_RE.test(commit)) throw new MessageError(message("git.invalidBaseCommit"));
    return commit;
  }

  async diffCommits(
    gitDir: string,
    baseCommit: string,
    headCommit: string,
    options?: { full?: boolean },
  ) {
    if (!COMMIT_RE.test(baseCommit) || !COMMIT_RE.test(headCommit)) {
      throw new MessageError(message("git.invalidBaseCommit"));
    }
    // 作業領域は使わず、退避したメタデータだけで差分を出す（外部の差分・変換は使わない）
    const diff = await git(
      "diff",
      [
        "--git-dir",
        gitDir,
        ...SAFE_CONFIG,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        `${baseCommit}...${headCommit}`,
      ],
      isolatedEnv("/dev/null"),
    );
    if (options?.full) return diff;
    return diff.length > DIFF_LIMIT
      ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
      : diff;
  }

  async deleteBranch(gitDir: string, branch: string, authEnv?: Record<string, string>) {
    // 人間のブランチを消さないよう、sacty のブランチだけを受け付ける
    if (!/^sacty\/[\w./-]+$/.test(branch)) throw new MessageError(message("git.notSactyBranch"));
    // プッシュと同じく、退避したメタデータと、gh のトークンかホストの認証を使う。作業領域は読まない
    try {
      await git(
        "push",
        ["--git-dir", gitDir, "push", "--", "origin", `:refs/heads/${branch}`],
        // すでに無いブランチの理由を読むので、git の文言は訳さない
        { ...cloneEnv(authEnv), LC_ALL: "C" },
      );
    } catch (error) {
      // すでに無いブランチ（マージの後に GitHub が消した要求要件・設計のブランチなど。PBI-57）は、消せたものとする
      if (
        error instanceof MessageError &&
        /remote ref does not exist/.test(JSON.stringify(error.text))
      ) {
        return;
      }
      throw error;
    }
  }

  /** コミットの作者。ホストの git の利用者の設定を使い、無ければ sacty にする。 */
  private async author(): Promise<Record<string, string>> {
    const get = async (key: string) => {
      try {
        return (await git("config", ["config", "--global", "--get", key], cloneEnv())).trim();
      } catch {
        return "";
      }
    };
    const name = (await get("user.name")) || "sacty";
    const email = (await get("user.email")) || "sacty@localhost";
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }
}
