import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * 置いた添付物のハッシュ（tamper に挙げた道具は、別の中身のハッシュ）に差し替えた写しを実行する。
 */
function run(
  installExit: number,
  options: { tamper?: ("osv" | "gitleaks")[]; missing?: string[]; cache?: string } = {},
) {
  dir ??= mkdtempSync(join(tmpdir(), "sacty-security-tools-"));
  rmSync(join(dir, "fetched"), { force: true });
  rmSync(join(dir, "installed"), { force: true });
  const bin = join(dir, "bin");
  const assets = join(dir, "assets");
  mkdirSync(bin, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const script = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ["#!/bin/sh", ...lines, ""].join("\n"));
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(assets, "osv-scanner_linux_amd64"), "osv");
  const tarball = "gitleaks_8.30.1_linux_x64.tar.gz";
  // 同じ場所で続けて実行するときは、前に作った tar を使い回す（作り直すと、tar に入る更新日時でハッシュが変わるため）
  if (!existsSync(join(assets, tarball))) {
    writeFileSync(join(dir, "gitleaks"), "gitleaks");
    execFileSync("tar", ["-czf", join(assets, tarball), "-C", dir, "gitleaks"]);
  }
  // 取得元のリリースにハッシュのファイルを置いても、それでは確かめない（スクリプトに固定したハッシュで確かめる）
  writeFileSync(join(assets, "osv-scanner_SHA256SUMS"), "0  osv-scanner_linux_amd64\n");
  const osvSha = sha256(join(assets, "osv-scanner_linux_amd64"));
  const gitleaksSha = sha256(join(assets, tarball));
  const pinned = (tool: "osv" | "gitleaks", sha: string) =>
    options.tamper?.includes(tool) ? sha.replace(/^./, (c) => (c === "0" ? "1" : "0")) : sha;
  const copy = join(dir, "install-security-tools.sh");
  writeFileSync(
    copy,
    readFileSync(SCRIPT, "utf8")
      .replace(
        /^OSV_SCANNER_SHA256_AMD64=.*$/m,
        `OSV_SCANNER_SHA256_AMD64=${pinned("osv", osvSha)}`,
      )
      .replace(
        /^GITLEAKS_SHA256_X64=.*$/m,
        `GITLEAKS_SHA256_X64=${pinned("gitleaks", gitleaksSha)}`,
      ),
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
    env: {
      PATH: `${bin}:/usr/bin:/bin:/sbin`,
      ...(options.cache ? { SACTY_DOWNLOAD_CACHE: options.cache } : {}),
    },
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
    const result = run(0, { tamper: ["osv"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "osv-scanner_linux_amd64 のハッシュが、固定したハッシュと合いません",
    );
    expect(result.stdout).not.toContain("を入れました");
  });

  it("osv-scanner が通っても、gitleaks のハッシュが合わなければ、gitleaks を置かずに止める", () => {
    const result = run(0, { tamper: ["gitleaks"] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("osv-scanner 2.7.0 を入れました");
    expect(result.stderr).toContain(
      "gitleaks_8.30.1_linux_x64.tar.gz のハッシュが、固定したハッシュと合いません",
    );
    expect(result.stdout).not.toContain("gitleaks 8.30.1 を入れました");
    expect(readFileSync(join(dir ?? "", "installed"), "utf8")).not.toContain(
      "/usr/local/bin/gitleaks",
    );
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

  describe("ビルドのキャッシュ（SACTY_DOWNLOAD_CACHE）", () => {
    const fetched = () => {
      try {
        return readFileSync(join(dir ?? "", "fetched"), "utf8");
      } catch {
        return "";
      }
    };

    it("取得して確かめたものをキャッシュに置き、次からは取得せずに使う", () => {
      dir = mkdtempSync(join(tmpdir(), "sacty-security-tools-"));
      const cache = join(dir, "cache");
      expect(run(0, { cache }).status).toBe(0);
      expect(fetched()).toContain("osv-scanner_linux_amd64");
      expect(readFileSync(join(cache, "osv-scanner/2.7.0/osv-scanner_linux_amd64"), "utf8")).toBe(
        "osv",
      );
      const second = run(0, { cache });
      expect(second.status).toBe(0);
      expect(fetched()).toBe("");
      expect(second.stdout).toContain(
        "ビルドのキャッシュにある osv-scanner_linux_amd64 を使います",
      );
      expect(second.stdout).toContain("osv-scanner 2.7.0 を入れました");
      expect(second.stdout).toContain("gitleaks 8.30.1 を入れました");
    });

    it("キャッシュの中身が固定したハッシュと合わなければ使わず、取得し直して置き換える", () => {
      dir = mkdtempSync(join(tmpdir(), "sacty-security-tools-"));
      const cache = join(dir, "cache");
      mkdirSync(join(cache, "osv-scanner/2.7.0"), { recursive: true });
      writeFileSync(join(cache, "osv-scanner/2.7.0/osv-scanner_linux_amd64"), "broken");
      const result = run(0, { cache });
      expect(result.status).toBe(0);
      expect(fetched()).toContain("osv-scanner_linux_amd64");
      expect(readFileSync(join(cache, "osv-scanner/2.7.0/osv-scanner_linux_amd64"), "utf8")).toBe(
        "osv",
      );
    });

    it("取得したものがハッシュと合わなければ、キャッシュに置かずに止める", () => {
      dir = mkdtempSync(join(tmpdir(), "sacty-security-tools-"));
      const cache = join(dir, "cache");
      const result = run(0, { cache, tamper: ["osv"] });
      expect(result.status).toBe(1);
      expect(() =>
        readFileSync(join(cache, "osv-scanner/2.7.0/osv-scanner_linux_amd64")),
      ).toThrow();
    });

    it("置いたら、同じ道具のほかの版を消す", () => {
      dir = mkdtempSync(join(tmpdir(), "sacty-security-tools-"));
      const cache = join(dir, "cache");
      mkdirSync(join(cache, "osv-scanner/2.6.0"), { recursive: true });
      writeFileSync(join(cache, "osv-scanner/2.6.0/osv-scanner_linux_amd64"), "old");
      expect(run(0, { cache }).status).toBe(0);
      expect(() =>
        readFileSync(join(cache, "osv-scanner/2.6.0/osv-scanner_linux_amd64")),
      ).toThrow();
    });
  });
});
