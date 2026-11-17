import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MVP_STEPS, message, renderMessage } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { AgentConfig, ConfigResult, SactyConfig } from "./config.js";
import {
  type ContextFetcher,
  type ContextRef,
  DEFAULT_CONTEXT_DIR,
  GitContextFetcher,
} from "./context.js";
import { HostMcpFile, toHostMcp } from "./host-mcp.js";
import { type Platform, PlatformCredentials } from "./platforms.js";
import { MemoryProjectStore } from "./projects.js";
import {
  MemorySecretStore,
  OnePasswordSecretStore,
  type OpRunner,
  ResolvingSecretStore,
  SecretNotFoundError,
} from "./secrets.js";
import { createApp } from "./server.js";
import { InvalidOperationError, type ServiceDeps, type TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  completed,
  configOf,
  current,
  dbPath,
  dir,
  FakeContexts,
  FakeGitHub,
  FakeTickets,
  fakeGateway,
  foundTicket,
  ja,
  jiraPlatform,
  makeService,
  projectsWithAccount,
  triageOut,
  useTempDir,
} from "./testing/daemon.js";
import { idleFor } from "./testing/wait.js";

useTempDir();

describe("起動時に秘密情報をまとめて取り出す（PBI-48）", () => {
  /** まとめて取り出せる取り出し口の偽物。取り出せるものを持ち、呼ばれた参照を記録する。 */
  class PrefetchStore extends MemorySecretStore {
    prefetched: { refs: string[]; fresh?: boolean }[] = [];
    constructor(private readonly available: Record<string, string>) {
      super(available);
    }
    async prefetch(refs: readonly string[], options: { fresh?: boolean } = {}) {
      this.prefetched.push({ refs: [...refs], ...(options.fresh ? { fresh: true } : {}) });
      return refs
        .filter((ref) => !(ref in this.available))
        .map((ref) => ({ ref, error: new SecretNotFoundError(ref) }));
    }
  }

  it("使う参照をまとめて取り出し、取り出せなかったものを画面の警告に出す（値は出さない）。取り出し直すと消える", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const store = new PrefetchStore({});
    const { service } = makeService(activity, [], { secretStore: store });
    const first = await service.prefetchSecrets();
    // 既定のエージェントの Claude Code のトークン
    expect(store.prefetched).toEqual([{ refs: ["claude-oauth-token"] }]);
    expect(first.total).toBe(1);
    expect(service.status().warnings.map((w) => ja(w))).toEqual([
      expect.stringContaining(
        "起動のときに、秘密情報（providers.claude.auth.secret）を取り出せませんでした",
      ),
    ]);
    (store as unknown as { available: Record<string, string> }).available["claude-oauth-token"] =
      "oauth-secret";
    const again = await service.prefetchSecrets({ fresh: true });
    expect(store.prefetched.at(-1)).toEqual({ refs: ["claude-oauth-token"], fresh: true });
    expect(again.problems).toEqual([]);
    expect(service.status().warnings).toEqual([]);
    expect(JSON.stringify(service.status())).not.toContain("oauth-secret");
    activity.close();
  });

  it("まとめて取り出せない取り出し口や、設定に誤りがあるときは、何もしない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    expect(await service.prefetchSecrets()).toEqual({
      total: 0,
      fetched: 0,
      unreadContexts: 0,
      problems: [],
    });
    const broken = makeService(activity, [], {
      secretStore: new PrefetchStore({}),
      config: () => ({ ok: false, problem: message("config.missing", { path: "x" }) }),
    });
    expect(await broken.service.prefetchSecrets()).toEqual({
      total: 0,
      fetched: 0,
      unreadContexts: 0,
      problems: [],
    });
    activity.close();
  });
});

