import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitNamed } from "./shutdown-report.js";

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("デーモンを止めるときの後片付けの表示", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("時間がたっても終わらないものだけを表示する（終わったものは除く）", async () => {
    const done = deferred();
    const slow = deferred();
    const log = vi.fn();
    const waiting = waitNamed({ 取り込み: done.promise, "PR の確認": slow.promise }, 3_000, log);

    done.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(log).toHaveBeenCalledExactlyOnceWith("[daemon] 後片付けを待っています：PR の確認");

    slow.resolve();
    await waiting;
  });

  it("時間内に終われば、何も表示しない", async () => {
    const log = vi.fn();
    await waitNamed({ 取り込み: Promise.resolve() }, 3_000, log);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(log).not.toHaveBeenCalled();
  });

  it("失敗した後処理も、終わったものとして扱い、失敗を返す", async () => {
    const log = vi.fn();
    await expect(
      waitNamed({ 取り込み: Promise.reject(new Error("x")) }, 3_000, log),
    ).rejects.toThrow("x");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(log).not.toHaveBeenCalled();
  });
});
