// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import { type ParsedFilter, parseTaskFilter } from "@/lib/task-filter";
import type { TaskListData, TaskRow } from "@/lib/task-list-data";

const bfcache = { id: "one" };
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    bfcacheId: bfcache.id,
  }),
  usePathname: () => "/projects/p1/tasks",
  useSearchParams: () =>
    new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
}));
vi.mock("@/app/actions", () => {
  const action = vi.fn(async () => ({}));
  return { createTaskAction: action, followProjectAction: action, setLanguageAction: action };
});

const { I18nProvider } = await import("@/i18n/client");
const { LiveTaskList } = await import("./task-list");
const { liveVersion } = await import("@/lib/live-server");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (patch: Partial<TaskRow>): TaskRow => ({
  id: "t1",
  title: "題",
  child: false,
  depth: 0,
  start: "sacty",
  repoless: false,
  steps: [],
  status: { text: "実行待ち", tone: "waiting" },
  createdAt: "2026-10-01T12:00:00",
  ...patch,
});
/** n 行（題は `${prefix} 1`…。新しい順の並びを模して、そのままの順で並べる）。 */
const many = (n: number, prefix = "タスク", patch: Partial<TaskRow> = {}): TaskRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({ id: `${prefix}-${i + 1}`, title: `${prefix} ${i + 1}`, ...patch }),
  );
const done = { text: "完了", tone: "completed" as const };
const working = { text: "実行中", tone: "working" as const };
const data = (rows: TaskRow[], needsYou: TaskListData["needsYou"] = []): TaskListData => ({
  projectId: "p1",
  needsYou,
  rows,
});

let container: HTMLDivElement;
let root: Root;
let locale: "ja" | "en" = "ja";

function mount(
  list: TaskListData | null,
  options: { filter?: ParsedFilter; url?: string; project?: string; error?: string } = {},
) {
  window.history.replaceState(null, "", options.url ?? "/projects/p1/tasks");
  render(list, options);
}
function render(
  list: TaskListData | null,
  options: { filter?: ParsedFilter; project?: string; error?: string } = {},
) {
  act(() =>
    root.render(
      h(
        I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
        { locale },
        h(LiveTaskList, {
          key: options.project ?? "p1",
          projectId: options.project ?? "p1",
          initial: list,
          ...(list ? { initialVersion: liveVersion(list) } : {}),
          ...(options.filter ? { initialFilter: options.filter } : {}),
          ...(options.error ? { error: options.error } : {}),
        }),
      ),
    ),
  );
}

const ids = () =>
  [...container.querySelectorAll('[data-testid^="task-row-"]')].map(
    (e) => e.getAttribute("data-testid")?.replace("task-row-", "") ?? "",
  );
const count = () => container.querySelector('[data-testid="task-filter-count"]');
const buttonWith = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(text));
const more = () => buttonWith(locale === "ja" ? "さらに表示" : "Show more");
const clearButton = () => buttonWith(locale === "ja" ? "条件をクリア" : "Clear filters");
const select = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("select") as HTMLSelectElement;
const input = (type: string, index = 0) =>
  container.querySelectorAll(`input[type="${type}"]`)[index] as HTMLInputElement;
const change = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
const pressMore = () => act(() => more()?.click());
const params = () => new URLSearchParams(window.location.search);
const m = () => messagesFor(locale).tasks;

