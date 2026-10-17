import { describe, expect, it } from "vitest";
import {
  AdoptAuditProposalInput,
  AUDIT_REJECT_REASON_MAX,
  auditAdoptionRate,
  auditRemarkCount,
  RejectAuditProposalInput,
  ResumeAuditInput,
  sameAuditTarget,
} from "./audit.js";

describe("監査の入力（PBI-124）", () => {
  it("採用の宛先は、対象リポジトリ・コンテキスト（depth は 0 以上の整数）・sacty のどれか", () => {
    expect(AdoptAuditProposalInput.parse({ target: { kind: "sacty" } })).toEqual({
      target: { kind: "sacty" },
    });
    expect(
      AdoptAuditProposalInput.safeParse({ target: { kind: "context", repo: "r", depth: 0 } })
        .success,
    ).toBe(true);
    for (const target of [
      { kind: "context", repo: "r", depth: -1 },
      { kind: "context", repo: "r", depth: 1.5 },
      { kind: "repository", repo: "" },
      { kind: "other" },
    ]) {
      expect(AdoptAuditProposalInput.safeParse({ target }).success, JSON.stringify(target)).toBe(
        false,
      );
    }
    expect(AdoptAuditProposalInput.safeParse({ target: { kind: "sacty" }, x: 1 }).success).toBe(
      false,
    );
  });

  it("却下の理由は、前後の空白を除いて 1 文字から上限まで", () => {
    expect(RejectAuditProposalInput.parse({ reason: "  理由  " })).toEqual({ reason: "理由" });
    expect(RejectAuditProposalInput.safeParse({ reason: "   " }).success).toBe(false);
    expect(RejectAuditProposalInput.safeParse({}).success).toBe(false);
    expect(
      RejectAuditProposalInput.safeParse({ reason: "あ".repeat(AUDIT_REJECT_REASON_MAX) }).success,
    ).toBe(true);
    expect(
      RejectAuditProposalInput.safeParse({ reason: "あ".repeat(AUDIT_REJECT_REASON_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it("再開の上限は 0 より大きい金額（省けば、画面が上限を求める理由を出す）", () => {
    expect(ResumeAuditInput.parse({})).toEqual({});
    expect(ResumeAuditInput.safeParse({ capUsd: 0 }).success).toBe(false);
    expect(ResumeAuditInput.safeParse({ capUsd: 2 }).success).toBe(true);
  });
});

describe("監査の小さな関数（PBI-124）", () => {
  it("宛先が同じか（種類・リポジトリ・層で比べる）", () => {
    expect(sameAuditTarget({ kind: "sacty" }, { kind: "sacty" })).toBe(true);
    expect(
      sameAuditTarget({ kind: "repository", repo: "a" }, { kind: "repository", repo: "a" }),
    ).toBe(true);
    expect(
      sameAuditTarget({ kind: "repository", repo: "a" }, { kind: "repository", repo: "b" }),
    ).toBe(false);
    expect(
      sameAuditTarget(
        { kind: "context", repo: "a", depth: 0 },
        { kind: "context", repo: "a", depth: 1 },
      ),
    ).toBe(false);
    expect(
      sameAuditTarget({ kind: "repository", repo: "a" }, { kind: "context", repo: "a", depth: 0 }),
    ).toBe(false);
  });

  it("採用率は、判断した提案が無ければ null", () => {
    expect(auditAdoptionRate(0, 0)).toBeNull();
    expect(auditAdoptionRate(3, 1)).toBe(0.75);
    expect(auditAdoptionRate(0, 2)).toBe(0);
  });

  it("差し戻し・指摘の件数は、人の差し戻しと PR の指摘の合計", () => {
    expect(
      auditRemarkCount({
        changesRequested: 2,
        pullRequestRemark: 3,
        pause: 1,
        retry: 4,
        toolFailure: 5,
        escalation: 1,
      }),
    ).toBe(5);
  });
});
