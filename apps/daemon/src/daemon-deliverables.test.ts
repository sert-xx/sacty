import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@sacty/core";
import { exportDue, isCompleted, MVP_STEPS, message, renderMessage, STEP_PLANS } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult, SactyConfig } from "./config.js";
import type { ContextRef } from "./context.js";
import { HostMcpFile, toHostMcp } from "./host-mcp.js";
import { PlatformFile, toPlatform } from "./platforms.js";
import { NOT_APPLICABLE, PR_BODY_MAX, type TemplateLookup } from "./pr-template.js";
import { buildPullRequestBody, buildStepDocument } from "./prompts.js";
import { createApp } from "./server.js";
import {
  awaitingIssueComment,
  InvalidOperationError,
  type ServiceDeps,
  type TaskService,
} from "./service.js";
import {
  agent,
  configOf,
  current,
  dbPath,
  dir,
  FakeContexts,
  FakePulls,
  FakeRepos,
  fakeGateway,
  HOLD,
  ja,
  makeService,
  noAiReview,
  projectsWithAccount,
  recordingGateway,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

describe("成果の書き出し（PBI-56）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  /** 書き出しのエージェントの出力。100万出力トークン = $15 なので、1000 で $0.015。 */
  const exportOut = (v: Record<string, unknown>): AgentOutcome =>
    out(`書きました\n\n\`\`\`json\n${JSON.stringify({ "sacty-export": v })}\n\`\`\``, 1000);
  const URL1 = "https://wiki.example.com/pages/101";
  const confluence = () =>
    toPlatform(
      "confluence",
      PlatformFile.parse({
        upstream: "https://wiki.example.com",
        description: "Confluence（設計書は DEV スペース）",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "wiki-token" },
        allow: ["GET /rest/api/content/**", "POST /rest/api/content", "PUT /rest/api/content/*"],
      }),
    );
  const secrets = {
    "claude-oauth-token": "oauth-secret",
    "github-token": "ghp_secret",
    "wiki-token": "wiki-secret-value",
    "docs-token": "docs-secret-value",
  };
  /** 決めた書き出し先を返す、オーケストレーターの代わり。 */
  const plannerWith =
    (exports: Record<string, unknown>): ServiceDeps["planner"] =>
    async () => ({
      steps: [...MVP_STEPS],
      fallback: false,
      testCommand: "npm test",
      costUsd: 0,
      estimated: false,
      exports: exports as never,
    });
  /** 要求要件を confluence に書き出し、設計は書き出さないと決める。 */
  const toConfluence = plannerWith({
    requirements: {
      to: { via: "platform", name: "confluence", location: "DEV スペースの「要件」" },
      reason: "規約で要件は Confluence に置く",
    },
    design: { reason: "設計は sacty の中だけで足りる" },
  });
  const investigateToConfluence: ServiceDeps["planner"] = async () => ({
    steps: [...STEP_PLANS.investigate],
    plan: "investigate",
    reason: "質問",
    fallback: false,
    costUsd: 0,
    estimated: false,
    exports: {
      investigate: { to: { via: "platform", name: "confluence", location: "" }, reason: "r" },
    },
  });
  const promptOf = (executor: { calls: Invocation[] }, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const exportEvents = (activity: SqliteActivityStore, id: string) =>
    activity.forTask(id).filter((e) => e.type === "OutputExported");
  const taskOf = (service: TaskService, id: string) => service.get(id)?.task as Task;
  const issue = {
    repo: "https://github.com/acme/app",
    number: 5,
    title: "再試行はどこ？",
    body: "",
    url: "https://github.com/acme/app/issues/5",
    labels: ["sacty"],
  };

  /** 工程を選んで要求要件を実行し、承認するところまで進める。 */
  async function approveRequirements(service: TaskService, id: string) {
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: current(service, id) });
  }

  it("オーケストレーターが決めた書き出し先と理由を記録し、承認した要求要件をゲートウェイの接続先に書き出して URL を残す（認証はコンテナにも作業履歴にも出ない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const recorded = recordingGateway();
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件 v1"), exportOut({ url: URL1 }), out("# 設計")],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: recorded.gateway,
        planner: toConfluence,
        secrets,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "決済の再送" });
    await approveRequirements(service, id);
    // 工程ごとの書き出し先（書き出さないことも含む）と理由（作業履歴と画面）
    const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.exports).toEqual({
      requirements: {
        to: { via: "platform", name: "confluence", location: "DEV スペースの「要件」" },
        reason: "規約で要件は Confluence に置く",
      },
      design: { reason: "設計は sacty の中だけで足りる" },
    });
    expect(exportDue(taskOf(service, id))).toBe("requirements");
    expect(service.queuedTaskIds()).toEqual([id]);

    // 承認の後、次の工程の前に書き出す
    await service.runNext(id);
    const call = executor.calls[1];
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    // 書き出しのトークンで使えるのは、選んだ PF だけ（ほかのホストの PF・MCP は使えない。PBI-131）
    expect(recorded.access.at(-1)).toEqual({ platforms: ["confluence"], hostMcp: [] });
    const prompt = promptOf(executor, 1);
    expect(prompt).toContain("sacty-export.md");
    expect(prompt).toContain("$SACTY_PF_URL/confluence");
    expect(prompt).toContain("DEV スペースの「要件」");
    expect(prompt).toContain(
      "を含むページを探し、あればそのページを更新する（新しく作らない）。無ければ、新しいページを作る",
    );
    // 書き出す内容は、作業領域のファイルで渡す
    expect(executor.workspaceFiles[1]).toEqual(["sacty-export.md"]);
    const task = taskOf(service, id);
    expect(task.exports.requirements).toMatchObject({
      url: URL1,
      last: { submission: 1, via: "platform", name: "confluence", url: URL1 },
    });
    expect(task.status).toBe("queued");
    // 費用はタスクの予算に入る
    expect(task.budget.usedUsd).toBeCloseTo(0.015 + 0.000015, 6);
    const [exported] = exportEvents(activity, id);
    expect(exported).toMatchObject({
      actor: "agent",
      payload: { url: URL1, runResult: "completed", costUsd: 0.015 },
    });
    // 認証の値は、コンテナにも作業履歴にも出ない
    expect(JSON.stringify(executor.calls)).not.toContain("wiki-secret-value");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("wiki-secret-value");

    // 続けて設計へ進む。書き出さないと決めた設計は、承認しても書き出さない
    await service.runNext(id);
    expect(executor.calls).toHaveLength(3);
    service.approve(id, { step: "design", submission: 1 });
    expect(exportDue(taskOf(service, id))).toBeUndefined();
    activity.close();
  });

  it("使える接続先が無ければ、書き出し先を決めさせず、承認しても書き出さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件"), out("# 設計")], {
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.exports).toBeUndefined();
    await service.runNext(id);
    // 書き出さずに設計を実行した
    expect(executor.calls).toHaveLength(2);
    expect(exportEvents(activity, id)).toEqual([]);
    activity.close();
  });

  it("オーケストレーターに使える接続先（ゲートウェイの接続先・ホストの MCP）と規約を渡し、選んだ MCP サーバーで書き出す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const recorded = recordingGateway();
    const notion = toHostMcp(
      "notion",
      HostMcpFile.parse({ command: "notion-mcp", description: "Notion（チームのワークスペース）" }),
    );
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "rules.md": "# 規約\n\n要求要件は Notion の「仕様」に置く",
      },
    });
    const plan = out(
      `\`\`\`json\n${JSON.stringify({
        "sacty-steps": {
          plan: "skip-design",
          reason: "小さい",
          testCommand: "npm test",
          exports: {
            requirements: { to: "notion", via: "mcp", location: "仕様", reason: "規約で Notion" },
            design: { to: "confluence", reason: "設計も" },
          },
        },
      })}\n\`\`\``,
    );
    const { service, executor } = makeService(
      activity,
      [plan, out("# 要求要件"), exportOut({ url: "https://notion.example.com/p/1" })],
      {
        config: configOf(agent(), 1, [confluence()], [notion]),
        gateway: recorded.gateway,
        contexts,
        realPlanner: true,
        secrets,
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    // 工程を選んで、最初の工程（要求要件）を続けて実行する
    await service.runNext(id);
    const orchestrator = promptOf(executor, 0);
    expect(orchestrator).toContain("confluence（via: platform・ゲートウェイの接続先）");
    expect(orchestrator).toContain(
      "notion（via: mcp・MCP サーバー）：Notion（チームのワークスペース）",
    );
    expect(orchestrator).toContain("要求要件は Notion の「仕様」に置く");
    // skip-design なので、書き出せる工程は要求要件だけ（設計の指定は使わない）
    expect(taskOf(service, id).exportPlans).toEqual({
      requirements: {
        to: { via: "mcp", name: "notion", location: "仕様" },
        reason: "規約で Notion",
      },
    });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    // MCP サーバーは、ゲートウェイの HTTP の MCP として渡し、PF の URL は渡さない（実行は、工程の選択・要求要件の後）
    const call = executor.calls[2];
    expect(call?.env.SACTY_PF_URL).toBeUndefined();
    expect(JSON.parse(executor.mcpConfigs[2] ?? "{}").mcpServers.notion).toMatchObject({
      url: "http://host.docker.internal:5001/mcp/notion",
    });
    expect(promptOf(executor, 2)).toContain("MCP サーバー。そのツールで書く");
    expect(promptOf(executor, 2)).toContain("Notion（チームのワークスペース）");
    // 書き出しのトークンで使えるのは、選んだ MCP サーバーだけ（ホストの PF の confluence は使えない。PBI-131）
    expect(recorded.access.at(-1)).toEqual({ platforms: [], hostMcp: ["notion"] });
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://notion.example.com/p/1");
    activity.close();
  });

  it("ホストの MCP サーバーへの書き出しは、その MCP サーバーだけの準備を待ち、準備ができなければ、どれかがわかる理由を残して書き出さない（PBI-77）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const notion = toHostMcp("notion", HostMcpFile.parse({ command: "notion-mcp" }));
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const waits: (readonly string[])[] = [];
    let notionProblem: ReturnType<typeof message>[] = [
      message("gateway.mcpReadyTimeout", { name: "notion", seconds: 300 }),
    ];
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://notion.example.com/p/1" }), out("# 設計")],
      {
        config: configOf(agent(), 1, [], [notion, cloud]),
        gateway: fakeGateway(),
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "notion", location: "仕様" }, reason: "規約" },
        }),
        hostMcpReady: async (names) => {
          waits.push(names);
          return names.includes("notion") ? notionProblem : [];
        },
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    // 書き出しは、決めた接続先の MCP サーバーだけを待つ（エージェントは実行しない）
    expect(waits.at(-1)).toEqual(["notion"]);
    expect(executor.calls).toHaveLength(1);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.failed", {
        detail: message("gateway.mcpReadyTimeout", { name: "notion", seconds: 300 }),
      }),
    );
    expect(taskOf(service, id).pausedReason).toBeUndefined();
    // 準備ができれば、書き出し直せる
    notionProblem = [];
    service.retryExport(id, "requirements");
    await service.runNext(id);
    expect(waits.at(-1)).toEqual(["notion"]);
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://notion.example.com/p/1");
    activity.close();
  });

  it("使える接続先に無い名前・決めなかった工程は、理由を添えて書き出さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件")], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: plannerWith({ requirements: { to: { name: "nowhere" }, reason: "?" } }),
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(taskOf(service, id).exportPlans).toEqual({
      requirements: { reason: message("export.destinationUnknown", { name: "nowhere" }) },
      design: { reason: message("export.notDecided") },
    });
    activity.close();
  });

  it("コンテキストの MCP サーバーでも書き出せる。認証のヘッダーはゲートウェイだけが持つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
        ].join("\n"),
      },
    });
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://docs.example.com/p/9" })],
      {
        gateway: fakeGateway(),
        contexts,
        secrets,
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "docs", location: "" }, reason: "規約" },
        }),
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    expect(taskOf(service, id).exportPlans?.requirements?.to?.name).toBe("docs");
    await service.runNext(id);
    const mcp = JSON.parse(executor.mcpConfigs[1] ?? "{}").mcpServers.docs;
    expect(mcp.url).toBe("http://host.docker.internal:5001/ctx-mcp/docs");
    expect(JSON.stringify(executor.calls[1])).not.toContain("docs-secret-value");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("docs-secret-value");
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://docs.example.com/p/9");
    activity.close();
  });

  it("書き出しには決めた MCP サーバーだけを渡す（ほかの MCP サーバーの認証が取れなくても書き出せる）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
          "  other:",
          "    url: https://other.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: other-token, prefix: 'Bearer ' }",
        ].join("\n"),
      },
    });
    // 承認の後は、other の認証だけを取り出せなくする
    let otherGone = false;
    const values: Record<string, string> = { ...secrets, "other-token": "other-secret-value" };
    const secretStore = {
      async get(name: string) {
        if (name === "other-token" && otherGone) throw new Error("other-token を取り出せません");
        const value = values[name];
        if (value === undefined) throw new Error(`no secret ${name}`);
        return value;
      },
    };
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://docs.example.com/p/9" })],
      {
        gateway: fakeGateway(),
        contexts,
        secretStore,
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "docs", location: "" }, reason: "規約" },
        }),
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    otherGone = true;
    await service.runNext(id);
    const servers = JSON.parse(executor.mcpConfigs[1] ?? "{}").mcpServers;
    expect(Object.keys(servers)).toEqual(["docs"]);
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://docs.example.com/p/9");
    expect(JSON.stringify(executor.calls[1])).not.toContain("other");
    activity.close();
  });

  it("書き出せなければ理由を残して進め（タスクは止めない）、画面から書き出し直せる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件"),
        exportOut({ error: "スペース DEV に書き込む権限がありません" }),
        out("# 設計"),
        exportOut({ url: URL1 }),
      ],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
        secrets,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    // 書き出し直せるのは、書き出せなかったものだけ
    expect(() => service.retryExport(id, "requirements")).toThrow(InvalidOperationError);
    await service.runNext(id);
    const failed = taskOf(service, id).exports.requirements;
    expect(failed?.url).toBeUndefined();
    expect(ja(failed?.last?.failed)).toContain("スペース DEV に書き込む権限がありません");
    // タスクは止まらず、設計へ進む
    expect(taskOf(service, id).status).toBe("queued");
    await service.runNext(id);
    expect(taskOf(service, id).gate?.step).toBe("design");
    expect(() => service.retryExport(id, "design")).toThrow(InvalidOperationError);
    expect(() => service.retryExport(id, "nope")).toThrow(InvalidOperationError);
    // 画面から書き出し直す（設計の承認待ちのまま）
    service.retryExport(id, "requirements");
    expect(() => service.retryExport(id, "requirements")).toThrow(InvalidOperationError);
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements).toMatchObject({
      url: URL1,
      last: { url: URL1 },
    });
    expect(taskOf(service, id).exports.requirements?.retry).toBeUndefined();
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    expect(executor.calls).toHaveLength(4);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("結果を読めなかった（ページを作ったかもしれない）書き出しを書き出し直すと、作る前に目印で既存のページを探させる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件"),
        out("ページを作りました（結果の JSON を出し忘れた）"),
        out("# 設計"),
        exportOut({ url: URL1 }),
      ],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
        secrets,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id); // 書き出し（結果を読めない）
    expect(taskOf(service, id).exports.requirements?.last?.failed).toBeDefined();
    await service.runNext(id); // 設計
    service.retryExport(id, "requirements");
    await service.runNext(id);
    const retried = promptOf(executor, 3);
    expect(retried).toContain(
      "目印「sacty-export:" +
        id +
        ":requirements」を含むページを探し、あればそのページを更新する（新しく作らない）",
    );
    expect(retried).not.toContain("置き場所に、新しいページを作る");
    expect(taskOf(service, id).exports.requirements?.url).toBe(URL1);
    activity.close();
  });

  it("接続できない（エージェントの実行に失敗した・接続先が設定から消えた）ときも、理由を残して進める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let platforms = [confluence()];
    const config = () => configOf(agent(), 1, platforms)();
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件"),
        { kind: "failed", reason: "error", message: "connect ECONNREFUSED wiki.example.com" },
        out("# 設計"),
      ],
      { config, gateway: fakeGateway(), planner: toConfluence },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.failed", { detail: "connect ECONNREFUSED wiki.example.com" }),
    );
    expect(taskOf(service, id).pausedReason).toBeUndefined();
    await service.runNext(id);
    expect(taskOf(service, id).gate?.step).toBe("design");
    // 接続先が設定から消えた（エージェントは実行しない）
    platforms = [];
    service.retryExport(id, "requirements");
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.destinationMissing", { name: "confluence" }),
    );
    expect(executor.calls).toHaveLength(3);
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    activity.close();
  });

  it("予算の上限に達していれば、書き出さずに理由を残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件", 70_000)], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.budgetExceeded"),
    );
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("差し戻しの後に承認し直すと、前に書き出したページを更新させる（新しく作らない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件 v1"),
        exportOut({ url: URL1 }),
        out("# 設計"),
        out("# 要求要件 v2"),
        exportOut({ url: URL1 }),
      ],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    await service.runNext(id);
    // 設計の承認待ちで、要求要件まで差し戻す（承認を取り消すので、書き出しは待たない）
    service.requestChanges(id, {
      step: "design",
      submission: 1,
      target: "requirements",
      comments: ["受け入れ条件を足して"],
    });
    expect(exportDue(taskOf(service, id))).toBeUndefined();
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 2 });
    expect(exportDue(taskOf(service, id))).toBe("requirements");
    await service.runNext(id);
    const prompt = promptOf(executor, 4);
    expect(prompt).toContain(`前にこの成果を書き出したページ（${URL1}）を、この内容で更新する`);
    expect(prompt).not.toContain("新しいページを作る");
    expect(taskOf(service, id).exports.requirements).toMatchObject({
      url: URL1,
      last: { submission: 2, url: URL1 },
    });
    expect(exportEvents(activity, id)).toHaveLength(2);
    activity.close();
  });

  it("書き出しの後・記録の前にデーモンが止まったら、再起動の後に目印のあるページを探して更新させ、二重に書き出さない", async () => {
    const first = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(first, [out("# 要求要件"), HOLD as never], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    void service.runNext(id);
    await executor.started.promise;
    // 書き出しを始めた記録だけがある（ここでデーモンが止まった）
    expect(first.forTask(id).at(-1)?.type).toBe("ExportStarted");
    first.close();

    const second = new SqliteActivityStore(dbPath);
    const restarted = makeService(second, [exportOut({ url: URL1 }), out("# 設計")], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    restarted.service.recoverInterrupted();
    expect(restarted.service.queuedTaskIds()).toEqual([id]);
    await restarted.service.runNext(id);
    const prompt = promptOf(restarted.executor, 0);
    expect(prompt).toContain(`目印「sacty-export:${id}:requirements」を含むページを探し`);
    expect(restarted.executor.workspaceFiles[0]).toEqual(["sacty-export.md"]);
    const exported = taskOf(restarted.service, id).exports.requirements;
    expect(exported?.url).toBe(URL1);
    expect(exported?.started).toBeUndefined();
    // 書き出しの後は、続けて設計へ進む
    await restarted.service.runNext(id);
    expect(taskOf(restarted.service, id).gate?.step).toBe("design");
    second.close();
  });

  it("書き出し中に一時停止すると、結果を記録せずに止まり、再開すると目印で探して書き出しを続ける", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), HOLD as never, exportOut({ url: URL1 })],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    const running = service.runNext(id);
    await executor.started.promise;
    await service.pause(id);
    await running;
    const paused = taskOf(service, id);
    expect(paused.status).toBe("paused");
    expect(paused.exports.requirements?.started).toBeDefined();
    expect(paused.exports.requirements?.last).toBeUndefined();
    expect(exportEvents(activity, id).at(-1)?.payload).toMatchObject({
      runResult: "interrupted",
      failed: message("export.stopped"),
    });
    // 一時停止中は書き出さない
    expect(service.queuedTaskIds()).toEqual([]);
    service.resume(id, {});
    await service.runNext(id);
    expect(promptOf(executor, 2)).toContain(`目印「sacty-export:${id}:requirements」`);
    expect(taskOf(service, id).exports.requirements?.url).toBe(URL1);
    activity.close();
  });

  it("書き出し中に中止すると、コンテナを止めて中止できる（以後は書き出さない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件"), HOLD as never], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    const cancelled = await service.cancel(id);
    await running;
    expect(executor.killed).toContain(runId);
    expect(cancelled.status).toBe("cancelled");
    expect(exportDue(cancelled)).toBeUndefined();
    expect(service.queuedTaskIds()).toEqual([]);
    expect(() => service.retryExport(id, "requirements")).toThrow(InvalidOperationError);
    activity.close();
  });

  it("書き出せなかった理由は、秘密情報を伏せてから切り詰める（境界をまたぐトークンを残さない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 理由の上限（1000文字）の境界を、実行ごとのトークンがまたぐ
    const error = `${"x".repeat(995)}sacty-gw-run の認証で拒否されました`;
    const { service } = makeService(activity, [out("# 要求要件"), exportOut({ error })], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    const failed = ja(taskOf(service, id).exports.requirements?.last?.failed);
    expect(failed).toContain("x".repeat(995));
    expect(failed).not.toContain("sacty");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("sacty-gw");
    activity.close();
  });

  it("Issue から取り込んだ調査のタスクは、書き出してから、書き出した先の URL を添えて Issue にコメントする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service } = makeService(activity, [out("# 調査の結果"), exportOut({ url: URL1 })], {
      pulls,
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: investigateToConfluence,
    });
    const [task] = service.importIssues([issue]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    expect(awaitingIssueComment(taskOf(service, id))).toBe(false);
    await service.runNext(id);
    // 書き出しの前には、コメントしない
    expect(pulls.issueComments).toHaveLength(0);
    await service.runNext(id);
    expect(pulls.issueComments[0]?.body).toContain(`書き出した先：${URL1}`);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("書き出せなかったときは、URL を添えずに Issue にコメントする（いまの仕様にフォールバックする）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service } = makeService(
      activity,
      [out("# 調査の結果"), exportOut({ error: "接続できません" })],
      {
        pulls,
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: investigateToConfluence,
      },
    );
    const [task] = service.importIssues([issue]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.issueComments).toHaveLength(1);
    expect(pulls.issueComments[0]?.body).toContain("# 調査の結果");
    expect(pulls.issueComments[0]?.body).not.toContain("書き出した先");
    activity.close();
  });

  it("書き出しの API から、承認済みの成果を書き出し直せる（書き出せないものは 409）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ error: "だめ" }), out("# 設計")],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    const app = createApp(service, "export-token");
    const headers = { authorization: "Bearer export-token" };
    const denied = await app.request(`/api/tasks/${id}/exports/design/retry`, {
      method: "POST",
      headers,
    });
    expect(denied.status).toBe(409);
    const ok = await app.request(`/api/tasks/${id}/exports/requirements/retry`, {
      method: "POST",
      headers,
    });
    expect(ok.status).toBe(200);
    expect(taskOf(service, id).exports.requirements?.retry).toBe(true);
    activity.close();
  });

  it("書き出しの実行でも、置いた段階のサブエージェントの定義と注意を、その実行の記録（ContextResolved）に残す（PBI-119）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
        ].join("\n"),
      },
    });
    const base = (configOf(agent())() as { ok: true; config: SactyConfig }).config;
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://docs.example.com/p/9" })],
      {
        config: () => ({
          ok: true,
          config: {
            ...base,
            tierAgents: {
              "claude-code": {
                standard: agent({ id: "claude_standard", model: "claude-sonnet-5-5" }),
                lite: agent({
                  id: "claude_lite",
                  auth: { mode: "subscription", secret: "another-token" },
                }),
              },
            },
          },
        }),
        gateway: fakeGateway(),
        contexts,
        secrets,
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "docs", location: "" }, reason: "規約" },
        }),
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://docs.example.com/p/9");
    // 書き出しの実行にも段階を置く
    expect(executor.seeds[1]?.["agents/standard.md"]).toContain('model: "claude-sonnet-5-5"');
    // 工程の実行と書き出しの実行の、それぞれの記録
    const resolved = activity
      .forTask(id)
      .filter((e) => e.type === "ContextResolved")
      .map((e) => (e.type === "ContextResolved" ? e.payload : undefined));
    expect(resolved).toHaveLength(2);
    // 2 つ目が書き出しの実行（工程の実行の後）。実行の ID は、工程の実行のものと違う
    const ofExport = resolved[1];
    expect(ofExport?.runId).not.toBe(resolved[0]?.runId);
    expect(ofExport?.tiers).toEqual([
      { tier: "standard", agentId: "claude_standard", model: "claude-sonnet-5-5" },
    ]);
    expect(ofExport?.warnings).toContainEqual(
      message("agents.tierConnectionDiffers", {
        tier: "lite",
        id: "claude_lite",
        parent: "claude-subscription",
      }),
    );
    activity.close();
  });

  it("書き出しの記録（ContextResolved）に失敗しても、用意したコンテキストのディレクトリを消す（PR #129 再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const outs: string[] = [];
    class RecordingOut extends FakeContexts {
      override async fetch(ref: ContextRef, out: string, authEnv?: Record<string, string>) {
        outs.push(out);
        return super.fetch(ref, out, authEnv);
      }
    }
    const contexts = new RecordingOut({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": ["servers:", "  docs:", "    url: https://docs.example.com/mcp"].join("\n"),
      },
    });
    const { service } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://docs.example.com/p/9" })],
      {
        gateway: fakeGateway(),
        contexts,
        secrets,
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "docs", location: "" }, reason: "規約" },
        }),
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    // 承認の後の最初の ContextResolved（書き出しの実行の記録）の書き込みで失敗させる
    const original = activity.append.bind(activity);
    let seen = 0;
    const spy = vi.spyOn(activity, "append").mockImplementation((entry) => {
      if (entry.events.some((e) => e.event.type === "ContextResolved") && ++seen === 1) {
        throw new Error("db full");
      }
      return original(entry);
    });
    await expect(service.runNext(id)).rejects.toThrow("db full");
    spy.mockRestore();
    expect(seen).toBe(1);
    // 取得した層の置き場所（用意したコンテキストの一時ディレクトリの下）が消えている
    const exportFetch = outs.at(-1);
    expect(outs.length).toBeGreaterThanOrEqual(2);
    expect(exportFetch && existsSync(exportFetch)).toBe(false);
    activity.close();
  });

  it("書き出しは、人がタスクの詳細で選んだエージェントで行い、選んだ名前が消えていれば書き出さずに理由を残す（PBI-121。PR #131 レビュー指摘）", async () => {
    for (const removed of [false, true]) {
      const activity = new SqliteActivityStore(dbPath);
      const strong = agent({ id: "strong", model: "claude-opus-5-5" });
      let agents = [agent(), strong];
      const base = configOf(agent(), 1, [confluence()]);
      const config = (): ConfigResult => {
        const loaded = base() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: { ...loaded.config, agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
        };
      };
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件 v1"), exportOut({ url: URL1 }), out("# 設計")],
        { config, gateway: fakeGateway(), planner: toConfluence, secrets },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済の再送" });
      await service.runNext(id);
      service.changeStepAgent(id, { step: "requirements", agent: "strong" });
      service.approve(id, { step: "requirements", submission: current(service, id) });
      if (removed) agents = [agent()];
      await service.runNext(id);
      const exported = exportEvents(activity, id).at(-1);
      if (removed) {
        expect(exported?.type === "OutputExported" && exported.payload).toMatchObject({
          failed: message("agent.chosenMissing", { step: "requirements", name: "strong" }),
          runResult: "failed",
        });
        // 書き出しのエージェントは動かさない（要求要件の実行だけ）
        expect(executor.calls).toHaveLength(1);
      } else {
        expect(exported?.type === "OutputExported" && exported.payload).toMatchObject({
          agentId: "strong",
          model: "claude-opus-5-5",
          url: URL1,
        });
        expect(promptOf(executor, 1)).toContain("claude-opus-5-5");
      }
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("書き出しの準備の間にエージェントを変えたら、古いエージェントで始めず、次の実行で新しいエージェントで書き出す（PR #131 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const strong = agent({ id: "strong", model: "claude-opus-5-5" });
    const other = agent({ id: "other", model: "claude-sonnet-5-5" });
    const base = configOf(agent(), 1, [confluence()]);
    const config = (): ConfigResult => {
      const loaded = base() as { ok: true; config: SactyConfig };
      return {
        ok: true,
        config: {
          ...loaded.config,
          agents: Object.fromEntries([agent(), strong, other].map((a) => [a.id, a])),
        },
      };
    };
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件 v1"), exportOut({ url: URL1 }), out("# 設計")],
      { config, gateway: fakeGateway(), planner: toConfluence, secrets },
    );
    const { id } = service.createTask({ projectId: "default", title: "決済の再送" });
    await service.runNext(id);
    service.changeStepAgent(id, { step: "requirements", agent: "strong" });
    service.approve(id, { step: "requirements", submission: current(service, id) });
    const svc = service as unknown as { findPlatform: (...args: unknown[]) => Promise<unknown> };
    const find = svc.findPlatform.bind(svc);
    const spy = vi.spyOn(svc, "findPlatform").mockImplementationOnce(async (...args) => {
      const found = await find(...args);
      service.changeStepAgent(id, { step: "requirements", agent: "other" });
      return found;
    });
    await service.runNext(id);
    spy.mockRestore();
    expect(activity.forTask(id).some((e) => e.type === "ExportStarted")).toBe(false);
    expect(exportEvents(activity, id)).toEqual([]);
    expect(executor.calls).toHaveLength(1);
    expect(exportDue(taskOf(service, id))).toBe("requirements");
    await service.runNext(id);
    expect(exportEvents(activity, id).at(-1)?.payload).toMatchObject({
      agentId: "other",
      url: URL1,
    });
    expect(promptOf(executor, 1)).toContain("claude-sonnet-5-5");
    activity.close();
  });
});

