import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { MAIN_ID, SkipLink } from "@/components/shell/skip-link";
import RootLayout, { viewport } from "./layout";

type El = ReactElement<{ children?: ReactNode; id?: string; tabIndex?: number }>;

/** 描画せずに、layout が返す要素の木を辿って要素を集める（Suspense の中も含む）。 */
function collect(node: ReactNode, out: El[] = []): El[] {
  Children.forEach(node, (c) => {
    if (!isValidElement(c)) return;
    const el = c as El;
    out.push(el);
    collect(el.props.children, out);
  });
  return out;
}

describe("layout の本文へ移動", () => {
  const all = collect(RootLayout({ children: null }) as ReactNode);

  it("SkipLink を置く", () => {
    expect(all.some((e) => e.type === SkipLink)).toBe(true);
  });

  it("main に、SkipLink が指す id と tabIndex=-1 がある", () => {
    const main = all.find((e) => e.type === "main");
    expect(main?.props.id).toBe(MAIN_ID);
    expect(main?.props.id).toBe("main-content");
    expect(main?.props.tabIndex).toBe(-1);
  });
});

describe("layout の viewport", () => {
  it("viewportFit を cover にする（画面の下の安全な領域を env() で使うため）", () => {
    expect(viewport.viewportFit).toBe("cover");
  });
});
