import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import { buildReviewBody } from "./prompts.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore } from "./settings.js";
import { dbPath, dir, FakePulls, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

/**
 * PR のレビューの実行が返した過程の記録（sacty-review-record）を、作業履歴に残し、投稿する本文からは取り除く（PBI-460）。
 * エージェントのセッションのファイルは、形だけを写した架空の内容で作る。
 */
describe("レビューの記録を読み、作業履歴に残し、投稿する本文から取り除く（PBI-460）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const verdict = (v: string) =>
    `\`\`\`json\n${JSON.stringify({ "sacty-review-verdict": { verdict: v } })}\n\`\`\``;
  const block = (value: unknown) => `\`\`\`sacty-review-record\n${JSON.stringify(value)}\n\`\`\``;
  const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  const toolUse = (id: string, name: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  });
  const record = {
    mode: "subagents",
    viewpoints: [
      { id: "C-1", status: "launched", reason: "起動した" },
      { id: "C-2", status: "substituted", reason: "起動し直しても失敗したので、親が代わりに見た" },
      { id: "C-7", status: "not_launched", reason: "並行処理の変更が無い" },
    ],
    dismissed: [
      { title: "指摘A", viewpoint: "C-3", reason: "目的の範囲の外" },
      { title: "指摘B", reason: "既存のレビューと重なる" },
    ],
    dropped: { overlapping: 1, outOfScope: 2, handled: 0, must: 0 },
    verification: [
      { kind: "reused", text: "CI の結果を使い回した" },
      { kind: "ran", text: "文書のテストを実行した" },
    ],
  };
  const normalized = { ...record, notReviewed: [], scope: [] };

  function start(outcome: AgentOutcome) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const made = makeService(activity, [outcome], {
      pulls,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
      sessionLogs: new SessionLogStore(join(dir, "runs")),
    });
    made.executor.sessionFiles = () => ({
      "projects/-workspace/s1.jsonl": jsonl([
        toolUse("t0", "Skill"),
        toolUse("a0", "Agent"),
        toolUse("a1", "Agent"),
      ]),
    });
    made.executor.logLines = () =>
      `${JSON.stringify({ type: "system", subtype: "init", tools: ["Task", "Bash", "Read"] })}\n`;
    const [task] = made.service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: 9,
        title: "PR 9",
        body: "本文",
        url: "https://github.com/acme/app/pull/9",
        labels: ["sacty-review"],
        pullRequest: true,
      },
    ]);
    return { ...made, activity, pulls, id: task?.id ?? "" };
  }
  const completed = (service: ReturnType<typeof start>["service"], id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunCompleted" ? [e.payload] : [],
    );

  /** 答えで実行を終え、投稿するところまで進めて、記録と投稿した本文を返す。 */
  async function run(answer: string) {
    const s = start(out(answer));
    await s.service.runNext(s.id);
    const payload = completed(s.service, s.id)[0];
    const status = s.service.get(s.id)?.task.status;
    // 実行を終えた時点で、作業履歴に残す本文からも、記録のブロックを取り除いてある
    const stored = s.service.get(s.id)?.task.outputs.review ?? "";
    await s.service.runNext(s.id);
    const body = s.pulls.reviews[0]?.body ?? "";
    const records = s.service.get(s.id)?.task.reviewRecords;
    s.activity.close();
    return { ...s, payload, status, body, records, stored };
  }

  it("正しい記録は、作業履歴の reviewRecord に各欄が残り、task.reviewRecords に今回の回の要素ができ、投稿する本文には JSON も見出しも無い", async () => {
    const r = await run(
      `## 総評\n問題はありません。\n\n${verdict("no_findings")}\n\n${block(record)}\n`,
    );
    expect(r.payload?.reviewRecord).toEqual(normalized);
    const records = r.records;
    expect(records).toHaveLength(1);
    expect(records?.[0]).toMatchObject({
      round: 1,
      record: normalized,
      reviewDispatch: { subagents: 2, runtime: "claude-code" },
    });
    expect(r.pulls.reviews).toHaveLength(1);
    expect(r.stored).toContain("## 総評");
    expect(r.stored).not.toContain("sacty-review-record");
    expect(r.stored).not.toContain("viewpoints");
    expect(r.body).toContain("## 総評");
    expect(r.body).toContain("AI がレビューしました（人間は確認していません）。");
    expect(r.body).not.toContain("sacty-review-record");
    expect(r.body).not.toContain("viewpoints");
    expect(r.body).not.toContain("使い回した");
    expect(r.body).not.toContain("指摘A");
  });

  it.each([
    ["JSON として読めない", "```sacty-review-record\n{viewpoints: [\n```"],
    [
      "viewpoints が 101 件",
      block({
        viewpoints: Array.from({ length: 101 }, (_, i) => ({ id: `C-${i}`, status: "launched" })),
      }),
    ],
    ["status が列挙に無い値", block({ viewpoints: [{ id: "C-1", status: "ok" }] })],
    ["dropped に負の数", block({ dropped: { overlapping: -1 } })],
    ["表に無い欄", block({ mode: "subagents", extra: "x" })],
    ["閉じていないフェンス", `\`\`\`sacty-review-record\n${JSON.stringify(record)}`],
  ])(
    "記録が %s ときも、記録だけを null にして、ブロックを取り除き、レビューは投稿する（止めない）",
    async (_name, bad) => {
      // 閉じていないフェンスは文字列の終わりまでなので、最後に置く
      const r = await run(`## 総評\n問題はありません。\n\n${verdict("no_findings")}\n\n${bad}`);
      expect(r.payload?.reviewRecord).toBeNull();
      expect(r.status).not.toBe("paused");
      expect(r.pulls.reviews).toHaveLength(1);
      expect(r.body).toContain("## 総評");
      expect(r.body).not.toContain("sacty-review-record");
      expect(r.body).not.toContain("viewpoints");
      expect(r.body).not.toContain("C-1");
      expect(r.stored).not.toContain("sacty-review-record");
      expect(r.stored).not.toContain("C-1");
      expect(r.records?.[0]).toMatchObject({
        round: 1,
        record: null,
      });
    },
  );

  it("記録のブロックが 2 つあるときは、最初だけを読み、両方を取り除く", async () => {
    const first = { mode: "subagents", scope: ["最初のブロック"] };
    const second = { mode: "sequential", scope: ["2 つ目のブロック"] };
    const r = await run(
      `## 総評\n問題はありません。\n\n${block(first)}\n\n${block(second)}\n\n${verdict("no_findings")}\n`,
    );
    expect(r.payload?.reviewRecord).toMatchObject({ mode: "subagents", scope: ["最初のブロック"] });
    expect(r.body).not.toContain("最初のブロック");
    expect(r.body).not.toContain("2 つ目のブロック");
    expect(r.body).not.toContain("sacty-review-record");
  });

  it("記録の文字列は、秘密の値を伏せてから 500 文字に切る（欄を問わず、境界をまたぐ値も残らない）", async () => {
    const secret = "oauth-secret";
    const long = `${"あ".repeat(495)}${secret}`;
    const r = await run(
      `## 総評\n問題はありません。\n\n${verdict("no_findings")}\n\n${block({
        viewpoints: [{ id: "C-1", status: "launched", reason: `理由 ${secret}` }],
        dismissed: [{ title: `題 ${secret}`, reason: long }],
        verification: [{ kind: "ran", text: `${secret} を使って実行` }],
      })}\n`,
    );
    const saved = JSON.stringify(r.payload?.reviewRecord);
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain("oauth");
    const rec = r.payload?.reviewRecord;
    expect(rec?.viewpoints[0]?.reason).toContain("理由");
    for (const text of [
      rec?.viewpoints[0]?.reason,
      rec?.dismissed[0]?.title,
      rec?.dismissed[0]?.reason,
      rec?.verification[0]?.text,
    ]) {
      expect(text?.length).toBeLessThanOrEqual(500);
    }
    expect(rec?.dismissed[0]?.reason.length).toBe(500);
  });

  it("秘密の値を伏せる処理が失敗しても、記録だけを null にして、レビューは投稿する", async () => {
    const s = start(
      out(`## 総評\n問題はありません。\n\n${verdict("no_findings")}\n\n${block(record)}\n`),
    );
    vi.spyOn(s.service as never, "auditRedactor").mockRejectedValue(new Error("伏せられない"));
    await s.service.runNext(s.id);
    expect(completed(s.service, s.id)[0]?.reviewRecord).toBeNull();
    await s.service.runNext(s.id);
    expect(s.pulls.reviews).toHaveLength(1);
    expect(s.pulls.reviews[0]?.body).toContain("## 総評");
    expect(s.pulls.reviews[0]?.body).not.toContain("sacty-review-record");
    expect(s.pulls.reviews[0]?.body).not.toContain("C-7");
    s.activity.close();
  });

  it("記録のブロックを返さなかった実行は、reviewRecord の欄も、回の要素も作らない", async () => {
    const r = await run(`## 総評\n問題はありません。\n\n${verdict("no_findings")}\n`);
    expect(r.payload && "reviewRecord" in r.payload).toBe(false);
    expect(r.records).toBeUndefined();
  });

  it("本文の組み立ては、投稿の直前にも、残った記録のブロックを取り除く", () => {
    const task = {
      id: "t1",
      reviewRound: 1,
      reviewComments: [],
      reviewVerdicts: [{ round: 1, verdict: "no_findings" }],
      outputs: { review: `## 総評\n問題なし\n\n${block(record)}\n` },
    };
    const body = buildReviewBody(task as never);
    expect(body).toContain("## 総評");
    expect(body).not.toContain("sacty-review-record");
    expect(body).not.toContain("viewpoints");
  });
});
