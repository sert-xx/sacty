import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Task } from "@sacty/core";
import { DERIVE_RECORD_HEADING, isCompleted, renderMessage, rerunEditableBody } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult, SactyConfig } from "./config.js";
import type { PullRequestFeedback } from "./github.js";
import { IssueIntake } from "./intake.js";
import { NotificationFeed } from "./notification-feed.js";
import { SlackNotifier } from "./notifier.js";
import { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import type { Platform } from "./platforms.js";
import { MemoryProjectStore, SqliteProjectStore } from "./projects.js";
import { buildRemarkReply } from "./remark-reply.js";
import { MemorySecretStore, SecretNotFoundError } from "./secrets.js";
import { createApp } from "./server.js";
import type { ServiceDeps, TaskService } from "./service.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore, SqliteSettingsStore } from "./settings.js";
import { describeTask } from "./task-mcp.js";
import {
  agent,
  completed,
  configOf,
  dbPath,
  dir,
  FakeContexts,
  type FakeExecutor,
  FakeGitHub,
  FakePulls,
  FakeRepos,
  FakeTickets,
  fakeGateway,
  foundTicket,
  ja,
  jiraPlatform,
  makeService,
  projectsWithAccount,
  readTree,
  triageOut,
  useTempDir,
} from "./testing/daemon.js";
import { loopTurn, waitForAssertion } from "./testing/wait.js";

useTempDir();

describe("プロジェクトの対象と、オーケストレーターが決めるベースブランチ・テストのコマンド（PBI-25）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const plan = (value: string, extra: Record<string, string> = {}) =>
    out(block({ "sacty-steps": { plan: value, reason: "理由", ...extra } }));
  /** 対象：リポジトリ acme/app と Org tools（tools/secret は、ほかのプロジェクトが担当）。 */
  const targets = () => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "org", target: "https://github.com/tools" },
      ],
      githubAccounts: { "github.com": "me" },
    });
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/tools/secret" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };

  it("対象の中から選んだリポジトリで、ブランチを指定せずに既定のブランチを clone する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, repos } = makeService(activity, [out("# 要求要件")], { projects: targets() });
    // リポジトリの対象は、登録した名前にそろえる
    expect(
      service.createTask({ projectId: "default", title: "A", repo: "https://github.com/ACME/APP" })
        .repo,
    ).toBe("https://github.com/acme/app");
    // Org の対象の中のリポジトリも選べる
    const task = service.createTask({
      projectId: "default",
      title: "B",
      repo: "https://github.com/tools/cli",
    });
    expect(task.repo).toBe("https://github.com/tools/cli");
    await service.runNext(task.id);
    expect(repos.prepared[0]?.url).toBe("https://github.com/tools/cli.git");
    expect(repos.prepared[0]?.baseBranch).toBeUndefined();
    expect(service.get(task.id)?.task.repository).toMatchObject({
      baseBranch: "main",
      baseCommit: "base123",
    });
    activity.close();
  });

  it("GitHub Enterprise Server のリポジトリは、そのホストの、そのホストのアカウントのトークンで clone する（PBI-40）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const github = new FakeGitHub({ me: "ghp_secret", "ghe.example.co.jp/corp": "ghp_corp" });
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": { "rules.md": "# 規約" },
    });
    const { service, repos } = makeService(activity, [out("# 要求要件")], { github, contexts });
    // 1つのプロジェクトで、GHE の対象と、github.com のコンテキストリポジトリを使う
    const project = service.saveProject(undefined, {
      name: "GHE",
      targets: [{ scope: "repo", target: "https://ghe.example.co.jp/acme/app" }],
      githubAccounts: { "ghe.example.co.jp": "corp", "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const task = service.createTask({ projectId: project.id, title: "A" });
    expect(task.repo).toBe("https://ghe.example.co.jp/acme/app");
    await service.runNext(task.id);
    const header = (token: string) =>
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    expect(repos.prepared[0]).toMatchObject({
      url: "https://ghe.example.co.jp/acme/app.git",
      authEnv: {
        GIT_CONFIG_KEY_0: "http.https://ghe.example.co.jp/.extraheader",
        GIT_CONFIG_VALUE_0: header("ghp_corp"),
      },
    });
    expect(contexts.fetched[0]?.authEnv).toMatchObject({
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: header("ghp_secret"),
    });
    activity.close();
  });

  // 選んでいない（対象が複数）ときは、リポジトリを指定しないタスクとして作る（PBI-73。別の describe で確かめる）
  it("対象の外・ほかのプロジェクトが担当するリポジトリは作らない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: targets() });
    for (const repo of [
      "https://github.com/tools/secret",
      "https://github.com/other/app",
      "not a repo",
    ]) {
      expect(() =>
        service.createTask({ projectId: "default", title: "A", ...(repo ? { repo } : {}) }),
      ).toThrow(/対象リポジトリを、プロジェクト/);
    }
    expect(service.list()).toEqual([]);
    activity.close();
  });

  it("対象のリポジトリの候補は、リポジトリの対象と、gh で読んだ Org のリポジトリ（ほかのプロジェクトの担当を除く）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.ownerRepos = {
      "https://github.com/tools": [
        "https://github.com/tools/cli",
        "https://github.com/tools/secret",
        "https://github.com/tools/web",
      ],
    };
    const { service } = makeService(activity, [], { projects: targets(), pulls });
    expect(await service.projectRepositories("default")).toEqual({
      repositories: [
        "https://github.com/acme/app",
        "https://github.com/tools/cli",
        "https://github.com/tools/web",
      ],
      errors: [],
    });
    expect(pulls.repositoryRequests).toEqual([
      { org: "https://github.com/tools", token: "ghp_secret" },
    ]);
    // 読めなかった Org は、トークンを伏せた理由を返す（読めたものは返す）
    pulls.repositoriesFail = "404 Not Found ghp_secret";
    const failed = await service.projectRepositories("default");
    expect(failed?.repositories).toEqual(["https://github.com/acme/app"]);
    expect(failed?.errors[0]?.org).toBe("https://github.com/tools");
    expect(JSON.stringify(failed?.errors)).not.toContain("ghp_secret");
    expect(await service.projectRepositories("no-such")).toBeUndefined();
    activity.close();
  });

  it("オーケストレーターが既定と違うベースブランチを選べば、その最新で用意し直して記録し、用意できなければ既定のブランチで進める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    repos.branchHeads = { develop: "dev456" };
    repos.missingBranches = ["nope"];
    const { service } = makeService(
      activity,
      [
        plan("skip-design", { baseBranch: "develop", testCommand: "make test" }),
        out("# 要求要件"),
        plan("skip-design", { baseBranch: "nope", testCommand: "make test" }),
        out("# 要求要件"),
      ],
      { repos, realPlanner: true },
    );
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    const task = service.get(a.id)?.task;
    expect(task?.repository).toMatchObject({ baseBranch: "develop", baseCommit: "dev456" });
    expect(task?.testCommand).toBe("make test");
    expect(repos.prepared.map((p) => p.baseBranch)).toEqual([undefined, "develop"]);
    expect(service.get(a.id)?.activity.filter((e) => e.type === "RepositoryPrepared")).toHaveLength(
      2,
    );
    // 最初の工程（要求要件）を続けて実行している
    expect(task?.steps.find((st) => st.state === "active")?.key).toBe("requirements");

    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    expect(service.get(b.id)?.task.repository?.baseBranch).toBe("main");
    expect(service.get(b.id)?.task.stepsChoice?.reason).toMatchObject({
      code: "orchestrator.baseBranchUnavailable",
      params: { branch: "nope" },
    });
    expect(service.get(b.id)?.task.steps.find((st) => st.state === "active")?.key).toBe(
      "requirements",
    );
    activity.close();
  });

  it("テストのコマンドが分からなくても、sacty はテストを実行しないので止めずに進める。調査だけのタスクも止めない（PBI-336）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [plan("standard"), out("# 要求要件"), plan("investigate"), out("# 調査の結果")],
      { realPlanner: true },
    );
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    expect(service.get(a.id)?.task.status).not.toBe("paused");
    expect(service.get(a.id)?.task.pausedMessage).toBeUndefined();
    expect(service.get(a.id)?.task.testCommand).toBeUndefined();
    expect(service.get(a.id)?.task.gate).toEqual({ step: "requirements", submission: 1 });
    expect(executor.calls).toHaveLength(2);
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    expect(service.get(b.id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    activity.close();
  });

  it("対象リポジトリを選ぶ前の版で作ったタスクは、理由を記録して止まる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    activity.append({
      taskId: "t-old",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title: "古いタスク", body: "", start: "ticket", budgetCapUsd: 1 },
          },
        },
      ],
    });
    const { service, repos, executor } = makeService(activity, [out("# 要求要件")]);
    await service.runNext("t-old");
    const task = service.get("t-old")?.task;
    expect(task?.status).toBe("paused");
    expect(task?.pausedMessage).toEqual({ code: "run.repositoryNotConfigured" });
    expect(repos.prepared).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    activity.close();
  });
});

describe("sacty の設定と、Issue・PR の取り込み（PBI-26）", () => {
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const found = (number: number, labels: string[], pullRequest = false) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `${pullRequest ? "PR" : "Issue"} ${number}`,
    body: "本文",
    url: `https://github.com/acme/app/${pullRequest ? "pull" : "issues"}/${number}`,
    labels,
    ...(pullRequest ? { pullRequest: true } : {}),
  });
  /**
   * 取り込むラベルで PR を取り込んでいた（PBI-99 より前の）タスク。いまは取り込みでは作らないので、台帳に書いて作る。
   * すでに取り込んだタスクは、これまでどおり進む。
   */
  const importedPullRequest = (activity: SqliteActivityStore, number: number) => {
    const id = randomUUID();
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "TaskCreated",
            payload: {
              title: `PR ${number}`,
              body: "本文",
              start: "github_pull_request",
              budgetCapUsd: 5,
              source: {
                kind: "github_pull_request",
                repo: "https://github.com/acme/app",
                number,
                url: `https://github.com/acme/app/pull/${number}`,
              },
            },
          },
        },
      ],
    });
    return id;
  };

  it("取り込むラベルは sacty 全体の設定で、設定していなければ取り込まない。変えると取り込みは読み直す", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore();
    const { service } = makeService(activity, [], { settings });
    expect(service.getSettings()).toEqual({});
    expect(service.intakeSources()).toEqual([]);
    expect(service.importIssues([found(1, ["sacty"])])).toEqual([]);
    const before = service.projectsRevision();

    // 前後の空白は除き、空は「設定しない」
    expect(service.saveSettings({ intakeLabel: "  ai-task " })).toEqual({ intakeLabel: "ai-task" });
    expect(service.projectsRevision()).not.toBe(before);
    expect(service.intakeSources()).toEqual([
      {
        host: "github.com",
        query: 'is:open is:issue repo:acme/app label:"ai-task"',
        account: "me",
        project: "デフォルト",
      },
    ]);
    // ラベルの大文字・小文字は区別しない。ほかのラベルは取り込まない
    expect(
      service
        .importIssues([found(2, ["AI-Task"]), found(3, ["sacty"])])
        .map((t) => t.source?.number),
    ).toEqual([2]);
    expect(service.saveSettings({ intakeLabel: " " })).toEqual({});
    expect(service.intakeSources()).toEqual([]);
    // 検索の条件を壊す文字は受け付けない
    expect(() => service.saveSettings({ intakeLabel: 'a" OR label:"b' })).toThrow();
    activity.close();
  });

  it("取り込むラベルの付いた PR は取り込まない（PBI-99）。すでに PR から作ったタスクは、その PR をレビューの対象として工程を選ばせる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 8, url: "https://github.com/acme/app/pull/8" };
    const settings = new MemorySettingsStore({ intakeLabel: "sacty" });
    const first = makeService(activity, [], { pulls, settings });
    expect(first.service.importIssues([found(8, ["sacty"], true)])).toEqual([]);
    const id = importedPullRequest(activity, 8);
    const { service, executor } = makeService(
      activity,
      [out(block({ "sacty-steps": { plan: "review", reason: "PR のレビュー" } })), out("# 評価")],
      { pulls, settings, realPlanner: true },
    );
    expect(service.get(id)?.task.start).toBe("github_pull_request");
    await service.runNext(id);
    // 本文に PR の URL が無くても、取り込んだ PR そのものをレビューの対象にする
    expect(promptOf(executor, 0)).toContain("- review：");
    expect(pulls.prInfoRequests).toEqual([
      { repo: "https://github.com/acme/app", number: 8, token: "ghp_secret" },
    ]);
    await service.runNext(id);
    expect(pulls.reviews[0]?.number).toBe(8);
    activity.close();
  });

  it("すでに PR から作った調査のタスクは、結果を PR にコメントする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const id = importedPullRequest(activity, 9);
    const { service } = makeService(activity, [out("# 調査の結果")], {
      pulls,
      planner: async () => ({
        steps: ["investigate" as const],
        plan: "investigate" as const,
        reason: "質問",
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    await service.runNext(id);
    expect(pulls.issueComments.map((c) => [c.repo, c.number])).toEqual([
      ["https://github.com/acme/app", 9],
    ]);
    expect(service.get(id)?.task.issueComment).toBeDefined();
    activity.close();
  });

  it("状態には、取り込むラベルを含める（設定していなければ無い）。取り込みに github: の設定は要らない（PBI-100）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore();
    const { service } = makeService(activity, [], { settings });
    expect(service.status().intake).toEqual({});
    service.saveSettings({ intakeLabel: "sacty" });
    expect(service.status().intake).toEqual({ label: "sacty" });
    activity.close();
  });
});

