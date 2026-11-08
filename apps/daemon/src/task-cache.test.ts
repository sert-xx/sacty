import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTAINER_TASK_CACHE,
  DockerExecutor,
  dockerRunArgs,
  TASK_CACHE_ENV,
  TASK_CACHE_PROBE_SCRIPT,
  taskCacheNotices,
  withTaskCacheProbe,
} from "./agents/docker.js";
import { CLAUDE_CACHE_DIR, type Invocation } from "./agents/invocation.js";
import { prepareTaskCache } from "./task-cache.js";

// タスクごとの依存のキャッシュ（PBI-319）の用意と、コンテナへの渡し方

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-task-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const taskId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("依存のキャッシュの用意（PBI-319）", () => {
  it("タスクごとに、持ち主だけが読み書きできるディレクトリを作り、2回目は中身を残して使う", async () => {
    const first = await prepareTaskCache(dir, taskId);
    expect(first).toBe(join(dir, "_task-cache", taskId));
    expect(statSync(join(dir, "_task-cache")).mode & 0o777).toBe(0o700);
    expect(statSync(first as string).mode & 0o777).toBe(0o700);
    writeFileSync(join(first as string, "downloaded"), "pkg");
    const second = await prepareTaskCache(dir, taskId);
    expect(second).toBe(first);
    expect(readFileSync(join(second as string, "downloaded"), "utf8")).toBe("pkg");
    // 別のタスクとは別の場所
    const another = await prepareTaskCache(dir, other);
    expect(another).toBe(join(dir, "_task-cache", other));
    expect(readdirSync(another as string)).toEqual([]);
  });

  it("壊れたもの（ファイル・リンク・読み書きできないディレクトリ）は消して作り直す。リンクの先は消さない", async () => {
    const base = join(dir, "_task-cache");
    mkdirSync(base);
    const warns: string[] = [];
    // ファイル
    writeFileSync(join(base, taskId), "broken");
    const fromFile = await prepareTaskCache(dir, taskId, (line) => warns.push(line));
    expect(fromFile).toBe(join(base, taskId));
    expect(lstatSync(fromFile as string).isDirectory()).toBe(true);
    // リンク
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    rmSync(join(base, taskId), { recursive: true });
    symlinkSync(outside, join(base, taskId));
    const fromLink = await prepareTaskCache(dir, taskId, (line) => warns.push(line));
    expect(lstatSync(fromLink as string).isDirectory()).toBe(true);
    expect(readdirSync(fromLink as string)).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    // 読み書きできないディレクトリ（root で動かすと権限で拒まれないので確かめない）
    if (process.getuid?.() !== 0) {
      writeFileSync(join(fromLink as string, "stale"), "x");
      chmodSync(fromLink as string, 0o000);
      const fromLocked = await prepareTaskCache(dir, taskId, (line) => warns.push(line));
      expect(readdirSync(fromLocked as string)).toEqual([]);
    }
    expect(warns).toEqual([]);
  });

  it("壊れたものを消せなければ、使わずに理由を知らせる", async () => {
    if (process.getuid?.() === 0) return; // root は権限で拒まれない
    const locked = join(dir, "_task-cache", taskId, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "stale"), "x");
    chmodSync(locked, 0o000);
    chmodSync(join(dir, "_task-cache", taskId), 0o000);
    const warns: string[] = [];
    try {
      expect(await prepareTaskCache(dir, taskId, (line) => warns.push(line))).toBeUndefined();
      expect(warns.join("\n")).toContain("キャッシュを使わずに実行します");
    } finally {
      chmodSync(join(dir, "_task-cache", taskId), 0o700);
      chmodSync(locked, 0o700);
    }
  });

  it("キャッシュの根がリンク・ファイルなら、使わずに理由を知らせる（リンクの先に書かない）", async () => {
    const outside = join(dir, "outside");
    // リンクの先に、同じ名前のディレクトリがあっても使わない
    mkdirSync(join(outside, taskId), { recursive: true });
    symlinkSync(outside, join(dir, "_task-cache"));
    const warns: string[] = [];
    expect(await prepareTaskCache(dir, taskId, (line) => warns.push(line))).toBeUndefined();
    expect(readdirSync(outside)).toEqual([taskId]);
    expect(readdirSync(join(outside, taskId))).toEqual([]);
    expect(warns.join("\n")).toContain("キャッシュを使わずに実行します");
    rmSync(join(dir, "_task-cache"));
    writeFileSync(join(dir, "_task-cache"), "file");
    expect(await prepareTaskCache(dir, taskId, () => {})).toBeUndefined();
  });
});

