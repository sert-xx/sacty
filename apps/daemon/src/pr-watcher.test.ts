import { describe, expect, it } from "vitest";
import { PullRequestWatcher } from "./pr-watcher.js";

describe("PR の見守り（PBI-14a）", () => {
  it("確認が重ならないようにし、止めるときは実行中の確認を待つ", async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const service = {
      checkPullRequests: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running--;
      },
    };
    const watcher = new PullRequestWatcher(service, 60_000);
    const first = watcher.tick();
    const second = watcher.tick(); // 前の確認が終わるまで、新しい確認はしない
    expect(calls).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(maxRunning).toBe(1);
    await watcher.stop();
    await watcher.tick(); // 止めた後は確認しない
    expect(calls).toBe(1);
  });

  it("確認の失敗は、見守りを止めない", async () => {
    let calls = 0;
    const watcher = new PullRequestWatcher({
      checkPullRequests: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    await watcher.tick();
    await watcher.tick();
    expect(calls).toBe(2);
  });
});
