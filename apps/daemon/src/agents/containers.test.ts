import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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
    // 遅れてコンテナができた場合に備えて、終わった後も docker kill を繰り返した
    expect(docker.calls.filter((a) => a[0] === "kill").length).toBeGreaterThanOrEqual(2);
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
