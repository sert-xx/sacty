import { describe, expect, it, vi } from "vitest";

// プロジェクトが1つも無い
vi.mock("@/lib/header-data", () => ({ loadHeaderData: async () => null }));
vi.mock("@/i18n/server", () => ({ languagePreference: async () => "ja" }));

const { AppHeader, HeaderFallback } = await import("./header");
const { LiveHeaderMenus } = await import("./live-header");

type Element = { type: unknown; props: { children?: unknown; live?: boolean } };

describe("プロジェクトが1つも無いときのヘッダー（PR #119 レビュー指摘）", () => {
  it("切り替えとお知らせは出さないが、取り直しは始めておく（ほかのタブで最初のプロジェクトを作ったら出す）", async () => {
    const element = (await AppHeader()) as Element;
    expect(element.type).toBe(HeaderFallback);
    expect(element.props.live).toBe(true);
    const frame = HeaderFallback({ language: "ja", live: true }) as Element;
    const children = [frame.props.children].flat() as Element[];
    expect(children.some((c) => c?.type === LiveHeaderMenus)).toBe(true);
  });
});
