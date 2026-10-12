import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, parseRepoUrl, renderMessage } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import { MessageError } from "./errors.js";
import type { GitHubAuth } from "./gh.js";
import type { FoundIssue, IssueSearch } from "./github.js";
import { IssueIntake } from "./intake.js";
import { MemoryProjectStore } from "./projects.js";
import { buildPullRequestBody } from "./prompts.js";
import { MemorySecretStore } from "./secrets.js";
import { TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";

/** 記録した文言（コードと引数）を、日本語の文にする（PBI-11）。 */
const ja = (text: unknown) => renderMessage(text, "ja");

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
      ...(github ? { github: { pollIntervalSec: 300 } } : {}),
    },
  });

class FakeSearch implements IssueSearch {
  queries: string[] = [];
  /** 検索ごとに使われたトークン。 */
  tokens: string[] = [];
  /** 検索ごとに渡された、どこまで読んだか。 */
  sinces: (string | undefined)[] = [];
  /** 返す、どこまで読んだか。 */
  cursor?: string;
  rateLimited = false;
  fail?: string;
  /** この条件の検索だけ失敗させる。 */
  failQuery?: string;
  /** 検索ごとのホスト（PBI-40）。 */
  hosts: string[] = [];
  constructor(readonly issues: FoundIssue[]) {}
  async search(host: string, query: string, token: string, since?: string) {
    if (this.fail || query === this.failQuery) {
      throw new Error(`${this.fail ?? "Issue を検索できませんでした：GitHub API 422"} ${token}`);
    }
    this.hosts.push(host);
    this.queries.push(query);
    this.tokens.push(token);
    this.sinces.push(since);
    return {
      issues: this.issues.filter((i) => {
        const repo = parseRepoUrl(i.repo);
        return repo?.host === host && query.includes(`repo:${repo.path}`);
      }),
      cursor: this.cursor,
      ...(this.rateLimited ? { rateLimited: true, incomplete: "レート制限" } : {}),
    };
  }
}

/** gh の偽物。ログイン済みのアカウントごとのトークンを返す。 */
class FakeGh implements GitHubAuth {
  requested: string[] = [];
  constructor(public tokens: Record<string, string> = { me: "ghp_secret" }) {}
  async accounts() {
    return [];
  }
  /** github.com のアカウントは名前だけ、ほかのホストは「ホスト/名前」で持つ。 */
  async token(host: string, account: string) {
    const key = host === "github.com" ? account : `${host}/${account}`;
    this.requested.push(key);
    const token = this.tokens[key];
    if (!token) throw new MessageError(message("github.accountUnavailable", { account, host }));
    return token;
  }
}

function setup(github = true, gh = new FakeGh()) {
  const activity = new SqliteActivityStore(join(dir, "sacty.db"));
  const service = new TaskService({
    activity,
    config: config(github),
    secrets: new MemorySecretStore({}),
    executor: unused as AgentExecutor,
    repos: unused as never,
    tests: unused as never,
    pulls: unused as never,
    projects: new MemoryProjectStore(),
    // 取り込むラベル（sacty の設定。PBI-26）
    settings: new MemorySettingsStore({ intakeLabel: "sacty" }),
    github: unused as never,
    workspaceRoot: join(dir, "workspaces"),
  });
  service.saveProject(undefined, {
    name: "決済",
    githubAccounts: { "github.com": "me" },
    targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
  });
  const search = new FakeSearch([
    {
      repo: "https://github.com/acme/payments",
      number: 7,
      title: "冪等性キー",
      body: "本文",
      url: "https://github.com/acme/payments/issues/7",
      labels: ["sacty"],
    },
  ]);
  let now = 1_000_000;
  const intake = new IssueIntake(service, search, gh, config(github), () => now);
  return { activity, service, search, intake, gh, advance: (ms: number) => (now += ms) };
}