describe("自動のトリアージの種類ごとの On/Off（PBI-53）", () => {
  const found = (number: number, labels: string[], pullRequest = false) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `#${number}`,
    body: "",
    url: `https://github.com/acme/app/${pullRequest ? "pull" : "issues"}/${number}`,
    labels,
    ...(pullRequest ? { pullRequest: true } : {}),
  });

  it("Off にした種類は検索せず、取り込まない。ラベルなどの設定は残る。項目の無い設定はすべて On", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      reviewRequested: true,
    });
    const { service } = makeService(activity, [], { settings });
    const queries = () => service.intakeSources().map((s) => s.query);
    // On/Off の項目が無い設定は、すべて On。取り込むラベルは Issue だけを探す（PBI-99）
    expect(queries()).toEqual([
      'is:open is:issue repo:acme/app label:"sacty"',
      'is:open is:pr repo:acme/app label:"sacty-review"',
      "is:open is:pr repo:acme/app user-review-requested:me",
    ]);
    // 取り込むラベルの付いた PR は取り込まない（PBI-99）
    expect(
      service
        .importIssues([found(1, ["sacty"]), found(2, ["sacty"], true)])
        .map((t) => t.source?.number),
    ).toEqual([1]);
    const before = service.projectsRevision();

    // Issue を Off：取り込むラベルの検索をしない。重ねて書いても1つ、並びはそろえる
    expect(
      service.saveSettings({
        intakeLabel: "sacty",
        reviewLabel: "sacty-review",
        reviewRequested: true,
        triageOff: ["issues", "issues"],
      }),
    ).toMatchObject({ intakeLabel: "sacty", reviewLabel: "sacty-review", triageOff: ["issues"] });
    expect(service.projectsRevision()).not.toBe(before);
    expect(queries()).toEqual([
      'is:open is:pr repo:acme/app label:"sacty-review"',
      "is:open is:pr repo:acme/app user-review-requested:me",
    ]);
    expect(service.importIssues([found(3, ["sacty"]), found(4, ["sacty"], true)])).toEqual([]);

    // Issue とレビュー用のラベルを Off：その検索をしない。ラベルは残る
    service.saveSettings({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      reviewRequested: true,
      triageOff: ["reviewLabel", "issues"],
    });
    expect(queries()).toEqual(["is:open is:pr repo:acme/app user-review-requested:me"]);
    expect(service.getSettings()).toMatchObject({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      triageOff: ["issues", "reviewLabel"],
    });
    expect(service.importIssues([found(5, ["sacty"]), found(6, ["sacty-review"], true)])).toEqual(
      [],
    );
    // 状況（画面）にも出す
    expect(service.status().intake).toMatchObject({ triageOff: ["issues", "reviewLabel"] });
    // すべて On に戻すと、項目を持たない
    expect(service.saveSettings({ intakeLabel: "sacty", triageOff: [] })).toEqual({
      intakeLabel: "sacty",
    });
    expect(() => service.saveSettings({ triageOff: ["jira-unknown"] })).toThrow();
    // 消した種類（取り込むラベルの PR。PBI-99）は受け付けない
    expect(() => service.saveSettings({ triageOff: ["pullRequests"] })).toThrow();
    activity.close();
  });

  it("取り込むラベルとレビュー用のラベルに同じ名前（大文字・小文字だけ違う名前も）を保存でき、Issue は通常のタスク、PR はレビューだけのタスクにする（PBI-104）", () => {
    for (const [intakeLabel, reviewLabel] of [
      ["sacty", "sacty"],
      ["sacty", " SACTY "],
    ] as const) {
      const activity = new SqliteActivityStore(dbPath);
      const settings = new MemorySettingsStore({});
      const { service } = makeService(activity, [], { settings });
      expect(service.saveSettings({ intakeLabel, reviewLabel }), reviewLabel).toEqual({
        intakeLabel: "sacty",
        reviewLabel: reviewLabel.trim(),
      });
      // Issue と PR は検索の条件（is:issue・is:pr）で分かれる
      expect(service.intakeSources().map((s) => [s.query, s.review])).toEqual([
        ['is:open is:issue repo:acme/app label:"sacty"', undefined],
        [`is:open is:pr repo:acme/app label:"${reviewLabel.trim()}"`, "label"],
      ]);
      // 同じラベルの Issue は通常のタスク、PR はレビューだけのタスク。どちらの検索で見つかっても入れ替わらない
      const labeled = reviewLabel.trim();
      const created = service.importIssues([
        found(1, ["sacty"]),
        found(2, [labeled], true),
        { ...found(3, ["sacty"]), review: "label" },
        found(4, [labeled], true),
      ]);
      expect(created.map((t) => [t.source?.number, t.source?.kind, t.source?.review])).toEqual([
        [1, "github_issue", undefined],
        [2, "github_pull_request", "label"],
        [3, "github_issue", undefined],
        [4, "github_pull_request", "label"],
      ]);
      // 2つの検索の両方で見つかっても、同じ Issue・PR は二度取り込まない
      expect(
        service.importIssues([
          found(1, ["sacty"]),
          { ...found(1, ["sacty"]), review: "label" },
          found(2, [labeled], true),
          { ...found(2, [labeled], true), review: "label" },
        ]),
      ).toEqual([]);
      expect(service.list()).toHaveLength(4);
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("同じ名前の2つのラベルをすでに保存してある設定（SQLite）でも開け、Issue と PR の取り込みが続く（PBI-99 レビュー指摘）", () => {
    // 以前の版で保存した設定を、そのまま書く
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    raw
      .prepare("INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)")
      .run(
        JSON.stringify({ intakeLabel: "sacty", reviewLabel: "Sacty", triageOff: ["pullRequests"] }),
        "2026-10-14T00:00:00.000Z",
      );
    raw.close();
    const settings = new SqliteSettingsStore(dbPath);
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { settings });
    expect(service.getSettings()).toEqual({ intakeLabel: "sacty", reviewLabel: "Sacty" });
    expect(service.intakeSources().map((s) => s.query)).toEqual([
      'is:open is:issue repo:acme/app label:"sacty"',
      'is:open is:pr repo:acme/app label:"Sacty"',
    ]);
    // Issue は通常のタスク、PR はレビューだけのタスク
    expect(
      service
        .importIssues([found(1, ["sacty"]), found(2, ["sacty"], true)])
        .map((t) => [t.source?.number, t.source?.review]),
    ).toEqual([
      [1, undefined],
      [2, "label"],
    ]);
    // そのまま保存し直せる（PBI-104）
    expect(service.saveSettings({ intakeLabel: "sacty", reviewLabel: "Sacty" })).toEqual({
      intakeLabel: "sacty",
      reviewLabel: "Sacty",
    });
    activity.close();
    settings.close();
  });
});

