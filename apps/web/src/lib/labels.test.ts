import type { Task, TaskProposal } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { isWorking, needsPerson, personAction, statusText } from "./labels";

const proposal = (patch: Partial<TaskProposal> = {}): TaskProposal => ({
  id: "CP-1",
  fromStep: "design",
  target: "requirements",
  reason: "r",
  facts: [],
  proposed: "p",
  proposedAt: "2026-10-10T00:00:00.000Z",
  applied: false,
  ...patch,
});

const task = (patch: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "default",
  title: "A",
  body: "",
  start: "ticket",
  status: "idle",
  steps: [],
  outputs: {},
  testViewpoints: [],
  approved: {},
  proposals: [],
  testMap: [],
  verifyFailures: 0,
  submissions: {},
  remarks: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...patch,
});

describe("一覧と詳細の導線（PBI-9 レビュー指摘）", () => {
  it("ゴールガーディアンの判定中は、待機（idle）でも作業中として自動更新する", () => {
    expect(isWorking(task({ proposals: [proposal()] }))).toBe(true);
    expect(statusText(task({ proposals: [proposal()] }))).toBe("ゴールガーディアンが判定中");
    const judged = proposal({ judgement: { verdict: "rejected", reason: "x", at: "" } });
    expect(isWorking(task({ proposals: [judged] }))).toBe(false);
    expect(isWorking(task({ status: "running" }))).toBe(true);
    // 実装の検証中（テスト・最終レビュー）も、待機（idle）のまま作業中（PBI-10a）
    expect(isWorking(task({ verification: "pending" }))).toBe(true);
    expect(statusText(task({ verification: "tests_passed" }))).toBe(
      "ゴールガーディアンが最終レビュー中",
    );
  });

  it("判定できなかった申し出は、判断フォームのある「変更の申し出と判定」へ誘導する", () => {
    const undecided = task({
      status: "escalated",
      proposals: [proposal({ judgement: { verdict: "undecidable", reason: "x", at: "" } })],
    });
    expect(needsPerson(undecided)).toBe(true);
    expect(personAction(undecided)).toEqual({ href: "/tasks/t1#proposals", label: "判断する" });
    // 差し戻しの上限によるエスカレーションと承認待ちは、成果物チェックへ
    expect(personAction(task({ status: "escalated" })).href).toBe("/tasks/t1/review");
    expect(personAction(task({ status: "awaiting_approval" }))).toEqual({
      href: "/tasks/t1/review",
      label: "チェックする",
    });
    expect(personAction(task({ status: "paused" })).href).toBe("/tasks/t1");
  });
});
