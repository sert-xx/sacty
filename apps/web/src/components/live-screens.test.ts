// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeaderData } from "@/lib/header-data";
import type { TaskDetailData } from "@/lib/task-detail-data";
import type { TaskListData, TaskRow } from "@/lib/task-list-data";

// 画面のサーバー・ルーターに頼る部品は、テストでは使わない（ここで確かめるのは、データの取り直しと画面への反映）
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
const followProjectAction = vi.fn(async (_id: string) => {});
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return {
    followProjectAction,
    askQuestionAction: action,
    cancelTaskAction: action,
    changeStepImageAction: action,
    createTaskAction: action,
    decideChangeAction: action,
    gateAction: action,
    pauseTaskAction: action,
    rereviewTaskAction: action,
    resumeTaskAction: action,
    retryExportAction: action,
    setLanguageAction: action,
    voidRemarkAction: action,
  };
});

const { I18nProvider } = await import("@/i18n/client");
const { LiveTaskDetail } = await import("./task-detail");
const { LiveTaskList } = await import("./task-list");
const { NewTaskDialog } = await import("./new-task-dialog");
const { LiveHeaderMenus } = await import("./shell/live-header");
const { liveVersion } = await import("@/lib/live-server");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (patch: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "p1",
  title: "ログインを直す",
  body: "本文",
  start: "sacty",
  status: "idle",
  steps: [],
  outputs: {},
  testViewpoints: [],
  approved: {},
  proposals: [],
  testMap: [],
  reviewComments: [],
  reproductionTests: [],
  verifyFailures: 0,
  integrationFailures: 0,
  misses: [],
  importedFeedback: [],
  questions: [],
  exports: {},
  stepPullRequests: [],
  stepBranches: [],
  submissions: {},
  remarks: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...patch,
});

const detail = (t: Task): TaskDetailData => ({
  task: t,
  activity: [],
  projectName: "Acme",
  children: [],
  cleanupPlan: [],
  imageStatus: {
    problems: [],
    images: [
      { name: "node", description: "Node.js" },
      { name: "python", description: "Python" },
    ],
  },
});

/** 承認待ち（要求要件）で、承認済みの調査（折りたたんだ欄）と、工程のイメージの選択があるタスク。 */
const awaiting = task({
  status: "awaiting_approval",
  gate: { step: "requirements", submission: 1 } as Task["gate"],
  steps: [
    { key: "investigate", state: "done" },
    { key: "requirements", state: "active" },
    { key: "implement", state: "todo" },
  ],
  approved: {
    investigate: {
      submission: 1,
      output: "調査の結果",
      testViewpoints: [],
      at: "2026-10-10T00:00:00Z",
    },
  },
  outputs: { requirements: "要求要件の下書き" },
  images: { implement: "node" },
});

// 画面のサーバーの代わり。取り直しの問い合わせに、server の今のデータを返す（版が同じなら中身を送らない）
let server: unknown;
let candidateRequests = 0;
const requests: string[] = [];
function stubServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      // 作成のダイアログを開いたときの、リポジトリの候補（PBI-109）
      if (url.endsWith("/repositories")) {
        candidateRequests += 1;
        return Response.json({ repositories: ["acme/web"], problems: [] });
      }
      requests.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (server === "down") return Response.json({ unavailable: true });
      // 遅れて失敗する（取っている間に画面が描き直される場合を試す）
      if (server === "slow-down") {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return Response.json({ unavailable: true });
      }
      if (server === "missing") return Response.json({ missing: true });
      const version = liveVersion(server);
      return Response.json(
        headers["x-sacty-live-version"] === version
          ? { unchanged: true }
          : { data: server, version },
      );
    }),
  );
}

let visibility: DocumentVisibilityState = "visible";
// テーマのメニューが読む（jsdom には無い）
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;
let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  act(() => {
    // createElement の3つ目の引数で子を渡す（I18nProvider の型は children を必須にしている）
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, node));
  });
}

