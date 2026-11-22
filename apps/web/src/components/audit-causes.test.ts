// @vitest-environment jsdom
import type { AuditCause, ListedAuditProposal, ProjectAudits } from "@sacty/core";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkRejectState } from "@/app/actions";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

/*
 * 監査の画面の、原因ごとに束ねた出し方とまとめて却下（PBI-443）。実際の部品をブラウザの環境（jsdom）に載せて、
 * 開閉・絞り込み・選択・確認のダイアログ・結果の出し方を操作して確かめる。
 */

let locale: Locale = "ja";
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    replace: _replace,
    scroll: _scroll,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    replace?: boolean;
    scroll?: boolean;
  }) => h("a", { href, ...rest }, children),
}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
const bulkAction = vi.fn(
  async (_prev: BulkRejectState, _data: FormData): Promise<BulkRejectState> => ({}),
);
vi.mock("@/app/actions", () => ({
  adoptAuditProposalAction: vi.fn(async () => ({})),
  rejectAuditProposalAction: vi.fn(async () => ({})),
  rejectAuditProposalsAction: (prev: BulkRejectState, data: FormData) => bulkAction(prev, data),
  deleteAuditMemoryAction: vi.fn(async () => ({})),
  resumeAuditAction: vi.fn(async () => ({})),
}));

const { AuditScreen } = await import("./audit-screen");
const { ProposalView } = await import("./audit");
const { sliceAudits } = await import("@/lib/audit-view");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  locale = "ja";
  bulkAction.mockReset();
  bulkAction.mockImplementation(async () => ({}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const cause = (id: string, patch: Partial<AuditCause> & { tasks?: number } = {}): AuditCause => ({
  id,
  projectId: "p1",
  title: `原因 ${id}`,
  status: "proposed",
  occurrences: Array.from({ length: patch.tasks ?? 1 }, (_, i) => ({
    taskId: `t-${id}-${i}`,
    taskTitle: `タスク ${id}-${i}`,
    at: "2026-10-01T00:00:00Z",
  })),
  ...patch,
});

const proposal = (
  causeId: string,
  n: number,
  decision?: ListedAuditProposal["decision"],
): ListedAuditProposal => ({
  id: `${causeId}:${n}`,
  causeId,
  taskId: `t-${causeId}-0`,
  title: `提案 ${causeId}-${n}`,
  body: "本文",
  target: { kind: "sacty" },
  targetCandidates: [{ kind: "sacty" }],
  taskTitle: `タスク ${causeId}-0`,
  ...(decision ? { decision } : {}),
});

const rejected = (bulk?: { id: string; count: number }) =>
  ({
    kind: "rejected",
    at: "2026-10-02T00:00:00Z",
    reason: "不要",
    ...(bulk ? { bulk } : {}),
  }) as const;

const dataOf = (causes: AuditCause[], proposals: ListedAuditProposal[]): ProjectAudits => ({
  projectId: "p1",
  mock: false,
  defaultCapUsd: 1,
  audits: [],
  causes,
  proposals,
});

/** 全件の監査のデータを、URL の指定で区切って描く（ページのサーバーと同じ）。 */
const screen = (
  data: ProjectAudits,
  filter: "all" | "pending" | "recurred" = "all",
  shown = 20,
) => {
  const sliced = sliceAudits(data, filter, shown);
  return h(AuditScreen, { data: sliced.data, view: sliced.view, today: "2026-10-17" });
};
const draw = (data: ProjectAudits, filter: "all" | "pending" | "recurred" = "all", shown = 20) =>
  act(() => root.render(screen(data, filter, shown)));

const q = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) =>
  scope.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) => [
  ...scope.querySelectorAll<T>(selector),
];
const byText = (text: string, selector = "button") =>
  qa<HTMLButtonElement>(selector).find((b) => b.textContent?.trim() === text);
const causeRow = (id: string) => q(`[data-testid="audit-cause-${id}"]`) as HTMLElement;
const toggle = (id: string) =>
  act(() => (q("button[aria-expanded]", causeRow(id)) as HTMLButtonElement).click());
const checkbox = (name: string) =>
  qa<HTMLInputElement>('input[type="checkbox"]').find((c) => c.getAttribute("aria-label") === name);
