import { describe, expect, it } from "vitest";
import { CreateTicketInput, TICKET_BODY_MAX, TICKET_TITLE_MAX } from "./events.js";

describe("CreateTicketInput", () => {
  it("前後の空白を除いて受け付ける", () => {
    expect(CreateTicketInput.parse({ title: "  A  ", body: " B " })).toEqual({
      title: "A",
      body: "B",
    });
  });

  it("上限ちょうどの文字数は受け付ける", () => {
    const parsed = CreateTicketInput.safeParse({
      title: "あ".repeat(TICKET_TITLE_MAX),
      body: "あ".repeat(TICKET_BODY_MAX),
    });
    expect(parsed.success).toBe(true);
  });

  it("タイトルが上限を超えると、日本語の理由で拒否する", () => {
    const parsed = CreateTicketInput.safeParse({ title: "あ".repeat(TICKET_TITLE_MAX + 1) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["title"]);
    expect(parsed.error?.issues[0]?.message).toBe("タイトルは200文字以内で入力してください。");
  });

  it("内容が上限を超えると、日本語の理由で拒否する", () => {
    const parsed = CreateTicketInput.safeParse({
      title: "A",
      body: "あ".repeat(TICKET_BODY_MAX + 1),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["body"]);
    expect(parsed.error?.issues[0]?.message).toBe("内容は10,000文字以内で入力してください。");
  });
});
