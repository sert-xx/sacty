import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { processSource, TEST_TIMEOUT_MARGIN_MS, testTimeLeftMs, waitFor } from "./wait.js";

const node = (script: string) =>
  spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });

describe("テストの合図の待ち（PBI-85。PR #94 レビュー指摘）", () => {
  it("合図が来れば、そのまま進む", async () => {
    let n = 0;
    await waitFor(() => ++n >= 3, { what: "合図", intervalMs: 1 });
    expect(n).toBe(3);
  });

  it("合図を出すはずのプロセスが先に終わったら、期限を待たずに、終了コード・標準エラー出力の末尾を書いたエラーで落ちる", async () => {
    const child = node('process.stderr.write("cannot start: missing tool"); process.exit(3)');
    const started = Date.now();
    await expect(
      waitFor(() => false, {
        what: "準備の合図",
        source: processSource("偽のコマンド", child),
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(
      /^準備の合図を待っている間に、偽のコマンドが、合図を出さないまま終わった：終了コード 3・シグナル null・標準エラー出力の末尾 "cannot start: missing tool"$/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("終わる直前に合図を出していれば、成功にする", async () => {
    let ready = false;
    const ended = Promise.resolve("done").then((v) => {
      ready = true;
      return v;
    });
    await waitFor(() => ready, { what: "合図", source: { name: "処理", ended } });
  });

  it("合図を出すはずの処理が失敗したら、その理由で落ちる", async () => {
    await expect(
      waitFor(() => false, {
        what: "合図",
        source: { name: "偽の実行", ended: Promise.reject(new Error("spawn ENOENT")) },
      }),
    ).rejects.toThrow("合図を待っている間に、偽の実行が、合図を出さないまま失敗した：spawn ENOENT");
  });

  it("期限を過ぎたら、何を待っていたか・合図を出すはずのものがまだ動いていること・待った時間を書いて落ちる", async () => {
    const child = node("setTimeout(() => {}, 10_000)");
    try {
      await expect(
        waitFor(() => false, {
          what: "準備の合図",
          source: processSource("偽のコマンド", child),
          timeoutMs: 50,
        }),
      ).rejects.toThrow(
        /^準備の合図が来なかった：偽のコマンドはまだ動いている。\d+ms 待った（期限 50ms）$/,
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  // 既定の設定のテスト（時間切れは Vitest の既定の5秒）。期限を省くと、テストの時間切れより前に、理由を書いたエラーで落ちる
  // （期限がテストの時間切れより長いと、汎用の「Test timed out」になって、何を待っていたかがわからない。PR #94 再レビュー指摘）
  it("期限を省いたら、合図を出すはずのものが動き続けて合図だけ来なくても、テストの時間切れより前に理由を書いて落ちる", async () => {
    const left = testTimeLeftMs();
    expect(left).toBeDefined();
    expect(left).toBeLessThanOrEqual(5_000 - TEST_TIMEOUT_MARGIN_MS);
    const started = Date.now();
    const error = await waitFor(() => false, {
      what: "準備の合図",
      source: { name: "偽の実行", ended: new Promise(() => {}) },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(
      /^準備の合図が来なかった：偽の実行はまだ動いている。\d+ms 待った（期限 \d+ms（テストの時間切れの前に止めた））$/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("テストに時間切れを指定していれば、その残りから期限を決める。明示した期限が長くても、残りに収める", {
    timeout: 1_500,
  }, async () => {
    const left = testTimeLeftMs() ?? Number.POSITIVE_INFINITY;
    // 1.5秒の5分の1（0.3秒）を余裕として引く
    expect(left).toBeLessThanOrEqual(1_500 - 300);
    await expect(waitFor(() => false, { what: "合図", timeoutMs: 60_000 })).rejects.toThrow(
      /^合図が来なかった：\d+ms 待った（期限 \d+ms（テストの時間切れの前に止めた））$/,
    );
  });
});