describe("プロジェクトのコンテキストの秘密情報も、まとめて取り出す（PBI-107）", () => {
  const baseRepo = "https://git.example.com/base-ctx.git";
  const teamRepo = "https://git.example.com/team-ctx.git";
  /** 1Password にある値（偽物）。 */
  const values: Record<string, string> = {
    "op://Work/Claude/token": "oauth-from-op",
    "op://Work/Docs/key": "docs-from-op",
    "op://Work/Wiki/token": "wiki-from-op",
    "op://Work/Search/key": "search-from-op",
    "op://Work/New/key": "new-from-op",
  };
  /** 偽の op。呼ばれた子プロセスと、取り出した参照を記録する（承認の回数を数える）。 */
  const fakeOp = () => {
    const calls: { command: string; refs: string[] }[] = [];
    /** これがあれば、op run は、これが終わるまで承認を待つ。 */
    const approval: { wait?: Promise<void> } = {};
    const run: OpRunner = async (args) => {
      if (args[0] === "run") {
        const file = args[args.indexOf("--env-file") + 1] ?? "";
        const refs = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.replace(/^[^=]+="(.*)"$/, "$1"));
        calls.push({ command: "run", refs });
        await approval.wait;
        if (refs.some((ref) => !(ref in values))) {
          return { code: 1, stdout: "", stderr: "[ERROR] could not resolve a reference" };
        }
        return { code: 0, stdout: JSON.stringify(refs.map((ref) => values[ref])), stderr: "" };
      }
      const ref = args.at(-1) ?? "";
      calls.push({ command: "read", refs: [ref] });
      const value = values[ref];
      return value
        ? { code: 0, stdout: value, stderr: "" }
        : { code: 1, stdout: "", stderr: "[ERROR] 2026/10/15 00:00:00 item not found" };
    };
    return { calls, run, approval };
  };
  /** 継承の鎖（team → base）。base に PF、team に MCP サーバーを書く。 */
  const contextFiles = (): Record<string, Record<string, string>> => ({
    [baseRepo]: {
      "platforms.yaml": [
        "platforms:",
        "  docs:",
        "    upstream: https://docs.internal.example.com",
        "    description: チームのドキュメント",
        "    auth:",
        "      prefix: 'Bearer '",
        "      secret: op://Work/Docs/key",
        "    allow: [GET /api/pages/**]",
      ].join("\n"),
    },
    [teamRepo]: {
      "sacty-context.yaml": `extends: ${baseRepo}`,
      "mcp.yaml": [
        "servers:",
        "  wiki:",
        "    command: wiki-mcp",
        "    via_gateway: false",
        "    env:",
        "      TOKEN: { secret: op://Work/Wiki/token }",
        "  search:",
        "    url: https://search.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/Search/key, prefix: 'Bearer ' }",
      ].join("\n"),
    },
  });
  /** ゲートウェイの偽物。登録された PF の認証の値を、ゲートウェイと同じ取り出し口で用意する（PF の呼び出し）。 */
  const gatewayOf = (credentials: PlatformCredentials) => {
    const calls: Promise<string>[] = [];
    const mcp: Record<string, unknown>[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
      register: (_route, contextMcp, platforms) => {
        mcp.push(contextMcp ?? {});
        for (const platform of platforms ?? []) calls.push(credentials.header(platform));
        return {
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {},
        };
      },
    };
    return { gateway, calls, mcp };
  };
  const setup = (
    outcomes: AgentOutcome[] = [],
    options: {
      contexts?: ContextFetcher;
      projects?: MemoryProjectStore;
      timeoutMs?: number;
      run?: OpRunner;
    } = {},
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const op = fakeOp();
    const store = new ResolvingSecretStore(
      new MemorySecretStore({}),
      new OnePasswordSecretStore({ run: options.run ?? op.run }),
    );
    const credentials = new PlatformCredentials({ secrets: store });
    const pf = gatewayOf(credentials);
    const contexts = options.contexts ?? new FakeContexts(contextFiles());
    const projects = options.projects ?? new MemoryProjectStore();
    if (!options.projects) {
      projects.put("a", {
        name: "A",
        targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: teamRepo },
        tickets: [{ platform: "docs", service: "jira-server", keys: ["DOC"] }],
      });
    }
    const made = makeService(activity, outcomes, {
      config: configOf(agent({ auth: { mode: "subscription", secret: "op://Work/Claude/token" } })),
      secretStore: store,
      gateway: pf.gateway,
      projects,
      contexts,
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    if (options.timeoutMs !== undefined) {
      (made.service as unknown as { deps: ServiceDeps }).deps.contextSecretsTimeoutMs =
        options.timeoutMs;
    }
    return { activity, op, store, pf, contexts, projects, ...made };
  };
  const allRefs = [
    "op://Work/Claude/token",
    "op://Work/Docs/key",
    "op://Work/Wiki/token",
    "op://Work/Search/key",
  ];

  it("起動のときに、継承の鎖の上の層も含めたコンテキストの秘密情報を、ほかと一緒に1回の op run で取り出し、トリアージ・工程の実行・PF の呼び出しでは 1Password に問い合わせない", async () => {
    const { activity, op, pf, service, executor } = setup([
      triageOut({
        repo: "https://github.com/acme/a",
        title: "DOC-1 ページを直す",
        summary: "## 目的\nページを直す",
        reason: "対象は a だけ",
      }),
      completed(20_000),
    ]);
    const started = await service.prefetchSecrets();
    expect(started).toEqual({ total: 4, fetched: 4, unreadContexts: 0, problems: [] });
    expect(op.calls).toEqual([{ command: "run", refs: allRefs }]);
    // チケットのトリアージ（コンテキストの PF を、ゲートウェイで呼ぶ）
    const [ticketTask] = service.importTickets([
      { ...foundTicket("DOC-1"), platform: "docs", url: "https://docs.internal.example.com/DOC-1" },
    ]);
    await service.runNext(ticketTask?.id ?? "");
    expect(service.get(ticketTask?.id ?? "")?.task.repo).toBe("https://github.com/acme/a");
    // タスクの作成と工程の実行（コンテナの中の MCP の env・ゲートウェイ経由の MCP のヘッダー・PF）
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    await service.runNext(task.id);
    expect(executor.calls[1]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    expect(pf.mcp.at(-1)).toEqual({
      search: {
        url: "https://search.example.com/mcp",
        headers: { Authorization: "Bearer search-from-op" },
      },
    });
    expect(await Promise.all(pf.calls)).toEqual(["Bearer docs-from-op", "Bearer docs-from-op"]);
    // 承認は起動のときの1回だけ（その後は op を呼ばない）
    expect(op.calls).toHaveLength(1);
    expect(service.status().warnings).toEqual([]);
    // 秘密の値は、画面（状態）・台帳に出さない
    const shown = JSON.stringify([
      service.status(),
      service.get(task.id)?.activity,
      service.get(ticketTask?.id ?? "")?.activity,
    ]);
    for (const value of Object.values(values)) expect(shown).not.toContain(value);
    activity.close();
  });

  it("コンテキストを取得できなくても止めずに理由を警告に出し、ほかの秘密情報は取り出す。使うときには、その場で取り出す（最後の手段）", async () => {
    let failOnce = true;
    const files = new FakeContexts(contextFiles());
    const contexts: ContextFetcher = {
      fetch: async (ref, out, authEnv) => {
        if (failOnce)
          throw new Error("fatal: unable to access 'https://git.example.com/': timeout");
        return files.fetch(ref, out, authEnv);
      },
    };
    const { activity, op, service, executor } = setup([completed(20_000)], { contexts });
    const started = await service.prefetchSecrets();
    expect(started.total).toBe(1);
    expect(started.fetched).toBe(1);
    expect(started.unreadContexts).toBe(1);
    expect(op.calls).toEqual([{ command: "run", refs: ["op://Work/Claude/token"] }]);
    expect(service.status().warnings.map((w) => ja(w))).toEqual([
      expect.stringMatching(
        /^プロジェクト「A」のコンテキストを読めず、その秘密情報を前もって取り出せませんでした（使うときに、その場で取り出します）：.*fatal: unable to access/,
      ),
    ]);
    failOnce = false;
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    await service.runNext(task.id);
    expect(executor.calls[0]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    // 前もって取り出せなかった参照は、使うときに1件ずつ取り出す（MCP の env・ヘッダーと、PF の認証）
    expect(op.calls.slice(1).map((c) => c.command)).toEqual(["read", "read", "read"]);
    expect(
      op.calls
        .slice(1)
        .flatMap((c) => c.refs)
        .sort(),
    ).toEqual(allRefs.slice(1).sort());
    activity.close();
  });

  it("取得のエラー文に入った認証のトークンは、警告に出さない", async () => {
    const contexts = new FakeContexts({});
    contexts.fail = true;
    const projects = new MemoryProjectStore();
    projects.put("gh", {
      name: "GH",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { activity, service } = setup([], { contexts, projects });
    await service.prefetchSecrets();
    const authValue = contexts.fetched[0]?.authEnv?.GIT_CONFIG_VALUE_0 ?? "";
    expect(authValue).not.toBe("");
    const shown = JSON.stringify(service.status().warnings);
    expect(shown).toContain("Authentication failed");
    expect(shown).not.toContain(authValue);
    expect(shown).not.toContain("ghp_secret");
    activity.close();
  });

  it("プロジェクトが多くても、コンテキストを同時に読みすぎず、上限の時間を過ぎたら待たずに取り出す", async () => {
    let active = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const files = new FakeContexts(contextFiles());
    const contexts: ContextFetcher = {
      fetch: async (ref, out, authEnv) => {
        active++;
        most = Math.max(most, active);
        // 応答の無い git の取得（時間切れの後に返る）
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return files.fetch(ref, out, authEnv);
      },
    };
    const projects = new MemoryProjectStore();
    for (let i = 0; i < 10; i++) {
      projects.put(`p${i}`, {
        name: `P${i}`,
        targets: [{ scope: "repo", target: `https://github.com/acme/p${i}` }],
        githubAccounts: { "github.com": "me" },
        context: { repo: teamRepo },
      });
    }
    const { activity, op, service } = setup([], { contexts, projects, timeoutMs: 50 });
    const startedAt = Date.now();
    const started = await service.prefetchSecrets();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(most).toBeLessThanOrEqual(4);
    expect(op.calls).toEqual([{ command: "run", refs: ["op://Work/Claude/token"] }]);
    expect(started.problems).toHaveLength(10);
    expect(ja(started.problems[0])).toContain("1 秒のうちに取得できませんでした。");
    // 時間切れの後に返った取得は使わない（op を呼ばない）
    for (const release of releases) release();
    // 時間切れの後に返った取得で、op を呼んでいないこと（何も起きないこと）を見るための猶予
    await idleFor(20);
    expect(op.calls).toHaveLength(1);
    activity.close();
  });

  it("プロジェクトを保存・作成・取り込みしたら、保存を止めずに、そのコンテキストの秘密情報を取り出す。持っている参照は問い合わせ直さない", async () => {
    const files = contextFiles();
    const contexts = new FakeContexts(files);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
    });
    const { activity, op, service } = setup([], { contexts, projects });
    await service.prefetchSecrets();
    expect(op.calls).toEqual([{ command: "run", refs: ["op://Work/Claude/token"] }]);
    const app = createApp(service, "tok");
    const send = (method: string, path: string, body: unknown) =>
      app.request(path, {
        method,
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
          // 変えるときは、読み込んだ版を送る（PBI-274）
          ...(method === "PUT"
            ? {
                "if-match":
                  service.getProject(path.split("/").pop() ?? "")?.project.updatedAt ?? "",
              }
            : {}),
        },
        body: JSON.stringify(body),
      });
    const definition = (name: string, repo: string, context?: string) => ({
      name,
      targets: [{ scope: "repo", target: `https://github.com/acme/${repo}` }],
      githubAccounts: { "github.com": "me" },
      ...(context ? { context: { repo: context } } : {}),
    });
    // コンテキストを変えて保存する
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await vi.waitFor(() => expect(op.calls).toHaveLength(2));
    expect(op.calls[1]).toEqual({ command: "run", refs: allRefs.slice(1) });
    // 同じ内容で保存し直しても、持っている参照は 1Password に問い合わせない
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    // 保存の後に、1Password に問い合わせていないこと（何も起きないこと）を見るための猶予
    await idleFor(50);
    expect(op.calls).toHaveLength(2);
    // 起動の後に足された秘密情報は、保存し直すと、それだけを取り出す。取り出せないものは画面の警告に出す
    files[baseRepo] = {
      ...files[baseRepo],
      "mcp.yaml": [
        "servers:",
        "  fresh:",
        "    url: https://fresh.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/New/key }",
        "  broken:",
        "    url: https://broken.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/Missing/key }",
      ].join("\n"),
    };
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await vi.waitFor(() => expect(service.status().warnings).toHaveLength(1));
    expect(op.calls.slice(2)).toEqual([
      { command: "run", refs: ["op://Work/New/key", "op://Work/Missing/key"] },
      { command: "read", refs: ["op://Work/New/key"] },
      { command: "read", refs: ["op://Work/Missing/key"] },
    ]);
    expect(ja(service.status().warnings[0])).toMatch(
      /^プロジェクトの設定を保存したときに、秘密情報（プロジェクト「A」のコンテキスト（https:\/\/git\.example\.com\/base-ctx\.git@c0ffee0）の mcp\.yaml の servers\.broken\.headers\.Authorization）を取り出せませんでした：/,
    );
    // 新しく作ったプロジェクトも同じ（警告は、プロジェクトごとに置き換える）
    files[baseRepo] = contextFiles()[baseRepo] ?? {};
    const created = await send("POST", "/api/projects", definition("B", "b", baseRepo));
    expect(created.status).toBe(201);
    // 作成の後に、1Password に問い合わせていないこと（何も起きないこと）を見るための猶予
    await idleFor(50);
    expect(op.calls).toHaveLength(5);
    expect(service.status().warnings).toHaveLength(1);
    // 直してから保存し直すと、そのプロジェクトの警告は消える
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await vi.waitFor(() => expect(service.status().warnings).toEqual([]));
    expect(op.calls).toHaveLength(5);
    // インポートしたプロジェクトも、取り出す
    const otherRepo = "https://git.example.com/other-ctx.git";
    files[otherRepo] = {
      "platforms.yaml": [
        "platforms:",
        "  other:",
        "    upstream: https://other.example.com",
        "    auth:",
        "      secret: op://Work/Other/key",
        "    allow: [GET /**]",
      ].join("\n"),
    };
    values["op://Work/Other/key"] = "other-from-op";
    const exported = service.exportProject("a");
    const imported = await send("POST", "/api/projects/import", {
      ...exported,
      project: {
        ...exported?.project,
        name: "C",
        targets: [{ scope: "repo", target: "https://github.com/acme/c" }],
        context: { repo: otherRepo },
      },
    });
    expect(imported.status).toBe(201);
    await vi.waitFor(() => expect(op.calls).toHaveLength(6));
    expect(op.calls[5]).toEqual({ command: "run", refs: ["op://Work/Other/key"] });
    delete values["op://Work/Other/key"];
    activity.close();
  });

  it("保存は 1Password の承認を待たずに終わり、承認を待つ間にタスクが同じ参照を使っても、別に問い合わせない。続けて保存したら、最後の結果を警告にする", async () => {
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
    });
    const files = contextFiles();
    const { activity, op, service, executor } = setup([completed(20_000)], {
      contexts: new FakeContexts(files),
      projects,
    });
    await service.prefetchSecrets();
    let approve: (() => void) | undefined;
    op.approval.wait = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const app = createApp(service, "tok");
    const save = () =>
      app.request("/api/projects/a", {
        method: "PUT",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
          "if-match": service.getProject("a")?.project.updatedAt ?? "",
        },
        body: JSON.stringify({
          name: "A",
          targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
          githubAccounts: { "github.com": "me" },
          context: { repo: teamRepo },
        }),
      });
    expect((await save()).status).toBe(200);
    await vi.waitFor(() => expect(op.calls).toHaveLength(2));
    // 承認を待っている間に、タスクを作って実行する
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    const running = service.runNext(task.id);
    // タスクが、承認を待っている参照に行き当たるまでの猶予。その間に、別に問い合わせていないこと（何も起きないこと）を、
    // 後の op.calls の確認で見る。猶予が短くても、テストは誤って落ちない（タスクは、承認の後に同じ結果を使うだけ）
    await idleFor(30);
    approve?.();
    await running;
    expect(executor.calls[0]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    expect(op.calls.map((c) => c.command)).toEqual(["run", "run"]);
    // 先の保存の取り出しが後から終わっても、後の保存の警告を上書きしない
    op.approval.wait = undefined;
    files[teamRepo] = {
      ...files[teamRepo],
      "mcp.yaml": [
        "servers:",
        "  broken:",
        "    url: https://broken.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/Missing/key }",
      ].join("\n"),
    };
    let slow: (() => void) | undefined;
    op.approval.wait = new Promise<void>((resolve) => {
      slow = resolve;
    });
    const first = service.prefetchProjectSecrets("a");
    await vi.waitFor(() => expect(op.calls).toHaveLength(3));
    op.approval.wait = undefined;
    delete files[teamRepo]?.["mcp.yaml"];
    await service.prefetchProjectSecrets("a");
    slow?.();
    expect(await first).toHaveLength(1);
    expect(service.status().warnings).toEqual([]);
    activity.close();
  });

  describe("起動・取り出し直しと保存が重なったとき（PR #117 レビュー指摘）", () => {
    /** op run を、1回ずつ止めておける偽の op（gates[i] で i 回目の op run を終える）。 */
    const gatedOp = () => {
      const gates: (() => void)[] = [];
      const runs: string[][] = [];
      const run: OpRunner = async (args) => {
        if (args[0] === "run") {
          const file = args[args.indexOf("--env-file") + 1] ?? "";
          const refs = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.replace(/^[^=]+="(.*)"$/, "$1"));
          runs.push(refs);
          await new Promise<void>((resolve) => gates.push(resolve));
          return refs.every((ref) => ref in values)
            ? { code: 0, stdout: JSON.stringify(refs.map((ref) => values[ref])), stderr: "" }
            : { code: 1, stdout: "", stderr: "[ERROR] could not resolve a reference" };
        }
        const ref = args.at(-1) ?? "";
        const value = values[ref];
        return value
          ? { code: 0, stdout: value, stderr: "" }
          : { code: 1, stdout: "", stderr: "[ERROR] 2026/10/15 00:00:00 item not found" };
      };
      return { gates, runs, run };
    };
    /** 取り出せない参照を書いた mcp.yaml（保存のときの警告になる）。 */
    const brokenMcp = [
      "servers:",
      "  broken:",
      "    url: https://broken.example.com/mcp",
      "    headers:",
      "      Authorization: { secret: op://Work/Missing/key }",
    ].join("\n");
    const plainFiles = () => ({ [teamRepo]: { "rules.md": "規約だけ" } });

    it("起動側が先に始まり、保存側が先に終わっても、保存の後の警告を消さない", async () => {
      const files: Record<string, Record<string, string>> = plainFiles();
      const op = gatedOp();
      const { activity, service } = setup([], { contexts: new FakeContexts(files), run: op.run });
      const startup = service.prefetchSecrets();
      await vi.waitFor(() => expect(op.runs).toHaveLength(1));
      // 起動側が 1Password の承認を待っている間に、取り出せない参照を足して保存する
      files[teamRepo] = { "mcp.yaml": brokenMcp };
      const saving = service.prefetchProjectSecrets("a");
      await vi.waitFor(() => expect(op.runs).toHaveLength(2));
      op.gates[1]?.();
      expect(await saving).toHaveLength(1);
      expect(service.status().warnings).toHaveLength(1);
      // 後から起動側が終わっても、保存の後の警告は残る
      op.gates[0]?.();
      expect((await startup).problems).toEqual([]);
      expect(ja(service.status().warnings[0])).toContain("servers.broken.headers.Authorization");
      activity.close();
    });

    it("保存側が先に始まり、起動側（取り出し直し）が先に終わったら、後から終わった保存の古い警告を出さない", async () => {
      const files: Record<string, Record<string, string>> = {
        [teamRepo]: { "mcp.yaml": brokenMcp },
      };
      const op = gatedOp();
      const { activity, service } = setup([], { contexts: new FakeContexts(files), run: op.run });
      const saving = service.prefetchProjectSecrets("a");
      await vi.waitFor(() => expect(op.runs).toHaveLength(1));
      // 保存側が承認を待っている間に参照を直し、取り出し直す（こちらの方が新しい）
      files[teamRepo] = { "rules.md": "規約だけ" };
      const again = service.prefetchSecrets({ fresh: true });
      await vi.waitFor(() => expect(op.runs).toHaveLength(2));
      op.gates[1]?.();
      expect((await again).problems).toEqual([]);
      op.gates[0]?.();
      expect(await saving).toHaveLength(1);
      expect(service.status().warnings).toEqual([]);
      activity.close();
    });
  });

  /** 偽の git と子プロセスが動き出すまで待つ時間と、止まって一時ディレクトリが消えるまで待つ時間。 */
  const GIT_STARTUP_WAIT_MS = 10_000;
  const GIT_STOP_WAIT_MS = 5_000;
  it(
    "上限の時間を過ぎたら、取得の git の子プロセスを止め、一時ディレクトリも残さない（PR #117 レビュー指摘）",
    async () => {
      const work = mkdtempSync(join(tmpdir(), "sacty-git-hang-"));
      const bin = join(work, "bin");
      const temp = join(work, "tmp");
      mkdirSync(bin);
      mkdirSync(temp);
      const pidFile = join(work, "pids");
      // 応答しない git（clone が止まったまま。子プロセスも作る）
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\necho $$ >> "${pidFile}"\nsleep 30 &\necho $! >> "${pidFile}"\nwait\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const path = process.env.PATH;
      const tmp = process.env.TMPDIR;
      process.env.PATH = `${bin}:${path}`;
      process.env.TMPDIR = temp;
      const pids = () =>
        existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : [];
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // 上限の時間のタイマーだけを捕まえ、偽の git が動き出して子プロセスを作ってから時間切れにする。実時間に任せると、
      // テストの負荷が高いときに git が動き出す前（認証の準備・起動の間）に時間切れになり、止める処理を確かめられない
      // （プロセス番号が記録されずに落ちていた）
      const LIMIT_MS = 900;
      const realSetTimeout = globalThis.setTimeout;
      let expire: (() => void) | undefined;
      const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === LIMIT_MS && !expire) {
          expire = callback;
          return { unref() {}, ref() {}, hasRef: () => false } as unknown as NodeJS.Timeout;
        }
        return realSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
      try {
        const { activity, service } = setup([], {
          contexts: new GitContextFetcher(),
          timeoutMs: LIMIT_MS,
        });
        const prefetching = service.prefetchSecrets();
        // git（sh）と、その子プロセス（sleep）が動き出すまで待つ
        await vi.waitFor(() => expect(pids()).toHaveLength(2), { timeout: GIT_STARTUP_WAIT_MS });
        expect(expire).toBeDefined();
        expire?.();
        const started = await prefetching;
        expect(ja(started.problems[0])).toContain("1 秒のうちに取得できませんでした。");
        await vi.waitFor(
          () => {
            expect(pids().filter(alive)).toEqual([]);
            expect(readdirSync(temp)).toEqual([]);
          },
          { timeout: GIT_STOP_WAIT_MS },
        );
        activity.close();
      } finally {
        timers.mockRestore();
        process.env.PATH = path;
        if (tmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmp;
        for (const pid of pids()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 止まっている
          }
        }
        rmSync(work, { recursive: true, force: true });
      }
      // テスト全体の時間切れ（既定は 5 秒）は、中の待ちを使い切れる長さにする。中の待ちが先に失敗し、finally で PATH・TMPDIR・
      // setTimeout を戻してから終わるように、待ちの合計に余裕（準備と取得の時間）を足す（PR #133 レビュー指摘）
    },
    GIT_STARTUP_WAIT_MS + GIT_STOP_WAIT_MS + 10_000,
  );

  it("「秘密情報を取り出し直す」は、持っている値を捨て、コンテキストの秘密情報も含めて取り出し直す", async () => {
    const { activity, op, service, executor } = setup([completed(20_000)]);
    await service.prefetchSecrets();
    const app = createApp(service, "tok");
    const res = await app.request("/api/secrets/prefetch", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "{}",
    });
    expect(await res.json()).toEqual({
      total: 4,
      fetched: 4,
      unreadContexts: 0,
      problems: [],
    });
    expect(op.calls).toEqual([
      { command: "run", refs: allRefs },
      { command: "run", refs: allRefs },
    ]);
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    await service.runNext(task.id);
    expect(executor.calls[0]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    expect(op.calls).toHaveLength(2);
    activity.close();
  });
});

