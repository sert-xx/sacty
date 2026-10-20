import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_TEMPLATE, loadConfig } from "./config.js";
import {
  compareVersions,
  packageVersion,
  parseVersion,
  SACTY_REPOSITORY,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateChecker,
} from "./update-check.js";

/*
 * sacty の最新版の確かめ（PBI-135・PBI-147）。動いている版と GitHub の sacty の最新のリリースを比べる。
 */

const CURRENT = "1.0.0";
const LATEST_URL = `https://api.github.com/repos/${SACTY_REPOSITORY}/releases/latest`;
const releaseUrl = (tag: string) => `https://github.com/${SACTY_REPOSITORY}/releases/tag/${tag}`;

type Reply = { status?: number; body?: unknown } | Error;

/** 最新のリリースの API の応答（使う項目と、実物にある項目のいくつか）。 */
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `sacty ${tag.replace(/^v/, "")}`,
  html_url: releaseUrl(tag),
  draft: false,
  prerelease: false,
  ...extra,
});

function setup(
  options: { replies?: Reply[]; version?: string | undefined; enabled?: boolean } = {},
) {
  const replies = [...(options.replies ?? [])];
  const state = {
    now: 1_000_000,
    enabled: options.enabled ?? true,
    urls: [] as string[],
    versionCalls: 0,
  };
  const checker = new UpdateChecker({
    localVersion: async () => {
      state.versionCalls += 1;
      return "version" in options ? options.version : CURRENT;
    },
    enabled: () => state.enabled,
    now: () => state.now,
    fetch: (async (url: string) => {
      state.urls.push(url);
      const reply = replies.shift() ?? { body: release(`v${CURRENT}`) };
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
    }) as typeof fetch,
  });
  return { checker, state };
}

describe("版の読み方と比べ方", () => {
  it("MAJOR.MINOR.PATCH を読む（先頭の v は任意）。プレリリース・ビルド・桁の足りないもの・先行ゼロは読まない", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" v10.0.1\n")).toEqual([10, 0, 1]);
    for (const bad of [
      "1.2",
      "1",
      "v1.2.3-beta.1",
      "1.2.3+build",
      "01.2.3",
      "main",
      "",
      "x1.2.3",
    ]) {
      expect(parseVersion(bad), bad).toBeUndefined();
    }
  });

  it("数で比べる（1.10.0 は 1.9.0 より新しい）", () => {
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0);
    expect(compareVersions([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(compareVersions([1, 0, 0], [1, 0, 1])).toBeLessThan(0);
  });
});

