// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionRow, DashboardData, OpenTaskRow } from "@/lib/dashboard-data";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));
const runIntakeAction = vi.fn(async () => {});
vi.mock("@/app/actions", () => ({
  followProjectAction: vi.fn(async () => {}),
  runIntakeAction,
}));

const { I18nProvider } = await import("@/i18n/client");
const { LiveDashboard, DASHBOARD_LIVE_URL, durationText } = await import("./dashboard");
const { liveVersion } = await import("@/lib/live-server");
const { messagesFor } = await import("@/i18n");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** テストの「今」（画面の時計）。 */
const NOW = new Date("2026-10-16T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

// 画面のサーバーの代わり。取り直しの問い合わせに、server の今のデータを返す（版が同じなら中身を送らない）
let server: unknown;
const requests: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  requests.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (server === "down") return Response.json({ unavailable: true });
      const version = liveVersion(server);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return Response.json(
        headers["x-sacty-live-version"] === version
          ? { unchanged: true }
          : { data: server, version },
      );
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode, locale: "ja" | "en" = "ja") {
  act(() => {
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" | "en" }>, { locale }, node));
  });
}

/** 描き直す（別のデータで最初から）。 */
function rerender(node: ReactNode, locale: "ja" | "en" = "ja") {
  act(() => root.unmount());
  root = createRoot(container);
  render(node, locale);
}

async function wait(ms = 3_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const row = (
  id: string,
  projectId: string,
  projectName: string,
  status: OpenTaskRow["status"] = { text: "実行中", tone: "working" },
): OpenTaskRow => ({ id, title: `タスク ${id}`, projectId, projectName, status });

const attention = (
  id: string,
  waitingSince: string,
  patch: Partial<AttentionRow> = {},
): AttentionRow => ({
  ...row(id, "p1", "決済", { text: "要求要件の承認待ち", tone: "person" }),
  href: `/tasks/${id}/review`,
  waitingSince,
  ...patch,
});

const noFlow = { completed: 0, cancelled: 0, medianLeadMs: null };
/** 何も無いときのデータ。欄ごとのテストは、ここに欄のデータを足す。 */
const empty = (): DashboardData => ({
  projects: 1,
  openTasks: [],
  attention: [],
  paused: [],
  costs: {
    today: 0,
    days7: 0,
    since: { today: "2026-10-15T15:00:00.000Z", days7: "2026-10-09T15:00:00.000Z" },
    timeZone: "Asia/Tokyo",
    nearBudget: [],
  },
  intake: null,
  flow: {
    days7: noFlow,
    days30: noFlow,
    since: { days7: "2026-10-09T15:00:00.000Z", days30: "2026-09-16T15:00:00.000Z" },
  },
  quality: {
    since: "2026-09-16T15:00:00.000Z",
    counts: {
      changesRequested: 0,
      pullRequestRework: 0,
      guardianMissed: 0,
      integrationFailed: 0,
      fixTask: 0,
    },
    reworkBySteps: {},
    reworkByCause: { guardian_missed: 0, new_request: 0, base_changed: 0, unspecified: 0 },
  },
  queue: { running: 0, queued: 0, max: 3 },
});
const base = (patch: Partial<DashboardData> = {}): DashboardData => ({ ...empty(), ...patch });
const show = (data: DashboardData, locale: "ja" | "en" = "ja") => {
  server = data;
  render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }), locale);
};

const list = () => container.querySelector('[data-testid="open-tasks-list"]') as HTMLElement | null;
const item = (id: string) => container.querySelector(`[data-testid="open-task-${id}"]`);
const byId = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const text = () => container.textContent ?? "";
const card = (id: string) => byId(`dashboard-card-${id}`);
/** 欄の見出しの横の補足（印のラベルは「補足」。aria-describedby で文に結び付く）。 */
const cardHint = (id: string) => {
  const trigger = card(id)?.querySelector('[data-slot="hint"]');
  const described = trigger?.getAttribute("aria-describedby");
  return described ? document.getElementById(described)?.textContent : undefined;
};