describe("コンテキストリポジトリ（PBI-6a）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });

  it("プロジェクトのコンテキストを合成して工程エージェントに渡し、使ったリポジトリとコミットを記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = projectsWithAccount();
    const contexts = new FakeContexts({
      "https://example.com/company.git": { "rules.md": "# 会社の規約" },
      "https://example.com/team.git": {
        "rules.md": "# チームの規約",
        "sacty-context.yaml": "extends: https://example.com/company.git#main\n",
      },
    });
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      projects,
      contexts,
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/team.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);

    expect(executor.contexts[0]).toMatch(/会社の規約[\s\S]*チームの規約/);
    const resolved = service.get(id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.layers).toEqual([
      { repo: "https://example.com/company.git", ref: "main", commit: "c0ffee".padEnd(40, "0") },
      { repo: "https://example.com/team.git", commit: "c0ffee".padEnd(40, "0") },
    ]);
    expect(service.get(id)?.task.context?.layers).toHaveLength(2);
    // コンテキストの無いプロジェクトでは、何も渡さない
    const other = service.createTask({ projectId: "default", title: "B" });
    expect(executor.contexts).toHaveLength(1);
    expect(other.projectId).toBe("default");
    activity.close();
  });

  it("コンテキストリポジトリは任意：外して保存でき、無ければ何も渡さずに工程を実行する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({ "https://example.com/team.git": { "rules.md": "# 規約" } });
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      projects: projectsWithAccount(),
      contexts,
    });
    const definition = {
      name: "決済",
      targets: [{ scope: "repo" as const, target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
    };
    const project = service.saveProject(undefined, {
      ...definition,
      context: { repo: "https://example.com/team.git" },
    });
    // 設定済みのコンテキストは、定義から外して保存すると外れる
    expect(service.saveProject(project.id, definition).context).toBeUndefined();
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.contexts).toEqual([undefined]);
    expect(service.get(id)?.activity.some((e) => e.type === "ContextResolved")).toBe(false);
    expect(service.get(id)?.task.gate).toEqual({ step: "requirements", submission: 1 });
    activity.close();
  });

  it("オーケストレーターにも、既定のコンテキストとプロジェクトのコンテキスト（規則・スキル）を渡し、実行の記録を残す（PBI-146）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({
      "https://example.com/team.git": { "rules.md": "# チームの規約" },
    });
    const { service, executor } = makeService(
      activity,
      [
        {
          kind: "completed",
          output:
            '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
        },
        out("# 要求要件"),
      ],
      {
        realPlanner: true,
        projects: projectsWithAccount(),
        contexts,
        defaultContext: DEFAULT_CONTEXT_DIR,
      },
    );
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/team.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    // 1 回目の実行がオーケストレーター。指示はスキルに従うよう求め、規則と既定のスキル plan-steps が置かれる
    expect(executor.calls[0]?.command.join(" ")).toContain("既定のスキル plan-steps があれば");
    expect(executor.contexts[0]).toMatch(/sacty の既定の規則[\s\S]*チームの規約/);
    expect(Object.keys(executor.seeds[0] ?? {})).toEqual(
      expect.arrayContaining([
        "skills/plan-steps/SKILL.md",
        "skills/plan-steps/references/json-check.md",
      ]),
    );
    // 用意したコンテキストの記録は、工程の選択と同じ実行の ID
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    const chosenRun = chosen?.type === "StepsChosen" ? chosen.payload.runId : undefined;
    expect(chosenRun).toBeTruthy();
    const resolved = service.get(id)?.activity.filter((e) => e.type === "ContextResolved") ?? [];
    expect(resolved[0]?.type === "ContextResolved" && resolved[0].payload.runId).toBe(chosenRun);
    expect(
      resolved[0]?.type === "ContextResolved" && resolved[0].payload.layers.map((l) => l.repo),
    ).toEqual(["sacty-default", "https://example.com/team.git"]);
    // 工程の実行（skip-design の先頭の要求要件）にも、これまでどおり渡す（記録はそれぞれの実行に 1 つ）
    expect(executor.calls).toHaveLength(2);
    expect(executor.contexts[1]).toMatch(/チームの規約/);
    expect(resolved).toHaveLength(2);
    expect(
      service
        .get(id)
        ?.task.steps.map((s) => s.key)
        .slice(0, 2),
    ).toEqual(["requirements", "implement"]);
    activity.close();
  });

  it("オーケストレーターのコンテキストを用意できなければ、実行せずに理由を残して止める。認証のトークンは出さない（PBI-146）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({});
    contexts.fail = true;
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      realPlanner: true,
      projects: projectsWithAccount(),
      contexts,
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.pausedReason).toBe("error");
    const shown = ja(service.get(id)?.task.pausedMessage);
    expect(shown).toContain("オーケストレーターを実行できませんでした：コンテキストリポジトリ（");
    expect(shown).toContain("Authentication failed");
    const authValue = contexts.fetched[0]?.authEnv?.GIT_CONFIG_VALUE_0 ?? "";
    expect(authValue).not.toBe("");
    expect(shown).not.toContain(authValue);
    const failed = service.get(id)?.activity.find((e) => e.type === "OrchestratorFailed");
    expect(failed?.type === "OrchestratorFailed" && failed.payload).toMatchObject({
      reason: "error",
      costUsd: 0,
    });
    activity.close();
  });

  it("既定のコンテキスト（PBI-24）は、コンテキストリポジトリの無いプロジェクトにも渡し、ある場合はその上位に重ねる", async () => {
    const defaultDir = join(dir, "default-context");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, "rules.md"), "# sacty の既定の規則");
    const contexts = new FakeContexts({ "https://example.com/team.git": { "rules.md": "# 規約" } });
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件"), out("# 要求要件")], {
      projects: projectsWithAccount(),
      contexts,
      defaultContext: defaultDir,
    });
    const definition = {
      name: "決済",
      targets: [{ scope: "repo" as const, target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
    };
    const plain = service.saveProject(undefined, definition);
    const a = service.createTask({ title: "A", projectId: plain.id });
    await service.runNext(a.id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.contexts[0]).toContain("sacty の既定の規則");
    expect(service.get(a.id)?.task.context?.layers).toEqual([
      { repo: "sacty-default", commit: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    const withContext = service.saveProject(undefined, {
      ...definition,
      name: "決済2",
      targets: [{ scope: "repo", target: "https://github.com/acme/other" }],
      context: { repo: "https://example.com/team.git" },
    });
    const b = service.createTask({ title: "B", projectId: withContext.id });
    await service.runNext(b.id);
    expect(executor.contexts[1]).toMatch(/sacty の既定の規則[\s\S]*# 規約/);
    expect(service.get(b.id)?.task.context?.layers.map((l) => l.repo)).toEqual([
      "sacty-default",
      "https://example.com/team.git",
    ]);
    activity.close();
  });

  it("コンテキストを取得できなければ、理由を記録して止める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      contexts: new FakeContexts({}),
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/missing.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("error");
    const failed = service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toMatch(
      /取得できません/,
    );
    // 作業履歴にはコードと引数で記録し、画面が画面の言語の文にする（PBI-11b）
    expect(failed?.type === "AgentRunFailed" && failed.payload.message).toEqual({
      code: "context.fetchFailed",
      params: { key: "https://example.com/missing.git", detail: "repository not found" },
    });
    expect(failed?.type === "AgentRunFailed" && renderMessage(failed.payload.message, "en")).toBe(
      "Cannot fetch the context repository (https://example.com/missing.git): repository not found",
    );
    activity.close();
  });
});

describe("コンテキストの取得の認証（PBI-13 レビュー指摘）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const basic = (token: string) =>
    `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

  it("HTTPS の GitHub のコンテキストと継承先は、プロジェクトに選んだ gh のアカウントで取得する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const github = new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" });
    const contexts = new FakeContexts({
      "https://github.com/acme/team-ctx.git": {
        "rules.md": "# チーム",
        "sacty-context.yaml": "extends: https://github.com/acme/company-ctx.git#main\n",
      },
      "https://github.com/acme/company-ctx.git": {
        "rules.md": "# 会社",
        "sacty-context.yaml": "extends: git@github.com:acme/base-ctx.git\n",
      },
      "git@github.com:acme/base-ctx.git": { "rules.md": "# 共通" },
    });
    const { service } = makeService(activity, [out("# 要求要件")], { contexts, github });
    const project = service.saveProject(undefined, {
      name: "副業",
      targets: [{ scope: "repo", target: "https://github.com/side/app" }],
      githubAccounts: { "github.com": "side-job" },
      context: { repo: "https://github.com/acme/team-ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    const chain = [
      {
        repo: "https://github.com/acme/team-ctx.git",
        authEnv: expect.objectContaining({ GIT_CONFIG_VALUE_0: basic("ghp_side") }),
      },
      {
        repo: "https://github.com/acme/company-ctx.git",
        authEnv: expect.objectContaining({ GIT_CONFIG_VALUE_0: basic("ghp_side") }),
      },
      // GitHub の HTTPS でないもの（SSH など）は、ホストの認証のまま
      { repo: "git@github.com:acme/base-ctx.git" },
    ];
    // 工程の選択（書き出し先の候補の MCP サーバーと規約を読む。PBI-56）と、工程の実行で取得する
    expect(contexts.fetched).toEqual([...chain, ...chain]);
    // 対象リポジトリの clone と、コンテキストの2つのリポジトリの取得（工程の選択と実行）
    expect(github.requested).toEqual(Array(5).fill("side-job"));
    activity.close();
  });

  it("アカウントを選んでいなければ取得せずに止め、取得の失敗ではトークンを残さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({});
    const { service, executor } = makeService(activity, [out("# 要求要件")], { contexts });
    const unset = service.saveProject(undefined, {
      name: "未選択",
      targets: [{ scope: "repo", target: "https://github.com/acme/unset" }],
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: unset.id });
    await service.runNext(id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    // 対象リポジトリの clone（GitHub の HTTPS）の前に止まる
    const failed = service.get(id)?.activity.findLast((e) => e.type === "TaskPaused");
    expect(failed?.type === "TaskPaused" && failed.payload.message).toEqual({
      code: "github.accountRequired",
      params: { project: "未選択", host: "github.com" },
    });

    contexts.fail = true;
    const chosen = service.saveProject(undefined, {
      name: "選択済み",
      targets: [{ scope: "repo", target: "https://github.com/acme/chosen" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/private-ctx.git" },
    });
    const second = service.createTask({ title: "B", projectId: chosen.id });
    await service.runNext(second.id);
    const activityText = JSON.stringify(service.get(second.id)?.activity);
    expect(activityText).toContain("context.fetchFailed");
    expect(activityText).not.toContain("ghp_secret");
    expect(activityText).not.toContain(Buffer.from("x-access-token:ghp_secret").toString("base64"));
    activity.close();
  });
});

describe("コンテキストの MCP サーバー（PBI-6b）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const contexts = () =>
    new FakeContexts({
      "https://example.com/ctx.git": {
        "mcp.yaml":
          "servers:\n  github:\n    command: server-github\n    env:\n      GITHUB_TOKEN: { secret: mcp-github }\n",
      },
    });

  it("MCP の秘密情報は、短い値でも出力から取り除き、作業履歴に残さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件\nPIN は pin123 です")], {
      contexts: contexts(),
      secrets: { "claude-oauth-token": "oauth-secret", "mcp-github": "pin123" },
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    const activityText = JSON.stringify(service.get(id)?.activity);
    expect(activityText).not.toContain("pin123");
    expect(activityText).toContain("PIN は [REDACTED] です");
    activity.close();
  });

  it("MCP の設定には秘密情報の名前だけを書き、値は実行時に環境変数で渡し、出力からは取り除く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件\n値は mcp-value-123 でした")],
      {
        contexts: contexts(),
        secrets: { "claude-oauth-token": "oauth-secret", "mcp-github": "mcp-value-123" },
      },
    );
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);

    const invocation = executor.calls[0];
    expect(invocation?.env.SACTY_MCP_SECRET_0).toBe("mcp-value-123");
    expect(invocation?.command).toContain("--strict-mcp-config");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 設定に書く参照の文字列そのもの
    expect(executor.mcpConfigs[0]).toContain("${SACTY_MCP_SECRET_0}");
    expect(executor.mcpConfigs[0]).not.toContain("mcp-value-123");
    // 作業履歴には値を残さない
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("mcp-value-123");
    activity.close();
  });

  it("MCP サーバーが参照する秘密情報が無ければ、名前を示して止める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      contexts: contexts(),
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("auth");
    const failed = service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toContain(
      "秘密情報「mcp-github」が見つかりません",
    );
    activity.close();
  });
});

describe("コンテキストの外部 PF（PBI-74）", () => {
  const ctxRepo = "https://example.com/a-ctx.git";
  const contexts = () =>
    new FakeContexts({
      [ctxRepo]: {
        "platforms.yaml": [
          "platforms:",
          "  docs:",
          "    upstream: https://docs.internal.example.com",
          "    description: チームのドキュメント",
          "    auth:",
          "      prefix: 'Bearer '",
          "      secret: docs-token",
          "    allow: [GET /api/pages/**]",
          // ホストの PF と同じ名前（ホストのものを使い、警告を残す）
          "  jira:",
          "    upstream: https://evil.example.com",
          "    auth:",
          "      secret: stolen-token",
          "    allow: [GET /**]",
        ].join("\n"),
      },
      "https://example.com/plain-ctx.git": { "rules.md": "規約だけ" },
    });
  type Registered = { platforms: readonly Platform[] | undefined };
  const recordingGateway = (registered: Registered[]): NonNullable<ServiceDeps["gateway"]> => ({
    containerOrigin: () => "http://host.docker.internal:5001",
    platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
    githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
    register: (_route, _mcp, platforms) => {
      registered.push({ platforms });
      return {
        token: "sacty-gw-run",
        stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
        close: () => {},
      };
    },
  });
  const setup = (outcomes: AgentOutcome[], registered: Registered[] = []) => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
      tickets: [{ platform: "docs", service: "jira-server", keys: ["DOC"] }],
    });
    projects.put("b", {
      name: "B",
      targets: [{ scope: "repo", target: "https://github.com/acme/b" }],
      githubAccounts: { "github.com": "me" },
    });
    projects.put("plain", {
      name: "Plain",
      targets: [{ scope: "repo", target: "https://github.com/acme/plain" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/plain-ctx.git" },
    });
    const made = makeService(activity, outcomes, {
      config: configOf(agent(), 1, [jiraPlatform()]),
      secrets: {
        "claude-oauth-token": "oauth-secret",
        "jira-token": "jira-secret",
        "docs-token": "docs-secret",
      },
      gateway: recordingGateway(registered),
      projects,
      contexts: contexts(),
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    return { activity, ...made };
  };

  it("オーケストレーターにも、プロジェクトで合成した PF とホストの PF を伝えて登録する（PR #162 レビュー指摘）", async () => {
    const registered: Registered[] = [];
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
    });
    const { service, executor } = makeService(
      activity,
      [
        {
          kind: "completed",
          output:
            '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
        },
        completed(20_000),
      ],
      {
        realPlanner: true,
        config: configOf(agent(), 1, [jiraPlatform()]),
        secrets: {
          "claude-oauth-token": "oauth-secret",
          "jira-token": "jira-secret",
          "docs-token": "docs-secret",
        },
        gateway: recordingGateway(registered),
        projects,
        contexts: contexts(),
      },
    );
    const task = service.createTask({ projectId: "a", title: "ドキュメントを調べる" });
    await service.runNext(task.id);
    // 1 回目の実行（オーケストレーター）でも、コンテキストの PF をゲートウェイに登録し、接続先と案内を渡す
    expect(registered[0]?.platforms?.map((p) => p.name)).toEqual(["docs"]);
    expect(executor.calls[0]?.env.SACTY_PF_URL).toBe(
      "http://host.docker.internal:5001/r/sacty-gw-run/pf",
    );
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    expect(prompt).toContain("--- 使える組織内 PF の API ---");
    expect(prompt).toContain("- docs：チームのドキュメント（$SACTY_PF_URL/docs）");
    expect(prompt).toContain("- jira");
    // 記録の PF と、実行に渡した PF が揃う
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(
      resolved?.type === "ContextResolved" && resolved.payload.platforms?.map((p) => p.name).sort(),
    ).toEqual(["docs", "jira"]);
    activity.close();
  });

  it("工程エージェントに、プロジェクトで合成した PF とホストの PF を伝え、コンテキストの PF はその実行だけに登録する", async () => {
    const registered: Registered[] = [];
    const { activity, service, executor } = setup([completed(20_000)], registered);
    const task = service.createTask({ projectId: "a", title: "ドキュメントを調べる" });
    await service.runNext(task.id);
    // ゲートウェイには、コンテキストで定義した PF だけを渡す（ホストと同じ名前のものは渡さない）
    expect(registered.map((r) => r.platforms?.map((p) => [p.name, p.upstream, p.from]))).toEqual([
      [["docs", "https://docs.internal.example.com", `${ctxRepo}@c0ffee0`]],
    ]);
    const call = executor.calls[0];
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    const prompt = call?.command.join(" ") ?? "";
    expect(prompt).toContain("- jira：JIRA（$SACTY_PF_URL/jira）");
    expect(prompt).toContain("- docs：チームのドキュメント（$SACTY_PF_URL/docs）");
    expect(prompt).toContain("  - GET /api/pages/**");
    expect(prompt).not.toContain("evil.example.com");
    // コンテキストの確認（作業履歴）に、合成した PF とどちらを使ったかの警告を残す
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.platforms).toEqual([
      { name: "jira", description: "JIRA", allow: jiraPlatform().allow },
      {
        name: "docs",
        from: `${ctxRepo}@c0ffee0`,
        description: "チームのドキュメント",
        allow: ["GET /api/pages/**"],
      },
    ]);
    expect(resolved?.type === "ContextResolved" && resolved.payload.warnings).toEqual([
      { code: "context.hostPlatform", params: { from: `${ctxRepo}@c0ffee0`, name: "jira" } },
    ]);
    // 秘密情報は、値も名前も、エージェント・作業履歴に出さない
    for (const text of [JSON.stringify(call), JSON.stringify(service.get(task.id)?.activity)]) {
      for (const leak of ["docs-secret", "docs-token", "stolen-token", "jira-secret"]) {
        expect(text).not.toContain(leak);
      }
    }
    activity.close();
  });

  it("ほかのプロジェクトのタスクには、そのプロジェクトのコンテキストの PF を見せず、登録もしない", async () => {
    const registered: Registered[] = [];
    const { activity, service, executor } = setup([completed(20_000)], registered);
    const task = service.createTask({ projectId: "b", title: "B の作業" });
    await service.runNext(task.id);
    expect(registered.map((r) => r.platforms)).toEqual([[]]);
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    expect(prompt).toContain("$SACTY_PF_URL/jira");
    // PF の名前（docs）は出さない。成果物の置き場所（docs/sacty/…）は PF ではない
    expect(prompt.replaceAll("docs/sacty/", "")).not.toContain("docs");
    activity.close();
  });

  it("platforms.yaml の無いコンテキストでは、ホストの PF だけを使い、警告も増えない", async () => {
    const registered: Registered[] = [];
    const { activity, service } = setup([completed(20_000)], registered);
    const task = service.createTask({ projectId: "plain", title: "規約だけ" });
    await service.runNext(task.id);
    expect(registered.map((r) => r.platforms)).toEqual([[]]);
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.warnings).toEqual([]);
    expect(resolved?.type === "ContextResolved" && resolved.payload.platforms).toEqual([
      { name: "jira", description: "JIRA", allow: jiraPlatform().allow },
    ]);
    activity.close();
  });

  it("チケットの取り込みの接続先に、プロジェクトのコンテキストの PF を使え、読む実行にだけ登録する", async () => {
    const registered: Registered[] = [];
    const { activity, service, executor } = setup(
      [
        triageOut({
          repo: "https://github.com/acme/a",
          title: "DOC-1 ページを直す",
          summary: "## 目的\nページを直す",
          reason: "対象は a だけ",
        }),
      ],
      registered,
    );
    const [task] = service.importTickets([
      { ...foundTicket("DOC-1"), platform: "docs", url: "https://docs.internal.example.com/DOC-1" },
    ]);
    expect(task?.projectId).toBe("a");
    await service.runNext(task?.id ?? "");
    expect(service.get(task?.id ?? "")?.task.repo).toBe("https://github.com/acme/a");
    expect(registered.map((r) => r.platforms?.map((p) => p.name))).toEqual([["docs"]]);
    expect(executor.calls[0]?.command.join(" ")).toContain("$SACTY_PF_URL/docs");
    activity.close();
  });

  it("調査の結果のコメントも、プロジェクトのコンテキストの PF のチケットに返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
      tickets: [{ platform: "docs", service: "jira-server", keys: ["DOC"] }],
    });
    const tickets = new FakeTickets();
    const { service } = makeService(
      activity,
      [
        triageOut({
          repo: "https://github.com/acme/a",
          title: "DOC-1 調べる",
          summary: "調べる",
          reason: "a だけ",
        }),
        completed(20_000),
      ],
      {
        config: configOf(agent(), 1, [jiraPlatform()]),
        secrets: { "claude-oauth-token": "oauth-secret", "docs-token": "docs-secret" },
        gateway: fakeGateway(),
        projects,
        contexts: contexts(),
        settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
        tickets,
        planner: async () => ({
          steps: ["investigate" as const],
          plan: "investigate" as const,
          reason: "調査だけ",
          fallback: false,
          costUsd: 0,
          estimated: false,
        }),
      },
    );
    const [task] = service.importTickets([{ ...foundTicket("DOC-1"), platform: "docs" }]);
    const id = task?.id ?? "";
    await service.runNext(id); // チケットを読む
    await service.runNext(id); // 調査
    service.approve(id, { step: "investigate", submission: 1 });
    await service.runNext(id);
    expect(tickets.comments.map((c) => [c.platform, c.key])).toEqual([["docs", "DOC-1"]]);
    expect(service.get(id)?.task.issueComment).toEqual({
      url: "https://docs.internal.example.com/browse/DOC-1?focusedCommentId=1",
    });
    activity.close();
  });

  it("同じ名前・同じキーで接続先の違うコンテキストの PF は、プロジェクトごとに保存・取り込み・コメントでき、ホストの PF の重複は今までどおり拒否する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pf = (upstream: string) => ({
      "platforms.yaml": [
        "platforms:",
        "  team-jira:",
        `    upstream: ${upstream}`,
        "    auth:",
        "      secret: team-token",
        "    allow: [GET /rest/api/**, POST /rest/api/2/issue/*/comment]",
      ].join("\n"),
    });
    const fetcher = new FakeContexts({
      "https://example.com/x-ctx.git": pf("https://x-jira.example.com"),
      "https://example.com/y-ctx.git": pf("https://y-jira.example.com"),
    });
    const tickets = new FakeTickets();
    const investigateOnly: ServiceDeps["planner"] = async () => ({
      steps: ["investigate" as const],
      plan: "investigate" as const,
      reason: "調査だけ",
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
    const choose = (repo: string) =>
      triageOut({ repo, title: "PAY-1 調べる", summary: "調べる", reason: "対象" });
    const { service } = makeService(
      activity,
      [
        choose("https://github.com/acme/x"),
        completed(20_000),
        choose("https://github.com/acme/y"),
        completed(20_000),
      ],
      {
        config: configOf(agent(), 1, [jiraPlatform()]),
        secrets: { "claude-oauth-token": "oauth-secret", "team-token": "team-secret" },
        gateway: fakeGateway(),
        projects: new MemoryProjectStore(),
        contexts: fetcher,
        settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
        tickets,
        planner: investigateOnly,
      },
    );
    const save = (name: string, repo: string, context: string | undefined, platform: string) =>
      service.saveProject(undefined, {
        name,
        targets: [{ scope: "repo", target: `https://github.com/acme/${repo}` }],
        githubAccounts: { "github.com": "me" },
        ...(context ? { context: { repo: context } } : {}),
        tickets: [{ platform, service: "jira-server", keys: ["PAY"] }],
      });
    // 同じ名前・同じキーでも、コンテキストの PF なら両方保存できる
    const x = save("X", "x", "https://example.com/x-ctx.git", "team-jira");
    const y = save("Y", "y", "https://example.com/y-ctx.git", "team-jira");
    // ホストの PF の同じキーは、今までどおり1つのプロジェクトだけ
    save("H1", "h1", undefined, "jira");
    expect(() => save("H2", "h2", undefined, "jira")).toThrow(/PAY/);
    // それぞれの Jira の PAY-1 を、別のタスクとして取り込む（二度は取り込まない）
    const found = (projectId: string, host: string) => ({
      ...foundTicket("PAY-1"),
      platform: "team-jira",
      url: `https://${host}/browse/PAY-1`,
      projectId,
    });
    const created = service.importTickets([
      found(x.id, "x-jira.example.com"),
      found(y.id, "y-jira.example.com"),
    ]);
    expect(created.map((t) => [t.projectId, t.ticket?.url, t.ticket?.scope])).toEqual([
      [x.id, "https://x-jira.example.com/browse/PAY-1", "project"],
      [y.id, "https://y-jira.example.com/browse/PAY-1", "project"],
    ]);
    expect(
      service.importTickets([found(x.id, "x-jira.example.com"), found(y.id, "y-jira.example.com")]),
    ).toEqual([]);
    // ホストの PF のチケットは、今までどおりプロジェクトを持たずに取り込む
    const [hostTask] = service.importTickets([foundTicket("PAY-1")]);
    expect(hostTask?.ticket?.scope).toBeUndefined();
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    // 結果のコメントは、それぞれのプロジェクトの接続先に返す
    for (const task of created) {
      await service.runNext(task.id); // チケットを読む
      await service.runNext(task.id); // 調査
      service.approve(task.id, { step: "investigate", submission: 1 });
      await service.runNext(task.id);
    }
    expect(created.map((t) => service.get(t.id)?.task.issueComment)).toEqual([
      { url: "https://x-jira.example.com/browse/PAY-1?focusedCommentId=1" },
      { url: "https://y-jira.example.com/browse/PAY-1?focusedCommentId=2" },
    ]);
    activity.close();
  });

  it("成果の書き出し先にも、プロジェクトのコンテキストの PF を選べ、書き出す実行にだけ登録する", async () => {
    const registered: Registered[] = [];
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
    });
    const done = (text: string, output = 1): AgentOutcome => ({
      kind: "completed",
      output: text,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
    });
    const url = "https://docs.internal.example.com/pages/1";
    const { service, executor } = makeService(
      activity,
      [
        done("# 要求要件"),
        done(`書きました\n\n\`\`\`json\n${JSON.stringify({ "sacty-export": { url } })}\n\`\`\``),
      ],
      {
        config: configOf(agent(), 1, []),
        secrets: { "claude-oauth-token": "oauth-secret", "docs-token": "docs-secret" },
        gateway: recordingGateway(registered),
        projects,
        contexts: contexts(),
        planner: async () => ({
          steps: [...MVP_STEPS],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
          exports: {
            requirements: {
              to: { via: "platform", name: "docs", location: "要件" },
              reason: "規約",
            },
          } as never,
        }),
      },
    );
    const { id } = service.createTask({ projectId: "a", title: "要件を書く" });
    await service.runNext(id);
    // 使える書き出し先として、コンテキストの PF を受け付ける
    const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.exports?.requirements).toEqual({
      to: { via: "platform", name: "docs", location: "要件" },
      reason: "規約",
    });
    service.approve(id, { step: "requirements", submission: current(service, id) });
    await service.runNext(id);
    expect(service.get(id)?.task.exports.requirements).toMatchObject({ url });
    // 書き出しの実行には、決めた接続先（コンテキストの PF）だけを登録する
    expect(registered.at(-1)?.platforms?.map((p) => p.name)).toEqual(["docs"]);
    expect(executor.calls.at(-1)?.command.join(" ")).toContain("$SACTY_PF_URL/docs");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("docs-secret");
    activity.close();
  });

  it("プロジェクトの設定の画面には、合成した PF（名前・層・説明・allow）を出し、秘密情報は出さない", async () => {
    const { activity, service } = setup([]);
    const result = await service.projectPlatforms("a");
    expect(result).toEqual({
      platforms: [
        { name: "jira", description: "JIRA", allow: jiraPlatform().allow },
        {
          name: "docs",
          from: `${ctxRepo}@c0ffee0`,
          description: "チームのドキュメント",
          allow: ["GET /api/pages/**"],
        },
      ],
      warnings: [
        { code: "context.hostPlatform", params: { from: `${ctxRepo}@c0ffee0`, name: "jira" } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("docs-token");
    expect((await service.projectPlatforms("b"))?.platforms.map((p) => p.name)).toEqual(["jira"]);
    expect(await service.projectPlatforms("missing")).toBeUndefined();
    activity.close();
  });

  it("コンテキストを取得できなければ、ホストの PF と、トークンを伏せた理由を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fetcher = contexts();
    fetcher.fail = true;
    const projects = new MemoryProjectStore();
    projects.put("gh", {
      name: "GH",
      targets: [{ scope: "repo", target: "https://github.com/acme/gh" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { service } = makeService(activity, [], {
      config: configOf(agent(), 1, [jiraPlatform()]),
      contexts: fetcher,
      projects,
    });
    const result = await service.projectPlatforms("gh");
    expect(result?.platforms.map((p) => p.name)).toEqual(["jira"]);
    expect(ja(result?.error)).toContain("Authentication failed");
    // 認証のヘッダー（トークンを base64 にしたもの）も伏せる
    const basic = Buffer.from("x-access-token:ghp_secret").toString("base64");
    expect(ja(result?.error)).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
    expect(JSON.stringify(result)).not.toContain(basic);
    activity.close();
  });
});

describe("コンテキストのプレビュー（PBI-76）", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };
  const ctxRepo = "https://github.com/acme/ctx.git";
  const files = {
    "rules.md": "# チームの規約",
    "skills/grp/deploy/SKILL.md": "---\ndescription: デプロイ手順\n---\n手順",
    "mcp.yaml": [
      "servers:",
      "  github:",
      "    command: server-github",
      "    env:",
      "      GITHUB_TOKEN: { secret: mcp-github }",
      "  docs:",
      "    url: https://docs.example.com/mcp",
      "    headers:",
      "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
      "  cloud:",
      "    command: shadowed",
      "    tool_timeout_sec: 1800",
    ].join("\n"),
    "platforms.yaml": [
      "platforms:",
      "  wiki:",
      "    upstream: https://wiki.example.com",
      "    description: Wiki",
      "    auth:",
      "      secret: wiki-token",
      "    allow: [GET /api/**]",
    ].join("\n"),
    "agents/claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
    "agents/codex/config.toml": 'model_reasoning_summary = "concise"\n',
  };
  /** 取得した場所も記録する（後片付けを確かめる）。 */
  class RecordingContexts extends FakeContexts {
    outs: string[] = [];
    override async fetch(ref: ContextRef, out: string, authEnv?: Record<string, string>) {
      this.outs.push(out);
      return super.fetch(ref, out, authEnv);
    }
  }
  const secretValues: Record<string, string> = {
    "claude-oauth-token": "oauth-secret",
    "openai-key": "openai-secret",
    "mcp-github": "mcp-github-value",
    "docs-token": "docs-secret-value",
    "wiki-token": "wiki-secret-value",
  };
  const setup = (
    a: AgentConfig = agent(),
    repos: Record<string, Record<string, string>> = { [ctxRepo]: files },
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("p", {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
    });
    projects.put("bare", {
      name: "コンテキストなし",
      targets: [{ scope: "repo", target: "https://github.com/acme/bare" }],
      githubAccounts: { "github.com": "me" },
    });
    const contexts = new RecordingContexts(repos);
    const gets: string[] = [];
    const registered: unknown[] = [];
    /** ホストの MCP サーバーの準備を待った名前（PBI-77）。プレビューでは待たない。 */
    const ready: string[][] = [];
    const cloud = toHostMcp("cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const made = makeService(activity, [completed(20_000)], {
      config: configOf(a, 1, [jiraPlatform()], [cloud]),
      projects,
      contexts,
      defaultContext: DEFAULT_CONTEXT_DIR,
      hostMcpReady: async (names) => {
        ready.push([...names]);
        return [message("gateway.mcpUnavailable", { name: "cloud", detail: "starting" })];
      },
      secretStore: {
        get: async (name) => {
          gets.push(name);
          const value = secretValues[name];
          if (value === undefined) throw new SecretNotFoundError(name);
          return value;
        },
      },
      gateway: {
        containerOrigin: () => "http://host.docker.internal:5001",
        platformsUrl: (t) => `http://host.docker.internal:5001/r/${t}/pf`,
        githubUrl: (t) => `http://host.docker.internal:5001/r/${t}/github`,
        register: (_route, mcp) => {
          registered.push(mcp);
          return {
            token: "sacty-gw-run-token",
            stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
            close: () => {},
          };
        },
      },
    });
    return {
      ...made,
      activity,
      contexts,
      gets,
      registered,
      ready,
      app: createApp(made.service, token),
    };
  };
  const preview = async (
    app: ReturnType<typeof createApp>,
    id: string,
    body?: unknown,
    runtime = "claude-code",
  ) =>
    body === undefined
      ? app.request(`/api/projects/${id}/context-preview?runtime=${runtime}`, { headers: auth })
      : app.request(`/api/projects/${id}/context-preview`, {
          method: "POST",
          headers: json,
          body: JSON.stringify(body),
        });

  for (const [runtime, a] of [
    ["claude-code", agent()],
    [
      "codex",
      agent({ id: "codex-key", runtime: "codex", auth: { mode: "api-key", secret: "openai-key" } }),
    ],
  ] as const) {
    it(`${runtime}：API のプレビューのファイルは、工程の実行で実際に置いたファイルと一致する`, async () => {
      const { activity, service, executor, app } = setup(a);
      const res = await preview(app, "p", undefined, runtime);
      expect(res.status).toBe(200);
      const { preview: view } = (await res.json()) as {
        preview: { files: { path: string; content: string }[]; runtime: string };
      };
      expect(view.runtime).toBe(runtime);
      const { id } = service.createTask({ projectId: "p", title: "調べる" });
      await service.runNext(id);
      const placed = executor.seeds[0];
      expect(placed && Object.keys(placed).length).toBeGreaterThan(5);
      expect(Object.fromEntries(view.files.map((f) => [f.path, f.content]))).toEqual(placed);
      // AI の種類ごとの設定のファイル
      expect(Object.keys(placed ?? {})).toContain(
        runtime === "codex" ? "config.toml" : "settings.json",
      );
      activity.close();
    });
  }

  it("秘密情報の値・ゲートウェイの実行ごとのトークン・gh のトークンを出さず、秘密情報を取り出さない", async () => {
    const { activity, app, gets, registered, contexts, ready } = setup();
    const res = await preview(app, "p");
    const text = await res.text();
    for (const value of [...Object.values(secretValues), "sacty-gw-run-token", "ghp_secret"]) {
      expect(text).not.toContain(value);
    }
    expect(gets).toEqual([]);
    // ゲートウェイに実行を登録せず、ホストの MCP サーバーの準備も待たない（起動の副作用を起こさない。PBI-77）
    expect(registered).toEqual([]);
    expect(ready).toEqual([]);
    // コンテキストの取得には、プロジェクトの gh のアカウントを使う（実行と同じ）
    expect(contexts.fetched.at(-1)?.authEnv).toBeDefined();
    const view = JSON.parse(text).preview;
    expect(view.secrets).toEqual([
      { env: "SACTY_MCP_SECRET_0", secret: "mcp-github", prefix: "", gatewayToken: false },
      {
        env: "SACTY_MCP_SECRET_1",
        secret: "sacty:gateway-token",
        prefix: "Bearer ",
        gatewayToken: true,
      },
      {
        env: "SACTY_MCP_SECRET_2",
        secret: "sacty:gateway-token",
        prefix: "Bearer ",
        gatewayToken: true,
      },
    ]);
    // MCP は、ゲートウェイ経由に置き換えた形と元の接続先の両方
    expect(view.mcp).toEqual([
      expect.objectContaining({ name: "github", origin: { kind: "direct" } }),
      expect.objectContaining({
        name: "docs",
        agent: { url: "http://host.docker.internal:5001/ctx-mcp/docs" },
        origin: {
          kind: "gateway",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: { secret: "docs-token", prefix: "Bearer " } },
        },
      }),
      expect.objectContaining({
        name: "cloud",
        from: "sacty-gateway",
        agent: { url: "http://host.docker.internal:5001/mcp/cloud" },
        origin: { kind: "host" },
      }),
    ]);
    // 使える外部 PF（ホストと層。秘密情報の名前も出さない）と、警告（ホストと同じ名前）
    expect(view.platforms.map((p: { name: string }) => p.name)).toEqual(["jira", "wiki"]);
    expect(text).not.toContain("wiki-token");
    expect(view.warnings.map((w: unknown) => (w as { code: string }).code)).toEqual([
      "context.hostMcpOverride",
    ]);
    activity.close();
  });

  it("工程の実行では、ホストの MCP の準備を待ち（PBI-77）、作業履歴にホストと同じ名前の警告と準備の警告を残す", async () => {
    const { activity, service, ready, app } = setup();
    // プレビュー・保存の検査は待たない
    await preview(app, "p", undefined, "codex");
    await app.request("/api/projects/p", {
      method: "PUT",
      headers: { ...json, "if-match": service.getProject("p")?.project.updatedAt ?? "" },
      body: JSON.stringify({
        name: "決済",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: ctxRepo },
      }),
    });
    expect(ready).toEqual([]);
    const { id } = service.createTask({ projectId: "p", title: "調べる" });
    await service.runNext(id);
    expect(ready).toEqual([["cloud"]]);
    const resolved = activity.forTask(id).find((e) => e.type === "ContextResolved");
    expect(
      resolved?.type === "ContextResolved" &&
        resolved.payload.warnings.map((w) => (typeof w === "string" ? w : w.code)),
    ).toEqual(["context.hostMcpOverride", "gateway.mcpUnavailable"]);
    activity.close();
  });

  it("編集中の（保存していない）設定でプレビューでき、保存した設定・作業履歴は変えない", async () => {
    const { activity, service, app, contexts } = setup(agent(), {
      [ctxRepo]: files,
      "https://github.com/acme/other.git": { "rules.md": "# 別のコンテキスト" },
    });
    const before = service.getProject("bare");
    const saved = (await (await preview(app, "bare")).json()).preview;
    expect(saved.layers.map((l: { repo: string }) => l.repo)).toEqual(["sacty-default"]);
    const editing = await preview(app, "bare", {
      runtime: "codex",
      definition: {
        name: "コンテキストなし",
        targets: [{ scope: "repo", target: "https://github.com/acme/bare" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: "https://github.com/acme/other.git", ref: "dev" },
      },
    });
    expect(editing.status).toBe(200);
    const view = (await editing.json()).preview;
    expect(view.runtime).toBe("codex");
    expect(
      view.layers.map((l: { repo: string; ref?: string }) => `${l.repo}#${l.ref ?? ""}`),
    ).toEqual(["sacty-default#", "https://github.com/acme/other.git#dev"]);
    const agents = view.files.find((f: { path: string }) => f.path === "AGENTS.md");
    expect(agents.content).toContain("# 別のコンテキスト");
    // 保存していない設定の gh のアカウントで取得する
    expect(contexts.fetched.at(-1)).toMatchObject({ repo: "https://github.com/acme/other.git" });
    expect(contexts.fetched.at(-1)?.authEnv).toBeDefined();
    // 保存した設定は変わらず、作業履歴にも何も残さない。取得したものは消す
    expect(service.getProject("bare")).toEqual(before);
    expect(service.list()).toEqual([]);
    for (const out of contexts.outs) expect(existsSync(out)).toBe(false);
    activity.close();
  });

  it("誤りは、どの層のどのファイルのどの項目かがわかる理由で返し、トークンは伏せる", async () => {
    const { activity, app } = setup(agent(), {
      [ctxRepo]: { "mcp.yaml": "servers:\n  bad:\n    url: ftp://x\n" },
    });
    const res = await preview(app, "p");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: unknown };
    expect(ja(body.error)).toContain(`${ctxRepo} の mcp.yaml に誤りがあります（servers.bad.url）`);
    activity.close();

    const failing = setup();
    failing.contexts.fail = true;
    const failed = (await (await preview(failing.app, "p")).json()) as { error: unknown };
    expect(ja(failed.error)).toContain("Authentication failed");
    expect(JSON.stringify(failed)).not.toContain("ghp_secret");
    expect(ja(failed.error)).toContain("[REDACTED]");
    failing.activity.close();
  });

  it("保存するときも同じ検査をし、誤りがあれば保存したうえで知らせる（誤りが無ければ知らせない）", async () => {
    const { activity, app, service } = setup(agent(), {
      [ctxRepo]: files,
      "https://github.com/acme/broken.git": {
        "platforms.yaml": "platforms:\n  x: { upstream: 1 }\n",
      },
    });
    const definition = {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    };
    const put = (body: unknown) =>
      app.request("/api/projects/p", {
        method: "PUT",
        headers: { ...json, "if-match": service.getProject("p")?.project.updatedAt ?? "" },
        body: JSON.stringify(body),
      });
    const broken = await put({
      ...definition,
      context: { repo: "https://github.com/acme/broken.git" },
    });
    expect(broken.status).toBe(200);
    const saved = (await broken.json()) as { project: { context: unknown }; contextError: unknown };
    expect(saved.project.context).toEqual({ repo: "https://github.com/acme/broken.git" });
    expect(ja(saved.contextError)).toContain(
      "https://github.com/acme/broken.git の platforms.yaml に誤りがあります（platforms.x",
    );
    expect(service.getProject("p")?.project.context).toEqual({
      repo: "https://github.com/acme/broken.git",
    });
    const fine = await put({ ...definition, context: { repo: ctxRepo } });
    expect(await fine.json()).not.toHaveProperty("contextError");
    // コンテキストリポジトリを外せば、確かめない
    const none = await put(definition);
    expect(await none.json()).not.toHaveProperty("contextError");
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "新規",
        context: { repo: "https://github.com/acme/broken.git" },
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toHaveProperty("contextError");
    activity.close();
  });

  it("無いプロジェクトは404、AI の種類・設定の誤りは400を返す", async () => {
    const { activity, app } = setup();
    expect((await preview(app, "missing")).status).toBe(404);
    expect((await preview(app, "missing", { runtime: "codex" })).status).toBe(404);
    expect((await preview(app, "p", undefined, "gpt")).status).toBe(400);
    expect((await preview(app, "p", { runtime: "gpt" })).status).toBe(400);
    const invalid = await preview(app, "p", { definition: { name: "" } });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { issues: { path: unknown[] }[] }).issues[0]?.path).toEqual([
      "definition",
      "name",
    ]);
    expect((await preview(app, "p", { extra: 1 })).status).toBe(400);
    const notJson = await app.request("/api/projects/p/context-preview", {
      method: "POST",
      headers: json,
      body: "{",
    });
    expect(notJson.status).toBe(400);
    // 認証が無ければ 401
    expect((await app.request("/api/projects/p/context-preview")).status).toBe(401);
    activity.close();
  });
});