describe("PR のレビューだけを行う取り込み（PBI-44）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const pr = (number: number, labels: string[], extra: Record<string, unknown> = {}) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `PR ${number}`,
    body: "本文",
    url: `https://github.com/acme/app/pull/${number}`,
    labels,
    pullRequest: true,
    ...extra,
  });

  it("自分へのレビューの依頼とレビュー用のラベルで、ホストのアカウントごとに PR を探す（チームへの依頼は含めない）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore();
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "org", target: "https://ghe.example.com/corp" },
      ],
      githubAccounts: { "github.com": "me", "ghe.example.com": "me-corp" },
    });
    const { service } = makeService(activity, [], { settings, projects });
    expect(service.intakeSources()).toEqual([]);
    expect(service.saveSettings({ reviewRequested: "on", reviewLabel: " sacty-review " })).toEqual({
      reviewRequested: true,
      reviewLabel: "sacty-review",
    });
    expect(service.intakeSources()).toEqual([
      {
        host: "github.com",
        query: 'is:open is:pr repo:acme/app label:"sacty-review"',
        account: "me",
        project: "デフォルト",
        review: "label",
      },
      {
        host: "github.com",
        query: "is:open is:pr repo:acme/app user-review-requested:me",
        account: "me",
        project: "デフォルト",
        review: "requested",
      },
      {
        host: "ghe.example.com",
        query: 'is:open is:pr org:corp label:"sacty-review"',
        account: "me-corp",
        project: "デフォルト",
        review: "label",
      },
      {
        host: "ghe.example.com",
        query: "is:open is:pr org:corp user-review-requested:me-corp",
        account: "me-corp",
        project: "デフォルト",
        review: "requested",
      },
    ]);
    // 切り替えを切ると、依頼の検索はしない。取り込むラベル（Issue と PR）は別の設定
    service.saveSettings({ reviewLabel: "sacty-review", intakeLabel: "sacty" });
    expect(service.intakeSources().map((s) => s.review ?? "intake")).toEqual([
      "intake",
      "label",
      "intake",
      "label",
    ]);
    activity.close();
  });

  it("依頼された PR とレビュー用のラベルの PR を取り込み、レビュー用のラベルの Issue は取り込まない。同じ PR は1つ", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({
      reviewRequested: true,
      reviewLabel: "sacty-review",
    });
    const { service } = makeService(activity, [], { settings });
    const created = service.importIssues([
      pr(1, [], { review: "requested", requestedFor: "me" }),
      pr(2, ["Sacty-Review"]),
      // 依頼とラベルの両方に当てはまる
      pr(3, ["sacty-review"], { review: "requested", requestedFor: "me" }),
      pr(3, ["sacty-review"], { review: "label" }),
      // レビュー用のラベルの Issue は取り込まない
      {
        ...pr(4, ["sacty-review"]),
        pullRequest: undefined,
        url: "https://github.com/acme/app/issues/4",
      },
      // 依頼の検索で見つかっても、切り替えを切っていれば取り込まない（後で確かめる）
    ]);
    expect(created.map((t) => [t.source?.number, t.source?.review])).toEqual([
      [1, "requested"],
      [2, "label"],
      [3, "requested"],
    ]);
    // 二度は取り込まない
    expect(
      service.importIssues([
        pr(1, [], { review: "requested", requestedFor: "me" }),
        pr(2, ["sacty-review"]),
      ]),
    ).toEqual([]);
    service.saveSettings({ reviewLabel: "sacty-review" });
    expect(service.importIssues([pr(5, [], { review: "requested", requestedFor: "me" })])).toEqual(
      [],
    );
    activity.close();
  });

  it("依頼は、担当のプロジェクトでそのホストに選んだ本人への依頼だけを取り込む（レビュー指摘）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ reviewRequested: true });
    const projects = new MemoryProjectStore();
    // Org のプロジェクトは alice、その中のリポジトリのプロジェクトは bob
    projects.put("org", {
      name: "Org",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
      githubAccounts: { "github.com": "alice" },
    });
    projects.put("repo", {
      name: "リポジトリ",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "Bob" },
    });
    const { service } = makeService(activity, [], { settings, projects });
    const created = service.importIssues([
      // alice への依頼が Org の検索で見つかったが、acme/app の担当は bob のプロジェクト
      pr(20, [], { review: "requested", requestedFor: "alice" }),
      // bob への依頼（大文字・小文字は区別しない）
      pr(21, [], { review: "requested", requestedFor: "bob" }),
      // 誰への依頼かが分からないものは取り込まない
      pr(22, [], { review: "requested" }),
      // alice の担当のリポジトリ
      {
        ...pr(23, [], { review: "requested", requestedFor: "alice" }),
        repo: "https://github.com/acme/web",
        url: "https://github.com/acme/web/pull/23",
      },
    ]);
    expect(created.map((t) => [t.projectId, t.source?.repo, t.source?.number])).toEqual([
      ["repo", "https://github.com/acme/app", 21],
      ["org", "https://github.com/acme/web", 23],
    ]);
    activity.close();
  });

  it("プロジェクトの対象で指定したイメージを、レビューだけの工程にも使い、無い名前なら止まる（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const java = {
      name: "java",
      image: "sacty-agent-java:test",
      description: "Java",
      baseImage: "java",
      env: { MAVEN_OPTS: "-Xmx1g" },
    };
    const projects = new MemoryProjectStore();
    const put = (image: string) =>
      projects.put("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app", image }],
        githubAccounts: { "github.com": "me" },
      });
    put("java");
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 30, url: "https://github.com/acme/app/pull/30" };
    const { service, executor } = makeService(activity, [out("# 評価")], {
      pulls,
      projects,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
      config: () => ({
        ok: true,
        config: {
          ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
          images: { java },
        },
      }),
    });
    const [task] = service.importIssues([pr(30, ["sacty-review"])]);
    await service.runNext(task?.id ?? "");
    const chosen = service.get(task?.id ?? "")?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.image).toBe("java");
    expect(executor.images[0]).toEqual({ image: java.image, env: java.env });

    // 無い名前を指定していたら、工程を決めずに止まる
    put("python");
    const [other] = service.importIssues([pr(31, ["sacty-review"])]);
    await service.runNext(other?.id ?? "");
    const stopped = service.get(other?.id ?? "")?.task;
    expect(stopped?.status).toBe("paused");
    expect(stopped?.steps).toEqual([]);
    expect(ja(stopped?.pausedMessage)).toContain("イメージ「python」");
    activity.close();
  });

  describe("images があり、イメージを決めていないときは、レビューの工程のイメージだけをオーケストレーターに選ばせる", () => {
    const java = {
      name: "java",
      image: "sacty-agent-java:test",
      description: "Java 17・Maven",
      baseImage: "java",
      env: { MAVEN_OPTS: "-Xmx1g" },
    };
    const withImages = (): (() => ConfigResult) => () => ({
      ok: true,
      config: {
        ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
        images: { java },
      },
    });
    const answer = (body: Record<string, unknown>) =>
      out(`\`\`\`json\n${JSON.stringify({ "sacty-review-image": body })}\n\`\`\``);
    const run = async (outcomes: AgentOutcome[], db = dbPath) => {
      const activity = new SqliteActivityStore(db);
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 40, url: "https://github.com/acme/app/pull/40" };
      const made = makeService(activity, outcomes, {
        pulls,
        settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
        config: withImages(),
      });
      const [task] = made.service.importIssues([pr(40, ["sacty-review"])]);
      const id = task?.id ?? "";
      await made.service.runNext(id);
      const chosen = made.service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      return { ...made, activity, id, chosen };
    };

    it("選んだイメージでレビューを実行し、オーケストレーターの記録にする（費用も記録する）", async () => {
      const { service, executor, activity, id, chosen } = await run([
        answer({ image: "java", reason: "pom.xml が Java 17" }),
        out("# 評価"),
      ]);
      const prompt = executor.calls[0]?.command.join(" ") ?? "";
      expect(prompt).toContain("レビューの工程で使う実行のイメージを選んでください");
      expect(prompt).toContain("- java：Java 17・Maven");
      expect(chosen?.actor).toBe("orchestrator");
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        steps: ["review"],
        plan: "review",
        image: "java",
        imageSource: "orchestrator",
        imageReason: "pom.xml が Java 17",
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "imageUnexplained",
      );
      expect(ja(chosen?.type === "StepsChosen" ? chosen.payload.reason : undefined)).toBe(
        "レビュー用のラベルの付いた PR なので、レビューだけを行います（オーケストレーターは、レビューの工程のイメージだけを選びます）。",
      );
      // オーケストレーターは既定のイメージ、レビューは選んだイメージ
      expect(executor.images.slice(0, 2)).toEqual([
        { image: "sacty-agent:test" },
        { image: java.image, env: java.env },
      ]);
      expect(executor.calls[1]?.command.join(" ")).toContain("レビューエージェント");
      expect(service.get(id)?.task.steps.map((step) => step.key)).toEqual(["review"]);
      activity.close();
    });

    it("レビューを依頼された PR のレビューのタスクも、オーケストレーターがイメージを選ぶ（親のイメージの決め方は使わない）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 41, url: "https://github.com/acme/app/pull/41" };
      const made = makeService(
        activity,
        [answer({ image: "java", reason: "pom.xml が Java 17" }), out("# 評価")],
        {
          pulls,
          settings: new MemorySettingsStore({ reviewRequested: true }),
          config: withImages(),
        },
      );
      const [task] = made.service.importIssues([
        { ...pr(41, []), review: "requested" as const, requestedFor: "me" },
      ]);
      const id = task?.id ?? "";
      expect(made.service.get(id)?.task.source?.review).toBe("requested");
      await made.service.runNext(id);
      const chosen = made.service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(made.executor.calls[0]?.command.join(" ")).toContain(
        "レビューの工程で使う実行のイメージを選んでください",
      );
      expect(chosen?.actor).toBe("orchestrator");
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        image: "java",
        imageSource: "orchestrator",
      });
      activity.close();
    });

    it("既定のイメージを選んだら、合わない理由か、理由が無いことを記録する（PBI-105）", async () => {
      const first = await run([
        answer({ image: "default", reason: "r", defaultReason: "Rust で、合うものが無い" }),
      ]);
      expect(first.chosen?.type === "StepsChosen" && first.chosen.payload).toMatchObject({
        image: "default",
        defaultImageReason: "Rust で、合うものが無い",
      });
      first.activity.close();
      const second = await run([answer({ image: "default" })], join(dir, "second.db"));
      expect(second.chosen?.type === "StepsChosen" && second.chosen.payload).toMatchObject({
        imageUnexplained: true,
      });
      second.activity.close();
    });

    it("答えを読めない・images に無い名前なら、工程を決めずに止まる", async () => {
      const unreadable = await run([out("選べませんでした")]);
      const stopped = unreadable.service.get(unreadable.id)?.task;
      expect(stopped?.status).toBe("paused");
      expect(stopped?.steps).toEqual([]);
      expect(
        unreadable.service
          .get(unreadable.id)
          ?.activity.some((e) => e.type === "OrchestratorFailed"),
      ).toBe(true);
      unreadable.activity.close();
      const unknown = await run([answer({ image: "python" })], join(dir, "second.db"));
      const paused = unknown.service.get(unknown.id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.steps).toEqual([]);
      expect(ja(paused?.pausedMessage)).toContain("イメージ「python」");
      unknown.activity.close();
    });

    it("images に無い名前を答えたら、代わりのエージェントで選び直してレビューする（PR #180 レビュー指摘）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const main = agent({ fallback: ["claude-api"] });
      const backup = agent({
        id: "claude-api",
        auth: { mode: "api-key", secret: "anthropic-key" },
      });
      const config = (): ConfigResult => {
        const base = withImages()();
        return base.ok
          ? {
              ok: true,
              config: {
                ...base.config,
                defaultAgent: main,
                guardianAgent: main,
                agents: { [main.id]: main, [backup.id]: backup },
              },
            }
          : base;
      };
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 41, url: "https://github.com/acme/app/pull/41" };
      const { service, executor } = makeService(
        activity,
        [answer({ image: "python" }), answer({ image: "java", reason: "pom.xml" }), out("# 評価")],
        {
          pulls,
          config,
          settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
          secrets: { "claude-oauth-token": "oauth-secret", "anthropic-key": "sk-ant-secret" },
        },
      );
      const [task] = service.importIssues([pr(41, ["sacty-review"])]);
      const id = task?.id ?? "";
      await service.runNext(id);
      const events = service.get(id)?.activity ?? [];
      const failed = events.find((e) => e.type === "OrchestratorFailed");
      expect(failed?.type === "OrchestratorFailed" && failed.payload.runId).toBeTruthy();
      expect(events.find((e) => e.type === "AgentFellBack")?.payload).toMatchObject({
        role: "orchestrator",
        agentId: "claude-subscription",
        fallbackAgentId: "claude-api",
      });
      expect(service.get(id)?.task.status).toBe("queued");
      await service.runNext(id);
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        image: "java",
        agentId: "claude-api",
      });
      expect(executor.calls[1]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(executor.calls[2]?.command.join(" ")).toContain("レビューエージェント");
      expect(executor.images[2]).toEqual({ image: java.image, env: java.env });
      activity.close();
    });
  });

  it("取り込むラベルとレビュー用のラベルの両方が付いた PR は、レビューだけのタスクにする。Issue の取り込みはこれまでどおり", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ intakeLabel: "sacty", reviewLabel: "sacty-review" });
    const { service } = makeService(activity, [], { settings });
    const created = service.importIssues([
      pr(6, ["sacty"]),
      pr(6, ["sacty", "sacty-review"], { review: "label" }),
      { ...pr(7, ["sacty"]), pullRequest: undefined, url: "https://github.com/acme/app/issues/7" },
    ]);
    expect(created.map((t) => [t.source?.number, t.source?.kind, t.source?.review])).toEqual([
      [6, "github_pull_request", "label"],
      [7, "github_issue", undefined],
    ]);
    activity.close();
  });

  it("レビューの取り込みのタスクは、オーケストレーターを使わずにレビューだけを行い、PR に投稿する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 8, url: "https://github.com/acme/app/pull/8" };
    const settings = new MemorySettingsStore({ reviewRequested: true });
    const { service, executor } = makeService(activity, [out("# 評価")], {
      pulls,
      settings,
      realPlanner: true,
    });
    const [task] = service.importIssues([pr(8, [], { review: "requested", requestedFor: "me" })]);
    const id = task?.id ?? "";
    await service.runNext(id);
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.actor).toBe("sacty");
    expect(chosen?.type === "StepsChosen" && chosen.payload.steps).toEqual(["review"]);
    expect(ja(chosen?.type === "StepsChosen" ? chosen.payload.reason : undefined)).toBe(
      "自分にレビューが依頼された PR なので、レビューだけを行います（オーケストレーターは使いません）。",
    );
    // エージェントの実行はレビューの1回だけ（オーケストレーターは動かさない）
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.command.join(" ")).toContain("レビューエージェント");
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(service.get(id)?.task.reviewPost).toBeDefined();
    activity.close();
  });

  it("PR がマージ・クローズされたら、終わっていないレビューのタスクを中止する。完了したタスクと開いている PR はそのまま", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review", intakeLabel: "sacty" });
    const { service } = makeService(activity, [], { pulls, settings });
    const [merged, closed, issueTask] = service.importIssues([
      pr(10, ["sacty-review"]),
      pr(11, ["sacty-review"]),
      // 取り込むラベルの PR（レビューの取り込みではない）は、ここでは中止しない
      pr(12, ["sacty"]),
    ]);
    pulls.state = { state: "open" };
    await service.checkPullRequests();
    expect(service.get(merged?.id ?? "")?.task.status).not.toBe("cancelled");

    pulls.state = { state: "merged" };
    await service.checkPullRequests();
    const cancelled = service.get(merged?.id ?? "");
    expect(cancelled?.task.status).toBe("cancelled");
    const event = cancelled?.activity.find((e) => e.type === "TaskCancelled");
    expect(event?.actor).toBe("sacty");
    expect(event?.type === "TaskCancelled" && event.payload.reason).toBe("pull_request_merged");
    expect(service.get(closed?.id ?? "")?.task.status).toBe("cancelled");
    expect(service.get(issueTask?.id ?? "")?.task.status).not.toBe("cancelled");

    pulls.state = { state: "closed" };
    const [another] = service.importIssues([pr(13, ["sacty-review"])]);
    await service.checkPullRequests();
    const closedEvent = service
      .get(another?.id ?? "")
      ?.activity.find((e) => e.type === "TaskCancelled");
    expect(closedEvent?.type === "TaskCancelled" && closedEvent.payload.reason).toBe(
      "pull_request_closed",
    );
    activity.close();
  });

  it("再レビューで、PR の最新のコミットをもう一度レビューして投稿する。投稿して完了したタスクだけ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review" });
    const { service } = makeService(activity, [out("# 1回目"), out("# 2回目")], {
      pulls,
      settings,
    });
    const [task] = service.importIssues([pr(9, ["sacty-review"])]);
    const id = task?.id ?? "";
    // 投稿する前は、再レビューできない
    expect(() => service.rereview(id)).toThrow(/再レビューできるのは/);
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);

    // PR に新しいコミットが積まれた
    pulls.prInfo = { ...pulls.prInfo, headSha: "n".repeat(40) };
    const restarted = service.rereview(id);
    expect(restarted.status).toBe("queued");
    expect(restarted.reviewRound).toBe(2);
    expect(restarted.reviewPost).toBeUndefined();
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(2);
    expect(pulls.reviews[1]?.commit).toBe("n".repeat(40));
    expect(pulls.reviews[1]?.body).toContain("# 2回目");
    // 回ごとに別の目印（前回のレビューを、今回の投稿済みと見なさない）
    expect(pulls.reviews[1]?.body).toContain(`<!-- sacty-review:${id}:2 -->`);
    expect(service.get(id)?.activity.some((e) => e.type === "ReviewRestarted")).toBe(true);
    activity.close();
  });

  it("派生で作ったタスクの再実行は、元のタスクを再レビューで完了でなくした後も、説明を空にして重ねても、元のタスクと記録を保つ（PR #242 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review" });
    const { service } = makeService(activity, [out(`# レビュー\n${"あ".repeat(6000)}`)], {
      pulls,
      settings,
    });
    const [task] = service.importIssues([pr(9, ["sacty-review"])]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.runNext(id);
    const derived = service.deriveTask(id, { title: "指摘を直す", body: "直す", repo: null });
    const record = derived.derivedFrom?.record ?? "";
    expect(record).toContain(DERIVE_RECORD_HEADING);
    await service.cancel(derived.id);
    // 元のタスクを再レビューで完了でなくする（派生はできなくなる）
    service.rereview(id);
    expect(service.get(id)?.task.status).toBe("queued");
    // 説明を空にして再実行する（記録が説明の先頭に来る）
    const first = service.rerunTask(derived.id, { title: "指摘を直す", body: "", repo: null });
    expect(first.derivedFrom).toEqual({ taskId: id, record });
    expect(first.body.startsWith(record)).toBe(true);
    expect(rerunEditableBody(first)).toBe("");
    await service.cancel(first.id);
    // 画面の初期値（空）のまま、もう一度再実行できる
    const second = service.rerunTask(first.id, {
      title: "指摘を直す",
      body: rerunEditableBody(service.get(first.id)?.task as Task),
      repo: null,
    });
    expect(second.derivedFrom).toEqual({ taskId: id, record });
    expect(rerunEditableBody(second)).toBe("");
    expect(service.get(id)?.task.derivedTasks).toEqual([derived.id, first.id, second.id]);
    activity.close();
  });

  it("再レビューには、sacty が作者のアカウントで投稿した指摘への返信（行への返信・PR のコメント）が、作者の返答として渡る。既存のレビューでも作者の投稿として渡る（PBI-352）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review" });
    const { service, executor } = makeService(activity, [out("# 1回目"), out("# 2回目")], {
      pulls,
      settings,
    });
    const [task] = service.importIssues([pr(9, ["sacty-review"])]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.runNext(id);
    const postedAt = Date.parse(service.get(id)?.task.reviewPost?.at ?? "");
    const at = new Date(postedAt + 60_000).toISOString();
    // 実装のタスク（t-impl）の返信。PR の作者（sacty が PR を作ったアカウント）の投稿
    const declined = buildRemarkReply({
      taskId: "t-impl",
      stepName: "実装",
      remarkId: "implement-1-2",
      submission: 2,
      text: "再開のフォームの候補は、この子タスクの範囲の外です（後続の子タスクで対応します）",
      status: "declined",
      secrets: [],
    });
    const addressed = buildRemarkReply({
      taskId: "t-impl",
      stepName: "実装",
      remarkId: "implement-1-1",
      submission: 2,
      text: "上限を足しました",
      status: "addressed",
      secrets: [],
    });
    pulls.feedbackBy[9] = [
      {
        key: "review_comment:11",
        kind: "review_comment",
        author: "alice",
        at,
        path: "src/retry.ts",
        line: 2,
        body: addressed,
      },
      { key: "comment:12", kind: "comment", author: "alice", at, body: declined },
      { key: "comment:13", kind: "comment", author: "bob", at, body: "ほかの人のコメント" },
    ];
    service.rereview(id);
    await service.runNext(id);
    // レビューの工程に渡す読み取りだけが、sacty の返信を含める
    expect(pulls.feedbackIncludeSactyReplies).toEqual([true, true]);
    const prompt =
      executor.calls
        .map((c) => c.command.join(" "))
        .filter((c) => c.includes("レビューエージェント"))[1] ?? "";
    expect(prompt).toContain(
      "作者が「対象外」「後続で対応」と返した論点は、範囲が変わるか、今回の変更が直接の原因になっていない限り、もう一度指摘しない",
    );
    const json = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"previousReview"')) ?? "{}",
    );
    expect(json.authorReplies).toEqual([
      // この PR を扱うタスクの ID（t-impl は、このテストの中のタスクではない）と目印が一致しないので、sacty の返信とは読まない
      {
        kind: "review_comment",
        by: "unverified",
        at,
        path: "src/retry.ts",
        line: 2,
        body: addressed,
      },
      { kind: "comment", by: "unverified", at, body: declined },
    ]);
    expect(json.authorReplies[1].body).toContain("**対応していません。** 理由：");
    // 既存のレビューでは、作者（alice）の投稿として渡る（ほかのレビュアーの指摘にならない）
    const existing = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"existingReviews"')) ?? "{}",
    );
    expect(
      existing.existingReviews.map((r: { author: string; body: string }) => [r.author, r.body]),
    ).toEqual([
      ["alice", addressed],
      ["alice", declined],
      ["bob", "ほかの人のコメント"],
    ]);
    activity.close();
  });

  it("再レビューでは、前回の指摘と、前回の投稿の後の PR の作者の返答だけをプロンプトに渡す（PBI-111）。既存のレビューは初回から渡す（PBI-144）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review" });
    const first = [
      "# 1回目",
      `\`\`\`json\n${JSON.stringify({
        "sacty-review-comments": [
          { path: "src/retry.ts", line: 2, severity: "must", body: "上限が無い" },
        ],
        "sacty-review-verdict": { verdict: "changes_required" },
      })}\n\`\`\``,
    ].join("\n\n");
    const { service, executor } = makeService(
      activity,
      [out(first), out("# 2回目"), out("# 3回目"), out("# 4回目")],
      { pulls, settings },
    );
    const promptOf = (_: unknown, i: number) =>
      executor.calls
        .map((c) => c.command.join(" "))
        .filter((c) => c.includes("レビューエージェント"))[i] ?? "";
    const [task] = service.importIssues([pr(9, ["sacty-review"])]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.runNext(id);
    // 最初のレビューには、再レビューの指示は無い。PR にすでにあるレビューは、初回から読んで渡す（PBI-144）
    expect(promptOf(executor, 0)).not.toContain("--- 再レビュー ---");
    expect(promptOf(executor, 0)).toContain("--- PR の既存のレビュー ---");
    expect(promptOf(executor, 0)).toContain("PR には、まだレビュー・コメントがありません");
    expect(pulls.feedbackNumbers).toEqual([9]);
    // 本文のある承認のレビュー（「承認するが、ここは直してほしい」）も既存の指摘として読む（PR #161 レビュー指摘）
    expect(pulls.feedbackIncludeApprovals).toEqual([true]);
    const postedAt = Date.parse(service.get(id)?.task.reviewPost?.at ?? "");
    const at = (offset: number) => new Date(postedAt + offset).toISOString();
    const reply = (key: string, patch: Partial<PullRequestFeedback>): PullRequestFeedback => ({
      key,
      kind: "comment",
      author: "alice",
      at: at(60_000),
      body: key,
      ...patch,
    });
    pulls.feedbackBy[9] = [
      reply("前回より前の作者のコメント", { at: at(-60_000) }),
      reply("直しました", { kind: "review_comment", path: "src/retry.ts", line: 2 }),
      reply("ほかの人のコメント", { author: "bob" }),
      reply("目印", { body: `<!-- sacty-review:${id} -->\n写し` }),
      // login の大文字・小文字は区別しない
      reply("後続で対応します", { author: "Alice" }),
    ];
    service.rereview(id);
    await service.runNext(id);
    const prompt = promptOf(executor, 1);
    expect(prompt).toContain("--- 再レビュー ---");
    const json = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"previousReview"')) ?? "{}",
    );
    expect(json.previousReview).toMatchObject({
      body: "# 1回目",
      commit: "h".repeat(40),
      comments: [{ path: "src/retry.ts", line: 2, body: "[要修正] 上限が無い" }],
    });
    expect(json.authorReplies.map((r: { body: string }) => r.body)).toEqual([
      "直しました",
      "後続で対応します",
    ]);
    expect(json.authorReplies[0]).toMatchObject({ kind: "review_comment", path: "src/retry.ts" });
    // 既存のレビューは、作者のものも他の人のものも、前回の投稿より前のものも渡す（自分の前回の投稿は含まない）
    const existing = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"existingReviews"')) ?? "{}",
    );
    expect(
      existing.existingReviews.map((r: { author: string; body: string }) => [r.author, r.body]),
    ).toEqual([
      ["alice", "前回より前の作者のコメント"],
      ["alice", "直しました"],
      ["bob", "ほかの人のコメント"],
      ["alice", `<!-- sacty-review:${id} -->\n写し`],
      ["Alice", "後続で対応します"],
    ]);
    expect(prompt).toContain(
      "既存の指摘と同じ箇所・同じ問題（言い換えを含む）は、新しい指摘として繰り返さない",
    );
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(2);

    // 返答を読めなくても、再レビューは止めずに、読めなかったことを伝える
    pulls.feedback = async () => {
      throw new Error("401 Bad credentials (token ghp_secret)");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.rereview(id);
    await service.runNext(id);
    const unreadable = promptOf(executor, 2);
    expect(unreadable).toContain("PR の作者の返答は読めませんでした");
    expect(unreadable).toContain("PR にすでにあるレビュー・コメントは読めませんでした");
    expect(unreadable).not.toContain("existingReviews");
    // 運用する人のために、タスクと PR と理由をデーモンのログに残す。秘密の値は伏せる（PR 121 レビュー指摘）
    const logged = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("作者の返答"));
    warn.mockRestore();
    expect(logged).toContain(`レビューのタスク ${id}`);
    expect(logged).toContain("PR #9（https://github.com/acme/app）");
    expect(logged).toContain("401 Bad credentials");
    expect(logged).not.toContain("ghp_secret");
    expect(unreadable).not.toContain("401");
    // 前回（2回目）の本文を、前回の指摘として渡す
    expect(unreadable).toContain('"body":"# 2回目"');
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(3);

    // 作者が分からなければ、返答を選べないので読めなかったものとする（既存のレビューは読んで渡す）
    const before = pulls.feedbackNumbers.length;
    pulls.feedback = FakePulls.prototype.feedback;
    pulls.prInfo = { ...pulls.prInfo, author: "" };
    service.rereview(id);
    await service.runNext(id);
    expect(promptOf(executor, 3)).toContain("PR の作者の返答は読めませんでした");
    expect(promptOf(executor, 3)).toContain('{"existingReviews"');
    expect(pulls.feedbackNumbers.length).toBe(before + 1);
    activity.close();
  });
});

