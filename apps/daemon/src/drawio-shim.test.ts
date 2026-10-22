import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** イメージに入れる drawio（draw.io Desktop の CLI を、画面の無いコンテナで動かすもの）。 */
const SHIM = fileURLToPath(
  new URL("../../../packages/cli/docker/drawio-shim.cjs", import.meta.url),
);

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** draw.io の代わり：受け取った引数と DISPLAY を出し、D-Bus のログと本当のエラーを標準エラー出力に書いて、3 で終わる。 */
function fakeDrawio(): string {
  return script("drawio", [
    'echo "display=$DISPLAY args=$*"',
    'echo "[8:1022/010438.473673:ERROR:dbus/bus.cc:406] Failed to connect to the bus" >&2',
    'echo "Error: input file/directory not found: x.drawio" >&2',
    "exit 3",
  ]);
}

/** dir に実行できるスクリプトを置く。 */
function script(name: string, lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "sacty-drawio-"));
  const path = join(dir, name);
  writeFileSync(path, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

function drawio(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(env, args).done;
}

function run(env: Record<string, string>, args: string[]) {
  const child = spawn(process.execPath, [SHIM, ...args], { env });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) =>
      resolve({ code: code ?? (signal === "SIGTERM" ? 143 : -1), stdout, stderr }),
    );
  });
  return { child, done };
}

/** プロセスが無くなるまで待つ（最大 5 秒）。無くなれば true。 */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("イメージの drawio（draw.io の CLI を画面の無いコンテナで動かす）", () => {
  it("サンドボックスと GPU を使わない指定を足して引数をそのまま渡し、終了コードを返し、D-Bus のログだけを除く", async () => {
    const result = await drawio(
      { PATH: process.env.PATH ?? "", DISPLAY: ":42", SACTY_DRAWIO_BIN: fakeDrawio() },
      "-x",
      "-f",
      "png",
      "-o",
      "a b.drawio.png",
      "x.drawio",
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toBe(
      "display=:42 args=--no-sandbox --disable-gpu -x -f png -o a b.drawio.png x.drawio\n",
    );
    expect(result.stderr).toBe("Error: input file/directory not found: x.drawio\n");
  });

  it("標準エラー出力のチャンクが UTF-8 の文字の途中で分かれても、文字を壊さない（PR #191 レビュー指摘）", async () => {
    // 「日」（E6 97 A5）の 1 バイト目だけを先に出し、少し待ってから残りを出す
    const bin = script("drawio", [
      "printf '\\346' >&2",
      "sleep 0.2",
      "printf '\\227\\245本語エラー\\n' >&2",
    ]);
    const result = await drawio({
      PATH: process.env.PATH ?? "",
      DISPLAY: ":1",
      SACTY_DRAWIO_BIN: bin,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("日本語エラー\n");
  });

  it("仮想の画面（Xvfb）の起動を待っている間に止められたら、Xvfb を止めてから終わる（PR #191 レビュー指摘）", async () => {
    // 番号を返さずに待ち続ける Xvfb の代わり。自分の PID を書いてから sleep になる
    script("Xvfb", ['echo $$ > "$PIDFILE"', "exec sleep 30"]);
    const pidFile = join(dir ?? "", "xvfb.pid");
    const { child, done } = run(
      {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        PIDFILE: pidFile,
        SACTY_DRAWIO_BIN: "/nonexistent",
      },
      ["-x"],
    );
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
    }
    expect(pid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    const result = await done;
    expect(result.code).toBe(143);
    expect(result.stderr).not.toContain("仮想の画面");
    expect(await gone(pid)).toBe(true);
  });

  it("DISPLAY が無く、仮想の画面（Xvfb）を起動できなければ、理由を示して止まる", async () => {
    const result = await drawio({ PATH: "/nonexistent", SACTY_DRAWIO_BIN: fakeDrawio() }, "-x");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("drawio: 仮想の画面（Xvfb）を起動できませんでした");
  });
});