/** 操作せずに、間隔（3秒）だけ待つ。 */
async function wait(ms = 3_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  followProjectAction.mockClear();
  candidateRequests = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  stubServer();
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

describe("タスクの詳細：裏で起きた変化が、操作しなくても間隔のうちに出る（PBI-108）", () => {
  it("ほかのタブ・CLI で承認すると、承認待ちの表示が消え、次の工程に進んだことが出る", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    expect(container.querySelector("#gate")).not.toBeNull();
    expect(text()).toContain("要求要件の承認待ち");

    server = detail(
      task({
        ...awaiting,
        status: "running",
        gate: undefined,
        steps: [
          { key: "investigate", state: "done" },
          { key: "requirements", state: "done" },
          { key: "implement", state: "active" },
        ],
      }),
    );
    await wait();
    expect(container.querySelector("#gate")).toBeNull();
    expect(text()).toContain("実行中");
    // 画面のリロード（router.refresh）はしない
    expect(refresh).not.toHaveBeenCalled();
  });

  it("一時停止のタスクを再開すると、再開のフォームが消えて実行待ちになる", async () => {
    const paused = task({ status: "paused", pausedReason: "manual" });
    server = detail(paused);
    render(
      h(LiveTaskDetail, { id: "t1", initial: detail(paused), initialVersion: liveVersion(server) }),
    );
    const status = () => container.querySelector("h1")?.parentElement?.textContent ?? "";
    expect(status()).toContain("一時停止中");
    expect(container.querySelector("form input[name=taskId]")).not.toBeNull();
    server = detail(task({ status: "queued" }));
    await wait();
    expect(status()).toContain("実行待ち");
    expect(status()).not.toContain("一時停止中");
  });

  it("実行待ちのタスクが拾われて動き出し、その後に承認待ちになる", async () => {
    const queued = task({ status: "queued" });
    server = detail(queued);
    render(
      h(LiveTaskDetail, { id: "t1", initial: detail(queued), initialVersion: liveVersion(server) }),
    );
    expect(text()).toContain("実行待ち");
    server = detail(task({ status: "running", steps: [{ key: "requirements", state: "active" }] }));
    await wait();
    expect(text()).toContain("実行中");
    server = detail(awaiting);
    await wait();
    expect(container.querySelector("#gate")).not.toBeNull();
    expect(text()).toContain("要求要件の承認待ち");
  });

  it("タブが隠れている間は問い合わせず、見えたらすぐに取り直す", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    server = detail(task({ ...awaiting, status: "running", gate: undefined }));
    await wait(30_000);
    expect(requests).toHaveLength(0);
    expect(container.querySelector("#gate")).not.toBeNull();
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests).toHaveLength(1);
    expect(container.querySelector("#gate")).toBeNull();
  });

  it("デーモンに届かない間は画面をそのまま残し、届いたらまた更新する", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    server = "down";
    await wait(9_000);
    expect(container.querySelector("#gate")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    server = detail(task({ ...awaiting, status: "running", gate: undefined }));
    await wait();
    expect(container.querySelector("#gate")).toBeNull();
  });

  it("描いたときにデーモンに届かなくても、届いたら詳細を出す", async () => {
    server = "down";
    render(h(LiveTaskDetail, { id: "t1", initial: null, error: "デーモンに届きません" }));
    expect(text()).toContain("デーモンに届きません");
    await wait();
    expect(text()).toContain("デーモンに届きません");
    server = detail(awaiting);
    await wait();
    expect(container.querySelector("#gate")).not.toBeNull();
  });

  it("一時停止でリポジトリを選ぶ候補（gh で GitHub に問い合わせる）は、持っていれば取り直しのたびには求めない", async () => {
    const triage = task({ status: "paused", pausedReason: "manual", noRepo: true });
    const initial = { ...detail(triage), ticketRepositories: ["acme/web"] };
    server = detail(triage);
    render(h(LiveTaskDetail, { id: "t1", initial, initialVersion: liveVersion(initial) }));
    await wait(9_000);
    expect(requests).toHaveLength(3);
    expect(requests.every((u) => u === "/live/tasks/t1")).toBe(true);
    // 取り直したデータに候補が無くても、持っている候補を使い続ける
    expect(container.querySelector('option[value="acme/web"]')).not.toBeNull();
  });

  it("後から人がリポジトリを選ぶ一時停止になったときは、候補を一度だけ求める", async () => {
    const queued = task({ status: "queued", noRepo: true });
    server = detail(queued);
    render(
      h(LiveTaskDetail, { id: "t1", initial: detail(queued), initialVersion: liveVersion(server) }),
    );
    const triage = task({ status: "paused", pausedReason: "manual", noRepo: true });
    server = detail(triage);
    await wait();
    server = { ...detail(triage), ticketRepositories: ["acme/api"] };
    await wait();
    server = detail(triage);
    await wait(6_000);
    expect(requests).toEqual([
      "/live/tasks/t1",
      "/live/tasks/t1?repositories=1",
      "/live/tasks/t1",
      "/live/tasks/t1",
    ]);
    expect(container.querySelector('option[value="acme/api"]')).not.toBeNull();
  });
});

