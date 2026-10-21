import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DockerExecutor, RunningContainers } from "./docker.js";
import { FORWARD_NOTICE_PREFIX, withLocalForwards } from "./forward.js";
import { withOutputRelay } from "./output-relay.js";

/** 子プロセスの標準入力の偽物。書かれた内容と、閉じたかを記録する（PBI-149）。 */
function fakeStdin() {
  return {
    written: "",
    ended: false,
    on() {
      return this;
    },
    end(data?: string) {
      this.written += data ?? "";
      this.ended = true;
    },
  };
}

/** docker コマンドの偽物。docker run は止められるまで終わらず、docker kill は決めた終了コードを返す。 */
function fakeDocker(killCodes: number[]) {
  const calls: string[][] = [];
  let run: (EventEmitter & { killedWith?: string }) | undefined;
  const spawnImpl = ((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: fakeStdin(),
      killedWith: undefined as string | undefined,
      kill(signal: string) {
        this.killedWith = signal;
        setTimeout(() => child.emit("close", 137), 0);
        return true;
      },
    });
    if (args[0] === "run") run = child;
    // ps：コンテナは残っていない（止められた後）
    if (args[0] === "ps") setTimeout(() => child.emit("close", 0), 0);
    if (args[0] === "kill") {
      const code = killCodes.shift() ?? 0;
      setTimeout(() => {
        // コンテナができていれば止まる
        if (code === 0 && run && !run.killedWith) run.emit("close", 137);
        child.emit("close", code);
      }, 0);
    }
    return child;
  }) as never;
  return { spawnImpl, calls, run: () => run };
}

/** すぐには終わらないエージェントの実行（止めたときの振る舞いを見る）。 */
const invocation = {
  command: ["sh", "-c", "sleep 9"],
  env: {},
  parser: "claude-json" as const,
};

describe("コンテナができる前に止めた場合（PBI-3 レビュー指摘）", () => {
  it("docker kill が対象なしで失敗したら、docker run 自体を止めて、kill を繰り返す", async () => {
    const docker = fakeDocker([1, 1, 0]);
    const runner = new DockerExecutor(60_000, docker.spawnImpl);
    // テスト用に、繰り返しの間隔を短くする
    (runner as unknown as { containers: { retryMs: number } }).containers.retryMs = 1;
    const running = runner
      .run({ runId: "r1", image: "img", workspaceDir: "/tmp", invocation })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    runner.kill("r1"); // イメージの取得中で、コンテナはまだ無い
    await running;
    expect(docker.run()?.killedWith).toBe("SIGKILL"); // docker run 自体を止めた
    await new Promise((r) => setTimeout(r, 20));
    // 終わった後に、コンテナが残っていないことを docker ps で確かめた
    expect(docker.calls.some((a) => a[0] === "ps")).toBe(true);
  });

  it("止める要求が子プロセスより先に来ても、起動したら止める", async () => {
    const docker = fakeDocker(Array(50).fill(1)); // コンテナは最後まで無い
    const runner = new DockerExecutor(60_000, docker.spawnImpl);
    (runner as unknown as { containers: { retryMs: number; retries: number } }).containers.retryMs =
      1;
    const containers = (
      runner as unknown as {
        containers: { register(n: string): void; stop(n: string): void };
      }
    ).containers;
    // run() の register と spawn の間に止められた状況を再現する
    containers.register("sacty-run-r2");
    containers.stop("sacty-run-r2");
    await runner
      .run({ runId: "r2", image: "img", workspaceDir: "/tmp", invocation })
      .catch(() => undefined);
    // 起動したら止めた（docker run 自体を止めた）
    expect(docker.run()?.killedWith).toBe("SIGKILL");
  });
});

