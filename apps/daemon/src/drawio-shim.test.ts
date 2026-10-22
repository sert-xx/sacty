import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "sacty-drawio-"));
  const bin = join(dir, "drawio");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'echo "display=$DISPLAY args=$*"',
      'echo "[8:1022/010438.473673:ERROR:dbus/bus.cc:406] Failed to connect to the bus" >&2',
      'echo "Error: input file/directory not found: x.drawio" >&2',
      "exit 3",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

function drawio(env: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [SHIM, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
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

  it("DISPLAY が無く、仮想の画面（Xvfb）を起動できなければ、理由を示して止まる", async () => {
    const result = await drawio({ PATH: "/nonexistent", SACTY_DRAWIO_BIN: fakeDrawio() }, "-x");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("drawio: 仮想の画面（Xvfb）を起動できませんでした");
  });
});
