import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ActivityEvent, message } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEEPS_WORKSPACE_ROLES,
  planTimeoutResume,
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

  describe("planTimeoutResume", () => {
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
      const plan = await planTimeoutResume([archive("r1"), timedOut("r1")], run, filesDirOf);
      expect(plan).toMatchObject({
        mode: "resume",
        sessionId: "sess-1",
        filesDir: filesDirOf("r1"),
      });
    });

    it("前の実行が時間切れでない・別の役割なら、何も決めない（記録もしない）", async () => {
      expect(await planTimeoutResume([archive("r1")], run, filesDirOf)).toBeUndefined();
      expect(
        await planTimeoutResume([archive("r1"), timedOut("r1", "design")], run, filesDirOf),
      ).toBeUndefined();
    });

    it.each([
      ["エージェントの ID が違う", { ...run, agentId: "b" }, undefined, "agent_changed"],
      ["AI の種類が違う", { ...run, runtime: "codex" }, undefined, "agent_changed"],
    ] as const)("%s：続けない", async (_name, other, _x, reason) => {
      const plan = await planTimeoutResume([archive("r1"), timedOut("r1")], other, filesDirOf);
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
        expect(await planTimeoutResume(events, run, filesDirOf)).toMatchObject({
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
      expect(await planTimeoutResume([truncated, timedOut("r1")], run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "truncated",
      });
      const noMain = archive("r1", { files: { "history.jsonl": "{}\n" } });
      expect(await planTimeoutResume([noMain, timedOut("r1")], run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
    });

    it("写したファイルが書き換えられた・消えた・置き場所が分からなければ files_broken", async () => {
      const events = [archive("r1"), timedOut("r1")];
      writeFileSync(join(filesDirOf("r1"), MAIN), "tampered\n");
      expect(await planTimeoutResume(events, run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
      rmSync(join(filesDirOf("r1"), MAIN));
      expect(await planTimeoutResume(events, run, filesDirOf)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
      expect(await planTimeoutResume(events, run, () => undefined)).toMatchObject({
        mode: "restart",
        reason: "files_broken",
      });
    });

    it("Codex のセッションは rollout のファイルで確かめる", async () => {
      const path = "sessions/2026/11/02/rollout-2026-11-02T10-00-00-thread-1.jsonl";
      const payload = { runtime: "codex", sessionId: "thread-1" };
      const codex = { role: "implement", agentId: "a", runtime: "codex" };
      expect(
        await planTimeoutResume(
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
        await planTimeoutResume(
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
