import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { TaskService } from "./service.js";

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * デーモンのAPI。呼び出せるのはNext.jsのサーバーだけで、
 * CLIが起動のたびに生成するトークンを必須にする。
 */
export function createApp(service: TaskService, token: string) {
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

  app.get("/api/tasks", (c) => c.json({ tasks: service.list() }));

  app.get("/api/tasks/:id", (c) => {
    const found = service.get(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  });

  app.post("/api/tickets", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    try {
      return c.json({ task: service.createTicket(body) }, 201);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_input", issues: error.issues }, 400);
      }
      throw error;
    }
  });

  return app;
}