describe("プロジェクトと GitHub Issue の取り込み（PBI-5a）", () => {
  const issue = (repo: string, number: number, labels: string[], title = `Issue ${number}`) => ({
    repo,
    number,
    title,
    body: "Issue の本文",
    url: `${repo}/issues/${number}`,
    labels,
  });

  function setup(
    outcomes: AgentOutcome[] = [],
    options: { config?: () => ConfigResult; github?: FakeGitHub } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    const made = makeService(activity, outcomes, {
      projects,
      settings: new MemorySettingsStore({ intakeLabel: "sacty" }),
      ...options,
    });
    const pay = made.service.saveProject(undefined, {
      name: "決済",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "org", target: "https://github.com/acme" }],
    });
    const auth = made.service.saveProject(undefined, {
      name: "認証",
      targets: [{ scope: "repo", target: "https://github.com/acme/auth" }],
    });
    return { activity, ...made, pay, auth };
  }

  it("既定のプロジェクトは作らず、取り込み元が重複するプロジェクトは作れない（PBI-22）", () => {
    const { activity, service } = setup();
    expect(service.listProjects().map((p) => p.name)).toEqual(["決済", "認証"]);
    expect(() =>
      service.saveProject(undefined, {
        name: "重複",
        targets: [{ scope: "org", target: "https://github.com/ACME" }],
      }),
    ).toThrow(/プロジェクト「決済」に登録されています/);
    expect(() => service.saveProject("no-such", { name: "x" })).toThrow(/見つかりません/);
    activity.close();
  });

  it("画面のタスクは、指定したプロジェクトに作る（無いプロジェクトは拒否する。PBI-4a）", () => {
    const { activity, service, pay, auth } = setup();
    const a = service.createTask({
      title: "A",
      projectId: pay.id,
      repo: "https://github.com/acme/payments",
    });
    expect(a.projectId).toBe(pay.id);
    expect(a.repo).toBe("https://github.com/acme/payments");
    // 対象がリポジトリ1つだけなら、選ばなくてもそれが対象リポジトリになる（PBI-25）
    expect(service.createTask({ projectId: auth.id, title: "B" }).repo).toBe(
      "https://github.com/acme/auth",
    );
    // 対象が無いプロジェクトには作れない（PBI-25）
    const empty = service.saveProject(undefined, { name: "空" });
    expect(() => service.createTask({ projectId: empty.id, title: "E" })).toThrow(
      /対象（Org・リポジトリ）がありません/,
    );
    // 作るプロジェクトを省略すると作らない（既定のプロジェクトは無い。PBI-22）
    expect(() => service.createTask({ title: "D" })).toThrow();
    expect(
      service
        .list()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(() => service.createTask({ title: "C", projectId: "no-such" })).toThrow(
      /プロジェクトが見つかりません/,
    );
    activity.close();
  });

  it("Org の設定画面に、ほかのプロジェクトが担当している除外リポジトリを出す", () => {
    const { activity, service, pay } = setup();
    expect(service.getProject(pay.id)?.exclusions).toEqual([
      {
        org: "https://github.com/acme",
        repos: [{ repo: "https://github.com/acme/auth", projectName: "認証" }],
      },
    ]);
    activity.close();
  });

  it("対象ごとに検索し、取り込むラベルが付いた Issue だけを、担当のプロジェクトに二重にならないよう取り込む", () => {
    const { activity, service, pay, auth } = setup();
    // 検索には、プロジェクトに選んだ gh のアカウントを使う（PBI-13）。選んでいなければアカウントは無い。
    // ラベルは、sacty 全体の設定にするまで（PBI-26）、すべての対象で sacty（PBI-25）
    expect(service.intakeSources()).toEqual([
      {
        host: "github.com",
        query: 'is:open is:issue org:acme label:"sacty"',
        account: "me",
        project: "決済",
      },
      {
        host: "github.com",
        query: 'is:open is:issue repo:acme/auth label:"sacty"',
        project: "認証",
      },
    ]);
    const created = service.importIssues([
      issue("https://github.com/acme/payments", 1, ["sacty"], "冪等性キー"),
      issue("https://github.com/acme/payments", 2, ["bug"]), // ラベルが違う
      issue("https://github.com/acme/auth", 3, ["SACTY"]), // リポジトリ単位の担当（認証）が優先する
      issue("https://github.com/other/repo", 5, ["sacty"]), // どのプロジェクトも担当していない
      issue("https://github.com/acme/payments", 1, ["sacty"]), // 同じ取り込みの中の重複
    ]);
    expect(created.map((t) => [t.projectId, t.source?.repo, t.source?.number])).toEqual([
      [pay.id, "https://github.com/acme/payments", 1],
      [auth.id, "https://github.com/acme/auth", 3],
    ]);
    expect(created[0]).toMatchObject({
      title: "冪等性キー",
      body: "Issue の本文",
      start: "github_issue",
    });
    const activityEvent = service.get(created[0]?.id ?? "")?.activity[0];
    expect(activityEvent?.type === "TaskCreated" && activityEvent.payload.source).toEqual({
      kind: "github_issue",
      repo: "https://github.com/acme/payments",
      number: 1,
      url: "https://github.com/acme/payments/issues/1",
    });
    expect(activityEvent?.projectId).toBe(pay.id);

    // 次の取り込みでも、同じ Issue は取り込まない（大文字・小文字は区別しない）
    expect(service.importIssues([issue("https://github.com/ACME/Payments", 1, ["sacty"])])).toEqual(
      [],
    );
    // 担当の判定は取り込むたびに行う（設定の変更をすぐに反映する）
    service.saveProject(auth.id, { name: "認証", targets: [] });
    expect(
      service.importIssues([issue("https://github.com/acme/auth", 6, ["sacty"])])[0]?.projectId,
    ).toBe(pay.id);
    activity.close();
  });

  it("長い Issue の本文やタイトルも切り詰めずに取り込む（レビュー指摘）", () => {
    const { activity, service } = setup();
    const body = `${"a".repeat(10_000)}\n\n## 必須条件\n- 二重に処理しない`;
    const title = "t".repeat(250);
    const [task] = service.importIssues([
      { ...issue("https://github.com/acme/payments", 12, ["sacty"]), body, title },
    ]);
    expect(task?.body).toBe(body);
    expect(task?.title).toBe(title);
    activity.close();
  });

  it("Issue から作ったタスクは、その Issue のリポジトリの既定のブランチを clone し、オーケストレーターが決めたテストのコマンドを記録する", async () => {
    const { activity, service, repos, executor, id } = await (async () => {
      const made = setup([
        {
          kind: "completed",
          output: "# 要求要件",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
        },
        {
          kind: "completed",
          output: `# 設計\n\n\`\`\`json\n${JSON.stringify({ "sacty-test-viewpoints": [{ title: "a", input: "b", expected: "c" }] })}\n\`\`\``,
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
        },
        {
          kind: "completed",
          output: `# 実装\n\n\`\`\`json\n${JSON.stringify({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["t"] }] })}\n\`\`\``,
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
        },
      ]);
      const [task] = made.service.importIssues([
        issue("https://github.com/acme/payments", 9, ["sacty"]),
      ]);
      return { ...made, id: task?.id ?? "" };
    })();
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    expect(repos.prepared[0]?.url).toBe("https://github.com/acme/payments.git");
    expect(repos.prepared[0]?.baseBranch).toBeUndefined();
    expect(service.get(id)?.task.testCommand).toBe("npm test");
    expect(executor.calls).toHaveLength(3);
    activity.close();
  });

  it("プロジェクトに選んだ gh のアカウントでトークンを取り出し、HTTPS の clone を認証する（PBI-13）", async () => {
    const outcomes: AgentOutcome[] = [
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ];
    // アクティブなアカウントは別のもの。プロジェクトに選んだアカウントのトークンを使う
    const github = new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" });
    const { activity, service, repos, pay } = setup(outcomes, { github });
    service.saveProject(pay.id, { ...pay, githubAccounts: { "github.com": "side-job" } });
    const [task] = service.importIssues([issue("https://github.com/acme/payments", 11, ["sacty"])]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    // clone の認証には、プロジェクトが選んだアカウントの値を使う。
    expect(github.requested).toEqual(["side-job"]);
    expect(repos.prepared[0]?.url).toBe("https://github.com/acme/payments.git");
    // トークンは環境変数でだけ渡し、選んだアカウントのものを使う
    expect(repos.prepared[0]?.authEnv?.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:ghp_side").toString("base64")}`,
    );
    activity.close();
  });

  it("GitHub のアカウントを選んでいないプロジェクトは、アクティブなアカウントを使わずに理由を記録して止める（PBI-13）", async () => {
    const outcomes: AgentOutcome[] = [
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ];
    const github = new FakeGitHub({ me: "ghp_active" });
    const { activity, service, repos, pay } = setup(outcomes, { github });
    // インポートしたプロジェクトなど、アカウントを選んでいない
    const { githubAccounts: _, ...withoutAccount } = pay;
    service.saveProject(pay.id, withoutAccount);
    const [task] = service.importIssues([issue("https://github.com/acme/payments", 13, ["sacty"])]);
    const id = task?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await service.runNext(id);
    expect(github.requested).toEqual([]);
    expect(repos.prepared).toHaveLength(0);
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(service.get(id)?.task.pausedMessage).toEqual({
      code: "github.accountRequired",
      params: { project: "決済", host: "github.com" },
    });
    activity.close();
  });

  it("プロジェクトに選んだ gh のアカウントでログインしていなければ、理由を記録して止める（PBI-13）", async () => {
    const outcomes: AgentOutcome[] = [
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ];
    const other = setup(outcomes, { github: new FakeGitHub({ me: "ghp_active" }) });
    other.service.saveProject(other.pay.id, {
      ...other.pay,
      githubAccounts: { "github.com": "side-job" },
    });
    const [t2] = other.service.importIssues([
      issue("https://github.com/acme/payments", 12, ["sacty"]),
    ]);
    const id2 = t2?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await other.service.runNext(id2);
    expect(other.service.get(id2)?.task.pausedReason).toBe("error");
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(other.service.get(id2)?.task.pausedMessage).toEqual({
      code: "github.accountUnavailable",
      params: { account: "side-job", host: "github.com" },
    });
    expect(other.repos.prepared).toHaveLength(0);
    other.activity.close();
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  it("エクスポートした定義を、新しいプロジェクトとしてインポートでき、重複していれば拒否する", () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    const { service } = makeService(activity, [], { projects });
    const pay = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
    });
    const exported = service.exportProject(pay.id);
    expect(service.exportProject("no-such")).toBeUndefined();

    // 同じ取り込み元のプロジェクトがあるあいだは、インポートできない
    expect(() => service.importProject(exported)).toThrow(/プロジェクト「決済」に登録されています/);
    expect(service.listProjects()).toHaveLength(1);

    // 別の sacty（取り込み元が重複しない環境）へは、新しいプロジェクトとしてインポートできる
    const other = makeService(new SqliteActivityStore(join(dir, "other.db")), [], {
      projects: new MemoryProjectStore(),
    });
    const imported = other.service.importProject(JSON.parse(JSON.stringify(exported)));
    expect(imported.id).not.toBe(pay.id);
    expect(imported).toMatchObject({
      name: "決済",
      targets: pay.targets,
    });
    activity.close();
  });
});

