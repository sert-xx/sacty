import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_TEMPLATE, loadConfig } from "./config.js";
import {
  gitHeadCommit,
  SACTY_REPOSITORY,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateChecker,
} from "./update-check.js";

/*
 * sacty の最新版の確かめ（PBI-135）。手元のコミットと GitHub の sacty の main を比べる。
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMPARE_URL = `https://github.com/${SACTY_REPOSITORY}/compare/${COMMIT}...main`;

type Reply = { status?: number; body?: unknown } | Error;

function setup(
  options: { replies?: Reply[]; commit?: string | undefined; enabled?: boolean } = {},
) {
  const replies = [...(options.replies ?? [])];
  const state = {
    now: 1_000_000,
    enabled: options.enabled ?? true,
    urls: [] as string[],
    commitCalls: 0,
  };
  const checker = new UpdateChecker({
    localCommit: async () => {
      state.commitCalls += 1;
      return "commit" in options ? options.commit : COMMIT;
    },
    enabled: () => state.enabled,
    now: () => state.now,
    fetch: (async (url: string) => {
      state.urls.push(url);
      const reply = replies.shift() ?? { body: compare("identical", 0) };
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
    }) as typeof fetch,
  });
  return { checker, state };
}

/** 比較の API の応答。aheadBy は main にあって手元に無いコミット、behindBy は手元だけにあるコミットの数。 */
const compare = (status: string, aheadBy: number, behindBy = 0) => ({
  status,
  ahead_by: aheadBy,
  behind_by: behindBy,
  html_url: COMPARE_URL,
});

describe("main との比べ方", () => {
  it("遅れていれば、遅れている数と差分のページを知らせる。同じ・進んでいるだけなら知らせない", async () => {
    for (const [status, aheadBy, behindBy, expected] of [
      // main が手元より進んでいる（main に手元に無いコミットがある）
      ["ahead", 3, 0, { behindBy: 3, compareUrl: COMPARE_URL }],
      ["ahead", 1, 0, { behindBy: 1, compareUrl: COMPARE_URL }],
      // 手元にも main に無いコミットがある（分かれている）ときも、main の変更が入っていないので知らせる
      ["diverged", 2, 5, { behindBy: 2, compareUrl: COMPARE_URL }],
      ["identical", 0, 0, undefined],
      // 手元が main より進んでいるだけ（開発中のブランチなど）
      ["behind", 0, 4, undefined],
    ] as const) {
      const { checker, state } = setup({ replies: [{ body: compare(status, aheadBy, behindBy) }] });
      await checker.check();
      expect(checker.status(), status).toEqual(expected);
      expect(state.urls).toEqual([
        `https://api.github.com/repos/${SACTY_REPOSITORY}/compare/${COMMIT}...main`,
      ]);
    }
  });

  it("本物の応答の形（main が 4 件進んでいる）を、4 件遅れていると読む", async () => {
    // gh api repos/sert-xx/sacty/compare/<#146 の前のマージ>...main の応答（使う項目だけ）
    const real = {
      ahead_by: 4,
      behind_by: 0,
      html_url: COMPARE_URL,
      status: "ahead",
    };
    const { checker } = setup({ replies: [{ body: real }] });
    await checker.check();
    expect(checker.status()).toEqual({ behindBy: 4, compareUrl: COMPARE_URL });
  });

  it("確かめられないときは、例外にせず黙る（前の知らせも消す）", async () => {
    for (const reply of [
      new Error("ECONNREFUSED"),
      { status: 404, body: { message: "Not Found" } },
      { status: 403, body: { message: "API rate limit exceeded" } },
      { body: { status: "ahead" } },
      { body: { ...compare("ahead", 2), html_url: "javascript:alert(1)" } },
      { body: { ...compare("ahead", -1) } },
    ] as Reply[]) {
      const { checker, state } = setup({ replies: [{ body: compare("ahead", 5) }, reply] });
      await checker.check();
      expect(checker.status()?.behindBy).toBe(5);
      state.now += UPDATE_CHECK_INTERVAL_MS;
      await expect(checker.check()).resolves.toBeUndefined();
      expect(checker.status(), JSON.stringify(reply)).toBeUndefined();
    }
  });

  it("手元のコミットがわからない（git の作業ツリーでない・形が違う）ときは、GitHub に問い合わせない", async () => {
    for (const commit of [undefined, "", "HEAD", "0123abc", `${COMMIT}\n--upload-pack=x`]) {
      const { checker, state } = setup({ commit });
      await checker.check();
      expect(checker.status()).toBeUndefined();
      expect(state.urls, String(commit)).toEqual([]);
    }
  });
});

describe("確かめる間隔", () => {
  it("1日に1回だけ問い合わせる（境界：1日の1ミリ秒前は問い合わせず、ちょうど1日で問い合わせる）", async () => {
    const { checker, state } = setup({
      replies: [{ body: compare("ahead", 1) }, { body: compare("ahead", 4) }],
    });
    await checker.check();
    state.now += UPDATE_CHECK_INTERVAL_MS - 1;
    await checker.check();
    expect(state.urls).toHaveLength(1);
    expect(checker.status()?.behindBy).toBe(1);
    state.now += 1;
    await checker.check();
    expect(state.urls).toHaveLength(2);
    expect(checker.status()?.behindBy).toBe(4);
  });

  it("同時に呼ばれても、問い合わせは1回。手元のコミットは起動のときに1回だけ取る", async () => {
    const { checker, state } = setup({ replies: [{ body: compare("ahead", 1) }] });
    await Promise.all([checker.check(), checker.check(), checker.check()]);
    expect(state.urls).toHaveLength(1);
    state.now += UPDATE_CHECK_INTERVAL_MS;
    await checker.check();
    expect(state.urls).toHaveLength(2);
    expect(state.commitCalls).toBe(1);
  });
});

describe("OFF（config.yaml の update_check: false）", () => {
  it("OFF なら問い合わせず、知らせも出さない。ON に戻したら、間隔を待たずに確かめる", async () => {
    const off = setup({ enabled: false });
    await off.checker.check();
    expect(off.state.urls).toEqual([]);

    const { checker, state } = setup({
      replies: [{ body: compare("ahead", 2) }, { body: compare("ahead", 3) }],
    });
    await checker.check();
    expect(checker.status()?.behindBy).toBe(2);
    state.enabled = false;
    expect(checker.status()).toBeUndefined();
    await checker.check();
    state.enabled = true;
    // OFF の間に知らせを消しているので、ON に戻しても古い知らせは出さない
    expect(checker.status()).toBeUndefined();
    await checker.check();
    expect(state.urls).toHaveLength(2);
    expect(checker.status()?.behindBy).toBe(3);
  });
});

describe("手元のコミット", () => {
  it("sacty のリポジトリの HEAD を 40 桁で返し、git の作業ツリーでなければ undefined", async () => {
    expect(await gitHeadCommit()).toMatch(/^[0-9a-f]{40}$/);
    const dir = mkdtempSync(join(tmpdir(), "sacty-not-git-"));
    try {
      expect(await gitHeadCommit(dir)).toBeUndefined();
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
