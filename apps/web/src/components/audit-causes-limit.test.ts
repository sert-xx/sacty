// @vitest-environment jsdom
import type { AuditCause, ListedAuditProposal, ProjectAudits } from "@sacty/core";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * 監査の画面のまとめて却下の上限（PBI-443）。2,001 件を選ぶには原因を 201 件開くので、提案の表示は軽い代わりの部品にして、
 * 選択と確定の止め方だけを確かめる（提案の表示そのものは audit-causes.test.ts で確かめる）。
 */

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
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/components/audit", () => ({
  AuditStatusLabel: () => null,
  MockBadge: () => null,
  ProposalView: ({ proposal }: { proposal: { id: string; title: string } }) =>
    h("div", { "data-testid": `audit-proposal-${proposal.id}` }, proposal.title),
}));
const bulkAction = vi.fn(async () => ({}));
vi.mock("@/app/actions", () => ({
  rejectAuditProposalsAction: () => bulkAction(),
}));

const { AuditScreen } = await import("./audit-screen");
const { sliceAudits } = await import("@/lib/audit-view");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  bulkAction.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const cause = (id: string): AuditCause => ({
  id,
  projectId: "p1",
  title: `原因 ${id}`,
  status: "proposed",
  occurrences: [{ taskId: `t-${id}`, taskTitle: `タスク ${id}`, at: "2026-10-01T00:00:00Z" }],
});
const proposal = (causeId: string, n: number): ListedAuditProposal => ({
  id: `${causeId}:${n}`,
  causeId,
  taskId: `t-${causeId}`,
  title: `提案 ${causeId}-${n}`,
  body: "",
  target: { kind: "sacty" },
  targetCandidates: [{ kind: "sacty" }],
  taskTitle: `タスク ${causeId}`,
});

describe("まとめて却下の上限（PBI-443）", () => {
  it("2,000 件までは確定できる状態で、2,001 件を選ぶと、確定のボタンは押せず、上限を案内し、受け口は呼ばれない", async () => {
    // 判断待ちの提案を 10 件ずつ持つ原因 201 件（すべて出し、開いて全選択する）
    const causes = Array.from({ length: 201 }, (_, i) => cause(`c${String(i).padStart(3, "0")}`));
    const proposals = causes.flatMap((c) =>
      Array.from({ length: 10 }, (_, i) => proposal(c.id, i)),
    );
    const data: ProjectAudits = {
      projectId: "p1",
      mock: false,
      defaultCapUsd: 1,
      audits: [],
      causes,
      proposals,
    };
    const sliced = sliceAudits(data, "all", 220);
    act(() =>
      root.render(h(AuditScreen, { data: sliced.data, view: sliced.view, today: "2026-10-17" })),
    );
    const bar = () => document.querySelector('[data-testid="audit-selected-count"]')?.textContent;
    const rowButton = (id: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-testid="audit-cause-${id}"] button[aria-expanded]`,
      );
    const selectAll = (id: string) =>
      document.querySelector<HTMLInputElement>(
        `input[aria-label="原因 ${id}の判断待ちをすべて選ぶ"]`,
      );
    const reject = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="audit-bulk-reject"]');
    for (const [i, c] of causes.entries()) {
      act(() => rowButton(c.id)?.click());
      act(() => selectAll(c.id)?.click());
      if (i === 199) {
        // 2,000 件ちょうどは上限の内
        expect(bar()).toBe("2000 件を選択中");
        expect(document.body.textContent).not.toContain("選べるのは 2000 件までです。");
      }
    }
    expect(bar()).toBe("2010 件を選択中");
    expect(document.body.textContent).toContain("選べるのは 2000 件までです。");
    act(() => reject()?.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "却下を確定する",
    ) as HTMLButtonElement;
    const reason = document.querySelector<HTMLTextAreaElement>("#audit-bulk-reason");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(reason, "理由");
      reason?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // 理由を書いても、上限を超えている間は確定できない
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(bulkAction).not.toHaveBeenCalled();
  }, 60_000);
});
