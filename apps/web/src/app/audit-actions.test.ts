import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 監査の採用・却下・再開の Server Action（PR #134 レビュー指摘）。フォームの値をデーモンへ正しく渡し、成功のときだけ
 * 画面を描き直し、誤り・拒否・通信の失敗では理由と入力を返す。
 */
const adoptAuditProposal = vi.fn();
const rejectAuditProposal = vi.fn();
const rejectAuditProposals = vi.fn();
const resumeAudit = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/daemon", () => ({
  adoptAuditProposal,
  rejectAuditProposal,
  rejectAuditProposals,
  resumeAudit,
  CONTEXT_CHECK_PARAM: "contextCheck",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
  headers: async () => new Headers({ "accept-language": "ja" }),
}));
vi.mock("next/cache", () => ({ refresh, revalidatePath: () => {} }));

const {
  adoptAuditProposalAction,
  rejectAuditProposalAction,
  rejectAuditProposalsAction,
  resumeAuditAction,
} = await import("./actions");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
};

beforeEach(() => {
  adoptAuditProposal.mockReset();
  rejectAuditProposal.mockReset();
  rejectAuditProposals.mockReset();
  resumeAudit.mockReset();
  refresh.mockReset();
});

describe("提案の採用（PBI-124）", () => {
  it("選んだ宛先（JSON）を検査してデーモンへ渡し、成功したら描き直す", async () => {
    adoptAuditProposal.mockResolvedValue({ ok: true });
    const target = { kind: "context", repo: "https://github.com/a/ctx", depth: 1 };
    expect(
      await adoptAuditProposalAction(
        {},
        form({ proposalId: "t1:c1:0", target: JSON.stringify(target) }),
      ),
    ).toEqual({});
    expect(adoptAuditProposal).toHaveBeenCalledWith("t1:c1:0", target, undefined);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("手入れを書いていれば、種類と中身を添えて渡す（PBI-151）", async () => {
    adoptAuditProposal.mockResolvedValue({ ok: true });
    const target = { kind: "sacty" };
    expect(
      await adoptAuditProposalAction(
        {},
        form({
          proposalId: "t1:c1:0",
          target: JSON.stringify(target),
          noteKind: "replace",
          note: "  既にある設定に足す  ",
        }),
      ),
    ).toEqual({});
    expect(adoptAuditProposal).toHaveBeenCalledWith("t1:c1:0", target, {
      kind: "replace",
      text: "既にある設定に足す",
    });
  });

  it("手入れの種類と中身がそろっていなければ、デーモンへ渡さずに理由と入力を返す（PBI-151）", async () => {
    const target = JSON.stringify({ kind: "sacty" });
    expect(
      await adoptAuditProposalAction({}, form({ proposalId: "x", target, note: "足したい" })),
    ).toEqual({
      message: "手入れの種類は、補足か差し替えを選んでください。",
      note: "足したい",
    });
    expect(
      await adoptAuditProposalAction(
        {},
        form({ proposalId: "x", target, noteKind: "supplement", note: "   " }),
      ),
    ).toEqual({
      message: "手入れの中身を入力してください。手を入れないなら、種類を選ばないでください。",
      noteKind: "supplement",
    });
    expect(adoptAuditProposal).not.toHaveBeenCalled();
  });

  it("宛先が JSON でない・形が違えば、デーモンへ渡さずに理由を返す", async () => {
    for (const target of ["not json", JSON.stringify({ kind: "context", repo: "r" })]) {
      expect(await adoptAuditProposalAction({}, form({ proposalId: "x", target }))).toEqual({
        message: "宛先が不正です。",
      });
    }
    expect(adoptAuditProposal).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("デーモンの拒否・通信の失敗では、理由を返して描き直さない", async () => {
    const target = JSON.stringify({ kind: "sacty" });
    adoptAuditProposal.mockResolvedValueOnce({ ok: false, message: "判断済み" });
    expect(await adoptAuditProposalAction({}, form({ proposalId: "x", target }))).toEqual({
      message: "判断済み",
    });
    adoptAuditProposal.mockRejectedValueOnce(new Error("down"));
    expect(await adoptAuditProposalAction({}, form({ proposalId: "x", target }))).toMatchObject({
      message: expect.stringContaining("デーモン"),
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("提案の却下（PBI-124）", () => {
  it("理由をそのままデーモンへ渡し、成功したら描き直す", async () => {
    rejectAuditProposal.mockResolvedValue({ ok: true });
    expect(
      await rejectAuditProposalAction({}, form({ proposalId: "t1:c1:0", reason: "変えない" })),
    ).toEqual({});
    expect(rejectAuditProposal).toHaveBeenCalledWith("t1:c1:0", "変えない");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("拒否・通信の失敗では、理由と入力した理由を返す（入力を消さない）", async () => {
    rejectAuditProposal.mockResolvedValueOnce({ ok: false, message: "入力してください。" });
    expect(await rejectAuditProposalAction({}, form({ proposalId: "x", reason: "  " }))).toEqual({
      message: "入力してください。",
      reason: "  ",
    });
    rejectAuditProposal.mockRejectedValueOnce(new Error("down"));
    expect(
      await rejectAuditProposalAction({}, form({ proposalId: "x", reason: "書いた理由" })),
    ).toMatchObject({ reason: "書いた理由", message: expect.stringContaining("デーモン") });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("予算で止まった監査の再開（PBI-124）", () => {
  it("上限を数にしてデーモンへ渡し、成功したら描き直す", async () => {
    resumeAudit.mockResolvedValue({ ok: true });
    expect(await resumeAuditAction({}, form({ taskId: "t5", capUsd: " 20000.5 " }))).toEqual({});
    expect(resumeAudit).toHaveBeenCalledWith("t5", 20000.5);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("空・数でない・0 以下は、デーモンへ渡さずに理由と入力を返す", async () => {
    for (const capUsd of ["", "abc", "0", "-1"]) {
      expect(await resumeAuditAction({}, form({ taskId: "t5", capUsd }))).toEqual({
        message: "新しい上限は、0 より大きい金額にしてください。",
        capUsd,
      });
    }
    expect(resumeAudit).not.toHaveBeenCalled();
  });

  it("拒否・通信の失敗では、理由と入力した上限を返す", async () => {
    resumeAudit.mockResolvedValueOnce({ ok: false, message: "低い" });
    expect(await resumeAuditAction({}, form({ taskId: "t5", capUsd: "1" }))).toEqual({
      message: "低い",
      capUsd: "1",
    });
    resumeAudit.mockRejectedValueOnce(new Error("down"));
    expect(await resumeAuditAction({}, form({ taskId: "t5", capUsd: "3" }))).toMatchObject({
      capUsd: "3",
      message: expect.stringContaining("デーモン"),
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("提案のまとめての却下（PBI-443）", () => {
  const bulkForm = (ids: string[], reason: string, projectId = "p1") => {
    const data = new FormData();
    data.set("projectId", projectId);
    data.set("reason", reason);
    for (const id of ids) data.append("proposalId", id);
    return data;
  };

  it("選んだ提案の ID・プロジェクト・前後の空白を除いた理由をデーモンへ渡し、却下できたら画面を描き直して結果を返す", async () => {
    rejectAuditProposals.mockResolvedValue({
      ok: true,
      rejectedIds: ["a", "b"],
      failed: [{ proposalId: "c", message: "その提案は、すでに採用か却下をしています。" }],
    });
    const state = await rejectAuditProposalsAction({}, bulkForm(["a", "b", "c"], "  不要  "));
    expect(rejectAuditProposals).toHaveBeenCalledWith("p1", ["a", "b", "c"], "不要");
    expect(state).toEqual({
      result: {
        rejectedIds: ["a", "b"],
        failed: [{ proposalId: "c", message: "その提案は、すでに採用か却下をしています。" }],
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("1 件も却下できなければ、描き直さずに、できなかった理由を返す", async () => {
    rejectAuditProposals.mockResolvedValue({
      ok: true,
      rejectedIds: [],
      failed: [{ proposalId: "a", message: "判断済み" }],
    });
    const state = await rejectAuditProposalsAction({}, bulkForm(["a"], "理由"));
    expect(state.result?.rejectedIds).toEqual([]);
    expect(state.result?.failed).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("2,001 件・重複・空の選択・理由が空・理由が長すぎるときは、デーモンを呼ばずに理由と入力を返す", async () => {
    const many = Array.from({ length: 2001 }, (_, i) => `x${i}`);
    for (const data of [
      bulkForm(many, "理由"),
      bulkForm(["a", "a"], "理由"),
      bulkForm([], "理由"),
      bulkForm(["a"], "理由", ""),
    ]) {
      const state = await rejectAuditProposalsAction({}, data);
      expect(state.message).toContain("選んだ提案を確かめてください");
    }
    expect(await rejectAuditProposalsAction({}, bulkForm(["a"], "   "))).toEqual({
      message: "理由を入力してください。",
      reason: "   ",
    });
    expect((await rejectAuditProposalsAction({}, bulkForm(["a"], "あ".repeat(2001)))).message).toBe(
      "理由は 2000 文字までです。",
    );
    expect(rejectAuditProposals).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("デーモンの拒否・通信の失敗では、理由を残して返し、描き直さない", async () => {
    rejectAuditProposals.mockResolvedValueOnce({ ok: false, message: "確かめてください" });
    expect(await rejectAuditProposalsAction({}, bulkForm(["a"], "理由"))).toEqual({
      message: "確かめてください",
      reason: "理由",
    });
    rejectAuditProposals.mockRejectedValueOnce(new Error("down"));
    const down = await rejectAuditProposalsAction({}, bulkForm(["a"], "理由"));
    expect(down.reason).toBe("理由");
    expect(down.message).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