describe("タスクの詳細：自動の更新で、操作の途中の状態を消さない（PBI-108）", () => {
  it("入力の途中の文字・選択・開いた欄・開いたダイアログ・フォーカス・画面の要素がそのまま残る", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );

    // 承認済みの調査の欄（details）を開く
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    // 工程のイメージを選ぶ（まだ変えない）
    const select = container.querySelector(
      '[data-testid="step-image-implement"]',
    ) as HTMLSelectElement;
    select.value = "python";
    // チャットのパネル（ダイアログ）を開き、質問を書きかけて、フォーカスを置いたままにする
    const trigger = document.querySelector(
      'button[aria-label^="オーケストレーター"]',
    ) as HTMLButtonElement;
    act(() => trigger.click());
    // パネルを開いたときのフォーカスの移動が済んでから（間隔より短い）
    await wait(100);
    const question = document.getElementById("question") as HTMLTextAreaElement;
    question.value = "テストはどこ？";
    question.focus();
    question.setSelectionRange(2, 4);
    const steps = container.querySelector("#steps")?.closest("section");

    // 裏で状態が変わる（作業履歴が増え、費用が変わり、質問の答えが来る）
    server = detail(
      task({
        ...awaiting,
        budget: { usedUsd: 0.4, capUsd: 1, warned: false, estimated: false },
        updatedAt: "2026-10-10T01:00:00.000Z",
      }),
    );
    (server as TaskDetailData).activity = [
      {
        id: "e1",
        seq: 1,
        taskId: "t1",
        projectId: "p1",
        at: "2026-10-10T01:00:00.000Z",
        actor: "sacty",
        type: "BudgetWarned",
        payload: { usedUsd: 0.8, capUsd: 1 },
      } as unknown as TaskDetailData["activity"][number],
    ];
    await wait();
    await wait();
    expect(text()).toContain("$0.40");

    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(container.querySelector('[data-testid="step-image-implement"]')).toBe(select);
    expect(select.value).toBe("python");
    expect(document.getElementById("question")).toBe(question);
    expect(question.value).toBe("テストはどこ？");
    expect(document.activeElement).toBe(question);
    expect([question.selectionStart, question.selectionEnd]).toEqual([2, 4]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // 変わっていない所の要素は作り直さない（スクロールの位置が動かない）
    expect(container.querySelector("#steps")?.closest("section")).toBe(steps);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("再開のフォームの途中の値（予算の上限）が残る", async () => {
    const paused = task({ status: "paused", pausedReason: "budget" });
    server = detail(paused);
    render(
      h(LiveTaskDetail, { id: "t1", initial: detail(paused), initialVersion: liveVersion(server) }),
    );
    const cap = container.querySelector('input[name="capUsd"]') as HTMLInputElement;
    cap.value = "5";
    server = detail(
      task({ ...paused, updatedAt: "2026-10-10T02:00:00.000Z", title: "題を変えた" }),
    );
    await wait();
    expect(text()).toContain("題を変えた");
    expect(container.querySelector('input[name="capUsd"]')).toBe(cap);
    expect(cap.value).toBe("5");
  });
});

const row = (id: string, title: string, status: TaskRow["status"]): TaskRow => ({
  id,
  title,
  child: false,
  start: "sacty",
  repoless: false,
  steps: [],
  status,
});

describe("タスクの一覧：新しいタスク・状態の変化が、操作しなくても間隔のうちに出る（PBI-108）", () => {
  it("タスクが無いときも取り直し、取り込みで増えたタスクを出す。作成のダイアログの書きかけは消えない", async () => {
    const empty: TaskListData = { projectId: "p1", needsYou: [], rows: [] };
    server = empty;
    render([
      h(NewTaskDialog, {
        key: "new",
        projectId: "p1",
        projectName: "Acme",
        hasTargets: true,
      }),
      h(LiveTaskList, { key: "list", initial: empty, initialVersion: liveVersion(empty) }),
    ]);
    expect(text()).toContain("タスクはまだありません");
    // 作成のダイアログを開いて、題を書きかける
    const open = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "タスクを作成",
    );
    act(() => open?.click());
    const title = document.querySelector('input[name="title"]') as HTMLInputElement;
    title.value = "書きかけの題";
    title.focus();

    server = {
      projectId: "p1",
      needsYou: [],
      rows: [row("t9", "取り込んだ Issue", { text: "実行待ち", tone: "waiting" })],
    } satisfies TaskListData;
    await wait();
    expect(container.querySelector('[data-testid="task-row-t9"]')?.textContent).toContain(
      "取り込んだ Issue",
    );
    expect(document.querySelector('input[name="title"]')).toBe(title);
    expect(title.value).toBe("書きかけの題");
    expect(document.activeElement).toBe(title);
    // 取り直しのたびに、リポジトリの候補（gh で GitHub に問い合わせる）を読み直さない（開いたときの1回だけ）
    await wait(9_000);
    expect(candidateRequests).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("すべてが承認待ち・一時停止・完了でも取り直し、承認・再開で変わった状態を出す", async () => {
    const still: TaskListData = {
      projectId: "p1",
      needsYou: [
        {
          id: "a",
          title: "承認待ちのタスク",
          status: "要求要件の承認待ち",
          action: { href: "/tasks/a/review", label: "レビューする" },
        },
        {
          id: "b",
          title: "止めたタスク",
          status: "一時停止中",
          action: { href: "/tasks/b", label: "再開する" },
        },
      ],
      rows: [
        row("a", "承認待ちのタスク", { text: "要求要件の承認待ち", tone: "person" }),
        row("b", "止めたタスク", { text: "一時停止中", tone: "person" }),
        row("c", "終わったタスク", { text: "完了", tone: "completed" }),
      ],
    };
    server = still;
    render(h(LiveTaskList, { initial: still, initialVersion: liveVersion(still) }));
    expect(text()).toContain("あなたの出番");
    server = {
      ...still,
      needsYou: [],
      rows: [
        row("a", "承認待ちのタスク", { text: "実行中", tone: "working" }),
        row("b", "止めたタスク", { text: "実行待ち", tone: "waiting" }),
        still.rows[2] as TaskRow,
      ],
    } satisfies TaskListData;
    await wait();
    expect(container.querySelector('[data-testid="task-row-a"]')?.textContent).toContain("実行中");
    expect(container.querySelector('[data-testid="task-row-b"]')?.textContent).toContain(
      "実行待ち",
    );
    expect(text()).not.toContain("あなたの出番");
  });
});

describe("ヘッダーのお知らせも、データだけを取り直す（PBI-108）", () => {
  it("ほかのタブで承認待ちになったタスクが、お知らせの件数に出る。描いたときのプロジェクトのまま取り直す", async () => {
    const quiet: HeaderData = {
      projects: [{ id: "p1", name: "Acme", needsYou: 0 }],
      current: { id: "p1", name: "Acme", needsYou: 0 },
      notices: [],
    };
    server = quiet;
    render(
      h(LiveHeaderMenus, { initial: quiet, initialVersion: liveVersion(quiet), language: "ja" }),
    );
    expect(document.querySelector('[aria-label="お知らせ"]')).not.toBeNull();
    server = {
      projects: [{ id: "p1", name: "Acme", needsYou: 1 }],
      current: { id: "p1", name: "Acme", needsYou: 1 },
      notices: [
        {
          taskId: "t1",
          title: "ログインを直す",
          projectId: "p1",
          projectName: "Acme",
          status: "要求要件の承認待ち",
          href: "/tasks/t1/review",
        },
      ],
    } satisfies HeaderData;
    await wait();
    expect(document.querySelector('[aria-label="お知らせ（人間の対応待ち 1件）"]')).not.toBeNull();
    expect(requests.every((u) => u === "/live/header?current=p1")).toBe(true);
  });
});

describe("更新できない間・描いたときに届かなかったとき・候補の取り直し（PR #119 レビュー指摘）", () => {
  it("詳細：更新できない間は、表示を残したまま更新が止まっていることを出し、つながったら消す", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
    server = "down";
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')?.textContent).toContain(
      "いま更新できません",
    );
    expect(container.querySelector("#gate")).not.toBeNull();
    server = detail(awaiting);
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
  });

  it("一覧：更新できない間は、それを出す", async () => {
    const list: TaskListData = { projectId: "p1", needsYou: [], rows: [] };
    server = list;
    render(h(LiveTaskList, { initial: list, initialVersion: liveVersion(list) }));
    server = "down";
    await wait();
    expect(container.querySelector('[data-testid="live-stale"]')).not.toBeNull();
  });

  it("詳細：描いたときに届かず後から出たタスクのプロジェクトを、表示しているプロジェクトにする", async () => {
    server = "down";
    render(h(LiveTaskDetail, { id: "t1", initial: null, error: "デーモンに届きません" }));
    await wait();
    expect(followProjectAction).not.toHaveBeenCalled();
    server = detail(task({ ...awaiting, projectId: "p2" }));
    await wait();
    expect(container.querySelector("#gate")).not.toBeNull();
    expect(followProjectAction).toHaveBeenCalledWith("p2");
  });

  it("詳細：描いたときに届いていれば、プロジェクトを合わせ直さない", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    await wait();
    expect(followProjectAction).not.toHaveBeenCalled();
  });

  it("一時停止の候補を取れなかったときは、間を空けて求め直し、取れたら求めない（0件とは分ける）", async () => {
    const triage = task({ status: "paused", pausedReason: "manual", noRepo: true });
    const failed = { ...detail(triage), ticketRepositoriesFailed: true };
    server = detail(triage);
    render(h(LiveTaskDetail, { id: "t1", initial: failed, initialVersion: liveVersion(failed) }));
    await wait(27_000);
    // 30秒までは求めない（gh で GitHub に問い合わせ続けない）
    expect(requests.every((u) => u === "/live/tasks/t1")).toBe(true);
    server = { ...detail(triage), ticketRepositories: ["acme/api"] };
    await wait(3_000);
    expect(requests.at(-1)).toBe("/live/tasks/t1?repositories=1");
    expect(container.querySelector('option[value="acme/api"]')).not.toBeNull();
    const count = requests.length;
    server = detail(triage);
    await wait(60_000);
    expect(requests.slice(count).every((u) => u === "/live/tasks/t1")).toBe(true);
  });

  it("取れた0件は、取得済みとして求め直さない", async () => {
    const triage = task({ status: "paused", pausedReason: "manual", noRepo: true });
    const none = { ...detail(triage), ticketRepositories: [] };
    server = detail(triage);
    render(h(LiveTaskDetail, { id: "t1", initial: none, initialVersion: liveVersion(none) }));
    await wait(60_000);
    expect(requests.every((u) => u === "/live/tasks/t1")).toBe(true);
  });

  it("ヘッダー：プロジェクトが無い（0件）ときも取り直し、最初のプロジェクトができたら切り替えとお知らせを出す", async () => {
    server = "missing";
    render(h(LiveHeaderMenus, { initial: null, language: "ja" }));
    await wait();
    expect(document.querySelector('[aria-label^="プロジェクト："]')).toBeNull();
    server = {
      projects: [{ id: "p1", name: "Acme", needsYou: 0 }],
      current: { id: "p1", name: "Acme", needsYou: 0 },
      notices: [],
    } satisfies HeaderData;
    await wait();
    expect(document.querySelector('[aria-label^="プロジェクト：Acme"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="お知らせ"]')).not.toBeNull();
  });

  it("ヘッダー：更新できない間は、件数が今の値でないかもしれないことを出す", async () => {
    const quiet: HeaderData = {
      projects: [{ id: "p1", name: "Acme", needsYou: 0 }],
      current: { id: "p1", name: "Acme", needsYou: 0 },
      notices: [],
    };
    server = quiet;
    render(
      h(LiveHeaderMenus, { initial: quiet, initialVersion: liveVersion(quiet), language: "ja" }),
    );
    server = "down";
    await wait();
    expect(document.querySelector('[data-testid="live-stale-header"]')?.textContent).toBe(
      "更新が止まっています",
    );
    server = quiet;
    await wait();
    expect(document.querySelector('[data-testid="live-stale-header"]')).toBeNull();
  });
});

describe("取っている間にサーバーが描き直したとき（PR #119 再レビュー指摘）", () => {
  it("古い取得の失敗で、新しい画面に「更新できない」を出さない", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    server = "slow-down";
    await wait(3_000); // 取り直しが始まる
    // 操作の後に、サーバーが画面を描き直した（新しい initial）
    const fresh = detail(task({ ...awaiting, title: "描き直した題" }));
    render(h(LiveTaskDetail, { id: "t1", initial: fresh, initialVersion: liveVersion(fresh) }));
    await wait(5_000); // 古い取得が失敗で終わる
    expect(text()).toContain("描き直した題");
    expect(container.querySelector('[data-testid="live-stale"]')).toBeNull();
  });

  it("描き直していなければ、遅れた失敗でも「更新できない」を出す", async () => {
    server = detail(awaiting);
    render(
      h(LiveTaskDetail, {
        id: "t1",
        initial: detail(awaiting),
        initialVersion: liveVersion(server),
      }),
    );
    server = "slow-down";
    await wait(8_000);
    expect(container.querySelector('[data-testid="live-stale"]')).not.toBeNull();
  });
});
