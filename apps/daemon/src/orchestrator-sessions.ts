import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ArchivedAgentFile, type OrchestratorSessionReason } from "@sacty/core";
import { z } from "zod";
import {
  type AgentSessionRuntime,
  archivedFilePath,
  checkArchivedFiles,
  hashFile,
  safeRelativePath,
} from "./agent-sessions.js";
import { validLogId } from "./session-logs.js";

/**
 * オーケストレーターのセッションを、タスクごとに持つ（PBI-67）。SACTY_HOME/sessions/<タスク>/orchestrator/ に、
 * AI の種類・エージェントの ID・セッションの ID と、セッションのファイル（PBI-66 で実行ごとに写した元のファイル。伏せた後の
 * もの）を置く。セッションは正本ではなく作業用のキャッシュ（正本は台帳）なので、無い・壊れた・エージェントを変えたときは、
 * 新しいセッションで始める。
 *
 * 保存は、実行ごとの場所（generations/<実行>/files/）に写してから session.json を置き換える（書き換えない）。複製で答える
 * 質問（チャット）が読んでいる間に保存されても、読んでいるファイルは変わらない。いまのものと、その1つ前の場所だけを残す。
 */

/** セッションの ID として受け付ける形（エージェントの出力から読むので、コマンドの引数・ファイルの名前に使える形だけ）。 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

const StoredSession = z.object({
  version: z.literal(1),
  agentId: z.string().min(1),
  runtime: z.enum(["claude-code", "codex"]),
  sessionId: z.string().regex(SESSION_ID),
  /** ファイルを写した実行（保存の場所の名前）。 */
  runId: z.string().min(1),
  savedAt: z.string(),
  files: z.array(ArchivedAgentFile).min(1),
});
export type StoredOrchestratorSession = z.infer<typeof StoredSession>;

/** Codex のセッションのファイルの名前（rollout-<日時>-<スレッド>.jsonl）。 */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/** セッションの本体のファイル（Claude Code：projects/<作業ディレクトリ>/<ID>.jsonl、Codex：sessions/…/rollout-…-<ID>.jsonl）。 */
export function sessionMainFile(
  runtime: AgentSessionRuntime,
  sessionId: string,
  files: readonly { path: string }[],
): string | undefined {
  if (!validSessionId(sessionId)) return undefined;
  return files.find(({ path }) => {
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "";
    return runtime === "claude-code"
      ? parts.length === 3 && parts[0] === "projects" && name === `${sessionId}.jsonl`
      : parts[0] === "sessions" && ROLLOUT.exec(name)?.[1] === sessionId;
  })?.path;
}

/** 別のエージェントの、保存してあったセッション（やり取りを引き継ぐため）。mainFile はセッションの本体のファイル。 */
export type OrchestratorHandoff = {
  agentId: string;
  runtime: AgentSessionRuntime;
  sessionId: string;
  mainFile: string;
};

export type OrchestratorSessionPlan =
  | { mode: "resume"; sessionId: string; filesDir: string }
  | { mode: "new"; reason: OrchestratorSessionReason; handoff?: OrchestratorHandoff };

export type SaveResult =
  | { saved: true }
  | { saved: false; notSaved: "no_session" | "session_missing" | "copy_failed" };

export class OrchestratorSessionStore {
  constructor(private readonly root: string) {}

  /** タスクのセッションの場所。ID の形が正しくなければ undefined。 */
  private dir(taskId: string): string | undefined {
    return validLogId(taskId) ? join(this.root, taskId, "orchestrator") : undefined;
  }

  /** タスクのセッションの場所があるか（中止の片付けの確認に出す）。 */
  has(taskId: string): boolean {
    const dir = this.dir(taskId);
    return dir !== undefined && existsSync(dir);
  }

  /** タスクのセッションを消す（中止の片付け）。消せなければ例外。 */
  remove(taskId: string): void {
    if (validLogId(taskId)) rmSync(join(this.root, taskId), { recursive: true, force: true });
  }

