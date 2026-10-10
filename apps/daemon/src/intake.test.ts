import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import type { FoundIssue, IssueSearch } from "./github.js";
import { IssueIntake } from "./intake.js";
import { SqliteLedgerStore } from "./ledger.js";
import { MemoryProjectStore } from "./projects.js";
import { buildPullRequestBody } from "./prompts.js";
import { MemorySecretStore } from "./secrets.js";
import { TaskService } from "./service.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-intake-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error("unused")) });

const config =
  (github: boolean): (() => ConfigResult) =>
  () => ({
    ok: true,
    config: {
      image: "img",
      budgetPerTaskUsd: 1,
      defaultAgent: { id: "stub", runtime: "stub", auth: { mode: "stub" } } as never,
      guardianAgent: { id: "stub", runtime: "stub", auth: { mode: "stub" } } as never,
      ...(github ? { github: { tokenSecret: "github-token", pollIntervalSec: 300 } } : {}),
    },
  });

class FakeSearch implements IssueSearch {
  queries: string[] = [];
  /** 検索ごとに渡された、どこまで読んだか。 */
  sinces: (string | undefined)[] = [];
  /** 返す、どこまで読んだか。 */
  cursor?: string;
  rateLimited = false;
  fail?: string;
  /** この条件の検索だけ失敗させる。 */
  failQuery?: string;
  constructor(private readonly issues: FoundIssue[]) {}
  async search(query: string, token: string, since?: string) {
    if (this.fail || query === this.failQuery) {
      throw new Error(`${this.fail ?? "Issue を検索できませんでした：GitHub API 422"} ${token}`);
    }
    this.queries.push(query);
    this.sinces.push(since);
    return {
      issues: this.issues.filter((i) => query.includes(`repo:${i.repo}`)),
      cursor: this.cursor,
      ...(this.rateLimited ? { rateLimited: true, incomplete: "レート制限" } : {}),
    };
  }
}

function setup(github = true) {
  const ledger = new SqliteLedgerStore(join(dir, "sacty.db"));
  const service = new TaskService({
    ledger,
    config: config(github),
    secrets: new MemorySecretStore({ "github-token": "ghp_secret" }),
    executor: unused as AgentExecutor,
    repos: unused as never,
    tests: unused as never,
    pulls: unused as never,
    projects: new MemoryProjectStore(),
    workspaceRoot: join(dir, "workspaces"),
  });
  service.saveProject(undefined, {
    name: "決済",
    sources: [{ scope: "repo", target: "acme/payments", label: "sacty" }],
  });
  const search = new FakeSearch([
    {
      repo: "acme/payments",
      number: 7,
      title: "冪等性キー",
      body: "本文",
      url: "https://github.com/acme/payments/issues/7",
      labels: ["sacty"],
    },
  ]);
  let now = 1_000_000;
  const intake = new IssueIntake(
    service,
    search,
    new MemorySecretStore({ "github-token": "ghp_secret" }),
    config(github),
    () => now,
  );
  return { ledger, service, search, intake, advance: (ms: number) => (now += ms) };
}

describe("GitHub Issue の定期的な取り込み（PBI-5a）", () => {
  it("間隔ごとに取り込み元を検索してタスクにし、状況を記録する", async () => {
    const { ledger, service, search, intake, advance } = setup();
    await intake.tick();
    expect(search.queries).toEqual(['is:issue is:open repo:acme/payments label:"sacty"']);
    expect(service.list().map((t) => t.title)).toEqual(["冪等性キー"]);
    expect(service.status().intake).toMatchObject({ imported: 1 });

    await intake.tick(); // 間隔が来ていない
    expect(search.queries).toHaveLength(1);
    advance(300_000);
    await intake.tick();
    expect(search.queries).toHaveLength(2);
    expect(service.list()).toHaveLength(1); // 二重に取り込まない
    expect(service.status().intake).toMatchObject({ imported: 0 });
    ledger.close();
  });

  it("失敗は理由を記録し、トークンは残さない。設定が無ければ取り込まない", async () => {
    const failing = setup();
    failing.search.fail = "Issue を検索できませんでした：GitHub API 401";
    await failing.intake.tick(true);
    const error = failing.service.status().intake?.errors?.[0]?.message ?? "";
    expect(error).toContain("GitHub API 401");
    expect(error).not.toContain("ghp_secret");
    failing.ledger.close();
    rmSync(join(dir, "sacty.db"), { force: true });

    const off = setup(false);
    await off.intake.tick(true);
    expect(off.search.queries).toEqual([]);
    expect(off.service.status().intake).toBeNull();
    off.ledger.close();
  });

  it("1つの取り込み元の検索に失敗しても、ほかの取り込み元は取り込む（レビュー指摘）", async () => {
    const { ledger, service, search, intake } = setup();
    service.saveProject(undefined, {
      name: "削除されたリポジトリ",
      sources: [{ scope: "repo", target: "acme/deleted", label: "sacty" }],
    });
    search.failQuery = 'is:issue is:open repo:acme/deleted label:"sacty"';
    await intake.tick(true);
    expect(service.list().map((t) => t.source?.repo)).toEqual(["acme/payments"]);
    const status = service.status().intake;
    expect(status?.imported).toBe(1);
    expect(status?.errors).toEqual([
      {
        query: 'is:issue is:open repo:acme/deleted label:"sacty"',
        message: "Issue を検索できませんでした：GitHub API 422 [REDACTED]",
      },
    ]);
    ledger.close();
  });

  it("読んだところから次の取り込みを続け、レート制限ならその回のほかの検索をやめる（レビュー指摘）", async () => {
    const { ledger, service, search, intake, advance } = setup();
    service.saveProject(undefined, {
      name: "認証",
      sources: [{ scope: "repo", target: "acme/auth", label: "sacty" }],
    });
    search.cursor = "2026-10-10T00:00:00Z";
    search.rateLimited = true;
    await intake.tick(true);
    expect(search.queries).toHaveLength(1); // 1つ目でレート制限になり、2つ目は検索しない
    expect(service.status().intake?.errors?.map((e) => e.message)).toEqual([
      "レート制限",
      "レート制限のため、次の取り込みで検索します。",
    ]);

    search.rateLimited = false;
    advance(300_000);
    await intake.tick();
    expect(search.sinces).toEqual([undefined, "2026-10-10T00:00:00Z", undefined]);

    // プロジェクトの設定が変わったら、先頭から読み直す
    service.saveProject(undefined, { name: "請求" });
    advance(300_000);
    await intake.tick();
    expect(search.sinces.slice(-2)).toEqual([undefined, undefined]);
    ledger.close();
  });

  it("Issue から作ったタスクの PR は、マージで Issue を閉じる", async () => {
    const { ledger, service, intake } = setup();
    await intake.tick();
    const task = service.list()[0];
    if (!task) throw new Error("no task");
    expect(buildPullRequestBody(task)).toContain("Closes #7");
    ledger.close();
  });
});
