import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupSharedComposeRuns,
  GitSharedComposeFetcher,
  sharedComposeRunDir,
} from "./shared-compose.js";

let dir: string;
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
    .toString()
    .trim();

/** 共用の compose のリポジトリ（compose ファイルと初期化スクリプト）を作る。 */
function makeRepo(): string {
  const repo = join(dir, "infra");
  mkdirSync(join(repo, "compose", "init"), { recursive: true });
  run(repo, "init", "--quiet", "--initial-branch", "main");
  writeFileSync(join(repo, "compose", "redis.yml"), "services:\n  redis:\n    image: redis\n");
  writeFileSync(join(repo, "compose", "init", "seed.sh"), "echo v1\n");
  run(repo, "add", ".");
  run(repo, "commit", "--quiet", "-m", "v1");
  return repo;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-shared-compose-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("共用の compose のリポジトリの取得（PBI-70）", { timeout: 30_000 }, () => {
  it("既定のブランチを取得し、そのコミットの中身を実行ごとのディレクトリに置く（.git は置かない）", async () => {
    const repo = makeRepo();
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"));
    const dest = join(dir, "run1");
    const { commit } = await fetcher.checkout({ repo, dest });
    expect(commit).toBe(run(repo, "rev-parse", "HEAD"));
    expect(readFileSync(join(dest, "compose", "redis.yml"), "utf8")).toContain("redis");
    expect(readFileSync(join(dest, "compose", "init", "seed.sh"), "utf8")).toBe("echo v1\n");
    expect(existsSync(join(dest, ".git"))).toBe(false);
    // キャッシュは、リポジトリごとに1つ
    expect(readdirSync(join(dir, "cache"))).toHaveLength(1);
  });

  it("実行のたびに ref の最新を取る（キャッシュを更新する）。前の実行のディレクトリは変えない", async () => {
    const repo = makeRepo();
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"));
    const first = await fetcher.checkout({ repo, ref: "main", dest: join(dir, "run1") });
    writeFileSync(join(repo, "compose", "init", "seed.sh"), "echo v2\n");
    run(repo, "commit", "--quiet", "-am", "v2");
    const second = await fetcher.checkout({ repo, ref: "main", dest: join(dir, "run2") });
    expect(second.commit).not.toBe(first.commit);
    expect(second.commit).toBe(run(repo, "rev-parse", "HEAD"));
    expect(readFileSync(join(dir, "run2", "compose", "init", "seed.sh"), "utf8")).toBe("echo v2\n");
    expect(readFileSync(join(dir, "run1", "compose", "init", "seed.sh"), "utf8")).toBe("echo v1\n");
    expect(readdirSync(join(dir, "cache"))).toHaveLength(1);
  });

  it("ブランチ・タグを ref に指定できる", async () => {
    const repo = makeRepo();
    run(repo, "tag", "v1");
    run(repo, "checkout", "--quiet", "-b", "cassandra");
    writeFileSync(
      join(repo, "compose", "cassandra.yml"),
      "services:\n  cassandra:\n    image: cassandra\n",
    );
    run(repo, "add", ".");
    run(repo, "commit", "--quiet", "-m", "cassandra");
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"));
    await fetcher.checkout({ repo, ref: "cassandra", dest: join(dir, "branch") });
    expect(existsSync(join(dir, "branch", "compose", "cassandra.yml"))).toBe(true);
    await fetcher.checkout({ repo, ref: "v1", dest: join(dir, "tag") });
    expect(existsSync(join(dir, "tag", "compose", "cassandra.yml"))).toBe(false);
    expect(existsSync(join(dir, "tag", "compose", "redis.yml"))).toBe(true);
  });

  it("並行して取得しても、それぞれのディレクトリに同じコミットを置く（キャッシュの処理を並べる）", async () => {
    const repo = makeRepo();
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"));
    const results = await Promise.all(
      [1, 2, 3].map((i) => fetcher.checkout({ repo, dest: join(dir, `run${i}`) })),
    );
    expect(new Set(results.map((r) => r.commit)).size).toBe(1);
    for (const i of [1, 2, 3]) {
      expect(readFileSync(join(dir, `run${i}`, "compose", "redis.yml"), "utf8")).toContain("redis");
    }
  });

  it("リポジトリ・ref が無ければ、git のエラー文で失敗する。失敗の後も、次の取得はできる", async () => {
    const repo = makeRepo();
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"));
    await expect(
      fetcher.checkout({ repo: join(dir, "missing"), dest: join(dir, "run1") }),
    ).rejects.toThrow(/missing|does not appear|not a git repository/i);
    await expect(
      fetcher.checkout({ repo, ref: "no-such-branch", dest: join(dir, "run2") }),
    ).rejects.toThrow(/no-such-branch/);
    const { commit } = await fetcher.checkout({ repo, dest: join(dir, "run3") });
    expect(commit).toBe(run(repo, "rev-parse", "HEAD"));
  });

  it("中断された取得の後も同じキャッシュで取得できる", async () => {
    const repo = makeRepo();
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetcher.checkout({ repo, dest: join(dir, "stopped"), signal: controller.signal }),
    ).rejects.toThrow();
    const result = await fetcher.checkout({ repo, dest: join(dir, "next") });
    expect(result.commit).toBe(run(repo, "rev-parse", "HEAD"));
  });

  it("取得待ちの中断は先行取得を待たず、後から取得を始めない", async () => {
    const repo = makeRepo();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let fetches = 0;
    const spawnImpl: typeof spawn = ((command, args, options) => {
      if (command === "git" && Array.isArray(args) && args.includes("fetch")) {
        fetches++;
        if (fetches === 1) {
          const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
            ...options,
            stdio: ["pipe", "pipe", "pipe"],
          });
          entered.resolve();
          void release.promise.then(() => child.stdin?.end());
          return child;
        }
      }
      return spawn(command, args, options);
    }) as typeof spawn;
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"), spawnImpl);
    const first = fetcher.checkout({ repo, dest: join(dir, "first") });
    await entered.promise;
    const controller = new AbortController();
    const waiting = fetcher.checkout({
      repo,
      dest: join(dir, "waiting"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(fetches).toBe(1);
    release.resolve();
    await expect(first).rejects.toThrow();
    await fetcher.checkout({ repo, dest: join(dir, "next") });
    expect(fetches).toBe(2);
    expect(existsSync(join(dir, "waiting"))).toBe(false);
  });

  it("中断の error 後も Git の close まで後続の取得を待つ", async () => {
    const repo = makeRepo();
    const entered = Promise.withResolvers<void>();
    let held: EventEmitter | undefined;
    let fetches = 0;
    const spawnImpl: typeof spawn = ((command, args, options) => {
      if (command === "git" && Array.isArray(args) && args.includes("fetch")) {
        fetches++;
        if (fetches === 1) {
          held = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
          });
          options?.signal?.addEventListener("abort", () =>
            held?.emit("error", new Error("aborted")),
          );
          entered.resolve();
          return held;
        }
      }
      return spawn(command, args, options);
    }) as typeof spawn;
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"), spawnImpl);
    const controller = new AbortController();
    const first = fetcher.checkout({ repo, dest: join(dir, "first"), signal: controller.signal });
    await entered.promise;
    const next = fetcher.checkout({ repo, dest: join(dir, "next") });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toBe(1);
    held?.emit("close", null);
    await expect(first).rejects.toThrow();
    await next;
    expect(fetches).toBe(2);
  });

  it("実行中の git を停止し、同じキャッシュの後続の取得を続ける", async () => {
    const repo = makeRepo();
    const entered = Promise.withResolvers<void>();
    let hold = true;
    const spawnImpl: typeof spawn = ((command, args, options) => {
      if (command === "git" && Array.isArray(args) && args.includes("fetch") && hold) {
        hold = false;
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
        entered.resolve();
        return child;
      }
      return spawn(command, args, options);
    }) as typeof spawn;
    const fetcher = new GitSharedComposeFetcher(join(dir, "cache"), spawnImpl);
    const controller = new AbortController();
    const pending = fetcher.checkout({
      repo,
      dest: join(dir, "stopped"),
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    const result = await fetcher.checkout({ repo, dest: join(dir, "next") });
    expect(result.commit).toBe(run(repo, "rev-parse", "HEAD"));
  });

  it("実行ごとのディレクトリは作業領域の根の下にあり、デーモンの起動時にまとめて消す", () => {
    const root = join(dir, "workspaces");
    const runDir = sharedComposeRunDir(root, "run-1");
    mkdirSync(runDir, { recursive: true });
    expect(runDir.startsWith(join(root, "_shared-compose"))).toBe(true);
    cleanupSharedComposeRuns(root);
    expect(existsSync(join(root, "_shared-compose"))).toBe(false);
    // 無くても失敗しない
    cleanupSharedComposeRuns(root);
  });
});
