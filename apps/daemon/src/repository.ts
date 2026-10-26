import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
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

/** 中身の行の数（最後の行に改行が無くても1行に数える）。 */
function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

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
   * 実装の作業領域の内容（.git を除く）を outDir に写す。ゴールガーディアンに、実装後のコードを使い捨ての写しで
   * 読ませるため（PBI-16）。シンボリックリンクはたどらず、そのまま写す。gitDir があれば、写しの .git は、作業領域の .git
   * （エージェントが書き換えられる）ではなく、退避したメタデータの写しにする（最終レビューのテストが git を参照できるように）。
   */
  copyWorkingTree(dir: string, outDir: string, gitDir?: string): Promise<void>;
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
  }): Promise<{ commit: string }>;
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
  readFile(gitDir: string, commit: string, path: string): Promise<string | undefined>;
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

const COMMIT_RE = /^[0-9a-f]{40,64}$/;

/** コミットから読むファイルの大きさの上限（要求要件・設計の成果のファイル。PBI-63）。 */
const FILE_LIMIT = 1024 * 1024;

/** ブランチの名前として受け付けるか（オプションに見えるもの・使えない文字を除く）。 */
function validBranch(branch: string): boolean {
  return /^[\w./-]+$/.test(branch) && !branch.startsWith("-");
}

/** コミットに書くファイルのパスとして受け付けるか（リポジトリの中の相対パス。.git・. と .. を含まない）。 */
function validPath(path: string): boolean {
  if (!/^[\w./-]+$/.test(path)) return false;
  return path
    .split("/")
    .every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
}

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
      // 新しく作ったファイルも含めるため、すべてインデックスに載せる
      await run("add", ["add", "--all"]);
      return await then(run);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
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
    // 数 GB・数万ファイルになりうるので、非同期で写す（写す間もデーモンが応答し続ける。PBI-156）
    await cp(dir, outDir, {
      recursive: true,
      // リンクの先は写さない（ホストのファイルを取り込まない）。作業領域の .git は渡さない
      verbatimSymlinks: true,
      filter: (src) => relative(dir, src).split(sep)[0] !== ".git",
    });
    // 退避したメタデータ（エージェントが触る前のもの）の写しを .git にする。写しなので、退避したものは書き換えられない
    if (gitDir) await cp(gitDir, join(outDir, ".git"), { recursive: true, verbatimSymlinks: true });
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
        baseCommit,
      ]);
      return diff.length > DIFF_LIMIT
        ? `${diff.slice(0, DIFF_LIMIT)}\n[sacty] 差分が大きいため、先頭の ${DIFF_LIMIT} バイトだけを渡しています。`
        : diff;
    });
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
      const lines = async (spec: string) => {
        try {
          return lineCount(await run("cat-file", ["cat-file", "blob", spec]));
        } catch {
          return 0; // 無いファイル（足した・消した）
        }
      };
      return Promise.all(
        listed.map(async ({ unknown, ...change }) =>
          unknown
            ? {
                path: change.path,
                added: await lines(`:${change.path}`),
                removed: await lines(`${baseCommit}:${change.path}`),
              }
            : change,
        ),
      );
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
      // 前回プッシュした内容から変わっていなければ、同じコミットをそのまま使う
      if (tree === parentTree && input.parent !== input.baseCommit) return input.parent;
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

  async readFile(gitDir: string, commit: string, path: string) {
    if (!COMMIT_RE.test(commit)) throw new MessageError(message("git.invalidBaseCommit"));
    if (!validPath(path)) throw new MessageError(message("git.invalidPath"));
    const env = isolatedEnv("/dev/null");
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
    return text;
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
