import { describe, expect, it } from "vitest";
import { messagesFor } from "./index";
import type { Locale } from "./locale";

/**
 * 「あなたの出番」の組の見出し（PBI-442）は、色だけに頼らず文で区別でき、既にある状態の名前と紛れない。
 * ダッシュボードとヘッダーのお知らせで同じ文を使う。
 */
describe("人の出番の組の見出しの文", () => {
  const stateNames: Record<Locale, string[]> = {
    ja: ["承認待ち", "エスカレーション", "一時停止中"],
    en: ["Awaiting approval", "Escalated", "Paused"],
  };

  it.each(["ja", "en"] as const)(
    "%s：2 つの見出しがあり、互いに違い、状態の名前と同じでなく、含まない",
    (locale) => {
      const m = messagesFor(locale);
      const headings = [m.dashboard.attention.groups, m.shell.notices.groups].flatMap((g) => [
        g.decision,
        g.paused,
      ]);
      expect(m.dashboard.attention.groups.decision).not.toBe(m.dashboard.attention.groups.paused);
      // ダッシュボードとベルで同じ文
      expect(m.shell.notices.groups).toEqual(m.dashboard.attention.groups);
      for (const heading of headings) {
        expect(heading.length).toBeGreaterThan(0);
        for (const name of stateNames[locale]) {
          expect(heading.toLowerCase()).not.toContain(name.toLowerCase());
        }
        // 状態の文（statusText の基になる辞書）の語とも同じにしない
        expect(Object.values(m.labels.status)).not.toContain(heading);
      }
    },
  );

  it("使わなくなった「ほかのプロジェクト」「このプロジェクト」の組の文言は、お知らせの辞書に残さない", () => {
    for (const locale of ["ja", "en"] as const) {
      const notices = messagesFor(locale).shell.notices as Record<string, unknown>;
      expect(notices.others).toBeUndefined();
      expect(notices.here).toBeUndefined();
    }
  });
});
