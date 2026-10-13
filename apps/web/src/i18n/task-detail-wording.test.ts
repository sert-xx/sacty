import { describe, expect, it } from "vitest";
import { messagesFor } from "./index";

describe("タスク詳細の文言（PBI-61）", () => {
  it("中止のボタンに「…」を付けない", () => {
    expect(messagesFor("ja").parts.control.cancel).toBe("中止");
    expect(messagesFor("en").parts.control.cancel).toBe("Cancel");
  });

  it("AI のアイコンの名前は、答え待ちのときだけ答えを書いていることを伝える", () => {
    for (const locale of ["ja", "en"] as const) {
      const m = messagesFor(locale).task.chat;
      expect(m.open).toBe(m.title);
      expect(m.openPending.startsWith(m.open)).toBe(true);
      expect(m.openPending).not.toBe(m.open);
      expect(m.close).not.toBe("");
    }
  });
});
