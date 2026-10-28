import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * タスクの再開の Server Action（PR #201 レビュー指摘）。テストが決まらずに止まったタスクで選んだテストの扱いを、
 * フォームの値から ResumeTaskInput の tests にしてデーモンへ渡し、入力の誤りは送らずに理由と入力を返す。
 */
const resumeTask = vi.fn();
const chooseTicketRepository = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/daemon", () => ({
  resumeTask,
  chooseTicketRepository,
  CONTEXT_CHECK_PARAM: "contextCheck",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
  headers: async () => new Headers({ "accept-language": "ja" }),
}));
vi.mock("next/cache", () => ({ refresh, revalidatePath: () => {} }));

const { resumeTaskAction } = await import("./actions");
const { messagesFor } = await import("@/i18n");
const a = messagesFor("ja").common.action;
/** 補足も工程の設定も無いときに、デーモンへ渡す値。 */
const NONE = { note: "", images: {}, agents: {} };

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
};

beforeEach(() => {
  resumeTask.mockReset();
  chooseTicketRepository.mockReset();
  refresh.mockReset();
  resumeTask.mockResolvedValue({ ok: true });
});

describe("タスクの再開のテストの扱い", () => {
  it("テストのコマンドを選んだら、前後の空白を除いて testCommand として渡す", async () => {
    expect(
      await resumeTaskAction(
        {},
        form({ taskId: "t1", tests: "command", testCommand: "  make check ", noTestsReason: "x" }),
      ),
    ).toEqual({});
    expect(resumeTask).toHaveBeenCalledWith("t1", undefined, { testCommand: "make check" }, NONE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("テストなしを選んだら、理由を noTestsReason として渡す", async () => {
    await resumeTaskAction(
      {},
      form({ taskId: "t1", tests: "none", testCommand: "", noTestsReason: " スキル集 " }),
    );
    expect(resumeTask).toHaveBeenCalledWith("t1", undefined, { noTestsReason: "スキル集" }, NONE);
  });

  it("決めずに再開したら、テストの扱いを渡さない", async () => {
    await resumeTaskAction({}, form({ taskId: "t1", tests: "" }));
    expect(resumeTask).toHaveBeenCalledWith("t1", undefined, undefined, NONE);
    await resumeTaskAction({}, form({ taskId: "t2" }));
    expect(resumeTask).toHaveBeenLastCalledWith("t2", undefined, undefined, NONE);
  });

  it("コマンド・理由が空か長すぎれば送らず、理由と入力を返す", async () => {
    expect(
      await resumeTaskAction({}, form({ taskId: "t1", tests: "command", testCommand: "  " })),
    ).toMatchObject({ message: a.testCommandInvalid, tests: "command", testCommand: "" });
    expect(
      await resumeTaskAction(
        {},
        form({ taskId: "t1", tests: "none", noTestsReason: "あ".repeat(2001) }),
      ),
    ).toMatchObject({ message: a.noTestsReasonInvalid, tests: "none" });
    expect(resumeTask).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("デーモンが拒んだら、理由と入力を返して描き直さない", async () => {
    resumeTask.mockResolvedValue({
      ok: false,
      message: "不具合の修正は、テストなしでは進められません。",
    });
    expect(
      await resumeTaskAction({}, form({ taskId: "t1", tests: "none", noTestsReason: "なし" })),
    ).toMatchObject({
      message: "不具合の修正は、テストなしでは進められません。",
      tests: "none",
      noTestsReason: "なし",
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("タスクの再開の補足と工程の設定", () => {
  it("補足（前後の空白を除く）と、工程ごとのイメージ・エージェントを渡す（空の選択と不正な工程は渡さない）", async () => {
    await resumeTaskAction(
      {},
      form({
        taskId: "t1",
        note: "  ACME_TOKEN を使う ",
        "image:implement": "java",
        "image:design": "",
        "image:nope": "java",
        "agent:implement": "strong",
      }),
    );
    expect(resumeTask).toHaveBeenCalledWith("t1", undefined, undefined, {
      note: "ACME_TOKEN を使う",
      images: { implement: "java" },
      agents: { implement: "strong" },
    });
  });

  it("補足が長すぎれば送らず、理由と入力を返す", async () => {
    const note = "あ".repeat(10_001);
    expect(await resumeTaskAction({}, form({ taskId: "t1", note }))).toMatchObject({
      message: a.resumeNoteTooLong(10_000),
      note,
    });
    expect(resumeTask).not.toHaveBeenCalled();
  });
});
