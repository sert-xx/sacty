import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, parseRepoUrl, renderMessage } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import type { ContextFetcher, ContextRef } from "./context.js";
import { MessageError } from "./errors.js";
import type { GitHubAuth } from "./gh.js";
import type { FoundIssue, IssueSearch } from "./github.js";
import { IssueIntake } from "./intake.js";
import { PlatformFile, toPlatform } from "./platforms.js";
import { fillTemplate, limitBody } from "./pr-template.js";
import { MemoryProjectStore } from "./projects.js";
import {
  buildPullRequestBody,
  buildPullRequestBodyParts,
  buildPullRequestBodyText,
  buildStepPullRequestBodyParts,
  buildStepPullRequestBodyText,
} from "./prompts.js";
import { MemorySecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { INTAKE_SCOPES_PER_QUERY, TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";
import type { TicketClient } from "./tickets.js";

/** 取り込みの対象にする、n 個のリポジトリ（acme/<name>-0 …）。 */
const manyRepos = (name: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    scope: "repo" as const,
    target: `https://github.com/acme/${name}-${i}`,
  }));

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

/** 設定ファイル。readable が false なら、読めない（取り込まない）。 */
const config =
  (readable: boolean): (() => ConfigResult) =>
  () =>
    readable
      ? {
          ok: true,
          config: {
            image: "img",
            budgetPerTaskUsd: 1,
            defaultAgent: { id: "stub", runtime: "stub", auth: { mode: "stub" } } as never,
            guardianAgent: { id: "stub", runtime: "stub", auth: { mode: "stub" } } as never,
          },
        }
      : { ok: false, problem: message("config.missing", { path: "config.yaml" }) };

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

/** JIRA の接続先（PBI-52）。 */
const jira = toPlatform(
  "jira",
  PlatformFile.parse({
    upstream: "https://jira.example.com",
    description: "JIRA",
    auth: { header: "Authorization", prefix: "Bearer ", secret: "jira-token" },
    allow: ["GET /rest/api/**"],
  }),
);
/** チケットの検索の偽物。 */
class FakeTicketSearch implements TicketClient {
  searched: {
    platform: string;
    service: string;
    keys: readonly string[];
    label: string;
    cursor?: string;
  }[] = [];
  fail?: string;
  /** 見つからない（空の結果を返す）。 */
  none = false;
  /** 返す続きの位置（順に）。 */
  next: (string | undefined)[] = [];
  async search(input: Parameters<TicketClient["search"]>[0]) {
    this.searched.push({ ...input, platform: input.platform.name });
    if (this.none) return { tickets: [] };
    if (this.fail) throw new Error(this.fail);
    return {
      tickets: [
        {
          platform: input.platform.name,
          service: input.service,
          key: "PAY-1",
          summary: "決済の再送",
          url: "https://jira.example.com/browse/PAY-1",
        },
      ],
      ...(this.next.length > 0 ? { cursor: this.next.shift() } : {}),
    };
  }
  async comment(): Promise<{ url: string }> {
    throw new Error("unused");
  }
}
/**
 * 取り込みの準備。tickets を渡すと、接続先（jira）とプロジェクトのチケットの取り込み元も設定する（PBI-100）。
 */
function setup(readable = true, gh = new FakeGh(), tickets?: TicketClient) {
  const settingsConfig = (): ConfigResult => {
    const base = config(readable)();
    return base.ok && tickets ? { ok: true, config: { ...base.config, platforms: [jira] } } : base;
  };
  const activity = new SqliteActivityStore(join(dir, "sacty.db"));
  const service = new TaskService({
    activity,
    config: settingsConfig,
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
    ...(tickets ? { tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }] } : {}),
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
  const intake = new IssueIntake(service, search, gh, settingsConfig, () => now, tickets);
  return {
    activity,
    service,
    search,
    intake,
    gh,
    config: settingsConfig,
    advance: (ms: number) => (now += ms),
  };
}

