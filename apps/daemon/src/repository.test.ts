import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDeploymentSkill } from "./deployment.js";
import {
  DIFF_LIMIT,
  GitRepositoryWorkspace,
  NothingToCommitError,
  SKIPPED_PATHS_MAX,
  WORKSPACE_TOOLS_DIR,
} from "./repository.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-repo-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** ローカルに、コミットが1つある main ブランチのリポジトリを作る。 */
function makeOrigin(): string {
  const origin = join(dir, "origin");
  mkdirSync(origin);
  git(origin, "init", "--initial-branch=main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "test");
  writeFileSync(join(origin, "pay.ts"), "export const pay = () => 0;\n");
  git(origin, "add", "--all");
  git(origin, "commit", "-m", "init");
  return origin;
}

/**
 * git が `merge-tree --write-tree --merge-base`（ベースブランチの取り込みが使う機能。2.40 以上）を使えるか。実装と同じく、
 * 実際に呼んで、使い方の誤り（終了コード 129）になるかで見る。使えない git（2.39 以前）では、実際に使うテストを飛ばす。
 */
const MERGE_BASE_SUPPORTED = (() => {
  const probe = mkdtempSync(join(tmpdir(), "sacty-git-probe-"));
  try {
    git(probe, "init", "--quiet", "--initial-branch=main");
    git(
      probe,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-qm",
      "x",
    );
    git(probe, "merge-tree", "--write-tree", "--merge-base=HEAD", "HEAD", "HEAD");
    return true;
  } catch (error) {
    return (error as { status?: number }).status !== 129;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
if (!MERGE_BASE_SUPPORTED) {
  console.warn(
    `[repository.test] この環境の git（${git(tmpdir(), "--version")}）は merge-tree --merge-base（2.40 以上）を使えないので、ベースブランチの取り込みを実際に動かすテストを飛ばします。`,
  );
}
/** `merge-tree --merge-base` を実際に使うテスト。git が 2.40 未満なら飛ばす（最低版はホストの要件。CI の git は新しい）。 */
const itMerge = it.skipIf(!MERGE_BASE_SUPPORTED);

// 実際の git を動かすので、テストをまとめて実行して重いときも時間切れにしない（PBI-35 レビューでの5秒の時間切れ）
describe("対象リポジトリの作業領域（git）", { timeout: 30_000 }, () => {
  it("用意し直すときは、ブランチが進んでいても記録済みの起点のコミットにする。無ければエラーにする（PBI-15）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const first = await workspace.prepare(
      join(dir, "a"),
      join(dir, "_git", "a.git"),
      origin,
      "main",
    );
    writeFileSync(join(origin, "later.ts"), "later\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "later");
    const again = await workspace.prepare(
      join(dir, "b"),
      join(dir, "_git", "b.git"),
      origin,
      "main",
      undefined,
      first.baseCommit,
    );
    expect(again.baseCommit).toBe(first.baseCommit);
    expect(existsSync(join(dir, "b", "later.ts"))).toBe(false);
    await expect(
      workspace.prepare(
        join(dir, "c"),
        join(dir, "_git", "c.git"),
        origin,
        "main",
        undefined,
        "0".repeat(40),
      ),
    ).rejects.toThrow(/起点のコミット/);
  });

  it("ブランチを指定しなければ、リポジトリの既定のブランチを clone し、そのブランチ名を返す（PBI-25）", async () => {
    const origin = makeOrigin();
    // 既定のブランチが main でないリポジトリ
    git(origin, "branch", "-m", "main", "trunk");
    const workspace = new GitRepositoryWorkspace();
    const prepared = await workspace.prepare(
      join(dir, "a"),
      join(dir, "_git", "a.git"),
      origin,
      undefined,
    );
    expect(prepared.baseBranch).toBe("trunk");
    expect(prepared.baseCommit).toBe(git(origin, "rev-parse", "trunk"));
    // 指定したブランチは、そのまま返す
    git(origin, "branch", "develop");
    const develop = await workspace.prepare(
      join(dir, "b"),
      join(dir, "_git", "b.git"),
      origin,
      "develop",
    );
    expect(develop.baseBranch).toBe("develop");
    // オプションに見えるブランチ名は受け付けない
    await expect(
      workspace.prepare(join(dir, "c"), join(dir, "_git", "c.git"), origin, "--upload-pack=x"),
    ).rejects.toThrow();
  });

  it("PR のコミットを取得し、分岐点からの PR の差分と、PR の先頭のコードを出す（PBI-19）", async () => {
    const origin = makeOrigin();
    // GitHub と同じく、PR の先頭はブランチではなく refs/pull/N/head にだけある
    git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");
    git(origin, "checkout", "-b", "feature");
    writeFileSync(join(origin, "retry.ts"), "export const retry = 3;\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "retry");
    const head = git(origin, "rev-parse", "HEAD");
    git(origin, "update-ref", "refs/pull/1/head", head);
    git(origin, "checkout", "main");
    git(origin, "branch", "-D", "feature");
    const workspace = new GitRepositoryWorkspace();
    const gitDir = join(dir, "_git", "a.git");
    await workspace.prepare(join(dir, "a"), gitDir, origin, "main");
    // clone の後に、向き先のブランチが進んだ
    writeFileSync(join(origin, "later.ts"), "later\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "later");
    const base = git(origin, "rev-parse", "HEAD");

    await workspace.fetchCommits(gitDir, [head, base]);
    // すでにあるコミットは取得し直さない（取得できない場所でも失敗しない）
    git(gitDir, "remote", "set-url", "origin", join(dir, "missing"));
    await workspace.fetchCommits(gitDir, [head, base]);
    const diff = await workspace.diffCommits(gitDir, base, head);
    expect(diff).toContain("+export const retry = 3;");
    // 向き先のブランチが後から進んだ分は、PR の差分に含めない
    expect(diff).not.toContain("later");
    const out = join(dir, "snapshot");
    await workspace.snapshot(gitDir, head, out);
    expect(readdirSync(out).sort()).toEqual(["pay.ts", "retry.ts"]);
    await expect(workspace.fetchCommits(gitDir, ["--upload-pack=evil"])).rejects.toThrow();
    await expect(workspace.diffCommits(gitDir, "main", head)).rejects.toThrow();
  });

  it("PR の差分は既定で切り詰め、full なら切り詰めない（レビューの差分の全体をファイルで渡すため。PBI-65）", async () => {
    const origin = makeOrigin();
    const base = git(origin, "rev-parse", "HEAD");
    // 先頭のファイルだけで上限を超え、後ろのファイルの差分が切り詰めで消える
    writeFileSync(join(origin, "a.txt"), `${"x".repeat(100)}\n`.repeat(2_500));
    writeFileSync(join(origin, "z.txt"), "last\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "big");
    const head = git(origin, "rev-parse", "HEAD");
    const workspace = new GitRepositoryWorkspace();
    const gitDir = join(dir, "_git", "big.git");
    await workspace.prepare(join(dir, "big"), gitDir, origin, "main");
    const truncated = await workspace.diffCommits(gitDir, base, head);
    expect(truncated.length).toBeLessThan(DIFF_LIMIT + 200);
    expect(truncated).toContain("[sacty] 差分が大きいため");
    expect(truncated).not.toContain("+last");
    const full = await workspace.diffCommits(gitDir, base, head, { full: true });
    expect(full).toContain("+last");
    expect(full).not.toContain("[sacty] 差分が大きいため");
    expect(full.length).toBeGreaterThan(DIFF_LIMIT);
  });

  it("ベースブランチの最新を取得し、そのコミットのコードを書き出す（統合レビュー。PBI-31）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const gitDir = join(dir, "_git", "a.git");
    const prepared = await workspace.prepare(join(dir, "a"), gitDir, origin, "main");
    // 子タスクの PR がマージされて、ベースブランチが進んだ
    writeFileSync(join(origin, "merged.ts"), "export const merged = 1;\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "merged");
    const latest = git(origin, "rev-parse", "HEAD");

    const commit = await workspace.fetchBranch(gitDir, "main");
    expect(commit).toBe(latest);
    expect(commit).not.toBe(prepared.baseCommit);
    const out = join(dir, "integrated");
    await workspace.snapshot(gitDir, commit, out);
    expect(readdirSync(out).sort()).toEqual(["merged.ts", "pay.ts"]);
    // オプションに見えるブランチ名・存在しないブランチは受け付けない
    await expect(workspace.fetchBranch(gitDir, "--upload-pack=evil")).rejects.toThrow();
    await expect(workspace.fetchBranch(gitDir, "missing")).rejects.toThrow();
  });

  it("実装後のコードを、.git を除き、シンボリックリンクはたどらずに写す（PBI-16）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    await workspace.prepare(clone, join(dir, "_git", "task.git"), origin, "main");
    writeFileSync(join(clone, "new.ts"), "new\n");
    const secret = join(dir, "host-secret.txt");
    writeFileSync(secret, "HOST-ONLY");
    symlinkSync(secret, join(clone, "link.txt"));
    const out = join(dir, "copy");
    await workspace.copyWorkingTree(clone, out);
    expect(readdirSync(out).sort()).toEqual(["link.txt", "new.ts", "pay.ts"]);
    // リンクはリンクのまま（ホストのファイルの中身は写さない）
    expect(lstatSync(join(out, "link.txt")).isSymbolicLink()).toBe(true);
    await expect(workspace.copyWorkingTree(join(dir, "missing"), join(dir, "x"))).rejects.toThrow();
  });

  // root は権限に関係なく読めるので、読めないファイルを作れない（CI の権限・ふつうのユーザーで確かめる）
  const itUnreadable = it.skipIf(process.getuid?.() === 0);

  itUnreadable(
    "読めないファイル・ディレクトリ（権限 0000）があっても写し全体を失敗にせず、写さずに返す。読めるようになれば写す（PBI-278）",
    async () => {
      const workspace = new GitRepositoryWorkspace();
      const clone = join(dir, "task", "repo");
      mkdirSync(join(clone, "node_modules/.browser/usr/share/pixmaps"), { recursive: true });
      writeFileSync(join(clone, "pay.ts"), "pay\n");
      writeFileSync(join(clone, "node_modules/.browser/ok.txt"), "ok\n");
      // 展開したツールの、権限 0000 のファイル（S16 の chromium.png）と、一覧も辿りもできないディレクトリ
      const png = join(clone, "node_modules/.browser/usr/share/pixmaps/chromium.png");
      writeFileSync(png, "png");
      chmodSync(png, 0o000);
      mkdirSync(join(clone, "locked/inner"), { recursive: true });
      writeFileSync(join(clone, "locked/inner/a.txt"), "a");
      chmodSync(join(clone, "locked"), 0o000);
      // 先をたどれないリンクは、そのまま写す
      symlinkSync(join(dir, "missing-target"), join(clone, "dangling"));
      try {
        const out = join(dir, "copy");
        const copied = await workspace.copyWorkingTree(clone, out);
        expect(copied.skipped.count).toBe(2);
        expect(copied.skipped.paths.sort()).toEqual([
          "locked",
          "node_modules/.browser/usr/share/pixmaps/chromium.png",
        ]);
        expect(readFileSync(join(out, "pay.ts"), "utf8")).toBe("pay\n");
        expect(readFileSync(join(out, "node_modules/.browser/ok.txt"), "utf8")).toBe("ok\n");
        expect(existsSync(join(out, "node_modules/.browser/usr/share/pixmaps/chromium.png"))).toBe(
          false,
        );
        expect(existsSync(join(out, "locked"))).toBe(false);
        expect(lstatSync(join(out, "dangling")).isSymbolicLink()).toBe(true);
        // 写しは消せる（失敗した写しの後始末で残らない）
        rmSync(out, { recursive: true });

        // 読めるようになれば（人が権限を直して再開）、同じ作業領域をすべて写せる
        chmodSync(png, 0o644);
        chmodSync(join(clone, "locked"), 0o755);
        const again = await workspace.copyWorkingTree(clone, join(dir, "copy2"));
        expect(again.skipped).toEqual({ count: 0, paths: [] });
        expect(readFileSync(join(dir, "copy2/locked/inner/a.txt"), "utf8")).toBe("a");
      } finally {
        chmodSync(png, 0o644);
        chmodSync(join(clone, "locked"), 0o755);
      }
    },
  );

  itUnreadable(
    "写さなかったファイルが多くても、返すパスは上限までで、総数は数える。読めないファイルが無ければ空（PBI-278）",
    async () => {
      const workspace = new GitRepositoryWorkspace();
      const clone = join(dir, "task", "repo");
      mkdirSync(clone, { recursive: true });
      // 境界：読めないファイルが0件
      writeFileSync(join(clone, "ok.txt"), "ok");
      expect((await workspace.copyWorkingTree(clone, join(dir, "c0"))).skipped).toEqual({
        count: 0,
        paths: [],
      });
      // 境界：1件
      writeFileSync(join(clone, "f0"), "x");
      chmodSync(join(clone, "f0"), 0o000);
      const one = await workspace.copyWorkingTree(clone, join(dir, "c1"));
      expect(one.skipped).toEqual({ count: 1, paths: ["f0"] });
      // 上限を超える件数
      const total = SKIPPED_PATHS_MAX + 5;
      for (let i = 1; i < total; i++) {
        writeFileSync(join(clone, `f${i}`), "x");
        chmodSync(join(clone, `f${i}`), 0o000);
      }
      const many = await workspace.copyWorkingTree(clone, join(dir, "cn"));
      expect(many.skipped.count).toBe(total);
      expect(many.skipped.paths).toHaveLength(SKIPPED_PATHS_MAX);
      expect(existsSync(join(dir, "cn", "ok.txt"))).toBe(true);
      // 長いパスは、作業履歴のイベントの形（500文字）に収まるよう切り詰める
      const alone = join(dir, "task2", "repo");
      const deep = join(alone, "a".repeat(200), "b".repeat(200), "c".repeat(200));
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "locked"), "x");
      chmodSync(join(deep, "locked"), 0o000);
      const long = await workspace.copyWorkingTree(alone, join(dir, "cl"));
      expect(long.skipped.paths).toHaveLength(1);
      expect(long.skipped.paths[0]?.length).toBe(500);
    },
  );

  it("退避したメタデータを渡すと、写しを git の作業ツリーにする（作業領域の .git は使わない。最終レビューのテスト）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const prepared = await workspace.prepare(clone, gitDir, origin, "main");
    writeFileSync(join(clone, "new.ts"), "new\n");
    // エージェントが作業領域の .git を書き換えても、写しには使わない
    writeFileSync(join(clone, ".git", "AGENT-MARK"), "x");
    const out = join(dir, "copy");
    await workspace.copyWorkingTree(clone, out, gitDir);
    expect(git(out, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(git(out, "rev-parse", "HEAD")).toBe(prepared.baseCommit);
    // 実装の変更は、起点からの変更として見える
    expect(git(out, "status", "--porcelain")).toContain("new.ts");
    expect(existsSync(join(out, ".git", "AGENT-MARK"))).toBe(false);
    // 写しの中で書き換えても、退避したメタデータは変わらない
    writeFileSync(join(out, ".git", "GUARDIAN-MARK"), "x");
    expect(existsSync(join(gitDir, "GUARDIAN-MARK"))).toBe(false);
  });

  it("多数のファイルを写す間も、イベントループを止めない（ほかのタイマーが進む。PBI-156）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    await workspace.prepare(clone, gitDir, origin, "main");
    // node_modules の代わりに、多数のファイルを置く
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(clone, "node_modules", `pkg${d}`), { recursive: true });
      for (let f = 0; f < 100; f++) {
        writeFileSync(join(clone, "node_modules", `pkg${d}`, `f${f}.js`), "x");
      }
    }
    let ticks = 0;
    let copying = true;
    const tick = () => {
      if (!copying) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const out = join(dir, "copy");
    await workspace.copyWorkingTree(clone, out, gitDir);
    copying = false;
    // 同期で写すと、写し終わるまでタイマーが1つも進まない
    expect(ticks).toBeGreaterThan(0);
    expect(readdirSync(join(out, "node_modules", "pkg19"))).toHaveLength(100);
    expect(git(out, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });

  it("起点のコミットのファイルだけを、.git や作業領域の変更を含めずに書き出す（PBI-15）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    // 実装で作業領域を書き換えても、書き出すのは起点のコミットのファイル
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
    writeFileSync(join(clone, "new.ts"), "new\n");
    // 起点の後に origin が進んでも、起点のコミットのまま
    writeFileSync(join(origin, "later.ts"), "later\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "later");
    const out = join(dir, "snapshot");
    await workspace.snapshot(gitDir, baseCommit, out);
    expect(readdirSync(out).sort()).toEqual(["pay.ts"]);
    expect(readFileSync(join(out, "pay.ts"), "utf8")).toBe("export const pay = () => 0;\n");
    await expect(workspace.snapshot(gitDir, "not-a-commit", join(dir, "x"))).rejects.toThrow();
  });

  it("作業領域で書き換えられた git の設定を、差分を作るときに評価しない（レビュー指摘）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");

    // エージェント（コンテナ）が、作業領域の git の設定と属性を書き換えた
    const marker = join(dir, "pwned");
    git(clone, "config", "filter.evil.clean", `touch ${marker}; cat`);
    git(clone, "config", "diff.evil.textconv", `touch ${marker}; cat`);
    git(clone, "config", "core.fsmonitor", `touch ${marker}`);
    writeFileSync(join(clone, ".gitattributes"), "* filter=evil diff=evil\npay.ts -diff\n");
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");

    const diff = await workspace.diff(clone, gitDir, baseCommit);
    expect(existsSync(marker)).toBe(false); // ホストで外部コマンドを実行していない
    expect(diff).toContain("+export const pay = () => 1;"); // 属性で中身を隠されない
    expect(diff).toContain(".gitattributes"); // 属性の変更自体は差分に出る
    // 退避したメタデータは書き換えない
    // （無い設定を --get すると git は終了コード1で終わる）
    expect(() =>
      git(gitDir, "--git-dir", gitDir, "config", "--get", "filter.evil.clean"),
    ).toThrow();
  });

  it("clone して起点のコミットを返し、新しいファイルを含む差分を返す", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    expect(baseCommit).toBe(git(origin, "rev-parse", "HEAD"));

    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
    writeFileSync(join(clone, "pay.test.ts"), "test('同じキーの再送', () => {});\n");
    const diff = await workspace.diff(clone, gitDir, baseCommit);
    expect(diff).toContain("+export const pay = () => 1;");
    expect(diff).toContain("pay.test.ts");
    expect(diff).toContain("同じキーの再送"); // 日本語のファイル内容もそのまま
    // コミットはしない
    expect(git(clone, "rev-parse", "HEAD")).toBe(baseCommit);
  });

  it("エージェントが作業領域に入れたツールの置き場所（根の .sacty-tools）は、.gitignore が無くても、否定パターンで戻されても、差分にもコミットにも入れない。node_modules はリポジトリの .gitignore に従う（PBI-278）", async () => {
    const origin = makeOrigin();
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");

    mkdirSync(join(clone, WORKSPACE_TOOLS_DIR, "chromium"), { recursive: true });
    writeFileSync(join(clone, WORKSPACE_TOOLS_DIR, "chromium", "chrome"), "binary\n");
    writeFileSync(join(clone, "pay.test.ts"), "test\n");
    // 名前の似た別のディレクトリは対象外（入れる）
    mkdirSync(join(clone, "docs", WORKSPACE_TOOLS_DIR), { recursive: true });
    writeFileSync(join(clone, "docs", WORKSPACE_TOOLS_DIR, "note.md"), "note\n");
    // node_modules は、リポジトリの .gitignore に任せる（否定パターンで含めるリポジトリの意図を尊重する）
    mkdirSync(join(clone, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(clone, "node_modules/pkg/index.js"), "dep\n");

    const paths = async () =>
      (await workspace.diffStats(clone, gitDir, baseCommit)).map((f) => f.path).sort();
    const expectedWithoutIgnore = [
      `docs/${WORKSPACE_TOOLS_DIR}/note.md`,
      "node_modules/pkg/index.js",
      "pay.test.ts",
    ];
    // .gitignore が無い
    expect(await paths()).toEqual(expectedWithoutIgnore);
    // .gitignore の否定パターンで、ツールの置き場所を再び含めようとしても入れない
    writeFileSync(
      join(clone, ".gitignore"),
      `!${WORKSPACE_TOOLS_DIR}/\n!${WORKSPACE_TOOLS_DIR}/**\n!/${WORKSPACE_TOOLS_DIR}/**\n`,
    );
    expect(await paths()).toEqual([".gitignore", ...expectedWithoutIgnore].sort());
    // node_modules を無視するリポジトリでは入らない。否定すれば入る
    writeFileSync(join(clone, ".gitignore"), "node_modules/\n");
    expect(await paths()).toEqual(
      [".gitignore", `docs/${WORKSPACE_TOOLS_DIR}/note.md`, "pay.test.ts"].sort(),
    );
    writeFileSync(join(clone, ".gitignore"), "node_modules/\n!node_modules/\n");
    expect(await paths()).toContain("node_modules/pkg/index.js");

    const diff = await workspace.diff(clone, gitDir, baseCommit);
    expect(diff).not.toContain("binary");
    const { commit } = await workspace.publish({
      dir: clone,
      gitDir,
      baseCommit,
      parent: baseCommit,
      branch: "sacty/tools",
      message: "m",
      date: "2026-10-10T01:00:00.000Z",
    });
    const files = git(origin, "ls-tree", "-r", "--name-only", commit).split("\n");
    expect(files).toContain("pay.test.ts");
    expect(files.filter((f) => f.includes("chrome") || f.startsWith(WORKSPACE_TOOLS_DIR))).toEqual(
      [],
    );
  });

  it("起点で追跡しているツールの置き場所のファイルは、起点のまま残る（消えた変更にもならない）（PBI-278）", async () => {
    const origin = makeOrigin();
    mkdirSync(join(origin, WORKSPACE_TOOLS_DIR));
    writeFileSync(join(origin, WORKSPACE_TOOLS_DIR, "keep.txt"), "v1\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "tracked");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    writeFileSync(join(clone, WORKSPACE_TOOLS_DIR, "keep.txt"), "v2\n");
    writeFileSync(join(clone, "pay.test.ts"), "test\n");
    expect((await workspace.diffStats(clone, gitDir, baseCommit)).map((f) => f.path)).toEqual([
      "pay.test.ts",
    ]);
  });

  itUnreadable(
    "読めない未追跡のファイルがあっても、差分とコミットは失敗にせず、読めるほかのファイルだけを入れる（PBI-278）",
    async () => {
      const origin = makeOrigin();
      git(origin, "config", "receive.denyCurrentBranch", "ignore");
      const workspace = new GitRepositoryWorkspace();
      const clone = join(dir, "task", "repo");
      const gitDir = join(dir, "_git", "task.git");
      const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
      writeFileSync(join(clone, "pay.test.ts"), "test\n");
      mkdirSync(join(clone, "tools"));
      writeFileSync(join(clone, "tools/chromium.png"), "png");
      chmodSync(join(clone, "tools/chromium.png"), 0o000);
      try {
        expect((await workspace.diffStats(clone, gitDir, baseCommit)).map((f) => f.path)).toEqual([
          "pay.test.ts",
        ]);
        const { commit } = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit,
          parent: baseCommit,
          branch: "sacty/unreadable",
          message: "m",
          date: "2026-10-10T01:00:00.000Z",
        });
        expect(git(origin, "ls-tree", "-r", "--name-only", commit)).toBe("pay.test.ts\npay.ts");
      } finally {
        chmodSync(join(clone, "tools/chromium.png"), 0o644);
      }
    },
  );

  itUnreadable(
    "起点で追跡しているファイルを読めないときは、ほかの読めるファイルがあっても、変更が黙って落ちずに失敗にする（PBI-278）",
    async () => {
      const origin = makeOrigin();
      git(origin, "config", "receive.denyCurrentBranch", "ignore");
      const workspace = new GitRepositoryWorkspace();
      const clone = join(dir, "task", "repo");
      const gitDir = join(dir, "_git", "task.git");
      const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
      writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
      chmodSync(join(clone, "pay.ts"), 0o000);
      writeFileSync(join(clone, "other.ts"), "other\n");
      try {
        await expect(workspace.diffStats(clone, gitDir, baseCommit)).rejects.toThrow(/pay\.ts/);
        await expect(workspace.diff(clone, gitDir, baseCommit)).rejects.toThrow();
        await expect(
          workspace.publish({
            dir: clone,
            gitDir,
            baseCommit,
            parent: baseCommit,
            branch: "sacty/tracked-unreadable",
            message: "m",
            date: "2026-10-10T01:00:00.000Z",
          }),
        ).rejects.toThrow(/pay\.ts/);
      } finally {
        chmodSync(join(clone, "pay.ts"), 0o644);
      }
    },
  );

  it("読めないこと以外の git add の失敗は、読めない未追跡のファイルが混ざっていても、これまでどおり失敗にする（PBI-278）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    // コミットの無い入れ子のリポジトリは、git add が失敗する
    mkdirSync(join(clone, "nested"));
    git(join(clone, "nested"), "init", "--initial-branch=main");
    writeFileSync(join(clone, "nested", "a.txt"), "a\n");
    await expect(workspace.diffStats(clone, gitDir, baseCommit)).rejects.toThrow();
  });

  itUnreadable(
    "読めない未追跡のファイルと、読めないこと以外の git add の失敗が混ざっていても、失敗にする（PBI-278）",
    async () => {
      const origin = makeOrigin();
      const workspace = new GitRepositoryWorkspace();
      const clone = join(dir, "task", "repo");
      const gitDir = join(dir, "_git", "task.git");
      const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
      mkdirSync(join(clone, "nested"));
      git(join(clone, "nested"), "init", "--initial-branch=main");
      writeFileSync(join(clone, "nested", "a.txt"), "a\n");
      writeFileSync(join(clone, "locked.png"), "png");
      chmodSync(join(clone, "locked.png"), 0o000);
      try {
        // 読めないファイルだけなら進む（前提）
        rmSync(join(clone, "nested"), { recursive: true, force: true });
        expect(await workspace.diffStats(clone, gitDir, baseCommit)).toEqual([]);
        // 入れ子のリポジトリ（別種の失敗）が混ざると、読めないファイルがあっても失敗にする
        mkdirSync(join(clone, "nested"));
        git(join(clone, "nested"), "init", "--initial-branch=main");
        writeFileSync(join(clone, "nested", "a.txt"), "a\n");
        await expect(workspace.diffStats(clone, gitDir, baseCommit)).rejects.toThrow(/nested/);
      } finally {
        chmodSync(join(clone, "locked.png"), 0o644);
      }
    },
  );

  it("ファイルごとの変更は、差分の上限で切り詰めず、名前の変更を変更元の削除と変更先の追加に分ける", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");

    // 差分の上限を超える大きなファイルの後に、名前の変更がある
    writeFileSync(join(clone, "a-large.lock"), "x\n".repeat(DIFF_LIMIT));
    renameSync(join(clone, "pay.ts"), join(clone, "z-moved.ts"));
    expect(await workspace.diff(clone, gitDir, baseCommit)).not.toContain("z-moved.ts");
    expect(await workspace.diffStats(clone, gitDir, baseCommit)).toEqual([
      { path: "a-large.lock", added: DIFF_LIMIT, removed: 0 },
      { path: "pay.ts", added: 0, removed: 1 },
      { path: "z-moved.ts", added: 1, removed: 0 },
    ]);
  });

  it("作業領域の .gitattributes で差分を隠したファイル・バイナリも、中身の行の数で数える", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");

    writeFileSync(join(clone, ".gitattributes"), "pay.ts -diff\n");
    writeFileSync(join(clone, "pay.ts"), Array.from({ length: 301 }, (_, i) => `${i}\n`).join(""));
    writeFileSync(join(clone, "logo.bin"), Buffer.from([0, 1, 2, 10, 0, 3]));
    expect(await workspace.diffStats(clone, gitDir, baseCommit)).toEqual([
      { path: ".gitattributes", added: 1, removed: 0 },
      { path: "logo.bin", added: 2, removed: 0 },
      { path: "pay.ts", added: 301, removed: 1 },
    ]);
  });

  it("中身から数えるとき、消したファイルは変更後を 0 行にし、ある中身を読めなければ 0 行にせずに失敗にする", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");

    writeFileSync(join(clone, ".gitattributes"), "pay.ts -diff\n");
    rmSync(join(clone, "pay.ts"));
    expect(await workspace.diffStats(clone, gitDir, baseCommit)).toEqual([
      { path: ".gitattributes", added: 1, removed: 0 },
      { path: "pay.ts", added: 0, removed: 1 },
    ]);

    // cat-file だけが失敗する git（読み取りの失敗）
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = cat-file ] && { echo "fatal: read error" >&2; exit 128; }; done\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await expect(workspace.diffStats(clone, gitDir, baseCommit)).rejects.toThrow(/read error/);
    } finally {
      process.env.PATH = path;
    }
  });

  it("用意し直すときは、記録したブランチが消えていても、記録済みの起点のコミットにする（PBI-157 レビュー指摘）", async () => {
    const origin = makeOrigin();
    git(origin, "checkout", "-b", "feature");
    writeFileSync(join(origin, "feature.ts"), "feature\n");
    git(origin, "add", "--all");
    git(origin, "commit", "-m", "feature");
    const workspace = new GitRepositoryWorkspace();
    const first = await workspace.prepare(
      join(dir, "a"),
      join(dir, "_git", "a.git"),
      origin,
      "feature",
    );
    // PR のマージの後に、ブランチが消された（コミットは既定のブランチに取り込まれている）
    git(origin, "checkout", "main");
    git(origin, "merge", "--ff-only", "feature");
    git(origin, "branch", "-D", "feature");
    const again = await workspace.prepare(
      join(dir, "b"),
      join(dir, "_git", "b.git"),
      origin,
      "feature",
      undefined,
      first.baseCommit,
    );
    expect(again).toEqual({ baseCommit: first.baseCommit, baseBranch: "feature" });
    expect(existsSync(join(dir, "b", "feature.ts"))).toBe(true);
    expect(existsSync(join(dir, "_git", "b.git"))).toBe(true);
  });

  it("途中で止まった clone は作り直し、無いブランチは理由つきで失敗する", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "repo");
    mkdirSync(clone);
    writeFileSync(join(clone, "leftover"), "x");
    await workspace.prepare(clone, join(dir, "repo.git"), origin, "main");
    expect(existsSync(join(clone, "leftover"))).toBe(false);

    await expect(
      workspace.prepare(join(dir, "other"), join(dir, "other.git"), origin, "no-such-branch"),
    ).rejects.toThrow(/git clone に失敗しました/);
  });

  it("退避したメタデータでコミットしてプッシュし、再提出は前回のコミットに積む（PBI-10b）", async () => {
    const origin = makeOrigin();
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    const branch = "sacty/task-1234abcd";

    await expect(
      workspace.publish({
        dir: clone,
        gitDir,
        baseCommit,
        parent: baseCommit,
        branch,
        message: "m",
      }),
    ).rejects.toBeInstanceOf(NothingToCommitError);

    // エージェント（コンテナ）が、作業領域の git の設定を書き換えた
    const marker = join(dir, "pwned");
    git(clone, "config", "filter.evil.clean", `touch ${marker}; cat`);
    git(clone, "config", "core.hooksPath", dir);
    writeFileSync(join(clone, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");

    const first = await workspace.publish({
      dir: clone,
      gitDir,
      baseCommit,
      parent: baseCommit,
      branch,
      message: "決済API\n\nsacty task t1",
      date: "2026-10-10T01:00:00.000Z",
    });
    expect(existsSync(marker)).toBe(false);
    expect(git(origin, "rev-parse", branch)).toBe(first.commit);
    expect(git(origin, "show", `${branch}:pay.ts`)).toBe("export const pay = () => 1;");
    expect(git(origin, "log", "-1", "--format=%s", branch)).toBe("決済API");
    // 作業領域の HEAD は動かさない（コミットは退避したメタデータに作る）
    expect(git(clone, "rev-parse", "HEAD")).toBe(baseCommit);

    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 2;\n");
    const second = await workspace.publish({
      dir: clone,
      gitDir,
      baseCommit,
      parent: first.commit,
      branch,
      message: "m2",
      date: "2026-10-10T02:00:00.000Z",
    });
    expect(git(origin, "rev-parse", `${branch}^`)).toBe(first.commit);
    expect(git(origin, "rev-parse", branch)).toBe(second.commit);

    // 変わっていなければ、同じコミットのまま
    const third = await workspace.publish({
      dir: clone,
      gitDir,
      baseCommit,
      parent: second.commit,
      branch,
      message: "m3",
      date: "2026-10-10T03:00:00.000Z",
    });
    expect(third.commit).toBe(second.commit);
  });

  it("プッシュの後で止まって再開しても、同じ提出なら同じコミットを作り直し、プッシュが拒否されない（レビュー指摘）", async () => {
    const origin = makeOrigin();
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
    const input = {
      dir: clone,
      gitDir,
      baseCommit,
      parent: baseCommit,
      branch: "sacty/task-1234abcd",
      message: "決済API",
      date: "2026-10-10T01:00:00.000Z",
    };
    const first = await workspace.publish(input);
    // プッシュの後、作業履歴に記録する前に止まり、1秒以上たってから同じ入力で再開した
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const retried = await workspace.publish(input);
    expect(retried.commit).toBe(first.commit);
    expect(git(origin, "rev-parse", input.branch)).toBe(first.commit);
  });

  describe("ベースブランチの取り込み（マージコミット）", () => {
    /** 2行目をタスクが変える README を持つ origin から、作業領域を用意する。 */
    const prepareMerge = async () => {
      const origin = makeOrigin();
      git(origin, "config", "receive.denyCurrentBranch", "ignore");
      writeFileSync(join(origin, "README.md"), "# app\n\n1. one\n2. two\n3. three\n");
      git(origin, "add", "--all");
      git(origin, "commit", "-m", "readme");
      const workspace = new GitRepositoryWorkspace();
      const clone = join(dir, "task", "repo");
      const gitDir = join(dir, "_git", "task.git");
      const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
      return { origin, workspace, clone, gitDir, baseCommit, branch: "sacty/task-1234abcd" };
    };
    /** origin のベースブランチ（main）に、別のタスクがマージしたコミットを足す。 */
    const advanceMain = (origin: string, file: string, content: string) => {
      writeFileSync(join(origin, file), content);
      git(origin, "add", "--all");
      git(origin, "commit", "-m", `main: ${file}`);
      return git(origin, "rev-parse", "HEAD");
    };
    const parents = (origin: string, rev: string) =>
      git(origin, "log", "-1", "--format=%P", rev).split(" ").filter(Boolean);
    /** ブランチをベースブランチにマージするとき、競合するか（GitHub の「マージできる」の判定と同じ3方向のマージ）。 */
    const conflictsWith = (origin: string, main: string, branch: string) => {
      try {
        git(origin, "merge-tree", "--write-tree", "--name-only", main, branch);
        return false;
      } catch {
        return true;
      }
    };
    const isAncestor = (origin: string, a: string, b: string) => {
      try {
        git(origin, "merge-base", "--is-ancestor", a, b);
        return true;
      } catch {
        return false;
      }
    };

    itMerge(
      "競合しなければ、作業領域にベースブランチの変更が入り、提出は親が2つのマージコミットになる（履歴は書き換えない）",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit, branch } = await prepareMerge();
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
        const tip = advanceMain(origin, "other.ts", "export const other = 1;\n");
        expect(await workspace.fetchBranch(gitDir, "main")).toBe(tip);

        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: baseCommit,
          target: tip,
        });
        expect(merged).toEqual({ status: "merged", conflicts: [] });
        // 作業領域には、ベースブランチの変更と、タスクの変更の両方がある
        expect(readFileSync(join(clone, "other.ts"), "utf8")).toBe("export const other = 1;\n");
        expect(readFileSync(join(clone, "pay.ts"), "utf8")).toBe("export const pay = () => 1;\n");
        // 作業領域の HEAD・退避したメタデータのブランチは動かさない（コミットは提出のときに作る）
        expect(git(clone, "rev-parse", "HEAD")).toBe(baseCommit);

        const input = {
          dir: clone,
          gitDir,
          baseCommit: tip,
          merge: tip,
          parent: baseCommit,
          branch,
          message: "決済API",
          date: "2026-10-10T01:00:00.000Z",
        };
        const first = await workspace.publish(input);
        expect(parents(origin, branch)).toEqual([baseCommit, tip]);
        expect(git(origin, "rev-parse", branch)).toBe(first.commit);
        expect(git(origin, "show", `${branch}:other.ts`)).toBe("export const other = 1;");
        expect(git(origin, "show", `${branch}:pay.ts`)).toBe("export const pay = () => 1;");
        // ベースブランチの先頭を含む履歴なので、ベースブランチに早送りでマージできる（PR が競合しない）
        expect(isAncestor(origin, tip, branch)).toBe(true);
        expect(conflictsWith(origin, tip, branch)).toBe(false);
        expect(git(origin, "diff", "--stat", `${tip}...${branch}`)).toContain("pay.ts");
        expect(git(origin, "diff", "--name-only", `${tip}..${branch}`)).toBe("pay.ts");

        // 再開して同じ入力で作り直しても、同じマージコミットになる（プッシュ済みと枝分かれしない）
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect((await workspace.publish(input)).commit).toBe(first.commit);

        // 次の提出は、取り込み済みなので、前回のコミットだけを親にする
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 2;\n");
        const second = await workspace.publish({
          ...input,
          parent: first.commit,
          message: "m2",
          date: "2026-10-10T02:00:00.000Z",
        });
        expect(parents(origin, second.commit)).toEqual([first.commit]);
        // 変わっていなければ、同じコミットのまま
        const third = await workspace.publish({
          ...input,
          parent: second.commit,
          date: "2026-10-10T03:00:00.000Z",
        });
        expect(third.commit).toBe(second.commit);
      },
    );

    itMerge(
      "競合したファイルには目印を残して返し、解消するまで目印を検出し、解消した内容をマージコミットで出す",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit, branch } = await prepareMerge();
        // タスクは2行目を変え、別のタスクも同じ行を変えてマージした
        writeFileSync(join(clone, "README.md"), "# app\n\n1. one\n2. two (mine)\n3. three\n");
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
        const tip = advanceMain(
          origin,
          "README.md",
          "# app\n\n1. one\n2. two (theirs)\n3. three\n",
        );
        await workspace.fetchBranch(gitDir, "main");

        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: baseCommit,
          target: tip,
        });
        expect(merged).toEqual({ status: "conflicted", conflicts: ["README.md"] });
        const text = readFileSync(join(clone, "README.md"), "utf8");
        expect(text).toMatch(/^<{7} /m);
        expect(text).toMatch(/^={7}$/m);
        expect(text).toMatch(/^>{7} /m);
        // 上が作業領域の側、下がベースブランチの側
        expect(text.indexOf("(mine)")).toBeLessThan(text.indexOf("(theirs)"));
        // 競合しなかったファイルは、そのまま
        expect(readFileSync(join(clone, "pay.ts"), "utf8")).toBe("export const pay = () => 1;\n");
        expect(await workspace.conflictMarkers(clone, ["README.md", "pay.ts"])).toEqual([
          "README.md",
        ]);

        // 目印をすべて消して解消すると、目印は検出されない
        writeFileSync(
          join(clone, "README.md"),
          "# app\n\n1. one\n2. two (mine) (theirs)\n3. three\n",
        );
        expect(await workspace.conflictMarkers(clone, ["README.md"])).toEqual([]);
        const resolved = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit: tip,
          merge: tip,
          parent: baseCommit,
          branch,
          message: "決済API",
          date: "2026-10-10T01:00:00.000Z",
        });
        expect(parents(origin, resolved.commit)).toEqual([baseCommit, tip]);
        // 比較：取り込まずに（親が1つで）同じ内容を出すと、ベースブランチと競合したままになる（S7 の PR の状態）
        const plain = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit: tip,
          parent: baseCommit,
          branch: "sacty/task-plain",
          message: "決済API",
          date: "2026-10-10T01:00:00.000Z",
        });
        expect(parents(origin, plain.commit)).toEqual([baseCommit]);
        expect(conflictsWith(origin, tip, "sacty/task-plain")).toBe(true);
        expect(git(origin, "show", `${branch}:README.md`)).toContain("two (mine) (theirs)");
        expect(git(origin, "show", `${branch}:README.md`)).not.toContain("<<<<<<<");
        expect(isAncestor(origin, tip, branch)).toBe(true);
        expect(conflictsWith(origin, tip, branch)).toBe(false);
        // ベースブランチ側の変更を、自分の変更として混ぜない：ベースブランチとの差は、タスクの2ファイルだけ
        expect(git(origin, "diff", "--name-only", `${tip}..${branch}`).split("\n").sort()).toEqual([
          "README.md",
          "pay.ts",
        ]);
      },
    );

    itMerge(
      "タスクブランチに積んだ要求要件・設計のファイルを引き継ぐ提出（keep）も、ベースブランチの先頭を第2の親にしたマージコミットになる",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
        const taskBranch = "sacty/task-1234abcd";
        const path = "docs/sacty/1234abcd/requirements.md";
        // タスクブランチには、要求要件のファイルが積まれている（作業領域には無い）
        await workspace.pushCommit(gitDir, baseCommit, taskBranch);
        const step = await workspace.commitFiles({
          gitDir,
          parent: baseCommit,
          files: { [path]: "# 要求要件\n" },
          branch: taskBranch,
          message: "[要求要件]",
          date: "2026-10-10T01:00:00.000Z",
        });
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
        const tip = advanceMain(origin, "other.ts", "o\n");
        await workspace.fetchBranch(gitDir, "main");
        await workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: tip });
        const parent = await workspace.fetchBranch(gitDir, taskBranch);
        expect(parent).toBe(step.commit);
        const published = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit: tip,
          merge: tip,
          parent,
          branch: taskBranch,
          message: "決済API",
          date: "2026-10-10T02:00:00.000Z",
          keep: { commit: parent, paths: [path] },
        });
        expect(parents(origin, published.commit)).toEqual([step.commit, tip]);
        expect(git(origin, "show", `${taskBranch}:${path}`)).toBe("# 要求要件");
        expect(git(origin, "show", `${taskBranch}:other.ts`)).toBe("o");
        expect(git(origin, "show", `${taskBranch}:pay.ts`)).toContain("pay = () => 1");
        expect(conflictsWith(origin, tip, taskBranch)).toBe(false);
        expect(
          git(origin, "diff", "--name-only", `${tip}..${taskBranch}`).split("\n").sort(),
        ).toEqual([path, "pay.ts"]);
      },
    );

    itMerge(
      "競合の目印は、ID のラベルが付いた始めの行か終わりの行が1つでも残っていれば検出する（消し忘れも）。ラベルの無い似た行や単独の =======、シンボリックリンク・無いファイル・作業領域の外は見ない",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
        writeFileSync(join(clone, "README.md"), "# app\n\n1. one\n2. two (mine)\n3. three\n");
        const tip = advanceMain(
          origin,
          "README.md",
          "# app\n\n1. one\n2. two (theirs)\n3. three\n",
        );
        await workspace.fetchBranch(gitDir, "main");
        await workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: tip });
        const conflicted = readFileSync(join(clone, "README.md"), "utf8");
        const lines = conflicted.split("\n");
        const start = lines.findIndex((l) => l.startsWith("<<<<<<< "));
        const sep = lines.indexOf("=======");
        const end = lines.findIndex((l) => l.startsWith(">>>>>>> "));
        expect([start, sep, end].every((i) => i >= 0)).toBe(true);
        const without = (...drop: number[]) => lines.filter((_, i) => !drop.includes(i)).join("\n");
        const detect = async (text: string) => {
          writeFileSync(join(clone, "README.md"), text);
          return workspace.conflictMarkers(clone, ["README.md"]);
        };
        // 消さずに残っている・始めの行だけ残っている・終わりの行だけ残っている
        expect(await detect(conflicted)).toEqual(["README.md"]);
        expect(await detect(without(sep, end))).toEqual(["README.md"]);
        expect(await detect(without(start, sep))).toEqual(["README.md"]);
        // 始めと終わりの行を消せば、解消している（単独の ======= は、Markdown の見出しの下線と区別できないので見ない）
        expect(await detect(without(start, end))).toEqual([]);
        expect(await detect(without(start, sep, end))).toEqual([]);

        // ラベルの無い似た行や、見出しの下線は目印にしない
        writeFileSync(join(clone, "heading.md"), "Title\n=======\n\ntext\n");
        writeFileSync(
          join(clone, "similar.md"),
          "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n<<<<<<< ours\n>>>>>>> theirs\n",
        );
        const outside = join(dir, "outside.txt");
        writeFileSync(outside, `<<<<<<< ${"a".repeat(40)}\n>>>>>>> ${"b".repeat(40)}\n`);
        symlinkSync(outside, join(clone, "link.txt"));
        expect(
          await workspace.conflictMarkers(clone, [
            "heading.md",
            "similar.md",
            "link.txt",
            "missing.txt",
            "../outside.txt",
          ]),
        ).toEqual([]);
        expect(await workspace.conflictMarkers(join(dir, "missing"), ["README.md"])).toEqual([]);
      },
    );

    itMerge(
      "ディレクトリとファイルの名前が衝突して git が避けた名前（<名前>~<ID>）は、残っているうちは解消していないものとする",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
        // タスクは docs というファイルを足し、別のタスクは docs/ ディレクトリを足してマージした
        writeFileSync(join(clone, "docs"), "mine\n");
        mkdirSync(join(origin, "docs"));
        const tip = advanceMain(origin, "docs/a.md", "theirs\n");
        await workspace.fetchBranch(gitDir, "main");
        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: baseCommit,
          target: tip,
        });
        expect(merged.status).toBe("conflicted");
        const renamed = merged.conflicts.filter((c) => /~[0-9a-f]{40,}$/.test(c));
        expect(renamed).toHaveLength(1);
        expect(existsSync(join(clone, renamed[0] as string))).toBe(true);
        // 避けた名前のファイルが残っている間は、解消していない（目印は無くても）
        expect(await workspace.conflictMarkers(clone, merged.conflicts)).toEqual(renamed);
        // 消せば解消（ディレクトリ側の docs は、残す側として決めた）
        rmSync(join(clone, renamed[0] as string));
        expect(await workspace.conflictMarkers(clone, merged.conflicts)).toEqual([]);
      },
    );

    itMerge(
      "両側が同じファイルを別名へ改名して内容も競合したとき、git が書く長い目印（<<<<<<<<）とパス付きのラベルも、残っているうちは解消していないものとする",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
        // 作業領域は README.md を ours.md に改名して内容を変え、別のタスクは theirs.md に改名して同じ行を変えてマージした
        renameSync(join(clone, "README.md"), join(clone, "ours.md"));
        writeFileSync(join(clone, "ours.md"), "# app\n\n1. one\n2. two (mine)\n3. three\n");
        git(origin, "mv", "README.md", "theirs.md");
        const tip = advanceMain(
          origin,
          "theirs.md",
          "# app\n\n1. one\n2. two (theirs)\n3. three\n",
        );
        await workspace.fetchBranch(gitDir, "main");
        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: baseCommit,
          target: tip,
        });
        expect(merged.status).toBe("conflicted");
        expect(merged.conflicts.length).toBeGreaterThan(0);
        // 実際に git が書いた目印は、7文字より長く、ID にパスが付いている
        const marked = merged.conflicts.filter(
          (c) =>
            existsSync(join(clone, c)) &&
            /^<{8,} [0-9a-f]{40,}:/m.test(readFileSync(join(clone, c), "utf8")),
        );
        expect(marked.length).toBeGreaterThan(0);
        expect(await workspace.conflictMarkers(clone, marked)).toEqual(marked);
        // 目印の行を消せば、解消したことになる
        for (const c of marked) {
          const text = readFileSync(join(clone, c), "utf8")
            .split("\n")
            .filter((line) => !/^([<>]{8,} [0-9a-f]{40,}|={8,}$)/.test(line))
            .join("\n");
          writeFileSync(join(clone, c), text);
        }
        expect(await workspace.conflictMarkers(clone, marked)).toEqual([]);
      },
    );

    it("目印の検査でファイルを読めないとき（権限など）は、目印なしとせず、パスと原因を付けて失敗する。ファイルが無い・途中が通常のファイルなら、解消済みとする", async () => {
      const { workspace, clone } = await prepareMerge();
      const id = "a".repeat(40);
      writeFileSync(join(clone, "locked.txt"), `<<<<<<< ${id}\nx\n>>>>>>> ${id}\n`);
      writeFileSync(join(clone, "plain"), "x\n");
      // 消した・親がファイルに置き換わった（ENOENT・ENOTDIR）は、解消した
      expect(await workspace.conflictMarkers(clone, ["gone.txt", "plain/child.txt"])).toEqual([]);
      if (process.getuid?.() === 0) return; // root は権限に関係なく読める
      chmodSync(join(clone, "locked.txt"), 0o000);
      try {
        await expect(workspace.conflictMarkers(clone, ["locked.txt"])).rejects.toThrow(
          /locked\.txt.*EACCES/,
        );
      } finally {
        chmodSync(join(clone, "locked.txt"), 0o644);
      }
      // 権限を戻せば、同じファイルの目印を検出する
      expect(await workspace.conflictMarkers(clone, ["locked.txt"])).toEqual(["locked.txt"]);
    });

    it("競合の目印の行の見分け：長い目印・パス付きのラベルは目印とし、ラベルの無い似た行・短い ID は目印としない", async () => {
      const { workspace, clone } = await prepareMerge();
      const id = "a".repeat(40);
      const check = async (text: string) => {
        writeFileSync(join(clone, "x.txt"), text);
        return (await workspace.conflictMarkers(clone, ["x.txt"])).length === 1;
      };
      expect(await check(`<<<<<<<< ${id}:ours.txt\nx\n`)).toBe(true);
      expect(await check(`x\n>>>>>>>>> ${id}:dir/with space.txt\n`)).toBe(true);
      expect(await check(`<<<<<<< ${id}\r\nx\n`)).toBe(true);
      expect(await check(`<<<<<<< ${id}:\n`)).toBe(true);
      expect(await check(`<<<<<<< HEAD\nx\n>>>>>>> branch\n`)).toBe(false);
      expect(await check(`<<<<<<<< abc123:ours.txt\n`)).toBe(false);
      expect(await check(`<<<<<< ${id}\n`)).toBe(false);
      expect(await check(`text <<<<<<<< ${id}\n`)).toBe(false);
      expect(await check("Title\n=======\n")).toBe(false);
    });

    itMerge(
      "競合したファイルが上限を超えるときは、作業領域を書き換えずに、件数と上限を示して失敗する。上限以内なら取り込む",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
        // 3つのファイルが競合する
        for (const name of ["a.txt", "b.txt", "c.txt"]) {
          writeFileSync(join(clone, name), `${name} mine\n`);
          writeFileSync(join(origin, name), `${name} theirs\n`);
        }
        git(origin, "add", "--all");
        git(origin, "commit", "-m", "main: three files");
        const tip = git(origin, "rev-parse", "HEAD");
        await workspace.fetchBranch(gitDir, "main");
        const before = readFileSync(join(clone, "a.txt"), "utf8");
        await expect(
          workspace.mergeBase({
            dir: clone,
            gitDir,
            base: baseCommit,
            target: tip,
            maxConflicts: 2,
          }),
        ).rejects.toThrow(/3 件.*2 件/);
        // 作業領域は書き換えていない（目印は入っていない）
        expect(readFileSync(join(clone, "a.txt"), "utf8")).toBe(before);
        expect(await workspace.conflictMarkers(clone, ["a.txt", "b.txt", "c.txt"])).toEqual([]);
        // 上限と同じ件数なら取り込む
        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: baseCommit,
          target: tip,
          maxConflicts: 3,
        });
        expect(merged.status).toBe("conflicted");
        expect(merged.conflicts.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
      },
    );

    it("この環境の git が merge-tree --merge-base（2.40 以上）を使えるか。使えないときは、実際に使うテストを飛ばしたことを、理由つきで出す", ({
      skip,
    }) => {
      if (!MERGE_BASE_SUPPORTED) {
        skip(
          `git が 2.40 未満（${git(tmpdir(), "--version")}）なので、ベースブランチの取り込みを実際に動かすテストを飛ばした`,
        );
      }
      expect(MERGE_BASE_SUPPORTED).toBe(true);
    });

    it("git が 2.40 未満（merge-tree --merge-base が使い方の誤り＝終了コード 129）なら、作業領域を書き換えずに、2.40 以上が必要だと案内して失敗する（git の版は偽って試す）", async () => {
      const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
      writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
      const tip = advanceMain(origin, "other.ts", "export const other = 1;\n");
      await workspace.fetchBranch(gitDir, "main");
      // 本物の git に渡し、merge-tree の --merge-base だけ、古い git と同じ終了コード 129 で失敗する git を、PATH の先頭に置く
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const fakeDir = join(dir, "fake-bin");
      mkdirSync(fakeDir);
      writeFileSync(
        join(fakeDir, "git"),
        `#!/bin/sh\ncase " $* " in\n  *" merge-tree "*--merge-base*) echo "error: unknown option 'merge-base'" >&2; exit 129;;\nesac\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );
      const path = process.env.PATH;
      process.env.PATH = `${fakeDir}${delimiter}${path ?? ""}`;
      try {
        await expect(
          workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: tip }),
        ).rejects.toThrow(/2\.40 以上/);
      } finally {
        process.env.PATH = path;
      }
      // 作業領域は書き換えていない
      expect(readFileSync(join(clone, "pay.ts"), "utf8")).toBe("export const pay = () => 1;\n");
      expect(existsSync(join(clone, "other.ts"))).toBe(false);
    });

    itMerge(
      "取り込むものが無ければ何もせず、作業領域の変更は消えない。ベースブランチが続けて進んだら、前に取り込んだ先頭を起点に取り込む",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit, branch } = await prepareMerge();
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
        // 先頭が起点と同じ・起点の履歴に含まれる
        expect(
          await workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: baseCommit }),
        ).toEqual({ status: "unchanged", conflicts: [] });
        expect(readFileSync(join(clone, "pay.ts"), "utf8")).toBe("export const pay = () => 1;\n");

        const first = advanceMain(origin, "a.ts", "a\n");
        await workspace.fetchBranch(gitDir, "main");
        await workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: first });
        expect(
          await workspace.mergeBase({ dir: clone, gitDir, base: first, target: baseCommit }),
        ).toEqual({ status: "unchanged", conflicts: [] });
        const published = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit: first,
          merge: first,
          parent: baseCommit,
          branch,
          message: "m",
          date: "2026-10-10T01:00:00.000Z",
        });
        // その後にまた進んだ
        const second = advanceMain(origin, "b.ts", "b\n");
        await workspace.fetchBranch(gitDir, "main");
        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: first,
          target: second,
        });
        expect(merged.status).toBe("merged");
        expect(existsSync(join(clone, "b.ts"))).toBe(true);
        const next = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit: second,
          merge: second,
          parent: published.commit,
          branch,
          message: "m2",
          date: "2026-10-10T02:00:00.000Z",
        });
        expect(parents(origin, next.commit)).toEqual([published.commit, second]);
        expect(isAncestor(origin, second, branch)).toBe(true);
      },
    );

    itMerge(
      "作業領域の git の設定（フィルター・フック）は使わない。不正なコミットは受け付けない",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit } = await prepareMerge();
        const marker = join(dir, "pwned");
        git(clone, "config", "filter.evil.clean", `touch ${marker}; cat`);
        git(clone, "config", "core.hooksPath", dir);
        writeFileSync(join(clone, ".gitattributes"), "* filter=evil merge=evil\n");
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
        const tip = advanceMain(origin, "other.ts", "o\n");
        await workspace.fetchBranch(gitDir, "main");
        await workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: tip });
        expect(existsSync(marker)).toBe(false);
        await expect(
          workspace.mergeBase({ dir: clone, gitDir, base: "main", target: tip }),
        ).rejects.toThrow();
        await expect(
          workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: "--upload-pack=x" }),
        ).rejects.toThrow();
        await expect(
          workspace.publish({
            dir: clone,
            gitDir,
            baseCommit,
            merge: "not-a-commit",
            parent: baseCommit,
            branch: "sacty/task-1",
            message: "m",
            date: "2026-10-10T01:00:00.000Z",
          }),
        ).rejects.toThrow();
      },
    );

    itMerge(
      "人が PR のブランチに足したコミットを、sacty が最後にプッシュしたコミットを共通の祖先にして取り込み、その先頭に積める（外すパスは取り込まない。PBI-334）",
      async () => {
        const { origin, workspace, clone, gitDir, baseCommit, branch } = await prepareMerge();
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
        const pushed = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit,
          parent: baseCommit,
          branch,
          message: "決済API",
          date: "2026-10-10T01:00:00.000Z",
        });
        // 人が、PR のブランチに、README の直しと新しいファイルと、外すパス（タスクブランチの要求要件）の変更を積んだ
        const human = join(dir, "human");
        git(origin, "worktree", "add", human, branch);
        writeFileSync(
          join(human, "README.md"),
          "# app\n\n1. one\n2. two\n3. three（人が直した）\n",
        );
        writeFileSync(join(human, "human.ts"), "export const human = 1;\n");
        mkdirSync(join(human, "docs"), { recursive: true });
        writeFileSync(join(human, "docs", "req.md"), "# 要求要件\n");
        git(human, "add", "--all");
        git(human, "commit", "-m", "human");
        const head = git(human, "rev-parse", "HEAD");
        expect(await workspace.fetchBranch(gitDir, branch)).toBe(head);
        // sacty はその間に、作業領域で実装を直していた
        writeFileSync(join(clone, "pay.ts"), "export const pay = () => 2;\n");

        const merged = await workspace.mergeBase({
          dir: clone,
          gitDir,
          base: pushed.commit,
          target: head,
          exclude: ["docs/req.md"],
        });
        expect(merged).toEqual({ status: "merged", conflicts: [] });
        expect(readFileSync(join(clone, "README.md"), "utf8")).toContain("3. three（人が直した）");
        expect(readFileSync(join(clone, "human.ts"), "utf8")).toBe("export const human = 1;\n");
        expect(readFileSync(join(clone, "pay.ts"), "utf8")).toBe("export const pay = () => 2;\n");
        // 外したパスは、作業領域に入れない（提出のときに keep で引き継ぐ）
        expect(existsSync(join(clone, "docs", "req.md"))).toBe(false);

        // 人の先頭を親にして積めば、強制プッシュせずに更新できる
        const next = await workspace.publish({
          dir: clone,
          gitDir,
          baseCommit,
          parent: head,
          branch,
          message: "決済API",
          date: "2026-10-10T02:00:00.000Z",
        });
        expect(parents(origin, next.commit)).toEqual([head]);
        expect(git(origin, "show", `${branch}:pay.ts`)).toBe("export const pay = () => 2;");
        expect(git(origin, "show", `${branch}:human.ts`)).toBe("export const human = 1;");
      },
    );

    itMerge(
      "競合したのに git が競合したファイルを示さないとき（ディレクトリの移動先を決められない）は、作業領域を書き換えずに失敗する（PBI-334）",
      async () => {
        const origin = makeOrigin();
        git(origin, "config", "receive.denyCurrentBranch", "ignore");
        mkdirSync(join(origin, "a"));
        writeFileSync(join(origin, "a", "x"), "x\n");
        writeFileSync(join(origin, "a", "y"), "y\n");
        git(origin, "add", "--all");
        git(origin, "commit", "-m", "dir");
        const workspace = new GitRepositoryWorkspace();
        const clone = join(dir, "task", "repo");
        const gitDir = join(dir, "_git", "task.git");
        const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
        // 実装は a/ の中身を b/ と c/ に分けて移し、ベースブランチの側は a/ にファイルを足した（足したファイルの行き先が決まらない）
        mkdirSync(join(clone, "b"));
        mkdirSync(join(clone, "c"));
        renameSync(join(clone, "a", "x"), join(clone, "b", "x"));
        renameSync(join(clone, "a", "y"), join(clone, "c", "y"));
        writeFileSync(join(origin, "a", "z"), "z\n");
        git(origin, "add", "--all");
        git(origin, "commit", "-m", "main: a/z");
        const tip = await workspace.fetchBranch(gitDir, "main");
        await expect(
          workspace.mergeBase({ dir: clone, gitDir, base: baseCommit, target: tip }),
        ).rejects.toThrow(/競合したファイルを示しませんでした/);
        expect(existsSync(join(clone, "a", "z"))).toBe(false);
        expect(existsSync(join(clone, "b", "x"))).toBe(true);
      },
    );

    it("外すパスに、作業領域の外を指すものや .git は受け付けない（PBI-334）", async () => {
      const { workspace, clone, gitDir, baseCommit } = await prepareMerge();
      for (const exclude of [["../x"], [".git/config"], ["/etc/passwd"], ["a//b"]]) {
        await expect(
          workspace.mergeBase({
            dir: clone,
            gitDir,
            base: baseCommit,
            target: baseCommit,
            exclude,
          }),
        ).rejects.toThrow();
      }
    });
  });

  /**
   * タスクの作業領域を用意する（PBI-57 の確かめの共通の準備）。1つのテストで全部を確かめると、git を数十回動かすので、
   * 負荷が高いと時間切れ（30秒）を超える。マージの前と後で2つのテストに分け、準備はここでそろえる。
   */
  const prepareTask = async () => {
    const origin = makeOrigin();
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    const taskBranch = "sacty/task-1234abcd";
    const stepBranch = `${taskBranch}-requirements-1`;
    const path = "docs/sacty/1234abcd/requirements.md";
    const input = {
      gitDir,
      parent: baseCommit,
      files: { [path]: "# 要求要件\n" },
      branch: stepBranch,
      message: "[要求要件] 決済API\n\nsacty task t1",
      date: "2026-10-10T01:00:00.000Z",
      allowEmpty: true,
    };
    return { origin, workspace, clone, gitDir, baseCommit, taskBranch, stepBranch, path, input };
  };

  it("タスクブランチを作り、成果のファイルを工程のブランチにコミットし、実装はタスクブランチのファイルを引き継いで積む（PBI-57）：タスクブランチと、工程のブランチへの成果のファイルのコミット・受け付けないパス・ブランチの削除", async () => {
    const { origin, workspace, clone, gitDir, baseCommit, taskBranch, stepBranch, path, input } =
      await prepareTask();

    // タスクブランチは、起点のコミットから作る
    await workspace.pushCommit(gitDir, baseCommit, taskBranch);
    expect(git(origin, "rev-parse", taskBranch)).toBe(baseCommit);
    // 同じコミットをもう一度プッシュしても失敗しない（作った後・記録の前に止まって再開した）
    await workspace.pushCommit(gitDir, baseCommit, taskBranch);

    // エージェント（コンテナ）が作業領域の git の設定を書き換えていても、評価しない
    const marker = join(dir, "pwned");
    git(clone, "config", "filter.evil.clean", `touch ${marker}; cat`);
    writeFileSync(join(clone, ".gitattributes"), "* filter=evil\n");
    const first = await workspace.commitFiles(input);
    expect(existsSync(marker)).toBe(false);
    expect(git(origin, "rev-parse", `${stepBranch}^`)).toBe(baseCommit);
    expect(git(origin, "show", `${stepBranch}:${path}`)).toBe("# 要求要件");
    expect(git(origin, "show", `${stepBranch}:pay.ts`)).toBe("export const pay = () => 0;");
    // 作業領域は使わない（HEAD も変えない）
    expect(git(clone, "rev-parse", "HEAD")).toBe(baseCommit);
    // 同じ提出なら、再開しても同じコミットを作り直す（プッシュが拒否されない）
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await workspace.commitFiles(input)).commit).toBe(first.commit);
    // 内容が変わらなければ、積む先のコミットをそのまま使う（同じ PR を更新するとき）
    expect(
      (await workspace.commitFiles({ ...input, parent: first.commit, allowEmpty: false })).commit,
    ).toBe(first.commit);
    // 新しい PR のために、内容が同じでもコミットを作れる
    const empty = await workspace.commitFiles({
      ...input,
      parent: first.commit,
      branch: `${taskBranch}-requirements-2`,
    });
    expect(empty.commit).not.toBe(first.commit);

    // リポジトリの外・.git を指すパスは受け付けない
    for (const bad of ["../x.md", ".git/config", "/abs.md", "a//b.md"]) {
      await expect(workspace.commitFiles({ ...input, files: { [bad]: "x" } })).rejects.toThrow(
        /パスが不正/,
      );
    }
    // すでに無い sacty のブランチ（マージの後に GitHub が消した）を消しても、失敗にしない
    await workspace.deleteBranch(gitDir, `${taskBranch}-design-9`);
    await workspace.deleteBranch(gitDir, stepBranch);
    expect(git(origin, "branch", "--list", stepBranch)).toBe("");
  });

  it("タスクブランチを作り、成果のファイルを工程のブランチにコミットし、実装はタスクブランチのファイルを引き継いで積む（PBI-57）：マージ後のタスクブランチに、成果のファイルを引き継いで実装を積む", async () => {
    const { origin, workspace, clone, gitDir, baseCommit, taskBranch, stepBranch, path, input } =
      await prepareTask();
    await workspace.pushCommit(gitDir, baseCommit, taskBranch);
    await workspace.commitFiles(input);
    // GitHub で、要求要件の PR がタスクブランチにマージされた
    git(origin, "checkout", "--quiet", taskBranch);
    git(origin, "merge", "--quiet", "--no-ff", stepBranch, "-m", "merge requirements");
    git(origin, "checkout", "--quiet", "main");
    const head = await workspace.fetchBranch(gitDir, taskBranch);
    expect(head).toBe(git(origin, "rev-parse", taskBranch));

    // 実装は、タスクブランチの最新に積む。成果のファイルは作業領域に無いが、タスクブランチのものを引き継ぐ
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
    const implemented = await workspace.publish({
      dir: clone,
      gitDir,
      baseCommit,
      parent: head,
      branch: taskBranch,
      message: "決済API",
      date: "2026-10-10T02:00:00.000Z",
      keep: { commit: head, paths: [path, "docs/sacty/1234abcd/design.md"] },
    });
    expect(git(origin, "rev-parse", `${taskBranch}^`)).toBe(head);
    expect(git(origin, "show", `${taskBranch}:${path}`)).toBe("# 要求要件");
    expect(git(origin, "show", `${taskBranch}:pay.ts`)).toBe("export const pay = () => 1;");
    expect(implemented.commit).toBe(git(origin, "rev-parse", taskBranch));
    // sacty が積んだ後の、タスクブランチの変更のパス（人が直接積んだ変更を見つける。レビュー指摘）
    expect(await workspace.changedPaths(gitDir, implemented.commit, implemented.commit)).toEqual(
      [],
    );
    git(origin, "checkout", "--quiet", taskBranch);
    writeFileSync(join(origin, "human-fix.ts"), "export const fix = 1;\n");
    git(origin, "add", "human-fix.ts");
    git(origin, "commit", "--quiet", "-m", "human fix");
    git(origin, "checkout", "--quiet", "main");
    const touched = await workspace.fetchBranch(gitDir, taskBranch);
    expect(await workspace.changedPaths(gitDir, implemented.commit, touched)).toEqual([
      "human-fix.ts",
    ]);
    expect(await workspace.changedPaths(gitDir, baseCommit, head)).toEqual([path]);
    await expect(workspace.changedPaths(gitDir, "--output=x", touched)).rejects.toThrow();
    // 作業領域に変更が無ければ、引き継ぐファイルがあってもコミットしない
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 0;\n");
    await expect(
      workspace.publish({
        dir: clone,
        gitDir,
        baseCommit,
        parent: implemented.commit,
        branch: taskBranch,
        message: "m",
        date: "2026-10-10T03:00:00.000Z",
        keep: { commit: head, paths: [path] },
      }),
    ).rejects.toBeInstanceOf(NothingToCommitError);
  });

  it("人が PR の中で直してマージした成果のファイルを、マージ後のタスクブランチから、退避したメタデータで読む（PBI-63）", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    const taskBranch = "sacty/task-1234abcd";
    const stepBranch = `${taskBranch}-requirements-1`;
    const path = "docs/sacty/1234abcd/requirements.md";
    await workspace.pushCommit(gitDir, baseCommit, taskBranch);
    await workspace.commitFiles({
      gitDir,
      parent: baseCommit,
      files: {
        [path]: "<!-- sacty task t1 の要求要件。sacty が作成しました。 -->\n\n# 要求要件\n",
      },
      branch: stepBranch,
      message: "[要求要件] 決済API",
      date: "2026-10-10T01:00:00.000Z",
      allowEmpty: true,
    });
    // GitHub で、人が PR の中でファイルを直し（大きな日本語の本文。読み込みの区切りで文字が壊れないこと）、マージした
    const human = `# 要求要件（人が直した）\n\n${"返金も扱う。".repeat(30_000)}\n`;
    git(origin, "checkout", "--quiet", stepBranch);
    writeFileSync(join(origin, path), human);
    writeFileSync(join(origin, "binary.md"), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x41]));
    writeFileSync(join(origin, "nul.md"), "a\0b");
    writeFileSync(join(origin, "big.md"), "a".repeat(1024 * 1024 + 1));
    symlinkSync("../../../pay.ts", join(origin, "docs/sacty/1234abcd/design.md"));
    git(origin, "add", "--all");
    git(origin, "commit", "--quiet", "-m", "human edit");
    git(origin, "checkout", "--quiet", taskBranch);
    git(origin, "merge", "--quiet", "--no-ff", stepBranch, "-m", "merge requirements");
    const merged = git(origin, "rev-parse", "HEAD");
    // マージの後に、タスクブランチへ未レビューの変更が積まれた
    writeFileSync(join(origin, path), "Later unreviewed change\n");
    git(origin, "commit", "--quiet", "-am", "later");
    git(origin, "checkout", "--quiet", "main");
    // 作業領域の git の設定（エージェントが書き換えうる）は評価しない
    const marker = join(dir, "pwned");
    git(clone, "config", "filter.evil.smudge", `touch ${marker}; cat`);
    writeFileSync(join(clone, ".gitattributes"), "* filter=evil\n");

    const tip = await workspace.fetchBranch(gitDir, taskBranch);
    expect(tip).not.toBe(merged);
    await workspace.fetchCommits(gitDir, [merged]);
    // マージのコミットからは承認する本文、先端からは後の変更が読める（先端は読まないこと）
    expect(await workspace.readFile(gitDir, merged, path)).toBe(human);
    expect(await workspace.readFile(gitDir, tip, path)).toBe("Later unreviewed change\n");
    expect(existsSync(marker)).toBe(false);
    // マージの前（起点）には無い
    expect(await workspace.readFile(gitDir, baseCommit, path)).toBeUndefined();
    // 消されたファイル
    expect(await workspace.readFile(gitDir, merged, "docs/sacty/1234abcd/missing.md")).toBe(
      undefined,
    );
    // テキストでない・大きすぎる・シンボリックリンク・ディレクトリは読めない
    await expect(workspace.readFile(gitDir, merged, "binary.md")).rejects.toThrow(/UTF-8/);
    await expect(workspace.readFile(gitDir, merged, "nul.md")).rejects.toThrow(/UTF-8/);
    await expect(workspace.readFile(gitDir, merged, "big.md")).rejects.toThrow(/大きすぎます/);
    await expect(
      workspace.readFile(gitDir, merged, "docs/sacty/1234abcd/design.md"),
    ).rejects.toThrow(/通常のファイルではありません/);
    await expect(workspace.readFile(gitDir, merged, "docs/sacty")).rejects.toThrow(
      /通常のファイルではありません/,
    );
    // リポジトリの外・オプションに見えるもの・不正なコミットは受け付けない
    for (const bad of ["../x.md", ".git/config", "/abs.md", "--output=x"]) {
      await expect(workspace.readFile(gitDir, merged, bad)).rejects.toThrow(/パスが不正/);
    }
    await expect(workspace.readFile(gitDir, "HEAD", path)).rejects.toThrow();
  });

  it("任意の名前の読み方（anyName）は、日本語・空白・記号の名前も読み、リポジトリの外へ出るパス・シンボリックリンクは読まない（PR #304 のレビュー）", async () => {
    const origin = makeOrigin();
    mkdirSync(join(origin, "docs"));
    const names = ["docs/日本語.md", "docs/guide name.md", 'docs/q"t.md', "docs/a*b.md"];
    for (const name of names) writeFileSync(join(origin, name), `${name} の本文\n`);
    writeFileSync(join(origin, "docs/x.md"), "x\n");
    symlinkSync("../pay.ts", join(origin, "docs/リンク.md"));
    git(origin, "add", "--all");
    git(origin, "commit", "--quiet", "-m", "names");
    const workspace = new GitRepositoryWorkspace();
    const gitDir = join(dir, "_git", "n.git");
    const { baseCommit } = await workspace.prepare(join(dir, "n"), gitDir, origin, "main");
    for (const name of names) {
      expect(await workspace.readFile(gitDir, baseCommit, name, { anyName: true }), name).toBe(
        `${name} の本文\n`,
      );
      // ほかの読み方（anyName を付けない）は、これまでどおり受け付けない
      await expect(workspace.readFile(gitDir, baseCommit, name), name).rejects.toThrow(
        /パスが不正/,
      );
    }
    // パスの指定の特別な書き方として読まない（* は字のまま。docs/x.md に一致させない）
    expect(await workspace.readFile(gitDir, baseCommit, "docs/*.md", { anyName: true })).toBe(
      undefined,
    );
    expect(
      await workspace.readFile(gitDir, baseCommit, ":(glob)docs/*.md", { anyName: true }),
    ).toBe(undefined);
    // 無いファイルは undefined。シンボリックリンクは通常のファイルでないので読まない
    expect(await workspace.readFile(gitDir, baseCommit, "docs/無い.md", { anyName: true })).toBe(
      undefined,
    );
    await expect(
      workspace.readFile(gitDir, baseCommit, "docs/リンク.md", { anyName: true }),
    ).rejects.toThrow(/通常のファイルではありません/);
    // リポジトリの外・.git・オプションに見えるもの・制御文字は受け付けない
    for (const bad of [
      "../x.md",
      "docs/../../x.md",
      "./pay.ts",
      ".git/config",
      "docs/.GIT/config",
      "/etc/passwd",
      "-x.md",
      "docs//x.md",
      "docs/a\nb.md",
      "",
    ]) {
      await expect(
        workspace.readFile(gitDir, baseCommit, bad, { anyName: true }),
        JSON.stringify(bad),
      ).rejects.toThrow(/パスが不正/);
    }
  });

  it("差分のファイルの一覧は、BMP の外の文字・引用符・タブの名前と、名前の変更の前のパス・種類の変更を取り違えない（PR #304 のレビュー）", async () => {
    const origin = makeOrigin();
    mkdirSync(join(origin, "docs"));
    const body = Array.from({ length: 12 }, (_, i) => `${i + 1}. 説明の行`);
    writeFileSync(
      join(origin, "docs/old name.md"),
      // もともとある名前は、差分の前後の行に入らない先頭に置く（起点と比べないと除けない）
      ["道具は `.sacty-tools/` に置く。", ...body, ""].join("\n"),
    );
    writeFileSync(join(origin, "docs/link"), "x\n");
    git(origin, "add", "--all");
    git(origin, "commit", "--quiet", "-m", "docs");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    // 名前を変え、もともとある名前の行を足す
    rmSync(join(clone, "docs/old name.md"));
    writeFileSync(
      join(clone, 'docs/new "名".md'),
      [
        "道具は `.sacty-tools/` に置く。",
        ...body,
        "道具は `.sacty-tools/` に置く（再掲）。",
        "",
      ].join("\n"),
    );
    // BMP の外の文字と引用符・タブを含む名前の、新しいファイル
    const emoji = 'docs/😀"guide.md';
    const tab = "docs/新\tタブ.md";
    writeFileSync(join(clone, emoji), "記録は `/tmp/agent-scratch/` に置く。\n");
    writeFileSync(join(clone, tab), "記録は `/sacty-input` に置く。\n");
    // 種類の変更（節が 2 つに分かれる）
    rmSync(join(clone, "docs/link"));
    symlinkSync("../pay.ts", join(clone, "docs/link"));

    const files = await workspace.diffFiles(clone, gitDir, baseCommit);
    expect(files).toContainEqual({
      status: expect.stringMatching(/^R/),
      oldPath: "docs/old name.md",
      path: 'docs/new "名".md',
    });
    expect(files.find((f) => f.path === "docs/link")?.status).toBe("T");
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([emoji, tab]));
  });

  it("中止したときは sacty のブランチだけを消し、ほかのブランチは消さない（PBI-3）", async () => {
    const origin = makeOrigin();
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    git(origin, "branch", "feature/human");
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const gitDir = join(dir, "_git", "task.git");
    const { baseCommit } = await workspace.prepare(clone, gitDir, origin, "main");
    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
    const branch = "sacty/task-1234abcd";
    await workspace.publish({
      dir: clone,
      gitDir,
      baseCommit,
      parent: baseCommit,
      branch,
      message: "m",
      date: "2026-10-10T01:00:00.000Z",
    });
    expect(git(origin, "branch", "--list", branch)).toContain(branch);

    await workspace.deleteBranch(gitDir, branch);
    expect(git(origin, "branch", "--list", branch)).toBe("");
    await expect(workspace.deleteBranch(gitDir, "feature/human")).rejects.toThrow(
      /Sacty のブランチではありません/,
    );
    expect(git(origin, "branch", "--list", "feature/human")).toContain("feature/human");
  });
});

