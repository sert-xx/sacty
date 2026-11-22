import { type RefObject, useEffect } from "react";

/** 上に固定した見出しの下端の位置（`top-16` = 64px）。 */
const STICKY_TOP_PX = 64;
/** 固定の見出しの下に空ける余白（px）。 */
const GAP_PX = 16;

/** CSS の変数の名前。移動先の `scroll-margin-top` が、固定の見出しの実際の高さの分を空けるのに使う。 */
export const STICKY_OFFSET_VAR = "--sticky-offset";

/** 固定の見出しの高さから、移動先の上に空ける大きさ（px）。 */
export function stickyOffsetPx(height: number): number {
  return STICKY_TOP_PX + Math.max(0, Math.ceil(height)) + GAP_PX;
}

/** 固定の見出しの外側の箱が固定になる幅（Tailwind の `sm`）。これ未満では、帯（題とタブ）だけが固定になる。 */
const WIDE_QUERY = "(min-width: 640px)";

/**
 * 固定の見出しの実際の高さ（題・操作の折り返しで変わる）を、CSS の変数に入れる。
 * 移動先（`#error-report` など）は `scroll-mt-[calc(var(--sticky-offset)…)]` で、その分を空ける。
 * 測る箱は幅で切り替える。640px 以上は外側の箱（outer）、未満は帯（bar。外側の箱は `display: contents` で高さが 0 になる）。
 * 両方を見張り、幅をまたいだとき（`matchMedia` の change）も測り直す。
 */
export function useStickyOffset(
  outer: RefObject<HTMLElement | null>,
  bar: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const outerEl = outer.current;
    const barEl = bar.current;
    if (!outerEl || !barEl) return;
    const root = document.documentElement;
    const query = typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY) : null;
    const apply = () => {
      const el = query && !query.matches ? barEl : outerEl;
      root.style.setProperty(STICKY_OFFSET_VAR, `${stickyOffsetPx(el.offsetHeight)}px`);
    };
    apply();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(apply);
    observer?.observe(outerEl);
    observer?.observe(barEl);
    query?.addEventListener("change", apply);
    return () => {
      observer?.disconnect();
      query?.removeEventListener("change", apply);
      root.style.removeProperty(STICKY_OFFSET_VAR);
    };
  }, [outer, bar]);
}