  /** 保存したセッション。無ければ undefined、読めない・形が違えば "broken"。 */
  read(taskId: string): StoredOrchestratorSession | "broken" | undefined {
    const dir = this.dir(taskId);
    if (!dir) return undefined;
    let text: string;
    try {
      text = readFileSync(join(dir, "session.json"), "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "broken";
    }
    try {
      const parsed = StoredSession.safeParse(JSON.parse(text));
      if (!parsed.success || !validLogId(parsed.data.runId)) return "broken";
      if (!parsed.data.files.every((f) => safeRelativePath(f.path))) return "broken";
      return parsed.data;
    } catch {
      return "broken";
    }
  }

  /**
   * 再開できるかを決める。同じエージェント（AI の種類と ID）のセッションがあり、ファイルが記録どおりにそろっていれば
   * 再開する。そうでなければ、新しく始める理由を返す。
   */
  async plan(
    taskId: string,
    agent: { agentId: string; runtime: AgentSessionRuntime },
  ): Promise<OrchestratorSessionPlan> {
    const stored = this.read(taskId);
    const dir = this.dir(taskId);
    if (stored === undefined || !dir) return { mode: "new", reason: "first" };
    if (stored === "broken") return { mode: "new", reason: "files_broken" };
    const filesDir = join(dir, "generations", stored.runId, "files");
    if (stored.agentId !== agent.agentId || stored.runtime !== agent.runtime) {
      // 別のエージェントのセッションは再開できないので、やり取りを引き継いで新しく始める。本体のファイルが記録どおりなら
      // 引き継ぐ（間を省いたものも、残った発言を引き継ぐ）
      const main = sessionMainFile(stored.runtime, stored.sessionId, stored.files);
      const recorded = main ? stored.files.filter((f) => f.path === main) : [];
      const checked = main ? await checkArchivedFiles(filesDir, recorded) : [];
      const mainFile = main && archivedFilePath(filesDir, main);
      return {
        mode: "new",
        reason: "agent_changed",
        ...(mainFile && checked.length > 0 && checked.every((f) => f.status === "match")
          ? {
              handoff: {
                agentId: stored.agentId,
                runtime: stored.runtime,
                sessionId: stored.sessionId,
                mainFile,
              },
            }
          : {}),
      };
    }
    // 上限で間を省いたファイルは、そのまま戻しても再開できない
    if (stored.files.some((f) => f.truncated)) return { mode: "new", reason: "truncated" };
    if (!sessionMainFile(stored.runtime, stored.sessionId, stored.files)) {
      return { mode: "new", reason: "files_broken" };
    }
    const checked = await checkArchivedFiles(filesDir, stored.files);
    if (!checked.every((f) => f.status === "match")) return { mode: "new", reason: "files_broken" };
    return { mode: "resume", sessionId: stored.sessionId, filesDir };
  }

  /**
   * 実行の後に写したファイル（sourceDir。PBI-66 の runs/<タスク>/<実行>/agent）を、タスクのセッションとして保存する。
   * 記録したハッシュと一致するものだけを写し、写し終えてから session.json を置き換える。
   */
  async save(
    taskId: string,
    input: {
      agentId: string;
      runtime: AgentSessionRuntime;
      sessionId: string | undefined;
      runId: string;
      sourceDir: string;
      files: readonly ArchivedAgentFile[];
    },
  ): Promise<SaveResult> {
    const dir = this.dir(taskId);
    if (!dir || !validLogId(input.runId)) return { saved: false, notSaved: "copy_failed" };
    if (!input.sessionId || !validSessionId(input.sessionId)) {
      return { saved: false, notSaved: "no_session" };
    }
    if (!sessionMainFile(input.runtime, input.sessionId, input.files)) {
      return { saved: false, notSaved: "session_missing" };
    }
    const previous = this.read(taskId);
    const generation = join(dir, "generations", input.runId);
    try {
      rmSync(generation, { recursive: true, force: true });
      const filesDir = join(generation, "files");
      mkdirSync(filesDir, { recursive: true, mode: 0o700 });
      for (const file of input.files) {
        // 写した場所の外・リンクは辿らない
        const source = archivedFilePath(input.sourceDir, file.path);
        if (!source) throw new Error(`${file.path}: not found`);
        const dest = join(filesDir, ...file.path.split("/"));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        copyFileSync(source, dest);
        const hashed = await hashFile(dest);
        if (!hashed || hashed.sha256 !== file.sha256 || hashed.bytes !== file.bytes) {
          throw new Error(`${file.path}: does not match the recorded hash`);
        }
      }
      const stored: StoredOrchestratorSession = {
        version: 1,
        agentId: input.agentId,
        runtime: input.runtime,
        sessionId: input.sessionId,
        runId: input.runId,
        savedAt: new Date().toISOString(),
        files: [...input.files],
      };
      const temp = join(dir, `session.json.tmp-${process.pid}-${input.runId}`);
      writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, join(dir, "session.json"));
    } catch (error) {
      console.warn(
        `[daemon] オーケストレーターのセッションを保存できませんでした（${taskId}）：`,
        error instanceof Error ? error.message : error,
      );
      rmSync(generation, { recursive: true, force: true });
      return { saved: false, notSaved: "copy_failed" };
    }
    // いまのものと、その1つ前（読んでいる途中の複製があるかもしれない）だけを残す
    const keep = new Set([
      input.runId,
      ...(previous && previous !== "broken" ? [previous.runId] : []),
    ]);
    try {
      for (const name of readdirSync(join(dir, "generations"))) {
        if (!keep.has(name))
          rmSync(join(dir, "generations", name), { recursive: true, force: true });
      }
    } catch {
      // 消せなくても、保存はできている
    }
    return { saved: true };
  }
}
