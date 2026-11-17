import { describe, expect, it } from "vitest";
import {
  type CiCheck,
  CreateTaskInput,
  ciAllPassed,
  EventInput,
  RESUME_NOTE_MAX,
  RequestChangesInput,
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

describe("差し戻しの原因（PBI-268）", () => {
  const changes = (extra: Record<string, unknown> = {}) => ({
    type: "ChangesRequested",
    payload: {
      step: "implement",
      round: 1,
      remarks: [{ id: "implement-1-1", text: "直して" }],
      ...extra,
    },
  });

  it("原因の無い過去の差し戻しも読める。原因は3種類だけ", () => {
    // PBI-267 までの作業履歴には、cause が無い
    expect(EventInput.parse(changes()).payload).not.toHaveProperty("cause");
    for (const cause of ["guardian_missed", "base_changed", "new_request"]) {
      expect(EventInput.parse(changes({ cause })).payload).toMatchObject({ cause });
    }
    expect(EventInput.safeParse(changes({ cause: "other" })).success).toBe(false);
  });

  it("戻し先の判断（ReworkJudged）の原因は、あってもなくてもよい", () => {
    const judged = (extra: Record<string, unknown> = {}) => ({
      type: "ReworkJudged",
      payload: { reason: "r", agentId: "a", ...extra },
    });
    expect(EventInput.safeParse(judged()).success).toBe(true);
    expect(EventInput.safeParse(judged({ cause: "new_request" })).success).toBe(true);
    expect(EventInput.safeParse(judged({ cause: "x" })).success).toBe(false);
  });

  it("差し戻しの入力の原因は省略でき、知らない値は断る", () => {
    const input = { step: "implement", submission: 1, comments: ["x"] };
    expect(RequestChangesInput.parse(input)).not.toHaveProperty("cause");
    expect(RequestChangesInput.parse({ ...input, cause: "base_changed" }).cause).toBe(
      "base_changed",
    );
    expect(RequestChangesInput.safeParse({ ...input, cause: "x" }).success).toBe(false);
  });
});

describe("CI の一覧が通ったか（ciAllPassed。PBI-375）", () => {
  const check = (conclusion?: string, kind: CiCheck["kind"] = "workflow"): CiCheck => ({
    kind,
    name: "CI",
    status: conclusion === undefined ? "pending" : "completed",
    ...(conclusion === undefined ? {} : { conclusion }),
  });

  it("空でなく、すべて終わっていて、成功（と、実行されなかった・中立）だけなら、通ったとする", () => {
    expect(ciAllPassed([check("success")])).toBe(true);
    expect(ciAllPassed([check("success"), check("success", "status")])).toBe(true);
    expect(ciAllPassed([check("success"), check("skipped", "check"), check("neutral")])).toBe(true);
  });

  it.each<[string, CiCheck[]]>([
    ["空の一覧", []],
    ["取り消し", [check("success"), check("cancelled")]],
    ["取り消しだけ", [check("cancelled")]],
    ["失敗", [check("success"), check("failure")]],
    ["時間切れ", [check("success"), check("timed_out")]],
    ["古い結果", [check("success"), check("stale")]],
    ["実行中", [check("success"), check()]],
    ["実行されなかったものだけ", [check("skipped"), check("neutral")]],
    [
      "結論の無い終わったもの",
      [check("success"), { kind: "check", name: "x", status: "completed" }],
    ],
    ["空の結論", [check("success"), check("")]],
    ["コミットの状態の失敗", [check("success"), check("failure", "status")]],
    ["コミットの状態のエラー", [check("success"), check("error", "status")]],
    ["コミットの状態の成功以外", [check("success"), check("neutral", "status")]],
    ["知らない結論", [check("success"), check("something_new")]],
  ])("%sがあれば、通ったとしない", (_name, checks) => {
    expect(ciAllPassed(checks)).toBe(false);
  });

  it("消したことの記録（PullRequestCiRecovered）は、PR の番号と先頭のコミットを持つ", () => {
    const recovered = (payload: object) => ({ type: "PullRequestCiRecovered", payload });
    expect(EventInput.safeParse(recovered({ number: 7, commit: "abc" })).success).toBe(true);
    expect(EventInput.safeParse(recovered({ number: 7, commit: "" })).success).toBe(false);
    expect(EventInput.safeParse(recovered({ number: 0, commit: "abc" })).success).toBe(false);
  });
});