describe("コンテナの停止の確認（PBI-3 レビュー指摘）", () => {
  /** docker ps は決めた順にコンテナの有無を返し、docker kill は成功する。 */
  function dockerWithPs(listed: boolean[]) {
    const calls: string[][] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        kill: () => true,
      });
      setTimeout(() => {
        if (args[0] === "ps" && listed.shift()) child.stdout.emit("data", "abc123\n");
        child.emit("close", 0);
      }, 0);
      return child;
    }) as never;
    return { spawnImpl, calls };
  }

  it("止める要求があった実行は、コンテナが無くなったのを確かめるまで完了にしない", async () => {
    const docker = dockerWithPs([true, true, false]); // 遅れてできたコンテナが、2回目の kill の後に消える
    const containers = new RunningContainers(docker.spawnImpl, 1, 5);
    containers.register("sacty-run-r1");
    containers.stop("sacty-run-r1");
    expect(await containers.finish("sacty-run-r1")).toBe(true);
    expect(docker.calls.filter((a) => a[0] === "ps")).toHaveLength(3);
    expect(docker.calls.filter((a) => a[0] === "kill").length).toBeGreaterThanOrEqual(3);
  });

  it("止まらないまま上限に達したら、確かめられなかったことを返す", async () => {
    const docker = dockerWithPs(Array(10).fill(true));
    const containers = new RunningContainers(docker.spawnImpl, 1, 3);
    containers.register("sacty-run-r2");
    containers.stop("sacty-run-r2");
    expect(await containers.finish("sacty-run-r2")).toBe(false);
  });

  it("止める要求が無ければ、確かめずに完了にする", async () => {
    const docker = dockerWithPs([]);
    const containers = new RunningContainers(docker.spawnImpl, 1, 3);
    containers.register("sacty-run-r3");
    expect(await containers.finish("sacty-run-r3")).toBe(true);
    expect(docker.calls).toEqual([]);
  });
});

describe("実行の上限（PBI-150）", () => {
  it("エージェントの実行も、実行ごとの上限（PBI-150）を既定より優先し、その分で時間切れにする", async () => {
    const docker = fakeDocker([0]);
    const executor = new DockerExecutor(60_000, docker.spawnImpl);
    (executor as unknown as { containers: { retryMs: number } }).containers.retryMs = 1;
    // 時間切れは、上限の分を添えた誤りになる（呼ぶ側が実行の失敗として記録する）
    await expect(
      executor.run({
        runId: "a",
        image: "img",
        workspaceDir: "/tmp",
        invocation: { command: ["sh", "-c", "sleep 9"], env: {}, parser: "claude-json" },
        timeoutMs: 15,
      }),
    ).rejects.toThrow(`エージェントの実行が ${15 / 60_000} 分を超えたため止めました。`);
  });
});

describe("イメージの環境変数（PBI-41）", () => {
  /** docker run の引数と、docker コマンドに渡した環境変数・標準入力を記録し、すぐ終わる偽物。 */
  function recordingDocker() {
    const runs: {
      args: string[];
      env: Record<string, string>;
      stdin: ReturnType<typeof fakeStdin>;
    }[] = [];
    const spawnImpl = ((_cmd: string, args: string[], options: { env: Record<string, string> }) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: fakeStdin(),
        kill: () => true,
      });
      if (args[0] === "run") runs.push({ args, env: options.env, stdin: child.stdin });
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    }) as never;
    return { spawnImpl, runs };
  }

  it("サービスのネットワークにつなぐ（PBI-47）。指定が無ければ --network を付けない", async () => {
    const docker = recordingDocker();
    const runner = new DockerExecutor(60_000, docker.spawnImpl);
    await runner
      .run({
        runId: "r3",
        image: "img",
        workspaceDir: "/tmp",
        invocation,
        network: "sacty-svc-r3_sacty",
      })
      .catch(() => undefined);
    await runner
      .run({ runId: "r4", image: "img", workspaceDir: "/tmp", invocation })
      .catch(() => undefined);
    const args = docker.runs.map((r) => r.args);
    expect(args[0]?.slice(0, 4)).toEqual(["run", "--rm", "--network", "sacty-svc-r3_sacty"]);
    expect(args[1]).not.toContain("--network");
    // 権限は落としたまま（Docker のソケットも渡さない）
    expect(args[0]).toContain("ALL");
    expect(args[0]?.join(" ")).not.toContain("docker.sock");
  });

  it("エージェントの実行でも、転送するときだけ転送を起動し、転送しなかった理由をデーモンのログに出す（PBI-60）", async () => {
    const runs: string[][] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: fakeStdin(),
        kill: () => true,
      });
      if (args[0] === "run") runs.push(args);
      setTimeout(() => {
        child.stdout.emit("data", '{"type":"result","subtype":"success","result":"done"}\n');
        child.stderr.emit(
          "data",
          `${FORWARD_NOTICE_PREFIX}127.0.0.1:5432 を db:5432 に転送しません（すでに使われています）。db:5432 で接続してください\nother\n`,
        );
        child.emit("close", 0);
      }, 0);
      return child;
    }) as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const executor = new DockerExecutor(60_000, spawnImpl);
      const invocation = {
        command: ["claude", "-p", "x"],
        env: {},
        parser: "claude-json" as const,
      };
      const outcome = await executor.run({
        runId: "a1",
        image: "img",
        workspaceDir: "/tmp",
        invocation,
        network: "n",
        forwards: [{ port: 5432, host: "db" }],
      });
      // 出力の読み取りは変わらない
      expect(outcome).toMatchObject({ kind: "completed", output: "done" });
      expect(runs[0]?.slice(runs[0].indexOf("img") + 1)).toEqual(
        withOutputRelay(withLocalForwards(["claude", "-p", "x"], [{ port: 5432, host: "db" }])),
      );
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining(
          "sacty-run-a1：[sacty] localhost の転送：127.0.0.1:5432 を db:5432",
        ),
      ]);
      await executor.run({ runId: "a2", image: "img", workspaceDir: "/tmp", invocation });
      expect(runs[1]?.slice(runs[1].indexOf("img") + 1)).toEqual(
        withOutputRelay(["claude", "-p", "x"]),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("エージェントの実行では、実行の環境変数がイメージの環境変数より優先する", async () => {
    const docker = recordingDocker();
    const executor = new DockerExecutor(60_000, docker.spawnImpl);
    await executor.run({
      runId: "r2",
      image: "sacty-agent-java:test",
      workspaceDir: "/tmp",
      invocation: {
        command: ["codex"],
        env: { SHARED: "from-run", CODEX_HOME: "/.codex" },
        parser: "codex-jsonl",
      },
      imageEnv: { SHARED: "from-image", PIP_INDEX_URL: "https://pypi.example.com/simple" },
    });
    const run = docker.runs[0];
    expect(run?.env.SHARED).toBe("from-run");
    expect(run?.env.PIP_INDEX_URL).toBe("https://pypi.example.com/simple");
    // イメージより前（docker run の引数）だけを見る（後ろはコンテナで実行するコマンド）
    const dockerArgs = run?.args.slice(0, run.args.indexOf("sacty-agent-java:test")) ?? [];
    const names = dockerArgs.filter((_, i, a) => a[i - 1] === "-e");
    expect(names.sort()).toEqual(["CODEX_HOME", "PIP_INDEX_URL", "SHARED"]);
  });
});

