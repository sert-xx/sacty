import { describe, expect, it } from "vitest";
import { CreateTaskInput, EventInput, TASK_BODY_MAX, TASK_TITLE_MAX } from "./events.js";
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

describe("PR に付けるラベルの予定（PBI-88・PBI-99）", () => {
  it("label に残す。これまでの記録（intakeLabel）も読めるが、付ける予定としては扱わない（台帳は書き換えない）", () => {
    const base = {
      branch: "sacty/task-1",
      commit: "abc",
      url: "https://github.com/acme/app/pull/7",
      number: 7,
      repo: "https://github.com/acme/app",
    };
    expect(
      EventInput.parse({
        type: "PullRequestPublished",
        payload: { ...base, label: "sacty-review" },
      }).payload,
    ).toEqual({ ...base, label: "sacty-review" });
    expect(
      EventInput.parse({ type: "PullRequestPublished", payload: { ...base, intakeLabel: "sacty" } })
        .payload,
    ).toEqual(base);
  });
});