beforeEach(() => {
  locale = "ja";
  bfcache.id = "one";
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("最初の表示", () => {
  const mixed = [
    row({ id: "w", title: "進行中", status: working }),
    row({ id: "q", title: "待ち" }),
    row({ id: "d", title: "完了した", status: done }),
    row({ id: "x", title: "中止した", status: { text: "中止", tone: "cancelled" } }),
  ];

  it("URL に指定が無ければ「終わっていない」で、完了・中止は出ない（クリアも出ない）", () => {
    mount(data(mixed));
    expect(ids()).toEqual(["w", "q"]);
    expect(select("状態").value).toBe("active");
    expect(count()?.textContent).toBe("4件中 2件");
    expect(clearButton()).toBeUndefined();
    expect(window.location.search).toBe("");
  });

  it("終わっていないタスクが 0 件なら、すべてで出す（選択欄も「すべて」・クリアは出ない）", () => {
    mount(data(mixed.slice(2)));
    expect(ids()).toEqual(["d", "x"]);
    expect(select("状態").value).toBe("");
    expect(select("状態").selectedOptions[0]?.textContent).toBe("すべて");
    expect(clearButton()).toBeUndefined();
  });

  it("タスクが 1 件も無いプロジェクトは、案内だけを出す", () => {
    mount(data([]));
    expect(container.textContent).toContain(m().empty);
    expect(container.querySelector('[data-testid="task-filter"]')).toBeNull();
    expect(more()).toBeUndefined();
  });

  describe("自動の更新", () => {
    let server: TaskListData;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          const version = liveVersion(server);
          const sent = ((init?.headers ?? {}) as Record<string, string>)["x-sacty-live-version"];
          return Response.json(sent === version ? { unchanged: true } : { data: server, version });
        }),
      );
    });
    const wait = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

    it("すべてで開いた後に進行中のタスクが増えても、すべてのまま（URL も変わらない）", async () => {
      mount(data(mixed.slice(2)));
      server = data(mixed);
      await wait();
      expect(ids()).toEqual(["w", "q", "d", "x"]);
      expect(select("状態").value).toBe("");
      expect(window.location.search).toBe("");
    });

    it("終わっていないで開いた後にそのタスクが完了になっても、終わっていないのまま", async () => {
      const one = [row({ id: "w", title: "進行中", status: working }), mixed[2] as TaskRow];
      mount(data(one));
      expect(ids()).toEqual(["w"]);
      server = data([row({ id: "w", title: "進行中", status: done }), mixed[2] as TaskRow]);
      await wait();
      expect(select("状態").value).toBe("active");
      expect(ids()).toEqual([]);
      expect(container.textContent).toContain(m().filter.none);
      expect(window.location.search).toBe("");
    });

    it("デーモンに届かずに開いたときは、最初にデータが届いた時点で決め、その後は切り替えない", async () => {
      mount(null, { error: "届きません" });
      expect(container.textContent).toContain("届きません");
      server = data(mixed);
      await wait();
      expect(select("状態").value).toBe("active");
      expect(ids()).toEqual(["w", "q"]);
      server = data(mixed.map((r) => ({ ...r, status: done })));
      await wait();
      expect(select("状態").value).toBe("active");
      expect(ids()).toEqual([]);
      expect(window.location.search).toBe("");
    });
  });
});

