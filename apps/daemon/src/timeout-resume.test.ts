import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ActivityEvent, message } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  incompleteAgentToContinue,
  incompleteResumeLines,
  KEEPS_WORKSPACE_ROLES,
  planContinuation,
  timedOutRunBefore,
  timeoutMinutes,
  timeoutResumeLines,
} from "./timeout-resume.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-timeout-resume-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): ActivityEvent =>
  ({
    id: `e${++seq}`,
    taskId: "t",
    projectId: "p",
    at: "2026-11-02T00:00:00.000Z",
    actor: "sacty",
    type,
    payload,
  }) as unknown as ActivityEvent;

const timedOut = (runId: string, role = "implement", agentId = "a", runtime = "claude-code") =>
  ev("AgentRunTimedOut", { runId, role, agentId, runtime, minutes: 3 });
const continued = (runId: string, stoppedRunId: string) =>
  ev("AgentRunContinued", {
    runId,
    role: "implement",
    agentId: "a",
    runtime: "claude-code",
    mode: "resumed",
    stoppedRunId,
  });

describe("時間切れで止めた実行の再開の判定（PBI-280）", () => {
  describe("timedOutRunBefore：直前の実行が時間切れで止まったか", () => {
    const archived = (runId: string, role = "implement") =>
      ev("AgentSessionArchived", {
        runId,
        role,
        agentId: "a",
        runtime: "claude-code",
        files: [],
        limitBytes: 1,
        skipped: [],
      });

    it("作業履歴が空・時間切れの記録が無ければ無し", () => {
      expect(timedOutRunBefore([])).toBeUndefined();
      expect(timedOutRunBefore([archived("r1")])).toBeUndefined();
    });

    it("時間切れの記録が最後の実行の記録なら、その実行（1件・複数件）", () => {
      expect(timedOutRunBefore([archived("r1"), timedOut("r1")])?.runId).toBe("r1");
      // 複数回止まったときは、最後の 1 件
      expect(
        timedOutRunBefore([
          archived("r1"),
          timedOut("r1"),
          continued("r2", "r1"),
          archived("r2"),
          timedOut("r2"),
        ])?.runId,
      ).toBe("r2");
      // 元のファイルを写せなかった実行（写した記録が無い）も、時間切れの記録だけで見つかる
      expect(timedOutRunBefore([timedOut("r1")])?.runId).toBe("r1");
    });

    it("続けた記録があれば、続けた後なので無し（同じ実行を二度続けない）", () => {
      expect(timedOutRunBefore([timedOut("r1"), continued("r2", "r1")])).toBeUndefined();
      // 続けた実行が時間切れ以外で止まっても、続けた記録が最後
      expect(
        timedOutRunBefore([timedOut("r1"), archived("r2"), continued("r2", "r1")]),
      ).toBeUndefined();
    });

    it("いま実行する実行の開始は無視し、続けた実行の開始・失敗（写した記録が無い）は別の実行として数える", () => {
      const started = (runId: string) =>
        ev("AgentRunStarted", { runId, step: "implement", agentId: "a" });
      const failed = (runId: string) =>
        ev("AgentRunFailed", { runId, step: "implement", agentId: "a", reason: "error" });
      // 時間切れで止めた実行自身の開始・失敗は、時間切れの記録の前後にあっても数えない
      const base = [started("r1"), archived("r1"), timedOut("r1"), failed("r1")];
      expect(timedOutRunBefore(base, "r2")?.runId).toBe("r1");
      expect(timedOutRunBefore([...base, started("r2")], "r2")?.runId).toBe("r1");
      // 続けた実行 r2 がデーモンの停止で中断された（失敗だけが残る）。r3 は r1 を続けない
      const interrupted = [...base, started("r2"), failed("r2")];
      expect(timedOutRunBefore(interrupted, "r3")).toBeUndefined();
      // 失敗が残る前（開始だけ）でも同じ
      expect(timedOutRunBefore([...base, started("r2")], "r3")).toBeUndefined();
    });

    it("準備失敗を挟んでも時間切れのセッションを継続する", () => {
      const start = ev("AgentRunStarted", { runId: "r2", step: "design", agentId: "a" });
      const failure = ev("AgentRunFailed", {
        runId: "r2",
        step: "design",
        agentId: "a",
        preparationFailed: true,
      });
      expect(timedOutRunBefore([timedOut("r1", "design"), start, failure], "r3")?.runId).toBe("r1");
      const early = ev("AgentRunStarted", {
        runId: "r4",
        step: "design",
        agentId: "a",
        preparationFailed: true,
      });
      expect(
        timedOutRunBefore(
          [timedOut("r1", "design"), early, ev("AgentRunFailed", { runId: "r4" })],
          "r5",
        )?.runId,
      ).toBe("r1");
    });

    it("時間切れの後に別の実行（写した記録がある）が挟まれば無し。質問への答え（chat）は数えない", () => {
      expect(timedOutRunBefore([timedOut("r1"), archived("r9", "design")])).toBeUndefined();
      expect(timedOutRunBefore([timedOut("r1"), archived("r9", "chat")])?.runId).toBe("r1");
      // 時間切れの記録より前の実行は関係ない
      expect(
        timedOutRunBefore([archived("r0", "design"), archived("r1"), timedOut("r1")])?.runId,
      ).toBe("r1");
    });
  });

  describe("timeoutMinutes", () => {
    it("run.timeout だけが時間切れ。停止を確かめられない失敗・文字列の失敗は違う", () => {
      expect(timeoutMinutes(message("run.timeout", { minutes: 30 }))).toBe(30);
      expect(timeoutMinutes(message("run.containerNotConfirmed", { name: "x" }))).toBeUndefined();
      expect(timeoutMinutes("エージェントの実行が 3 分を超えたため止めました。")).toBeUndefined();
    });
  });

  describe("planContinuation", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const MAIN = "projects/-workspace/sess-1.jsonl";
    /** 写したファイルを置き、その記録（AgentSessionArchived）を作る。 */
    const archive = (
      runId: string,
      over: { files?: Record<string, string>; payload?: Record<string, unknown> } = {},
    ) => {
      const files = over.files ?? { [MAIN]: '{"x":1}\n' };
      const root = join(dir, runId, "agent");
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      return ev("AgentSessionArchived", {
        runId,
        role: "implement",
        agentId: "a",
        runtime: "claude-code",
        sessionId: "sess-1",
        files: Object.entries(files).map(([path, text]) => ({
          path,
          bytes: Buffer.byteLength(text),
          sha256: sha(text),
          sourceBytes: Buffer.byteLength(text),
        })),
        limitBytes: 1,
        skipped: [],
        ...over.payload,
      });
    };
    const filesDirOf = (runId: string) => join(dir, runId, "agent");
    const run = { role: "implement", agentId: "a", runtime: "claude-code" };

    it("同じ役割・同じエージェントで、写したファイルが記録どおりなら続ける", async () => {
      const plan = await planContinuation([archive("r1"), timedOut("r1")], run, filesDirOf);
      expect(plan).toMatchObject({
        mode: "resume",
        sessionId: "sess-1",
        filesDir: filesDirOf("r1"),
      });
    });

    it("前の実行が時間切れでない・別の役割なら、何も決めない（記録もしない）", async () => {
      expect(await planContinuation([archive("r1")], run, filesDirOf)).toBeUndefined();
      expect(
        await planContinuation([archive("r1"), timedOut("r1", "design")], run, filesDirOf),
      ).toBeUndefined();
    });

    it.each([
      ["エージェントの ID が違う", { ...run, agentId: "b" }, undefined, "agent_changed"],
      ["AI の種類が違う", { ...run, runtime: "codex" }, undefined, "agent_changed"],
    ] as const)("%s：続けない", async (_name, other, _x, reason) => {
      const plan = await planContinuation([archive("r1"), timedOut("r1")], other, filesDirOf);
      expect(plan).toMatchObject({ mode: "restart", reason });
    });

    it("写した記録が無い・写さなかった・ファイルが空・セッションの ID が無い／不正なら no_session", async () => {
      const cases: ActivityEvent[][] = [
        [timedOut("r1")],
        [
          archive("r1", { payload: { notArchived: "container_not_confirmed", files: [] } }),
          timedOut("r1"),
        ],
        [archive("r1", { payload: { files: [] } }), timedOut("r1")],
        [archive("r1", { payload: { sessionId: undefined } }), timedOut("r1")],
        [archive("r1", { payload: { sessionId: "../x" } }), timedOut("r1")],
      ];
      for (const events of cases) {
        expect(await planContinuation(events, run, filesDirOf)).toMatchObject({
          mode: "restart",
          reason: "no_session",
        });
      }
    });

    it("上限で間を省いたファイルがあれば truncated、セッションの本体が無ければ files_broken", async () => {
      const truncated = archive("r1");
      (truncated.payload as { files: Record<string, unknown>[] }).files[0] = {
        ...(truncated.payload as { files: Record<string, unknown>[] }).files[0],
        truncated: { droppedBytes: 1, droppedLines: 1 },
      };
      expect(await planContinuation([truncated, timedOut("r1")], run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "truncated",
      });
      const noMain = archive("r1", { files: { "history.jsonl": "{}\n" } });
      expect(await planContinuation([noMain, timedOut("r1")], run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
    });

    it("写したファイルが書き換えられた・消えた・置き場所が分からなければ files_broken", async () => {
      const events = [archive("r1"), timedOut("r1")];
      writeFileSync(join(filesDirOf("r1"), MAIN), "tampered\n");
      expect(await planContinuation(events, run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
      rmSync(join(filesDirOf("r1"), MAIN));
      expect(await planContinuation(events, run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
      expect(await planContinuation(events, run, () => undefined)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
    });

    it("Codex のセッションは rollout のファイルで確かめる", async () => {
      const path = "sessions/2026/11/02/rollout-2026-11-02T10-00-00-thread-1.jsonl";
      const payload = { runtime: "codex", sessionId: "thread-1" };
      const codex = { role: "implement", agentId: "a", runtime: "codex" };
      expect(
        await planContinuation(
          [
            archive("r1", { files: { [path]: "{}\n" }, payload }),
            timedOut("r1", "implement", "a", "codex"),
          ],
          codex,
          filesDirOf,
        ),
      ).toMatchObject({ mode: "resume", sessionId: "thread-1" });
      // 別のスレッドのファイルしか無ければ、続けられない
      expect(
        await planContinuation(
          [
            archive("r1", {
              files: { "sessions/2026/11/02/rollout-2026-11-02T10-00-00-other.jsonl": "{}\n" },
              payload,
            }),
            timedOut("r1", "implement", "a", "codex"),
          ],
          codex,
          filesDirOf,
        ),
      ).toMatchObject({ mode: "restart", reason: "files_broken" });
    });

    describe("未完了で終わった実装の実行の続き（PBI-350）", () => {
      const completed = (runId: string, step = "implement", agentId = "a") =>
        ev("AgentRunCompleted", { runId, step, agentId, output: "" });
      const incomplete = () => ev("ImplementationIncomplete", { remaining: ["docs"] });
      const started = (runId: string) =>
        ev("AgentRunStarted", { runId, step: "implement", agentId: "a" });
      /** 未完了で終わった実装の実行（写した記録 → 完了 → 未完了の記録）。 */
      const unfinished = (runId: string) => [archive(runId), completed(runId), incomplete()];

      it("直前の実装の実行が未完了で終わったら、同じエージェントのセッションの続きから進める", async () => {
        const plan = await planContinuation(unfinished("r1"), run, filesDirOf);
        expect(plan).toEqual({
          mode: "resume",
          stopped: { runId: "r1", role: "implement", agentId: "a", runtime: "claude-code" },
          cause: { kind: "incomplete" },
          sessionId: "sess-1",
          filesDir: filesDirOf("r1"),
        });
        // いま実行する実行の開始の記録は、別の実行に数えない
        expect(
          await planContinuation(
            [...unfinished("r1"), started("r2")],
            { ...run, runId: "r2" },
            filesDirOf,
          ),
        ).toMatchObject({ mode: "resume", stopped: { runId: "r1" } });
      });

      it("続きの実行もまた未完了で終わったら、その実行のセッションを続ける（何度でも）", async () => {
        const events = [
          ...unfinished("r1"),
          started("r2"),
          { ...continued("r2", "r1") },
          ...unfinished("r2"),
        ];
        expect(await planContinuation(events, run, filesDirOf)).toMatchObject({
          mode: "resume",
          stopped: { runId: "r2" },
          cause: { kind: "incomplete" },
        });
      });

      it("未完了の後にタスクが一時停止して、人が再開しても、同じようにセッションの続きから進める", async () => {
        const events = [
          ...unfinished("r1"),
          ev("TaskPaused", { reason: "incomplete" }),
          ev("TaskResumed", {}),
        ];
        expect(await planContinuation(events, run, filesDirOf)).toEqual({
          mode: "resume",
          stopped: { runId: "r1", role: "implement", agentId: "a", runtime: "claude-code" },
          cause: { kind: "incomplete" },
          sessionId: "sess-1",
          filesDir: filesDirOf("r1"),
        });
      });

      it("未完了の後に別の実行があった・実装でない役割・未完了の記録が無いなら、何も決めない", async () => {
        // 未完了の後に、別の実行が始まった・失敗した・ファイルを写した
        for (const after of [
          started("r2"),
          ev("AgentRunFailed", { runId: "r2", step: "implement", reason: "error", message: "x" }),
          archive("r2"),
        ]) {
          expect(
            await planContinuation(
              [...unfinished("r1"), after],
              { ...run, runId: "r3" },
              filesDirOf,
            ),
          ).toBeUndefined();
        }
        // 実装でない役割の実行（設計など）は続けない
        expect(
          await planContinuation(unfinished("r1"), { ...run, role: "design" }, filesDirOf),
        ).toBeUndefined();
        // 未完了の記録が無い（完了して提出に進んだ）
        expect(
          await planContinuation([archive("r1"), completed("r1")], run, filesDirOf),
        ).toBeUndefined();
        // 未完了の記録の前の完了が、実装のものでない
        expect(
          await planContinuation(
            [archive("r1"), completed("r1", "design"), incomplete()],
            run,
            filesDirOf,
          ),
        ).toBeUndefined();
        // 質問への答え（chat）は、挟まっても数えない
        const chat = ev("AgentSessionArchived", {
          runId: "c1",
          role: "chat",
          agentId: "a",
          runtime: "claude-code",
          files: [],
          limitBytes: 1,
          skipped: [],
        });
        expect(await planContinuation([...unfinished("r1"), chat], run, filesDirOf)).toMatchObject({
          mode: "resume",
          stopped: { runId: "r1" },
        });
      });

      it("時間切れで止めた実行が後にあれば、時間切れの続きとして扱う", async () => {
        const events = [...unfinished("r1"), archive("r2"), timedOut("r2")];
        expect(await planContinuation(events, run, filesDirOf)).toMatchObject({
          mode: "resume",
          stopped: { runId: "r2" },
          cause: { kind: "timeout", minutes: 3 },
        });
      });

      it("エージェントを変えた・写した記録が無い・ファイルが壊れているなら、最初から実行し直す", async () => {
        expect(
          await planContinuation(unfinished("r1"), { ...run, agentId: "b" }, filesDirOf),
        ).toMatchObject({
          mode: "restart",
          reason: "agent_changed",
          cause: { kind: "incomplete" },
        });
        expect(
          await planContinuation(unfinished("r1"), { ...run, runtime: "codex" }, filesDirOf),
        ).toMatchObject({ mode: "restart", reason: "agent_changed" });
        // 写した記録が無い（AI の種類が分からない）
        expect(
          await planContinuation([completed("r1"), incomplete()], run, filesDirOf),
        ).toMatchObject({ mode: "restart", reason: "no_session" });
        const events = unfinished("r1");
        writeFileSync(join(filesDirOf("r1"), MAIN), "tampered\n");
        expect(await planContinuation(events, run, filesDirOf)).toMatchObject({
          mode: "restart",
          reason: "files_broken",
        });
      });
    });
  });

  describe("incompleteAgentToContinue：未完了の続きを始めるエージェント（PBI-417）", () => {
    const started = (runId: string, agentId = "b") =>
      ev("AgentRunStarted", { runId, step: "implement", agentId });
    const completed = (runId: string, agentId = "b") =>
      ev("AgentRunCompleted", { runId, step: "implement", agentId, output: "" });
    const archived = (runId: string) =>
      ev("AgentSessionArchived", {
        runId,
        role: "implement",
        agentId: "b",
        runtime: "claude-code",
        sessionId: "s",
      });
    const incomplete = () => ev("ImplementationIncomplete", { remaining: ["docs"] });
    const changed = (step: string, to: string) => ev("StepAgentChanged", { step, from: "a", to });
    const unfinished = (runId: string, agentId = "b") => [
      started(runId, agentId),
      archived(runId),
      completed(runId, agentId),
      incomplete(),
    ];

    it("直前の実装の実行が未完了で終わっていれば、その実行のエージェント", () => {
      expect(incompleteAgentToContinue(unfinished("r1", "b"))).toBe("b");
    });

    it("未完了の記録が無ければ無し（完了で終わった実行・実行が無い）", () => {
      expect(incompleteAgentToContinue([])).toBeUndefined();
      expect(
        incompleteAgentToContinue([started("r1"), archived("r1"), completed("r1")]),
      ).toBeUndefined();
    });

    it("未完了の後に別の実行が始まっていたら無し", () => {
      expect(incompleteAgentToContinue([...unfinished("r1"), started("r2", "a")])).toBeUndefined();
    });

    it("時間切れで止めた実行の続きは対象外（未完了の記録があっても無し）", () => {
      expect(
        incompleteAgentToContinue([...unfinished("r1"), started("r2"), timedOut("r2")]),
      ).toBeUndefined();
    });

    it("未完了の後に人が実装のエージェントを変えていたら無し", () => {
      expect(
        incompleteAgentToContinue([...unfinished("r1"), changed("implement", "c")]),
      ).toBeUndefined();
    });

    it("未完了で終わった実行の途中で人が変えていても無し（変更前のエージェントを使わない）", () => {
      expect(
        incompleteAgentToContinue([
          started("r1", "a"),
          changed("implement", "c"),
          archived("r1"),
          completed("r1", "a"),
          incomplete(),
        ]),
      ).toBeUndefined();
    });

    it("未完了で終わった実行より前の変更と、ほかの工程の変更は、見ない", () => {
      expect(incompleteAgentToContinue([changed("implement", "c"), ...unfinished("r1", "b")])).toBe(
        "b",
      );
      expect(incompleteAgentToContinue([...unfinished("r1", "b"), changed("review", "c")])).toBe(
        "b",
      );
    });
  });

  describe("incompleteResumeLines（PBI-350）", () => {
    it("続きであること・提出していないこと・最後まで実装すること・出し直すことを伝え、後ろに指示の全文が続くことを知らせる", () => {
      const lines = incompleteResumeLines({}).join("\n");
      expect(lines).toContain("【未完了からの続き】");
      expect(lines).toContain("直前の実装の実行のセッションの続きです");
      expect(lines).toContain("範囲を実装し終える前に終わり、未完了と申告しました");
      expect(lines).toContain("sacty は提出していません");
      // 再開を指定しても、別のセッションで始まることがある
      expect(lines).toContain(
        "これまでの会話が見当たらないとき（セッションを続けられなかったとき）は、下の指示と、作業領域の現状から進めてください。",
      );
      expect(lines).toContain("この実行の中で、範囲のすべて");
      expect(lines).toContain("途中で終えても進まない");
      expect(lines).toContain("省かずに出し直す");
      expect(lines).toContain(
        "次の指示は、直前の実行と同じ内容に、直前の実行の状況（残っていること）と、その後に足された補足や新しい指摘を含めたものです。",
      );
      // 残っていること・完了の申告の形は、後ろに続く指示の全文にあるので、ここでは繰り返さない
      expect(lines).not.toContain("残っていること：");
      expect(lines).not.toContain("--- 完了の申告 ---");
      // 後ろに指示の全文を続けるので、空行で終わる
      expect(lines.endsWith("\n")).toBe(true);
    });

    it("申告だけを求める実行は、コードを変えなくてよいこと・欠けているもの・出し直すものを伝える（PBI-416）", () => {
      const lines = incompleteResumeLines({ unmapped: ["TV-2"], declarationOnly: true }).join("\n");
      expect(lines).toContain("【申告の出し直し】");
      expect(lines).toContain("コードは変えなくてよい");
      expect(lines).toContain("TV-2");
      expect(lines).toContain("すべてのテスト観点の対応");
      expect(lines).toContain("未完了と申告する");
      expect(
        incompleteResumeLines({ undeclared: true, declarationOnly: true }).join("\n"),
      ).toContain("完了の申告が無いか、決まった形どおりに読めませんでした");
    });

    it("申告が無かった・観点の対応が欠けていたときは、その理由を伝える", () => {
      expect(incompleteResumeLines({ undeclared: true }).join("\n")).toContain(
        "完了の申告が無いか、決まった形どおりに読めないまま終わりました",
      );
      expect(incompleteResumeLines({ unmapped: ["TV-2", "TV-3"] }).join("\n")).toContain(
        "テストの対応していないテスト観点がありました",
      );
      // 前回の状況が分からなくても、続きの知らせは出す
      expect(incompleteResumeLines(undefined).join("\n")).toContain("【未完了からの続き】");
    });
  });

  describe("timeoutResumeLines", () => {
    it("止めた上限と、作業領域に残るものを伝える。実装・再現は変更が残り、ほかは残らない", () => {
      const implement = timeoutResumeLines("implement", 3).join("\n");
      expect(implement).toContain("上限の 3 分");
      expect(implement).toContain("止める前に書いたファイルが残っています");
      const requirements = timeoutResumeLines("requirements", 90).join("\n");
      expect(requirements).toContain("上限の 90 分");
      expect(requirements).toContain("止める前に書いたファイルは残っていません");
      expect(KEEPS_WORKSPACE_ROLES).toEqual(["implement", "reproduce"]);
    });
  });
});
