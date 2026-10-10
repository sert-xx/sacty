import type { LedgerEvent, Task, TaskProposal } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { labels } from "@/i18n/messages/labels";
import {
  describeEvent as describeIn,
  isWorking,
  needsPerson,
  personAction as personActionIn,
  statusText as statusTextIn,
} from "./labels";

// 既存のテストは日本語の文言で確かめる
const ja = labels.ja;
const statusText = (task: Task) => statusTextIn(task, ja);
const personAction = (task: Task) => personActionIn(task, ja);
const describeEvent = (event: LedgerEvent) => describeIn(event, ja);

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
  misses: [],
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

describe("成果物チェックの表示（PBI-10b）", () => {
  const event = (e: Pick<LedgerEvent, "type" | "payload">): LedgerEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-10T00:00:00.000Z",
      actor: "person",
    }) as LedgerEvent;

  it("実装へ戻すときは承認の取り消しを書かず、設計へ戻すときは書く", () => {
    const back = (target: "implement" | "design") =>
      describeEvent(
        event({
          type: "ChangesRequested",
          payload: {
            step: "pr",
            target,
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
      );
    expect(back("implement")).toBe("成果物チェックで差し戻し、実装からやり直し：指摘1件（人間）");
    expect(back("design")).toBe(
      "成果物チェックで差し戻し、設計からやり直し（設計の承認を取り消し）：指摘1件（人間）",
    );
    expect(
      describeEvent(event({ type: "StepSubmitted", payload: { step: "pr", submission: 2 } })),
    ).toBe("成果物チェックに提出（2回目）→ 承認待ち");
  });

  it("成果物チェック待ちと完了を表示する", () => {
    expect(
      statusText(task({ status: "awaiting_approval", gate: { step: "pr", submission: 1 } })),
    ).toBe("成果物チェック待ち");
    const done = task({
      steps: [
        { key: "requirements", state: "done" },
        { key: "pr", state: "done" },
      ],
    });
    expect(statusText(done)).toBe("完了");
    expect(isWorking(done)).toBe(false);
  });
});

describe("英語の表示（PBI-4b）", () => {
  const en = labels.en;
  const event = (e: Pick<LedgerEvent, "type" | "payload">): LedgerEvent =>
    ({
      ...e,
      seq: 1,
      id: "e1",
      taskId: "t1",
      projectId: "default",
      at: "2026-10-10T00:00:00.000Z",
      actor: "person",
    }) as LedgerEvent;

  it("用語集の英語で、状態と台帳を表示する", () => {
    expect(
      statusTextIn(task({ status: "awaiting_approval", gate: { step: "pr", submission: 2 } }), en),
    ).toBe("Awaiting deliverable review (submission 2)");
    expect(
      statusTextIn(
        task({ status: "awaiting_approval", gate: { step: "requirements", submission: 1 } }),
        en,
      ),
    ).toBe("Requirements awaiting approval");
    expect(personActionIn(task({ status: "awaiting_approval" }), en).label).toBe("Review");
    expect(
      describeIn(
        event({
          type: "ChangesRequested",
          payload: {
            step: "pr",
            target: "design",
            round: 1,
            remarks: [{ id: "x", text: "y" }],
            overLimit: false,
          },
        }),
        en,
      ),
    ).toBe(
      "Changes requested in deliverable review; redo from Design (Design approval revoked): 1 comment (person)",
    );
    expect(
      describeIn(
        event({
          type: "TaskEscalated",
          payload: {
            step: "design",
            reason: "change_undecidable",
            proposalId: "CP-1",
            pendingRemarks: [],
          },
        }),
        en,
      ),
    ).toBe("Escalated: the Goal Guardian could not decide CP-1");
  });
});
