import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { processSource, waitFor } from "./wait.js";

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

  it("期限を過ぎたら、何を待っていたかを書いて落ちる", async () => {
    const child = node("setTimeout(() => {}, 10_000)");
    try {
      await expect(
        waitFor(() => false, {
          what: "準備の合図",
          source: processSource("偽のコマンド", child),
          timeoutMs: 50,
        }),
      ).rejects.toThrow("準備の合図を 50ms 待ったが、来なかった");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