describe("プロジェクトの削除", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };

  it("終わっていないタスクがあれば拒否し、中止した後は削除できる（タスクは残す）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    const { service } = makeService(activity, [], { projects });
    const pay = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
    });
    const app = createApp(service, token);
    const remove = (id: string) =>
      app.request(`/api/projects/${id}`, { method: "DELETE", headers: auth });

    expect((await remove("no-such")).status).toBe(404);

    const task = service.createTask({ projectId: pay.id, title: "A" });
    const refused = await remove(pay.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { messages: unknown[] }).messages).toEqual([
      { code: "project.hasActiveTasks", params: { count: 1 } },
    ]);
    expect(service.getProject(pay.id)).toBeDefined();

    await service.cancel(task.id);
    const deleted = await remove(pay.id);
    expect(deleted.status).toBe(200);
    expect(service.getProject(pay.id)).toBeUndefined();
    expect(service.listProjects()).toHaveLength(0);
    // タスクと作業履歴は残すが、画面の取得（タスクの詳細・実行の記録）では無いものとして返す
    expect(service.get(task.id)).toBeDefined();
    expect((await app.request(`/api/tasks/${task.id}`, { headers: auth })).status).toBe(404);
    // 実行の記録の API も 404 になること（実在する記録で）は、「エージェントの元のセッションのファイル」のテストで確かめる
    activity.close();
  });

  it("SQLite の保存先から消える", () => {
    const store = new SqliteProjectStore(join(dir, "projects.db"));
    store.put("p1", { name: "決済", targets: [] });
    expect(store.delete("p1")).toBe(true);
    expect(store.get("p1")).toBeUndefined();
    expect(store.delete("p1")).toBe(false);
    store.close();
  });
});

describe("Slack の通知先は sacty の設定（PBI-115）", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };
  const destination = {
    kind: "slack-api" as const,
    url: "https://slack.example.com/api/chat.postMessage",
    channel: "#sacty",
    token: "slack-bot",
    language: "ja" as const,
    mention: { targets: ["U0123ABCD"], kinds: ["approval" as const] },
  };

  /** Slack の偽物（送られた本文を記録する）。 */
  const fakeSlack = (status = 200) => {
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return status === 200
        ? Response.json({ ok: true })
        : new Response("xoxb-very-secret down", { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("sacty の設定に通知先を保存・検証でき（API）、テストの通知は保存した送り先に送る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const slack = fakeSlack();
    const projects = projectsWithAccount();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://127.0.0.1:4700",
      fetchImpl: slack.fetchImpl,
    });
    const { service } = makeService(activity, [], { settings, projects, notifier });
    const app = createApp(service, token);
    const put = (body: unknown) =>
      app.request("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const testNotification = () =>
      app.request("/api/settings/notification-test", { method: "POST", headers: auth });
    // 通知先が無ければ、テストの通知は理由を返す
    const none = await testNotification();
    expect(none.status).toBe(409);
    expect(((await none.json()) as { messages: unknown[] }).messages).toEqual([
      { code: "notify.notConfigured" },
    ]);
    // 検査はプロジェクトの設定のときと同じ（秘密情報の値・メンションの形・URL）
    for (const [notification, code] of [
      [{ ...destination, token: "xoxb plain value" }, "input.secretRef"],
      [{ ...destination, mention: { targets: ["@alice"] } }, "input.slackMention"],
      [{ ...destination, url: "nope" }, "input.invalidUrl"],
      [
        { kind: "slack-webhook", webhook: "https://hooks.slack.com/services/T/B/X" },
        "input.secretRef",
      ],
    ] as const) {
      const bad = await put({ intakeLabel: "sacty", notification });
      expect(bad.status).toBe(400);
      expect(
        ((await bad.json()) as { issues: { message: { code: string } }[] }).issues.map(
          (i) => i.message.code,
        ),
      ).toContain(code);
    }
    expect(settings.get().notification).toBeUndefined();
    const saved = await put({ intakeLabel: "sacty", notification: destination });
    expect(saved.status).toBe(200);
    expect(settings.get().notification).toEqual(destination);
    const got = (await (await app.request("/api/settings", { headers: auth })).json()) as {
      settings: { notification?: unknown };
    };
    expect(got.settings.notification).toEqual(destination);
    expect((await testNotification()).status).toBe(200);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.url).toBe(destination.url);
    expect(slack.calls[0]?.auth).toBe("Bearer xoxb-very-secret");
    expect(String(slack.calls[0]?.body.text)).toMatch(
      /^<@U0123ABCD> :wave: sacty からのテストの通知/,
    );
    // プロジェクトのテストの通知の API は無い
    const old = await app.request("/api/projects/default/notification-test", {
      method: "POST",
      headers: auth,
    });
    expect(old.status).toBe(404);
    activity.close();
  });

  it("Slack の通知を Off にしても送り先の設定は残し、送らない。デスクトップ通知の一覧には Off の間も入れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const slack = fakeSlack();
    const projects = projectsWithAccount();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://127.0.0.1:4700",
      fetchImpl: slack.fetchImpl,
    });
    const feed = new NotificationFeed();
    const { service } = makeService(activity, [completed(10)], {
      settings,
      projects,
      notifier,
      feed,
    });
    const app = createApp(service, token);
    const saved = await app.request("/api/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ intakeLabel: "sacty", notification: { ...destination, off: "on" } }),
    });
    expect(saved.status).toBe(200);
    expect(settings.get().notification).toEqual({ ...destination, off: true });
    const reply = async (query = "") =>
      (await (await app.request(`/api/notifications${query}`, { headers: auth })).json()) as {
        boot: string;
        latest: number;
        items: { seq: number; taskId: string; kind: string }[];
      };
    // 最初の問い合わせ（after 無し）は、最後の番号だけを返す
    expect(await reply()).toEqual({ boot: feed.boot, latest: 0, items: [] });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    // 通知を送っていないこと（何も起きないこと）を見る前に、送る処理の続き（マイクロタスクだけで進む）を済ませる
    await loopTurn();
    expect(slack.calls).toHaveLength(0);
    expect(await reply("?after=0")).toMatchObject({
      latest: 1,
      items: [
        { seq: 1, taskId: task.id, projectId: "default", title: "決済API", kind: "approval" },
      ],
    });
    expect(await reply("?after=1")).toMatchObject({ latest: 1, items: [] });
    expect(await reply()).toMatchObject({ latest: 1, items: [] });
    // Off の間も、テストの通知は送れる
    expect(
      (await app.request("/api/settings/notification-test", { method: "POST", headers: auth }))
        .status,
    ).toBe(200);
    expect(slack.calls).toHaveLength(1);
    activity.close();
  });

  it("2つのプロジェクトのタスクの通知が、1つの送り先に、プロジェクトの名前と工程の名前つきで届く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ notification: destination });
    const projects = projectsWithAccount();
    projects.put("search", {
      name: "検索チーム",
      targets: [{ scope: "repo", target: "https://github.com/acme/search" }],
      githubAccounts: { "github.com": "me" },
    });
    const slack = fakeSlack();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://127.0.0.1:4700",
      fetchImpl: slack.fetchImpl,
    });
    const { service } = makeService(activity, [completed(10), completed(10)], {
      settings,
      projects,
      notifier,
    });
    const pay = service.createTask({ projectId: "default", title: "決済API" });
    const search = service.createTask({ projectId: "search", title: "検索の改善" });
    await service.runNext(pay.id);
    await service.runNext(search.id);
    await waitForAssertion(() => expect(slack.calls).toHaveLength(2));
    expect(slack.calls.map((c) => [c.url, c.body.channel])).toEqual([
      [destination.url, "#sacty"],
      [destination.url, "#sacty"],
    ]);
    const [first, second] = slack.calls.map((c) => String(c.body.text));
    expect(first).toContain(`[デフォルト] <http://127.0.0.1:4700/tasks/${pay.id}|決済API>`);
    expect(first).toContain("要求要件の承認を待っています");
    expect(second).toContain(`[検索チーム] <http://127.0.0.1:4700/tasks/${search.id}|検索の改善>`);
    expect(second).toContain("要求要件の承認を待っています");
    // メンションの付け方は、これまでどおり（承認待ちに付ける）
    expect(first?.startsWith("<@U0123ABCD> ")).toBe(true);
    activity.close();
  });

  it("通知が同期的に例外を投げても、書き終えたタスクの操作は成功として返す（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const notifier: NonNullable<ServiceDeps["notifier"]> = {
      notify: () => {
        throw new Error("database is locked");
      },
      test: async () => {},
      problems: () => [],
    };
    const { service } = makeService(activity, [completed(10)], { notifier });
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "決済API" });
    // 承認待ちになる実行（通知する）も、例外にならない
    await expect(service.runNext(task.id)).resolves.not.toThrow();
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    // 人の操作（API）も、成功として返り、作業履歴に1回だけ書く
    const res = await app.request(`/api/tasks/${task.id}/approve`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ step: "requirements", submission: 1 }),
    });
    expect(res.status).toBe(200);
    expect(service.get(task.id)?.activity.filter((e) => e.type === "StepApproved")).toHaveLength(1);
    activity.close();
  });

  it("sacty の設定で通知先を A → B → A と戻すと、変える前の失敗は出さない。通知先を変えない保存では残す（再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const projects = projectsWithAccount();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://x",
      fetchImpl: fakeSlack(500).fetchImpl,
    });
    const { service } = makeService(activity, [], { settings, projects, notifier });
    const app = createApp(service, token);
    const put = (body: unknown) =>
      app.request("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const failed = () =>
      service.status().warnings.filter((w) => typeof w !== "string" && w.code === "notify.failed");
    const b = { ...destination, url: "https://slack-b.example.com/api/chat.postMessage" };
    expect((await put({ notification: destination })).status).toBe(200);
    await expect(service.testNotification()).rejects.toThrow();
    expect(failed()).toHaveLength(1);
    // 通知先を変えない保存（ほかの項目だけ）では、送れなかった理由を残す
    expect((await put({ intakeLabel: "sacty", notification: destination })).status).toBe(200);
    expect(failed()).toHaveLength(1);
    expect((await put({ notification: b })).status).toBe(200);
    expect(failed()).toEqual([]);
    expect((await put({ notification: destination })).status).toBe(200);
    expect(failed()).toEqual([]);
    activity.close();
  });

  it("送れなかった理由は sacty 全体の警告に1つだけ出し（秘密情報は伏せる）、送れたら消す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ notification: destination });
    const projects = projectsWithAccount();
    let slack = fakeSlack(500);
    const lines: string[] = [];
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://x",
      fetchImpl: ((...args: Parameters<typeof fetch>) => slack.fetchImpl(...args)) as typeof fetch,
      log: (line) => lines.push(line),
    });
    const { service } = makeService(activity, [completed(10), completed(10)], {
      settings,
      projects,
      notifier,
    });
    const a = service.createTask({ projectId: "default", title: "A" });
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(a.id);
    await service.runNext(b.id);
    await waitForAssertion(() => expect(slack.calls).toHaveLength(2));
    await waitForAssertion(() =>
      expect(
        service
          .status()
          .warnings.filter((w) => typeof w !== "string" && w.code === "notify.failed"),
      ).toHaveLength(1),
    );
    const shown = [JSON.stringify(service.status()), ...lines].join("\n");
    expect(shown).toContain("HTTP 500");
    expect(shown).not.toContain("xoxb-very-secret");
    // 台帳には、秘密情報も送れなかった理由も残さない
    const ledger = JSON.stringify(service.get(a.id)?.activity);
    expect(ledger).not.toContain("xoxb-very-secret");
    expect(ledger).not.toContain("notify.failed");
    slack = fakeSlack();
    await expect(service.testNotification()).resolves.toBeUndefined();
    expect(service.status().warnings).toEqual([]);
    activity.close();
  });

  it("プロジェクトには通知先を保存しない。古いデータ（通知先を持つプロジェクト）があっても読め、その通知先には送らない", async () => {
    // 以前の sacty が保存したプロジェクトの行（通知先を持つ）を、そのまま DB に置く
    const store = new SqliteProjectStore(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run(
      "old",
      JSON.stringify({
        name: "古いプロジェクト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
        notification: {
          kind: "slack-webhook",
          webhook: "old-webhook",
          language: "en",
          mention: { targets: ["U0OLD0000"], kinds: ["completed"] },
        },
      }),
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    db.close();
    const old = store.get("old");
    expect(old?.name).toBe("古いプロジェクト");
    expect(old).not.toHaveProperty("notification");
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const slack = fakeSlack();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => store.get(id),
      secrets: new MemorySecretStore({ "old-webhook": "https://hooks.slack.com/services/OLD" }),
      webUrl: "http://x",
      fetchImpl: slack.fetchImpl,
    });
    const { service } = makeService(activity, [completed(10)], {
      projects: store as unknown as MemoryProjectStore,
      settings,
      notifier,
    });
    const app = createApp(service, token);
    expect((await app.request("/api/projects/old", { headers: auth })).status).toBe(200);
    expect((await app.request("/api/projects", { headers: auth })).status).toBe(200);
    const exported = await (
      await app.request("/api/projects/old/export", { headers: auth })
    ).text();
    expect(exported).not.toMatch(/notification|old-webhook|U0OLD0000/);
    // 古いプロジェクトの通知先には送らない（sacty の設定に通知先が無いので、どこにも送らない）
    const task = service.createTask({ projectId: "old", title: "古いタスク" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    expect(slack.calls).toEqual([]);
    // 保存で送られた通知先は、保存しない（知らない項目として捨てる）
    const saved = service.saveProject("old", {
      name: "古いプロジェクト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      notification: { kind: "slack-webhook", webhook: "old-webhook" },
    } as unknown as Parameters<typeof service.saveProject>[1]);
    expect(saved).not.toHaveProperty("notification");
    expect(store.get("old")).not.toHaveProperty("notification");
    activity.close();
    store.close();
  });

  it("起動のときと sacty の設定を保存したときに、通知先のトークン・Webhook の URL を取り出し、取り出せなければ設定の警告に出す", async () => {
    class PrefetchStore extends MemorySecretStore {
      prefetched: string[][] = [];
      constructor(readonly available: Record<string, string>) {
        super(available);
      }
      async prefetch(refs: readonly string[]) {
        this.prefetched.push([...refs]);
        return refs
          .filter((ref) => !(ref in this.available))
          .map((ref) => ({ ref, error: new SecretNotFoundError(ref) }));
      }
    }
    const activity = new SqliteActivityStore(dbPath);
    const store = new PrefetchStore({ "claude-oauth-token": "oauth-secret" });
    const settings = new MemorySettingsStore({
      notification: { kind: "slack-webhook", webhook: "op://Work/Slack/webhook", language: "ja" },
    });
    const { service } = makeService(activity, [], { secretStore: store, settings });
    await service.prefetchSecrets();
    expect(store.prefetched.at(-1)).toEqual(["claude-oauth-token", "op://Work/Slack/webhook"]);
    expect(service.status().warnings.map((w) => ja(w))).toEqual([
      expect.stringContaining(
        "起動のときに、秘密情報（Sacty の設定の通知先（Webhook の URL））を取り出せませんでした",
      ),
    ]);
    // 設定を保存し直すと、設定の警告だけを置き換える（API で保存すると取り出す）
    const app = createApp(service, token);
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        notification: {
          kind: "slack-api",
          url: "https://slack.example.com/api/chat.postMessage",
          channel: "#a",
          token: "slack-bot",
        },
      }),
    });
    expect(res.status).toBe(200);
    await waitForAssertion(() => expect(store.prefetched.at(-1)).toEqual(["slack-bot"]));
    await waitForAssertion(() =>
      expect(service.status().warnings.map((w) => ja(w))).toEqual([
        expect.stringContaining(
          "Sacty の設定を保存したときに、秘密情報（Sacty の設定の通知先（Slack のトークン））を取り出せませんでした",
        ),
      ]),
    );
    store.available["slack-bot"] = "xoxb-x";
    await service.prefetchSettingsSecrets();
    expect(service.status().warnings).toEqual([]);
    expect(JSON.stringify(service.status())).not.toContain("xoxb-x");
    // 通知先を外せば、取り出すものは無い
    service.saveSettings({});
    await service.prefetchSettingsSecrets();
    expect(store.prefetched.at(-1)).toEqual([]);
    activity.close();
  });
});

