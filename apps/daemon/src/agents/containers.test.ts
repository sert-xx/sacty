import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RunningContainers } from "./docker.js";
import { DockerTestRunner } from "./test-runner.js";

/** docker コマンドの偽物。docker run は止められるまで終わらず、docker kill は決めた終了コードを返す。 */
function fakeDocker(killCodes: number[]) {
  const calls: string[][] = [];
  let run: (EventEmitter & { killedWith?: string }) | undefined;
  const spawnImpl = ((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
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

describe("コンテナができる前に止めた場合（PBI-3 レビュー指摘）", () => {
  it("docker kill が対象なしで失敗したら、docker run 自体を止めて、kill を繰り返す", async () => {
    const docker = fakeDocker([1, 1, 0]);
    const runner = new DockerTestRunner(60_000, docker.spawnImpl);
    // テスト用に、繰り返しの間隔を短くする
    (runner as unknown as { containers: { retryMs: number } }).containers.retryMs = 1;
    const running = runner.run({ runId: "r1", image: "img", workspaceDir: "/tmp", command: "x" });
    await new Promise((r) => setTimeout(r, 5));
    runner.kill("r1"); // イメージの取得中で、コンテナはまだ無い
    const result = await running;
    expect(docker.run()?.killedWith).toBe("SIGKILL"); // docker run 自体を止めた
    expect(result.exitCode).toBe(137);
    await new Promise((r) => setTimeout(r, 20));
    // 終わった後に、コンテナが残っていないことを docker ps で確かめた
    expect(docker.calls.some((a) => a[0] === "ps")).toBe(true);
  });

  it("止める要求が子プロセスより先に来ても、起動したら止める", async () => {
    const docker = fakeDocker(Array(50).fill(1)); // コンテナは最後まで無い
    const runner = new DockerTestRunner(60_000, docker.spawnImpl);
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
    const running = runner.run({ runId: "r2", image: "img", workspaceDir: "/tmp", command: "x" });
    const result = await running;
    expect(result.exitCode).toBe(137);
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

describe("テストの実行の注記（PBI-11b）", () => {
  it("docker を実行できなければ、出力とは分けて、コードと引数の注記にする", async () => {
    const spawnImpl = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setTimeout(() => child.emit("error", new Error("spawn docker ENOENT")), 0);
      return child;
    }) as never;
    const runner = new DockerTestRunner(60_000, spawnImpl);
    const result = await runner.run({
      runId: "r",
      image: "img",
      workspaceDir: "/tmp",
      command: "x",
    });
    expect(result).toMatchObject({
      exitCode: 127,
      output: "",
      note: { code: "run.dockerUnavailable", params: { detail: "spawn docker ENOENT" } },
      // 実行基盤の失敗（テストの結果ではない。PBI-29）
      infrastructure: true,
    });
  });

  it("時間を超えたら止めて、そのことを注記にする（テストの出力には混ぜない）", async () => {
    const docker = fakeDocker([0]);
    const runner = new DockerTestRunner(10, docker.spawnImpl);
    (runner as unknown as { containers: { retryMs: number } }).containers.retryMs = 1;
    const result = await runner.run({
      runId: "r",
      image: "img",
      workspaceDir: "/tmp",
      command: "x",
    });
    expect(result.note).toEqual({ code: "run.testTimeout", params: { minutes: 10 / 60_000 } });
    expect(result.infrastructure).toBe(true);
    expect(result.output).not.toContain("[sacty]");
  });
});
