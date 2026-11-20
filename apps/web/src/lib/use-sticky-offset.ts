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

/**
 * 固定の見出しの実際の高さ（題・操作の折り返しで変わる）を、CSS の変数に入れる。
 * 移動先（`#error-report` など）は `scroll-mt-[calc(var(--sticky-offset)…)]` で、その分を空ける。
 */
export function useStickyOffset(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () =>
      root.style.setProperty(STICKY_OFFSET_VAR, `${stickyOffsetPx(el.offsetHeight)}px`);
    apply();
    if (typeof ResizeObserver === "undefined")
      return () => root.style.removeProperty(STICKY_OFFSET_VAR);
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(STICKY_OFFSET_VAR);
    };
  }, [ref]);
}
