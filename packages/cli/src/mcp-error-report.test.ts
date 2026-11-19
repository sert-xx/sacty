import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ActivityEvent } from "@sacty/core";
import { describeTask, READ_REASONS, startTaskMcp } from "@sacty/daemon/task-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "../../../apps/daemon/src/activity.js";
import { createApp } from "../../../apps/daemon/src/server.js";
import { SessionLogStore } from "../../../apps/daemon/src/session-logs.js";
import { dbPath, dir, makeService, useTempDir } from "../../../apps/daemon/src/testing/daemon.js";
import { type Fetch, writeDaemonFile } from "./context-preview.js";
import { daemonApi } from "./mcp.js";

const TOKEN = "t".repeat(64);
const MARKER = "MARKER-STALE-LOG-9f3a";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-mcp-"));
  writeDaemonFile(home, { url: "http://127.0.0.1:4710", token: TOKEN });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

useTempDir();

const ciFailed = (number: number) => ({ number, commit: "abc", checks: [{ name: "build" }] });

/** 閉じられなかった実行（finishedAt の無い meta.json と、目印の入った保存済みのログ）を持つタスクの、本物のサービス。 */
function world() {
  const runsDir = join(dir, "runs");
  const activity = new SqliteActivityStore(dbPath);
  // 閉じる前にデーモンが止まった実行。起動し直したデーモン（同じ置き場所で、開いている実行は無い）を、サービスに渡す
  const before = new SessionLogStore(runsDir);
  const { service } = makeService(activity, [], { sessionLogs: new SessionLogStore(runsDir) });
  const task = service.createTask({ projectId: "default", title: "題" });
  const handle = before.open(
    {
      taskId: task.id,
      runId: "run-1",
      role: "requirements",
      agentId: "claude",
      runtime: "claude-code",
      authMode: "api-key",
    },
    () => [],
  );
  const say = (text: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  handle.stdout(`${say(`${MARKER} 日本語の行：あいうえお`)}\n`);
  handle.stderr(`${MARKER} 標準エラーの行\n`);
  const append = (type: string, payload: Record<string, unknown>) =>
    activity.append({
      taskId: task.id,
      projectId: "default",
      events: [{ actor: "sacty", event: { type, payload } as never }],
    });
  append("PullRequestCiFailed", ciFailed(1));
  const app = createApp(service, TOKEN);
  return { activity, service, task, app, append, handle };
}

type Calls = { url: string }[];

async function connect(fetcher: Fetch) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  startTaskMcp(daemonApi(home, fetcher), { version: "1", transport: a });
  const client = new Client(
    { name: "t", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(b);
  const raw = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return { isError: result.isError === true, text, structured: result.structuredContent };
  };
  return { client, raw };
}

type Report = {
  text: string;
  offset: number;
  next: number;
  clipped: boolean;
  clamped: boolean;
  totalBytes: number;
  fingerprint: string;
};

function through(w: ReturnType<typeof world>): { fetcher: Fetch; calls: Calls } {
  const calls: Calls = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url });
    const u = new URL(url);
    return w.app.request(`${u.pathname}${u.search}`, init);
  };
  return { fetcher, calls };
}