describe("GitHub Issue の定期的な取り込み（PBI-5a）", () => {
  it("間隔ごとに取り込み元を検索してタスクにし、状況を記録する", async () => {
    const { activity, service, search, intake, advance } = setup();
    await intake.tick();
    expect(search.queries).toEqual(['is:open repo:acme/payments label:"sacty"']);
    expect(service.list().map((t) => t.title)).toEqual(["冪等性キー"]);
    expect(service.status().intake).toMatchObject({ imported: 1 });

    await intake.tick(); // 間隔が来ていない
    expect(search.queries).toHaveLength(1);
    advance(300_000);
    await intake.tick();
    expect(search.queries).toHaveLength(2);
    expect(service.list()).toHaveLength(1); // 二重に取り込まない
    expect(service.status().intake).toMatchObject({ imported: 0 });
    activity.close();
  });

  it("失敗は理由を記録し、トークンは残さない。設定が無ければ取り込まない", async () => {
    const failing = setup();
    failing.search.fail = "Issue を検索できませんでした：GitHub API 401";
    await failing.intake.tick(true);
    const error = failing.service.status().intake?.errors?.[0]?.message ?? "";
    expect(error).toContain("GitHub API 401");
    expect(error).not.toContain("ghp_secret");
    failing.activity.close();
    rmSync(join(dir, "sacty.db"), { force: true });

    const off = setup(false);
    await off.intake.tick(true);
    expect(off.search.queries).toEqual([]);
    expect(off.service.status().intake).toBeNull();
    off.activity.close();
  });

  it("1つの取り込み元の検索に失敗しても、ほかの取り込み元は取り込む（レビュー指摘）", async () => {
    const { activity, service, search, intake } = setup();
    service.saveProject(undefined, {
      name: "削除されたリポジトリ",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "repo", target: "https://github.com/acme/deleted" }],
    });
    search.failQuery = 'is:open repo:acme/deleted label:"sacty"';
    await intake.tick(true);
    expect(service.list().map((t) => t.source?.repo)).toEqual(["https://github.com/acme/payments"]);
    const status = service.status().intake;
    expect(status?.imported).toBe(1);
    expect(status?.errors).toEqual([
      {
        query: 'is:open repo:acme/deleted label:"sacty"',
        message: "Issue を検索できませんでした：GitHub API 422 [REDACTED]",
      },
    ]);
    activity.close();
  });

  it("取り込み元ごとに、そのプロジェクトの gh のアカウントで検索し、ログインしていないアカウントの分だけ失敗にする（PBI-13）", async () => {
    const gh = new FakeGh({ me: "ghp_active", "side-job": "ghp_side" });
    const { activity, service, search, intake } = setup(true, gh);
    service.saveProject(undefined, {
      name: "副業",
      targets: [{ scope: "repo", target: "https://github.com/side/app" }],
      githubAccounts: { "github.com": "side-job" },
    });
    service.saveProject(undefined, {
      name: "ログアウト済み",
      targets: [{ scope: "repo", target: "https://github.com/old/app" }],
      githubAccounts: { "github.com": "logged-out" },
    });
    // アカウントを選んでいないプロジェクトは、アクティブなアカウントで検索せず、理由を示す
    service.saveProject(undefined, {
      name: "インポートしたもの",
      targets: [{ scope: "repo", target: "https://github.com/imported/app" }],
    });
    await intake.tick(true);
    // 既定（アカウント未設定）はアクティブなアカウント、副業は選んだアカウントのトークン
    expect(search.queries).toEqual([
      'is:open repo:acme/payments label:"sacty"',
      'is:open repo:side/app label:"sacty"',
    ]);
    expect(search.tokens).toEqual(["ghp_active", "ghp_side"]);
    expect(gh.requested).toEqual(["me", "side-job", "logged-out"]);
    expect(service.status().intake?.errors).toEqual([
      {
        query: 'is:open repo:old/app label:"sacty"',
        message: {
          code: "github.accountUnavailable",
          params: { account: "logged-out", host: "github.com" },
        },
      },
      {
        query: 'is:open repo:imported/app label:"sacty"',
        message: {
          code: "github.accountRequired",
          params: { project: "インポートしたもの", host: "github.com" },
        },
      },
    ]);
    activity.close();
  });

  it("レート制限はアカウントごとなので、ほかのアカウントの検索は続ける（PBI-13）", async () => {
    const gh = new FakeGh({ me: "ghp_active", "side-job": "ghp_side" });
    const { activity, service, search, intake } = setup(true, gh);
    service.saveProject(undefined, {
      name: "認証",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "repo", target: "https://github.com/acme/auth" }],
    });
    service.saveProject(undefined, {
      name: "副業",
      targets: [{ scope: "repo", target: "https://github.com/side/app" }],
      githubAccounts: { "github.com": "side-job" },
    });
    search.rateLimited = true;
    await intake.tick(true);
    // アクティブなアカウントは1つ目でレート制限になり、2つ目は検索しない。副業のアカウントは検索する
    expect(search.tokens).toEqual(["ghp_active", "ghp_side"]);
    activity.close();
  });

  it("GitHub Enterprise Server の対象は、そのホストで、そのホストのアカウントで検索する（PBI-40）", async () => {
    const gh = new FakeGh({
      me: "ghp_secret",
      "ghe.example.co.jp/corp": "ghp_corp",
      "ghe2.example.co.jp/corp": "ghp_corp2",
    });
    const { activity, service, search, intake } = setup(true, gh);
    // 同じ owner/name が別のホストにあっても、別のリポジトリ
    service.saveProject(undefined, {
      name: "社内",
      targets: [
        { scope: "repo", target: "https://ghe.example.co.jp/acme/payments" },
        { scope: "org", target: "https://ghe2.example.co.jp/acme" },
      ],
      githubAccounts: { "ghe.example.co.jp": "corp", "ghe2.example.co.jp": "corp" },
    });
    // github.com と同じ owner/name・番号の Issue
    search.issues.push({
      repo: "https://ghe.example.co.jp/acme/payments",
      number: 7,
      title: "社内の冪等性キー",
      body: "本文",
      url: "https://ghe.example.co.jp/acme/payments/issues/7",
      labels: ["sacty"],
    });
    await intake.tick(true);
    expect(search.hosts).toEqual(["github.com", "ghe.example.co.jp", "ghe2.example.co.jp"]);
    expect(search.queries).toEqual([
      'is:open repo:acme/payments label:"sacty"',
      'is:open repo:acme/payments label:"sacty"',
      'is:open org:acme label:"sacty"',
    ]);
    expect(search.tokens).toEqual(["ghp_secret", "ghp_corp", "ghp_corp2"]);
    // 同じ owner/name・番号でも、ホストが違えば別の Issue として、それぞれのプロジェクトに取り込む
    const projects = new Map(service.listProjects().map((p) => [p.id, p.name]));
    expect(
      service
        .list()
        .map((t) => [t.source?.repo, projects.get(t.projectId)])
        .sort(),
    ).toEqual([
      ["https://ghe.example.co.jp/acme/payments", "社内"],
      ["https://github.com/acme/payments", "決済"],
    ]);
    activity.close();
  });

  it("読んだところから次の取り込みを続け、レート制限ならその回のほかの検索をやめる（レビュー指摘）", async () => {
    const { activity, service, search, intake, advance } = setup();
    service.saveProject(undefined, {
      name: "認証",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "repo", target: "https://github.com/acme/auth" }],
    });
    search.cursor = "2026-10-10T00:00:00Z";
    search.rateLimited = true;
    await intake.tick(true);
    expect(search.queries).toHaveLength(1); // 1つ目でレート制限になり、2つ目は検索しない
    expect(service.status().intake?.errors?.map((e) => ja(e.message))).toEqual([
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
    activity.close();
  });

  it("Issue から作ったタスクの PR は、マージで Issue を閉じる", async () => {
    const { activity, service, intake } = setup();
    await intake.tick();
    const task = service.list()[0];
    if (!task) throw new Error("no task");
    expect(buildPullRequestBody(task)).toContain("Closes #7");
    activity.close();
  });
});
