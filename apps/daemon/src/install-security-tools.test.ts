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
 * GitHub の代わりに、リリースの添付物を置いた場所から返す curl（無いものは失敗）と、x86_64 を返す uname、
 * 指定の終了コードで終わる install を、PATH の先頭に置いて実行する。スクリプトに固定した x86_64 のハッシュは、
 * 置いた添付物のハッシュ（tamper なら、別の中身のハッシュ）に差し替えた写しを実行する。
 */
function run(installExit: number, options: { tamper?: boolean; missing?: string[] } = {}) {
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
  // 取得元のリリースにハッシュのファイルを置いても、それでは確かめない（スクリプトに固定したハッシュで確かめる）
  writeFileSync(join(assets, "osv-scanner_SHA256SUMS"), "0  osv-scanner_linux_amd64\n");
  const osvSha = sha256(join(assets, "osv-scanner_linux_amd64"));
  const gitleaksSha = sha256(join(assets, tarball));
  const pinned = (sha: string) =>
    options.tamper ? sha.replace(/^./, (c) => (c === "0" ? "1" : "0")) : sha;
  const copy = join(dir, "install-security-tools.sh");
  writeFileSync(
    copy,
    readFileSync(SCRIPT, "utf8")
      .replace(/^OSV_SCANNER_SHA256_AMD64=.*$/m, `OSV_SCANNER_SHA256_AMD64=${pinned(osvSha)}`)
      .replace(/^GITLEAKS_SHA256_X64=.*$/m, `GITLEAKS_SHA256_X64=${pinned(gitleaksSha)}`),
  );
  for (const name of options.missing ?? []) rmSync(join(assets, name));
  script("curl", [
    'out=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac; done',
    `echo "$url" >> "${dir}/fetched"`,
    `cp "${assets}/$(basename "$url")" "$out" 2>/dev/null`,
  ]);
  script("uname", ["echo x86_64"]);
  script("install", [`echo "install $*" >> "${dir}/installed"`, `exit ${installExit}`]);
  return spawnSync("sh", [copy], {
    encoding: "utf8",
    // macOS の sha256sum は /sbin にある
    env: { PATH: `${bin}:/usr/bin:/bin:/sbin` },
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
    // ハッシュのファイルは取らない
    expect(readFileSync(join(dir ?? "", "fetched"), "utf8")).not.toMatch(/SHA256SUMS|checksums/);
  });

  it("固定したハッシュと合わなければ、入れずに止める", () => {
    const result = run(0, { tamper: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "osv-scanner_linux_amd64 のハッシュが、固定したハッシュと合いません",
    );
    expect(result.stdout).not.toContain("を入れました");
  });

  it("取得できなければ、警告して続ける", () => {
    const result = run(0, {
      missing: ["osv-scanner_linux_amd64", "gitleaks_8.30.1_linux_x64.tar.gz"],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("を入れました");
    expect(result.stderr).toContain("osv-scanner を入れません");
    expect(result.stderr).toContain("gitleaks を入れません");
  });

  it("アーキテクチャごとに、版の添付物の sha256 を固定している", () => {
    const text = readFileSync(SCRIPT, "utf8");
    for (const name of [
      "OSV_SCANNER_SHA256_AMD64",
      "OSV_SCANNER_SHA256_ARM64",
      "GITLEAKS_SHA256_X64",
      "GITLEAKS_SHA256_ARM64",
    ]) {
      expect(text).toMatch(new RegExp(`^${name}=[0-9a-f]{64}$`, "m"));
    }
  });

  it("置けなければ、入れたとは出さずに警告して続ける", () => {
    const result = run(1);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("を入れました");
    expect(result.stderr).toContain("osv-scanner を入れません（/usr/local/bin に置けない）");
    expect(result.stderr).toContain("gitleaks を入れません（/usr/local/bin に置けない）");
  });
});