describe("ダッシュボードの欄の並び（PBI-118）", () => {
  it("8 つの欄を、あなたの出番 → 止まっている理由 → 終わっていないタスク → 費用と予算 → 工程の待ち行列 → 取り込みの状況 → 流量 → 品質の信号の順に出す", () => {
    show(base());
    const ids = [...container.querySelectorAll('[data-testid^="dashboard-card-"]')].map((e) =>
      e.getAttribute("data-testid")?.replace("dashboard-card-", ""),
    );
    expect(ids).toEqual([
      "attention",
      "paused",
      "open-tasks",
      "costs",
      "queue",
      "intake-status",
      "flow",
      "quality",
    ]);
    // 欄は幅が足りれば横に並び、足りなければ縦に積む（同じ枠）
    expect(byId("dashboard-grid")?.className).toContain("auto-fit");
    // 見出しはそれぞれの欄の名前
    expect(container.querySelector("#attention")?.textContent).toBe("あなたの出番");
    expect(container.querySelector("#paused")?.textContent).toBe("止まっているタスクの理由");
    expect(container.querySelector("#costs")?.textContent).toBe("費用と予算");
    expect(container.querySelector("#queue")?.textContent).toBe("工程の待ち行列");
    expect(container.querySelector("#intake-status")?.textContent).toBe("取り込みの状況");
    expect(container.querySelector("#flow")?.textContent).toBe("流量");
    expect(container.querySelector("#quality")?.textContent).toBe("品質の信号");
  });

  it("空のときの表示がある（対応待ち・止まっている理由・予算に近いタスク・取り込み・流量・品質）", () => {
    show(base());
    expect(text()).toContain("対応待ちはありません。");
    expect(text()).toContain("止まっているタスクはありません。");
    expect(text()).toContain("終わっていないタスクはありません。");
    expect(text()).toContain("予算に近いタスクはありません。");
    // 取り込みの文はプロジェクトの一覧と同じ辞書（projects.intake）を使う
    expect(text()).toContain(messagesFor("ja").projects.intake.stopped);
    // 設定ファイルを読めないときは「今すぐ取り込む」を出さないが、復旧先の sacty の設定へのリンクは出す（PR #128 レビュー指摘）
    expect(card("intake-status")?.querySelector('button[type="submit"]')).toBeNull();
    expect(card("intake-status")?.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(byId("flow-days7-lead")?.textContent).toBe("—");
    expect(byId("quality-changesRequested")?.textContent).toBe("0回");
    expect(byId("queue-running")?.textContent).toBe("0 / 3");
    expect(byId("queue-queued")?.textContent).toBe("0");
    expect(byId("queue-over")).toBeNull();
  });

  it("仕組み・数字の定義・期間の境は、見出しの横の補足に出す（本文には出さない）", () => {
    show(base());
    expect(cardHint("costs")).toContain("Asia/Tokyo");
    expect(cardHint("costs")).toContain("Sacty を動かしているマシンの日付");
    expect(cardHint("flow")).toContain("中央値");
    expect(cardHint("quality")).toContain("直近30日");
    expect(cardHint("queue")).toContain("10分");
    expect(cardHint("attention")).toContain("作業履歴の記録の時刻");
    // 終わっていないタスクの欄には補足が無い（印を出さない）
    expect(card("open-tasks")?.querySelector('[data-slot="hint"]')).toBeNull();
    // 補足の文は本文に出ない（印の中（スクリーンリーダー向けの隠した文）にだけある）
    const costs = card("costs")?.cloneNode(true) as HTMLElement;
    for (const hint of costs.querySelectorAll('[data-slot="hint"]')) hint.remove();
    expect(costs.textContent).not.toContain("マシンの日付");
  });
});

describe("ダッシュボードのあなたの出番（PBI-118）", () => {
  it("題（判断する場所へのリンク）・プロジェクト・状態・待っている時間を、データの順に出す", () => {
    show(
      base({
        attention: [
          attention("a", minutes(3 * 24 * 60 + 5)),
          attention("b", minutes(2 * 60 + 30), {
            projectName: "Webサイト",
            status: { text: "一時停止中", tone: "person" },
            href: "/tasks/b",
          }),
          attention("c", minutes(45)),
          attention("d", minutes(0.5)),
        ],
      }),
    );
    expect(byId("attention-summary")?.textContent).toBe("4件");
    const a = byId("attention-a");
    expect(a?.querySelector("a")?.getAttribute("href")).toBe("/tasks/a/review");
    expect(a?.textContent).toContain("決済");
    expect(a?.textContent).toContain("要求要件の承認待ち");
    expect(byId("attention-waiting-a")?.textContent).toContain("3日");
    expect(byId("attention-b")?.querySelector("a")?.getAttribute("href")).toBe("/tasks/b");
    expect(byId("attention-waiting-b")?.textContent).toContain("2時間");
    expect(byId("attention-waiting-c")?.textContent).toContain("45分");
    expect(byId("attention-waiting-d")?.textContent).toContain("1分未満");
    // 欄の高さは5件分で、あふれたら欄の中でスクロールする
    const ul = byId("attention-list");
    expect(ul?.className).toContain("max-h-80");
    expect(ul?.getAttribute("tabindex")).toBe("0");
  });

  it("待っている時間は、データが変わらなくても画面の時計で進む", async () => {
    show(base({ attention: [attention("a", minutes(59))] }));
    expect(byId("attention-waiting-a")?.textContent).toContain("59分");
    await wait(60_000);
    expect(byId("attention-waiting-a")?.textContent).toContain("1時間");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("待っている時間の文は、分・時間・日のどれか1つ（日英）", () => {
    const ja = messagesFor("ja").dashboard.duration;
    const en = messagesFor("en").dashboard.duration;
    expect(durationText(30_000, ja)).toBe("1分未満");
    expect(durationText(59 * 60_000, ja)).toBe("59分");
    expect(durationText(23 * 3_600_000 + 59 * 60_000, ja)).toBe("23時間");
    expect(durationText(24 * 3_600_000, ja)).toBe("1日");
    expect(durationText(-5_000, ja)).toBe("1分未満");
    expect(durationText(30_000, en)).toBe("under a minute");
    expect(durationText(5 * 60_000, en)).toBe("5 min");
    expect(durationText(2 * 3_600_000, en)).toBe("2 h");
    expect(durationText(24 * 3_600_000, en)).toBe("1 day");
    expect(durationText(72 * 3_600_000, en)).toBe("3 days");
  });
});

describe("ダッシュボードの止まっているタスクの理由（PBI-118）", () => {
  const paused = (): DashboardData["paused"] => [
    { reason: "usage_limit", tasks: [{ id: "u1", title: "上限 1", projectName: "決済" }] },
    {
      reason: "budget",
      tasks: [
        { id: "b1", title: "予算 1", projectName: "決済" },
        { id: "b2", title: "予算 2", projectName: "Webサイト" },
      ],
    },
  ];

  it("理由ごとの件数を出し、利用上限・認証を目立たせる。件数を押すと、その理由のタスクが欄の中で広がる", () => {
    show(base({ paused: paused() }));
    expect(byId("paused-summary")?.textContent).toBe("3件");
    expect(byId("paused-count-usage_limit")?.textContent).toBe("1件");
    expect(byId("paused-count-budget")?.textContent).toBe("2件");
    expect(byId("paused-fix-once-usage_limit")?.textContent).toBe("1か所直せば動きます");
    expect(byId("paused-fix-once-budget")).toBeNull();
    expect(byId("paused-count-usage_limit")?.className).toContain("text-warn");
    expect(byId("paused-count-budget")?.className).not.toContain("text-warn");
    // 閉じている間も、タスクは DOM にあるが details が閉じている
    const details = byId("paused-budget")?.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    act(() => {
      details.open = true;
    });
    expect(byId("paused-task-b1")?.querySelector("a")?.getAttribute("href")).toBe("/tasks/b1");
    expect(byId("paused-task-b2")?.textContent).toContain("Webサイト");
    expect(byId("paused-task-u1")).not.toBeNull();
  });

  it("展開した一覧は 5 件分の高さで、あふれたら欄の中でスクロールし、取り直しでスクロールの位置が消えない（PR #128 レビュー指摘）", async () => {
    const many = (n: number): DashboardData["paused"] => [
      {
        reason: "error",
        tasks: Array.from({ length: n }, (_, i) => ({
          id: `e${i}`,
          title: `エラー ${i}`,
          projectName: "決済",
        })),
      },
    ];
    show(base({ paused: many(100) }));
    const details = byId("paused-error")?.querySelector("details") as HTMLDetailsElement;
    act(() => {
      details.open = true;
    });
    const list = byId("paused-tasks-error") as HTMLElement;
    expect(list.className).toContain("max-h-80");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(container.querySelectorAll('[data-testid^="paused-task-e"]')).toHaveLength(100);
    list.scrollTop = 300;
    list.focus();
    server = base({ paused: many(101) });
    await wait();
    expect(byId("paused-tasks-error")).toBe(list);
    expect(list.scrollTop).toBe(300);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(list);
    expect(byId("paused-task-e100")).not.toBeNull();
  });

  it("開いた状態は、取り直しで消えない（同じ要素が残る）。件数が変わる・理由が無くなる", async () => {
    show(base({ paused: paused() }));
    const details = byId("paused-budget")?.querySelector("details") as HTMLDetailsElement;
    act(() => {
      details.open = true;
    });
    server = base({
      paused: [
        {
          reason: "budget",
          tasks: [{ id: "b3", title: "予算 3", projectName: "決済" }],
        },
      ],
    });
    await wait();
    expect(byId("paused-budget")?.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(byId("paused-count-budget")?.textContent).toBe("1件");
    expect(byId("paused-usage_limit")).toBeNull();
    expect(byId("paused-task-b3")).not.toBeNull();
    server = base();
    await wait();
    expect(text()).toContain("止まっているタスクはありません。");
    expect(byId("paused-reasons")).toBeNull();
  });
});

describe("ダッシュボードの費用と予算（PBI-118）", () => {
  it("今日と直近7日の費用を概算の1行で出し（実請求の行は無い）、予算に近いタスクは使用済み / 上限と、上限に達した印", () => {
    show(
      base({
        costs: {
          ...empty().costs,
          today: 0.5,
          days7: 12.345,
          nearBudget: [
            {
              id: "x",
              title: "上限",
              projectName: "決済",
              usedUsd: 2,
              capUsd: 2,
              exceeded: true,
            },
            {
              id: "y",
              title: "80%",
              projectName: "Webサイト",
              usedUsd: 0.8,
              capUsd: 1,
              exceeded: false,
            },
          ],
        },
      }),
    );
    expect(byId("cost-today")?.textContent).toBe("$0.5000");
    expect(byId("cost-days7")?.textContent).toBe("$12.35");
    expect(byId("cost-estimated")?.textContent).toContain("概算");
    expect(byId("cost-estimated")?.querySelector('[data-slot="hint"]')).not.toBeNull();
    expect(text()).not.toContain("実請求");
    expect(byId("near-budget-x")?.querySelector("a")?.getAttribute("href")).toBe("/tasks/x");
    expect(byId("near-budget-used-x")?.textContent).toContain("$2.00 / $2.00");
    expect(byId("near-budget-exceeded-x")?.textContent).toBe("上限に達した");
    expect(byId("near-budget-used-y")?.textContent).toContain("$0.8000 / $1.00");
    expect(byId("near-budget-exceeded-y")).toBeNull();
    expect(byId("near-budget-list")?.className).toContain("max-h-80");
  });
});

describe("ダッシュボードの工程の待ち行列（PBI-118）", () => {
  it("実行中 / 上限と実行待ちを出し、実行待ちが上限より多い状態が10分続いたら目立たせて設定へのリンクを添える", async () => {
    show(base({ queue: { running: 2, queued: 5, max: 3, overSince: minutes(9) } }));
    expect(byId("queue-running")?.textContent).toBe("2 / 3");
    expect(byId("queue-queued")?.textContent).toBe("5");
    // 9分では目立たせない
    expect(byId("queue-over")).toBeNull();
    expect(byId("queue-queued")?.className).not.toContain("text-warn");
    // 時計が進んで10分になると目立たせる（データは同じ）
    await wait(60_000);
    expect(byId("queue-over")?.textContent).toContain("実行待ちが上限より多い状態が続いています。");
    expect(byId("queue-over")?.querySelector('a[href="/settings"]')?.textContent).toBe(
      "Sacty の設定で上限を変える",
    );
    expect(byId("queue-queued")?.className).toContain("text-warn");
    // 上限以下に戻れば消える
    server = base({ queue: { running: 3, queued: 1, max: 3 } });
    await wait();
    expect(byId("queue-over")).toBeNull();
    expect(byId("queue-queued")?.textContent).toBe("1");
  });
});

describe("ダッシュボードの取り込みの状況（PBI-118）", () => {
  it("プロジェクトの一覧と同じ内容（直近の取り込み・取り込めなかった対象・設定へのリンク）と、「今すぐ取り込む」を出す", () => {
    show(
      base({
        intake: {
          label: "sacty",
          ticketLabel: "jira",
          runs: {
            issues: {
              lastRunAt: "2026-10-16T01:02:00.000Z",
              imported: 2,
              errors: [{ query: "is:open label:sacty", message: "検索に失敗しました" }],
            },
          },
        },
      }),
    );
    const c = card("intake-status");
    expect(c?.textContent).toContain("Issue：ラベル sacty");
    expect(c?.textContent).toContain("チケット：ラベル jira");
    expect(c?.textContent).toContain("2件のタスクを作成");
    expect(c?.querySelector('[role="alert"]')?.textContent).toContain("is:open label:sacty");
    expect(c?.querySelector('a[href="/settings"]')).not.toBeNull();
    const button = c?.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.textContent).toBe("今すぐ取り込む");
    expect(button.closest("form")).not.toBeNull();
  });

  it("取り込みの設定が無ければ、そのことと設定へのリンクを出す", () => {
    show(base({ intake: {} }));
    const c = card("intake-status");
    expect(c?.textContent).toContain(messagesFor("ja").projects.intake.noLabel);
    expect(c?.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(c?.querySelector('button[type="submit"]')).not.toBeNull();
  });
});

describe("ダッシュボードの流量と品質の信号（PBI-118）", () => {
  it("流量：直近7日・30日の完了・中止と、作成から完了までの中央値", () => {
    show(
      base({
        flow: {
          ...empty().flow,
          days7: { completed: 1, cancelled: 0, medianLeadMs: 90 * 60_000 },
          days30: { completed: 4, cancelled: 2, medianLeadMs: 2.5 * 24 * 3_600_000 },
        },
      }),
    );
    expect(byId("flow-days7-completed")?.textContent).toBe("1");
    expect(byId("flow-days7-cancelled")?.textContent).toBe("0");
    expect(byId("flow-days7-lead")?.textContent).toBe("1時間");
    expect(byId("flow-days30-completed")?.textContent).toBe("4");
    expect(byId("flow-days30-cancelled")?.textContent).toBe("2");
    expect(byId("flow-days30-lead")?.textContent).toBe("2日");
  });

  it("品質：5つの信号の回数と、工程ごとの差し戻し（要求要件・設計・実装は常に、ほかは回数があるときだけ）", () => {
    show(
      base({
        quality: {
          ...empty().quality,
          counts: {
            changesRequested: 3,
            pullRequestRework: 1,
            guardianMissed: 2,
            integrationFailed: 0,
            fixTask: 1,
          },
          reworkBySteps: { design: 3, document: 1 },
          reworkByCause: { guardian_missed: 2, new_request: 1, base_changed: 1, unspecified: 0 },
        },
      }),
    );
    expect(byId("quality-changesRequested")?.textContent).toBe("3回");
    expect(byId("quality-pullRequestRework")?.textContent).toBe("1回");
    expect(byId("quality-guardianMissed")?.textContent).toBe("2回");
    expect(byId("quality-integrationFailed")?.textContent).toBe("0回");
    expect(byId("quality-fixTask")?.textContent).toBe("1回");
    expect(byId("rework-requirements")?.textContent).toBe("0回");
    expect(byId("rework-design")?.textContent).toBe("3回");
    expect(byId("rework-implement")?.textContent).toBe("0回");
    expect(byId("rework-document")?.textContent).toBe("1回");
    expect(byId("rework-investigate")).toBeNull();
    // 見逃しではない差し戻しは、原因ごとに分けて出す（見逃しは「ゴールガーディアンの見逃し」の欄）
    expect(byId("rework-cause-new_request")?.textContent).toBe("1回");
    expect(byId("rework-cause-base_changed")?.textContent).toBe("1回");
    expect(byId("rework-cause-unspecified")?.textContent).toBe("0回");
    expect(byId("rework-cause-guardian_missed")).toBeNull();
    // 数字の意味は補足に
    const hints = [...(card("quality")?.querySelectorAll('[data-slot="hint"]') ?? [])];
    expect(hints.length).toBeGreaterThanOrEqual(7);
  });

  it("英語", () => {
    show(
      base({
        attention: [attention("a", minutes(120), { status: { text: "Awaiting", tone: "person" } })],
        paused: [{ reason: "auth", tasks: [{ id: "u", title: "T", projectName: "Payments" }] }],
        queue: { running: 1, queued: 0, max: 3 },
      }),
      "en",
    );
    expect(container.querySelector("#attention")?.textContent).toBe("Needs you");
    expect(container.querySelector("#paused")?.textContent).toBe("Why tasks are paused");
    expect(container.querySelector("#queue")?.textContent).toBe("Step queue");
    expect(byId("attention-summary")?.textContent).toBe("1 task");
    expect(byId("attention-waiting-a")?.textContent).toContain("2 h");
    expect(byId("paused-count-auth")?.textContent).toBe("1 task");
    expect(byId("paused-fix-once-auth")?.textContent).toBe("One fix resumes them");
    expect(text()).toContain("No task is near its budget.");
  });
});

describe("ダッシュボードの終わっていないタスクの欄（PBI-114）", () => {
  it("各タスクに、プロジェクト・状態・タスクの詳細へのリンクを出す", () => {
    show(
      base({
        projects: 2,
        openTasks: [
          row("a", "p1", "決済", { text: "要求要件の承認待ち", tone: "person" }),
          row("b", "p2", "Webサイト", { text: "一時停止中", tone: "person" }),
        ],
      }),
    );
    expect(container.querySelector("#open-tasks")?.textContent).toBe("終わっていないタスク");
    expect(byId("open-tasks-summary")?.textContent).toContain("2件");
    expect(item("a")?.textContent).toContain("決済");
    expect(item("a")?.textContent).toContain("要求要件の承認待ち");
    expect(item("b")?.textContent).toContain("Webサイト");
    expect(item("b")?.textContent).toContain("一時停止中");
    expect(item("a")?.querySelector("a")?.getAttribute("href")).toBe("/tasks/a");
  });

  it("切り詰めた題とプロジェクトの名前の全文を、ホバー（title）と、行にフォーカスがある間の折り返しで見られる", () => {
    const long = "請求書の PDF の日付の形式をそろえる（明細・合計・発行日・支払期限のすべて）";
    show(
      base({
        openTasks: [
          { ...row("a", "p1", "決済システムの請求まわり"), title: `${long} その1` },
          { ...row("b", "p1", "決済システムの請求まわり"), title: `${long} その2` },
        ],
      }),
    );
    const link = item("b")?.querySelector("a") as HTMLAnchorElement;
    expect(link.title).toBe(`${long} その2`);
    expect(link.className).toContain("truncate");
    expect(link.className).toContain("group-focus-within:whitespace-normal");
    const project = item("b")?.querySelector('span[title="決済システムの請求まわり"]');
    expect(project?.className).toContain("group-focus-within:whitespace-normal");
    expect(item("b")?.className).toContain("group");
  });

  it("件数の補足は言語ごとの文言で組み立てる（英語に「・」を出さない）", () => {
    const data = base({
      projects: 2,
      openTasks: [row("a", "p1", "Payments"), row("b", "p2", "Web")],
    });
    show(data, "en");
    expect(byId("open-tasks-summary")?.textContent).toBe("All projects · 2 tasks");
    rerender(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    expect(byId("open-tasks-summary")?.textContent).toBe("すべてのプロジェクト・2件");
  });

  it("欄の高さは5件分で、それより多ければ欄の中でスクロールする（件数の上限は無い）", () => {
    show(base({ openTasks: Array.from({ length: 30 }, (_, i) => row(`t${i}`, "p1", "決済")) }));
    expect(container.querySelectorAll('[data-testid^="open-task-t"]')).toHaveLength(30);
    // 1行が min-h-16（4rem）、欄が max-h-80（20rem）＝5件分。あふれたら欄の中でスクロールする
    expect(list()?.className).toContain("max-h-80");
    expect(list()?.className).toContain("overflow-y-auto");
    expect(item("t0")?.className).toContain("min-h-16");
    // キーボードでもスクロールできる
    expect(list()?.tabIndex).toBe(0);
  });

  it("プロジェクトが無いとき・終わっていないタスクが無いときの表示がある", () => {
    show(base({ projects: 0 }));
    expect(text()).toContain("プロジェクトがありません。");
    expect(container.querySelector('a[href="/projects"]')).not.toBeNull();
    const data = base({ projects: 2 });
    rerender(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    expect(text()).toContain("終わっていないタスクはありません。");
    expect(list()).toBeNull();
  });

  it("画面をリロードせずにデータだけを取り直し、状態の変化・増えたタスク・終わったタスクを反映する", async () => {
    show(base({ projects: 2, openTasks: [row("a", "p1", "決済"), row("b", "p2", "Webサイト")] }));
    server = base({
      projects: 2,
      openTasks: [
        row("c", "p2", "Webサイト", { text: "実行待ち", tone: "waiting" }),
        row("a", "p1", "決済", { text: "要求要件の承認待ち", tone: "person" }),
      ],
      attention: [attention("a", minutes(1))],
    });
    await wait();
    expect(requests.every((u) => u === DASHBOARD_LIVE_URL)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expect(item("a")?.textContent).toContain("要求要件の承認待ち");
    expect(item("c")?.textContent).toContain("実行待ち");
    // 終わったタスク（b）は消える
    expect(item("b")).toBeNull();
    expect(byId("open-tasks-summary")?.textContent).toContain("2件");
    // ほかの欄も同じ取り直しで変わる
    expect(byId("attention-a")).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("自動の更新で、欄のスクロールの位置とフォーカスが消えない（同じ要素が残る）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`t${i}`, "p1", "決済"));
    show(base({ openTasks: rows }));
    const before = list() as HTMLElement;
    before.scrollTop = 200;
    before.focus();
    const link = item("t8")?.querySelector("a") as HTMLAnchorElement;
    server = base({ openTasks: [row("new", "p1", "決済"), ...rows.slice(0, 11)] });
    await wait();
    expect(item("new")).not.toBeNull();
    expect(item("t11")).toBeNull();
    expect(list()).toBe(before);
    expect(list()?.scrollTop).toBe(200);
    expect(document.activeElement).toBe(before);
    expect(item("t8")?.querySelector("a")).toBe(link);
  });

  it("デーモンに届かない間は表示を残して更新できないことを出し、描いたときに届かなくても届いたら欄を出す", async () => {
    const data = base({ openTasks: [row("a", "p1", "決済")] });
    server = "down";
    render(h(LiveDashboard, { initial: data, initialVersion: liveVersion(data) }));
    await wait();
    expect(item("a")).not.toBeNull();
    expect(byId("live-stale")).not.toBeNull();

    rerender(h(LiveDashboard, { initial: null, error: "デーモンに届きません" }));
    expect(text()).toContain("デーモンに届きません");
    expect(card("attention")).toBeNull();
    server = data;
    await wait();
    expect(text()).not.toContain("デーモンに届きません");
    expect(item("a")).not.toBeNull();
    expect(card("attention")).not.toBeNull();
  });
});

describe("ダッシュボードの Slack の通知を送れなかった理由（PBI-115）", () => {
  const problem = "Slack の通知を送れませんでした：HTTP 500（タスクは止めていません）";
  const box = () => byId("notification-problems");

  it("送れなかった理由を、sacty の設定へのリンクつきで出す。無ければ出さない。取り直しで出る・消える", async () => {
    const ok = base({ notificationProblems: [] });
    show(ok);
    expect(box()).toBeNull();
    server = { ...ok, notificationProblems: [problem] } satisfies DashboardData;
    await wait();
    expect(box()?.textContent).toContain(problem);
    expect(box()?.querySelector('a[href="/settings"]')?.textContent).toBe(
      "Sacty の設定で Slack の通知を確かめる",
    );
    server = ok;
    await wait();
    expect(box()).toBeNull();
  });
});

describe("あなたの出番の PR で確かめる工程（PBI-136）", () => {
  it("PR なら題から PR を新しいタブで開き、ほかは sacty の画面へ", () => {
    const PR = "https://github.com/acme/web/pull/7";
    show(
      base({
        attention: [
          attention("a", minutes(10), { href: PR, external: true }),
          attention("b", minutes(5)),
        ],
      }),
    );
    const a = byId("attention-a")?.querySelector("a");
    expect(a?.getAttribute("href")).toBe(PR);
    expect(a?.getAttribute("target")).toBe("_blank");
    const b = byId("attention-b")?.querySelector("a");
    expect(b?.getAttribute("href")).toBe("/tasks/b/review");
    expect(b?.getAttribute("target")).toBeNull();
  });
});

describe("長い題の PR の行でも、外部の印は残る（PR #148 レビュー提案）", () => {
  it("題だけを省略し、印は省略の外に置く", () => {
    show(
      base({
        attention: [
          attention("a", minutes(10), {
            title: "とても長い題".repeat(20),
            href: "https://github.com/acme/web/pull/7",
            external: true,
          }),
        ],
      }),
    );
    const a = byId("attention-a")?.querySelector("a");
    const label = a?.querySelector(".truncate");
    expect(label?.textContent).toBe("とても長い題".repeat(20));
    expect(a?.textContent).toContain("↗");
    expect(label?.textContent).not.toContain("↗");
    // リンク全体は省略しない（省略すると、末尾の印も切れる）
    expect(a?.className).not.toContain("truncate");
  });
});