const bar = () => q('[data-testid="audit-selected-count"]')?.textContent;

/** 判断待ちの提案を 2 件ずつ持つ原因 n 件。 */
const manyCauses = (n: number, pendingEach = 2) => {
  const causes = Array.from({ length: n }, (_, i) => cause(`c${String(i).padStart(2, "0")}`));
  const proposals = causes.flatMap((c) =>
    Array.from({ length: pendingEach }, (_, i) => proposal(c.id, i)),
  );
  return dataOf(causes, proposals);
};

describe("原因が無いとき・原因の数（PBI-443）", () => {
  it("原因も提案も無ければ、今と同じ案内を出し、選択の帯もまとめて却下のボタンも出さない", () => {
    draw(dataOf([], []));
    expect(container.textContent).toContain("原因はまだありません。");
    expect(q('[data-testid="audit-bulk-bar"]')).toBeNull();
    expect(byText("まとめて却下")).toBeUndefined();
  });

  it("判断待ちの提案がなければ、原因があっても選択の帯を出さない（まとめて却下は押せない）", () => {
    draw(dataOf([cause("a")], [proposal("a", 0, rejected())]));
    expect(causeRow("a")).not.toBeNull();
    expect(q('[data-testid="audit-bulk-bar"]')).toBeNull();
  });

  it("原因 1 件・20 件ちょうどは全件を出して「さらに表示」を出さない。21 件以上は 20 件と「さらに表示」", () => {
    draw(manyCauses(1));
    expect(container.textContent).toContain("1 件中 1 件を表示");
    expect(q('[data-testid="audit-show-more"]')).toBeNull();
    draw(manyCauses(20));
    expect(container.textContent).toContain("20 件中 20 件を表示");
    expect(qa('[data-testid^="audit-cause-c"]').length).toBeGreaterThanOrEqual(20);
    expect(q('[data-testid="audit-show-more"]')).toBeNull();
    draw(manyCauses(21));
    expect(container.textContent).toContain("21 件中 20 件を表示");
    expect(q('[data-testid="audit-show-more"]')).not.toBeNull();
  });

  it("原因 45 件：最初は並びの先頭 20 件で、「さらに表示」の行き先は shown=40、続けて shown=60。45 件になったら消える", () => {
    const data = manyCauses(45);
    draw(data, "all", 20);
    expect(container.textContent).toContain("45 件中 20 件を表示");
    expect(causeRow("c19")).not.toBeNull();
    expect(q('[data-testid="audit-cause-c20"]')).toBeNull();
    expect(q('[data-testid="audit-show-more"]')?.getAttribute("href")).toBe(
      "/projects/p1/audit?shown=40",
    );
    draw(data, "all", 40);
    expect(container.textContent).toContain("45 件中 40 件を表示");
    expect(q('[data-testid="audit-show-more"]')?.getAttribute("href")).toBe(
      "/projects/p1/audit?shown=60",
    );
    draw(data, "all", 60);
    expect(container.textContent).toContain("45 件中 45 件を表示");
    expect(q('[data-testid="audit-show-more"]')).toBeNull();
    // 絞り込み中は、絞り込みも URL に残す
    draw(data, "pending", 20);
    expect(q('[data-testid="audit-show-more"]')?.getAttribute("href")).toBe(
      "/projects/p1/audit?causes=pending&shown=40",
    );
  });
});

