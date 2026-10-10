import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteLedgerStore } from "./ledger.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-test-"));
  dbPath = join(dir, "sacty.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("台帳", () => {
  it("UPDATEとDELETEを拒否する", () => {
    const ledger = new SqliteLedgerStore(dbPath);
    new TaskService(ledger).createTicket({ title: "A" });
    expect(() => ledger.rawExecForTest("UPDATE ledger SET type = 'x'")).toThrow(/append-only/);
    expect(() => ledger.rawExecForTest("DELETE FROM ledger")).toThrow(/append-only/);
    expect(ledger.all()).toHaveLength(2);
    ledger.close();
  });

  it("再起動しても同じ状態を復元する", () => {
    const first = new SqliteLedgerStore(dbPath);
    const created = new TaskService(first).createTicket({ title: "A", body: "B" });
    first.close();

    const second = new SqliteLedgerStore(dbPath);
    const restored = new TaskService(second).get(created.id);
    expect(restored?.task).toEqual(created);
    expect(restored?.ledger.map((e) => e.type)).toEqual(["TaskCreated", "StepsChosen"]);
    second.close();
  });
});

describe("API", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };

  it("トークンがないと401を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(new TaskService(ledger), token);
    expect((await app.request("/api/tasks")).status).toBe(401);
    expect(
      (await app.request("/api/tasks", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    ledger.close();
  });

  it("チケットを作ると、一覧と詳細（台帳つき）に現れる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(new TaskService(ledger), token);

    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "  決済APIの設計  ", body: "冪等性キーを扱う" }),
    });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { id: string; title: string } };
    expect(task.title).toBe("決済APIの設計");

    const list = (await (await app.request("/api/tasks", { headers: auth })).json()) as {
      tasks: { id: string }[];
    };
    expect(list.tasks.map((t) => t.id)).toEqual([task.id]);

    const detail = (await (
      await app.request(`/api/tasks/${task.id}`, { headers: auth })
    ).json()) as {
      ledger: { type: string; actor: string }[];
    };
    expect(detail.ledger.map((e) => [e.type, e.actor])).toEqual([
      ["TaskCreated", "person"],
      ["StepsChosen", "sacty"],
    ]);
    ledger.close();
  });

  it("タイトルが空なら400を返し、台帳に何も書かない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(new TaskService(ledger), token);
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(ledger.all()).toHaveLength(0);
    ledger.close();
  });

  it("存在しないタスクは404を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(new TaskService(ledger), token);
    expect((await app.request("/api/tasks/nope", { headers: auth })).status).toBe(404);
    ledger.close();
  });
});
