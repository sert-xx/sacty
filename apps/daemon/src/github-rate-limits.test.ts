import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubRateLimitStore } from "./github-rate-limits.js";

describe("GitHub のレート制限の待ちの保存（PBI-356）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sacty-rate-limits-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ホストとアカウントごとに、期限と連続した回数を保存し、作り直しても（デーモンを起動し直しても）読める。消したら、ファイルからも消える", () => {
    const file = join(dir, "nested", "github-rate-limits.json");
    const store = new GitHubRateLimitStore(file);
    expect(store.get("github.com:me")).toBeUndefined();
    store.set("github.com:me", { until: 1_000, streak: 2 });
    store.set("ghe.example.com:me", { until: 2_000, streak: 1 });
    const again = new GitHubRateLimitStore(file);
    expect(again.get("github.com:me")).toEqual({ until: 1_000, streak: 2 });
    expect(again.get("ghe.example.com:me")).toEqual({ until: 2_000, streak: 1 });
    // 持ち主だけが読み書きできる
    expect(statSync(file).mode & 0o777).toBe(0o600);
    again.clear("github.com:me");
    const third = new GitHubRateLimitStore(file);
    expect(third.get("github.com:me")).toBeUndefined();
    expect(third.get("ghe.example.com:me")).toEqual({ until: 2_000, streak: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "ghe.example.com:me": { until: 2_000, streak: 1 },
    });
  });

  it("ファイルが無い・壊れている・形が違うときは、待ち無しで始める（読める項目だけを使う）", () => {
    const file = join(dir, "github-rate-limits.json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // まだ保存していない（ファイルが無い）ときは、警告しない
    expect(new GitHubRateLimitStore(file).get("github.com:me")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    // 壊れている・形が違うときは、保存してあった待ちを失ったことを、警告に残す
    for (const content of ["", "{", "[]", "null", '"x"']) {
      warn.mockClear();
      writeFileSync(file, content);
      expect(new GitHubRateLimitStore(file).get("github.com:me")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("読めませんでした"));
    }
    // 読めない（ファイルでなくディレクトリ）ときも、警告に残す
    warn.mockClear();
    expect(new GitHubRateLimitStore(dir).get("github.com:me")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("読めませんでした"));
    warn.mockRestore();
    writeFileSync(
      file,
      JSON.stringify({
        "github.com:me": { until: 5, streak: 1 },
        "github.com:text": { until: "5", streak: 1 },
        "github.com:zero": { until: 5, streak: 0 },
        "github.com:half": { until: 5, streak: 1.5 },
        "github.com:null": null,
        "github.com:huge": { until: 1e300, streak: 1 },
        "github.com:minus": { until: -1, streak: 1 },
      }),
    );
    const partly = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new GitHubRateLimitStore(file);
    // 読めなかった項目があることを、件数つきで警告に残す
    expect(partly).toHaveBeenCalledWith(expect.stringContaining("6 件を読めませんでした"));
    partly.mockRestore();
    expect(store.get("github.com:me")).toEqual({ until: 5, streak: 1 });
    for (const key of ["text", "zero", "half", "null", "huge", "minus"]) {
      expect(store.get(`github.com:${key}`)).toBeUndefined();
    }
  });

  it("ファイルの指定が無ければ、メモリーだけに持つ。保存できなくても、待ちはメモリーに残る（警告を残す）", () => {
    const memory = new GitHubRateLimitStore();
    memory.set("github.com:me", { until: 1, streak: 1 });
    expect(memory.get("github.com:me")).toEqual({ until: 1, streak: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 置き場所の親が、ディレクトリでなくファイル：保存できない
    writeFileSync(join(dir, "blocked"), "x");
    const store = new GitHubRateLimitStore(join(dir, "blocked", "limits.json"));
    store.set("github.com:me", { until: 9, streak: 3 });
    expect(store.get("github.com:me")).toEqual({ until: 9, streak: 3 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("保存できませんでした"));
    warn.mockRestore();
  });
});