describe("畳んだ行と、開いた中（PBI-443）", () => {
  it("畳んだ行に、状態（再発は警告の色と太字）・題・見つかった回数・判断待ちの数が出て、提案の本文と判断のボタンは描かない", () => {
    draw(
      dataOf(
        [cause("r", { status: "recurred", tasks: 3 }), cause("p")],
        [proposal("r", 0), proposal("r", 1), proposal("p", 0)],
      ),
    );
    const row = causeRow("r");
    expect(q("button[aria-expanded]", row)?.getAttribute("aria-expanded")).toBe("false");
    const status = q('[data-testid="audit-cause-status"]', row);
    expect(status?.textContent).toBe("再発");
    expect(status?.className).toContain("font-semibold");
    expect(status?.className).toContain("text-warn");
    expect(row.textContent).toContain("原因 r");
    expect(row.textContent).toContain("3 回");
    expect(q('[data-testid="audit-cause-pending"]', row)?.textContent).toBe("判断待ち 2 件");
    expect(container.textContent).not.toContain("本文");
    expect(byText("採用する")).toBeUndefined();
    expect(qa('input[type="checkbox"]')).toHaveLength(0);
  });

  it("開くと、該当するタスクと提案（判断待ちが先）が出て、判断の入力はその 1 か所だけ。畳むと消える", () => {
    draw(dataOf([cause("a")], [proposal("a", 0), proposal("a", 1, rejected()), proposal("a", 2)]));
    toggle("a");
    expect(q("button[aria-expanded]", causeRow("a"))?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("タスク a-0");
    const titles = qa('[data-testid^="audit-proposal-a:"]').map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(titles).toEqual(["audit-proposal-a:0", "audit-proposal-a:1", "audit-proposal-a:2"]);
    // 提案の表示に、出た監査のタスクが読める（これまで画面全体の検査にあった「出た監査」の代わり）
    expect(q('[data-testid="audit-proposal-a:0"]')?.textContent).toContain("出た監査");
    // 判断の入力（採用）は、判断待ちの提案ごとに 1 つだけ（二重に出ない）
    expect(qa("button").filter((b) => b.textContent === "採用する")).toHaveLength(2);
    expect(
      qa('input[type="checkbox"]').filter((c) => !c.getAttribute("aria-label")?.includes("すべて")),
    ).toHaveLength(2);
    toggle("a");
    expect(q('[data-testid="audit-proposal-a:0"]')).toBeNull();
  });

  it("該当するタスクは 5 件なら全件、6 件なら 5 件と「ほか 1 件」で、押すと 6 件になる", () => {
    draw(dataOf([cause("five", { tasks: 5 }), cause("six", { tasks: 6 })], []));
    toggle("five");
    expect(
      qa("a", causeRow("five")).filter((a) => a.getAttribute("href")?.startsWith("/tasks/")),
    ).toHaveLength(5);
    expect(byText("ほか 1 件")).toBeUndefined();
    toggle("six");
    const links = () =>
      qa("a", causeRow("six")).filter((a) => a.getAttribute("href")?.startsWith("/tasks/"));
    expect(links()).toHaveLength(5);
    act(() => byText("ほか 1 件")?.click());
    expect(links()).toHaveLength(6);
    expect(byText("ほか 1 件")).toBeUndefined();
  });

  it("開いた原因の提案は 10 件なら全件、11 件なら 10 件と「ほか 1 件」。全選択は出している 10 件だけで、「ほか」を押した後に残りを足せる", () => {
    const pending = (id: string, n: number) => Array.from({ length: n }, (_, i) => proposal(id, i));
    draw(
      dataOf([cause("ten"), cause("eleven")], [...pending("ten", 10), ...pending("eleven", 11)]),
    );
    toggle("ten");
    expect(qa('[data-testid^="audit-proposal-ten:"]')).toHaveLength(10);
    expect(byText("ほか 1 件")).toBeUndefined();
    toggle("eleven");
    expect(qa('[data-testid^="audit-proposal-eleven:"]')).toHaveLength(10);
    act(() => checkbox("原因 elevenの判断待ちをすべて選ぶ")?.click());
    expect(bar()).toBe("10 件を選択中");
    act(() => byText("ほか 1 件")?.click());
    expect(qa('[data-testid^="audit-proposal-eleven:"]')).toHaveLength(11);
    // 後から出した提案は、全選択に含まれていない（出していなかった分は選ばれない）
    expect(checkbox("原因 elevenの提案「提案 eleven-10」を選ぶ")?.checked).toBe(false);
    expect(bar()).toBe("10 件を選択中");
  });
});

describe("絞り込み（PBI-443）", () => {
  it("絞り込みは URL の指定になるリンクで、いまの絞り込みを示す。絞り込みを変えると件数の指定は外れる", () => {
    draw(manyCauses(3), "pending", 40);
    const links = qa<HTMLAnchorElement>("nav a");
    expect(links.map((a) => a.textContent)).toEqual(["すべて", "判断待ちあり", "再発だけ"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/projects/p1/audit",
      "/projects/p1/audit?causes=pending",
      "/projects/p1/audit?causes=recurred",
    ]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "true", null]);
  });

  it("合う原因が無いときは案内を出し、絞り込みのリンクは残す。件数の注記は出さない", () => {
    draw(dataOf([cause("a")], [proposal("a", 0)]), "recurred");
    expect(container.textContent).toContain("合う原因はありません。");
    expect(q("nav")).not.toBeNull();
    expect(container.textContent).not.toContain("件中");
  });
});

