import {
  type NotificationKind,
  type Project,
  renderMessage,
  type SlackNotification,
  type Task,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  mentionText,
  notificationFor,
  notificationText,
  SlackNotifier,
  withMention,
} from "./notifier.js";
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

const project = (id: string, name: string): Project => ({
  id,
  name,
  targets: [],
  createdAt: "",
  updatedAt: "",
});
const projects: Record<string, Project> = {
  p1: project("p1", "決済チーム"),
  p2: project("p2", "検索チーム"),
};

/** sacty の設定の通知先（PBI-115）と、タスクのプロジェクト。 */
const dest = (notification?: SlackNotification) => ({
  notification: () => notification,
  project: (id: string) => projects[id],
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

  it("本文には、何の判断か・タスクと窓口へのリンク（実装の承認は PR も）を、プロジェクトの言語で書く", () => {
    const pr = task({
      status: "awaiting_approval",
      gate: { step: "implement", submission: 1 },
      pullRequest: {
        branch: "sacty/t1",
        commit: "abc",
        url: "https://github.com/acme/app/pull/7",
        number: 7,
      },
    });
    const ja = notificationText(pr, "approval", "ja", "http://127.0.0.1:4700/");
    expect(ja).toContain("<http://127.0.0.1:4700/tasks/t1|決済の &lt;API&gt; &amp; 画面>");
    expect(ja).toContain("実装の承認を待っています");
    expect(ja).toContain("<http://127.0.0.1:4700/tasks/t1/review|承認の画面>");
    expect(ja).toContain("<https://github.com/acme/app/pull/7|#7>（マージで承認）");
    const en = notificationText(pr, "approval", "en", "http://127.0.0.1:4700");
    expect(en).toContain("Implement is waiting for your approval");
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
            step: "implement",
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
      ...dest({
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
    expect(api.calls[0]?.body).toMatchObject({
      channel: "#sacty",
      unfurl_links: false,
      // 送り手の名前とアイコン（PBI-68）
      username: "Sacty",
      icon_url: "https://raw.githubusercontent.com/sert-xx/sacty/main/assets/sacty-icon.png",
    });
    // 絵文字のアイコンは付けない（icon_url と競合させない）
    expect(api.calls[0]?.body).not.toHaveProperty("icon_emoji");
    expect(String(api.calls[0]?.body.text)).toContain("要求要件の承認を待っています");

    const withToken = slack();
    await new SlackNotifier({
      ...dest({
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
      ...dest({ kind: "slack-webhook", webhook: "slack-webhook", language: "ja" }),
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
      ...dest({
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
      "Slack の通知を送れませんでした：Slack: channel_not_found [secret]（タスクは止めていません）",
    );
    // テストの通知は、理由の例外にする
    await expect(notifier.test()).rejects.toThrow(/channel_not_found/);
    ok = true;
    await notifier.test();
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
          ...dest(destination as Project["notification"]),
          secrets: new MemorySecretStore(secrets as Record<string, string>),
          webUrl: "http://x",
          fetchImpl: slack(() => new Response(`${"x".repeat(pad)}${secret}`, { status: 500 }))
            .fetchImpl,
          log: (line) => lines.push(line),
        });
        const thrown = String(await notifier.test().catch((e: Error) => e));
        const shown = [thrown, renderMessage(notifier.problems()[0], "ja"), ...lines].join("\n");
        expect(shown).not.toContain(secret.slice(0, 12));
        expect(shown).not.toContain(secret.slice(-8));
      }
    }
  });

  it("通知先が無いプロジェクトには送らず、テストの通知は理由を返す", async () => {
    const api = slack();
    const notifier = new SlackNotifier({
      ...dest(),
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    await notifier.notify(task(), "completed");
    expect(api.calls).toHaveLength(0);
    await expect(notifier.test()).rejects.toThrow(/通知先が設定されていません/);
  });
});

describe("sacty の設定の通知先（PBI-115）", () => {
  const destination = {
    kind: "slack-api" as const,
    url: "https://slack.example.com/api/chat.postMessage",
    channel: "#sacty",
    language: "ja" as const,
  };

  it("すべてのプロジェクトのタスクを1つの送り先に送り、題名の前にプロジェクトの名前を入れる", async () => {
    const api = slack();
    const notifier = new SlackNotifier({
      ...dest(destination),
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    await notifier.notify(task({ id: "t1", projectId: "p1", title: "決済" }), "completed");
    await notifier.notify(task({ id: "t2", projectId: "p2", title: "検索" }), "completed");
    expect(api.calls.map((c) => c.url)).toEqual([destination.url, destination.url]);
    expect(api.calls.map((c) => c.body.channel)).toEqual(["#sacty", "#sacty"]);
    expect(String(api.calls[0]?.body.text)).toMatch(
      /^:white_check_mark: \[決済チーム\] <http:\/\/x\/tasks\/t1\|決済>/,
    );
    expect(String(api.calls[1]?.body.text)).toMatch(
      /^:white_check_mark: \[検索チーム\] <http:\/\/x\/tasks\/t2\|検索>/,
    );
  });

  it("プロジェクトの名前の mrkdwn の文字は逃がし、プロジェクトが分からなければ名前を付けない", () => {
    expect(notificationText(task(), "completed", "ja", "http://x", "A <&> B")).toContain(
      "[A &lt;&amp;&gt; B] <http://x/tasks/t1|",
    );
    expect(notificationText(task(), "completed", "ja", "http://x")).toMatch(
      /^:white_check_mark: <http:\/\/x\/tasks\/t1\|/,
    );
  });

  it("通知先が無ければ送らない。設定を読めなければ送らずに理由を持ち、テストの通知は理由を返す", async () => {
    const api = slack();
    const none = new SlackNotifier({
      ...dest(),
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    await none.notify(task(), "completed");
    await expect(none.test()).rejects.toThrow(/sacty の設定に、Slack の通知先が設定されていません/);
    expect(none.problems()).toEqual([]);
    const broken = new SlackNotifier({
      notification: () => {
        throw new Error("settings are broken");
      },
      project: () => undefined,
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    await expect(broken.notify(task(), "completed")).resolves.toBeUndefined();
    expect(renderMessage(broken.problems()[0], "ja")).toContain("settings are broken");
    expect(api.calls).toHaveLength(0);
  });

  it("送れなかった理由は sacty 全体で1つ。通知先を外したら、前の理由は出さない", async () => {
    let current: SlackNotification | undefined = destination;
    const notifier = new SlackNotifier({
      notification: () => current,
      project: (id) => projects[id],
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: slack(() => new Response("down", { status: 503 })).fetchImpl,
    });
    await notifier.notify(task({ projectId: "p1" }), "completed");
    await notifier.notify(task({ projectId: "p2" }), "completed");
    expect(notifier.problems()).toHaveLength(1);
    current = undefined;
    expect(notifier.problems()).toEqual([]);
  });
});

describe("通知の本文の工程の名前（PBI-115）", () => {
  const cases: [string, Partial<Task>, NotificationKind, string, string][] = [
    [
      "承認待ち",
      { status: "awaiting_approval", gate: { step: "design", submission: 1 } },
      "approval",
      "設計の承認を待っています",
      "Design is waiting for your approval",
    ],
    [
      "再現の判断",
      { status: "awaiting_approval", gate: { step: "reproduce", submission: 1 } },
      "approval",
      "再現の工程で再現できなかったため",
      "Reproduce: the bug was not reproduced",
    ],
    [
      "統合レビューの判断",
      {
        status: "awaiting_approval",
        gate: { step: "integrate", submission: 1 },
        integration: { passed: false } as Task["integration"],
      },
      "approval",
      "統合レビューに通らないため",
      "Integration review keeps failing",
    ],
    [
      "エスカレーション",
      {
        status: "escalated",
        escalation: { step: "requirements", target: "requirements", pendingRemarks: [] },
      } as Partial<Task>,
      "escalation",
      "要求要件でエスカレーションしました。判断してください",
      "Escalated in Requirements; your decision is needed",
    ],
    [
      "PR の指摘の戻し先の確認",
      {
        status: "escalated",
        escalation: {
          step: "implement",
          target: "design",
          pendingRemarks: [],
          reason: "rework_confirmation",
        },
      } as Partial<Task>,
      "escalation",
      "実装でエスカレーションしました。PR の指摘の戻し先を確かめてください",
      "Escalated in Implement: confirm the step to redo",
    ],
    [
      "工程の途中の一時停止",
      {
        status: "paused",
        pausedReason: "budget",
        steps: [
          { key: "requirements", state: "done" },
          { key: "implement", state: "active" },
        ],
      },
      "paused",
      "実装で一時停止しました（予算の上限）",
      "Paused in Implement (budget cap)",
    ],
    [
      "工程を決める前の一時停止",
      { status: "paused", pausedReason: "error", steps: [] },
      "paused",
      "工程を決める前に一時停止しました（エラー）",
      "Paused before the steps were decided (error)",
    ],
  ];
  for (const [name, patch, kind, ja, en] of cases) {
    it(`${name}：日英の本文に工程の名前を入れる`, () => {
      expect(notificationText(task(patch), kind, "ja", "http://x", "決済チーム")).toContain(ja);
      expect(notificationText(task(patch), kind, "en", "http://x", "決済チーム")).toContain(en);
    });
  }

  it("工程に結びつかない完了と、工程の分からない一時停止には、工程を入れない", () => {
    const done = task({ steps: [{ key: "implement", state: "done" }] });
    const ja = notificationText(done, "completed", "ja", "http://x", "決済チーム");
    expect(ja.split("\n")[1]).toBe("完了しました");
    expect(notificationText(done, "completed", "en", "http://x").split("\n")[1]).toBe("Done");
    const paused = task({
      status: "paused",
      pausedReason: "auth",
      steps: [{ key: "implement", state: "done" }],
    });
    expect(notificationText(paused, "paused", "ja", "http://x").split("\n")[1]).toBe(
      "一時停止しました（認証エラー）",
    );
    expect(notificationText(paused, "paused", "en", "http://x").split("\n")[1]).toBe(
      "Paused (authentication error)",
    );
  });
});

describe("Slack の通知のメンション（PBI-69）", () => {
  const all = ["U0123ABCD", "W0456", "S0789EFGH", "@here", "@channel"];
  const gate = task({ status: "awaiting_approval", gate: { step: "requirements", submission: 1 } });
  const byKind = {
    approval: gate,
    escalation: task({ status: "escalated", escalation: { step: "design" } } as Partial<Task>),
    paused: task({ status: "paused", pausedReason: "budget" }),
    completed: task(),
  } as const;

  it("相手ごとに Slack のメンションの書き方にし、選んだ種類の本文の先頭にだけ付ける", () => {
    expect(mentionText({ targets: all, kinds: ["approval"] })).toBe(
      "<@U0123ABCD> <@W0456> <!subteam^S0789EFGH> <!here> <!channel>",
    );
    expect(mentionText(undefined)).toBe("");
    const mention = { targets: ["U0123ABCD", "@here"], kinds: ["approval", "paused"] } as const;
    expect(withMention("本文", { ...mention, kinds: [...mention.kinds] }, "approval")).toBe(
      "<@U0123ABCD> <!here> 本文",
    );
    expect(withMention("本文", { ...mention, kinds: [...mention.kinds] }, "completed")).toBe(
      "本文",
    );
    expect(withMention("本文", undefined, "approval")).toBe("本文");
    // テストの通知（種類なし）には、種類によらず付ける
    expect(withMention("本文", { targets: ["S0789EFGH"], kinds: ["completed"] }, undefined)).toBe(
      "<!subteam^S0789EFGH> 本文",
    );
  });

  for (const destination of [
    {
      kind: "slack-api" as const,
      url: "https://slack.com/api/chat.postMessage",
      channel: "#sacty",
      language: "ja" as const,
    },
    { kind: "slack-webhook" as const, webhook: "slack-webhook", language: "en" as const },
  ]) {
    it(`${destination.kind}：既定（人の出番だけ）では、承認待ち・エスカレーション・一時停止にメンションし、完了にはしない。テストの通知にも付ける`, async () => {
      const api = slack(() =>
        destination.kind === "slack-api" ? Response.json({ ok: true }) : new Response("ok"),
      );
      const notifier = new SlackNotifier({
        ...dest({
          ...destination,
          mention: {
            targets: ["U0123ABCD", "@channel"],
            kinds: ["approval", "escalation", "paused"],
          },
        }),
        secrets: new MemorySecretStore({
          "slack-webhook": "https://hooks.slack.com/services/T/B/X",
        }),
        webUrl: "http://x",
        fetchImpl: api.fetchImpl,
      });
      for (const [kind, t] of Object.entries(byKind)) {
        await notifier.notify(t, kind as keyof typeof byKind);
      }
      await notifier.test();
      const texts = api.calls.map((c) => String(c.body.text));
      expect(texts).toHaveLength(5);
      for (const text of texts.slice(0, 3))
        expect(text.startsWith("<@U0123ABCD> <!channel> :")).toBe(true);
      expect(texts[3]).toMatch(/^:white_check_mark: /);
      expect(texts[3]).not.toContain("<@");
      expect(texts[4]?.startsWith("<@U0123ABCD> <!channel> :wave: ")).toBe(true);
      expect(notifier.problems()).toEqual([]);
    });
  }

  it("完了だけを選べば完了にだけ付け、設定しなければ、これまでどおりメンションしない", async () => {
    const only = slack();
    const notifier = new SlackNotifier({
      ...dest({
        kind: "slack-api",
        url: "https://slack.com/api/chat.postMessage",
        channel: "#sacty",
        language: "ja",
        mention: { targets: ["S0789EFGH"], kinds: ["completed"] },
      }),
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: only.fetchImpl,
    });
    for (const [kind, t] of Object.entries(byKind)) {
      await notifier.notify(t, kind as keyof typeof byKind);
    }
    expect(only.calls.map((c) => String(c.body.text).startsWith("<!subteam^S0789EFGH> "))).toEqual([
      false,
      false,
      false,
      true,
    ]);

    const plain = slack();
    const without = new SlackNotifier({
      ...dest({
        kind: "slack-api",
        url: "https://slack.com/api/chat.postMessage",
        channel: "#a",
        language: "ja",
      }),
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: plain.fetchImpl,
    });
    await without.notify(gate, "approval");
    await without.test();
    expect(String(plain.calls[0]?.body.text)).toMatch(/^:raising_hand: /);
    expect(String(plain.calls[1]?.body.text)).toMatch(/^:wave: /);
  });
});

describe("通知の失敗をタスクの操作に伝えない・古い結果で警告を変えない（PBI-115 レビュー指摘）", () => {
  const a = {
    kind: "slack-api" as const,
    url: "https://a.example.com/api/chat.postMessage",
    channel: "#a",
    language: "ja" as const,
  };
  const b = { ...a, url: "https://b.example.com/api/chat.postMessage", channel: "#b" };

  /** 送り先ごとに、応答を後から決められる Slack の偽物。 */
  function heldSlack() {
    const pending: { url: string; resolve: (res: Response) => void }[] = [];
    const fetchImpl = ((url: string) =>
      new Promise<Response>((resolve) => pending.push({ url, resolve }))) as typeof fetch;
    const answer = async (i: number, res: Response) => {
      pending[i]?.resolve(res);
      await new Promise((r) => setTimeout(r, 0));
    };
    return { pending, fetchImpl, answer };
  }

  it("プロジェクトを読めない・本文を作れないときも、notify は例外にせず、送れなかった理由として持つ", async () => {
    const api = slack();
    const notifier = new SlackNotifier({
      notification: () => a,
      project: () => {
        throw new Error("database is locked");
      },
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: api.fetchImpl,
    });
    let result: Promise<void> | undefined;
    expect(() => {
      result = notifier.notify(task(), "completed");
    }).not.toThrow();
    await expect(result).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0);
    expect(renderMessage(notifier.problems()[0], "ja")).toContain("database is locked");
  });

  it("送り先を変えた後に、古い送り先への送信が失敗しても、新しい送り先の警告にしない", async () => {
    let current: SlackNotification = a;
    const held = heldSlack();
    const notifier = new SlackNotifier({
      notification: () => current,
      project: (id) => projects[id],
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: held.fetchImpl,
    });
    const old = notifier.notify(task(), "completed");
    current = b;
    const test = notifier.test();
    await new Promise((r) => setTimeout(r, 0));
    await held.answer(1, Response.json({ ok: true }));
    await test;
    expect(notifier.problems()).toEqual([]);
    await held.answer(0, new Response("down", { status: 500 }));
    await old;
    expect(notifier.problems()).toEqual([]);
    // 古い送り先の失敗は、送り先を戻しても出さない（結果を持たない）
    current = a;
    expect(notifier.problems()).toEqual([]);
  });

  it("同じ送り先で並行して送ったときは、後に始めた送信の結果を残す", async () => {
    const held = heldSlack();
    const notifier = new SlackNotifier({
      notification: () => a,
      project: (id) => projects[id],
      secrets: new MemorySecretStore({}),
      webUrl: "http://x",
      fetchImpl: held.fetchImpl,
    });
    // 先に始めた送信が後から失敗しても、後に始めた送信の成功を上書きしない
    const first = notifier.notify(task(), "completed");
    const second = notifier.notify(task(), "completed");
    await new Promise((r) => setTimeout(r, 0));
    await held.answer(1, Response.json({ ok: true }));
    await held.answer(0, new Response("down", { status: 500 }));
    await Promise.all([first, second]);
    expect(notifier.problems()).toEqual([]);
    // 先に始めた送信が後から成功しても、後に始めた送信の失敗を消さない
    const third = notifier.notify(task(), "completed");
    const fourth = notifier.notify(task(), "completed");
    await new Promise((r) => setTimeout(r, 0));
    await held.answer(3, new Response("down", { status: 503 }));
    await held.answer(2, Response.json({ ok: true }));
    await Promise.all([third, fourth]);
    expect(renderMessage(notifier.problems()[0], "ja")).toContain("HTTP 503");
  });
});