describe("エージェントへの指示を標準入力で渡す（PBI-149）", () => {
  function recordingDocker() {
    const runs: { args: string[]; stdin: ReturnType<typeof fakeStdin> }[] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: fakeStdin(),
        kill: () => true,
      });
      if (args[0] === "run") runs.push({ args, stdin: child.stdin });
      setTimeout(() => {
        child.stdout.emit("data", '{"type":"result","subtype":"success","result":"done"}\n');
        child.emit("close", 0);
      }, 0);
      return child;
    }) as never;
    return { spawnImpl, runs };
  }

  it("指示があれば docker run に -i を付け、標準入力に指示の全体を書いて閉じる。コマンドの引数には入れない", async () => {
    const docker = recordingDocker();
    const executor = new DockerExecutor(60_000, docker.spawnImpl);
    // 1つの引数の上限（128 KiB）を超える大きな指示
    const prompt = `# ゴールガーディアン\n${"差分の行\n".repeat(30_000)}`;
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(128 * 1024);
    const outcome = await executor.run({
      runId: "s1",
      image: "img",
      workspaceDir: "/tmp",
      invocation: {
        command: ["claude", "-p", "--output-format", "stream-json", "--verbose"],
        stdin: prompt,
        env: {},
        parser: "claude-json",
      },
    });
    expect(outcome).toMatchObject({ kind: "completed", output: "done" });
    const [run] = docker.runs;
    const imageAt = run?.args.indexOf("img") ?? -1;
    // -i はイメージより前（docker run のオプション）
    expect(run?.args.slice(0, imageAt)).toContain("-i");
    expect(run?.stdin.written).toBe(prompt);
    expect(run?.stdin.ended).toBe(true);
    expect(run?.args.some((a) => a.includes("差分の行"))).toBe(false);
  });

  it("指示が無ければ -i を付けず、標準入力はすぐ閉じる", async () => {
    const docker = recordingDocker();
    const executor = new DockerExecutor(60_000, docker.spawnImpl);
    await executor.run({
      runId: "s2",
      image: "img",
      workspaceDir: "/tmp",
      invocation: { command: ["sh", "-c", "true"], env: {}, parser: "claude-json" },
    });
    const [run] = docker.runs;
    expect(run?.args).not.toContain("-i");
    expect(run?.stdin.written).toBe("");
    expect(run?.stdin.ended).toBe(true);
  });
});
