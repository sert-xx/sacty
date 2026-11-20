import type { EventInput, Remark } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import { current, dbPath, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

/**
 * 人の差し戻しの回数に上限は無い（PBI-414）。以前の版で上限のために止まったタスクは、残った指摘を元の形のまま
 * 引き継ぎ、人の補足を別に足して進められる。以前の版の作業履歴は、合成して読み込む。
 */
const draft = (text: string, blocks: Record<string, unknown>[] = []): AgentOutcome => ({
  kind: "completed",
  output: [text, ...blocks.map((b) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``)].join("\n\n"),
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
});
const viewpoints = {
  "sacty-test-viewpoints": [{ title: "A", input: "Aの入力", expected: "Aの期待結果" }],
};

/** 要求要件を承認し、設計を 1 回提出したところ（設計の承認待ち）まで進める。 */
async function toDesignGate(extra: AgentOutcome[] = []) {
  const activity = new SqliteActivityStore(dbPath);
  const made = makeService(activity, [
    draft("# 要求要件 v1"),
    draft("# 設計 v1", [viewpoints]),
    ...extra,
  ]);
  const task = made.service.createTask({ projectId: "default", title: "決済API", body: "x" });
  await made.service.runNext(task.id);
  made.service.approve(task.id, {
    step: "requirements",
    submission: current(made.service, task.id),
  });
  await made.service.runNext(task.id);
  return { activity, id: task.id };
}

/** 残った指摘 5 件（複数行・出どころ・元のコメント・「この PR で直す」を含む）。 */
const pending = (target: string): Remark[] => [
  { id: `${target}-4-1`, text: "1 行目\n2 行目\n3 行目" },
  { id: `${target}-4-2`, text: "AI の指摘", source: "sacty_review" },
  { id: `${target}-4-3`, text: "PR のコメント", origin: { key: "review_comment:501", number: 7 } },
  {
    id: `${target}-4-4`,
    text: "この PR で直す",
    origin: { key: "review_comment:502", number: 7 },
    fixOf: "implement-2-1",
  },
  { id: `${target}-4-5`, text: "あ".repeat(2_001) },
];

/**
 * 以前の版の記録を足し、読み込み直す：上限のエスカレーション → 上限を超えて差し戻す（overLimit: true）→ 作り直し →
 * もう一度、同じ内容の上限のエスカレーション。
 */
async function withLegacyEscalation(
  activity: SqliteActivityStore,
  id: string,
  payload: Record<string, unknown>,
) {
  const first: { actor: "person" | "sacty"; event: EventInput }[] = [
    { actor: "sacty", event: { type: "TaskEscalated", payload } as EventInput },
    {
      actor: "person",
      event: {
        type: "ChangesRequested",
        payload: {
          step: "design",
          target: "requirements",
          round: 1,
          remarks: [{ id: "requirements-1-1", text: "以前の指摘" }],
          overLimit: true,
        },
      },
    },
  ];
  activity.append({ taskId: id, projectId: "default", events: first });
  const redo = makeService(activity, [
    draft("# 要求要件 v2"),
    draft("# 設計 v2", [viewpoints]),
  ]).service;
  await redo.runNext(id);
  redo.approve(id, { step: "requirements", submission: current(redo, id) });
  await redo.runNext(id);
  activity.append({
    taskId: id,
    projectId: "default",
    events: [{ actor: "sacty", event: { type: "TaskEscalated", payload } as EventInput }],
  });
  return makeService(activity, [draft("# 要求要件 v3"), draft("# 設計 v3", [viewpoints])]).service;
}

const legacy = (reason: "too_many_changes" | "rework_confirmation", target: string) => ({
  step: "design",
  target,
  reason,
  pendingRemarks: pending(target),
});

const request = (
  service: ReturnType<typeof makeService>["service"],
  id: string,
  target: "requirements" | "design",
  comments: string[],
  extra: Record<string, unknown> = {},
) =>
  service.requestChanges(id, {
    step: "design",
    submission: current(service, id),
    target,
    comments,
    ...extra,
  });

/** 最後に記録した ChangesRequested の remarks。 */
const lastRemarks = (service: ReturnType<typeof makeService>["service"], id: string) => {
  const event = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
  return event?.type === "ChangesRequested" ? event.payload.remarks : [];
};
/** id 以外（文・source・origin・fixOf）を比べる。 */
const withoutId = (list: readonly Remark[]) => list.map(({ id: _id, ...rest }) => rest);

describe("以前の版の記録を読み込む（R-2）", () => {
  it("overLimit: true の ChangesRequested と too_many_changes の TaskEscalated を、誤りなく読み込む", async () => {
    const { activity, id } = await toDesignGate();
    const service = await withLegacyEscalation(
      activity,
      id,
      legacy("too_many_changes", "requirements"),
    );
    const task = service.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(task?.escalation).toMatchObject({ reason: "too_many_changes", target: "requirements" });
    expect(task?.escalation?.pendingRemarks).toEqual(pending("requirements"));
    const change = service.get(id)?.activity.find((e) => e.type === "ChangesRequested");
    expect(change?.type === "ChangesRequested" && change.payload.overLimit).toBe(true);
    activity.close();
  });
});

describe("上限で止まったタスクの差し戻し", () => {
  it("R-13：エスカレーションした工程へ差し戻すと、残った指摘を元の形のまま、人の補足を続けて渡す。2,001 文字の残った指摘も断らない（R-17）", async () => {
    const { activity, id } = await toDesignGate();
    const service = await withLegacyEscalation(
      activity,
      id,
      legacy("too_many_changes", "requirements"),
    );
    const after = request(service, id, "requirements", ["補足 1", "補足 2"]);
    expect(after.status).toBe("queued");
    const added = lastRemarks(service, id);
    expect(added).toHaveLength(7);
    expect(withoutId(added)).toEqual(
      [...withoutId(pending("requirements")), { text: "補足 1" }, { text: "補足 2" }].map((r) => r),
    );
    expect(added.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `requirements-2-${n}`));
    const event = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
    expect(event?.type === "ChangesRequested" && event.payload.overLimit).toBe(false);
    activity.close();
  });

  it("R-14：rework_confirmation は、どの工程へ差し戻しても、残った指摘を引き継ぐ", async () => {
    for (const target of ["design", "requirements"] as const) {
      const { activity, id } = await toDesignGate();
      const service = await withLegacyEscalation(
        activity,
        id,
        legacy("rework_confirmation", "requirements"),
      );
      request(service, id, target, ["補足 1", "補足 2"]);
      const added = lastRemarks(service, id);
      expect(withoutId(added)).toEqual([
        ...withoutId(pending("requirements")),
        { text: "補足 1" },
        { text: "補足 2" },
      ]);
      activity.close();
    }
  });

  it("R-15：too_many_changes は、別の工程へ差し戻すと、残った指摘を引き継がず、補足だけを渡す", async () => {
    const { activity, id } = await toDesignGate();
    const service = await withLegacyEscalation(
      activity,
      id,
      legacy("too_many_changes", "requirements"),
    );
    request(service, id, "design", ["補足だけ"]);
    const added = lastRemarks(service, id);
    expect(withoutId(added)).toEqual([{ text: "補足だけ" }]);
    activity.close();
  });

  it("R-20：引き継ぐ残った指摘も補足も無い差し戻しは、gate.remarksRequired で断り、何も記録しない", async () => {
    const { activity, id } = await toDesignGate();
    const service = await withLegacyEscalation(
      activity,
      id,
      legacy("too_many_changes", "requirements"),
    );
    const before = service.get(id)?.activity.length;
    expect(() => request(service, id, "design", [])).toThrow(
      expect.objectContaining({
        messages: [expect.objectContaining({ code: "gate.remarksRequired" })],
      }),
    );
    expect(service.get(id)?.activity.length).toBe(before);
    expect(service.get(id)?.task.status).toBe("escalated");
    // 残った指摘を引き継ぐ工程へは、補足が無くても差し戻せる
    expect(request(service, id, "requirements", []).status).toBe("queued");
    activity.close();
  });

  it("R-18：補足は 2,000 文字・50 件で通り、2,001 文字・51 件は、何も記録せずに断る", async () => {
    const refused = async (comments: string[], code: string) => {
      const { activity, id } = await toDesignGate();
      const service = await withLegacyEscalation(
        activity,
        id,
        legacy("too_many_changes", "requirements"),
      );
      const before = service.get(id)?.activity.length;
      expect(() => request(service, id, "requirements", comments)).toThrow(new RegExp(code));
      expect(service.get(id)?.activity.length).toBe(before);
      activity.close();
    };
    await refused(["あ".repeat(2_001)], "remarkTooLong");
    await refused(
      Array.from({ length: 51 }, (_, i) => `補足 ${i}`),
      "tooManyRemarks",
    );
    for (const comments of [
      ["あ".repeat(2_000)],
      Array.from({ length: 50 }, (_, i) => `補足 ${i}`),
    ]) {
      const { activity, id } = await toDesignGate();
      const service = await withLegacyEscalation(
        activity,
        id,
        legacy("too_many_changes", "requirements"),
      );
      const after = request(service, id, "requirements", comments);
      // 残った指摘 5 件の後ろに、補足がそのまま続く
      expect(after.status).toBe("queued");
      expect(lastRemarks(service, id)).toHaveLength(5 + comments.length);
      activity.close();
    }
  });

  it("R-19：「上限を超えて差し戻す」の指定は、断らずに無視し、指定が無いときと同じ記録にする", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const { activity, id } = await toDesignGate();
      const service = await withLegacyEscalation(
        activity,
        id,
        legacy("too_many_changes", "requirements"),
      );
      request(service, id, "requirements", ["補足"], extra);
      const event = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
      activity.close();
      return event?.payload;
    };
    const plain = await run({});
    expect(await run({ continueOverLimit: true })).toEqual(plain);
    expect(await run({ continueOverLimit: false })).toEqual(plain);
    expect(plain).toMatchObject({ overLimit: false });
  });

  it("R-1：4 回目の人の差し戻し（承認待ち）は、ChangesRequested（overLimit は偽）を記録し、TaskEscalated を記録しない", async () => {
    const { activity, id } = await toDesignGate([
      ...Array.from({ length: 4 }, (_, i) => draft(`# 設計 v${i + 2}`, [viewpoints])),
    ]);
    const made = makeService(activity, [
      ...Array.from({ length: 4 }, (_, i) => draft(`# 設計 v${i + 2}`, [viewpoints])),
    ]);
    for (let i = 1; i <= 4; i++) {
      const after = request(made.service, id, "design", [`指摘 ${i}`]);
      expect(after.status).toBe("queued");
      await made.service.runNext(id);
    }
    const events = made.service.get(id)?.activity ?? [];
    expect(events.map((e) => e.type)).not.toContain("TaskEscalated");
    const changes = events.filter((e) => e.type === "ChangesRequested");
    expect(changes).toHaveLength(4);
    expect(
      changes.every((e) => e.type === "ChangesRequested" && e.payload.overLimit === false),
    ).toBe(true);
    activity.close();
  });
});