describe("URL への書き出し", () => {
  const list = [
    row({ id: "a", title: "決済を直す", start: "sacty", repoName: "web", status: working }),
    row({
      id: "b",
      title: "決済の Issue",
      start: "github_issue",
      repoName: "api",
      createdAt: "2026-11-05T12:00:00",
    }),
    row({ id: "c", title: "完了した", status: done }),
  ];

  it("「すべて」を選ぶと完了・中止も出て、status=all が URL に残る", () => {
    mount(data(list));
    change(select("状態"), "");
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(window.location.search).toBe("?status=all");
  });

  it("全項目を URL に書き、履歴を増やさない（replaceState だけを使う）", () => {
    mount(data(list));
    // App Router が書いた履歴の state（__NA つき）を、操作の前に入れておく
    window.history.replaceState({ __NA: true }, "", window.location.href);
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    const length = window.history.length;
    for (const q of ["決", "決済", "決済の"]) change(input("search"), q);
    change(input("date", 0), "2026-11-01");
    change(input("date", 1), "2026-11-10");
    change(select("開始地点"), "github_issue");
    change(select("リポジトリ"), "api");
    change(select("状態"), "waiting");
    expect(Object.fromEntries(params())).toEqual({
      q: "決済の",
      from: "2026-11-01",
      to: "2026-11-10",
      start: "github_issue",
      repo: "api",
      status: "waiting",
    });
    expect(replace).toHaveBeenCalledTimes(8);
    // state を渡すと、App Router がルーターの URL を更新せず、あとでクエリが消える
    for (const call of replace.mock.calls) expect(call[0]).toBeNull();
    expect(window.history.state).not.toEqual({ __NA: true });
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
  });

  it("最初の表示と同じ絞り込みに戻したら、クエリを付けない", () => {
    mount(data(list));
    change(select("状態"), "working");
    expect(window.location.search).toBe("?status=working");
    change(select("状態"), "active");
    expect(window.location.search).toBe("");
  });

  it("条件をクリアは、変えたときだけ出て、最初の表示に戻してクエリを消す", () => {
    mount(data(list));
    expect(clearButton()).toBeUndefined();
    change(input("search"), "決済");
    change(select("状態"), "");
    expect(clearButton()).toBeDefined();
    expect(window.location.search).toContain("status=all");
    act(() => clearButton()?.click());
    expect(select("状態").value).toBe("active");
    expect(input("search").value).toBe("");
    expect(window.location.search).toBe("");
    expect(clearButton()).toBeUndefined();
    expect(ids()).toEqual(["a", "b"]);
  });

  it("絞り込みに関係のないクエリとハッシュを、書き換えでも消さない", () => {
    mount(data(list), { url: "/projects/p1/tasks?foo=1#x" });
    change(input("search"), "決済");
    expect(params().get("foo")).toBe("1");
    expect(params().get("q")).toBe("決済");
    expect(window.location.hash).toBe("#x");
    act(() => clearButton()?.click());
    expect(window.location.search).toBe("?foo=1");
    expect(window.location.hash).toBe("#x");
  });
});

describe("URL からの復元", () => {
  const list = [
    row({ id: "a", title: "決済を直す", start: "sacty", repoName: "web", status: working }),
    row({
      id: "b",
      title: "決済の Issue",
      start: "github_issue",
      repoName: "web",
      status: done,
      createdAt: "2026-11-05T12:00:00",
    }),
    row({ id: "c", title: "別件", repoName: "api", createdAt: "2026-11-20T12:00:00" }),
  ];
  const open = (query: string) => {
    const filter = parseTaskFilter(new URLSearchParams(query));
    mount(data(list), { filter, url: `/projects/p1/tasks?${query}` });
  };

  it("URL の絞り込みで開く（欄の値も復元する）", () => {
    open("q=決済&start=github_issue&repo=web&status=all&from=2026-11-01&to=2026-11-10");
    expect(ids()).toEqual(["b"]);
    expect(input("search").value).toBe("決済");
    expect(input("date", 0).value).toBe("2026-11-01");
    expect(input("date", 1).value).toBe("2026-11-10");
    expect(select("開始地点").value).toBe("github_issue");
    expect(select("リポジトリ").value).toBe("web");
    expect(select("状態").value).toBe("");
    expect(clearButton()).toBeDefined();
  });

  it.each([
    ["status=foo", ["a", "c"], "active"],
    ["from=2026-13-40", ["a", "c"], "active"],
    ["to=abc", ["a", "c"], "active"],
    ["q=", ["a", "c"], "active"],
    ["status=all&status=working", ["a", "c"], "active"],
    ["start=unknown", ["a", "c"], "active"],
    ["q=別件&status=foo", ["c"], "active"],
  ])(
    "知らない値・形の違う値（%s）は、その項目だけ指定なしにして、画面は壊れない",
    (query, shown) => {
      expect(() => open(query)).not.toThrow();
      expect(ids()).toEqual(shown);
      expect(select("状態").value).toBe("active");
      // 状態の指定が無効なら、最初の表示のままなので、クリアも出さない
      if (!query.includes("q=別件")) expect(clearButton()).toBeUndefined();
    },
  );

  it("一覧に無いリポジトリ・開始地点は、選択欄に残して、0 件の案内を出す", () => {
    open("repo=gone&start=jira");
    expect(select("リポジトリ").value).toBe("gone");
    expect(select("開始地点").value).toBe("jira");
    expect(ids()).toEqual([]);
    expect(container.textContent).toContain("条件に合うタスクはありません。");
  });

  it("parseTaskFilter は、検査に通った項目だけを返す", () => {
    expect(
      parseTaskFilter({ status: "all", from: "2026-02-30", to: "2026-02-28", q: ["a", "b"] }),
    ).toEqual({ status: "", to: "2026-02-28" });
    expect(parseTaskFilter({ start: "constructor", status: "toString", repo: "" })).toEqual({});
  });
});