describe("PR テンプレート（PBI-87）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const design = out(
    [
      "# 設計",
      block({
        "sacty-test-viewpoints": [
          { title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
        ],
      }),
    ].join("\n\n"),
  );
  const implement = (text = "# 実装の説明") =>
    out(
      [
        text,
        block({
          "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
        }),
      ].join("\n\n"),
    );
  const template = [
    "## 概要",
    "<!-- 何のための PR か -->",
    "",
    "## 変更内容",
    "",
    "## テスト",
    "- [x] 単体テストを足した",
    "",
    "## スクリーンショット",
    "",
  ].join("\n");
  const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;

  class FakeTemplates {
    calls: { repo: string; token: string }[] = [];
    constructor(private readonly result: () => Promise<TemplateLookup>) {}
    async find(input: { repo: string; token: string }) {
      this.calls.push(input);
      return this.result();
    }
  }
  const found = (text = template) =>
    new FakeTemplates(async () => ({
      kind: "found",
      template: {
        repo: "https://github.com/acme/.github",
        path: ".github/pull_request_template.md",
        text,
      },
    }));

  async function drain(service: TaskService, max = 12) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  /** 要求要件・設計を PR で承認する流れで、実装の PR まで進める。 */
  async function toPullRequest(
    templates: FakeTemplates,
    implementation = implement(),
    requirements = "# 要求要件 v1",
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const repos = new FakeRepos();
    const made = makeService(activity, [out(requirements), design, implementation], {
      stepPullRequests: true,
      now: () => Date.parse("2026-10-11T00:03:00Z"),
      pulls,
      repos,
      templates,
    });
    const { service } = made;
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
    const merge = async (step: "requirements" | "design") => {
      const pr = taskOf(service, id).stepPullRequests.findLast((p) => p.step === step);
      if (!pr) throw new Error(`no pull request for ${step}`);
      pulls.states[pr.number] = { state: "merged", mergedBy: "reviewer", headSha: pr.commit };
      repos.remote[`sacty/task-${id.slice(0, 8)}`] = `m${pr.number}`.padEnd(40, "0");
      await service.checkPullRequests();
    };
    await service.runNext(id); // 要求要件 → PR
    await merge("requirements");
    await service.runNext(id); // 設計 → PR
    await merge("design");
    await drain(service); // 実装・検証 → 実装の PR
    return { activity, service, pulls, id };
  }

  it("要求要件・設計の PR と実装の PR の本文を、テンプレートの見出しの形で埋め、使ったテンプレートを台帳に残す（受け入れ条件 1〜4）", async () => {
    const templates = found();
    const { activity, service, pulls, id } = await toPullRequest(templates);
    expect(pulls.calls).toHaveLength(3);
    // PR を作るたびに、PR を作るリポジトリでテンプレートを探す
    expect(templates.calls).toEqual(
      Array.from({ length: 3 }, () => ({
        repo: "https://github.com/acme/app",
        token: "ghp_secret",
      })),
    );
    const [requirements, designPr, impl] = pulls.calls.map((c) => c.body);
    // 要求要件の PR：テンプレートの見出しに沿い、承認の仕方とタスクの ID は最後に必ず入る
    expect(requirements).toMatch(/^## 概要\n\n<!-- 何のための PR か -->\n\n要求要件の成果物です。/);
    expect(requirements).not.toContain("Sacty のタスク「決済API」");
    expect(requirements).toContain(
      `## 変更内容\n\n成果のファイル：\`docs/sacty/${id.slice(0, 8)}/requirements.md\``,
    );
    expect(requirements).toContain(`## テスト\n\n- [ ] 単体テストを足した`);
    expect(requirements).toContain(`## スクリーンショット\n\n${NOT_APPLICABLE}`);
    expect(requirements).toContain(`<!-- sacty task ${id} -->`);
    expect(requirements).toContain(
      "この PR をマージすると（PR の中で直してからでも）、要求要件を承認したことになります。",
    );
    // 前の工程の成果物は、PR に出したコミットのファイルへのリンクにし、PR へのリンクも添える（PBI-322）
    expect(designPr).toMatch(
      new RegExp(
        `承認済みの前の成果：\\n- 要求要件：\\[\`docs/sacty/${id.slice(0, 8)}/requirements\\.md\`\\]\\(https://github\\.com/acme/app/blob/[0-9a-z]+/docs/sacty/${id.slice(0, 8)}/requirements\\.md\\)（PR：\\[#7\\]\\(https://github\\.com/acme/app/pull/7\\)）`,
      ),
    );
    // 実装の PR：目的・変更・テストをそれぞれの見出しに入れ、レビューは sacty の記録にする
    expect(impl).toMatch(/## 概要\n\n<!-- 何のための PR か -->\n\n(?!Sacty のタスク)/);
    expect(impl).not.toContain("レビューの子タスク");
    expect(impl).toContain(
      "**要求要件（人間が承認済み）**\n\n全文は、マージで承認した次の PR にあります。\n\n- 要求要件：[`docs/sacty/",
    );
    expect(impl).toContain("（PR：[#7](https://github.com/acme/app/pull/7)）");
    expect(impl).toContain("## 変更内容\n\n# 実装の説明");
    // 最終レビューをしない流れでは、最終レビューの列と、テストの実行の行を出さない
    expect(impl).toContain("## テスト\n\n| 観点 | テスト |\n| --- | --- |");
    expect(impl).not.toContain("最終レビュー |");
    expect(impl).not.toContain("テスト：（未実行）");
    expect(impl).toContain("<summary>観点ごとの詳細");
    expect(impl).toContain("- [ ] 単体テストを足した");
    // チェックボックスには、sacty が印を付けない
    expect(impl).not.toMatch(/\[[xX]\]/);
    // 最後の部分に、タスクの ID と、マージが実装の承認になることの案内（PBI-110）
    // その間に、レビューの進め方（1 項目 1 文。上限で省かれない footer の、承認の案内の前。PBI-450）
    expect(impl).toContain(`<!-- sacty task ${id} -->`);
    expect(impl).toContain(
      "この PR は Sacty が作成しました。\n\nこの PR をマージすると（PR の中で直してからでも）、実装を承認したことになります。",
    );
    expect(impl?.trimEnd().endsWith(`<!-- sacty task ${id} -->`)).toBe(true);
    expect(impl).not.toContain("成果物チェック");
    // 台帳と画面に、使ったテンプレートを残す
    const used = {
      repo: "https://github.com/acme/.github",
      path: ".github/pull_request_template.md",
    };
    const task = taskOf(service, id);
    expect(task.stepPullRequests.map((p) => p.template)).toEqual([used, used]);
    expect(task.pullRequest?.template).toEqual(used);
    // sacty の PR にラベルは付けない（PBI-330）
    expect(pulls.labels).toEqual([]);
    expect(task.pullRequest?.label).toBeUndefined();
    activity.close();
  });

  it("テンプレートが無ければ今の本文で作り、無かったことを台帳に残す", async () => {
    const { activity, service, pulls, id } = await toPullRequest(
      new FakeTemplates(async () => ({ kind: "none" })),
    );
    const task = taskOf(service, id);
    expect(pulls.calls[2]?.body).toBe(buildPullRequestBody(task, noAiReview(task)));
    expect(task.pullRequest?.template).toEqual({ fallback: "none" });
    expect(task.stepPullRequests[0]?.template).toEqual({ fallback: "none" });
    activity.close();
  });

  it("テンプレートを読めない・探す処理が失敗しても、PR の作成を止めずに今の本文で作り、理由を伏せて残す（受け入れ条件 4・5）", async () => {
    const unusable = await toPullRequest(
      new FakeTemplates(async () => ({
        kind: "unusable",
        repo: "https://github.com/acme/app",
        message: message("pr.templateFailed", {
          path: "/",
          status: 403,
          detail: "bad credentials ghp_secret",
        }),
      })),
    );
    let task = taskOf(unusable.service, unusable.id);
    expect(unusable.pulls.calls).toHaveLength(3);
    expect(unusable.pulls.calls[2]?.body).toBe(buildPullRequestBody(task, noAiReview(task)));
    expect(task.pullRequest?.template?.fallback).toBe("unusable");
    expect(renderMessage(task.pullRequest?.template?.message, "ja")).toContain("HTTP 403");
    expect(JSON.stringify(unusable.service.get(unusable.id)?.activity)).not.toContain("ghp_secret");
    unusable.activity.close();

    const thrown = await toPullRequest(
      new FakeTemplates(async () => {
        throw new Error("boom ghp_secret");
      }),
    );
    task = taskOf(thrown.service, thrown.id);
    expect(thrown.pulls.calls).toHaveLength(3);
    expect(task.pullRequest?.template).toEqual({
      fallback: "unusable",
      message: "boom [REDACTED]",
    });
    thrown.activity.close();
  });

  it("本文が長さの上限を超えるなら、後ろを省いてタスクの ID を残し、省いたことを台帳に残す（受け入れ条件 5）", async () => {
    const long = implement(`# 実装の説明\n\n${"長い説明。".repeat(20_000)}`);
    const withTemplate = await toPullRequest(found(), long);
    const body = withTemplate.pulls.calls[2]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain(`sacty task ${withTemplate.id}`);
    expect(taskOf(withTemplate.service, withTemplate.id).pullRequest?.template?.truncated).toBe(
      true,
    );
    withTemplate.activity.close();
  });

  it("テンプレートが無い・使えないときも、本文を省くときに実装の承認の案内とタスクの ID を失わない（PR #99 レビュー指摘）", async () => {
    for (const templates of [
      new FakeTemplates(async () => ({ kind: "none" })),
      new FakeTemplates(async () => {
        throw new Error("boom");
      }),
    ]) {
      const made = await toPullRequest(
        templates,
        implement(`# 実装の説明\n\n${"長い説明。".repeat(20_000)}`),
      );
      const body = made.pulls.calls[2]?.body ?? "";
      expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
      expect(body).toContain(`<!-- sacty task ${made.id} -->`);
      expect(body).toContain(
        "この PR は Sacty が作成しました。\n\nこの PR をマージすると（PR の中で直してからでも）、実装を承認したことになります。",
      );
      expect(body.endsWith(`<!-- sacty task ${made.id} -->`)).toBe(true);
      expect(taskOf(made.service, made.id).pullRequest?.template?.truncated).toBe(true);
      made.activity.close();
    }
  });

  it("本文に秘密の値を出さない（エージェントの出力に紛れても伏せる）", async () => {
    const leaked = await toPullRequest(
      found(),
      implement("# 実装の説明\n\nトークン ghp_secret を使った"),
    );
    expect(leaked.pulls.calls[2]?.body).not.toContain("ghp_secret");
    leaked.activity.close();
  });

  it("要約で切れる境界に秘密の値がまたがっても、切れた先頭を本文に出さない（PBI-264）", async () => {
    for (const templates of [found(), new FakeTemplates(async () => ({ kind: "none" }))]) {
      const leaked = await toPullRequest(
        templates,
        implement(`# 実装の説明\n\n${"あ".repeat(235)}ghp_secret を使った`),
      );
      const body = leaked.pulls.calls[2]?.body ?? "";
      expect(body).toContain("あ".repeat(100));
      expect(body).not.toContain("ghp_");
      leaked.activity.close();
    }
  });
});

describe("非コードの成果と単発作業（PBI-112）", () => {
  const out = (output: string): AgentOutcome => ({
    kind: "completed",
    output,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (value: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const promptOf = (executor: { calls: Invocation[] }, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const taskOf = (service: TaskService, id: string) => service.get(id)?.task as Task;
  const planner =
    (plan: "document" | "operation"): ServiceDeps["planner"] =>
    async () => ({
      steps: [...STEP_PLANS[plan]],
      plan,
      reason: "非コード作業",
      ...(plan === "operation" ? { operation } : {}),
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
  const calendar = () =>
    toPlatform(
      "calendar",
      PlatformFile.parse({
        upstream: "https://calendar.example.com",
        description: "チームの予定表",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "github-token" },
        allow: ["GET /**", "PUT /**"],
      }),
    );
  const operation = {
    via: "platform" as const,
    name: "calendar",
    target: "event-42",
    change: "開始時刻を10時から11時に変更する",
    verification: "event-42を再取得して開始時刻を確認する",
  };
  const success = out(
    block({
      "sacty-operation-result": {
        success: true,
        evidence: "event-42の開始時刻が11時であることを再取得して確認した",
      },
    }),
  );

  it("実オーケストレーターの1回の選択からoperationを直接実行して結果だけ承認する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const selected = out(
      block({ "sacty-steps": { plan: "operation", reason: "依頼された予定変更", operation } }),
    );
    const { service, executor } = makeService(activity, [selected, success], {
      realPlanner: true,
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "event-42の開始時刻を11時に変更",
      repo: null,
    });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.steps.map((step) => step.key)).toEqual(["operation"]);
    expect(task?.operation).toEqual(operation);
    expect(task?.gate?.step).toBe("operation");
    expect(executor.calls).toHaveLength(2); // 工程選択 + 単発作業。準備の実行や承認はない。
    expect(executor.calls[0]?.command.join(" ")).toContain("実行設定を同じ回答に書く");
    expect(executor.calls[1]?.command.join(" ")).toContain("event-42の開始時刻を11時に変更");
    expect(activity.forTask(id).filter((e) => e.type === "StepSubmitted")).toHaveLength(1);
    const { service: restored } = makeService(activity);
    expect(restored.get(id)?.task.operation).toEqual(operation);
    restored.approve(id, { step: "operation", submission: 1 });
    expect(isCompleted(restored.get(id)?.task as Task)).toBe(true);
    activity.close();
  });

  it("GitHub を接続先にした作業は、gh のアカウントのホストで実行し、頼まれたコメントを結果の承認の後に投稿する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const github = {
      via: "github" as const,
      name: "github.com",
      target: "https://github.com/acme/app/pull/12",
      change: "レビューの指摘に、対応の方針を返信する",
      verification: "PR のコメントを読み直して確かめる",
    };
    const selected = out(
      block({
        "sacty-steps": { plan: "operation", reason: "PR への返信", operation: github },
      }),
    );
    const result = out(
      [
        block({
          "sacty-operation-result": {
            success: true,
            evidence: "PR #12 の指摘を gh api で読み、返信の内容を頼んだ",
          },
        }),
        block({
          "sacty-github-comments": {
            comments: [{ url: "https://github.com/acme/app/pull/12", body: "方針：こう直します" }],
          },
        }),
      ].join("\n"),
    );
    const { service, executor, pulls } = makeService(activity, [selected, result], {
      realPlanner: true,
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "https://github.com/acme/app/pull/12 のレビューの指摘に返信",
      repo: null,
    });
    await service.runNext(id);
    // 接続先の候補に、gh のアカウントを選んだ GitHub のホストを出す
    expect(executor.calls[0]?.command.join(" ")).toContain("github/github.com");
    expect(service.get(id)?.task.operation).toEqual(github);
    expect(service.get(id)?.task.gate?.step).toBe("operation");
    expect(executor.calls[1]?.command.join(" ")).toContain("接続先は GitHub");
    expect(executor.calls[1]?.env.SACTY_GITHUB_URL).toContain("/github");
    expect(pulls.issueComments).toHaveLength(0);
    service.approve(id, { step: "operation", submission: 1 });
    await service.runNext(id);
    expect(pulls.issueComments).toHaveLength(1);
    expect(pulls.issueComments[0]).toMatchObject({ number: 12, token: "ghp_secret" });
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    activity.close();
  });

  it("対象リポジトリのあるタスクでも、オーケストレーターが作業の実行設定を決め、保存して作業を始める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const github = {
      via: "github" as const,
      name: "github.com",
      target: "https://github.com/acme/app/issues/7",
      change: "調査の結果をコメントする",
      verification: "Issue のコメントを読み直して確かめる",
    };
    const selected = out(
      block({
        "sacty-steps": {
          plan: "operation",
          reason: "Issue へのコメント",
          baseBranch: "main",
          operation: github,
        },
      }),
    );
    const result = out(
      block({
        "sacty-operation-result": { success: true, evidence: "Issue #7 を読み、コメントを頼んだ" },
      }),
    );
    const { service, executor } = makeService(activity, [selected, result], {
      realPlanner: true,
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "Issue #7 にコメントする",
      repo: "https://github.com/acme/app",
    });
    await service.runNext(id);
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    // リポジトリのあるタスクの指示にも、実行設定の項目・接続先・答えの形を出す
    expect(prompt).toContain("実行設定を同じ回答に書く");
    expect(prompt).toContain("github/github.com");
    expect(prompt).toContain('"operation": {"via"');
    const task = service.get(id)?.task;
    expect(task?.repository).toBeDefined();
    expect(task?.operation).toEqual(github);
    expect(task?.steps.map((step) => step.key)).toEqual(["operation"]);
    expect(task?.gate?.step).toBe("operation");
    expect(executor.calls[1]?.command.join(" ")).toContain("接続先は GitHub");
    activity.close();
  });

  it("作業のみを選べないタスク（ほかの組み合わせを指定した）では、実行設定を決めさせない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const selected = out(block({ "sacty-steps": { plan: "investigate", reason: "調べる" } }));
    const { service, executor } = makeService(activity, [selected, out("# 調査")], {
      realPlanner: true,
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "仕組みを調べる",
      repo: "https://github.com/acme/app",
      plan: "investigate",
    });
    await service.runNext(id);
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    expect(prompt).not.toContain("実行設定を同じ回答に書く");
    expect(prompt).not.toContain("単発作業に使える接続先");
    activity.close();
  });

  it("GitHub を接続先にした作業でも、アカウントを選んでいないホストなら始めずに止める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      planner: async () => ({
        steps: [...STEP_PLANS.operation],
        plan: "operation",
        reason: "PR への返信",
        operation: { ...operation, via: "github", name: "ghe.example.co.jp" },
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "返信", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(executor.calls).toHaveLength(0);
    activity.close();
  });

  it("ユーザー文書を実装なしで作成し、差戻し後の成果を承認して完了できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos, pulls } = makeService(
      activity,
      [out("# 利用手順 v1"), out("# 利用手順 v2")],
      { planner: planner("document") },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "利用手順を作る",
      repo: null,
    });
    await service.runNext(id);
    expect(service.get(id)?.task.gate?.step).toBe("document");
    service.requestChanges(id, {
      step: "document",
      submission: 1,
      comments: ["初回設定の説明を追加"],
    });
    await service.runNext(id);
    service.approve(id, { step: "document", submission: 2 });
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    expect(executor.calls).toHaveLength(2);
    expect(repos.prepared).toEqual([]);
    expect(pulls.calls).toEqual([]);
    activity.close();
  });

  it("文書作成の原稿のセルフレビューの報告を記録し、原稿の本文から取り除く。差し戻しの直しには、観点を絞る指示を渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const report = {
      rounds: 2,
      passed: true,
      remaining: [],
      notReviewed: [],
      summary: "手順の結果を足した",
    };
    const { service, executor } = makeService(
      activity,
      [out(`# 利用手順 v1\n\n${block({ "sacty-self-review": report })}`), out("# 利用手順 v2")],
      { planner: planner("document") },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "利用手順を作る",
      repo: null,
    });
    await service.runNext(id);
    // 最初の実行の指示は、原稿のセルフレビューを求める（全部の観点で見る）
    expect(promptOf(executor, 0)).toContain(
      "既定のスキル review-dispatch（流れは self-review）で原稿をセルフレビューする",
    );
    expect(promptOf(executor, 0)).not.toContain("を受けた直しである");
    expect(taskOf(service, id).selfReviews?.document).toEqual(report);
    const done = service.get(id)?.activity.find((e) => e.type === "AgentRunCompleted");
    expect(done?.type === "AgentRunCompleted" && done.payload.selfReview).toEqual(report);
    // 報告は原稿に残さない（承認・書き出しの対象は原稿だけ）
    expect(taskOf(service, id).outputs.document).toBe("# 利用手順 v1");
    service.requestChanges(id, {
      step: "document",
      submission: 1,
      comments: ["初回設定の説明を追加"],
    });
    await service.runNext(id);
    // 前の提出がパスしているので、差し戻しの直しは、指摘に関わる観点だけで見させる
    expect(promptOf(executor, 1)).toContain("を受けた直しである");
    // 報告が無い提出は「記録なし」にして、工程は止めない
    expect(taskOf(service, id).selfReviews?.document).toBeNull();
    expect(taskOf(service, id).gate).toEqual({ step: "document", submission: 2 });
    expect(taskOf(service, id).outputs.document).toBe("# 利用手順 v2");
    activity.close();
  });

  it("文書は承認後に指定先へ書き出し、URLを記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const selected: ServiceDeps["planner"] = async () => ({
      steps: [...STEP_PLANS.document],
      plan: "document",
      reason: "利用者向け手順",
      fallback: false,
      costUsd: 0,
      estimated: false,
      exports: {
        document: {
          to: { via: "platform", name: "calendar", location: "説明ページ" },
          reason: "依頼された保存先",
        },
      },
    });
    const { service, executor } = makeService(
      activity,
      [
        out("# 予定表の利用手順"),
        out(block({ "sacty-export": { url: "https://calendar.example.com/help" } })),
      ],
      { planner: selected, config: configOf(agent(), 1, [calendar()]), gateway: fakeGateway() },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "利用手順の作成と保存",
      repo: null,
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    service.approve(id, { step: "document", submission: 1 });
    expect(exportDue(service.get(id)?.task as Task)).toBe("document");
    await service.runNext(id);
    expect(service.get(id)?.task.exports.document?.url).toBe("https://calendar.example.com/help");
    expect(executor.calls).toHaveLength(2);
    activity.close();
  });

  it("タスクの説明に従って外部に直接書いた複数のページを成果物として記録し、差し戻しで同じページを直させ、書き出さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const PAGE1 = "https://calendar.example.com/help/1";
    const PAGE2 = "https://calendar.example.com/help/2";
    const PAGE3 = "https://calendar.example.com/help/3";
    // 差し戻しの回の出力。指摘の ID が決まってから中身を入れる
    const second = out("");
    const selected: ServiceDeps["planner"] = async () => ({
      steps: [...STEP_PLANS.document],
      plan: "document",
      reason: "利用者向け手順",
      fallback: false,
      costUsd: 0,
      estimated: false,
      exports: {
        document: {
          to: { via: "platform", name: "calendar", location: "説明ページ" },
          reason: "依頼された保存先",
        },
      },
    });
    const { service, executor } = makeService(
      activity,
      [
        out(
          `## 手順1\n\n直した内容\n\n${block({ "sacty-document-pages": { pages: [PAGE1, PAGE2] } })}`,
        ),
        second,
      ],
      { planner: selected, config: configOf(agent(), 1, [calendar()]), gateway: fakeGateway() },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "古い手順を含む説明ページをまとめて直す",
      repo: null,
    });
    await service.runNext(id);
    expect(taskOf(service, id).documentPages).toEqual([PAGE1, PAGE2]);
    // 申告は出力に残さない
    expect(taskOf(service, id).outputs.document).toBe("## 手順1\n\n直した内容");
    service.requestChanges(id, {
      step: "document",
      submission: 1,
      comments: ["説明ページの手順を直して。3ページ目も対象に"],
    });
    // 差し戻しでは、直したページだけを申告しても、前の回のページは成果物のまま。指摘への対応と同じ JSON に入れても、
    // 申告を読む（PR #220 レビュー指摘）
    const remarkId = taskOf(service, id).remarks[0]?.id ?? "";
    Object.assign(second, {
      output: `## 手順2\n\n直した内容\n\n${block({
        "sacty-responses": [{ remarkId, text: "3ページ目も直した" }],
        "sacty-document-pages": { pages: [PAGE2, PAGE3] },
      })}`,
    });
    await service.runNext(id);
    expect(promptOf(executor, 1)).toContain(`  - ${PAGE1}`);
    expect(promptOf(executor, 1)).toContain(`  - ${PAGE2}`);
    expect(taskOf(service, id).documentPages).toEqual([PAGE1, PAGE2, PAGE3]);
    expect(taskOf(service, id).remarks[0]?.response).toBe("3ページ目も直した");
    expect(taskOf(service, id).outputs.document).toBe("## 手順2\n\n直した内容");
    service.approve(id, { step: "document", submission: 2 });
    // 外部に直接書いたページが成果物なので、書き出さない（原稿を別のページとして出さない）
    expect(exportDue(taskOf(service, id))).toBeUndefined();
    await service.runNext(id);
    expect(executor.calls).toHaveLength(2);
    expect(isCompleted(taskOf(service, id))).toBe(true);
    activity.close();
  });

  it("オーケストレーターの作業指定を保存して一度実行し、結果だけの承認を待つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [success], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "予定を11時へ変更",
      repo: null,
    });
    await service.runNext(id);
    expect(service.get(id)?.task.operation).toEqual(operation);
    expect(service.get(id)?.task.operationAttempted).toBe(true);
    expect(service.get(id)?.task.gate?.step).toBe("operation");
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.env.SACTY_PF_URL).toBeDefined();
    expect(executor.calls[0]?.command.join(" ")).toContain("event-42");
    expect(() =>
      service.requestChanges(id, { step: "operation", submission: 1, comments: ["もう一度"] }),
    ).toThrow();
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    service.approve(id, { step: "operation", submission: 1 });
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    activity.close();
  });

  it("成功根拠を返さない外部作業は停止し、再起動と再開後にも再実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const options = {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    };
    const { service, executor } = makeService(activity, [out("処理しました")], options);
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(executor.calls).toHaveLength(1);
    const restarted = makeService(activity, [success], options);
    restarted.service.recoverInterrupted();
    expect(restarted.service.get(id)?.task.operationAttempted).toBe(true);
    expect(() => restarted.service.resume(id, {})).toThrow();
    await restarted.service.runNext(id);
    expect(restarted.executor.calls).toEqual([]);
    expect(restarted.service.get(id)?.task.status).toBe("paused");
    activity.close();
  });

  it("外部作業の実行器がタイムアウトしても再開・再実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [{ kind: "failed", reason: "error", message: "Executor timeout" }],
      {
        planner: planner("operation"),
        config: configOf(agent(), 1, [calendar()]),
        gateway: fakeGateway(),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.operationAttempted).toBe(true);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(() => service.resume(id, {})).toThrow();
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    expect(service.get(id)?.task.status).toBe("paused");
    activity.close();
  });

  it.each([false, true])(
    "再起動した操作の元runを保存し中止で停止確認する（停止=%s）",
    async (stops) => {
      const activity = new SqliteActivityStore(dbPath);
      const options = {
        planner: planner("operation"),
        config: configOf(agent(), 1, [calendar()]),
        gateway: fakeGateway(),
      };
      const { service } = makeService(activity, [], options);
      const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [...STEP_PLANS.operation],
                plan: "operation",
                reason: "予定更新",
                operation,
              },
            },
          },
          {
            actor: "sacty",
            event: {
              type: "AgentRunStarted",
              payload: {
                runId: "interrupted-operation",
                step: "operation",
                agentId: "claude-subscription",
                authMode: "subscription",
              },
            },
          },
        ],
      });
      const workspace = join(dir, "workspaces", id, "operation", "interrupted-operation");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "state.txt"), "実行中の状態");
      const restarted = makeService(activity, [success], options);
      restarted.service.recoverInterrupted();
      expect(restarted.service.get(id)?.task.unstoppedRuns).toEqual(["interrupted-operation"]);
      expect(restarted.service.get(id)?.task.operationAttempted).toBe(true);
      expect(restarted.service.get(id)?.task.status).toBe("paused");
      expect(() => restarted.service.resume(id, {})).toThrow();
      await restarted.service.runNext(id);
      expect(restarted.executor.calls).toEqual([]);
      expect(restarted.service.get(id)?.task.status).toBe("paused");
      // recoverInterruptedが記録したrun IDは、さらに読み直しても中止の確認対象になる。
      const restored = makeService(activity, [], options);
      restored.executor.stops = stops;
      const ensure = vi.spyOn(restored.executor, "ensureStopped");
      expect(restored.service.get(id)?.task.unstoppedRuns).toEqual(["interrupted-operation"]);
      const cancelled = await restored.service.cancel(id);
      expect(restored.executor.killed).toContain("interrupted-operation");
      expect(ensure).toHaveBeenCalledWith("interrupted-operation");
      expect(cancelled.cancelled?.cleanup.find((c) => c.target === "container")?.result).toBe(
        stops ? "done" : "failed",
      );
      expect(existsSync(workspace)).toBe(!stops);
      expect(restored.executor.calls).toEqual([]);
      activity.close();
    },
  );

  it("文書作成にも、ほかの工程と同じく登録済みPF・MCP・コンテキスト・GitHub の読み取りを渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const gateway = fakeGateway();
    const register = vi.spyOn(gateway, "register");
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/context" },
    });
    const { service, executor } = makeService(activity, [out("# 利用者マニュアル")], {
      planner: planner("document"),
      projects,
      config: configOf(
        agent(),
        1,
        [calendar()],
        [toHostMcp("notion", HostMcpFile.parse({ command: "notion-mcp" }))],
      ),
      contexts: new FakeContexts({
        "https://github.com/acme/context": { "rules.md": "# 文書の規約" },
      }),
      gateway,
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "利用者マニュアル作成",
      repo: null,
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.env.SACTY_PF_URL).toBeDefined();
    expect(executor.mcpConfigs[0]).toContain("notion");
    expect(executor.contexts[0]).toContain("文書の規約");
    // 接続先を決めて使う実行（操作・書き出し）と違い、PF・MCP を絞らない
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[3]).toBeUndefined();
    expect(Object.keys(register.mock.calls[0]?.[4] ?? {})).toEqual(["github.com"]);
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    expect(prompt).toContain("- calendar：チームの予定表");
    expect(prompt).toContain("--- GitHub（読み取り） ---");
    const resolved = service.get(id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved).toBeDefined();
    expect(service.get(id)?.task.gate?.step).toBe("document");
    activity.close();
  });

  it.each(["platform", "mcp"] as const)(
    "複数のPFとMCPがあっても指定された%s接続だけを実行に渡す",
    async (via) => {
      const activity = new SqliteActivityStore(dbPath);
      const gateway = fakeGateway();
      const register = vi.spyOn(gateway, "register");
      const name = via === "platform" ? "calendar" : "notion";
      const { service, executor } = makeService(activity, [success], {
        planner: async () => ({
          steps: [...STEP_PLANS.operation],
          plan: "operation",
          reason: "予定更新",
          fallback: false,
          costUsd: 0,
          estimated: false,
          operation: { ...operation, via, name },
        }),
        gateway,
        config: configOf(
          agent(),
          1,
          [calendar(), { ...calendar(), name: "other-calendar" }],
          [
            toHostMcp("notion", HostMcpFile.parse({ command: "notion-mcp" })),
            toHostMcp("other-mcp", HostMcpFile.parse({ command: "other-mcp" })),
          ],
        ),
      });
      const { id } = service.createTask({ projectId: "default", title: "予定変更", repo: null });
      await service.runNext(id);
      expect(service.get(id)?.task.gate?.step).toBe("operation");
      const invocation = executor.calls[0];
      expect(invocation?.env.SACTY_PF_URL !== undefined).toBe(via === "platform");
      const mcp = JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers ?? {};
      expect(Object.keys(mcp)).toEqual(via === "mcp" ? ["notion"] : []);
      expect(register.mock.calls.at(-1)?.[3]).toEqual({
        platforms: via === "platform" ? ["calendar"] : [],
        hostMcp: via === "mcp" ? ["notion"] : [],
      });
      service.approve(id, { step: "operation", submission: 1 });
      expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
      activity.close();
    },
  );

  it("工程決定後に接続先が削除されたら外部実行を開始せず一時停止する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const gateway = fakeGateway();
    const register = vi.spyOn(gateway, "register");
    const { service, executor } = makeService(activity, [success], {
      planner: planner("operation"),
      config: configOf(agent(), 1, []),
      gateway,
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "StepsChosen",
            payload: {
              steps: [...STEP_PLANS.operation],
              plan: "operation",
              reason: "削除前の接続先を選択",
              operation,
            },
          },
        },
      ],
    });
    const restarted = makeService(activity, [success], {
      config: configOf(agent(), 1, []),
      gateway,
    });
    await restarted.service.runNext(id);
    expect(restarted.service.get(id)?.task.status).toBe("paused");
    expect(restarted.service.get(id)?.task.operationAttempted).toBeUndefined();
    expect(executor.calls).toEqual([]);
    expect(restarted.executor.calls).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(() => restarted.service.resume(id, {})).not.toThrow();
    activity.close();
  });

  it("外部作業は、人が選んだエージェントで行う。準備の間に変えたら古いエージェントで始めず、名前が消えていれば動かさずに止める（PBI-121。PR #131 レビュー指摘）", async () => {
    const strong = agent({ id: "strong", model: "claude-opus-5-5" });
    const other = agent({ id: "other", model: "claude-sonnet-5-5" });
    for (const scenario of ["changedWhilePreparing", "removed"] as const) {
      const activity = new SqliteActivityStore(dbPath);
      let agents = [agent(), strong, other];
      const base = configOf(agent(), 1, [calendar()]);
      const config = (): ConfigResult => {
        const loaded = base() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: { ...loaded.config, agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
        };
      };
      const { service, executor } = makeService(activity, [success], {
        config,
        gateway: fakeGateway(),
      });
      const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [...STEP_PLANS.operation],
                plan: "operation",
                reason: "予定更新",
                operation,
              },
            },
          },
        ],
      });
      const restarted = makeService(activity, [success], { config, gateway: fakeGateway() });
      restarted.service.changeStepAgent(id, { step: "operation", agent: "strong" });
      if (scenario === "removed") {
        agents = [agent()];
        await restarted.service.runNext(id);
        expect(restarted.service.get(id)?.task.pausedMessage).toEqual(
          message("agent.chosenMissing", { step: "operation", name: "strong" }),
        );
        expect(restarted.service.get(id)?.task.operationAttempted).toBeUndefined();
        expect(restarted.executor.calls).toEqual([]);
      } else {
        // 接続先を用意している間に、人が別のエージェントに変える
        const svc = restarted.service as unknown as {
          findPlatform: (...args: unknown[]) => Promise<unknown>;
        };
        const find = svc.findPlatform.bind(svc);
        const spy = vi.spyOn(svc, "findPlatform").mockImplementationOnce(async (...args) => {
          const found = await find(...args);
          restarted.service.changeStepAgent(id, { step: "operation", agent: "other" });
          return found;
        });
        await restarted.service.runNext(id);
        // 古いエージェント（strong）では始めず、実行待ちのまま戻す
        expect(restarted.service.get(id)?.task.status).toBe("queued");
        expect(restarted.service.get(id)?.task.operationAttempted).toBeUndefined();
        expect(restarted.executor.calls).toEqual([]);
        spy.mockRestore();
        // 次の実行で、新しいエージェントで始める
        await restarted.service.runNext(id);
        const started = restarted.service
          .get(id)
          ?.activity.filter((e) => e.type === "AgentRunStarted");
        expect(started?.map((e) => e.type === "AgentRunStarted" && e.payload.agentId)).toEqual([
          "other",
        ]);
        expect(restarted.executor.calls[0]?.command.join(" ")).toContain("claude-sonnet-5-5");
      }
      expect(executor.calls).toEqual([]);
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("外部作業の接続先を調べている間に、消えた名前から有効な名前へ選び直したら、古い名前で止めずに新しい名前で始める（PR #131 再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const removed = agent({ id: "removed", model: "claude-haiku-5-5" });
    const valid = agent({ id: "valid", model: "claude-sonnet-5-5" });
    let agents = [agent(), removed, valid];
    const base = configOf(agent(), 1, [calendar()]);
    const config = (): ConfigResult => {
      const loaded = base() as { ok: true; config: SactyConfig };
      return {
        ok: true,
        config: { ...loaded.config, agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
      };
    };
    const { service } = makeService(activity, [], { config, gateway: fakeGateway() });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "StepsChosen",
            payload: {
              steps: [...STEP_PLANS.operation],
              plan: "operation",
              reason: "予定更新",
              operation,
            },
          },
        },
      ],
    });
    const restarted = makeService(activity, [success], { config, gateway: fakeGateway() });
    restarted.service.changeStepAgent(id, { step: "operation", agent: "removed" });
    agents = [agent(), valid];
    const svc = restarted.service as unknown as {
      exportDestinations: (...args: unknown[]) => Promise<unknown>;
    };
    const destinations = svc.exportDestinations.bind(svc);
    vi.spyOn(svc, "exportDestinations").mockImplementationOnce(async (...args) => {
      const found = await destinations(...args);
      restarted.service.changeStepAgent(id, { step: "operation", agent: "valid" });
      return found;
    });
    await restarted.service.runNext(id);
    const task = restarted.service.get(id)?.task;
    expect(task?.pausedMessage).toBeUndefined();
    const started = restarted.service.get(id)?.activity.filter((e) => e.type === "AgentRunStarted");
    expect(started?.map((e) => e.type === "AgentRunStarted" && e.payload.agentId)).toEqual([
      "valid",
    ]);
    expect(restarted.executor.calls[0]?.command.join(" ")).toContain("claude-sonnet-5-5");
    activity.close();
  });

  it.each([
    ["今の設定にあるイメージ", false],
    ["準備の間に config.yaml に足したイメージ", true],
  ])(
    "外部作業の接続先を用意している間に%sに変えたら、止めずに実行待ちのまま戻し、次の実行で変えた後のイメージで始めて、その名前を実行の記録に残す（PBI-318 レビュー指摘）",
    async (_, addedDuringPreparation) => {
      const activity = new SqliteActivityStore(dbPath);
      const base = configOf(agent(), 1, [calendar()]);
      const image = (name: string) => ({
        name,
        image: `sacty-agent-${name}:test`,
        description: name,
        env: { IMAGE_NAME: name },
      });
      let added = !addedDuringPreparation;
      const config = (): ConfigResult => {
        const loaded = base() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: {
            ...loaded.config,
            images: { java: image("java"), ...(added ? { web: image("web") } : {}) },
          },
        };
      };
      const { service } = makeService(activity, [], { config, gateway: fakeGateway() });
      const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [...STEP_PLANS.operation],
                plan: "operation",
                reason: "予定更新",
                operation,
                image: "java",
              },
            },
          },
        ],
      });
      const restarted = makeService(activity, [success], { config, gateway: fakeGateway() });
      const svc = restarted.service as unknown as {
        findPlatform: (...args: unknown[]) => Promise<unknown>;
      };
      const find = svc.findPlatform.bind(svc);
      vi.spyOn(svc, "findPlatform").mockImplementationOnce(async (...args) => {
        const found = await find(...args);
        added = true;
        restarted.service.changeTaskImage(id, { image: "web" });
        return found;
      });
      await restarted.service.runNext(id);
      // この実行では始めない（古いイメージでも、読み直していない設定でも始めず、止めもしない）
      expect(restarted.executor.images).toEqual([]);
      expect(restarted.service.get(id)?.task.status).toBe("queued");
      expect(restarted.service.get(id)?.activity.some((e) => e.type === "AgentRunStarted")).toBe(
        false,
      );
      await restarted.service.runNext(id);
      expect(restarted.executor.images).toEqual([
        { image: "sacty-agent-web:test", env: { IMAGE_NAME: "web" } },
      ]);
      const started = restarted.service
        .get(id)
        ?.activity.filter((e) => e.type === "AgentRunStarted");
      expect(started?.map((e) => e.type === "AgentRunStarted" && e.payload.image)).toEqual(["web"]);
      activity.close();
    },
  );

  it("外部作業の接続先を調べている間に、config.yaml に足した名前を選んだら、古い設定で止めずに次の実行で最新の設定から始める（PR #131 再々レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const old = agent({ id: "old", model: "claude-haiku-5-5" });
    const added = agent({ id: "new", model: "claude-sonnet-5-5" });
    let agents = [agent(), old];
    const base = configOf(agent(), 1, [calendar()]);
    const config = (): ConfigResult => {
      const loaded = base() as { ok: true; config: SactyConfig };
      return {
        ok: true,
        config: { ...loaded.config, agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
      };
    };
    const { service } = makeService(activity, [], { config, gateway: fakeGateway() });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "StepsChosen",
            payload: {
              steps: [...STEP_PLANS.operation],
              plan: "operation",
              reason: "予定更新",
              operation,
            },
          },
        },
      ],
    });
    const restarted = makeService(activity, [success], { config, gateway: fakeGateway() });
    restarted.service.changeStepAgent(id, { step: "operation", agent: "old" });
    const svc = restarted.service as unknown as {
      exportDestinations: (...args: unknown[]) => Promise<unknown>;
    };
    const destinations = svc.exportDestinations.bind(svc);
    vi.spyOn(svc, "exportDestinations").mockImplementationOnce(async (...args) => {
      const found = await destinations(...args);
      // 待っている間に config.yaml に足し、それを選ぶ
      agents = [agent(), old, added];
      restarted.service.changeStepAgent(id, { step: "operation", agent: "new" });
      return found;
    });
    await restarted.service.runNext(id);
    // 古い設定には無いが、止めずに実行待ちのまま戻す
    expect(restarted.service.get(id)?.task.status).toBe("queued");
    expect(restarted.service.get(id)?.task.pausedMessage).toBeUndefined();
    expect(restarted.executor.calls).toEqual([]);
    await restarted.service.runNext(id);
    const started = restarted.service.get(id)?.activity.filter((e) => e.type === "AgentRunStarted");
    expect(started?.map((e) => e.type === "AgentRunStarted" && e.payload.agentId)).toEqual(["new"]);
    expect(restarted.executor.calls[0]?.command.join(" ")).toContain("claude-sonnet-5-5");
    activity.close();
  });

  it("外部実行中に中止した後で成功応答が届いても承認待ちにせず再実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    const started = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<AgentOutcome>();
    const run = vi.spyOn(executor, "run").mockImplementationOnce(async () => {
      started.resolve();
      return outcome.promise;
    });
    const running = service.runNext(id);
    await started.promise;
    expect(service.get(id)?.task.operationAttempted).toBe(true);
    const stopRequested = Promise.withResolvers<void>();
    vi.spyOn(executor, "kill").mockImplementation(() => {
      stopRequested.resolve();
    });
    const cancelling = service.cancel(id);
    await stopRequested.promise;
    outcome.resolve(success);
    await Promise.all([running, cancelling]);
    expect(service.get(id)?.task.status).toBe("cancelled");
    expect(service.get(id)?.task.gate).toBeUndefined();
    await service.runNext(id);
    expect(run).toHaveBeenCalledTimes(1);
    activity.close();
  });

  it.each([
    ["未指定", undefined],
    ["対象なし", { ...operation, target: "" }],
    ["変更内容なし", { ...operation, change: "" }],
    ["確認方法なし", { ...operation, verification: "" }],
    ["接続先名なし", { ...operation, name: "" }],
  ])("作業指定が不十分（%s）なら実行前に停止し再開は許可する", async (_name, specified) => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [success], {
      planner: async () => ({
        steps: [...STEP_PLANS.operation],
        plan: "operation",
        reason: "予定更新",
        fallback: false,
        costUsd: 0,
        estimated: false,
        operation: specified as typeof operation | undefined,
      }),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.operationAttempted).toBeUndefined();
    expect(executor.calls).toEqual([]);
    expect(() => service.resume(id, {})).not.toThrow();
    activity.close();
  });

  it.each(["manual", "failed", "throw"] as const)(
    "外部実行の停止未確認を保持し、中止で再確認する（%s）",
    async (mode) => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [HOLD], {
        planner: planner("operation"),
        config: configOf(agent(), 1, [calendar()]),
        gateway: fakeGateway(),
      });
      const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
      executor.stops = false;
      if (mode === "failed")
        vi.spyOn(executor, "run").mockResolvedValueOnce({
          kind: "failed",
          reason: "error",
          message: "timeout",
        });
      if (mode === "throw")
        vi.spyOn(executor, "run").mockRejectedValueOnce(new Error("executor lost connection"));
      const running = service.runNext(id);
      if (mode === "manual") {
        await executor.started.promise;
        await service.pause(id);
      }
      await running;
      const stopped = service.get(id)?.task;
      const runId = activity
        .forTask(id)
        .filter((e) => e.type === "AgentRunStarted")
        .at(-1)?.payload.runId as string;
      expect(stopped?.status).toBe("paused");
      expect(stopped?.unstoppedRuns).toEqual([runId]);
      const workspace = join(dir, "workspaces", id, "operation", runId);
      expect(existsSync(workspace)).toBe(true);
      const { service: restarted, executor: restartedExecutor } = makeService(activity);
      expect(restarted.get(id)?.task.unstoppedRuns).toEqual([runId]);
      restartedExecutor.stops = false;
      expect(await restarted.confirmPausedContainers(id)).toBe(false);
      expect(restartedExecutor.killed).toContain(runId);
      const cancelled = await restarted.cancel(id);
      expect(cancelled.cancelled?.cleanup.find((c) => c.target === "container")?.result).toBe(
        "failed",
      );
      expect(cancelled.cancelled?.cleanup.find((c) => c.target === "workspace")?.result).toBe(
        "failed",
      );
      expect(existsSync(workspace)).toBe(true);
      activity.close();
    },
  );

  it("外部実行の停止を後から確認できれば中止で保持した作業領域を消す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    executor.stops = false;
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    await service.pause(id);
    await running;
    const workspace = join(dir, "workspaces", id, "operation", runId);
    expect(existsSync(workspace)).toBe(true);
    executor.stops = true;
    const cancelled = await service.cancel(id);
    expect(cancelled.cancelled?.cleanup.find((c) => c.target === "container")?.result).toBe("done");
    expect(existsSync(workspace)).toBe(false);
    activity.close();
  });

  it("成功応答でもコンテナの停止未確認なら結果承認へ進めない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [success], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    executor.stops = false;
    const ensure = vi.spyOn(executor, "ensureStopped");
    await service.runNext(id);
    const runId = activity.forTask(id).find((e) => e.type === "AgentRunStarted")?.payload.runId;
    expect(ensure).toHaveBeenCalledWith(runId);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.gate).toBeUndefined();
    expect(service.get(id)?.task.unstoppedRuns).toEqual([runId]);
    expect(service.get(id)?.task.outputs.operation).toContain("event-42");
    expect(existsSync(executor.dirs[0] ?? "")).toBe(true);
    expect(() => service.approve(id, { step: "operation", submission: 1 })).toThrow();
    activity.close();
  });

  it("開始済みの操作が実行待ちに復元されてもserviceが明示理由で再開始を拒否する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const options = {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    };
    const { service } = makeService(activity, [], options);
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    // 実行失敗を保存した直後、TaskPausedの記録より前にデーモンが停止した境界。
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["operation"], plan: "operation", operation },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: {
              runId: "first-operation",
              step: "operation",
              agentId: "claude-subscription",
              authMode: "subscription",
            },
          },
        },
        {
          actor: "agent",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId: "first-operation",
              step: "operation",
              agentId: "claude-subscription",
              reason: "error",
              message: "lost connection",
            },
          },
        },
      ],
    });
    const restored = makeService(activity, [success], options);
    expect(restored.service.get(id)?.task).toMatchObject({
      status: "queued",
      operationAttempted: true,
    });
    await restored.service.runNext(id);
    // 投影層の整合性エラーではなく、人に対処方法を示す通常の停止になる。
    expect(restored.service.get(id)?.task.pausedMessage).toEqual(message("operation.attempted"));
    expect(restored.service.get(id)?.task.status).toBe("paused");
    expect(restored.executor.calls).toEqual([]);
    expect(activity.forTask(id).filter((e) => e.type === "AgentRunStarted")).toHaveLength(1);
    activity.close();
  });
});

