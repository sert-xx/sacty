import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRepositoryWorkspace, NothingToCommitError } from "./repository.js";

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
      /sacty のブランチではありません/,
    );
    expect(git(origin, "branch", "--list", "feature/human")).toContain("feature/human");
  });
});