describe("デプロイの確認のスキルを、コミットから探す（PBI-89）", { timeout: 30_000 }, () => {
  /** スキルを置いたコミットを作り、作業領域に取得して、そのコミットを返す。 */
  async function commitWith(setup: (origin: string) => void) {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const gitDir = join(dir, "_git", "a.git");
    const { baseCommit } = await workspace.prepare(join(dir, "a"), gitDir, origin, "main");
    setup(origin);
    git(origin, "add", "--all");
    git(origin, "commit", "--quiet", "-m", "skill");
    const commit = git(origin, "rev-parse", "HEAD");
    await workspace.fetchCommits(gitDir, [commit]);
    return { workspace, gitDir, commit, baseCommit };
  }
  const skill = (origin: string, at = ".agents/skills/deployment-observer") => {
    mkdirSync(join(origin, at), { recursive: true });
    writeFileSync(join(origin, at, "SKILL.md"), "# deployment-observer\n");
  };

  it("原本（.agents）があれば使う。.claude が原本へのリンクでも、原本を使う。リンクでないものは undefined", async () => {
    const { workspace, gitDir, commit, baseCommit } = await commitWith((origin) => {
      skill(origin);
      mkdirSync(join(origin, ".claude/skills"), { recursive: true });
      symlinkSync(
        "../../.agents/skills/deployment-observer",
        join(origin, ".claude/skills/deployment-observer"),
      );
    });
    expect(await workspace.readLink(gitDir, commit, ".claude/skills/deployment-observer")).toBe(
      "../../.agents/skills/deployment-observer",
    );
    expect(await workspace.readLink(gitDir, commit, ".agents/skills")).toBeUndefined();
    expect(await workspace.readLink(gitDir, commit, "missing")).toBeUndefined();
    expect(await findDeploymentSkill(workspace, gitDir, commit)).toEqual({
      path: ".agents/skills/deployment-observer/SKILL.md",
    });
    // スキルの無いコミット
    expect(await findDeploymentSkill(workspace, gitDir, baseCommit)).toEqual({
      problem: { code: "deploy.skillMissing" },
    });
  });

  it(".claude にだけあっても使う。.agents が .claude の中を指すリンクなら、たどった先を使う", async () => {
    const only = await commitWith((origin) => skill(origin, ".claude/skills/deployment-observer"));
    expect(await findDeploymentSkill(only.workspace, only.gitDir, only.commit)).toEqual({
      path: ".claude/skills/deployment-observer/SKILL.md",
    });
    rmSync(join(dir, "origin"), { recursive: true, force: true });
    rmSync(join(dir, "a"), { recursive: true, force: true });
    rmSync(join(dir, "_git"), { recursive: true, force: true });
    const linked = await commitWith((origin) => {
      skill(origin, ".claude/skills/deployment-observer");
      mkdirSync(join(origin, ".agents/skills"), { recursive: true });
      symlinkSync(
        "../../.claude/skills/deployment-observer",
        join(origin, ".agents/skills/deployment-observer"),
      );
    });
    expect(await findDeploymentSkill(linked.workspace, linked.gitDir, linked.commit)).toEqual({
      path: ".claude/skills/deployment-observer/SKILL.md",
    });
  });

  it("リポジトリの外を指すリンク（相対・絶対）は使わず、理由を返す", async () => {
    const outside = join(dir, "outside-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "# outside\n");
    const { workspace, gitDir, commit } = await commitWith((origin) => {
      mkdirSync(join(origin, ".agents/skills"), { recursive: true });
      symlinkSync(outside, join(origin, ".agents/skills/deployment-observer"));
      mkdirSync(join(origin, ".claude/skills"), { recursive: true });
      symlinkSync("../../../outside-skill", join(origin, ".claude/skills/deployment-observer"));
    });
    expect(await findDeploymentSkill(workspace, gitDir, commit)).toEqual({
      problem: {
        code: "deploy.skillOutside",
        params: { path: ".agents/skills/deployment-observer/SKILL.md" },
      },
    });
  });

  it("SKILL.md 自体が外を指すリンク・リンクの循環も使わない", async () => {
    const { workspace, gitDir, commit } = await commitWith((origin) => {
      mkdirSync(join(origin, ".agents/skills/deployment-observer"), { recursive: true });
      symlinkSync(
        "../../../../x/SKILL.md",
        join(origin, ".agents/skills/deployment-observer/SKILL.md"),
      );
      mkdirSync(join(origin, ".claude/skills"), { recursive: true });
      symlinkSync("loop", join(origin, ".claude/skills/deployment-observer"));
      symlinkSync("deployment-observer", join(origin, ".claude/skills/loop"));
    });
    expect(await findDeploymentSkill(workspace, gitDir, commit)).toEqual({
      problem: {
        code: "deploy.skillOutside",
        params: { path: ".agents/skills/deployment-observer/SKILL.md" },
      },
    });
  });
});