describe("提出の前のセルフレビューの記録（PBI-120）", () => {
  const withReport = (body: string, report?: unknown): AgentOutcome => ({
    kind: "completed",
    output:
      report === undefined
        ? body
        : `${body}\n\n\`\`\`json\n${JSON.stringify({ "sacty-self-review": report })}\n\`\`\``,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });

  it("要求要件の報告を作業履歴とタスクに残し、成果物の本文からは取り除く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const report = {
      rounds: 2,
      passed: true,
      remaining: [],
      notReviewed: [],
      summary: "直した",
      needsDecision: ["同じ原因が3回目。範囲を絞る"],
    };
    const { service } = makeService(activity, [withReport("# 要求要件", report)]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    const done = service.get(id)?.activity.find((e) => e.type === "AgentRunCompleted");
    expect(done?.type === "AgentRunCompleted" && done.payload.selfReview).toEqual(report);
    const task = service.get(id)?.task;
    expect(task?.selfReviews?.requirements).toEqual(report);
    expect(task?.outputs.requirements).toBe("# 要求要件");
    activity.close();
  });

  it("報告が無い・形が違うときは「記録なし」（null）にして、工程は止めない", async () => {
    for (const report of [undefined, { rounds: "two" }]) {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [withReport("# 要求要件", report)]);
      const { id } = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.selfReviews?.requirements).toBeNull();
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.outputs.requirements).toBe("# 要求要件");
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("やり直して報告が変われば、最新の報告にする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [
      withReport("# 要求要件", { rounds: 5, passed: false, remaining: ["異常系が無い"] }),
      withReport("# 要求要件（直した）", { rounds: 1, passed: true }),
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(service.get(id)?.task.selfReviews?.requirements?.passed).toBe(false);
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["異常系を足す"] });
    await service.runNext(id);
    expect(service.get(id)?.task.selfReviews?.requirements).toMatchObject({
      passed: true,
      rounds: 1,
    });
    activity.close();
  });

  it("変更の申し出で本文を差し替えたら、前の「パス」を残さず「記録なし」にする（PR #130 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const json = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
    const design: AgentOutcome = {
      kind: "completed",
      output: [
        "# 設計 v1",
        json({
          "sacty-test-viewpoints": [{ title: "A", input: "Aの入力", expected: "Aの期待結果" }],
        }),
        json({
          "sacty-change-proposal": {
            target: "requirements",
            reason: "外部APIが冪等性キーに対応していない",
            facts: ["API仕様書に Idempotency-Key が無い"],
            proposed: "# 要求要件 v2",
          },
        }),
        json({ "sacty-self-review": { rounds: 1, passed: true } }),
      ].join("\n\n"),
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const undecidable: AgentOutcome = {
      kind: "completed",
      output: json({ "sacty-verdict": { verdict: "undecidable", reason: "価値判断を含む" } }),
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const { service } = makeService(activity, [
      withReport("# 要求要件 v1", { rounds: 2, passed: true }),
      design,
      undecidable,
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(service.get(id)?.task.selfReviews?.requirements?.passed).toBe(true);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    const applied = service.decideChange(id, "CP-1", { accept: true });
    // 新しい本文を、工程を動かさずに再承認に回す。前の「パス」は新しい本文を見ていない
    expect(applied.gate).toEqual({ step: "requirements", submission: 2 });
    expect(applied.outputs.requirements).toBe("# 要求要件 v2");
    expect(applied.selfReviews?.requirements).toBeNull();
    // 再承認しても、記録なしのまま
    const reapproved = service.approve(id, { step: "requirements", submission: 2 });
    expect(reapproved.selfReviews?.requirements).toBeNull();
    activity.close();
  });
});

describe("提出の前の出典の分類の記録", () => {
  const withClassification = (body: string, classification?: unknown): AgentOutcome => ({
    kind: "completed",
    output:
      classification === undefined
        ? body
        : `${body}\n\n\`\`\`json\n${JSON.stringify({ "sacty-provenance": classification })}\n\`\`\``,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const requirements =
    "# 要求要件\n\n| R-1 | 支払う |\n| R-2 | 失敗を知らせる |\n| R-3 | 記録する |";

  it("Input を読み取り専用で置いて指示に書き、分類の抜き出しを Input と照らして記録し、本文からは取り除く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [
      withClassification(requirements, {
        mode: "subagent",
        items: [
          { id: "R-1", kind: "input", refs: [], excerpt: "カードで 支払える" },
          { id: "R-2", kind: "input", refs: [], excerpt: "依頼に無い文" },
          { id: "R-9", kind: "inference", refs: [], excerpt: "" },
          { id: "R-3", kind: "inference", refs: ["R-1"], excerpt: "捨てる" },
        ],
      }),
    ]);
    const { id } = service.createTask({
      projectId: "default",
      title: "決済",
      body: "カードで**支払える**ようにする",
    });
    await service.runNext(id);
    const mount = executor.inputMounts[0];
    expect(mount?.readOnly).toBe(true);
    expect(mount?.files["task.md"]).toContain("カードで**支払える**ようにする");
    // 実行の後に消す
    expect(existsSync(mount?.dir ?? "")).toBe(false);
    expect(executor.calls[0]?.command.join("\n")).toContain("Input のディレクトリ（/sacty-input");
    const done = service.get(id)?.activity.find((e) => e.type === "AgentRunCompleted");
    const expected = {
      sequential: false,
      items: [
        // 空白と Markdown の記号をそろえて照らす
        { id: "R-1", kind: "input", refs: [], excerpt: "カードで 支払える", found: true },
        { id: "R-2", kind: "input", refs: [], excerpt: "依頼に無い文", found: false },
        // 推論の抜き出しは捨てる。成果物に無い ID の分類は捨てる
        { id: "R-3", kind: "inference", refs: ["R-1"], excerpt: "" },
      ],
      unclassified: [],
    };
    expect(done?.type === "AgentRunCompleted" && done.payload.provenance).toEqual(expected);
    const task = service.get(id)?.task;
    expect(task?.provenances?.requirements).toEqual(expected);
    expect(task?.outputs.requirements).toBe(requirements);
    activity.close();
  });

  it("本文の外に書かれた作業の報告を取り除いて成果物にし、消した要求の行（R-n（削除：…））は確かめる項目に数えない（PBI-302 C1）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const body = [
      "# 要求要件",
      "",
      "| R-1（削除：区間のまとめ方は R-2 で決める） | | |",
      "| R-2 | 支払う |",
      "| R-3 | 記録する |",
    ].join("\n");
    const { service } = makeService(activity, [
      withClassification(`要求要件を直しました。セルフレビューは 1 回目で通りました。\n\n${body}`, {
        mode: "subagent",
        items: [
          { id: "R-1", kind: "inference", refs: [], excerpt: "" },
          { id: "R-2", kind: "inference", refs: [], excerpt: "" },
          { id: "R-3", kind: "derived", refs: ["R-2"], excerpt: "" },
        ],
      }),
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.outputs.requirements).toBe(body);
    // 削除した行 R-1 は、分類があっても、分類なしでも、確かめる項目に出ない
    expect(task?.provenances?.requirements?.items.map((item) => item.id)).toEqual(["R-2", "R-3"]);
    expect(task?.provenances?.requirements?.unclassified).toEqual([]);
    expect(buildStepDocument(task as unknown as Task, "requirements")).not.toContain("直しました");
    activity.close();
  });

  it("答えが無い・形が違うときは「記録なし」（null）にして、工程は止めない", async () => {
    for (const classification of [undefined, { items: "R-1" }]) {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [withClassification(requirements, classification)]);
      const { id } = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.provenances?.requirements).toBeNull();
      expect(task?.status).toBe("awaiting_approval");
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("mode が無い・知らない値の答えは、誰が分類したか分からないので記録なしにする", async () => {
    for (const mode of [undefined, "auto"]) {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [
        withClassification(requirements, {
          ...(mode === undefined ? {} : { mode }),
          items: [{ id: "R-1", kind: "derived", refs: ["R-2"], excerpt: "" }],
        }),
      ]);
      const { id } = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(id);
      expect(service.get(id)?.task.provenances?.requirements, String(mode)).toBeNull();
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("設計の答えの TV-n（JSON の n 番目）を、項目の欠けた観点を除いて振った ID に直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const json = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
    const design: AgentOutcome = {
      kind: "completed",
      output: [
        "# 設計",
        json({
          "sacty-test-viewpoints": [
            { title: "欠けた観点", input: "", expected: "x" },
            { title: "B", input: "Bの入力", expected: "Bの期待結果" },
          ],
        }),
        json({
          "sacty-provenance": {
            mode: "subagent",
            items: [
              { id: "TV-1", kind: "input", refs: [], excerpt: "決済の要求要件" },
              { id: "TV-2", kind: "inference", refs: [], excerpt: "" },
            ],
          },
        }),
      ].join("\n\n"),
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const { service, executor } = makeService(activity, [
      withClassification("# 決済の要求要件", { mode: "subagent", items: [] }),
      design,
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(executor.inputMounts[1]?.files["requirements.md"]).toContain("# 決済の要求要件");
    const task = service.get(id)?.task;
    expect(task?.testViewpoints.map((v) => [v.id, v.title])).toEqual([["TV-1", "B"]]);
    // 元の2番目（推論）が、振り直した TV-1 の分類になる。欠けた観点の分類は捨てる
    expect(task?.provenances?.design).toEqual({
      sequential: false,
      items: [{ id: "TV-1", kind: "inference", refs: [], excerpt: "" }],
      unclassified: [],
    });
    activity.close();
  });

  it("変更の申し出で本文を差し替えたら、前の分類を残さず「記録なし」にする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const json = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
    const design: AgentOutcome = {
      kind: "completed",
      output: [
        "# 設計 v1",
        json({
          "sacty-test-viewpoints": [{ title: "A", input: "Aの入力", expected: "Aの期待結果" }],
        }),
        json({
          "sacty-change-proposal": {
            target: "requirements",
            reason: "外部APIが冪等性キーに対応していない",
            facts: ["API仕様書に Idempotency-Key が無い"],
            proposed: "# 要求要件 v2",
          },
        }),
      ].join("\n\n"),
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const undecidable: AgentOutcome = {
      kind: "completed",
      output: json({ "sacty-verdict": { verdict: "undecidable", reason: "価値判断を含む" } }),
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const { service } = makeService(activity, [
      withClassification(requirements, { mode: "subagent", items: [] }),
      design,
      undecidable,
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(service.get(id)?.task.provenances?.requirements?.unclassified).toEqual([
      "R-1",
      "R-2",
      "R-3",
    ]);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    const applied = service.decideChange(id, "CP-1", { accept: true });
    expect(applied.outputs.requirements).toBe("# 要求要件 v2");
    expect(applied.provenances?.requirements).toBeNull();
    activity.close();
  });

  it("差し戻しの指摘を Input に入れ、分類の無い項目を数える", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [
      withClassification(requirements, { mode: "subagent", items: [] }),
      withClassification(requirements, {
        mode: "sequential",
        items: [
          { id: "R-2", kind: "input", refs: ["requirements-1-1"], excerpt: "失敗を通知する" },
        ],
      }),
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.requestChanges(id, {
      step: "requirements",
      submission: 1,
      comments: ["失敗を通知する"],
    });
    await service.runNext(id);
    expect(executor.inputMounts[1]?.files["remarks.md"]).toContain(
      "- [requirements-1-1] 失敗を通知する",
    );
    expect(service.get(id)?.task.provenances?.requirements).toEqual({
      sequential: true,
      items: [
        {
          id: "R-2",
          kind: "input",
          refs: ["requirements-1-1"],
          excerpt: "失敗を通知する",
          found: true,
        },
      ],
      unclassified: ["R-1", "R-3"],
    });
    activity.close();
  });
});