describe("50 行ずつの表示", () => {
  it.each([
    ["ja", 0, null, "条件に合うタスクはありません。"],
    ["ja", 1, 0, "320件中 1件"],
    ["ja", 50, 0, "320件中 50件"],
    ["ja", 51, 1, "320件中 51件（50件を表示）"],
    ["ja", 300, 250, "320件中 300件（50件を表示）"],
    ["en", 51, 1, "51 of 320 (showing 50)"],
    ["en", 300, 250, "300 of 320 (showing 50)"],
  ] as const)(
    "（%s）合う行が %i 件のときの表示・ボタン・件数の文",
    (lang, matching, remaining, text) => {
      locale = lang;
      // 合う行は進行中。合わない行（完了）で全体を 320 件にする
      const rows = [
        ...many(matching, "合う", { status: working }),
        ...many(320 - matching, "合わない", { status: done }),
      ];
      if (matching === 0) {
        mount(data(many(320, "合う", { status: working })));
        change(input("search"), "見つからない");
        expect(ids()).toEqual([]);
        expect(container.textContent).toContain(text);
        expect(more()).toBeUndefined();
        return;
      }
      mount(data(rows));
      expect(ids()).toHaveLength(Math.min(matching, 50));
      expect(count()?.textContent).toBe(text);
      expect(count()?.getAttribute("role")).toBe("status");
      if (remaining === 0) expect(more()).toBeUndefined();
      else expect(more()?.textContent).toBe(m().filter.more(remaining ?? 0));
    },
  );

  it("「さらに表示」で 50 行ずつ足し、足した最初の行へフォーカスを移す。全部出たらボタンが消える", () => {
    mount(data(many(120)));
    expect(ids()).toHaveLength(50);
    expect(more()?.textContent).toBe("さらに表示（残り70件）");
    more()?.focus();
    pressMore();
    expect(ids()).toHaveLength(100);
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="task-row-タスク-51"] a'),
    );
    expect(more()?.textContent).toBe("さらに表示（残り20件）");
    expect(count()?.textContent).toBe("120件中 120件（100件を表示）");
    pressMore();
    expect(ids()).toHaveLength(120);
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="task-row-タスク-101"] a'),
    );
    expect(more()).toBeUndefined();
    expect(count()?.textContent).toBe("120件中 120件");
  });

  it("絞り込みを変えると、出す行は最初の 50 行に戻る", () => {
    const rows = [...many(120, "あ"), ...many(80, "い")].map((r) => r);
    mount(data(rows));
    pressMore();
    expect(ids()).toHaveLength(100);
    change(input("search"), "い");
    expect(ids()).toHaveLength(50);
    expect(more()?.textContent).toBe("さらに表示（残り30件）");
  });

  it("自動の更新で、絞り込み・足した行数・フォーカスを保つ（行が減っても上限までを出す）", async () => {
    vi.useFakeTimers();
    let server = data(many(120));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const version = liveVersion(server);
        const sent = ((init?.headers ?? {}) as Record<string, string>)["x-sacty-live-version"];
        return Response.json(sent === version ? { unchanged: true } : { data: server, version });
      }),
    );
    const wait = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
    mount(server);
    change(input("search"), "タスク");
    pressMore();
    const link = container.querySelector('[data-testid="task-row-タスク-60"] a') as HTMLElement;
    act(() => link.focus());
    server = data(many(130));
    await wait();
    expect(input("search").value).toBe("タスク");
    expect(ids()).toHaveLength(100);
    expect(document.activeElement).toBe(link);
    server = data(many(90));
    await wait();
    expect(ids()).toHaveLength(90);
    expect(input("search").value).toBe("タスク");
    expect(container.querySelector('[data-testid="task-row-タスク-60"] a')).toBe(link);
    expect(document.activeElement).toBe(link);
    expect(more()).toBeUndefined();
  });

  it("区切りの境目の子タスクは、足すと親の下に字下げして続き、読み上げに親を伝える", () => {
    const rows = many(49);
    rows.push(row({ id: "parent", title: "親のタスク" }));
    rows.push(row({ id: "child", title: "子のタスク", child: true, depth: 1, parentId: "parent" }));
    mount(data(rows));
    expect(ids()).toHaveLength(50);
    expect(ids().at(-1)).toBe("parent");
    pressMore();
    expect(ids().at(-1)).toBe("child");
    const childRow = container.querySelector('[data-testid="task-row-child"]');
    expect(childRow?.querySelector("td")?.className).toContain("pl-10");
    expect(childRow?.querySelector(".sr-only")?.textContent).toBe(m().childOf("親のタスク"));
  });

  it("「あなたの出番」のカードは、絞り込まず、区切らない", () => {
    const needsYou = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      title: `カード ${i}`,
      status: "承認待ち",
      action: { href: `/tasks/n${i}`, label: "開く" },
    }));
    mount(
      data(
        [...many(60, "進行", { status: working }), ...many(60, "終", { status: done })],
        needsYou,
      ),
    );
    change(select("状態"), "completed");
    expect(container.querySelectorAll('[aria-labelledby="needs-you"] li')).toHaveLength(60);
    expect(ids()).toHaveLength(50);
    expect(ids()[0]).toBe("終-1");
    expect(count()?.textContent).toBe("120件中 60件（50件を表示）");
  });

  it("戻る・進む（同じ bfcacheId）では絞り込みと足した行数を保ち、新しく開いたときは作り直す", () => {
    mount(data(many(120)));
    change(input("search"), "タスク");
    pressMore();
    expect(ids()).toHaveLength(100);
    render(data(many(120)));
    expect(input("search").value).toBe("タスク");
    expect(ids()).toHaveLength(100);
    bfcache.id = "two";
    window.history.replaceState(null, "", "/projects/p1/tasks");
    render(data(many(120)));
    expect(input("search").value).toBe("");
    expect(ids()).toHaveLength(50);
  });

  it("同じ一覧へクエリ無しで移る（サーバーの絞り込みが変わる）と、最初の表示に戻る", () => {
    const list = [...many(60, "終", { status: done }), ...many(60, "進", { status: working })];
    const url = "/projects/p1/tasks?status=all&q=%E7%B5%82";
    mount(data(list), { filter: parseTaskFilter(new URLSearchParams(url.split("?")[1])), url });
    expect(input("search").value).toBe("終");
    pressMore();
    window.history.replaceState(null, "", "/projects/p1/tasks");
    render(data(list), { filter: {} });
    expect(input("search").value).toBe("");
    expect(select("状態").value).toBe("active");
    expect(ids()).toHaveLength(50);
    expect(ids()[0]).toBe("進-1");
  });

  it("自分が URL に書いた絞り込みでサーバーが描き直されても、足した行数を保つ", () => {
    mount(data(many(120)));
    change(input("search"), "タスク");
    pressMore();
    render(data(many(120)), { filter: parseTaskFilter(params()) });
    expect(input("search").value).toBe("タスク");
    expect(ids()).toHaveLength(100);
  });

  it("クエリ無しで開いて絞り込み、クエリ無しの同じ一覧へ移ると（サーバーの props が変わらなくても）、最初の表示に戻る", () => {
    const list = [...many(60, "終", { status: done }), ...many(60, "進", { status: working })];
    mount(data(list));
    change(select("状態"), "");
    change(input("search"), "終");
    pressMore();
    expect(ids()).toHaveLength(60);
    window.history.replaceState(null, "", "/projects/p1/tasks");
    render(data(list));
    expect(input("search").value).toBe("");
    expect(select("状態").value).toBe("active");
    expect(ids()).toHaveLength(50);
    expect(ids()[0]).toBe("進-1");
  });

  it("どの操作の列の後でも、画面の絞り込みは今の URL と一致する（サーバーの props は {} のまま）", () => {
    const list = [
      ...many(70, "終", { status: done, repoless: false }),
      ...many(70, "進", { status: working }),
    ];
    const queries = [
      "",
      "?status=all",
      "?q=%E7%B5%82&status=all",
      "?status=working&start=sacty",
      "?from=2026-10-01&to=2026-10-31",
      "?repo=gone&status=foo",
      "?foo=1",
    ];
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const shown = () => ({
      query: input("search").value,
      status: select("状態").value,
      start: select("開始地点").value,
      repo: select("リポジトリ").value,
      from: input("date", 0).value,
      to: input("date", 1).value,
    });
    mount(data(list));
    for (let i = 0; i < 80; i++) {
      const op = rand(6);
      if (op === 0) change(input("search"), ["", "終", "進", "x"][rand(4)] ?? "");
      else if (op === 1)
        change(select("状態"), ["", "active", "completed", "working"][rand(4)] ?? "");
      else if (op === 2) change(input("date", 0), ["", "2026-10-05"][rand(2)] ?? "");
      else if (op === 3 && more()) pressMore();
      else if (op === 4) {
        window.history.replaceState(null, "", `/projects/p1/tasks${queries[rand(queries.length)]}`);
        render(data(list));
      } else render(data(list));
      const url = parseTaskFilter(params());
      const base = ids().length >= 0 ? select("状態").value : "";
      expect(shown()).toEqual({
        query: url.query ?? "",
        // 状態は、URL に無ければ最初の表示（終わっていないタスクがあるので「終わっていない」）
        status: url.status === undefined ? "active" : url.status,
        start: url.start ?? "",
        repo: url.repo ?? "",
        from: url.from ?? "",
        to: url.to ?? "",
      });
      expect(base).toBe(shown().status);
    }
  });

  it("作り直されたとき（サーバーの値が古くても）、今の URL の絞り込みで始まる", () => {
    const url = "/projects/p1/tasks?q=%E3%82%BF%E3%82%B9%E3%82%AF&status=all";
    window.history.replaceState(null, "", url);
    bfcache.id = "three";
    render(data(many(120)), { filter: {} });
    expect(input("search").value).toBe("タスク");
    expect(select("状態").value).toBe("");
  });

  it("別のプロジェクトへ移ると、前の絞り込み・足した行数を持ち込まない", () => {
    mount(data(many(120)));
    change(select("状態"), "");
    change(input("search"), "タスク");
    pressMore();
    window.history.replaceState(null, "", "/projects/p2/tasks");
    render(
      {
        ...data([...many(60, "終", { status: done }), ...many(60, "進", { status: working })]),
        projectId: "p2",
      },
      { project: "p2" },
    );
    expect(input("search").value).toBe("");
    expect(select("状態").value).toBe("active");
    expect(ids()).toHaveLength(50);
    expect(ids()[0]).toBe("進-1");
    expect(window.location.search).toBe("");
  });
});
