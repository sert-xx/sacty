import { timingSafeEqual } from "node:crypto";
import { issueMessage } from "@sacty/core";
import { type Context, Hono } from "hono";
import { ZodError } from "zod";
import { InvalidOperationError, type TaskService } from "./service.js";

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

  // 再レビュー（PBI-44）
  app.post("/api/tasks/:id/rereview", (c) => {
    try {
      return c.json({ task: service.rereview(c.req.param("id")) });
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
