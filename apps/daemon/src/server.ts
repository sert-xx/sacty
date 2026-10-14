import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { issueMessage } from "@sacty/core";
import { type Context, Hono } from "hono";
import { ZodError } from "zod";
import { safeRelativePath } from "./agent-sessions.js";
import { InvalidOperationError, type TaskService } from "./service.js";
import { validLogId } from "./session-logs.js";

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function handleError(c: Context, error: unknown) {
  if (error instanceof ZodError) {
    // 誤りは文言のコードと引数にして返し、画面が画面の言語の文言にする（PBI-11）
    return c.json(
      {
        error: "invalid_input",
        issues: error.issues.map((issue) => ({ path: issue.path, message: issueMessage(issue) })),
      },
      400,
    );
  }
  if (error instanceof InvalidOperationError) {
    // 理由は文言のコードと引数で返し、画面が画面の言語の文言にする（PBI-11）
    return c.json({ error: "invalid_operation", messages: error.messages }, 409);
  }
  throw error;
}

/**
 * デーモンのAPI。呼び出せるのはNext.jsのサーバーだけで、
 * CLIが起動のたびに生成するトークンを必須にする。
 */
export function createApp(
  service: TaskService,
  token: string,
  options: { intake?: { tick(force: boolean): Promise<void> } } = {},
) {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!given || !sameToken(given, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/status", (c) => c.json(service.status()));

  // gh にログイン済みの GitHub のアカウント（プロジェクトの設定で選ぶ。PBI-13）。トークンは返さない
  app.get("/api/github/accounts", async (c) => c.json(await service.githubAccounts()));

  app.get("/api/tasks", (c) => c.json({ tasks: service.list() }));

  app.get("/api/tasks/:id", (c) => {
    const found = service.get(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  });

  // エージェントの実行のセッションログ（PBI-62）。タスクごとの場所から読むので、ほかのタスクの実行は読めない
  app.get("/api/tasks/:id/runs/:runId/log", (c) => {
    const { id, runId } = c.req.param();
    if (!validLogId(id) || !validLogId(runId)) return c.json({ error: "invalid_id" }, 400);
    const log = service.sessionLog(id, runId);
    return log ? c.json(log) : c.json({ error: "not_found" }, 404);
  });

  // セッションログの生のファイル（events：途中の出来事の JSONL、stderr：標準エラー出力）
  app.get("/api/tasks/:id/runs/:runId/files/:file", (c) => {
    const { id, runId, file } = c.req.param();
    if (!validLogId(id) || !validLogId(runId) || (file !== "events" && file !== "stderr")) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const path = service.sessionLogFile(id, runId, file);
    if (!path) return c.json({ error: "not_found" }, 404);
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "content-type":
          file === "events" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8",
      },
    });
  });

  // 写したエージェントの元のファイルの一覧と、作業履歴に記録したハッシュとの一致（PBI-66）
  app.get("/api/tasks/:id/runs/:runId/agent-files", async (c) => {
    const { id, runId } = c.req.param();
    if (!validLogId(id) || !validLogId(runId)) return c.json({ error: "invalid_id" }, 400);
    const files = await service.agentSessionFiles(id, runId);
    return files ? c.json(files) : c.json({ error: "not_found" }, 404);
  });

  // 写したエージェントの元のファイル1つ（path は一覧の相対パス。作業履歴に記録したものだけを返す）
  app.get("/api/tasks/:id/runs/:runId/agent-files/raw", (c) => {
    const { id, runId } = c.req.param();
    const path = c.req.query("path") ?? "";
    if (!validLogId(id) || !validLogId(runId) || !safeRelativePath(path)) {
      return c.json({ error: "invalid_id" }, 400);
    }
    const file = service.agentSessionFile(id, runId, path);
    if (!file) return c.json({ error: "not_found" }, 404);
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "content-type": path.endsWith(".jsonl")
          ? "application/x-ndjson; charset=utf-8"
          : "application/octet-stream",
      },
    });
  });

  app.get("/api/projects", (c) => c.json({ projects: service.listProjects() }));

  app.get("/api/projects/:id", (c) => {
    const view = service.getProject(c.req.param("id"));
    if (!view) return c.json({ error: "not_found" }, 404);
    return c.json(view);
  });

  // sacty 全体の設定（取り込むラベルなど。PBI-26）
  app.get("/api/settings", (c) => c.json({ settings: service.getSettings() }));
  app.put("/api/settings", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ settings: service.saveSettings(json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // タスクの対象リポジトリの候補（プロジェクトの対象から。PBI-25）
  app.get("/api/projects/:id/repositories", async (c) => {
    const result = await service.projectRepositories(c.req.param("id"));
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json(result);
  });

  // プロジェクトで使える外部 PF（ホストの PF と、プロジェクトのコンテキストの PF。秘密情報は含めない。PBI-74）
  app.get("/api/projects/:id/platforms", async (c) => {
    const result = await service.projectPlatforms(c.req.param("id"));
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json(result);
  });

  app.post("/api/projects", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ project: service.saveProject(undefined, json.body) }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get("/api/projects/:id/export", (c) => {
    const exported = service.exportProject(c.req.param("id"));
    if (!exported) return c.json({ error: "not_found" }, 404);
    return c.json(exported);
  });

  app.post("/api/projects/import", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ project: service.importProject(json.body) }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.put("/api/projects/:id", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ project: service.saveProject(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  /** プロジェクトの通知先に、テストの通知を送る（PBI-38）。 */
  app.post("/api/projects/:id/notification-test", async (c) => {
    try {
      await service.testNotification(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  /** GitHub Issue の取り込みを、間隔を待たずに実行する。 */
  app.post("/api/intake/run", async (c) => {
    if (!options.intake) return c.json({ error: "not_configured" }, 409);
    await options.intake.tick(true);
    return c.json({ status: service.status().intake });
  });

  app.post("/api/tasks", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.createTask(json.body) }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/tasks/:id/approve", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.approve(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/tasks/:id/request-changes", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.requestChanges(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/tasks/:id/remarks/:remarkId/void", (c) => {
    try {
      return c.json({ task: service.voidRemark(c.req.param("id"), c.req.param("remarkId")) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/tasks/:id/proposals/:proposalId/decide", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({
        task: service.decideChange(c.req.param("id"), c.req.param("proposalId"), json.body),
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/tasks/:id/pause", async (c) => {
    try {
      return c.json({ task: await service.pause(c.req.param("id")) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get("/api/tasks/:id/cleanup-plan", (c) => {
    const plan = service.cleanupPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "not_found" }, 404);
    return c.json({ plan });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    try {
      return c.json({ task: await service.cancel(c.req.param("id")) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // チケットから取り込んだタスク（PBI-52）・リポジトリを指定せずに作ったタスク（PBI-73）の、作業するリポジトリを人が選ぶ
  app.post("/api/tasks/:id/repository", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    const repo = (json.body as { repo?: unknown } | undefined)?.repo;
    if (typeof repo !== "string") return c.json({ error: "invalid_repo" }, 400);
    try {
      return c.json({ task: await service.chooseRepository(c.req.param("id"), repo) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // タスクの詳細で、オーケストレーターに質問する（PBI-54）。答えは待たずに返す（画面は答えが出るまで更新する）
  app.post("/api/tasks/:id/questions", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.askQuestion(c.req.param("id"), json.body).task }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 再レビュー（PBI-44）
  app.post("/api/tasks/:id/rereview", (c) => {
    try {
      return c.json({ task: service.rereview(c.req.param("id")) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 書き出せなかった承認済みの成果を、書き出し直す（PBI-56）。書き出しは待たずに返す
  app.post("/api/tasks/:id/exports/:step/retry", (c) => {
    try {
      return c.json({ task: service.retryExport(c.req.param("id"), c.req.param("step")) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 秘密情報を取り出し直す（PBI-48）。値は返さない
  app.post("/api/secrets/prefetch", async (c) => {
    const { total, problems } = await service.prefetchSecrets({ fresh: true });
    return c.json({ total, problems });
  });

  app.post("/api/tasks/:id/resume", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      const id = c.req.param("id");
      // 一時停止のときに停止を確かめられなかったコンテナがあれば、確かめ直してから再開する
      const containersConfirmed = await service.confirmPausedContainers(id);
      return c.json({ task: service.resume(id, json.body, { containersConfirmed }) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return app;
}
