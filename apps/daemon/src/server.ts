import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { isFinished, issueMessage, ProjectDefinition } from "@sacty/core";
import { type Context, Hono } from "hono";
import { ZodError, z } from "zod";
import { safeRelativePath } from "./agent-sessions.js";
import { type AuditService, NoAuditService } from "./audits.js";
import { MemoryScheduleStore, ScheduledTasks } from "./schedules.js";
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

/** コンテキストのプレビューの AI の種類（PBI-76）。省けば Claude Code。 */
const PreviewRuntime = z.enum(["claude-code", "codex"]).default("claude-code");
/** 保存していない設定でのプレビュー（PBI-76）。definition を省けば、保存した設定で作る。 */
const PreviewRequest = z
  .object({ runtime: PreviewRuntime, definition: ProjectDefinition.optional() })
  .strict();

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
  options: {
    intake?: { tick(force: boolean): Promise<void> };
    audits?: AuditService;
    schedules?: ScheduledTasks;
  } = {},
) {
  const app = new Hono();
  // 完了したタスクの監査（PBI-124）。渡されなければ監査の無い実装（モックは main.ts が切り替える）
  const audits =
    options.audits ??
    new NoAuditService({
      tasks: () => service.list(),
      activity: (id) => service.get(id)?.activity ?? [],
      projects: () => service.listProjects(),
      defaultCapUsd: () => service.auditBudgetUsd(),
    });

  // スケジュールタスク。渡されなければ、メモリーに持つ（テスト用。main.ts は SQLite に保存する）
  const schedules =
    options.schedules ?? new ScheduledTasks({ store: new MemoryScheduleStore(), tasks: service });

  /**
   * 保存したプロジェクトの秘密情報（コンテキスト）を、まとめて取り出す（PBI-107）。保存は止めないので待たない
   * （1Password の承認を待つことがある）。取り出せなかったものは、画面の警告に出る。
   */
  const prefetchProjectSecrets = (id: string) => {
    service.prefetchProjectSecrets(id).catch((error: unknown) => {
      console.warn(
        "[daemon] プロジェクトの秘密情報を取り出せませんでした：",
        error instanceof Error ? error.message : error,
      );
    });
  };

  /** 保存した sacty の設定の秘密情報（通知先。PBI-115）を取り出す。プロジェクトと同じく待たない。 */
  const prefetchSettingsSecrets = () => {
    service.prefetchSettingsSecrets().catch((error: unknown) => {
      console.warn(
        "[daemon] sacty の設定の秘密情報を取り出せませんでした：",
        error instanceof Error ? error.message : error,
      );
    });
  };

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

  // ダッシュボードの集計（対応待ちの時刻・費用・流量・品質・待ち行列。PBI-118）。畳み込んで持つ記録から作るので軽い
  app.get("/api/dashboard", (c) => c.json(service.dashboard()));

  // gh にログイン済みの GitHub のアカウント（プロジェクトの設定で選ぶ。PBI-13）。トークンは返さない
  app.get("/api/github/accounts", async (c) => c.json(await service.githubAccounts()));

  // ?open=1 なら、終わっていないタスクだけ（ダッシュボードとヘッダーが3秒ごとに取るので、完了したタスクの成果物を毎回
  // 送らない。PBI-114）
  app.get("/api/tasks", (c) => {
    const tasks = service.list();
    return c.json({
      tasks: c.req.query("open") === "1" ? tasks.filter((t) => !isFinished(t)) : tasks,
    });
  });

  // 消したプロジェクトのタスクは、無いものとして返す（タスクと作業履歴は残すが、画面には出さない）
  app.get("/api/tasks/:id", (c) => {
    const id = c.req.param("id");
    const found = service.visibleTask(id) ? service.get(id) : undefined;
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  });

  // エージェントの実行のセッションログ（PBI-62）。タスクごとの場所から読むので、ほかのタスクの実行は読めない
  app.get("/api/tasks/:id/runs/:runId/log", (c) => {
    const { id, runId } = c.req.param();
    if (!validLogId(id) || !validLogId(runId)) return c.json({ error: "invalid_id" }, 400);
    if (!service.visibleTask(id)) return c.json({ error: "not_found" }, 404);
    // ?eventsFrom=&stderrFrom=（バイト）で、実行中は足された分だけを返す（PR #119 レビュー指摘）
    const offset = (name: string) => {
      const value = Number(c.req.query(name));
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    };
    const eventsFrom = offset("eventsFrom");
    const stderrFrom = offset("stderrFrom");
    const log = service.sessionLog(id, runId, {
      ...(eventsFrom !== undefined ? { events: eventsFrom } : {}),
      ...(stderrFrom !== undefined ? { stderr: stderrFrom } : {}),
    });
    return log ? c.json(log) : c.json({ error: "not_found" }, 404);
  });

  // セッションログの生のファイル（events：途中の出来事の JSONL、stderr：標準エラー出力）
  app.get("/api/tasks/:id/runs/:runId/files/:file", (c) => {
    const { id, runId, file } = c.req.param();
    if (!validLogId(id) || !validLogId(runId) || (file !== "events" && file !== "stderr")) {
      return c.json({ error: "invalid_id" }, 400);
    }
    if (!service.visibleTask(id)) return c.json({ error: "not_found" }, 404);
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
    if (!service.visibleTask(id)) return c.json({ error: "not_found" }, 404);
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
    if (!service.visibleTask(id)) return c.json({ error: "not_found" }, 404);
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
      const settings = service.saveSettings(json.body);
      prefetchSettingsSecrets();
      return c.json({ settings });
    } catch (error) {
      return handleError(c, error);
    }
  });

  /** sacty の設定の通知先に、テストの通知を送る（PBI-38。PBI-115 でプロジェクトから移した）。 */
  app.post("/api/settings/notification-test", async (c) => {
    try {
      await service.testNotification();
      return c.json({ ok: true });
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

  // コンテキストの合成の結果のプレビュー（PBI-76）。GET は保存した設定で、POST は送った（保存していない）設定で作る。
  // 取得・設定の誤りは、200 で error（秘密情報を伏せた理由）を返す
  app.get("/api/projects/:id/context-preview", async (c) => {
    try {
      const runtime = PreviewRuntime.parse(c.req.query("runtime"));
      const result = await service.projectContextPreview(c.req.param("id"), runtime);
      if (!result) return c.json({ error: "not_found" }, 404);
      return c.json(result);
    } catch (error) {
      return handleError(c, error);
    }
  });
  app.post("/api/projects/:id/context-preview", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      const { runtime, definition } = PreviewRequest.parse(json.body);
      const result = await service.projectContextPreview(c.req.param("id"), runtime, definition);
      if (!result) return c.json({ error: "not_found" }, 404);
      return c.json(result);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/projects", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      const project = service.saveProject(undefined, json.body);
      prefetchProjectSecrets(project.id);
      // 保存したコンテキストを、プレビューと同じ検査で確かめる（誤りは保存を止めず、知らせる。PBI-76）
      const contextError = await service.checkProjectContext(project.id);
      return c.json({ project, ...(contextError ? { contextError } : {}) }, 201);
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
      const project = service.importProject(json.body);
      prefetchProjectSecrets(project.id);
      return c.json({ project }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.put("/api/projects/:id", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      const project = service.saveProject(c.req.param("id"), json.body);
      prefetchProjectSecrets(project.id);
      // 保存したコンテキストを、プレビューと同じ検査で確かめる（誤りは保存を止めず、知らせる。PBI-76）
      const contextError = await service.checkProjectContext(project.id);
      return c.json({ project, ...(contextError ? { contextError } : {}) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // プロジェクトの削除（プロジェクトの設定の「危険な操作」）。終わっていないタスクがあれば 409 で理由を返す
  app.delete("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    if (!service.getProject(id)) return c.json({ error: "not_found" }, 404);
    try {
      service.deleteProject(id);
      // プロジェクトのスケジュールタスクも消す（作ったタスクは、ほかのタスクと同じく残す）
      schedules.deleteForProject(id);
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // スケジュールタスク（プロジェクトごと）。プロジェクトが無ければ 404
  app.get("/api/projects/:id/schedules", (c) => {
    const found = schedules.list(c.req.param("id"));
    return found ? c.json({ schedules: found }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/api/projects/:id/schedules", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ schedule: schedules.create(c.req.param("id"), json.body) }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // スケジュールタスクと、それが作ったタスク
  app.get("/api/schedules/:id", (c) => {
    const found = schedules.get(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  });

  app.put("/api/schedules/:id", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ schedule: schedules.update(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.delete("/api/schedules/:id", (c) => {
    try {
      schedules.delete(c.req.param("id"));
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

  // 中止したタスクを、最初からやり直す（再実行）。元のタスクを引き継いだ新しいタスクを作る
  app.post("/api/tasks/:id/rerun", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.rerunTask(c.req.param("id"), json.body) }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 承認したセキュリティチェックのレポートの指摘（区分ごとの対応のタスクを作る画面に出す）。レポートでなければ空
  app.get("/api/tasks/:id/security-findings", (c) => {
    const id = c.req.param("id");
    if (!service.visibleTask(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ findings: service.securityFindings(id) });
  });

  // 承認したセキュリティチェックのレポートの区分から、セキュリティ対応のタスクを作る（区分ごとに1回だけ）
  app.post("/api/tasks/:id/security-fixes", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.requestSecurityFix(c.req.param("id"), json.body) }, 201);
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

  // タスクの詳細で、工程のエージェントを変える（PBI-121）。その工程を次に実行するときから使う
  app.post("/api/tasks/:id/agents", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.changeStepAgent(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // タスクの詳細で、工程のイメージを変える（PBI-106）。その工程を次に実行するときから使う
  app.post("/api/tasks/:id/images", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ task: service.changeStepImage(c.req.param("id"), json.body) });
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
    const { total, fetched, unreadContexts, problems } = await service.prefetchSecrets({
      fresh: true,
    });
    return c.json({ total, fetched, unreadContexts, problems });
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

  // 完了したタスクの監査（PBI-124）。監査が無ければ audit は null
  app.get("/api/tasks/:id/audit", async (c) =>
    c.json({ audit: await audits.taskAudit(c.req.param("id")) }),
  );

  app.post("/api/tasks/:id/audit/resume", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ audit: await audits.resume(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // プロジェクトの監査の画面（PBI-124）。プロジェクトをまたいで集約しない
  app.get("/api/projects/:id/audits", async (c) => {
    const found = await audits.projectAudits(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  });

  // ダッシュボードの監査の指標（件数だけ。PBI-124）
  app.get("/api/audits/dashboard", (c) => c.json(audits.dashboard()));

  app.post("/api/audits/proposals/:id/adopt", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ proposal: await audits.adopt(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/api/audits/proposals/:id/reject", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    try {
      return c.json({ proposal: await audits.reject(c.req.param("id"), json.body) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 監査が登録したメモリーを、人が消す（PBI-126）。登録はできない
  app.post("/api/audits/memories/:id/delete", async (c) => {
    try {
      return c.json({ audit: await audits.deleteMemory(c.req.param("id")) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return app;
}