describe("タスクの作成時に、タスクのイメージ・工程ごとのエージェントを指定する", () => {
  const base = agent();
  const strong = agent({ id: "strong", model: "claude-opus-5-5", reasoning_effort: "high" });
  const java = { name: "java", image: "sacty-agent-java:test", description: "Java 17" };
  const playwright = { name: "playwright", image: "sacty-agent-pw:test", description: "PW" };
  const configured = (): ConfigResult => {
    const config = (configOf(base)() as { ok: true; config: SactyConfig }).config;
    return {
      ok: true,
      config: { ...config, agents: { [base.id]: base, strong }, images: { java, playwright } },
    };
  };
  const designOnly: ServiceDeps["planner"] = async () => ({
    steps: ["requirements", "design"],
    plan: "design-only",
    fallback: false,
    costUsd: 0,
    estimated: false,
    // オーケストレーターは playwright を選ぶ
    image: "playwright",
    imageReason: "画面のテストがある",
  });
  const reject = (service: TaskService, raw: Record<string, unknown>) => {
    try {
      service.createTask({ projectId: "default", title: "A", ...raw });
    } catch (error) {
      return error instanceof InvalidOperationError ? error.messages[0] : error;
    }
    return undefined;
  };

  it("指定したイメージは、オーケストレーターの選択より優先し、すべての工程で使う。エージェントは step_agents より優先する。作業履歴の作成に残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [completed(100), completed(100)], {
      config: configured,
      planner: designOnly,
    });
    const task = service.createTask({
      projectId: "default",
      title: "画面の設計",
      plan: "design-only",
      image: "java",
      agents: { requirements: "strong" },
    });
    expect(task).toMatchObject({
      requestedImage: "java",
      requestedAgents: { requirements: "strong" },
      agents: { requirements: "strong" },
    });
    const created = activity.forTask(task.id).find((e) => e.type === "TaskCreated");
    expect(created?.payload).toMatchObject({
      plan: "design-only",
      image: "java",
      agents: { requirements: "strong" },
    });
    expect(created?.payload).not.toHaveProperty("images");
    await service.runNext(task.id);
    // 工程を決めた記録に、作成時に人が指定したイメージを、決めた元とともに入れる
    const chosen = activity.forTask(task.id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
      image: "java",
      imageSource: "request",
    });
    // 人の指定なので、オーケストレーターの理由は残さない
    expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty("imageReason");
    const latest = service.get(task.id)?.task;
    expect(latest?.image).toBe("java");
    expect(latest?.images).toBeUndefined();
    expect(executor.images[0]).toEqual({ image: "sacty-agent-java:test" });
    const started = activity.forTask(task.id).find((e) => e.type === "AgentRunStarted");
    expect(started?.type === "AgentRunStarted" && started.payload.agentId).toBe("strong");
    service.approve(task.id, { step: "requirements", submission: 1 });
    await service.runNext(task.id);
    expect(executor.images[1]).toEqual({ image: "sacty-agent-java:test" });
    activity.close();
  });

  it("イメージを指定したら、オーケストレーターにイメージの候補を見せず、既定のイメージの理由も求めない", async () => {
    const planOutput = {
      kind: "completed" as const,
      output: `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "design-only", reason: "r" } })}\n\`\`\``,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
    };
    const promptFor = async (image?: string) => {
      rmSync(dbPath, { force: true });
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [planOutput, completed(100)], {
        config: configured,
        realPlanner: true,
      });
      const { id } = service.createTask({
        projectId: "default",
        title: "画面の設計",
        plan: "design-only",
        ...(image ? { image } : {}),
      });
      await service.runNext(id);
      const prompt = executor.calls[0]?.command.join(" ") ?? "";
      const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
      const task = service.get(id)?.task;
      activity.close();
      return { prompt, chosen, task };
    };
    const requested = await promptFor("default");
    expect(requested.prompt).not.toContain("- java：Java 17");
    // 既定のイメージにした理由を求めない（人が指定したため）
    expect(requested.chosen?.type === "StepsChosen" && requested.chosen.payload).not.toHaveProperty(
      "imageUnexplained",
    );
    expect(requested.task?.image).toBe("default");
    expect(requested.task?.imageSource).toBe("request");
    const auto = await promptFor();
    expect(auto.prompt).toContain("- java：Java 17");
    expect(auto.task?.imageUnexplained).toBe(true);
  });

  it("タスクのイメージは、再実行の指定・作成時の人の指定・プロジェクトの対象の指定・オーケストレーターの選択の順に優先する", async () => {
    const go = { name: "go", image: "sacty-agent-go:test", description: "Go" };
    const rust = { name: "rust", image: "sacty-agent-rust:test", description: "Rust" };
    const config = (): ConfigResult => {
      const loaded = (configured() as { ok: true; config: SactyConfig }).config;
      return { ok: true, config: { ...loaded, images: { java, playwright, go, rust } } };
    };
    const repo = "https://github.com/acme/app";
    const chooseFor = async (payload: {
      rerunImage?: string;
      requested?: string;
      project?: string;
    }) => {
      rmSync(dbPath, { force: true });
      const activity = new SqliteActivityStore(dbPath);
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [
          {
            scope: "repo",
            target: repo,
            ...(payload.project ? { image: payload.project } : {}),
          },
        ],
        githubAccounts: { "github.com": "me" },
      });
      // 画面・API では再実行と作成時の指定を同時に持たないので、優先の順を確かめるために記録を直接作る
      const id = randomUUID();
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "決済API",
                body: "",
                start: "sacty",
                repo,
                budgetCapUsd: 10,
                plan: "design-only",
                ...(payload.rerunImage
                  ? { rerun: { taskId: "old", image: payload.rerunImage } }
                  : {}),
                ...(payload.requested ? { image: payload.requested } : {}),
              },
            },
          },
        ],
      });
      const { service, executor } = makeService(activity, [completed(100)], {
        config,
        projects,
        // オーケストレーターは rust を選ぶ
        planner: async () => ({
          steps: ["requirements", "design"],
          plan: "design-only",
          fallback: false,
          costUsd: 0,
          estimated: false,
          image: "rust",
          imageReason: "Cargo.toml",
        }),
      });
      await service.runNext(id);
      const task = service.get(id)?.task;
      const result = {
        image: task?.image,
        source: task?.imageSource,
        ran: executor.images[0]?.image,
      };
      activity.close();
      return result;
    };
    expect(await chooseFor({ rerunImage: "java", requested: "playwright", project: "go" })).toEqual(
      { image: "java", source: "rerun", ran: java.image },
    );
    expect(await chooseFor({ requested: "playwright", project: "go" })).toEqual({
      image: "playwright",
      source: "request",
      ran: playwright.image,
    });
    expect(await chooseFor({ project: "go" })).toEqual({
      image: "go",
      source: "project",
      ran: go.image,
    });
    expect(await chooseFor({})).toEqual({ image: "rust", source: "orchestrator", ran: rust.image });
  });

  it("古い版で作成時に工程ごとのイメージを指定したタスクは、工程を選んだときにその工程のイメージにする（PBI-318 より前の作業履歴）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = randomUUID();
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "画面の設計",
              body: "",
              start: "sacty",
              noRepo: true,
              budgetCapUsd: 10,
              plan: "design-only",
              images: { requirements: "java", design: "default" },
            },
          },
        },
      ],
    });
    const { service, executor } = makeService(activity, [completed(100), completed(100)], {
      config: configured,
      planner: designOnly,
    });
    expect(service.get(id)?.task.requestedImages).toEqual({
      requirements: "java",
      design: "default",
    });
    await service.runNext(id);
    // すべての工程を指定していたので、オーケストレーターの選択でタスクのイメージを決めない（古い版と同じ）
    const task = service.get(id)?.task;
    expect(task?.image).toBeUndefined();
    expect(task?.images).toEqual({ requirements: "java", design: "default" });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(executor.images.map((i) => i.image)).toEqual([java.image, "sacty-agent:test"]);
    activity.close();
  });

  it("古い版で作成時に一部の工程だけイメージを指定したタスクは、オーケストレーターがイメージを決めなくても、既定のイメージをタスクのイメージにしてすべての工程をそろえる（PR #322 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = randomUUID();
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "画面の設計",
              body: "",
              start: "sacty",
              noRepo: true,
              budgetCapUsd: 10,
              plan: "design-only",
              images: { requirements: "java" },
            },
          },
        },
      ],
    });
    const { service, executor } = makeService(activity, [completed(100), completed(100)], {
      config: configured,
      // オーケストレーターはイメージを決めない
      planner: async () => ({
        steps: ["requirements", "design"],
        plan: "design-only",
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.image).toBe("default");
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    // 要求要件だけ java、設計は既定、にならない（どちらもタスクのイメージ）
    expect(executor.images.map((i) => i.image)).toEqual(["sacty-agent:test", "sacty-agent:test"]);
    activity.close();
  });

  it("エージェントの名前は、タスクの詳細で変えるときと同じく長さを限らない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const long = agent({ id: "a".repeat(101) });
    const config = (configured() as { ok: true; config: SactyConfig }).config;
    const { service } = makeService(activity, [], {
      config: () => ({
        ok: true,
        config: { ...config, agents: { ...config.agents, [long.id]: long } },
      }),
    });
    const task = service.createTask({
      projectId: "default",
      title: "A",
      plan: "direct",
      agents: { implement: long.id },
    });
    expect(task.requestedAgents).toEqual({ implement: long.id });
    activity.close();
  });

  it("進め方が無い・進め方に無い工程・統合レビューのエージェント・無い名前・設定を読めないときは、理由を示して断る", () => {
    const activity = new SqliteActivityStore(dbPath);
    let ok = true;
    const { service } = makeService(activity, [], {
      config: () =>
        ok ? configured() : { ok: false, problem: message("config.missing", { path: "x" }) },
    });
    expect(reject(service, { image: "java" })).toEqual(message("task.stepSettingsNeedPlan"));
    expect(reject(service, { plan: "direct", agents: { design: "strong" } })).toEqual(
      message("task.stepSettingOutsidePlan"),
    );
    expect(reject(service, { plan: "split", agents: { integrate: "strong" } })).toEqual(
      message("agent.stepNotChangeable"),
    );
    expect(reject(service, { plan: "direct", image: "ruby" })).toEqual(
      message("image.notInImages", { name: "ruby" }),
    );
    expect(reject(service, { plan: "direct", agents: { implement: "toString" } })).toEqual(
      message("agent.notInAgents", { name: "toString" }),
    );
    ok = false;
    expect(reject(service, { plan: "direct", image: "java" })).toMatchObject({
      code: "image.configUnavailable",
    });
    expect(reject(service, { plan: "direct", agents: { implement: "strong" } })).toMatchObject({
      code: "agent.configUnavailable",
    });
    // 何も指定しなければ、設定を読めなくても今と同じく作る（空の指定も同じ）
    const task = service.createTask({ projectId: "default", title: "A", agents: {} });
    expect(task.requestedImage).toBeUndefined();
    expect(activity.forTask(task.id)[0]?.payload).not.toHaveProperty("image");
    expect(service.list().filter((t) => t.title === "A")).toHaveLength(1);
    activity.close();
  });
});

