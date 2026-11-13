import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** ビルドのキャッシュを使うように設定して、コマンドを実行するスクリプト（Dockerfile から root で実行する）。 */
const SCRIPT = fileURLToPath(
  new URL("../../../packages/cli/docker/with-build-cache.sh", import.meta.url),
);

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** キャッシュの場所を cache にして、渡された APT_CONFIG・SACTY_DOWNLOAD_CACHE と apt の設定のファイルを出力させる。 */
function run(cache: string, env: Record<string, string> = {}) {
  return spawnSync(
    "sh",
    [
      SCRIPT,
      "sh",
      "-c",
      'printf "%s\\n%s\\n" "$APT_CONFIG" "$SACTY_DOWNLOAD_CACHE"; [ -z "$APT_CONFIG" ] || cat "$APT_CONFIG"',
    ],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", SACTY_BUILD_CACHE_DIR: cache, ...env },
    },
  );
}

describe("ビルドのキャッシュを使う設定（with-build-cache.sh）", () => {
  it("キャッシュがあれば、apt の .deb の置き場所と取得物の置き場所を渡す", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-build-cache-"));
    const result = run(dir);
    expect(result.status).toBe(0);
    const [aptConfig, downloads, ...conf] = result.stdout.split("\n");
    expect(aptConfig).toBe(join(dir, "apt.conf"));
    expect(downloads).toBe(join(dir, "downloads"));
    expect(conf.join("\n")).toBe(`Dir::Cache::Archives "${dir}/apt/";\n`);
  });

  it("元のイメージの APT_CONFIG は、#include で読み込んで引き継ぐ（プロキシなどを失わない。レビュー指摘）", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-build-cache-"));
    const cache = join(dir, "cache");
    mkdirSync(cache);
    const original = join(dir, "original.conf");
    writeFileSync(original, 'Acquire::http::Proxy "http://proxy.example.com:3128";\n');
    const result = run(cache, { APT_CONFIG: original });
    expect(result.status).toBe(0);
    expect(readFileSync(join(cache, "apt.conf"), "utf8")).toBe(
      `#include "${original}";\nDir::Cache::Archives "${cache}/apt/";\n`,
    );
  });

  it("APT_CONFIG のファイルが無ければ、読み込まない", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-build-cache-"));
    const result = run(dir, { APT_CONFIG: join(dir, "missing.conf") });
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "apt.conf"), "utf8")).not.toContain("#include");
  });

  it("キャッシュの場所が無ければ、何も設定せずに実行する", () => {
    dir = mkdtempSync(join(tmpdir(), "sacty-build-cache-"));
    const result = run(join(dir, "missing"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\n\n");
  });
});