describe("最新のリリースとの比べ方", () => {
  it("最新のリリースの版が動いている版より新しければ知らせる。同じ・古いなら知らせない", async () => {
    for (const [tag, expected] of [
      ["v1.1.0", { latest: "1.1.0", current: CURRENT, releaseUrl: releaseUrl("v1.1.0") }],
      ["v1.0.1", { latest: "1.0.1", current: CURRENT, releaseUrl: releaseUrl("v1.0.1") }],
      ["v2.0.0", { latest: "2.0.0", current: CURRENT, releaseUrl: releaseUrl("v2.0.0") }],
      // v の無いタグも読む
      ["1.1.0", { latest: "1.1.0", current: CURRENT, releaseUrl: releaseUrl("1.1.0") }],
      ["v1.0.0", undefined],
      // 手元が開発中の新しい版（リリースより進んでいる）なら知らせない
      ["v0.9.9", undefined],
    ] as const) {
      const { checker, state } = setup({ replies: [{ body: release(tag) }] });
      await checker.check();
      expect(checker.status(), tag).toEqual(expected);
      expect(state.urls).toEqual([LATEST_URL]);
    }
  });

  it("本物の応答の形（v1.0.0 のリリース）を、0.1.0 から見て新しい版と読む", async () => {
    // gh api repos/sert-xx/sacty/releases/latest の応答（使う項目と、いくつかの項目）
    const real = {
      tag_name: "v1.0.0",
      name: "sacty 1.0.0",
      html_url: "https://github.com/sert-xx/sacty/releases/tag/v1.0.0",
      draft: false,
      prerelease: false,
      published_at: "2026-10-19T23:55:41Z",
    };
    const { checker } = setup({ version: "0.1.0", replies: [{ body: real }] });
    await checker.check();
    expect(checker.status()).toEqual({
      latest: "1.0.0",
      current: "0.1.0",
      releaseUrl: "https://github.com/sert-xx/sacty/releases/tag/v1.0.0",
    });
  });

  it("確かめられないときは、例外にせず黙る（前の知らせも消す）", async () => {
    for (const reply of [
      new Error("ECONNREFUSED"),
      // リリースが1つも無い
      { status: 404, body: { message: "Not Found" } },
      { status: 403, body: { message: "API rate limit exceeded" } },
      { body: {} },
      { body: { ...release("v1.5.0"), html_url: "javascript:alert(1)" } },
      { body: { ...release("v1.5.0"), html_url: "http://github.com/x" } },
      // タグが版の形でない
      { body: release("v1.5.0-beta.1") },
      { body: release("nightly") },
      // 下書き・プレリリース（latest は返さないはずだが、返っても使わない）
      { body: release("v1.5.0", { draft: true }) },
      { body: release("v1.5.0", { prerelease: true }) },
    ] as Reply[]) {
      const { checker, state } = setup({ replies: [{ body: release("v1.5.0") }, reply] });
      await checker.check();
      expect(checker.status()?.latest).toBe("1.5.0");
      state.now += UPDATE_CHECK_INTERVAL_MS;
      await expect(checker.check()).resolves.toBeUndefined();
      expect(checker.status(), JSON.stringify(reply)).toBeUndefined();
    }
  });

  it("動いている版がわからない（package.json を読めない・形が違う）ときは、GitHub に問い合わせない", async () => {
    for (const version of [undefined, "", "main", "1.0", "1.0.0-dev", "0123abc"]) {
      const { checker, state } = setup({ version });
      await checker.check();
      expect(checker.status()).toBeUndefined();
      expect(state.urls, String(version)).toEqual([]);
    }
  });
});

describe("確かめる間隔", () => {
  it("1日に1回だけ問い合わせる（境界：1日の1ミリ秒前は問い合わせず、ちょうど1日で問い合わせる）", async () => {
    const { checker, state } = setup({
      replies: [{ body: release("v1.1.0") }, { body: release("v1.4.0") }],
    });
    await checker.check();
    state.now += UPDATE_CHECK_INTERVAL_MS - 1;
    await checker.check();
    expect(state.urls).toHaveLength(1);
    expect(checker.status()?.latest).toBe("1.1.0");
    state.now += 1;
    await checker.check();
    expect(state.urls).toHaveLength(2);
    expect(checker.status()?.latest).toBe("1.4.0");
  });

  it("同時に呼ばれても、問い合わせは1回。動いている版は起動のときに1回だけ読む", async () => {
    const { checker, state } = setup({ replies: [{ body: release("v1.1.0") }] });
    await Promise.all([checker.check(), checker.check(), checker.check()]);
    expect(state.urls).toHaveLength(1);
    state.now += UPDATE_CHECK_INTERVAL_MS;
    await checker.check();
    expect(state.urls).toHaveLength(2);
    expect(state.versionCalls).toBe(1);
  });
});