describe("GitHub Issue の定期的な取り込み（PBI-5a）", () => {
  it("間隔ごとに取り込み元を検索してタスクにし、状況を記録する", async () => {
    const { activity, service, search, intake, advance } = setup();
    await intake.tick();
    expect(search.queries).toEqual(['is:open is:issue repo:acme/payments label:"sacty"']);
    expect(service.list().map((t) => t.title)).toEqual(["冪等性キー"]);
    expect(service.status().intake?.runs?.issues).toMatchObject({ imported: 1 });

    await intake.tick(); // 間隔が来ていない
    expect(search.queries).toHaveLength(1);
    advance(300_000);
    await intake.tick();
    expect(search.queries).toHaveLength(2);
    expect(service.list()).toHaveLength(1); // 二重に取り込まない
    expect(service.status().intake?.runs?.issues).toMatchObject({ imported: 0 });
    activity.close();
  });

  it("失敗は理由を記録し、トークンは残さない。設定ファイルを読めなければ取り込まない", async () => {
    const failing = setup();
    failing.search.fail = "Issue を検索できませんでした：GitHub API 401";
    await failing.intake.tick(true);
    const error = failing.service.status().intake?.runs?.issues?.errors?.[0]?.message ?? "";
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
    // 同じアカウントの対象は1つの検索にまとまるので（PBI-140）、別のアカウントの検索で確かめる
    const { activity, service, search, intake } = setup(
      true,
      new FakeGh({ me: "ghp_secret", "side-job": "ghp_side" }),
    );
    service.saveProject(undefined, {
      name: "削除されたリポジトリ",
      githubAccounts: { "github.com": "side-job" },
      targets: [{ scope: "repo", target: "https://github.com/acme/deleted" }],
    });
    search.failQuery = 'is:open is:issue repo:acme/deleted label:"sacty"';
    await intake.tick(true);
    expect(service.list().map((t) => t.source?.repo)).toEqual(["https://github.com/acme/payments"]);
    const status = service.status().intake?.runs?.issues;
    expect(status?.imported).toBe(1);
    expect(status?.errors).toEqual([
      {
        query: 'is:open is:issue repo:acme/deleted label:"sacty"',
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
      'is:open is:issue repo:acme/payments label:"sacty"',
      'is:open is:issue repo:side/app label:"sacty"',
    ]);
    expect(search.tokens).toEqual(["ghp_active", "ghp_side"]);
    expect(gh.requested).toEqual(["me", "side-job", "logged-out"]);
    expect(service.status().intake?.runs?.issues?.errors).toEqual([
      {
        query: 'is:open is:issue repo:old/app label:"sacty"',
        message: {
          code: "github.accountUnavailable",
          params: { account: "logged-out", host: "github.com" },
        },
      },
      {
        query: 'is:open is:issue repo:imported/app label:"sacty"',
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
      name: "GHE",
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
      title: "GHE の冪等性キー",
      body: "本文",
      url: "https://ghe.example.co.jp/acme/payments/issues/7",
      labels: ["sacty"],
    });
    await intake.tick(true);
    expect(search.hosts).toEqual(["github.com", "ghe.example.co.jp", "ghe2.example.co.jp"]);
    expect(search.queries).toEqual([
      'is:open is:issue repo:acme/payments label:"sacty"',
      'is:open is:issue repo:acme/payments label:"sacty"',
      'is:open is:issue org:acme label:"sacty"',
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
      ["https://ghe.example.co.jp/acme/payments", "GHE"],
      ["https://github.com/acme/payments", "決済"],
    ]);
    activity.close();
  });

  it("レビューの依頼の検索で見つけた PR には、誰への依頼を探したかを付けて、レビューだけのタスクにする（PBI-44）", async () => {
    const { activity, service, search, intake } = setup();
    service.saveSettings({ intakeLabel: "sacty", reviewRequested: true });
    search.issues.push({
      repo: "https://github.com/acme/payments",
      number: 9,
      title: "PR 9",
      body: "",
      url: "https://github.com/acme/payments/pull/9",
      labels: [],
      pullRequest: true,
    });
    await intake.tick(true);
    expect(search.queries).toEqual([
      'is:open is:issue repo:acme/payments label:"sacty"',
      "is:open is:pr repo:acme/payments user-review-requested:me",
    ]);
    const pr = service.list().find((t) => t.source?.number === 9);
    expect(pr?.source).toMatchObject({ kind: "github_pull_request", review: "requested" });
    activity.close();
  });

  it("取り込むラベルとレビュー用のラベルが同じでも、Issue は通常のタスク、PR はレビューだけのタスクにし、二度は取り込まない（PBI-104）", async () => {
    const { activity, service, search, intake, advance } = setup();
    service.saveSettings({ intakeLabel: "sacty", reviewLabel: "Sacty" });
    // 偽の検索は is:issue・is:pr で絞らないので、どちらの検索でも Issue と PR の両方が見つかる
    search.issues.push({
      repo: "https://github.com/acme/payments",
      number: 9,
      title: "PR 9",
      body: "",
      url: "https://github.com/acme/payments/pull/9",
      labels: ["SACTY"],
      pullRequest: true,
    });
    await intake.tick(true);
    expect(search.queries).toEqual([
      'is:open is:issue repo:acme/payments label:"sacty"',
      'is:open is:pr repo:acme/payments label:"Sacty"',
    ]);
    const sources = () =>
      service
        .list()
        .map((t) => [t.source?.number, t.source?.kind, t.source?.review])
        .sort();
    expect(sources()).toEqual([
      [7, "github_issue", undefined],
      [9, "github_pull_request", "label"],
    ]);
    advance(300_000);
    await intake.tick();
    expect(search.queries).toHaveLength(4);
    expect(sources()).toHaveLength(2);
    activity.close();
  });

  it("読んだところから次の取り込みを続け、レート制限ならその回のほかの検索をやめる（レビュー指摘）", async () => {
    const { activity, service, search, intake, advance } = setup();
    // 同じアカウントの対象は1つの検索にまとまるので（PBI-140）、上限を超える数の対象で、検索を2つにする
    service.saveProject(undefined, {
      name: "認証",
      githubAccounts: { "github.com": "me" },
      targets: manyRepos("auth", INTAKE_SCOPES_PER_QUERY),
    });
    search.cursor = "2026-10-10T00:00:00Z";
    search.rateLimited = true;
    await intake.tick(true);
    expect(search.queries).toHaveLength(1); // 1つ目でレート制限になり、2つ目は検索しない
    expect(service.status().intake?.runs?.issues?.errors?.map((e) => ja(e.message))).toEqual([
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

  it("PR テンプレートに沿わせても、Issue を閉じる行とタスクの ID は失わない（PBI-87）", async () => {
    const { activity, service, intake } = setup();
    await intake.tick();
    const task = service.list()[0];
    if (!task) throw new Error("no task");
    // Issue の見出しのあるテンプレートは、その見出しに入れる
    const withIssue = fillTemplate(
      "## 概要\n\n## 関連 Issue\nFixes #\n",
      buildPullRequestBodyParts(task),
    );
    const body = limitBody(withIssue.main, withIssue.footer).body;
    expect(body).toContain("## 関連 Issue\n\nCloses #7");
    expect(body).toContain(`sacty task ${task.id}`);
    // Issue の見出しが無いテンプレートでも、本文の最後に入れる
    const without = fillTemplate("## 概要\n", buildPullRequestBodyParts(task));
    expect(without.footer).toMatch(/^Closes #7\n\n---\n/);
    expect(without.footer).toContain(`sacty task ${task.id}`);
    // 要求要件・設計の PR は、Issue を参照する（タスクブランチへのマージでは閉じない）
    const step = fillTemplate(
      "## Related\n",
      buildStepPullRequestBodyParts(task, "requirements", "docs/x.md"),
    );
    expect(step.main).toContain("## Related\n\n#7（このタスクの取り込み元");
    expect(step.footer).toContain(`sacty task ${task.id}`);
    expect(step.footer).toContain("この PR をマージすると、要求要件を承認したことになり");
    // テンプレートを使わない本文でも、省けない部分（タスクの ID・Closes・承認の案内）を分けて持つ（PR #99 レビュー指摘）
    const fallback = buildPullRequestBodyText(task);
    expect(fallback.keep).toEqual([expect.stringContaining(`sacty task ${task.id}`), "Closes #7"]);
    const stepFallback = buildStepPullRequestBodyText(task, "design", "docs/x.md");
    expect(stepFallback.keep[1]).toContain("この PR をマージすると、設計を承認したことになり");
    activity.close();
  });
});

describe("GitHub の検索をドメインごとにまとめる（PBI-140）", () => {
  it("同じドメイン・アカウントの対象は、プロジェクトをまたいで種類ごとに1つの検索にし、見つかったものは担当のプロジェクトに取り込む", async () => {
    const gh = new FakeGh({
      me: "ghp_me",
      "side-job": "ghp_side",
      "ghe.example.com/me": "ghp_ghe",
    });
    const { activity, service, search, intake } = setup(true, gh);
    service.saveSettings({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      reviewRequested: true,
    });
    const auth = service.saveProject(undefined, {
      name: "認証",
      githubAccounts: { "github.com": "me", "ghe.example.com": "me" },
      targets: [
        { scope: "repo", target: "https://github.com/acme/auth" },
        // 別のドメインは、同じ名前のアカウントでも別の検索
        { scope: "org", target: "https://ghe.example.com/corp" },
      ],
    });
    service.saveProject(undefined, {
      name: "副業",
      githubAccounts: { "github.com": "side-job" },
      targets: [{ scope: "repo", target: "https://github.com/side/app" }],
    });
    // アカウントを選んでいないプロジェクトは、まとめずにプロジェクトごと（検索せず理由を示す）
    service.saveProject(undefined, {
      name: "未設定",
      targets: [{ scope: "repo", target: "https://github.com/acme/legacy" }],
    });
    expect(service.intakeSources().map((s) => [s.host, s.account, s.project, s.query])).toEqual([
      [
        "github.com",
        "me",
        "決済・認証",
        'is:open is:issue repo:acme/payments repo:acme/auth label:"sacty"',
      ],
      [
        "github.com",
        "me",
        "決済・認証",
        'is:open is:pr repo:acme/payments repo:acme/auth label:"sacty-review"',
      ],
      [
        "github.com",
        "me",
        "決済・認証",
        "is:open is:pr repo:acme/payments repo:acme/auth user-review-requested:me",
      ],
      ["ghe.example.com", "me", "認証", 'is:open is:issue org:corp label:"sacty"'],
      ["ghe.example.com", "me", "認証", 'is:open is:pr org:corp label:"sacty-review"'],
      ["ghe.example.com", "me", "認証", "is:open is:pr org:corp user-review-requested:me"],
      ["github.com", "side-job", "副業", 'is:open is:issue repo:side/app label:"sacty"'],
      ["github.com", "side-job", "副業", 'is:open is:pr repo:side/app label:"sacty-review"'],
      [
        "github.com",
        "side-job",
        "副業",
        "is:open is:pr repo:side/app user-review-requested:side-job",
      ],
      ["github.com", undefined, "未設定", 'is:open is:issue repo:acme/legacy label:"sacty"'],
      ["github.com", undefined, "未設定", 'is:open is:pr repo:acme/legacy label:"sacty-review"'],
      [
        "github.com",
        undefined,
        "未設定",
        "is:open is:pr repo:acme/legacy user-review-requested:@me",
      ],
    ]);

    search.issues.push({
      repo: "https://github.com/acme/auth",
      number: 3,
      title: "ログインの失敗",
      body: "本文",
      url: "https://github.com/acme/auth/issues/3",
      labels: ["sacty"],
    });
    await intake.tick(true);
    // Issue の検索は、ドメイン・アカウントごとに1回（未設定のプロジェクトは検索しない）
    expect(search.queries.filter((q) => q.includes("is:issue"))).toEqual([
      'is:open is:issue repo:acme/payments repo:acme/auth label:"sacty"',
      'is:open is:issue org:corp label:"sacty"',
      'is:open is:issue repo:side/app label:"sacty"',
    ]);
    // 1つの検索で見つかったものを、それぞれの担当のプロジェクトに取り込む
    expect(
      service
        .list()
        .map((t) => [t.projectId === auth.id ? "認証" : "決済", t.source?.number])
        .sort(),
    ).toEqual([
      ["決済", 7],
      ["認証", 3],
    ]);
    expect(service.status().intake?.runs?.issues?.errors).toEqual([
      { query: 'is:open is:issue repo:acme/legacy label:"sacty"', message: expect.anything() },
    ]);
    activity.close();
  });

  it("アカウントを選んでいないプロジェクトどうしは、まとめずにプロジェクトごとに理由を示す", async () => {
    const { activity, service, search, intake } = setup();
    for (const [name, repo] of [
      ["未設定1", "acme/one"],
      ["未設定2", "acme/two"],
    ]) {
      service.saveProject(undefined, {
        name,
        targets: [{ scope: "repo", target: `https://github.com/${repo}` }],
      });
    }
    expect(service.intakeSources().map((s) => [s.project, s.query])).toEqual([
      ["決済", 'is:open is:issue repo:acme/payments label:"sacty"'],
      ["未設定1", 'is:open is:issue repo:acme/one label:"sacty"'],
      ["未設定2", 'is:open is:issue repo:acme/two label:"sacty"'],
    ]);
    await intake.tick(true);
    expect(search.queries).toEqual(['is:open is:issue repo:acme/payments label:"sacty"']);
    expect(service.status().intake?.runs?.issues?.errors?.map((e) => ja(e.message))).toEqual([
      expect.stringContaining("未設定1"),
      expect.stringContaining("未設定2"),
    ]);
    activity.close();
  });

  it("対象が上限を超えたら、上限ずつの検索に分ける", () => {
    const { activity, service } = setup();
    // プロジェクトの対象は 50 個までなので、2つのプロジェクトに分けて置く
    for (const name of ["a", "b"]) {
      service.saveProject(undefined, {
        name: `たくさん${name}`,
        githubAccounts: { "github.com": "me" },
        targets: manyRepos(name, INTAKE_SCOPES_PER_QUERY),
      });
    }
    const scopes = service
      .intakeSources()
      .map((s) => s.query.split(" ").filter((w) => w.startsWith("repo:")).length);
    // 決済の1つと合わせて 61 個 → 30・30・1
    expect(scopes).toEqual([INTAKE_SCOPES_PER_QUERY, INTAKE_SCOPES_PER_QUERY, 1]);
    const all = service.intakeSources().flatMap((s) => s.query.split(" "));
    expect(new Set(all.filter((w) => w.startsWith("repo:"))).size).toBe(
      INTAKE_SCOPES_PER_QUERY * 2 + 1,
    );
    activity.close();
  });
});

describe("取り込みの種類ごとの間隔（PBI-100）", () => {
  /** Issue・PR のレビュー・チケット（偽の JIRA と取り込み元つき）の取り込みをすべて設定した構成。 */
  const kindsSetup = (settings: Record<string, unknown> = {}) => {
    const tickets = new FakeTicketSearch();
    const made = setup(true, new FakeGh(), tickets);
    made.service.saveSettings({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      ticketLabel: "sacty",
      ...settings,
    });
    const lastRun = () =>
      Object.fromEntries(
        Object.entries(made.service.status().intake?.runs ?? {}).map(([k, r]) => [k, r?.lastRunAt]),
      );
    /** 種類ごとの、これまでの検索の回数（GitHub は検索の条件、チケットは JIRA の検索）。 */
    const counts = () => ({
      issues: made.search.queries.filter((q) => q.includes("is:issue")).length,
      reviews: made.search.queries.filter((q) => q.includes("is:pr")).length,
      tickets: tickets.searched.length,
    });
    /** その種類の、次の取り込みの記録（実時間を待たずに、終わったことを知るため）。 */
    const record = made.service.recordIntake.bind(made.service);
    const waiting: { kind: string; resolve: () => void }[] = [];
    made.service.recordIntake = (kind, run) => {
      record(kind, run);
      for (const w of waiting.filter((w) => w.kind === kind)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve();
      }
    };
    const recorded = (kind: string) =>
      new Promise<void>((resolve) => waiting.push({ kind, resolve }));
    return { ...made, tickets, lastRun, counts, recorded };
  };
  const at = (ms: number) => new Date(1_000_000 + ms).toISOString();

  it("種類ごとに、その種類の間隔で検索する（設定していない種類は既定の 300 秒）。再起動したら、すべての種類をすぐに検索する", async () => {
    const { activity, service, search, intake, advance, lastRun, counts, tickets, config } =
      kindsSetup({ issueIntervalSec: 60, reviewIntervalSec: 600 });
    await intake.tick();
    expect(counts()).toEqual({ issues: 1, reviews: 1, tickets: 1 });
    expect(lastRun()).toEqual({ issues: at(0), reviews: at(0), tickets: at(0) });

    advance(60_000);
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 1, tickets: 1 });
    advance(240_000); // 300 秒
    await intake.tick();
    expect(counts()).toEqual({ issues: 3, reviews: 1, tickets: 2 });
    expect(lastRun().tickets).toBe(at(300_000));
    advance(299_000); // 599 秒
    await intake.tick();
    expect(counts()).toEqual({ issues: 4, reviews: 1, tickets: 2 });
    advance(1_000); // 600 秒（Issue は前の検索から 1 秒）
    await intake.tick();
    expect(counts()).toEqual({ issues: 4, reviews: 2, tickets: 3 });
    expect(lastRun()).toEqual({ issues: at(599_000), reviews: at(600_000), tickets: at(600_000) });

    // 再起動（新しい取り込み）は、間隔を待たずにすべての種類を検索する
    const restarted = new IssueIntake(
      service,
      search,
      new FakeGh(),
      config,
      () => 1_000_000 + 600_001,
      tickets,
    );
    await restarted.tick();
    expect(counts()).toEqual({ issues: 5, reviews: 3, tickets: 4 });
    activity.close();
  });

  it("間隔を変えたら、デーモンを再起動せずに効く（保存した直後の確認で取り込み、その後は新しい間隔ごと）", async () => {
    const { activity, service, intake, advance, counts } = kindsSetup({ ticketIntervalSec: 600 });
    await intake.tick();
    advance(120_000);
    await intake.tick();
    expect(counts().tickets).toBe(1);
    service.saveSettings({ ...service.getSettings(), ticketIntervalSec: 60 });
    await intake.tick();
    expect(counts().tickets).toBe(2);
    advance(60_000);
    await intake.tick();
    expect(counts().tickets).toBe(3);
    // 長くすると、保存した直後の確認の後は、新しい間隔を待つ
    service.saveSettings({ ...service.getSettings(), ticketIntervalSec: 900 });
    await intake.tick();
    expect(counts().tickets).toBe(4);
    advance(600_000);
    await intake.tick();
    expect(counts().tickets).toBe(4);
    advance(300_000);
    await intake.tick();
    expect(counts().tickets).toBe(5);
    activity.close();
  });

  it("すぐに取り込む（force）は、すべての種類を間隔を待たずに検索する", async () => {
    const { activity, intake, advance, counts, lastRun } = kindsSetup();
    await intake.tick();
    advance(1_000);
    await intake.tick(true);
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    expect(lastRun()).toEqual({ issues: at(1_000), reviews: at(1_000), tickets: at(1_000) });
    activity.close();
  });

  it("取り込み元が無い回（ラベルが無い・Off）は記録せず、On にして保存したら次の確認ですぐに検索する（レビュー指摘）", async () => {
    const { activity, service, intake, counts } = kindsSetup({
      reviewLabel: "",
      ticketLabel: "sacty",
      triageOff: ["tickets"],
    });
    await intake.tick();
    expect(counts()).toEqual({ issues: 1, reviews: 0, tickets: 0 });
    // 取り込み元の無い種類は、取り込んだように記録しない
    expect(Object.keys(service.status().intake?.runs ?? {})).toEqual(["issues"]);
    // 時刻を進めずに、レビューの依頼とチケットを On にする（保存したので、すべての種類をすぐに検索する）
    service.saveSettings({ intakeLabel: "sacty", ticketLabel: "sacty", reviewRequested: true });
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 1, tickets: 1 });
    expect(Object.keys(service.status().intake?.runs ?? {}).sort()).toEqual([
      "issues",
      "reviews",
      "tickets",
    ]);
    // Off に戻すと、その種類の古い記録を消す
    service.saveSettings({ intakeLabel: "sacty", ticketLabel: "sacty", triageOff: ["tickets"] });
    await intake.tick(true);
    expect(Object.keys(service.status().intake?.runs ?? {}).sort()).toEqual(["issues"]);
    activity.close();
  });

  it("sacty の設定を読めなくても reject せず、理由を記録して、次の確認でやり直す（レビュー指摘）", async () => {
    const { activity, service, intake, counts } = kindsSetup();
    const getSettings = service.getSettings.bind(service);
    service.getSettings = () => {
      throw new Error("設定を読めません");
    };
    await expect(intake.tick()).resolves.toBeUndefined();
    const runs = service.status().intake?.runs;
    for (const kind of ["issues", "reviews", "tickets"] as const) {
      expect(
        runs?.[kind]?.errors?.map((e) => ja(e.message)),
        kind,
      ).toEqual([expect.stringContaining("設定を読めません")]);
    }
    expect(counts()).toEqual({ issues: 0, reviews: 0, tickets: 0 });
    // 読めるようになったら、間隔を待たずに取り込む
    service.getSettings = getSettings;
    await intake.tick();
    expect(counts()).toEqual({ issues: 1, reviews: 1, tickets: 1 });
    expect(service.status().intake?.runs?.issues?.errors).toBeUndefined();
    activity.close();
  });

  it("見つからなければ、取り込みの処理（すべてのタスクを調べる）を呼ばない。チケットも同じ（レビュー指摘）", async () => {
    const { activity, service, search, intake, tickets, counts } = kindsSetup();
    search.issues.length = 0;
    tickets.none = true;
    const calls = { issues: 0, tickets: 0 };
    const importIssues = service.importIssues.bind(service);
    service.importIssues = (found) => {
      calls.issues += 1;
      return importIssues(found);
    };
    const importTickets = service.importTickets.bind(service);
    service.importTickets = (found) => {
      calls.tickets += 1;
      return importTickets(found);
    };
    await intake.tick();
    // 検索はする（Issue・PR のレビュー・チケット）が、見つからないので取り込みの処理は呼ばない
    expect(counts()).toEqual({ issues: 1, reviews: 1, tickets: 1 });
    expect(calls).toEqual({ issues: 0, tickets: 0 });
    expect(service.status().intake?.runs?.issues).toMatchObject({ imported: 0 });
    expect(service.status().intake?.runs?.tickets).toMatchObject({ imported: 0 });
    // 見つかれば呼ぶ
    tickets.none = false;
    await intake.tick(true);
    expect(calls.tickets).toBe(1);
    activity.close();
  });

  it("一度取り込んだ種類を、次の確認の前に Off にして On に戻しても、次の確認ですぐに取り込む（レビュー指摘）", async () => {
    const { activity, service, intake, advance, counts } = kindsSetup();
    await intake.tick();
    expect(counts()).toEqual({ issues: 1, reviews: 1, tickets: 1 });
    advance(10_000);
    // 確認（tick）をはさまずに、チケットを Off にして On に戻す
    const settings = service.getSettings();
    service.saveSettings({ ...settings, triageOff: ["tickets"] });
    service.saveSettings(settings);
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    // 保存が無ければ、また間隔ごと
    advance(10_000);
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    activity.close();
  });

  it("レビューの依頼を On にしたまま、レビュー用のラベルだけを Off → On にしても、次の確認でラベルの PR を検索する（レビュー指摘）", async () => {
    const { activity, service, search, intake, advance } = kindsSetup({ reviewRequested: true });
    const labelSearches = () =>
      search.queries.filter((q) => q.includes('label:"sacty-review"')).length;
    await intake.tick();
    expect(labelSearches()).toBe(1);
    advance(10_000);
    const settings = service.getSettings();
    service.saveSettings({ ...settings, triageOff: ["reviewLabel"] });
    service.saveSettings(settings);
    await intake.tick();
    expect(labelSearches()).toBe(2);
    activity.close();
  });

  it("取り込んだ後に sacty の設定を一度だけ読めず、次の確認までに直ったら、間隔を待たずに取り込む（レビュー指摘）", async () => {
    const { activity, service, intake, advance, counts } = kindsSetup();
    await intake.tick();
    expect(counts()).toEqual({ issues: 1, reviews: 1, tickets: 1 });
    const getSettings = service.getSettings.bind(service);
    service.getSettings = () => {
      throw new Error("設定を読めません");
    };
    advance(30_000);
    await intake.tick();
    service.getSettings = getSettings;
    advance(30_000);
    await intake.tick();
    // 前の取り込みから 60 秒（間隔 300 秒の前）でも、すべての種類を取り込む
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    expect(service.status().intake?.runs?.issues?.errors).toBeUndefined();
    // その後は、また間隔ごと
    advance(30_000);
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    activity.close();
  });

  it("取り込みの途中の思わぬ失敗（途中で設定を読めないなど）も、直ったら次の確認で取り込む", async () => {
    const { activity, service, intake, advance, counts } = kindsSetup();
    await intake.tick();
    const revision = service.projectsRevision.bind(service);
    service.projectsRevision = () => {
      throw new Error("途中で読めません");
    };
    advance(30_000);
    await intake.tick(true);
    expect(service.status().intake?.runs?.issues?.errors?.map((e) => ja(e.message))).toEqual([
      expect.stringContaining("途中で読めません"),
    ]);
    service.projectsRevision = revision;
    advance(30_000);
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    activity.close();
  });

  it("sacty の設定を保存したら、何を変えたかによらず、すべての種類を次の確認ですぐに取り込む", async () => {
    const { activity, service, intake, advance, counts } = kindsSetup();
    await intake.tick();
    advance(10_000);
    service.saveSettings({ ...service.getSettings(), intakeLabel: "sacty-next" });
    await intake.tick();
    expect(counts()).toEqual({ issues: 2, reviews: 2, tickets: 2 });
    // 取り込みに関係の無い項目だけを保存しても同じ
    service.saveSettings({ ...service.getSettings(), maxParallelTasks: 2 });
    await intake.tick();
    expect(counts()).toEqual({ issues: 3, reviews: 3, tickets: 3 });
    // 保存が無ければ、間隔を待つ
    advance(10_000);
    await intake.tick();
    expect(counts()).toEqual({ issues: 3, reviews: 3, tickets: 3 });
    activity.close();
  });

  it("検索を待っている間に Off にして、次の確認の前に On に戻しても、取り込まれなかった項目を読み飛ばさない（レビュー指摘）", async () => {
    const { activity, service, search, intake, tickets } = kindsSetup();
    // GitHub は、続きの位置を渡すと、その前の項目を返さない。チケットも同じにする
    search.cursor = "2026-10-15T00:00:00Z";
    tickets.next = ["page-2", "page-2"];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    let bothStarted: () => void = () => {};
    const waiting = new Promise<void>((resolve) => (bothStarted = resolve));
    const block = async () => {
      started += 1;
      if (started === 2) bothStarted();
      await gate;
    };
    const original = search.search.bind(search);
    search.search = async (host, query, token, since) => {
      const result = await original(host, query, token, since);
      if (query.includes("is:issue") && !since) await block();
      return since ? { ...result, issues: [] } : result;
    };
    const ticketSearch = tickets.search.bind(tickets);
    tickets.search = async (input) => {
      const result = await ticketSearch(input);
      if (!input.cursor) await block();
      return input.cursor ? { ...result, tickets: [] } : result;
    };
    const settings = service.getSettings();
    const first = intake.tick();
    await waiting;
    // 検索を待っている間に Off にする（見つかった項目は、Off なので取り込まれない）
    service.saveSettings({ ...settings, triageOff: ["issues", "tickets"] });
    release();
    await first;
    expect(service.list()).toEqual([]);
    // 次の確認の前に On に戻す
    service.saveSettings(settings);
    await intake.tick();
    // 前の位置（先頭）から読み直して取り込む
    expect(search.sinces.filter((_, i) => search.queries[i]?.includes("is:issue"))).toEqual([
      undefined,
      undefined,
    ]);
    expect(tickets.searched.map((t) => t.cursor)).toEqual([undefined, undefined]);
    expect(
      service
        .list()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["PAY-1 決済の再送", "冪等性キー"]);
    activity.close();
  });

  it("タスクの保存に失敗したら、読んだ位置を進めず、直った後にすべての項目を取り込む（レビュー指摘）", async () => {
    const { activity, service, search, intake, tickets, advance } = kindsSetup();
    // GitHub は、続きの位置を渡すと、その前の項目を返さない
    search.cursor = "2026-10-15T00:00:00Z";
    const original = search.search.bind(search);
    search.search = async (host, query, token, since) => {
      const result = await original(host, query, token, since);
      return since ? { ...result, issues: [] } : result;
    };
    // チケットも、続きの位置を返す
    tickets.next = ["page-2", "page-2"];
    const importIssues = service.importIssues.bind(service);
    const importTickets = service.importTickets.bind(service);
    service.importIssues = () => {
      throw new Error("タスクを保存できません");
    };
    service.importTickets = () => {
      throw new Error("タスクを保存できません");
    };
    await intake.tick();
    expect(service.list()).toEqual([]);
    service.importIssues = importIssues;
    service.importTickets = importTickets;
    advance(30_000);
    await intake.tick();
    // 前の位置（先頭）から読み直すので、失敗した回の項目も取り込む
    expect(search.sinces.filter((_, i) => search.queries[i]?.includes("is:issue"))).toEqual([
      undefined,
      undefined,
    ]);
    expect(tickets.searched.map((t) => t.cursor)).toEqual([undefined, undefined]);
    expect(
      service
        .list()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["PAY-1 決済の再送", "冪等性キー"]);
    // 取り込めたら、位置を進める
    advance(300_000);
    await intake.tick();
    expect(search.sinces.at(-1)).toBe("2026-10-15T00:00:00Z");
    expect(tickets.searched.at(-1)?.cursor).toBe("page-2");
    activity.close();
  });

  it("定期の確認の前に状況を取っても、sacty の設定を読めない理由を返す（レビュー指摘）", async () => {
    const { activity, service } = kindsSetup();
    const store = (service as unknown as { deps: { settings: { get(): unknown } } }).deps.settings;
    store.get = () => {
      throw new Error("sacty.db を読めません");
    };
    const token = "test-token";
    const app = createApp(service, token);
    const res = await app.request("/api/status", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const { intake } = (await res.json()) as {
      intake: { settingsUnreadable?: boolean; settingsError?: unknown; runs?: unknown };
    };
    expect(intake.settingsUnreadable).toBe(true);
    expect(intake.runs).toBeUndefined();
    expect(ja(intake.settingsError)).toContain("sacty.db を読めません");
    activity.close();
  });

  it("sacty の設定の保存先が読めなくても、記録した理由を状況の API とすぐに取り込む API で返す（レビュー指摘）", async () => {
    const { activity, service, intake } = kindsSetup();
    const store = (service as unknown as { deps: { settings: { get(): unknown } } }).deps.settings;
    const get = store.get.bind(store);
    store.get = () => {
      throw new Error("sacty.db を読めません");
    };
    const token = "test-token";
    const app = createApp(service, token, { intake });
    const auth = { authorization: `Bearer ${token}` };
    const run = await app.request("/api/intake/run", { method: "POST", headers: auth });
    expect(run.status).toBe(200);
    const ran = (await run.json()) as {
      status: { settingsUnreadable?: boolean; runs?: Record<string, { errors?: unknown[] }> };
    };
    expect(ran.status.settingsUnreadable).toBe(true);
    for (const kind of ["issues", "reviews", "tickets"]) {
      expect(
        ran.status.runs?.[kind]?.errors?.map((e) => ja((e as { message: unknown }).message)),
        kind,
      ).toEqual([expect.stringContaining("sacty.db を読めません")]);
    }
    const status = await app.request("/api/status", { headers: auth });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { intake: unknown }).intake).toEqual(ran.status);
    // 読めるようになったら、ラベルも返す
    store.get = get;
    const recovered = (await (await app.request("/api/status", { headers: auth })).json()) as {
      intake: { settingsUnreadable?: boolean; label?: string };
    };
    expect(recovered.intake.settingsUnreadable).toBeUndefined();
    expect(recovered.intake.label).toBe("sacty");
    activity.close();
  });

  it("1つの種類のレート制限は、同じアカウントでも、ほかの種類の検索を止めない", async () => {
    const { activity, service, search, intake, counts } = kindsSetup();
    const original = search.search.bind(search);
    search.search = async (host, query, token, since) => {
      const result = await original(host, query, token, since);
      return query.includes("is:issue")
        ? { ...result, rateLimited: true, incomplete: "レート制限" }
        : result;
    };
    // 上限を超える数の対象で、種類ごとに検索を2つにする（PBI-140）
    service.saveProject(undefined, {
      name: "認証",
      githubAccounts: { "github.com": "me" },
      targets: manyRepos("auth", INTAKE_SCOPES_PER_QUERY),
    });
    await intake.tick(true);
    // Issue は1つ目でレート制限になり2つ目は探さないが、PR のレビューは2つとも探す
    expect(counts()).toMatchObject({ issues: 1, reviews: 2 });
    const runs = service.status().intake?.runs;
    expect(runs?.issues?.errors?.map((e) => ja(e.message))).toEqual([
      "レート制限",
      "レート制限のため、次の取り込みで検索します。",
    ]);
    expect(runs?.reviews?.errors).toBeUndefined();
    activity.close();
  });

  it("1つの種類の思わぬ失敗や遅れは、その種類の失敗として記録し、ほかの種類を止めない", async () => {
    const { activity, service, search, intake, advance, lastRun, counts, recorded } = kindsSetup({
      issueIntervalSec: 60,
      reviewIntervalSec: 60,
      ticketIntervalSec: 60,
    });
    const importIssues = service.importIssues.bind(service);
    service.importIssues = (found) => {
      if (found.some((f) => !f.review)) throw new Error("取り込みの失敗");
      return importIssues(found);
    };
    await intake.tick(true);
    const runs = service.status().intake?.runs;
    expect(runs?.issues?.errors?.map((e) => ja(e.message))).toEqual([
      expect.stringContaining("取り込みの失敗"),
    ]);
    expect(runs?.reviews?.lastRunAt).toBe(at(0));
    expect(runs?.reviews?.errors).toBeUndefined();
    expect(runs?.tickets?.lastRunAt).toBe(at(0));

    // Issue の検索が終わらなくても、ほかの種類は間隔ごとに取り込む（実時間は待たず、記録と検索の始まりで同期する）
    let release: () => void = () => {};
    let started: () => void = () => {};
    const issueStarted = new Promise<void>((resolve) => (started = resolve));
    const original = search.search.bind(search);
    search.search = async (host, query, token, since) => {
      if (query.includes("is:issue")) {
        started();
        await new Promise<void>((resolve) => (release = resolve));
      }
      return original(host, query, token, since);
    };
    advance(60_000);
    let done = Promise.all([recorded("reviews"), recorded("tickets")]);
    const first = intake.tick();
    await Promise.all([done, issueStarted]);
    expect(lastRun()).toEqual({ issues: at(0), reviews: at(60_000), tickets: at(60_000) });
    advance(60_000);
    done = Promise.all([recorded("reviews"), recorded("tickets")]);
    const second = intake.tick();
    await done;
    expect(lastRun()).toEqual({ issues: at(0), reviews: at(120_000), tickets: at(120_000) });
    expect(counts()).toMatchObject({ reviews: 3, tickets: 3 });
    // 止まっていた Issue の検索が終わると、その回の記録が残る（起動した取り込みは、すべて終わるまで待つ）
    release();
    await Promise.all([first, second]);
    expect(lastRun().issues).toBe(at(60_000));
    activity.close();
  });
});

describe("JIRA のチケットの取り込み（PBI-52）", () => {
  const ticketSetup = (platforms = [jira], settings = { ticketLabel: "sacty" }) => {
    const activity = new SqliteActivityStore(join(dir, "sacty.db"));
    const withPlatforms = (): ConfigResult => {
      const base = config(true)();
      return base.ok ? { ok: true, config: { ...base.config, platforms } } : base;
    };
    const service = new TaskService({
      activity,
      config: withPlatforms,
      secrets: new MemorySecretStore({}),
      executor: unused as AgentExecutor,
      repos: unused as never,
      tests: unused as never,
      pulls: unused as never,
      projects: new MemoryProjectStore(),
      settings: new MemorySettingsStore(settings),
      github: unused as never,
      workspaceRoot: join(dir, "workspaces"),
    });
    service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      tickets: [
        { platform: "jira", service: "jira-server", keys: ["PAY"] },
        { platform: "gone", service: "jira-cloud", keys: ["GONE"] },
      ],
    });
    const tickets = new FakeTicketSearch();
    const intake = new IssueIntake(
      service,
      new FakeSearch([]),
      new FakeGh(),
      withPlatforms,
      () => 1_000_000,
      tickets,
    );
    return { activity, service, intake, tickets };
  };

  it("取り込み先ごとに探してタスクにし、接続先が無い取り込み先は理由を記録する。二度は取り込まない", async () => {
    const { activity, service, intake, tickets } = ticketSetup();
    await intake.tick(true);
    expect(tickets.searched).toEqual([
      { platform: "jira", service: "jira-server", keys: ["PAY"], label: "sacty" },
    ]);
    expect(service.list().map((t) => [t.title, t.start])).toEqual([["PAY-1 決済の再送", "jira"]]);
    const status = service.status().intake;
    expect(status).toMatchObject({ ticketLabel: "sacty", runs: { tickets: { imported: 1 } } });
    expect(status?.runs?.tickets?.errors?.map((e) => [e.query, ja(e.message)])).toEqual([
      [expect.stringContaining('gone: project in ("GONE")'), expect.stringContaining("gone")],
    ]);
    await intake.tick(true);
    expect(service.list()).toHaveLength(1);
    expect(service.status().intake?.runs?.tickets).toMatchObject({ imported: 0 });
    activity.close();
  });

  it("読む上限を超えたら、次の回は続きの位置から読み、最後まで読んだら先頭に戻る。失敗したら先頭から読み直す", async () => {
    const { activity, intake, tickets } = ticketSetup();
    tickets.next = ["500", undefined, "500"];
    for (let i = 0; i < 3; i++) await intake.tick(true);
    tickets.fail = "JIRA 400";
    await intake.tick(true);
    tickets.fail = undefined;
    await intake.tick(true);
    expect(tickets.searched.map((s) => s.cursor)).toEqual([
      undefined,
      "500",
      undefined,
      "500",
      undefined,
    ]);
    activity.close();
  });

  it("ホストに無い接続先は、プロジェクトのコンテキストの platforms.yaml の PF で、プロジェクトごとに探す（PBI-74）", async () => {
    const activity = new SqliteActivityStore(join(dir, "sacty.db"));
    const withPlatforms = (): ConfigResult => {
      const base = config(true)();
      return base.ok ? { ok: true, config: { ...base.config, platforms: [jira] } } : base;
    };
    const pfYaml = (upstream: string) =>
      [
        "platforms:",
        "  team-jira:",
        `    upstream: ${upstream}`,
        "    auth:",
        "      secret: team-jira-token",
        "    allow: [GET /rest/api/**]",
      ].join("\n");
    const files: Record<string, Record<string, string>> = {
      "https://example.com/a-ctx.git": { "platforms.yaml": pfYaml("https://a-jira.example.com") },
      "https://example.com/b-ctx.git": { "platforms.yaml": pfYaml("https://b-jira.example.com") },
      "https://example.com/broken.git": { "platforms.yaml": "platforms: [" },
    };
    const fetched: string[] = [];
    const contexts: ContextFetcher = {
      async fetch(ref: ContextRef, out: string) {
        fetched.push(ref.repo);
        for (const [path, content] of Object.entries(files[ref.repo] ?? {})) {
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, path), content);
        }
        return { commit: "c0ffee".padEnd(40, "0") };
      },
    };
    const service = new TaskService({
      activity,
      config: withPlatforms,
      secrets: new MemorySecretStore({}),
      executor: unused as AgentExecutor,
      repos: unused as never,
      tests: unused as never,
      pulls: unused as never,
      projects: new MemoryProjectStore(),
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      github: unused as never,
      contexts,
      workspaceRoot: join(dir, "workspaces"),
    });
    const project = (name: string, repo: string, context: string, keys: string[]) =>
      service.saveProject(undefined, {
        name,
        targets: [{ scope: "repo", target: `https://github.com/acme/${repo}` }],
        context: { repo: context },
        tickets: [
          { platform: "team-jira", service: "jira-server", keys },
          // ホストの PF の名前は、これまでどおりプロジェクトをまたいでまとめる（コンテキストは取得しない）
          { platform: "jira", service: "jira-server", keys: [`${keys[0]}X`] },
          // どの層にも無い名前は、理由を記録する（コンテキストの取得はプロジェクトごとに1度だけ）
          { platform: "nowhere", service: "jira-server", keys: [`${keys[0]}N`] },
        ],
      });
    const a = project("A", "a", "https://example.com/a-ctx.git", ["PAY"]);
    const b = project("B", "b", "https://example.com/b-ctx.git", ["OPS"]);
    project("C", "c", "https://example.com/broken.git", ["BRK"]);
    class Recording extends FakeTicketSearch {
      upstreams: string[] = [];
      override async search(input: Parameters<TicketClient["search"]>[0]) {
        this.upstreams.push(`${input.platform.name} ${input.platform.upstream}`);
        return super.search(input);
      }
    }
    const tickets = new Recording();
    const intake = new IssueIntake(
      service,
      new FakeSearch([]),
      new FakeGh(),
      withPlatforms,
      () => 1_000_000,
      tickets,
    );
    await intake.tick(true);
    // 同じ名前でも、プロジェクトごとに、そのプロジェクトのコンテキストの PF で探す
    expect(tickets.upstreams).toEqual([
      "team-jira https://a-jira.example.com",
      "jira https://jira.example.com",
      "team-jira https://b-jira.example.com",
    ]);
    expect(tickets.searched.find((t) => t.platform === "jira")?.keys).toEqual([
      "BRKX",
      "OPSX",
      "PAYX",
    ]);
    // 見つかったチケットは、そのキーを書いたプロジェクトのタスクになる
    // ほかのプロジェクト（B）の PF で見つけた PAY-1 は、B のキーではないので取り込まない
    expect(service.list().map((t) => [t.title, t.projectId, t.ticket?.scope])).toEqual([
      ["PAY-1 決済の再送", a.id, "project"],
    ]);
    expect(b.id).not.toBe(a.id);
    // コンテキストの誤りは、どの層のどのファイルかを、取り込み先ごとに記録する（ほかの取り込み先は続ける）
    expect(
      service.status().intake?.runs?.tickets?.errors?.map((e) => [e.query, ja(e.message)]),
    ).toEqual([
      [expect.stringContaining('nowhere: project in ("PAYN")'), expect.stringContaining("nowhere")],
      [expect.stringContaining('nowhere: project in ("OPSN")'), expect.stringContaining("nowhere")],
      [
        expect.stringContaining('team-jira: project in ("BRK")'),
        expect.stringContaining("https://example.com/broken.git の platforms.yaml を読めません"),
      ],
      [
        expect.stringContaining('nowhere: project in ("BRKN")'),
        expect.stringContaining("https://example.com/broken.git の platforms.yaml を読めません"),
      ],
    ]);
    expect(fetched.sort()).toEqual([
      "https://example.com/a-ctx.git",
      "https://example.com/b-ctx.git",
      "https://example.com/broken.git",
    ]);
    activity.close();
  });

  it("検索の失敗は取り込み先ごとに記録し、Off なら探さない", async () => {
    const failing = ticketSetup();
    failing.tickets.fail = "JIRA 500";
    await failing.intake.tick(true);
    expect(
      failing.service.status().intake?.runs?.tickets?.errors?.map((e) => ja(e.message)),
    ).toContainEqual(expect.stringContaining("JIRA 500"));
    failing.activity.close();
    rmSync(join(dir, "sacty.db"), { force: true });

    const off = ticketSetup([jira], { ticketLabel: "sacty", triageOff: ["tickets"] } as never);
    await off.intake.tick(true);
    expect(off.tickets.searched).toEqual([]);
    expect(off.service.list()).toEqual([]);
    off.activity.close();
  });
});

