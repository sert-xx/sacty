import { describe, expect, it } from "vitest";
import {
  CreateTaskInput,
  EventInput,
  RESUME_NOTE_MAX,
  ResumeTaskInput,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
} from "./events.js";
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

  it("要求要件・設計の PR の記録（StepPullRequestPublished）も同じ（PBI-99 レビュー指摘）", () => {
    const base = {
      step: "requirements",
      branch: "sacty/task-1-requirements",
      commit: "abc",
      base: "def",
      path: "docs/sacty/requirements.md",
      url: "https://github.com/acme/app/pull/7",
      number: 7,
      repo: "https://github.com/acme/app",
    };
    expect(
      EventInput.parse({
        type: "StepPullRequestPublished",
        payload: { ...base, label: "sacty-review" },
      }).payload,
    ).toEqual({ ...base, label: "sacty-review" });
    expect(
      EventInput.parse({
        type: "StepPullRequestPublished",
        payload: { ...base, intakeLabel: "sacty" },
      }).payload,
    ).toEqual(base);
  });
});

describe("ResumeTaskInput の補足", () => {
  it("改行を LF にそろえてから数える（デーモンの API を直接呼んでも、画面の欄と同じ数え方）", () => {
    const note = `${"あ".repeat(4_999)}\r\n${"い".repeat(5_000)}`;
    expect(ResumeTaskInput.parse({ note }).note).toBe(
      `${"あ".repeat(4_999)}\n${"い".repeat(5_000)}`,
    );
  });

  it("LF にそろえても上限を超える補足は、再開用の誤りで断る", () => {
    const result = ResumeTaskInput.safeParse({ note: `${"あ".repeat(RESUME_NOTE_MAX)}\r\nい` });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("input.resumeNoteTooLong");
  });
});
