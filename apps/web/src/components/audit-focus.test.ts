// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({
  adoptAuditProposalAction: vi.fn(async () => ({})),
  rejectAuditProposalAction: vi.fn(async () => ({})),
  resumeAuditAction: vi.fn(async () => ({})),
}));

const { ProposalView } = await import("./audit");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === name) as
    | HTMLButtonElement
    | undefined;

describe("却下の入力の開閉とフォーカス（PR #134 レビュー指摘）", () => {
  it("最初の表示ではフォーカスを動かさず、開いたら理由の欄へ、やめたら「却下する」へ移す", () => {
    act(() =>
      root.render(
        h(ProposalView, {
          proposal: {
            id: "t1:c1:0",
            causeId: "c1",
            taskId: "t1",
            title: "提案",
            body: "本文",
            target: { kind: "sacty" },
            targetCandidates: [{ kind: "sacty" }],
          },
        }),
      ),
    );
    expect(document.activeElement).toBe(document.body);

    act(() => button("却下する")?.click());
    const reason = container.querySelector("textarea");
    expect(reason).not.toBeNull();
    expect(document.activeElement).toBe(reason);

    act(() => button("やめる")?.click());
    expect(container.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button("却下する"));
  });
});