describe("レビューの再依頼の確かめ（PBI-143）", () => {
  const requested = "is:open is:pr repo:acme/payments user-review-requested:me";

  it.each(["HTTP", "page-limit"])(
    "依頼を確かめられなければ（%s）、理由を残し、検索の読んだ位置を進めない",
    async (reason) => {
      const { activity, service, search, intake, advance } = setup();
      service.saveSettings({ intakeLabel: "sacty", reviewRequested: true });
      search.cursor = "2026-10-19T00:00:00Z";
      search.issues.push({
        repo: "https://github.com/acme/payments",
        number: 9,
        title: "PR 9",
        body: "",
        url: "https://github.com/acme/payments/pull/9",
        labels: [],
        pullRequest: true,
      });
      const failure = message("intake.rerequestUnchecked", {
        pr: "https://github.com/acme/payments#9",
        detail: reason === "HTTP" ? "GitHub API 502" : message("github.eventsIncomplete"),
      });
      const check = vi
        .spyOn(service, "restartRerequestedReviews")
        .mockImplementationOnce(async (found) => ({
          restarted: [],
          failed: found
            .filter((i) => i.number === 9)
            .slice(0, 1)
            .map((issue) => ({ issue, message: failure })),
        }))
        .mockImplementation(async () => ({ restarted: [], failed: [] }));
      const sinceOf = (query: string) =>
        search.sinces.filter((_, i) => search.queries[i] === query).at(-1);

      await intake.tick(true);
      // 依頼の検索で見つかったものとして、誰への依頼かを付けて渡す
      expect(check).toHaveBeenCalledTimes(1);
      // （偽の検索は is:pr で絞らないので、Issue 7 も見つかる）
      expect(check.mock.calls[0]?.[0].find((i) => i.number === 9)).toMatchObject({
        review: "requested",
        requestedFor: "me",
      });
      expect(ja(service.status().intake.runs?.reviews?.errors?.map((e) => e.message)[0])).toContain(
        "https://github.com/acme/payments#9 でレビューが再依頼されたかを確かめられませんでした",
      );
      if (reason === "page-limit") {
        expect(ja(service.status().intake.runs?.reviews?.errors?.[0]?.message)).toContain(
          "ページ数の上限に達したため",
        );
      }

      // 次の取り込みは、同じ範囲を検索し直す（読んだ位置を進めていない）
      advance(24 * 60 * 60 * 1000);
      await intake.tick(true);
      expect(sinceOf(requested)).toBeUndefined();
      expect(check).toHaveBeenCalledTimes(2);
      expect(service.status().intake.runs?.reviews?.errors).toBeUndefined();

      // 確かめられたら、読んだ位置を進める
      advance(24 * 60 * 60 * 1000);
      await intake.tick(true);
      expect(sinceOf(requested)).toBe("2026-10-19T00:00:00Z");
      activity.close();
    },
  );

  it("Issue の取り込みでは、再依頼を確かめない", async () => {
    const { activity, service, intake } = setup();
    const check = vi.spyOn(service, "restartRerequestedReviews");
    await intake.tick(true);
    expect(service.list().map((t) => t.source?.number)).toEqual([7]);
    expect(check).not.toHaveBeenCalled();
    activity.close();
  });
});
