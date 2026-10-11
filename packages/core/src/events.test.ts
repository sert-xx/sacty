import { describe, expect, it } from "vitest";
import { CreateTaskInput, TASK_BODY_MAX, TASK_TITLE_MAX } from "./events.js";
import { renderMessage } from "./messages.js";

describe("CreateTaskInput", () => {
  it("前後の空白を除いて受け付ける", () => {
    expect(CreateTaskInput.parse({ title: "  A  ", body: " B ", projectId: "p1" })).toEqual({
      title: "A",
      body: "B",
      projectId: "p1",
    });
  });

  it("上限ちょうどの文字数は受け付ける", () => {
    const parsed = CreateTaskInput.safeParse({
      title: "あ".repeat(TASK_TITLE_MAX),
      body: "あ".repeat(TASK_BODY_MAX),
      projectId: "p1",
    });
    expect(parsed.success).toBe(true);
  });

  it("タイトルが上限を超えると、文言のコードで拒否する（画面の言語の文言にできる）", () => {
    const parsed = CreateTaskInput.safeParse({ title: "あ".repeat(TASK_TITLE_MAX + 1) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["title"]);
    expect(parsed.error?.issues[0]?.message).toBe("input.titleTooLong");
    expect(renderMessage(parsed.error?.issues[0]?.message, "ja")).toBe(
      "タイトルは200文字以内で入力してください。",
    );
    expect(renderMessage(parsed.error?.issues[0]?.message, "en")).toBe(
      "Keep the title within 200 characters.",
    );
  });

  it("作るプロジェクトは省略できない（既定のプロジェクトは無い。PBI-22）", () => {
    const parsed = CreateTaskInput.safeParse({ title: "A" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["projectId"]);
  });

  it("内容が上限を超えると、文言のコードで拒否する", () => {
    const parsed = CreateTaskInput.safeParse({
      title: "A",
      body: "あ".repeat(TASK_BODY_MAX + 1),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["body"]);
    expect(renderMessage(parsed.error?.issues[0]?.message, "ja")).toBe(
      "内容は10,000文字以内で入力してください。",
    );
  });
});