describe("get_error_report：本物のサービス・本物の API・本物の daemonApi を通す（PBI-404）", () => {
  it("閉じられなかった実行のログは省いたものだけを返し、画面の経路（入力なし）には従来どおり入る", async () => {
    const w = world();
    const { fetcher } = through(w);
    const { client, raw } = await connect(fetcher);
    const one = await raw("get_error_report", { task_id: w.task.id, max_bytes: 100_000 });
    expect(one.isError).toBe(false);
    const whole = (one.structured as Report).text;
    expect(whole).not.toContain(MARKER);
    expect(whole).toContain("ログの中身を省きました");
    expect(whole).not.toContain("保存済みのログです");

    // 画面のダウンロード（入力なし）は、前と同じ
    const screen = await w.app.request(`/api/tasks/${w.task.id}/error-report`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(screen.status).toBe(200);
    expect(screen.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(screen.headers.get("x-sacty-stale-logs")).toBeNull();
    const screenText = await screen.text();
    expect(screenText).toContain(MARKER);
    expect(screenText).toContain("デーモンが止まって閉じられなかった実行の、保存済みのログです");
    await client.close();
    w.activity.close();
  });

  it("デーモンの入力：stale=omit は省いて印を付け、無い・omit 以外の値は省かず印も付けない。見えないタスクは 404", async () => {
    const w = world();
    const get = (qs: string, id = w.task.id) =>
      w.app.request(`/api/tasks/${id}/error-report${qs}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    const omitted = await get("?stale=omit");
    expect(omitted.status).toBe(200);
    expect(omitted.headers.get("x-sacty-stale-logs")).toBe("omitted");
    expect(omitted.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await omitted.text()).not.toContain(MARKER);
    for (const qs of ["", "?lang=en", "?stale=", "?stale=keep", "?stale=OMIT", "?stale=omit2"]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(200);
      expect(res.headers.get("x-sacty-stale-logs"), qs).toBeNull();
      expect(await res.text(), qs).toContain(MARKER);
    }
    const missing = await get("?stale=omit", "nothing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(missing.headers.get("x-sacty-stale-logs")).toBeNull();
    w.activity.close();
  });

  it("分けて読むと、連結が同じ時点の全体と一致する（日本語の文字が壊れない）。範囲の外の offset は空", async () => {
    const w = world();
    const { fetcher } = through(w);
    const { client, raw } = await connect(fetcher);
    const full = (
      (await raw("get_error_report", { task_id: w.task.id, max_bytes: 100_000 }))
        .structured as Report
    ).text;
    const total = Buffer.byteLength(full);
    let joined = "";
    let offset = 0;
    let fingerprint: string | undefined;
    let reads = 0;
    for (;;) {
      const r = await raw("get_error_report", {
        task_id: w.task.id,
        max_bytes: 400,
        offset,
        ...(fingerprint ? { fingerprint } : {}),
      });
      expect(r.isError, r.text).toBe(false);
      const part = r.structured as Report;
      expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(400);
      expect(part.text).not.toContain("�");
      expect(part.totalBytes).toBe(total);
      expect(part.offset).toBe(offset);
      joined += part.text;
      fingerprint = part.fingerprint;
      reads++;
      if (!part.clipped) break;
      offset = part.next;
    }
    expect(reads).toBeGreaterThan(2);
    // 作成時刻の行（毎回変わる）を除いて、同じ中身
    const strip = (t: string) => t.replace(/^- (レポートの作成|Report created).*$/m, "");
    expect(strip(joined)).toBe(strip(full));

    const beyond = (await raw("get_error_report", { task_id: w.task.id, offset: total + 10 }))
      .structured as Report;
    expect(beyond).toMatchObject({ text: "", offset: total, next: total, clipped: false });
    const clamped = (await raw("get_error_report", { task_id: w.task.id, max_bytes: 999_999 }))
      .structured as Report;
    expect(clamped.clamped).toBe(true);
    await client.close();
    w.activity.close();
  });

  it("作業履歴が増えて全体が変わったら、続きを返さず、読み直しを案内する。変わっていなければ読める", async () => {
    const w = world();
    const { fetcher } = through(w);
    const { client, raw } = await connect(fetcher);
    const first = (await raw("get_error_report", { task_id: w.task.id, max_bytes: 300 }))
      .structured as Report;
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 時間が進んで作成時刻が変わっても、中身が同じなら指紋は同じ（続きが読める）
    await new Promise((r) => setTimeout(r, 5));
    const same = await raw("get_error_report", {
      task_id: w.task.id,
      max_bytes: 300,
      offset: first.next,
      fingerprint: first.fingerprint,
    });
    expect(same.isError).toBe(false);
    expect((same.structured as Report).fingerprint).toBe(first.fingerprint);

    w.append("PullRequestCiFailed", ciFailed(2));
    const changed = await raw("get_error_report", {
      task_id: w.task.id,
      max_bytes: 300,
      offset: first.next,
      fingerprint: first.fingerprint,
    });
    expect(changed.isError).toBe(true);
    expect(changed.text).toContain(READ_REASONS.reportChanged);
    expect(changed.text).toContain("読み直して");
    expect(changed.structured).toBeUndefined();
    // 指紋を付けずに読み直せる
    const again = await raw("get_error_report", { task_id: w.task.id, max_bytes: 300 });
    expect(again.isError).toBe(false);
    expect((again.structured as Report).fingerprint).not.toBe(first.fingerprint);
    await client.close();
    w.activity.close();
  });

  it("成功も断りも、作業履歴・タスクの数・状態を変えない", async () => {
    const w = world();
    const { fetcher } = through(w);
    const { client, raw } = await connect(fetcher);
    const snapshot = () =>
      JSON.stringify([
        w.activity.forTask(w.task.id).length,
        w.service.list().length,
        w.service.get(w.task.id)?.task.status,
      ]);
    const before = snapshot();
    await raw("get_error_report", { task_id: w.task.id });
    await raw("get_error_report", { task_id: w.task.id, lang: "en" });
    expect((await raw("get_error_report", { task_id: "nothing" })).isError).toBe(true);
    expect(
      (await raw("get_error_report", { task_id: w.task.id, fingerprint: "0".repeat(64) })).isError,
    ).toBe(true);
    expect(snapshot()).toBe(before);
    await client.close();
    w.activity.close();
  });
});

describe("get_error_report：前の版のデーモン・断り方", () => {
  it("省いたことの印が無い応答（前の版）は、本文を返さずに断る。理由に、起動し直しが分かる文が入る", async () => {
    const w = world();
    const calls: string[] = [];
    // 入力（?stale=omit）を無視して、省いていないレポートを 200 で返す、前の版に相当するデーモン
    const fetcher: Fetch = async (url) => {
      calls.push(url);
      const u = new URL(url);
      return w.app.request(`${u.pathname}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    };
    const { client, raw } = await connect(fetcher);
    const r = await raw("get_error_report", { task_id: w.task.id });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("stale=omit");
    expect(r.isError).toBe(true);
    expect(r.text).toBe(READ_REASONS.reportNotOmitted);
    expect(r.text).toContain("起動し直して");
    expect(JSON.stringify(r)).not.toContain(MARKER);
    expect(r.structured).toBeUndefined();
    await client.close();
    w.activity.close();
  });

  it("前の版の断りの標準エラーにも、本文は出ない", async () => {
    const w = world();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const fetcher: Fetch = async (url) =>
      w.app.request(new URL(url).pathname, { headers: { authorization: `Bearer ${TOKEN}` } });
    const { client, raw } = await connect(fetcher);
    await raw("get_error_report", { task_id: w.task.id });
    spy.mockRestore();
    err.mockRestore();
    expect(writes.join("")).not.toContain(MARKER);
    await client.close();
    w.activity.close();
  });

  it("無いタスク・形の悪い ID・知らない引数・知らない lang・5xx・停止・時間切れは、理由を返し、本文を入れない", async () => {
    const w = world();
    const { fetcher, calls } = through(w);
    const { client, raw } = await connect(fetcher);
    const missing = await raw("get_error_report", { task_id: "nothing" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("見つかりません");
    const before = calls.length;
    const badId = await raw("get_error_report", { task_id: "../x" });
    expect(badId.isError).toBe(true);
    expect(badId.text).toContain(READ_REASONS.invalidId);
    const unknownArg = await raw("get_error_report", { task_id: w.task.id, full: true });
    expect(unknownArg.isError).toBe(true);
    expect(unknownArg.text).toContain("full");
    const badLang = await raw("get_error_report", { task_id: w.task.id, lang: "fr" });
    expect(badLang.isError).toBe(true);
    // 形の悪い ID・知らない引数・知らない lang では、API を呼ばない
    expect(calls.length).toBe(before);
    await client.close();

    const reasons = async (reply: () => Promise<Response>) => {
      const c = await connect(async () => reply());
      const r = await c.raw("get_error_report", { task_id: "t1" });
      await c.client.close();
      return r;
    };
    const server = await reasons(async () => new Response(`500 ${MARKER}`, { status: 500 }));
    expect(server.isError).toBe(true);
    expect(server.text).toContain("500");
    expect(server.text).not.toContain(MARKER);
    const down = await reasons(async () => {
      throw Object.assign(new Error(`connect ${MARKER}`), { code: "ECONNREFUSED" });
    });
    expect(down.isError).toBe(true);
    expect(down.text).toContain("つながりません");
    expect(down.text).not.toContain(MARKER);
    const timeout = await reasons(async () => {
      throw Object.assign(new Error(MARKER), { name: "TimeoutError" });
    });
    expect(timeout.isError).toBe(true);
    expect(timeout.text).toContain("時間内に応答しませんでした");
    expect(timeout.text).not.toContain(MARKER);
    w.activity.close();
  });
});

describe("get_task の errorReportWorthReading（画面がエラーレポートの欄を出す条件と同じ）", () => {
  const event = (type: string, payload: Record<string, unknown>): ActivityEvent =>
    ({ at: "2026-01-01T00:00:00.000Z", actor: "sacty", type, payload }) as never;

  it("エラーの記録なし・エラーの記録あり・分析の記録だけあり", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    const task = service.createTask({ projectId: "default", title: "題" });
    const worth = (t: typeof task, events: ActivityEvent[]) =>
      describeTask({ task: t, activity: events }).errorReportWorthReading;
    // なし（分析の依頼・結果はエラーに数えない）
    expect(worth(task, [event("PullRequestCiRecovered", { number: 1, commit: "abc" })])).toBe(
      false,
    );
    // 作業履歴にエラーの記録がある
    expect(worth(task, [event("PullRequestCiFailed", ciFailed(1))])).toBe(true);
    // 分析の記録だけある（作業履歴にエラーは無い）
    const analysed = { ...task, errorAnalyses: [{ id: "A-1" }] } as never;
    expect(worth(analysed, [])).toBe(true);
    activity.close();
  });
});