describe("判断の後の描き直しでも保たれる（PBI-443）", () => {
  it("開いていた原因（25 番目を含む）と選択は、提案を却下したあとの描き直しでも畳まれず、判断済みの提案は選択から外れる", () => {
    const data = manyCauses(45, 2);
    draw(data, "pending", 40);
    toggle("c24");
    act(() => checkbox("原因 c24の提案「提案 c24-0」を選ぶ")?.click());
    act(() => checkbox("原因 c24の提案「提案 c24-1」を選ぶ")?.click());
    expect(bar()).toBe("2 件を選択中");
    // 1 件を却下した後の描き直し（サーバーが新しいデータを渡す。同じ URL の指定）
    const after = dataOf(
      data.causes,
      data.proposals.map((p) => (p.id === "c24:0" ? { ...p, decision: rejected() } : p)),
    );
    draw(after, "pending", 40);
    expect(q("button[aria-expanded]", causeRow("c24"))?.getAttribute("aria-expanded")).toBe("true");
    expect(q('[data-testid="audit-proposal-c24:0"]')).not.toBeNull();
    expect(checkbox("原因 c24の提案「提案 c24-0」を選ぶ")).toBeUndefined();
    expect(bar()).toBe("1 件を選択中");
    expect(q('[data-testid="audit-show-more"]')?.getAttribute("href")).toBe(
      "/projects/p1/audit?causes=pending&shown=60",
    );
  });
});

describe("選択の操作と件数（PBI-443）", () => {
  it("原因 A を全選択して 1 件を外すと中間の状態になり、原因 B の 1 件を足すと件数は A−1+1。A を畳んでも選択は残り、判断済みの提案には選ぶ入力が無い", () => {
    draw(
      dataOf(
        [cause("A"), cause("B")],
        [
          proposal("A", 0),
          proposal("A", 1),
          proposal("A", 2),
          proposal("A", 3, rejected()),
          proposal("B", 0),
          proposal("B", 1),
        ],
      ),
    );
    toggle("A");
    toggle("B");
    const all = () => checkbox("原因 Aの判断待ちをすべて選ぶ") as HTMLInputElement;
    expect(bar()).toBe("0 件を選択中");
    expect(byText("まとめて却下")?.disabled).toBe(true);
    act(() => all().click());
    expect(bar()).toBe("3 件を選択中");
    expect(all().checked).toBe(true);
    act(() => checkbox("原因 Aの提案「提案 A-1」を選ぶ")?.click());
    expect(bar()).toBe("2 件を選択中");
    expect(all().checked).toBe(false);
    expect(all().indeterminate).toBe(true);
    act(() => checkbox("原因 Bの提案「提案 B-0」を選ぶ")?.click());
    expect(bar()).toBe("3 件を選択中");
    toggle("A");
    expect(bar()).toBe("3 件を選択中");
    toggle("A");
    expect(checkbox("原因 Aの提案「提案 A-0」を選ぶ")?.checked).toBe(true);
    expect(checkbox("原因 Aの提案「提案 A-3」を選ぶ")).toBeUndefined();
    expect(byText("まとめて却下")?.disabled).toBe(false);
  });
});