/** docker run の偽物。引数と環境を記録し、すぐに終わる。 */
function fakeDocker(stderr = "", hang = false) {
  const runs: { args: string[]; env: Record<string, string> }[] = [];
  let running: EventEmitter | undefined;
  const spawnImpl = ((_cmd: string, args: string[], options: { env: Record<string, string> }) => {
    if (args[0] === "run") runs.push({ args, env: options.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on: () => child.stdin, end: () => {} },
      kill: () => true,
    });
    if (args[0] === "run") running = child;
    setTimeout(() => {
      if (args[0] === "run" && stderr) child.stderr.emit("data", stderr);
      // hang なら、docker run は止められる（docker kill）まで終わらない
      if (args[0] === "run" && hang) return;
      if (args[0] === "kill") running?.emit("close", 137);
      child.emit("close", 0);
    }, 0);
    return child;
  }) as never;
  return { spawnImpl, runs };
}

const invocation = (extra: Partial<Invocation> = {}): Invocation => ({
  command: ["claude", "-p"],
  env: {},
  parser: "claude-json",
  ...extra,
});

describe("依存のキャッシュをコンテナに渡す（PBI-319）", () => {
  it("決まった場所にマウントして XDG_CACHE_HOME を向け、エージェントの CLI 自身のキャッシュはコンテナの中だけにする", async () => {
    const cache = join(dir, "_task-cache", taskId);
    // 前の実行が置いた CLI 自身のキャッシュ（リンクを含む）は、実行の前に消す。依存のキャッシュは残す
    mkdirSync(join(cache, "pip"), { recursive: true });
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(cache, CLAUDE_CACHE_DIR));
    const docker = fakeDocker();
    await new DockerExecutor(60_000, docker.spawnImpl).run({
      runId: "r1",
      image: "img",
      workspaceDir: join(dir, "ws"),
      // イメージの env の XDG_CACHE_HOME は、書けなかったときのために上書きせずに渡す
      imageEnv: { XDG_CACHE_HOME: "/elsewhere" },
      invocation: invocation({ taskCache: cache, agentCacheDirs: [CLAUDE_CACHE_DIR] }),
    });
    const [run] = docker.runs;
    expect(run?.args.join(" ")).toContain(`-v ${cache}:${CONTAINER_TASK_CACHE} `);
    expect(run?.args.join(" ")).toContain(`--tmpfs ${CONTAINER_TASK_CACHE}/${CLAUDE_CACHE_DIR} `);
    // キャッシュの場所は別の変数で渡し、XDG_CACHE_HOME は上書きしない（書けたときだけ、コンテナの中で向ける）
    expect(run?.args).toContain(TASK_CACHE_ENV);
    expect(run?.env[TASK_CACHE_ENV]).toBe(CONTAINER_TASK_CACHE);
    expect(run?.env.XDG_CACHE_HOME).toBe("/elsewhere");
    // 書けるかをコンテナの中で確かめてから、エージェントのコマンドを実行する
    expect(run?.args.join("\u0000")).toContain(
      ["sh", "-c", TASK_CACHE_PROBE_SCRIPT, "sh", "claude", "-p"].join("\u0000"),
    );
    expect(existsSync(join(cache, CLAUDE_CACHE_DIR))).toBe(false);
    expect(existsSync(join(cache, "pip"))).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("設定に XDG_CACHE_HOME が無ければ（Dockerfile の ENV だけにある場合を含む）、Docker の引数に XDG_CACHE_HOME を足さない", async () => {
    const cache = join(dir, "_task-cache", taskId);
    const docker = fakeDocker();
    await new DockerExecutor(60_000, docker.spawnImpl).run({
      runId: "r5",
      image: "img",
      workspaceDir: join(dir, "ws"),
      imageEnv: {},
      invocation: invocation({ taskCache: cache, env: {} }),
    });
    const [run] = docker.runs;
    // イメージの ENV を -e で消さないよう、XDG_CACHE_HOME は名前も値も渡さない（書けたときだけ、コンテナの中で向ける）
    expect(run?.args).not.toContain("XDG_CACHE_HOME");
    expect(run?.args.some((a) => a.startsWith("XDG_CACHE_HOME="))).toBe(false);
    expect(run?.env).not.toHaveProperty("XDG_CACHE_HOME");
    expect(run?.env[TASK_CACHE_ENV]).toBe(CONTAINER_TASK_CACHE);
  });

  it("コンテナの中で書けなかった知らせは、デーモンのログにも残す", async () => {
    const notice = "[sacty] 依存のキャッシュ：/sacty-cache に書けないので、使わずに実行します";
    const docker = fakeDocker(`${notice}\n`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await new DockerExecutor(60_000, docker.spawnImpl).run({
        runId: "r4",
        image: "img",
        workspaceDir: join(dir, "ws"),
        invocation: invocation({ taskCache: join(dir, "_task-cache", taskId) }),
      });
      expect(warn.mock.calls.flat().join("\n")).toContain(`sacty-run-r4：${notice}`);
    } finally {
      warn.mockRestore();
    }
  });

  it("知らせの後に時間切れになっても、デーモンのログに残す（PBI-319 レビュー指摘）", async () => {
    const notice = "[sacty] 依存のキャッシュ：/sacty-cache に書けないので、使わずに実行します";
    const docker = fakeDocker(`${notice}\n`, true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const running = new DockerExecutor(30, docker.spawnImpl).run({
        runId: "r5",
        image: "img",
        workspaceDir: join(dir, "ws"),
        invocation: invocation({ taskCache: join(dir, "_task-cache", taskId) }),
      });
      await expect(running).rejects.toThrow();
      expect(warn.mock.calls.flat().join("\n")).toContain(`sacty-run-r5：${notice}`);
    } finally {
      warn.mockRestore();
    }
  });

  it("キャッシュが無い実行は、これまでどおり（マウントも XDG_CACHE_HOME も足さない）", async () => {
    const docker = fakeDocker();
    await new DockerExecutor(60_000, docker.spawnImpl).run({
      runId: "r2",
      image: "img",
      workspaceDir: join(dir, "ws"),
      invocation: invocation({ agentCacheDirs: [CLAUDE_CACHE_DIR] }),
    });
    const [run] = docker.runs;
    expect(run?.args.join(" ")).not.toContain(CONTAINER_TASK_CACHE);
    expect(run?.args).not.toContain("--tmpfs");
    expect(run?.args).not.toContain(TASK_CACHE_PROBE_SCRIPT);
    expect(run?.env.XDG_CACHE_HOME).toBeUndefined();
    expect(run?.env[TASK_CACHE_ENV]).toBeUndefined();
  });

  it("コンテナの中だけの場所は、作業領域の後に --tmpfs で渡す", () => {
    const args = dockerRunArgs({
      runId: "r3",
      image: "img",
      workspaceDir: "/w",
      envNames: [],
      mounts: [{ hostPath: "/c", containerPath: CONTAINER_TASK_CACHE, readOnly: false }],
      tmpfs: [`${CONTAINER_TASK_CACHE}/x`],
      command: ["true"],
    });
    expect(args.join(" ")).toContain(
      `-v /w:/workspace -v /c:${CONTAINER_TASK_CACHE} --tmpfs ${CONTAINER_TASK_CACHE}/x -w /workspace`,
    );
  });
});

describe("依存のキャッシュに書けるかを、コンテナの中で確かめる（PBI-319 レビュー指摘）", () => {
  /**
   * 確かめのスクリプトを、この環境の sh で動かす（コンテナの中と同じ）。コマンドは、XDG_CACHE_HOME が無ければ unset、
   * あれば set:<値>（空の文字列も見分ける）を出す。キャッシュの場所を渡す変数がコマンドに残っていれば、標準エラー出力に出す。
   */
  const probe = (cache: string, xdg?: string) => {
    const show = [
      `env | grep '^${TASK_CACHE_ENV}=' >&2`,
      "if env | grep -q '^XDG_CACHE_HOME='; then printf 'set:%s' \"$XDG_CACHE_HOME\"; else printf unset; fi",
      "exit 7",
    ].join("; ");
    const [command, ...args] = withTaskCacheProbe(["sh", "-c", show]);
    return spawnSync(command as string, args, {
      env: {
        PATH: process.env.PATH ?? "",
        [TASK_CACHE_ENV]: cache,
        ...(xdg !== undefined ? { XDG_CACHE_HOME: xdg } : {}),
      },
      encoding: "utf8",
    });
  };
  /** 元の XDG_CACHE_HOME の3通り（未設定・空の文字列・値あり）と、それぞれのコマンドの出力。 */
  const before: [string | undefined, string][] = [
    [undefined, "unset"],
    ["", "set:"],
    ["/home/node/custom-cache", "set:/home/node/custom-cache"],
  ];

  it("書ければ XDG_CACHE_HOME をキャッシュに向けて実行し、確かめに使ったファイルと場所の変数を残さない。終了コードはコマンドのもの", () => {
    const cache = join(dir, "cache");
    mkdirSync(cache);
    for (const [xdg] of before) {
      const result = probe(cache, xdg);
      expect(result.stdout, String(xdg)).toBe(`set:${cache}`);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(7);
    }
    expect(readdirSync(cache)).toEqual([]);
  });

  it("書けなければ（UID の違うユーザーなど）、知らせを出し、元の XDG_CACHE_HOME（未設定・空・値あり）をそのまま残す", () => {
    if (process.getuid?.() === 0) return; // root は権限で拒まれない
    const cache = join(dir, "cache");
    mkdirSync(cache, { mode: 0o500 });
    try {
      for (const [xdg, shown] of before) {
        const result = probe(cache, xdg);
        expect(result.stdout, String(xdg)).toBe(shown);
        expect(result.status).toBe(7);
        expect(taskCacheNotices(result.stderr)).toEqual([
          `[sacty] 依存のキャッシュ：${cache} に書けないので、使わずに実行します`,
        ]);
        expect(result.stderr).not.toContain(`${TASK_CACHE_ENV}=`);
      }
      // 無い場所（マウントできなかったなど）も同じ
      expect(probe(join(dir, "missing")).stdout).toBe("unset");
      expect(probe(join(dir, "missing"), "/keep").stdout).toBe("set:/keep");
    } finally {
      chmodSync(cache, 0o700);
    }
  });
});