describe("コンテキストのイメージ（PBI-325）", () => {
  type Entry = ReturnType<NonNullable<ServiceDeps["contextImages"]>["images"]>[number];
  const entry = (state: Entry["state"], extra: Partial<Entry> = {}): Entry => ({
    name: "node-pw",
    description: "Node.js・Playwright",
    from: "acme@abc1234",
    image: "sacty-ctx-default-node-pw:0123456789abcdef",
    language: {
      name: "node-pw",
      image: "sacty-ctx-default-node-pw:0123456789abcdef",
      description: "Node.js・Playwright",
      baseImage: "registry.example.com/ci/node:26",
      env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" },
    },
    state,
    log: "",
    ...extra,
  });
  /** 状態を差し替えられる、コンテキストのイメージの偽物。 */
  const fakeImages = (initial: { pending: boolean; entries: Entry[] }) => {
    const state = { ...initial, rebuilt: [] as string[] };
    const images: NonNullable<ServiceDeps["contextImages"]> = {
      images: (projectId) => (projectId === "default" ? state.entries : []),
      pending: (projectId) => projectId === "default" && state.pending,
      view: () => [],
      rebuild: (_projectId, name) => {
        state.rebuilt.push(name);
        return { ok: true };
      },
      refresh: async () => {},
    };
    return { images, state };
  };
  const planOutput = (image: string) => ({
    kind: "completed" as const,
    output: `\`\`\`json\n{"sacty-steps": {"plan": "standard", "reason": "r", "testCommand": "npx playwright test", "image": "${image}", "imageReason": "Playwright のテストがある"}}\n\`\`\``,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
  });

  it("作っている間は工程を選ばずに待ち、作り終えたら候補に見せて、そのイメージと環境変数で実行する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: true, entries: [entry("building")] });
    const { service, executor } = makeService(activity, [planOutput("node-pw"), completed(10)], {
      realPlanner: true,
      contextImages: fake.images,
    });
    const task = service.createTask({ projectId: "default", title: "画面のテスト" });
    await service.runNext(task.id);
    // 作っている間は、オーケストレーターも動かさない
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task.id)?.task.status).toBe("queued");
    fake.state.pending = false;
    fake.state.entries = [entry("ready")];
    await service.runNext(task.id);
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    expect(prompt).toContain("- node-pw：Node.js・Playwright");
    expect(service.get(task.id)?.task.image).toBe("node-pw");
    expect(executor.images[1]).toEqual({
      image: "sacty-ctx-default-node-pw:0123456789abcdef",
      env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" },
    });
    activity.close();
  });

  it("待つ上限を過ぎたら、理由を示して一時停止する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: true, entries: [entry("building")] });
    let now = Date.parse("2026-11-11T00:00:00Z");
    const { service, executor } = makeService(activity, [], {
      realPlanner: true,
      contextImages: fake.images,
      contextImagesWaitMs: 60_000,
      now: () => now,
    });
    const task = service.createTask({ projectId: "default", title: "画面のテスト" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("queued");
    now += 61_000;
    await service.runNext(task.id);
    const latest = service.get(task.id);
    expect(latest?.task.status).toBe("paused");
    const paused = latest?.activity.findLast((e) => e.type === "TaskPaused");
    expect(paused?.type === "TaskPaused" && paused.payload.message).toEqual({
      code: "contextImage.waitTimedOut",
      params: { project: expect.any(String), minutes: 1 },
    });
    expect(executor.calls).toHaveLength(0);
    activity.close();
  });

  it("config.yaml のイメージを使うと決まったタスクは、コンテキストのイメージを作っていても待たない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: true, entries: [entry("building")] });
    const { service, executor } = makeService(activity, [completed(10)], {
      contextImages: fake.images,
    });
    const task = service.createTask({
      projectId: "default",
      title: "文書",
      plan: "standard",
      image: "default",
    });
    await service.runNext(task.id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it("作成に失敗したイメージを使う工程は、実行せずに理由を示して止まる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({
      pending: false,
      entries: [entry("failed", { error: "イメージを作成できませんでした。" })],
    });
    const { service, executor } = makeService(activity, [planOutput("node-pw")], {
      realPlanner: true,
      contextImages: fake.images,
    });
    const task = service.createTask({ projectId: "default", title: "画面のテスト" });
    await service.runNext(task.id);
    // 作成に失敗したものも選べる（工程は決まる）
    expect(service.get(task.id)?.task.image).toBe("node-pw");
    await service.runNext(task.id);
    const latest = service.get(task.id);
    expect(latest?.task.status).toBe("paused");
    expect(JSON.stringify(latest?.activity)).toContain("contextImage.failed");
    // オーケストレーターだけが動き、工程のエージェントは動かない
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("設定を読めるときの状態に、作成の状況を載せる（PBI-325 レビュー指摘）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: false, entries: [entry("building")] });
    const view = [
      {
        projectId: "default",
        projectName: "既定",
        loading: false,
        warnings: [],
        images: [
          {
            name: "node-pw",
            description: "Node.js・Playwright",
            from: "acme",
            image: "sacty-ctx-default-node-pw:0123456789abcdef",
            state: "building" as const,
          },
        ],
      },
    ];
    fake.images.view = () => view;
    const { service } = makeService(activity, [], { contextImages: fake.images });
    expect(service.status().contextImages).toEqual(view);
    activity.close();
  });

  it("イメージを待っているタスクは、ワーカーの実行の対象から除き、後の実行できるタスクの枠を塞がない（PBI-325 レビュー指摘）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: true, entries: [entry("building")] });
    const { service } = makeService(activity, [], { contextImages: fake.images });
    const waiting = service.createTask({ projectId: "default", title: "画面のテスト" });
    const runnable = service.createTask({
      projectId: "default",
      title: "文書",
      plan: "standard",
      image: "default",
    });
    expect(service.queuedTaskIds()).toEqual([waiting.id, runnable.id]);
    expect(service.runnableTaskIds()).toEqual([runnable.id]);
    fake.state.pending = false;
    expect(service.runnableTaskIds()).toEqual([waiting.id, runnable.id]);
    activity.close();
  });

  it("人がタスクのイメージを default に変えたら、作成時に指定したコンテキストのイメージの作成を待たない（PBI-325 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: false, entries: [entry("ready")] });
    const { service } = makeService(activity, [completed(10)], { contextImages: fake.images });
    const { id } = service.createTask({
      projectId: "default",
      title: "画面のテスト",
      plan: "standard",
      image: "node-pw",
    });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("awaiting_approval");
    service.changeTaskImage(id, { image: "default" });
    service.approve(id, { step: "requirements", submission: 1 });
    expect(service.get(id)?.task.status).toBe("queued");
    // 作成時の指定（node-pw）が残っていても、今のタスクのイメージ（default）で判定する
    fake.state.pending = true;
    expect(service.runnableTaskIds()).toContain(id);
    activity.close();
  });

  it("作成時に、コンテキストのイメージの名前を指定できる。無い名前は断る", () => {
    const activity = new SqliteActivityStore(dbPath);
    const fake = fakeImages({ pending: false, entries: [entry("ready")] });
    const { service } = makeService(activity, [], { contextImages: fake.images });
    const task = service.createTask({
      projectId: "default",
      title: "画面のテスト",
      plan: "standard",
      image: "node-pw",
    });
    expect(service.get(task.id)?.task.requestedImage).toBe("node-pw");
    expect(() =>
      service.createTask({ projectId: "default", title: "x", plan: "standard", image: "nothing" }),
    ).toThrow();
    activity.close();
  });
});