describe("確認のダイアログ（PBI-443）", () => {
  /** 原因 3 件に 10 件ずつ、判断待ちの提案を持たせ、30 件を選んで「まとめて却下」を押す。 */
  const select30 = () => {
    const data = manyCauses(3, 10);
    draw(data);
    for (const id of ["c00", "c01", "c02"]) {
      toggle(id);
      act(() => checkbox(`原因 ${id}の判断待ちをすべて選ぶ`)?.click());
    }
    expect(bar()).toBe("30 件を選択中");
    return data;
  };
  const trigger = () => q('[data-testid="audit-bulk-reject"]') as HTMLButtonElement;
  const dialog = () => q('[data-slot="dialog-content"]');

  it("件数 30 と、原因ごとに分けた 30 件の題がスクロールできる一覧に並び、取り消せない旨が出る。理由が空では確定できない", () => {
    select30();
    act(() => trigger().click());
    const d = dialog() as HTMLElement;
    expect(d).not.toBeNull();
    expect(d.textContent).toContain("30 件の提案を却下します。");
    expect(d.textContent).toContain("却下は取り消せません。");
    const list = q('[data-testid="audit-bulk-list"]', d) as HTMLElement;
    expect(list.className).toContain("overflow-y-auto");
    expect(qa("h3", list).map((e) => e.textContent)).toEqual(["原因 c00", "原因 c01", "原因 c02"]);
    expect(qa("li", list)).toHaveLength(30);
    expect(list.textContent).toContain("提案 c02-9");
    expect((byText("却下を確定する") as HTMLButtonElement).disabled).toBe(true);
    const reason = q<HTMLTextAreaElement>("#audit-bulk-reason", d) as HTMLTextAreaElement;
    expect(reason.required).toBe(true);
    expect(reason.maxLength).toBe(2000);
  });

  it("「やめる」でも Escape でも、何も記録せずに閉じて選択は 30 件のまま残り、フォーカスは「まとめて却下」に戻る", async () => {
    select30();
    act(() => trigger().click());
    await act(async () => byText("やめる")?.click());
    expect(dialog()).toBeNull();
    expect(bar()).toBe("30 件を選択中");
    expect(document.activeElement).toBe(trigger());
    act(() => trigger().click());
    expect(dialog()).not.toBeNull();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(bar()).toBe("30 件を選択中");
    expect(document.activeElement).toBe(trigger());
    expect(bulkAction).not.toHaveBeenCalled();
  });

  it("理由を書いて確定すると、プロジェクト・選んだ全件の ID・理由を渡し、全件成功なら「N 件を却下しました」を出して選択を空にし、ダイアログを閉じる", async () => {
    select30();
    bulkAction.mockImplementation(async (_prev, data) => ({
      result: { rejectedIds: data.getAll("proposalId").map(String), failed: [] },
    }));
    act(() => trigger().click());
    const reason = q<HTMLTextAreaElement>("#audit-bulk-reason") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(reason, "不要なので");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = byText("却下を確定する") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(bulkAction).toHaveBeenCalledTimes(1);
    const sent = bulkAction.mock.calls[0]?.[1] as FormData;
    expect(sent.get("projectId")).toBe("p1");
    expect(sent.get("reason")).toBe("不要なので");
    expect(sent.getAll("proposalId")).toHaveLength(30);
    expect(new Set(sent.getAll("proposalId")).size).toBe(30);
    expect(q('[data-testid="audit-bulk-result"]')?.textContent).toBe("30 件を却下しました。");
    expect(q('[data-testid="audit-bulk-result"]')?.getAttribute("role")).toBe("status");
    expect(dialog()).toBeNull();
    expect(bar()).toBe("0 件を選択中");
  });

  it("一部が却下できなかったときは、できた件数・できなかった件数と、できなかった提案の題と理由を出す。全部成功したようには出さない", async () => {
    select30();
    bulkAction.mockImplementation(async () => ({
      result: {
        rejectedIds: ["c00:0"],
        failed: [
          { proposalId: "c00:1", message: "その提案は、すでに採用か却下をしています。" },
          {
            proposalId: "c01:0",
            message: "このタスクは中止されたため、提案を採用・却下できません。",
          },
        ],
      },
    }));
    act(() => trigger().click());
    const reason = q<HTMLTextAreaElement>("#audit-bulk-reason") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(reason, "理由");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (byText("却下を確定する") as HTMLButtonElement).click());
    const result = q('[data-testid="audit-bulk-result"]') as HTMLElement;
    expect(result.textContent).toContain("1 件を却下し、2 件は却下できませんでした。");
    expect(result.textContent).not.toContain("3 件を却下しました");
    expect(result.textContent).toContain("提案 c00-1：その提案は、すでに採用か却下をしています。");
    expect(result.textContent).toContain(
      "提案 c01-0：このタスクは中止されたため、提案を採用・却下できません。",
    );
    // 1 件でも却下できたので、選択は空にする
    expect(bar()).toBe("0 件を選択中");
  });

  it("成功したあと、フォーカスは結果の領域に移る。確定した後で失敗した提案の原因が一覧から外れても、題は確定時の写しから出る", async () => {
    const data = select30();
    bulkAction.mockImplementation(async () => ({
      result: {
        rejectedIds: ["c00:0"],
        failed: [{ proposalId: "c01:0", message: "判断済み" }],
      },
    }));
    act(() => trigger().click());
    const reason = q<HTMLTextAreaElement>("#audit-bulk-reason") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(reason, "理由");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (byText("却下を確定する") as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    const result = q('[data-testid="audit-bulk-result"]') as HTMLElement;
    expect(document.activeElement).toBe(result);
    // 描き直しで c01 が一覧から外れても、失敗した提案の題は出る
    const rest = dataOf(
      data.causes.filter((c) => c.id !== "c01"),
      data.proposals.filter((p) => p.causeId !== "c01"),
    );
    draw(rest);
    expect(q('[data-testid="audit-bulk-result"]')?.textContent).toContain("提案 c01-0：判断済み");
    expect(q('[data-testid="audit-bulk-result"]')?.textContent).not.toContain("題を表示できません");
  });

  it("1 件も却下できなければ、選択を残して「N 件とも却下できませんでした」と出す。入力の誤りはダイアログの中に出し、閉じない", async () => {
    select30();
    bulkAction.mockImplementationOnce(async () => ({
      message: "理由を入力してください。",
      reason: "x",
    }));
    act(() => trigger().click());
    const reason = q<HTMLTextAreaElement>("#audit-bulk-reason") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(reason, "x");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (byText("却下を確定する") as HTMLButtonElement).click());
    expect(dialog()?.textContent).toContain("理由を入力してください。");
    bulkAction.mockImplementationOnce(async () => ({
      result: { rejectedIds: [], failed: [{ proposalId: "c00:0", message: "判断済み" }] },
    }));
    await act(async () => (byText("却下を確定する") as HTMLButtonElement).click());
    expect(q('[data-testid="audit-bulk-result"]')?.textContent).toContain(
      "1 件とも却下できませんでした。",
    );
    expect(bar()).toBe("30 件を選択中");
  });
});