describe("問い合わせの途中で OFF にしたとき（PR #147 レビュー指摘）", () => {
  /** 外から解決できる Promise。 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function controlled() {
    const version = deferred<string | undefined>();
    const reply = deferred<Response>();
    const state = { enabled: true, now: 1_000_000, fetches: 0 };
    const checker = new UpdateChecker({
      localVersion: () => version.promise,
      enabled: () => state.enabled,
      now: () => state.now,
      fetch: (async () => {
        state.fetches += 1;
        return reply.promise;
      }) as typeof fetch,
    });
    const respond = (tag: string) =>
      reply.resolve(new Response(JSON.stringify(release(tag)), { status: 200 }));
    return { checker, state, version, respond };
  }

  it("版を待つ間に OFF にされたら、GitHub に問い合わせない", async () => {
    const { checker, state, version } = controlled();
    const running = checker.check();
    state.enabled = false;
    version.resolve(CURRENT);
    await running;
    expect(state.fetches).toBe(0);
    expect(checker.status()).toBeUndefined();
  });

  it("問い合わせの間に OFF を見て ON に戻したら、その結果は残さず、間隔を待たずに確かめ直す", async () => {
    const { checker, state, version, respond } = controlled();
    version.resolve(CURRENT);
    const running = checker.check();
    await vi.waitFor(() => expect(state.fetches).toBe(1));
    state.enabled = false;
    expect(checker.status()).toBeUndefined();
    state.enabled = true;
    respond("v1.3.0");
    await running;
    expect(checker.status()).toBeUndefined();
    // OFF の間に時刻も消しているので、次の確かめで問い合わせる（1日待たない）
    await checker.check();
    expect(state.fetches).toBe(2);
  });

  it("OFF を status だけで見ても、ON に戻したときに古い知らせを出さず、次の確かめで問い合わせる", async () => {
    const { checker, state, version, respond } = controlled();
    version.resolve(CURRENT);
    respond("v1.2.0");
    await checker.check();
    expect(checker.status()?.latest).toBe("1.2.0");
    state.enabled = false;
    expect(checker.status()).toBeUndefined();
    state.enabled = true;
    expect(checker.status()).toBeUndefined();
    await checker.check();
    expect(state.fetches).toBe(2);
  });
});

describe("OFF（config.yaml の update_check: false）", () => {
  it("OFF なら問い合わせず、知らせも出さない。ON に戻したら、間隔を待たずに確かめる", async () => {
    const off = setup({ enabled: false });
    await off.checker.check();
    expect(off.state.urls).toEqual([]);
    // 動いている版も読まない
    expect(off.state.versionCalls).toBe(0);

    const { checker, state } = setup({
      replies: [{ body: release("v1.2.0") }, { body: release("v1.3.0") }],
    });
    await checker.check();
    expect(checker.status()?.latest).toBe("1.2.0");
    state.enabled = false;
    expect(checker.status()).toBeUndefined();
    await checker.check();
    state.enabled = true;
    // OFF の間に知らせを消しているので、ON に戻しても古い知らせは出さない
    expect(checker.status()).toBeUndefined();
    await checker.check();
    expect(state.urls).toHaveLength(2);
    expect(checker.status()?.latest).toBe("1.3.0");
  });
});

describe("動いている版", () => {
  it("apps/daemon/package.json の version を返し、読めない・version が無いファイルなら undefined", async () => {
    expect(await packageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    const dir = mkdtempSync(join(tmpdir(), "sacty-pbi147-version-"));
    try {
      expect(await packageVersion(join(dir, "missing.json"))).toBeUndefined();
      writeFileSync(join(dir, "no-version.json"), JSON.stringify({ name: "x" }));
      expect(await packageVersion(join(dir, "no-version.json"))).toBeUndefined();
      writeFileSync(join(dir, "broken.json"), "{");
      expect(await packageVersion(join(dir, "broken.json"))).toBeUndefined();
      writeFileSync(join(dir, "ok.json"), JSON.stringify({ version: "2.3.4" }));
      expect(await packageVersion(join(dir, "ok.json"))).toBe("2.3.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config.yaml の update_check", () => {
  it("書かなければ ON、false なら OFF。真偽でない値は誤り", () => {
    const dir = mkdtempSync(join(tmpdir(), "sacty-pbi135-config-"));
    const load = (extra: string) => {
      writeFileSync(
        join(dir, "config.yaml"),
        `default_agent: s\nagents:\n  s:\n    runtime: stub\n${extra}`,
      );
      return loadConfig(dir);
    };
    try {
      expect(load("")).toMatchObject({ ok: true, config: { updateCheck: true } });
      expect(load("update_check: false\n")).toMatchObject({
        ok: true,
        config: { updateCheck: false },
      });
      expect(load('update_check: "off"\n').ok).toBe(false);
      // 雛形は ON のまま（OFF の例はコメントだけ）
      expect(CONFIG_TEMPLATE).toMatch(/^# update_check: false$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