describe("JIRA のチケットの取り込みとトリアージ（PBI-52）", () => {
  const projects = () => {
    const store = new MemoryProjectStore();
    store.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "repo", target: "https://github.com/acme/api" },
      ],
      githubAccounts: { "github.com": "me" },
      tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
    });
    store.put("ops", {
      name: "運用",
      targets: [{ scope: "repo", target: "https://github.com/acme/ops" }],
      githubAccounts: { "github.com": "me" },
      tickets: [
        { platform: "jira", service: "jira-server", keys: ["OPS", "PAY"] },
        { platform: "cloud", service: "jira-cloud", keys: ["WEB"] },
      ],
    });
    return store;
  };
  const setup = (
    outcomes: AgentOutcome[] = [],
    extra: { platforms?: Platform[]; settings?: MemorySettingsStore } = {},
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, outcomes, {
      config: configOf(agent(), 1, extra.platforms ?? [jiraPlatform()]),
      secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
      gateway: fakeGateway(),
      projects: projects(),
      settings: extra.settings ?? new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    return { activity, ...made };
  };

  it("取り込み先を接続先と種類ごとにまとめ、ラベルが無いか Off なら探さない", () => {
    const settings = new MemorySettingsStore({});
    const { activity, service } = setup([], { settings });
    expect(service.ticketSources()).toEqual([]);
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    service.saveSettings({ ticketLabel: " sacty " });
    expect(service.ticketSources()).toEqual([
      { platform: "jira", service: "jira-server", keys: ["OPS", "PAY"], label: "sacty" },
      // ホストの PF に無い接続先は、プロジェクトのコンテキストの PF を引くため、プロジェクトごとにする（PBI-74）
      {
        platform: "cloud",
        service: "jira-cloud",
        keys: ["WEB"],
        label: "sacty",
        projectId: "ops",
      },
    ]);
    service.saveSettings({ ticketLabel: "sacty", triageOff: ["tickets"] });
    expect(service.ticketSources()).toEqual([]);
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    // ラベルは残る
    expect(service.getSettings()).toMatchObject({ ticketLabel: "sacty", triageOff: ["tickets"] });
    activity.close();
  });

  it("書いたキーのチケットだけを、担当のプロジェクトのタスクにし、二度は取り込まない", () => {
    const { activity, service } = setup();
    const created = service.importTickets([
      foundTicket("PAY-1", "決済の再送"),
      foundTicket("PAY-1", "決済の再送"),
      foundTicket("OPS-2"),
      foundTicket("ZZZ-3"),
      { ...foundTicket("WEB-4"), platform: "cloud", service: "jira-cloud" },
    ]);
    expect(created.map((t) => [t.title, t.projectId, t.start, t.repo])).toEqual([
      ["PAY-1 決済の再送", expect.any(String), "jira", undefined],
      ["OPS-2 OPS-2 の要約", "ops", "jira", undefined],
      ["WEB-4 WEB-4 の要約", "ops", "jira", undefined],
    ]);
    expect(created[0]?.ticket).toEqual({
      platform: "jira",
      service: "jira-server",
      key: "PAY-1",
      url: "https://jira.example.com/browse/PAY-1",
    });
    // 同じキーを書いたプロジェクトが複数あっても、1つのタスクだけ
    expect(service.importTickets([foundTicket("PAY-1"), foundTicket("OPS-2")])).toEqual([]);
    // ほかの接続先の同じキーは、別のチケット
    expect(
      service.importTickets([{ ...foundTicket("OPS-2"), platform: "cloud" }]).map((t) => t.title),
    ).toEqual([]);
    activity.close();
  });

  it("オーケストレーターがゲートウェイ経由でチケットを読み、リポジトリ・題・概要を決め、その後に工程を選ぶ", async () => {
    const { activity, service, executor, repos } = setup([
      triageOut({
        repo: "https://github.com/acme/api/",
        title: "PAY-1 決済の再送で二重に請求される",
        summary: "## 目的\n二重請求を防ぐ\n\n## スコープ\nAPI 側の再送の判定だけ",
        reason: "サブタスク。親は決済の改修。API の再送の判定を受け持つ",
      }),
      completed(20_000),
    ]);
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    const id = task?.id ?? "";
    expect(service.queuedTaskIds()).toContain(id);
    await service.runNext(id);
    const triaged = service.get(id)?.task;
    expect(triaged).toMatchObject({
      repo: "https://github.com/acme/api",
      title: "PAY-1 決済の再送で二重に請求される",
      body: "## 目的\n二重請求を防ぐ\n\n## スコープ\nAPI 側の再送の判定だけ",
      ticketTriage: {
        by: "orchestrator",
        reason: "サブタスク。親は決済の改修。API の再送の判定を受け持つ",
      },
      status: "queued",
      steps: [],
    });
    expect(triaged?.budget.usedUsd).toBeGreaterThan(0);
    const call = executor.calls[0];
    const prompt = call?.command.join(" ") ?? "";
    expect(prompt).toContain("PAY-1");
    expect(prompt).toContain("$SACTY_PF_URL/jira");
    expect(prompt).toContain("   - https://github.com/acme/app");
    expect(prompt).toContain("   - https://github.com/acme/api");
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    expect(JSON.stringify(call)).not.toContain("jira-secret");
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("jira-secret");
    // 次の実行で、選んだリポジトリを用意して工程を選ぶ
    await service.runNext(id);
    expect(repos.prepared[0]?.url).toBe("https://github.com/acme/api.git");
    expect(service.get(id)?.task.steps.length).toBeGreaterThan(0);
    activity.close();
  });

  it("選べなければ止まり、人が候補からリポジトリを選ぶと、そのリポジトリでチケットを読み直して題と概要を書く", async () => {
    // 人が選んだ後の読み直し。出力のリポジトリは使わない（人が決めたリポジトリに固定）
    const rewrite = triageOut({
      repo: "https://github.com/acme/api",
      title: "PAY-1 画面の再送ボタンを二重に押せないようにする",
      summary: "## 目的\n二重請求を防ぐ（画面側）",
      reason: "人が選んだリポジトリで書いた",
    });
    for (const bad of [
      triageOut({ repo: "", summary: "読んだ要件", reason: "どのリポジトリか分からない" }),
      triageOut({ repo: "https://github.com/evil/other", reason: "x" }),
      // 候補のリポジトリを選んでも、概要が無ければ止まる（通常の経路）
      triageOut({ repo: "https://github.com/acme/api", title: "PAY-1 題だけ", reason: "x" }),
      { kind: "completed", output: "JSON なし" } as AgentOutcome,
    ]) {
      const { activity, service, executor } = setup([bad, rewrite, completed(20_000)]);
      const [task] = service.importTickets([foundTicket("PAY-1")]);
      const id = task?.id ?? "";
      await service.runNext(id);
      const paused = service.get(id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.repo).toBeUndefined();
      expect(service.get(id)?.activity.map((e) => e.type)).toContain("OrchestratorFailed");
      await expect(
        service.chooseTicketRepository(id, "https://github.com/acme/ops"),
      ).rejects.toThrow();
      await service.chooseTicketRepository(id, "https://github.com/acme/app");
      expect(service.get(id)?.task).toMatchObject({
        repo: "https://github.com/acme/app",
        ticketTriage: { by: "person" },
      });
      service.resume(id, {});
      await service.runNext(id); // 選んだリポジトリで、チケットを読み直す
      const prompt = executor.calls[1]?.command.join(" ") ?? "";
      expect(prompt).toContain("人が次のリポジトリに決めました");
      expect(prompt).toContain("   - https://github.com/acme/app");
      expect(prompt).not.toContain("   - https://github.com/acme/api");
      expect(service.get(id)?.task).toMatchObject({
        repo: "https://github.com/acme/app",
        title: "PAY-1 画面の再送ボタンを二重に押せないようにする",
        body: "## 目的\n二重請求を防ぐ（画面側）",
        ticketTriage: { by: "orchestrator" },
        steps: [],
      });
      await service.runNext(id); // 工程を選ぶ
      expect(executor.calls).toHaveLength(3);
      expect(service.get(id)?.task.steps.length).toBeGreaterThan(0);
      // 工程を選んだ後は、リポジトリを変えられない
      await expect(
        service.chooseTicketRepository(id, "https://github.com/acme/api"),
      ).rejects.toThrow();
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("人が選んだリポジトリで読み直しても要件を書けなければ、工程を選ばずに止まり、選び直せる", async () => {
    const { activity, service, executor } = setup([
      triageOut({ repo: "", reason: "分からない" }),
      // 題だけで概要が無い
      triageOut({
        repo: "https://github.com/acme/app",
        title: "PAY-1 題のみ取得",
        summary: "",
        reason: "要件が読めない",
      }),
      triageOut({
        repo: "",
        title: "PAY-1 API の再送の判定",
        summary: "API 側",
        reason: "選び直したリポジトリで書いた",
      }),
    ]);
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.chooseTicketRepository(id, "https://github.com/acme/app");
    service.resume(id, {});
    await service.runNext(id);
    expect(service.get(id)?.task).toMatchObject({ status: "paused", steps: [] });
    expect(service.get(id)?.task.repository).toBeUndefined();
    // 題も本文も、取り込んだときのまま（読めなかった題を使わない）
    expect(service.get(id)?.task.title).toBe("PAY-1 PAY-1 の要約");
    expect(service.get(id)?.task.ticketTriage?.by).toBe("person");
    // 選び直して再開すると、そのリポジトリで読み直す
    await service.chooseTicketRepository(id, "https://github.com/acme/api");
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls[2]?.command.join(" ")).toContain("   - https://github.com/acme/api");
    expect(service.get(id)?.task).toMatchObject({
      repo: "https://github.com/acme/api",
      title: "PAY-1 API の再送の判定",
      ticketTriage: { by: "orchestrator" },
    });
    activity.close();
  });

  it("接続先が設定に無ければ、チケットを読まずに止まる。チケットでないタスクのリポジトリは選べない", async () => {
    const { activity, service, executor } = setup([], { platforms: [] });
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    await service.runNext(task?.id ?? "");
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task?.id ?? "")?.task.status).toBe("paused");
    expect(ja(service.get(task?.id ?? "")?.task.pausedMessage)).toContain("jira");
    const plain = service.createTask({
      projectId: "default",
      title: "A",
      repo: "https://github.com/acme/app",
    });
    await expect(
      service.chooseTicketRepository(plain.id, "https://github.com/acme/app"),
    ).rejects.toThrow();
    activity.close();
  });
});

