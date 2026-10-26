import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** 既定のイメージに、セキュリティの検査の道具を入れるスクリプト（Dockerfile から root で実行する）。 */
const SCRIPT = fileURLToPath(
  new URL("../../../packages/cli/docker/install-security-tools.sh", import.meta.url),
);

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * GitHub の代わりに、リリースの添付物とハッシュのファイルを置いた場所から返す curl と、x86_64 を返す uname、
 * 指定の終了コードで終わる install を、PATH の先頭に置いて実行する。
 */
function run(installExit: number) {
  dir = mkdtempSync(join(tmpdir(), "sacty-security-tools-"));
  const bin = join(dir, "bin");
  const assets = join(dir, "assets");
  mkdirSync(bin);
  mkdirSync(assets);
  const script = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ["#!/bin/sh", ...lines, ""].join("\n"));
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(assets, "osv-scanner_linux_amd64"), "osv");
  writeFileSync(join(dir, "gitleaks"), "gitleaks");
  const tarball = "gitleaks_8.30.1_linux_x64.tar.gz";
  execFileSync("tar", ["-czf", join(assets, tarball), "-C", dir, "gitleaks"]);
  writeFileSync(
    join(assets, "osv-scanner_SHA256SUMS"),
    `${sha256(join(assets, "osv-scanner_linux_amd64"))}  osv-scanner_linux_amd64\n`,
  );
  writeFileSync(
    join(assets, "gitleaks_8.30.1_checksums.txt"),
    `${sha256(join(assets, tarball))}  ${tarball}\n`,
  );
  script("curl", [
    'out=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac; done',
    `cp "${assets}/$(basename "$url")" "$out"`,
  ]);
  script("uname", ["echo x86_64"]);
  script("install", [`echo "install $*" >> "${dir}/installed"`, `exit ${installExit}`]);
  return spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
}

describe("セキュリティの検査の道具を入れる", () => {
  it("ハッシュが合えば、2つとも /usr/local/bin に置いて、入れたことを出す", () => {
    const result = run(0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("osv-scanner 2.7.0 を入れました");
    expect(result.stdout).toContain("gitleaks 8.30.1 を入れました");
    const installed = readFileSync(join(dir ?? "", "installed"), "utf8");
    expect(installed).toContain("/usr/local/bin/osv-scanner");
    expect(installed).toContain("/usr/local/bin/gitleaks");
  });

  it("置けなければ、入れたとは出さずに警告して続ける", () => {
    const result = run(1);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("を入れました");
    expect(result.stderr).toContain("osv-scanner を入れません（/usr/local/bin に置けない）");
    expect(result.stderr).toContain("gitleaks を入れません（/usr/local/bin に置けない）");
  });
});
