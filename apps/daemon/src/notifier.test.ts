import { type Project, renderMessage, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { notificationFor, notificationText, SlackNotifier } from "./notifier.js";
import { MemorySecretStore } from "./secrets.js";

const task = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    projectId: "p1",
    title: "決済の <API> & 画面",
    status: "idle",
    steps: [{ key: "requirements", state: "active" }],
    ...patch,
  }) as Task;

const project = (notification?: Project["notification"]): Project => ({
  id: "p1",
  name: "決済チーム",
  targets: [],
  ...(notification ? { notification } : {}),
  createdAt: "",
  updatedAt: "",
});

/** Slack の偽物。送られたものを記録し、決めた応答を返す。 */
function slack(response: () => Response = () => Response.json({ ok: true })) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return response();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("Slack の通知（PBI-38）", () => {
  it("状態の変わり方から通知することを決める（人間が自分で止めたとき・変わらないときは通知しない）", () => {
    const gate = (submission: number) =>
      task({ status: "awaiting_approval", gate: { step: "requirements", submission } });
    expect(notificationFor(task({ status: "running" }), gate(1))).toBe("approval");
    expect(notificationFor(gate(1), gate(1))).toBeUndefined();
    // 差し戻して出し直したら、もう一度知らせる
    expect(notificationFor(gate(1), gate(2))).toBe("approval");
    expect(notificationFor(gate(1), task({ status: "escalated" }))).toBe("escalation");
    expect(notificationFor(task(), task({ status: "paused", pausedReason: "budget" }))).toBe(
      "paused",
    );
    expect(
      notificationFor(task(), task({ status: "paused", pausedReason: "manual" })),
    ).toBeUndefined();
    const done = task({ steps: [{ key: "requirements", state: "done" }] });
    expect(notificationFor(task(), done)).toBe("completed");
    expect(notificationFor(done, done)).toBeUndefined();
    expect(notificationFor(undefined, task({ status: "queued" }))).toBeUndefined();
  });

  it("本文には、何の判断か・タスクと窓口へのリンク（成果物チェックは PR も）を、プロジェクトの言語で書く", () => {
    const pr = task({
      status: "awaiting_approval",
      gate: { step: "pr", submission: 1 },
      pullRequest: {
        branch: "sacty/t1",
        commit: "abc",
        url: "https://github.com/acme/app/pull/7",
        number: 7,
      },
    });
    const ja = notificationText(pr, "approval", "ja", "http://127.0.0.1:4700/");
    expect(ja).toContain("<http://127.0.0.1:4700/tasks/t1|決済の &lt;API&gt; &amp; 画面>");
    expect(ja).toContain("成果物チェックの承認を待っています");
    expect(ja).toContain("<http://127.0.0.1:4700/tasks/t1/review|承認の画面>");
    expect(ja).toContain("<https://github.com/acme/app/pull/7|#7>（マージで承認）");
    const en = notificationText(pr, "approval", "en", "http://127.0.0.1:4700");
    expect(en).toContain("Deliverable review is waiting for your approval");
    // 要求要件・設計の PR（PBI-57）も、マージで承認する PR を添える
    const step = notificationText(
      task({
        status: "awaiting_approval",
        gate: { step: "requirements", submission: 1 },
        stepPullRequests: [
          {
            step: "requirements",
            branch: "b",
            commit: "c",
            base: "b",
            path: "p",
            url: "https://github.com/acme/app/pull/8",
            number: 8,
            repo: "https://github.com/acme/app",
            submission: 1,
            state: "open",
          },
        ],
      }),
      "approval",
      "ja",
      "http://x",
    );
    expect(step).toContain("要求要件の承認を待っています");
    expect(step).toContain("<https://github.com/acme/app/pull/8|#8>（マージで承認）");
    const paused = notificationText(
      task({
        status: "paused",
        pausedReason: "usage_limit",
        pausedMessage: { code: "orchestrator.failed", params: { detail: "429 Too Many Requests" } },
      }),
      "paused",
      "ja",
      "http://x",
    );
    expect(paused).toContain("一時停止しました（AI の利用上限）");
    expect(paused).toContain("429 Too Many Requests");
    expect(notificationText(task(), "completed", "en", "http://x")).toContain("Done");
    expect(
      notificationText(
        task({
          status: "escalated",
          escalation: {
            step: "pr",
            target: "design",
            pendingRemarks: [],
            reason: "rework_confirmation",
          },
        }),
        "escalation",
        "ja",
        "http://x",
      ),
    ).toContain("PR の指摘の戻し先を確かめてください");
  });

  it("Slack API の形（Proxy を含む）は、チャンネルと本文を送り、トークンがあれば付ける", async () => {
    const api = slack();
    const notifier = new SlackNotifier({
      project: () =>
        project({
          kind: "slack-api",
          url: "https://slack-proxy-a.example.com/api/chat.postMessage",
          channel: "#sacty",
          language: "ja",
        }),
      secrets: new MemorySecretStore({}),
      webUrl: "http://127.0.0.1:4700",
      fetchImpl: api.fetchImpl,
    });
    await notifier.notify(
      task({ status: "awaiting_approval", gate: { step: "requirements", submission: 1 } }),
      "approval",
    );
    expect(api.calls[0]?.url).toBe("https://slack-proxy-a.example.com/api/chat.postMessage");
    expect(api.calls[0]?.headers.get("authorization")).toBeNull();
    expect(api.calls[0]?.body).toMatchObject({ channel: "#sacty", unfurl_links: false });
    expect(String(api.calls[0]?.body.text)).toContain("要求要件の承認を待っています");

    const withToken = slack();
    await new SlackNotifier({
      project: () =>
        project({
          kind: "slack-api",
          url: "https://slack.com/api/chat.postMessage",
          channel: "C123",
          token: "slack-bot",
          language: "en",
        }),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-secret" }),
      webUrl: "http://x",
      fetchImpl: withToken.fetchImpl,
    }).notify(task(), "completed");
    expect(withToken.calls[0]?.headers.get("authorization")).toBe("Bearer xoxb-secret");
  });

  it("Incoming Webhook は、秘密情報の URL に本文を送る", async () => {
    const hook = slack(() => new Response("ok"));
    await new SlackNotifier({
      project: () => project({ kind: "slack-webhook", webhook: "slack-webhook", language: "ja" }),
      secrets: new MemorySecretStore({
        "slack-webhook": "https://hooks.slack.com/services/T/B/SECRET",
      }),
      webUrl: "http://x",
      fetchImpl: hook.fetchImpl,
    }).notify(task(), "completed");
    expect(hook.calls[0]?.url).toBe("https://hooks.slack.com/services/T/B/SECRET");
    expect(Object.keys(hook.calls[0]?.body ?? {})).toEqual(["text"]);
  });

  it("送れなければ（Slack の ok:false も）タスクは止めずに理由を持ち（秘密情報は伏せる）、送れたら消す", async () => {
    let ok = false;
    const api = slack(() =>
      ok
        ? Response.json({ ok: true })
        : Response.json({ ok: false, error: "channel_not_found xoxb-secret" }),
    );
    const notifier = new SlackNotifier({
      project: () =>
        project({
          kind: "slack-api",
          url: "https://slack.com/api/chat.postMessage",
          channel: "#nope",
          token: "slack-bot",
          language: "ja",
        }),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-secret" }),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    // 送れなくても、notify は例外にしない
    await expect(notifier.notify(task(), "completed")).resolves.toBeUndefined();
    const [problem] = notifier.problems();
    expect(renderMessage(problem, "ja")).toBe(
      "プロジェクト「決済チーム」の Slack の通知を送れませんでした：Slack: channel_not_found [secret]（タスクは止めていません）",
    );
    // テストの通知は、理由の例外にする
    await expect(notifier.test("p1")).rejects.toThrow(/channel_not_found/);
    ok = true;
    await notifier.test("p1");
    expect(notifier.problems()).toEqual([]);
    expect(String(api.calls.at(-1)?.body.text)).toContain("テストの通知");
  });

  it("HTTP の失敗の本文で、切り詰める境界をまたぐトークン・Webhook の URL も伏せる（レビュー指摘）", async () => {
    const token = "xoxb-FAKE-TOKEN-0123456789abcdef";
    const webhook = "https://hooks.slack.com/services/T000/B000/FAKEWEBHOOKSECRET";
    for (const pad of [0, 280, 290, 380, 395, 5_000]) {
      for (const [destination, secrets, secret] of [
        [
          {
            kind: "slack-api",
            url: "https://proxy.example.com/api/chat.postMessage",
            channel: "#a",
            token: "bot",
            language: "ja",
          },
          { bot: token },
          token,
        ],
        [{ kind: "slack-webhook", webhook: "hook", language: "ja" }, { hook: webhook }, webhook],
      ] as const) {
        const lines: string[] = [];
        const notifier = new SlackNotifier({
          project: () => project(destination as Project["notification"]),
          secrets: new MemorySecretStore(secrets as Record<string, string>),
          webUrl: "http://x",
          fetchImpl: slack(() => new Response(`${"x".repeat(pad)}${secret}`, { status: 500 }))
            .fetchImpl,
          log: (line) => lines.push(line),
        });
        const thrown = String(await notifier.test("p1").catch((e: Error) => e));
        const shown = [thrown, renderMessage(notifier.problems()[0], "ja"), ...lines].join("\n");
        expect(shown).not.toContain(secret.slice(0, 12));
        expect(shown).not.toContain(secret.slice(-8));
      }
    }
  });

  it("通知先が無いプロジェクトには送らず、テストの通知は理由を返す", async () => {
    const api = slack();
    const notifier = new SlackNotifier({
      project: () => project(),
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    await notifier.notify(task(), "completed");
    expect(api.calls).toHaveLength(0);
    await expect(notifier.test("p1")).rejects.toThrow(/通知先が設定されていません/);
  });
});