describe("レビューの再依頼で、自動で再レビューする（PBI-143）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const pr = (number: number, extra: Record<string, unknown> = {}) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `PR ${number}`,
    body: "本文",
    url: `https://github.com/acme/app/pull/${number}`,
    labels: [] as string[],
    pullRequest: true,
    review: "requested" as const,
    requestedFor: "me",
    ...extra,
  });
  const restarts = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).filter((e) => e.type === "ReviewRestarted");

  /** 依頼で取り込んだ PR 9 のレビューを、投稿して完了させる。 */
  async function posted(now?: () => number, first = "# 1回目") {
    const activity = new SqliteActivityStore(dbPath, now && (() => new Date(now())));
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({
      reviewRequested: true,
      reviewLabel: "sacty-review",
    });
    const projects = projectsWithAccount();
    const { service, executor } = makeService(
      activity,
      [out(first), out("# 2回目"), out("# 3回目")],
      {
        pulls,
        settings,
        projects,
        now,
      },
    );
    const [task] = service.importIssues([pr(9)]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(service.get(id)?.task.reviewPost).toBeDefined();
    return { activity, pulls, settings, projects, service, executor, id };
  }

  /** 最後の投稿から ms 後に、依頼した（再依頼）ことにする。 */
  function requestAfterPost(service: TaskService, pulls: FakePulls, id: string, ms = 60_000) {
    const at = Date.parse(service.get(id)?.task.reviewPost?.at ?? "");
    pulls.lastRequestAt = new Date(at + ms).toISOString();
  }

  it.each([
    ["other", "me"],
    ["me", "other"],
  ])("複数アカウントの結果が %s、%s の順でも、対象への再依頼を1回拾う", async (first, second) => {
    const { activity, pulls, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me", "other"] };
    requestAfterPost(service, pulls, id);
    const { restarted } = await service.restartRerequestedReviews([
      pr(9, { requestedFor: first }),
      pr(9, { requestedFor: second }),
      pr(9),
    ]);
    expect(restarted).toHaveLength(1);
    expect(restarted[0]?.id).not.toBe(id);
    expect(restarted[0]?.previousReview?.body).toBe("# 1回目");
    expect(pulls.lastRequestQueries).toHaveLength(1);
    expect(pulls.lastRequestQueries[0]?.reviewer).toBe("me");
    activity.close();
  });

  it("sacty が作った PR は、以前の版で依頼から取り込んだタスクがあっても、再依頼で別のタスクを作らない（PBI-330 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    pulls.nextNumber = 9;
    const settings = new MemorySettingsStore({ reviewRequested: true });
    const { service } = makeService(activity, [out("# 1回目"), out("# 要求要件")], {
      pulls,
      settings,
      projects: projectsWithAccount(),
      stepPullRequests: true,
      planner: async () => ({
        steps: ["requirements"],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
    });
    // 以前の版：PR 9 を依頼から取り込んでレビューを投稿した
    const [review] = service.importIssues([pr(9)]);
    const reviewId = review?.id ?? "";
    await service.runNext(reviewId);
    await service.runNext(reviewId);
    expect(service.get(reviewId)?.task.reviewPost).toBeDefined();
    // その PR 9 は、sacty のタスクが作った要求要件の PR
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
    await service.runNext(id);
    expect(service.get(id)?.task.stepPullRequests.map((p) => p.number)).toEqual([9]);
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, reviewId);
    expect(await service.restartRerequestedReviews([pr(9)])).toEqual({
      restarted: [],
      failed: [],
    });
    expect(pulls.lastRequestQueries).toEqual([]);
    expect(service.list()).toHaveLength(2);
    activity.close();
  });

  it.each(["Off", "account"])("API待機中に%sへ変更したら、再レビューしない", async (change) => {
    const { activity, pulls, settings, projects, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, id);
    const requestAt = pulls.lastRequestAt;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(pulls, "lastReviewRequest").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return requestAt;
    });
    const pending = service.restartRerequestedReviews([pr(9)]);
    await entered.promise;
    if (change === "Off") settings.put({ reviewRequested: false });
    else {
      const project = projects.get("default");
      if (!project) throw new Error("project missing");
      projects.put(project.id, { ...project, githubAccounts: { "github.com": "other" } });
    }
    release.resolve();
    expect(await pending).toEqual({ restarted: [], failed: [] });
    expect(restarts(service, id)).toEqual([]);
    activity.close();
  });

  it.each([0, 2_000])(
    "API待機中に人の再レビューが%dms後に投稿完了しても、同じ依頼で重ねない",
    async (elapsed) => {
      let now = Date.parse("2026-10-19T00:00:00Z");
      const { activity, pulls, service, id } = await posted(() => now);
      pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
      requestAfterPost(service, pulls, id, 1_000);
      const requestAt = pulls.lastRequestAt;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(pulls, "lastReviewRequest").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return requestAt;
      });
      const pending = service.restartRerequestedReviews([pr(9)]);
      await entered.promise;
      now += elapsed;
      service.rereview(id);
      await service.runNext(id);
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(2);
      expect(service.get(id)?.task.reviewPost?.at).toBe(new Date(now).toISOString());
      release.resolve();
      expect(await pending).toEqual({ restarted: [], failed: [] });
      expect(restarts(service, id)).toHaveLength(1);
      expect(service.get(id)?.task.reviewRound).toBe(2);
      activity.close();
    },
  );

  it("投稿の後に依頼が残っていれば（再依頼）、1回だけ再レビューする。検索に残っていても、今の依頼先に無ければしない", async () => {
    const { activity, pulls, service, executor, id } = await posted();
    // 検索の反映の遅れで、投稿で外れた依頼がまだ見つかる：今の依頼先には無いので再レビューしない
    // （同じ PR が二度見つかっても、確かめるのは1回）
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: [] };
    const first = pulls.prInfoRequests.length;
    expect(await service.restartRerequestedReviews([pr(9), pr(9)])).toEqual({
      restarted: [],
      failed: [],
    });
    expect(pulls.prInfoRequests.length - first).toBe(1);
    expect(restarts(service, id)).toEqual([]);
    expect(pulls.lastRequestQueries).toEqual([]);
    expect(pulls.prInfoRequests.at(-1)).toEqual({
      repo: "https://github.com/acme/app",
      number: 9,
      token: "ghp_secret",
    });

    // 作者が再依頼した（login の大文字・小文字は区別しない。同じ PR が二度見つかっても1回）
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["bob", "Me"] };
    requestAfterPost(service, pulls, id);
    const before = pulls.prInfoRequests.length;
    const { restarted } = await service.restartRerequestedReviews([pr(9), pr(9)]);
    const next = restarted[0];
    if (!next) throw new Error("missing re-review task");
    expect(next.id).not.toBe(id);
    expect(next.status).toBe("queued");
    expect(next.reviewRound).toBe(2);
    expect(next.projectId).toBe(service.get(id)?.task.projectId);
    expect(next.budget.usedUsd).toBe(0);
    expect(next.reviewRerequest?.taskId).toBe(id);
    expect(next.previousReview?.body).toBe("# 1回目");
    expect(pulls.prInfoRequests.length - before).toBe(1);
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    expect(restarts(service, id)).toEqual([]);

    const requests = pulls.prInfoRequests.length;
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    expect(pulls.prInfoRequests).toHaveLength(requests);
    await service.runNext(next.id);
    await service.runNext(next.id);
    expect(pulls.reviews).toHaveLength(2);
    expect(executor.calls.at(-1)?.command).not.toContain("resume");
    expect(executor.calls.at(-1)?.command).not.toContain("--resume");
    expect(pulls.reviews[1]?.body).toContain("# 2回目");
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: [] };
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, next.id, -1_000);
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    // 次の依頼にはさらに別ID。引継ぎ元は初回ではなく最新の投稿。
    pulls.lastRequestAt = new Date(
      Math.max(
        Date.parse(next.reviewRerequest?.requestedAt ?? ""),
        Date.parse(service.get(next.id)?.task.reviewPost?.at ?? ""),
      ) + 60_000,
    ).toISOString();
    const third = (await service.restartRerequestedReviews([pr(9)])).restarted[0];
    expect(third?.id).not.toBe(next.id);
    expect(third?.reviewRerequest?.taskId).toBe(next.id);
    expect(third?.previousReview?.body).toBe("# 2回目");
    expect(third?.reviewRound).toBe(3);
    activity.close();
  });

  it("再依頼で作る新しいタスクに、元のタスクの前回の回のレビューの記録を写し、get_task にも出す（PBI-460）", async () => {
    const record = {
      mode: "subagents",
      viewpoints: [{ id: "C-1", status: "launched" }],
      notReviewed: [{ id: "C-6", reason: "差分を読めなかった" }],
      dismissed: [{ title: "指摘A", reason: "範囲の外" }],
      scope: [],
      verification: [{ kind: "stopped", text: "テストが止まった" }],
    };
    const answer = `# 1回目\n\n\`\`\`sacty-review-record\n${JSON.stringify(record)}\n\`\`\``;
    const { activity, pulls, service, id } = await posted(undefined, answer);
    // 元のタスクの回 1 の記録
    const original = service.get(id)?.task.reviewRecords?.find((r) => r.round === 1)?.record;
    expect(original).toEqual(record);
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, id);
    const { restarted } = await service.restartRerequestedReviews([pr(9)]);
    const next = restarted[0];
    if (!next) throw new Error("missing re-review task");
    // 作業履歴の TaskCreated の previousReview と、新しいタスクの previousReview に、同じ記録がある
    const created = (service.get(next.id)?.activity ?? []).find((e) => e.type === "TaskCreated");
    expect(
      created?.type === "TaskCreated" && created.payload.reviewRerequest?.previousReview.record,
    ).toEqual(original);
    expect(next.previousReview?.record).toEqual(original);
    // 同じ記録が get_task の previousReview にある
    const detail = describeTask({ task: next, activity: [] });
    expect(detail.previousReview?.record).toEqual(original);
    // 元のタスクの回の記録は、新しいタスクには写さない（元のタスクの画面と get_task で読む）
    expect(next.reviewRecords).toBeUndefined();
    activity.close();
  });

  it("再依頼で作る新しいタスクは、前回の記録が無い回（記録を返さなかった元のタスク）でも、欄を作らない", async () => {
    const { activity, pulls, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, id);
    const next = (await service.restartRerequestedReviews([pr(9)])).restarted[0];
    expect(next && "record" in (next.previousReview ?? {})).toBe(false);
    activity.close();
  });

  describe("フォークの PR（PBI-461）", () => {
    const fork = "https://github.com/mallory/app";
    async function forkPosted() {
      const ctx = await posted();
      ctx.pulls.prInfo = {
        ...ctx.pulls.prInfo,
        author: "mallory",
        headRepo: fork,
        requestedReviewers: ["me"],
      };
      requestAfterPost(ctx.service, ctx.pulls, ctx.id);
      return ctx;
    }

    it("フォークの作者が自分で再依頼しても、書き込みの権限があっても、別のタスクを作らない", async () => {
      const { activity, pulls, service, id } = await forkPosted();
      pulls.lastRequester = "Mallory";
      pulls.writers = ["mallory"];
      expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
      expect(restarts(service, id)).toEqual([]);
      activity.close();
    });

    it("フォークの PR を、書き込みの権限がある別の人が再依頼したときは、別のタスクを作る", async () => {
      const { activity, pulls, service, id } = await forkPosted();
      pulls.lastRequester = "maintainer";
      pulls.writers = ["Maintainer"];
      const { restarted } = await service.restartRerequestedReviews([pr(9)]);
      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.reviewRerequest?.taskId).toBe(id);
      activity.close();
    });

    it.each([
      ["権限が無い人", () => ({ lastRequester: "stranger", writers: [] as string[] })],
      ["頼んだ人が分からない", () => ({ lastRequester: undefined, writers: ["maintainer"] })],
      [
        "権限を読めない",
        () => ({ lastRequester: "maintainer", writers: ["maintainer"], permissionFail: "403" }),
      ],
    ])("フォークの PR の再依頼は、%s ときは始めない（みなさない側に倒す）", async (_n, set) => {
      const { activity, pulls, service, id } = await forkPosted();
      Object.assign(pulls, set());
      const result = await service.restartRerequestedReviews([pr(9)]);
      expect(result).toEqual({ restarted: [], failed: [] });
      expect(restarts(service, id)).toEqual([]);
      activity.close();
    });

    it("head のリポジトリを読めない PR も、フォークと同じに扱う", async () => {
      const { activity, pulls, service } = await forkPosted();
      pulls.prInfo = { ...pulls.prInfo, headRepo: undefined };
      pulls.lastRequester = "mallory";
      expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
      activity.close();
    });

    it("同じリポジトリの PR は、頼んだ人を確かめずに再レビューする（変えない）", async () => {
      const { activity, pulls, service, id } = await posted();
      pulls.prInfo = { ...pulls.prInfo, author: "alice", requestedReviewers: ["me"] };
      pulls.lastRequester = "alice";
      pulls.permissionFail = "unused";
      requestAfterPost(service, pulls, id);
      expect((await service.restartRerequestedReviews([pr(9)])).restarted).toHaveLength(1);
      activity.close();
    });
  });

  it("依頼が残っていても、最後の依頼が投稿より前か、依頼のできごとが無ければ、再レビューしない（繰り返さない）", async () => {
    const { activity, pulls, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    // 投稿で依頼が外れなかった（最後の依頼は、取り込んだときのもの）
    requestAfterPost(service, pulls, id, -60_000);
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    // 投稿と同じ時刻の依頼も、再依頼とはみなさない
    requestAfterPost(service, pulls, id, 0);
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    pulls.lastRequestAt = undefined;
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    expect(pulls.lastRequestQueries.at(-1)).toEqual({
      repo: "https://github.com/acme/app",
      number: 9,
      reviewer: "me",
    });
    // 投稿より 1 ミリ秒でも後なら、再依頼
    requestAfterPost(service, pulls, id, 1);
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toHaveLength(1);
    expect(restarts(service, id)).toHaveLength(0);
    activity.close();
  });

  it("元レビューの再開可能セッションが保存されていても、別タスクは新規実行し元ファイルを変えない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const orchestratorSessions = new OrchestratorSessionStore(join(dir, "sessions"));
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const { service, executor } = makeService(activity, [out("# 1回目"), out("# 2回目")], {
      pulls,
      sessionLogs,
      orchestratorSessions,
      settings: new MemorySettingsStore({ reviewRequested: true }),
      projects: projectsWithAccount(),
    });
    executor.sessionFiles = (_, runId) => ({
      [`projects/-workspace/session-${runId}.jsonl`]: `${JSON.stringify({ type: "user", message: "元のレビューセッション" })}\n`,
    });
    const original = service.importIssues([pr(9)])[0];
    if (!original) throw new Error("missing task");
    await service.runNext(original.id);
    await service.runNext(original.id);
    const archived = service
      .get(original.id)
      ?.activity.find((e) => e.type === "AgentSessionArchived");
    if (archived?.type !== "AgentSessionArchived") throw new Error("missing archived session");
    const sourceDir = sessionLogs.agentFilesDir(original.id, archived.payload.runId);
    if (!sourceDir) throw new Error("missing archived files");
    // 実レビューで保存されたファイルを、再開可能なタスク別キャッシュにも用意する。
    expect(
      await orchestratorSessions.save(original.id, {
        agentId: agent().id,
        runtime: "claude-code",
        sessionId: archived.payload.sessionId,
        runId: archived.payload.runId,
        files: archived.payload.files,
        sourceDir,
      }),
    ).toEqual({ saved: true });
    expect(
      await orchestratorSessions.plan(original.id, { agentId: agent().id, runtime: "claude-code" }),
    ).toMatchObject({ mode: "resume", sessionId: archived.payload.sessionId });
    const beforeTask = service.get(original.id);
    const beforeArchive = readTree(sourceDir);
    const beforeSession = readTree(join(dir, "sessions", original.id));
    expect(Object.keys(beforeArchive)).toEqual([
      `projects/-workspace/session-${archived.payload.runId}.jsonl`,
    ]);
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, original.id);
    const next = (await service.restartRerequestedReviews([pr(9)])).restarted[0];
    if (!next) throw new Error("missing re-review task");
    const start = executor.calls.length;
    await service.runNext(next.id);
    await service.runNext(next.id);
    const calls = executor.calls.slice(start);
    expect(calls).toHaveLength(1);
    for (const invocation of calls) {
      expect(invocation.command).not.toContain("resume");
      expect(invocation.command).not.toContain("--resume");
      expect(invocation.stage?.sessionDir).toBeUndefined();
    }
    expect(executor.restored.slice(start)).toEqual([undefined]);
    expect(service.get(original.id)).toEqual(beforeTask);
    expect(readTree(sourceDir)).toEqual(beforeArchive);
    expect(readTree(join(dir, "sessions", original.id))).toEqual(beforeSession);
    expect(orchestratorSessions.has(next.id)).toBe(false);
    expect(pulls.reviews).toHaveLength(2);
    activity.close();
  });

  it("定期取り込みのimported件数に実際に作成した再依頼タスクだけを加算する", async () => {
    const { activity, pulls, service, settings, id } = await posted();
    settings.put({ reviewRequested: true });
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    requestAfterPost(service, pulls, id);
    const intake = new IssueIntake(
      service,
      { search: async () => ({ issues: [pr(9)] }) },
      new FakeGitHub(),
      configOf(agent()),
    );
    await intake.tick(true);
    expect(service.status().intake?.runs?.reviews?.imported).toBe(1);
    expect(service.list()).toHaveLength(2);
    await intake.tick(true);
    expect(service.status().intake?.runs?.reviews?.imported).toBe(0);
    expect(service.list()).toHaveLength(2);
    activity.close();
  });

  it("API待機中に異なる再依頼時刻が返っても、最新の未完了タスクを追い越して作成しない", async () => {
    const { activity, pulls, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    const at = Date.parse(service.get(id)?.task.reviewPost?.at ?? "");
    const earlier = Promise.withResolvers<string>();
    const later = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(pulls, "lastReviewRequest")
      .mockImplementationOnce(() => earlier.promise)
      .mockImplementationOnce(() => {
        entered.resolve();
        return later.promise;
      });
    const first = service.restartRerequestedReviews([pr(9)]);
    const second = service.restartRerequestedReviews([pr(9)]);
    await entered.promise;
    earlier.resolve(new Date(at + 1_000).toISOString());
    expect((await first).restarted).toHaveLength(1);
    later.resolve(new Date(at + 2_000).toISOString());
    expect((await second).restarted).toEqual([]);
    activity.close();
  });

  it("別タスクの再レビュー指示にも前回本文・行指摘・コミットと作者返答を渡す", async () => {
    const first =
      "# 1回目\n\n```json\n" +
      JSON.stringify({
        "sacty-review-comments": [
          { path: "src/retry.ts", line: 2, severity: "must", body: "上限が無い" },
        ],
      }) +
      "\n```";
    const { activity, pulls, service, executor, id } = await posted(undefined, first);
    const at = Date.parse(service.get(id)?.task.reviewPost?.at ?? "");
    pulls.feedbackBy[9] = [
      {
        key: "after",
        kind: "review_comment",
        author: "alice",
        at: new Date(at + 1_000).toISOString(),
        body: "上限を直しました",
        path: "src/retry.ts",
        line: 2,
      },
      {
        key: "before",
        kind: "comment",
        author: "alice",
        at: new Date(at - 1_000).toISOString(),
        body: "前の返答",
      },
      {
        key: "other",
        kind: "comment",
        author: "bob",
        at: new Date(at + 1_000).toISOString(),
        body: "他の人",
      },
    ];
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"], headSha: "n".repeat(40) };
    requestAfterPost(service, pulls, id);
    const next = (await service.restartRerequestedReviews([pr(9)])).restarted[0];
    if (!next) throw new Error("missing task");
    await service.runNext(next.id);
    const prompt =
      executor.calls
        .map((c) => c.command.join(" "))
        .filter((c) => c.includes("レビューエージェント"))[1] ?? "";
    expect(prompt).toContain("--- 再レビュー ---");
    const json = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"previousReview"')) ?? "{}",
    );
    expect(json.previousReview).toMatchObject({
      body: "# 1回目",
      commit: "h".repeat(40),
      comments: [{ path: "src/retry.ts", line: 2, body: "[要修正] 上限が無い" }],
    });
    expect(json.authorReplies).toEqual([
      expect.objectContaining({ body: "上限を直しました", path: "src/retry.ts" }),
    ]);
    expect(service.get(next.id)?.task.reviewTarget?.headCommit).toBe("n".repeat(40));
    activity.close();
  });

  it.each(["queued", "cancelled", "failed", "restart"])(
    "並行取り込みと%sのあとも同じ依頼を別タスクに重複作成しない",
    async (state) => {
      const { activity, pulls, service, settings, projects, id } = await posted();
      pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
      requestAfterPost(service, pulls, id);
      const original = service.get(id);
      const results = await Promise.all([
        service.restartRerequestedReviews([pr(9)]),
        service.restartRerequestedReviews([pr(9)]),
      ]);
      const created = results.flatMap((r) => r.restarted);
      expect(created).toHaveLength(1);
      const next = created[0];
      if (!next) throw new Error("missing task");
      expect(next.id).not.toBe(id);
      expect(service.get(id)).toEqual(original);
      if (state === "cancelled") await service.cancel(next.id);
      if (state === "failed") {
        pulls.prInfoFail = "GitHub API 502";
        await service.runNext(next.id);
        expect(service.get(next.id)?.task.status).toBe("paused");
        pulls.prInfoFail = undefined;
      }
      const current =
        state === "restart"
          ? makeService(activity, [], { pulls, settings, projects }).service
          : service;
      expect((await current.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
      expect(current.get(next.id)?.task.previousReview).toEqual(next.previousReview);
      activity.close();
    },
  );

  it("依頼のできごとを読めなければ、再レビューせず、伏せた理由を返す", async () => {
    const { activity, pulls, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    pulls.lastRequestFail = "GitHub API 500 ghp_secret";
    const { restarted, failed } = await service.restartRerequestedReviews([pr(9)]);
    expect(restarted).toEqual([]);
    expect(failed.map((f) => f.issue.number)).toEqual([9]);
    expect(renderMessage(failed[0]?.message, "ja")).not.toContain("ghp_secret");
    expect(restarts(service, id)).toEqual([]);
    activity.close();
  });

  it("投稿する前・中止したタスクは再レビューせず、PR も読まない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    const settings = new MemorySettingsStore({ reviewRequested: true });
    const { service } = makeService(activity, [], { pulls, settings });
    const [waiting, cancelled] = service.importIssues([pr(9), pr(10)]);
    await service.cancel(cancelled?.id ?? "");
    expect(await service.restartRerequestedReviews([pr(9), pr(10)])).toEqual({
      restarted: [],
      failed: [],
    });
    expect(pulls.prInfoRequests).toEqual([]);
    expect(service.get(waiting?.id ?? "")?.task.status).toBe("queued");
    activity.close();
  });

  it("ラベルで取り込んだ PR のタスクは、依頼の検索で見つかっても再レビューしない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({
      reviewRequested: true,
      reviewLabel: "sacty-review",
    });
    const { service } = makeService(activity, [out("# 1回目")], { pulls, settings });
    const [task] = service.importIssues([
      { ...pr(9, { labels: ["sacty-review"] }), review: "label", requestedFor: undefined },
    ]);
    const id = task?.id ?? "";
    expect(task?.source?.review).toBe("label");
    await service.runNext(id);
    await service.runNext(id);
    expect(service.get(id)?.task.reviewPost).toBeDefined();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me"] };
    const before = pulls.prInfoRequests.length;
    expect((await service.restartRerequestedReviews([pr(9)])).restarted).toEqual([]);
    expect(pulls.prInfoRequests.length).toBe(before);
    activity.close();
  });

  it("依頼の取り込みを Off にしたとき・ほかのアカウントへの依頼・依頼の検索でないものでは、再レビューしない", async () => {
    const { activity, pulls, settings, service, id } = await posted();
    pulls.prInfo = { ...pulls.prInfo, requestedReviewers: ["me", "other"] };
    const before = pulls.prInfoRequests.length;
    const none = async (issue: ReturnType<typeof pr>) =>
      expect((await service.restartRerequestedReviews([issue])).restarted).toEqual([]);
    await none(pr(9, { requestedFor: "other" }));
    await none(pr(9, { review: "label" }));
    await none(pr(9, { requestedFor: undefined }));
    settings.put({ reviewLabel: "sacty-review" });
    await none(pr(9));
    expect(pulls.prInfoRequests.length).toBe(before);
    expect(restarts(service, id)).toEqual([]);
    activity.close();
  });

  it("今の依頼先を読めなければ、再レビューせず、伏せた理由を返す", async () => {
    const { activity, pulls, service, id } = await posted();
    pulls.prInfoFail = "GitHub API 502 ghp_secret";
    const { restarted, failed } = await service.restartRerequestedReviews([pr(9)]);
    expect(restarted).toEqual([]);
    expect(failed.map((f) => f.issue.number)).toEqual([9]);
    const text = renderMessage(failed[0]?.message, "ja");
    expect(text).toContain(
      "https://github.com/acme/app#9 でレビューが再依頼されたかを確かめられませんでした",
    );
    expect(text).not.toContain("ghp_secret");
    expect(restarts(service, id)).toEqual([]);
    activity.close();
  });
});