describe("読み上げの名前とキーボード（PBI-443）", () => {
  it("選ぶ入力の名前に原因と提案の題が入り、開閉のボタンは aria-expanded と開く先を持つ。ボタンは Tab で止まれる普通のボタン", () => {
    draw(dataOf([cause("a")], [proposal("a", 0), proposal("a", 1)]));
    const toggleButton = q("button[aria-expanded]", causeRow("a")) as HTMLButtonElement;
    expect(toggleButton.type).toBe("button");
    expect(toggleButton.tabIndex).toBe(0);
    expect(toggleButton.getAttribute("aria-controls")).toBe("audit-cause-panel-a");
    toggle("a");
    expect(q("#audit-cause-panel-a")).not.toBeNull();
    const names = qa('input[type="checkbox"]').map((c) => c.getAttribute("aria-label"));
    expect(names).toEqual([
      "原因 aの判断待ちをすべて選ぶ",
      "原因 aの提案「提案 a-0」を選ぶ",
      "原因 aの提案「提案 a-1」を選ぶ",
    ]);
    // 見える文字を含む名前（ラベルの名前に見える文字が入る）
    expect(names[0]).toContain("判断待ちをすべて選ぶ");
    // 名前は原因・提案ごとに区別できる
    expect(new Set(names).size).toBe(names.length);
  });

  it("英語の画面でも、足した文言（絞り込み・開閉・選択・ダイアログ）がある", () => {
    locale = "en";
    draw(dataOf([cause("a")], [proposal("a", 0)]));
    expect(container.textContent).toContain("Showing 1 of 1");
    expect(qa("nav a").map((a) => a.textContent)).toEqual([
      "All",
      "Needs decision",
      "Recurred only",
    ]);
    expect(container.textContent).toContain("1 needs decision");
    toggle("a");
    expect(checkbox('Select proposal "提案 a-0" of 原因 a')).toBeDefined();
    act(() => checkbox('Select proposal "提案 a-0" of 原因 a')?.click());
    expect(bar()).toBe("1 selected");
    act(() => byText("Reject selected")?.click());
    expect(dialog()?.textContent).toContain("Rejecting cannot be undone.");
    expect(byText("Cancel")).toBeDefined();
    expect(byText("Confirm rejection")).toBeDefined();
  });

  const dialog = () => q('[data-slot="dialog-content"]');
});

describe("まとめて却下した提案の表示（PBI-443）", () => {
  const view = (decision: ListedAuditProposal["decision"], lang: Locale = "ja") => {
    locale = lang;
    return renderToStaticMarkup(h(ProposalView, { proposal: { ...proposal("a", 0, decision) } }));
  };

  it("bulk がある却下は「まとめて却下（全 3 件）の 1 件」と出し、以前の版の記録（bulk なし）は今と同じ表示", () => {
    expect(view(rejected({ id: "b", count: 3 }))).toContain("まとめて却下（全 3 件）の 1 件");
    expect(view(rejected({ id: "b", count: 3 }), "en")).toContain("1 of 3 rejected in bulk");
    const old = view(rejected());
    expect(old).not.toContain("まとめて却下");
    expect(old).toContain("不要");
    expect(old).toContain("却下の理由");
  });
});

describe("量があるときの速さと描く量（PBI-443）", () => {
  /** 原因 300 件・提案 2,000 件以上（1 つの原因に提案 300 件）。 */
  const big = (bigCauseProposals: number, total: number) => {
    const causes = Array.from({ length: 300 }, (_, i) =>
      cause(`c${String(i).padStart(3, "0")}`, { tasks: 36 }),
    );
    const proposals: ListedAuditProposal[] = [];
    for (let i = 0; i < bigCauseProposals; i++) proposals.push(proposal("c000", i));
    let n = 0;
    while (proposals.length < total) {
      const c = causes[1 + (n % 299)] as AuditCause;
      proposals.push(proposal(c.id, Math.floor(n / 299)));
      n += 1;
    }
    return dataOf(causes, proposals);
  };
  const count = (html: string, tag: string) => html.split(`<${tag}`).length - 1;

  it("原因 300 件・提案 3,500 件で、開いた直後のボタンの数・ページの大きさは、提案を 200 件に減らしたデータと同じ桁", () => {
    const large = big(300, 3500);
    const small = big(30, 200);
    const started = performance.now();
    const largeHtml = renderToStaticMarkup(screen(large));
    const elapsed = performance.now() - started;
    const smallHtml = renderToStaticMarkup(screen(small));
    expect(largeHtml).toContain("原因 c000");
    // 開いた直後：原因 20 件の行だけで、提案の入力は描かない。提案の数に比例しない
    expect(count(largeHtml, "button")).toBe(count(smallHtml, "button"));
    expect(count(largeHtml, 'type="checkbox"')).toBe(0);
    expect(largeHtml.length).toBeLessThan(smallHtml.length * 1.2);
    expect(count(largeHtml, "button")).toBeLessThan(60);
    console.info(
      `audit screen 300 causes / 3500 proposals: first render ${Math.round(elapsed)} ms, ` +
        `${count(largeHtml, "button")} buttons, ${largeHtml.length} bytes (200 proposals: ${count(smallHtml, "button")} buttons, ${smallHtml.length} bytes)`,
    );
  });

  it("提案 300 件の原因を開いても、描くのは先頭 10 件までで、ボタンの数は 200 件のデータで開いたときと同じ桁にとどまる", () => {
    const buttonsAfterOpen = (data: ProjectAudits) => {
      // 毎回、開いた状態を持たない新しい画面から始める
      act(() => root.unmount());
      root = createRoot(container);
      draw(data);
      toggle("c000");
      return {
        buttons: qa("button").length,
        inputs: qa('input[type="checkbox"]').length,
        proposals: qa('[data-testid^="audit-proposal-c000:"]').length,
        height: container.innerHTML.length,
      };
    };
    const large = buttonsAfterOpen(big(300, 2000));
    const small = buttonsAfterOpen(big(30, 200));
    expect(large.proposals).toBe(10);
    expect(small.proposals).toBe(10);
    expect(large.buttons).toBe(small.buttons);
    expect(large.inputs).toBe(11);
    expect(large.height).toBeLessThan(small.height * 1.2);
  });
});
