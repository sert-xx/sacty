import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonText, Task } from "@sacty/core";
import { isCompleted, isRepoless, renderMessage, STEP_PLANS } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { SactyConfig } from "./config.js";
import { PlatformFile, toPlatform } from "./platforms.js";
import { GitRepositoryWorkspace } from "./repository.js";
import { createApp } from "./server.js";
import type { ServiceDeps } from "./service.js";
import {
  agent,
  configOf,
  dbPath,
  dir,
  FakeContexts,
  type FakeExecutor,
  FakeRepos,
  fakeGateway,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

describe("リポジトリを指定しないタスク（PBI-73）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const plan = (v: Record<string, unknown>, output = 1) =>
    out(block({ "sacty-steps": { reason: "理由", ...v } }), output);
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const design = out(
    `# 設計\n\n${block({ "sacty-test-viewpoints": [{ title: "t", input: "i", expected: "e" }] })}`,
  );
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  /** 対象：リポジトリ acme/api と acme/web（tools/secret は、ほかのプロジェクトが担当）。 */
  const twoRepos = (withContext = false) => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: API },
        { scope: "repo", target: WEB },
      ],
      githubAccounts: { "github.com": "me" },
      ...(withContext ? { context: { repo: "https://github.com/acme/context" } } : {}),
    });
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/tools/secret" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };
  const chosenOf = (activity: SqliteActivityStore, id: string) =>
    activity.forTask(id).find((e) => e.type === "StepsChosen");
  const textOf = (value: unknown) => renderMessage(value as DaemonText, "ja");

  describe("実際の Git で複数のリポジトリを用意する", () => {
    function fixtures() {
      const paths = [join(dir, "api.git"), join(dir, "web.git")];
      const commits = paths.map((path, index) => {
        const branch = index === 0 ? "main" : "develop";
        const source = join(dir, `source-${index}`);
        execFileSync("git", ["init", "--initial-branch", branch, source]);
        execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
        execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
        writeFileSync(join(source, "README.md"), index === 0 ? "API の内容" : "Web の内容");
        execFileSync("git", ["-C", source, "add", "."]);
        execFileSync("git", ["-C", source, "commit", "-m", "initial"]);
        execFileSync("git", ["clone", "--bare", source, path]);
        return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
      });
      class LocalRepos extends GitRepositoryWorkspace {
        override async prepare(...args: Parameters<GitRepositoryWorkspace["prepare"]>) {
          const index = [API, WEB].findIndex((url) => args[2] === url || args[2] === `${url}.git`);
          if (index === -1) throw new Error(`想定外の clone URL: ${args[2]}`);
          args[2] = paths[index] as string;
          return super.prepare(...args);
        }
      }
      return { paths, commits, repos: new LocalRepos() as unknown as FakeRepos };
    }

    it.each([false, true])(
      "各工程は選択済み=%s でも既定ブランチの実際の内容と指示を渡す",
      async (selected) => {
        const { paths, commits, repos } = fixtures();
        const activity = new SqliteActivityStore(dbPath);
        const selectedId = "real-selected";
        if (selected)
          activity.append({
            taskId: selectedId,
            projectId: "default",
            events: [
              {
                actor: "person",
                event: {
                  type: "TaskCreated",
                  payload: {
                    title: "複数",
                    body: "",
                    start: "sacty",
                    noRepo: true,
                    repos: [API, WEB],
                    budgetCapUsd: 1,
                  },
                },
              },
              {
                actor: "person",
                event: { type: "RepositoryChosen", payload: { repo: API, reason: "選択" } },
              },
            ],
          });
        const { service, executor, pulls } = makeService(activity, [], {
          projects: twoRepos(),
          repos,
          planner: async (task) => ({
            steps: task.parent ? ["implement"] : ["requirements", "design", "split"],
            plan: task.parent ? "skip-design" : "split",
            reason: "分割",
            fallback: false,
            costUsd: 0,
            estimated: false,
          }),
        });
        const id = selected
          ? selectedId
          : service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] }).id;
        const copies: string[][] = [];
        const childCopies: string[] = [];
        const mounts: string[] = [];
        const mountTargets: string[] = [];
        executor.respond = (invocation) => {
          const workspace = executor.dirs.at(-1) ?? "";
          if (copies.length >= 3) {
            const content = readFileSync(join(workspace, "README.md"), "utf8");
            childCopies.push(content);
            writeFileSync(join(workspace, "README.md"), `${content}\n変更`);
            return out(
              `# 実装\n${block({ "sacty-test-map": [{ viewpointId: "REQ", tests: ["test › 内容"] }] })}`,
            );
          }
          const mount = invocation.mounts?.find((m) => m.containerPath.endsWith("-repos"));
          if (mount) {
            expect(mount.readOnly).toBe(true);
            mounts.push(mount.hostPath);
            mountTargets.push(mount.containerPath);
          }
          const apiDir = selected ? workspace : join(workspace, "1-acme__api");
          const webDir = join(mount?.hostPath ?? workspace, "2-acme__web");
          const contents = [
            readFileSync(join(apiDir, "README.md"), "utf8"),
            readFileSync(join(webDir, "README.md"), "utf8"),
          ];
          copies.push(contents);
          if (copies.length === 1) return out(`# 要求 ${contents.join(" ")}`);
          if (copies.length === 2)
            return out(
              `# 設計 ${contents.join(" ")}\n${block({ "sacty-test-viewpoints": [{ title: "t", input: "i", expected: "e" }] })}`,
            );
          return out(
            block({
              "sacty-split": {
                reason: "分割",
                children: contents.map((content, index) => ({
                  key: index === 0 ? "A" : "B",
                  title: content,
                  body: content,
                  dependsOn: [],
                  repo: index === 0 ? API : WEB,
                  repoReason: content,
                })),
              },
            }),
          );
        };
        await service.runNext(id);
        service.approve(id, { step: "requirements", submission: 1 });
        await service.runNext(id);
        service.approve(id, { step: "design", submission: 1 });
        await service.runNext(id);
        expect(copies).toEqual(Array.from({ length: 3 }, () => ["API の内容", "Web の内容"]));
        for (let i = 0; i < 3; i++) {
          const prompt = promptOf(executor, i);
          expect(prompt).toContain(
            `- ${API}：${selected ? "." : "1-acme__api"}（main、${commits[0]}）`,
          );
          expect(prompt).toContain(
            `- ${WEB}：${selected ? `${mountTargets[i]}/` : ""}2-acme__web（develop、${commits[1]}）`,
          );
        }
        for (const path of selected ? mounts : executor.dirs) expect(existsSync(path)).toBe(false);
        const children = service.get(id)?.task.split?.children ?? [];
        expect(children.map((child) => child.repo)).toEqual([API, WEB]);
        for (const [index, child] of children.entries()) {
          expect(service.get(child.taskId)?.task.repo).toBe(index === 0 ? API : WEB);
          for (let attempt = 0; attempt < 8 && pulls.calls.length <= index; attempt++)
            await service.runNext(child.taskId);
          expect(childCopies[index]).toBe(index === 0 ? "API の内容" : "Web の内容");
          const pr = pulls.calls[index];
          expect(pr).toMatchObject({
            repo: index === 0 ? API : WEB,
            baseBranch: index === 0 ? "main" : "develop",
          });
          expect(
            execFileSync(
              "git",
              ["--git-dir", paths[index] ?? "", "rev-parse", `refs/heads/${pr?.branch}`],
              { encoding: "utf8" },
            ).trim(),
          ).toMatch(/^[0-9a-f]{40}$/);
          expect(() =>
            execFileSync(
              "git",
              [
                "--git-dir",
                paths[1 - index] ?? "",
                "rev-parse",
                "--verify",
                `refs/heads/${pr?.branch}`,
              ],
              { stdio: "pipe" },
            ),
          ).toThrow();
        }
        activity.close();
      },
    );

    it("bare リポジトリを失うと名前を示して工程を止める", async () => {
      const { paths, repos } = fixtures();
      rmSync(paths[1] ?? "", { recursive: true, force: true });
      const activity = new SqliteActivityStore(dbPath);
      const id = "real-missing";
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "複数",
                body: "",
                start: "sacty",
                noRepo: true,
                repos: [API, WEB],
                budgetCapUsd: 1,
              },
            },
          },
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: { steps: ["requirements"], plan: "split", reason: "分割", costUsd: 0 },
            },
          },
        ],
      });
      const { service, executor } = makeService(activity, [out("# 要求")], {
        projects: twoRepos(),
        repos,
      });
      await service.runNext(id);
      expect(executor.calls).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("paused");
      const failed = activity.forTask(id).find((event) => event.type === "AgentRunFailed");
      expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toContain(WEB);
      activity.close();
    });
  });

  it("複数指定は次の工程で clone を再利用し、最新のコミットを取得する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = "copy-refresh";
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "複数",
              body: "",
              start: "sacty",
              noRepo: true,
              repos: [API, WEB],
              budgetCapUsd: 1,
            },
          },
        },
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: {
              steps: ["requirements", "design", "implement"],
              plan: "standard",
              reason: "分割",
              costUsd: 0,
            },
          },
        },
      ],
    });
    const projects = twoRepos();
    const { service, executor, repos } = makeService(activity, [out("# 要求要件"), out("# 設計")], {
      projects,
    });
    const originalPrepare = repos.prepare.bind(repos);
    vi.spyOn(repos, "prepare").mockImplementation(async (...args) => {
      const result = await originalPrepare(...args);
      mkdirSync(join(args[0], ".git"), { recursive: true });
      writeFileSync(join(args[0], ".git", "history"), "history");
      return result;
    });
    const originalSnapshot = repos.snapshot.bind(repos);
    vi.spyOn(repos, "snapshot").mockImplementation(async (gitDir, commit, destination) => {
      await originalSnapshot(gitDir, commit, destination);
      writeFileSync(
        join(destination, "README.md"),
        `${gitDir.includes("1-acme__api") ? "api" : "web"} ${commit}`,
      );
    });
    const copies: string[][] = [];
    executor.respond = () => {
      const workspace = executor.dirs.at(-1) ?? "";
      copies.push(
        ["1-acme__api", "2-acme__web"].map((name) =>
          readFileSync(join(workspace, name, "README.md"), "utf8"),
        ),
      );
      return undefined;
    };
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    expect(service.get(id)?.task.stepReview).toBe("requirements");
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: API }],
      githubAccounts: { "github.com": "me" },
    });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.stepReview).toBe("requirements");
    projects.put("default", {
      name: "デフォルト",
      targets: [API, WEB].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    service.resume(id, {});
    repos.branchHead = "d".repeat(40);
    repos.defaultBranch = "release+2026";
    await service.runNext(id);
    for (const prepared of repos.prepared) {
      expect(existsSync(join(prepared.dir, ".git"))).toBe(false);
      expect(existsSync(prepared.gitDir)).toBe(true);
    }
    expect(repos.prepared.map((p) => p.url)).toEqual([API, WEB]);
    expect(repos.fetchedBranches).toHaveLength(4);
    expect(repos.fetchedBranches.map((f) => f.branch)).toEqual([
      "main",
      "main",
      "release+2026",
      "release+2026",
    ]);
    expect(copies).toEqual([
      [`api ${"c".repeat(40)}`, `web ${"c".repeat(40)}`],
      [`api ${repos.branchHead}`, `web ${repos.branchHead}`],
    ]);
    expect(promptOf(executor, 1)).toContain(repos.branchHead);
    activity.close();
  });

  // 調査の工程（進め方が「調査だけ」のタスク）にも渡す（PBI-367）
  it.each(["investigate", "requirements", "design", "split"] as const)(
    "複数指定の%sは選択前に両方の最新を読み、clone を再利用する",
    async (step) => {
      const activity = new SqliteActivityStore(dbPath);
      const id = `copies-${step}`;
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "複数",
                body: "",
                start: "sacty",
                noRepo: true,
                repos: [API, WEB],
                budgetCapUsd: 1,
              },
            },
          },
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [step],
                plan: step === "investigate" ? "investigate" : "split",
                reason: "分割",
                costUsd: 0,
              },
            },
          },
        ],
      });
      const { service, executor, repos } = makeService(activity, [out("# 結果")], {
        projects: twoRepos(),
      });
      await service.runNext(id);
      expect(executor.workspaceFiles[0]).toEqual(["1-acme__api", "2-acme__web"]);
      expect(repos.prepared.map((p) => p.url)).toEqual([API, WEB]);
      expect(repos.fetchedBranches.map((p) => p.branch)).toEqual(["main", "main"]);
      expect(promptOf(executor, 0)).toContain(`1-acme__api（main、${repos.branchHead}）`);
      expect(promptOf(executor, 0)).toContain(`2-acme__web（main、${repos.branchHead}）`);
      expect(promptOf(executor, 0)).not.toContain("作業領域（カレントディレクトリ）は空");
      expect(existsSync(executor.dirs[0] ?? "")).toBe(false);
      activity.close();
    },
  );

  // 調査の工程（進め方が「調査だけ」のタスク）にも渡す（PBI-367）
  it.each(["investigate", "requirements", "design", "split"] as const)(
    "複数指定の%sは選択後に起点と他の写しを読み、実行後に片付ける",
    async (step) => {
      const activity = new SqliteActivityStore(dbPath);
      const id = `chosen-copies-${step}`;
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "複数",
                body: "",
                start: "sacty",
                noRepo: true,
                repos: [API, WEB],
                budgetCapUsd: 1,
              },
            },
          },
          {
            actor: "person",
            event: { type: "RepositoryChosen", payload: { repo: API, reason: "選択" } },
          },
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [step],
                plan: step === "investigate" ? "investigate" : "split",
                reason: "分割",
                costUsd: 0,
              },
            },
          },
        ],
      });
      const { service, executor, repos } = makeService(activity, [out("# 結果")], {
        projects: twoRepos(),
      });
      repos.head = "a".repeat(40);
      repos.branchHead = "b".repeat(40);
      vi.spyOn(repos, "snapshot").mockImplementation(async (gitDir, commit, destination) => {
        mkdirSync(destination, { recursive: true });
        writeFileSync(
          join(destination, "README.md"),
          `${gitDir.includes("2-acme__web") ? "web" : "api"} ${commit}`,
        );
      });
      let mounted: { path: string; readOnly: boolean; content: string } | undefined;
      let selectedContent: string | undefined;
      executor.respond = (invocation) => {
        selectedContent = readFileSync(join(executor.dirs.at(-1) ?? "", "README.md"), "utf8");
        const mount = invocation.mounts?.find((m) => m.containerPath === "/sacty-repos");
        if (mount)
          mounted = {
            path: mount.hostPath,
            readOnly: mount.readOnly,
            content: readFileSync(join(mount.hostPath, "2-acme__web", "README.md"), "utf8"),
          };
        return undefined;
      };
      await service.runNext(id);
      expect(executor.workspaceFiles[0]).toEqual(["README.md"]);
      expect(selectedContent).toBe(`api ${repos.head}`);
      expect(mounted).toMatchObject({ readOnly: true, content: `web ${repos.branchHead}` });
      if (step === "requirements" || step === "design") {
        expect(executor.inputMounts[0]?.readOnly).toBe(true);
        expect(executor.inputMounts[0]?.files["task.md"]).toContain("複数");
      }
      expect(existsSync(mounted?.path ?? "")).toBe(false);
      expect(promptOf(executor, 0)).toContain(`2-acme__web（main、${repos.branchHead}）`);
      expect(promptOf(executor, 0)).toContain(API);
      activity.close();
    },
  );

  it.each([false, true])("停止未確認の実行は選択済み=%s でも写しを保持する", async (selected) => {
    const activity = new SqliteActivityStore(dbPath);
    const id = "unconfirmed-multi-copy";
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "複数",
              body: "",
              start: "sacty",
              noRepo: true,
              repos: [API, WEB],
              budgetCapUsd: 1,
            },
          },
        },
        ...(selected
          ? [
              {
                actor: "person" as const,
                event: {
                  type: "RepositoryChosen" as const,
                  payload: { repo: API, reason: "選択" },
                },
              },
            ]
          : []),
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["requirements"], plan: "split", reason: "分割", costUsd: 0 },
          },
        },
      ],
    });
    const { service, executor } = makeService(activity, [out("# 結果")], { projects: twoRepos() });
    executor.stops = false;
    let path = "";
    executor.respond = (invocation) => {
      path = selected
        ? (invocation.mounts?.find((mount) => mount.containerPath === "/sacty-repos")?.hostPath ??
          "")
        : (executor.dirs.at(-1) ?? "");
      return undefined;
    };
    await service.runNext(id);
    expect(path).not.toBe("");
    expect(existsSync(join(path, "2-acme__web", "README.md"))).toBe(true);
    activity.close();
  });

  it("選択後の初回 clone 中の一時停止は手動停止として記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = "pause-initial-multi-clone";
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "複数",
              body: "",
              start: "sacty",
              noRepo: true,
              repos: [API, WEB],
              budgetCapUsd: 1,
            },
          },
        },
        {
          actor: "person",
          event: { type: "RepositoryChosen", payload: { repo: API, reason: "選択" } },
        },
      ],
    });
    const { service, executor, repos } = makeService(activity, [], { projects: twoRepos() });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(repos, "prepare").mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      throw new Error("stopped");
    });
    const running = service.runNext(id);
    await started.promise;
    const pausing = service.pause(id);
    gate.resolve();
    await Promise.all([running, pausing]);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(
      service.get(id)?.activity.findLast((item) => item.type === "TaskPaused")?.payload,
    ).toMatchObject({ reason: "manual" });
    activity.close();
  });

  it("複数指定のリモート確認中に一時停止すると通信を中断し、再開後に進む", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = "pause-repository-fetch";
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "複数",
              body: "",
              start: "sacty",
              noRepo: true,
              repos: [API, WEB],
              budgetCapUsd: 1,
            },
          },
        },
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["requirements"], plan: "split", reason: "分割", costUsd: 0 },
          },
        },
      ],
    });
    const { service, executor, repos } = makeService(activity, [out("# 結果")], {
      projects: twoRepos(),
    });
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const original = repos.remoteDefaultBranch.bind(repos);
    vi.spyOn(repos, "remoteDefaultBranch")
      .mockImplementationOnce(async (_dir, _auth, signal) => {
        ready();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }),
        );
        return "main";
      })
      .mockImplementation(original);
    const running = service.runNext(id);
    await started;
    await service.pause(id);
    await running;
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const pause = service.get(id)?.activity.findLast((item) => item.type === "TaskPaused");
    expect(pause?.payload).toMatchObject({ reason: "manual" });
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it.each([
    [false, "requirements"],
    [true, "requirements"],
    // 調査の工程も、同じく止まって再開できる（PBI-367）
    [false, "investigate"],
    [true, "investigate"],
  ] as const)(
    "複数指定の写しの失敗は選択状態 %s の %s でも停止し、復旧後に再開する",
    async (chosen, step) => {
      const activity = new SqliteActivityStore(dbPath);
      const id = `copy-failure-${chosen}-${step}`;
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "複数",
                body: "",
                start: "sacty",
                noRepo: true,
                repos: [API, WEB],
                budgetCapUsd: 1,
              },
            },
          },
          ...(chosen
            ? [
                {
                  actor: "person" as const,
                  event: {
                    type: "RepositoryChosen" as const,
                    payload: { repo: API, reason: "選択" },
                  },
                },
              ]
            : []),
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [step],
                plan: step === "investigate" ? "investigate" : "split",
                reason: "分割",
                costUsd: 0,
              },
            },
          },
        ],
      });
      const main = agent({ fallback: ["backup"] });
      const backup = agent({ id: "backup" });
      const config = () => {
        const base = configOf(main)();
        return base.ok
          ? { ok: true as const, config: { ...base.config, agents: { [main.id]: main, backup } } }
          : base;
      };
      const { service, executor, repos } = makeService(activity, [out("# 結果")], {
        projects: twoRepos(),
        config,
      });
      const prepare = repos.prepare.bind(repos);
      let failWeb = true;
      vi.spyOn(repos, "prepare").mockImplementation(async (...args) => {
        if (args[2] === WEB && failWeb) {
          mkdirSync(args[0], { recursive: true });
          mkdirSync(args[1], { recursive: true });
          throw new Error("clone failed");
        }
        return prepare(...args);
      });
      await service.runNext(id);
      expect(executor.calls).toHaveLength(0);
      const failed = activity.forTask(id).find((event) => event.type === "AgentRunFailed");
      expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toContain(WEB);
      expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toContain(
        "clone failed",
      );
      expect(service.get(id)?.task.status).toBe("paused");
      failWeb = false;
      service.resume(id, {});
      await service.runNext(id);
      expect(executor.calls).toHaveLength(1);
      activity.close();
    },
  );

  it("選択済みの再準備が途中で失敗しても名前と理由を記録し、未完了の写しを作り直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = "chosen-incomplete-copy";
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "複数",
              body: "",
              start: "sacty",
              noRepo: true,
              repos: [API, WEB],
              budgetCapUsd: 1,
            },
          },
        },
        {
          actor: "person",
          event: { type: "RepositoryChosen", payload: { repo: WEB, reason: "選択" } },
        },
        {
          actor: "sacty",
          event: {
            type: "RepositoryPrepared",
            payload: { url: WEB, baseBranch: "main", baseCommit: "base123" },
          },
        },
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["requirements"], plan: "split", reason: "分割", costUsd: 0 },
          },
        },
      ],
    });
    const { service, executor, repos } = makeService(activity, [out("# 結果")], {
      projects: twoRepos(),
    });
    const prepare = repos.prepare.bind(repos);
    let attempts = 0;
    vi.spyOn(repos, "prepare").mockImplementation(async (...args) => {
      if (args[2] === WEB && ++attempts === 1) {
        mkdirSync(args[0], { recursive: true });
        mkdirSync(args[1], { recursive: true });
        writeFileSync(join(args[1], "partial"), "incomplete");
        throw new Error("metadata copy failed");
      }
      if (args[2] === WEB) expect(existsSync(join(args[1], "partial"))).toBe(false);
      return prepare(...args);
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failed = activity.forTask(id).find((event) => event.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toContain(WEB);
    expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toContain(
      "metadata copy failed",
    );
    service.resume(id, {});
    await service.runNext(id);
    expect(attempts).toBe(2);
    expect(repos.prepared.find((entry) => entry.url === WEB)?.recorded).toBe("base123");
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("複数の指定を正規化して記録し、不正な指定を断る", () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const extra = Array.from({ length: 9 }, (_, i) => `https://github.com/acme/extra${i}`);
    projects.put("default", {
      name: "デフォルト",
      targets: [API, WEB, ...extra].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    const { service } = makeService(activity, [], { projects });
    const multi = service.createTask({
      projectId: "default",
      title: "複数",
      repos: [API, WEB, API.toUpperCase()],
    });
    expect(multi).toMatchObject({ noRepo: true, repos: [API, WEB] });
    const single = service.createTask({
      projectId: "default",
      title: "単数",
      repos: [API, API.toUpperCase()],
    });
    expect(single.repo).toBe(API);
    expect(single.repos).toBeUndefined();
    const ten = service.createTask({
      projectId: "default",
      title: "10件",
      repos: [API, WEB, ...extra.slice(0, 8), API],
    });
    expect(ten.repos).toHaveLength(10);
    expect(() =>
      service.createTask({ projectId: "default", title: "11件", repos: [API, WEB, ...extra] }),
    ).toThrow(/10/);
    expect(() =>
      service.createTask({
        projectId: "default",
        title: "対象外",
        repos: [API, "https://github.com/other/missing"],
      }),
    ).toThrow(/other\/missing/);
    expect(() =>
      service.createTask({ projectId: "default", title: "両方", repo: null, repos: [API] }),
    ).toThrow(/repo/);
    expect(() => service.createTask({ projectId: "default", title: "空", repos: [] })).toThrow();
    activity.close();
  });

  it("API は複数の指定を作業履歴と投影に記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const app = createApp(service, "tok");
    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ projectId: "default", title: "複数", repos: [API, WEB] }),
    });
    expect(response.status).toBe(201);
    const { task } = (await response.json()) as { task: Task };
    expect(task).toMatchObject({ noRepo: true, repos: [API, WEB] });
    expect(isRepoless(task)).toBe(true);
    expect(activity.forTask(task.id).find((e) => e.type === "TaskCreated")?.payload).toMatchObject({
      noRepo: true,
      repos: [API, WEB],
    });
    activity.close();
  });

  it("複数指定でも準備以外の例外を準備失敗として記録しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], { projects: twoRepos() });
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    const internal = service as unknown as { heldReviewDue: () => boolean };
    const spy = vi.spyOn(internal, "heldReviewDue").mockImplementationOnce(() => {
      throw new Error("unexpected failure");
    });
    await expect(service.runNext(id)).rejects.toThrow("unexpected failure");
    expect(executor.calls).toHaveLength(0);
    expect(
      activity
        .forTask(id)
        .some(
          (event) =>
            event.type === "AgentRunStarted" ||
            event.type === "AgentRunFailed" ||
            event.type === "TaskPaused",
        ),
    ).toBe(false);
    spy.mockRestore();
    activity.close();
  });

  it("工程開始直前の候補照合中の一時停止は照合失敗を記録しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const id = "pause-second-candidates";
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "複数",
              body: "",
              start: "sacty",
              noRepo: true,
              repos: [API, WEB],
              budgetCapUsd: 1,
            },
          },
        },
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["requirements"], plan: "split", reason: "分割", costUsd: 0 },
          },
        },
      ],
    });
    const { service, executor } = makeService(activity, [], { projects: twoRepos() });
    const list = service.projectRepositories.bind(service);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    vi.spyOn(service, "projectRepositories").mockImplementation(async (projectId) => {
      if (++calls === 2) {
        started.resolve();
        await gate.promise;
        throw new Error("listing failed");
      }
      return list(projectId);
    });
    const running = service.runNext(id);
    await started.promise;
    const stopping = service.pause(id);
    gate.resolve();
    await Promise.all([running, stopping]);
    expect(executor.calls).toHaveLength(0);
    const events = activity.forTask(id);
    expect(
      events.some(
        (event) =>
          event.type === "AgentRunStarted" ||
          event.type === "AgentRunFailed" ||
          event.type === "OrchestratorFailed",
      ),
    ).toBe(false);
    expect(events.findLast((event) => event.type === "TaskPaused")?.payload).toMatchObject({
      reason: "manual",
    });
    activity.close();
  });

  it("複数指定の候補取得中に一時停止すると照合失敗より手動停止を優先する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    let release!: (value: { repositories: string[]; errors: [] }) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(service, "projectRepositories").mockImplementationOnce(async () => {
      started();
      return await new Promise((resolve) => {
        release = resolve;
      });
    });
    const running = service.runNext(id);
    await waiting;
    const stopping = service.pause(id);
    release({ repositories: [], errors: [] });
    await running;
    await stopping;
    const pauses = activity.forTask(id).filter((event) => event.type === "TaskPaused");
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.payload).toMatchObject({ reason: "manual" });
    expect(activity.forTask(id).some((event) => event.type === "OrchestratorFailed")).toBe(false);
    activity.close();
  });

  it("複数指定の照合はプロジェクト一覧を一度読み、読み取り失敗をそのまま伝える", () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const { service } = makeService(activity, [], { projects });
    const all = vi.spyOn(projects, "all");
    service.createTask({ projectId: "default", title: "重複", repos: [API, API, WEB] });
    const calls = all.mock.calls.length;
    all.mockClear();
    service.createTask({ projectId: "default", title: "多数", repos: [API, API, API, WEB, WEB] });
    expect(all).toHaveBeenCalledTimes(calls);
    all.mockImplementation(() => {
      throw new Error("project store failed");
    });
    expect(() =>
      service.createTask({ projectId: "default", title: "失敗", repos: [API, WEB] }),
    ).toThrow("project store failed");
    all.mockRestore();
    activity.close();
  });

  it("API は1件の配列を単数指定と同じ形で記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const app = createApp(service, "tok");
    const post = (input: object) =>
      app.request("/api/tasks", {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ projectId: "default", title: "単数", ...input }),
      });
    const single = await post({ repo: API });
    const array = await post({ repos: [API] });
    expect(single.status).toBe(201);
    expect(array.status).toBe(201);
    const a = ((await single.json()) as { task: Task }).task;
    const b = ((await array.json()) as { task: Task }).task;
    expect(b.repo).toBe(a.repo);
    expect(b.noRepo).toBe(a.noRepo);
    expect(b.repos).toBeUndefined();
    expect(isRepoless(b)).toBe(isRepoless(a));
    activity.close();
  });

  it.each(["unknown", "limit", "conflict"] as const)(
    "API は不正な%sを名前または上限を示して記録せず断る",
    async (kind) => {
      const activity = new SqliteActivityStore(dbPath);
      const extra = Array.from({ length: 9 }, (_, i) => `https://github.com/acme/extra${i}`);
      const projects = twoRepos();
      projects.put("default", {
        name: "デフォルト",
        targets: [API, WEB, ...extra].map((target) => ({ scope: "repo" as const, target })),
        githubAccounts: { "github.com": "me" },
      });
      const { service } = makeService(activity, [], { projects });
      const app = createApp(service, "tok");
      const inputs = {
        unknown: { repos: [API, "https://github.com/other/missing"] },
        limit: { repos: [API, WEB, ...extra] },
        conflict: { repo: API, repos: [WEB] },
      };
      const response = await app.request("/api/tasks", {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ projectId: "default", title: "不正", ...inputs[kind] }),
      });
      expect(response.status).toBe(400);
      const body = JSON.stringify(await response.json());
      expect(body).toContain(
        kind === "unknown"
          ? "other/missing"
          : kind === "limit"
            ? "repositoriesLimit"
            : "repositoriesConflict",
      );
      expect(service.list()).toHaveLength(0);
      activity.close();
    },
  );

  it("複数指定の候補外をオーケストレーターと人の選択で断る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const extra = "https://github.com/acme/extra";
    projects.put("default", {
      name: "デフォルト",
      targets: [API, WEB, extra].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "standard", repo: extra, repoReason: "理由" })],
      { projects, realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    await service.runNext(id);
    expect(promptOf(executor, 0)).toContain(API);
    expect(promptOf(executor, 0)).toContain(WEB);
    expect(promptOf(executor, 0)).not.toContain(extra);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      extra,
    );
    await expect(service.chooseRepository(id, extra)).rejects.toThrow(extra);
    const before = activity.forTask(id);
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: API }],
      githubAccounts: { "github.com": "me" },
    });
    await expect(service.chooseRepository(id, API)).rejects.toThrow(WEB);
    expect(activity.forTask(id)).toEqual(before);
    projects.put("default", {
      name: "デフォルト",
      targets: [API, WEB, extra].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    expect(service.get(id)?.task.status).toBe("paused");
    expect(activity.forTask(id).some((event) => event.type === "RepositoryChosen")).toBe(false);
    await service.chooseRepository(id, WEB);
    expect(service.get(id)?.task.repo).toBe(WEB);
    activity.close();
  });

  it("一覧取得例外で停止し、人の選択にも原因を返して復旧後に再開する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" }), out("# 結果")],
      { projects: twoRepos(), realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    const listing = vi
      .spyOn(service, "projectRepositories")
      .mockRejectedValue(new Error("listing failed"));
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((e) => e.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      "listing failed",
    );
    const before = activity.forTask(id);
    await expect(service.chooseRepository(id, API)).rejects.toThrow("listing failed");
    expect(activity.forTask(id)).toEqual(before);
    listing.mockRestore();
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it("プロジェクト定義の読み取り例外でオーケストレーターを停止し復旧後に再開する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" })],
      { projects, realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    const read = vi.spyOn(projects, "get").mockImplementation(() => {
      throw new Error("invalid project definition");
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      "invalid project definition",
    );
    read.mockRestore();
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it("イメージ待ちと選択後の準備より前に定義の読み取り失敗で停止し、復旧後に再開する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const contextImages: NonNullable<ServiceDeps["contextImages"]> = {
      images: () => [],
      pending: () => true,
      view: () => [],
      rebuild: () => ({ ok: true }),
      refresh: async () => {},
    };
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" })],
      {
        projects,
        realPlanner: true,
        contextImages,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    await service.pause(id);
    await service.chooseRepository(id, API);
    service.resume(id, {});
    const read = vi.spyOn(projects, "get").mockImplementation(() => {
      throw new Error("invalid project definition");
    });
    expect(service.runnableTaskIds()).toContain(id);
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      "invalid project definition",
    );
    read.mockRestore();
    contextImages.pending = () => false;
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it.each(["wait", "image", "repository"] as const)(
    "候補照合後の%sの準備で定義を読めなければ停止し、再開できる",
    async (preparation) => {
      const activity = new SqliteActivityStore(dbPath);
      const projects = twoRepos();
      let pending = preparation === "wait";
      const contextImages: NonNullable<ServiceDeps["contextImages"]> = {
        images: () =>
          preparation === "image"
            ? [
                {
                  name: "web",
                  description: "web",
                  from: "context",
                  image: "example",
                  language: {
                    name: "web",
                    image: "example",
                    description: "web",
                    baseImage: "node",
                    env: {},
                  },
                  state: "ready" as const,
                  log: "",
                },
              ]
            : [],
        pending: () => pending,
        view: () => [],
        rebuild: () => ({ ok: true }),
        refresh: async () => {},
      };
      const { service, executor } = makeService(
        activity,
        [plan({ plan: "investigate", investigation: "content" })],
        { projects, realPlanner: true, contextImages },
      );
      const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
      if (preparation === "repository") {
        await service.pause(id);
        await service.chooseRepository(id, API);
        service.resume(id, {});
      }
      const list = service.projectRepositories.bind(service);
      const get = projects.get.bind(projects);
      let failNextRead = false;
      const read = vi.spyOn(projects, "get").mockImplementation((projectId) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("late definition failure");
        }
        return get(projectId);
      });
      const listing = vi
        .spyOn(service, "projectRepositories")
        .mockImplementationOnce(async (projectId) => {
          const result = await list(projectId);
          failNextRead = true;
          return result;
        });
      await service.runNext(id);
      expect(executor.calls).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("paused");
      const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
      expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
        "late definition failure",
      );
      const failureText =
        failure?.type === "OrchestratorFailed" ? textOf(failure.payload.message) : "";
      if (preparation === "repository") expect(failureText).toContain(API);
      else expect(failureText).not.toContain(API);
      listing.mockRestore();
      read.mockRestore();
      pending = false;
      service.resume(id, {});
      await service.runNext(id);
      expect(executor.calls.length).toBeGreaterThan(0);
      activity.close();
    },
  );

  it.each([1, 2])(
    "選択後の要求要件の準備で%d回目の照合後に定義を読めなくても停止し、再開する",
    async (failureAfter) => {
      const activity = new SqliteActivityStore(dbPath);
      const projects = twoRepos();
      const id = "multiple-preparation-error";
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "複数",
                body: "",
                start: "sacty",
                noRepo: true,
                repos: [API, WEB],
                budgetCapUsd: 1,
              },
            },
          },
          {
            actor: "person",
            event: { type: "RepositoryChosen", payload: { repo: API, reason: "選択" } },
          },
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: { steps: [...STEP_PLANS.split], plan: "split", reason: "分割", costUsd: 0 },
            },
          },
        ],
      });
      const contextImages: NonNullable<ServiceDeps["contextImages"]> = {
        images: () => [
          {
            name: "web",
            description: "web",
            from: "context",
            image: "example",
            language: {
              name: "web",
              image: "example",
              description: "web",
              baseImage: "node",
              env: {},
            },
            state: "ready" as const,
            log: "",
          },
        ],
        pending: () => false,
        view: () => [],
        rebuild: () => ({ ok: true }),
        refresh: async () => {},
      };
      const { service, executor } = makeService(activity, [out("# 要求要件")], {
        projects,
        contextImages,
      });
      const list = service.projectRepositories.bind(service);
      const get = projects.get.bind(projects);
      let failNextRead = false;
      let listings = 0;
      const read = vi.spyOn(projects, "get").mockImplementation((projectId) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("late step failure");
        }
        return get(projectId);
      });
      const listing = vi
        .spyOn(service, "projectRepositories")
        .mockImplementation(async (projectId) => {
          const result = await list(projectId);
          if (++listings === failureAfter) failNextRead = true;
          return result;
        });
      await service.runNext(id);
      expect(executor.calls).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("paused");
      const failure = activity.forTask(id).find((event) => event.type === "AgentRunFailed");
      expect(failure?.type === "AgentRunFailed" && failure.payload.step).toBe("requirements");
      expect(failure?.type === "AgentRunFailed" && textOf(failure.payload.message)).toContain(
        "late step failure",
      );
      listing.mockRestore();
      read.mockRestore();
      service.resume(id, {});
      await service.runNext(id);
      expect(executor.calls).toHaveLength(1);
      activity.close();
    },
  );

  it("オーケストレーターの候補照合後の定義読み取り失敗で停止し再開する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" })],
      { projects, realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    const list = service.projectRepositories.bind(service);
    const get = projects.get.bind(projects);
    let listings = 0;
    let fail = false;
    const read = vi.spyOn(projects, "get").mockImplementation((projectId) => {
      if (fail) {
        fail = false;
        throw new Error("orchestrator late read");
      }
      return get(projectId);
    });
    const listing = vi
      .spyOn(service, "projectRepositories")
      .mockImplementation(async (projectId) => {
        const result = await list(projectId);
        if (++listings === 2) fail = true;
        return result;
      });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      "orchestrator late read",
    );
    listing.mockRestore();
    read.mockRestore();
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it("選択後に対象から外れた場合もオーケストレーターを実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const { service, executor } = makeService(
      activity,
      [
        plan({ plan: "standard", repo: API, repoReason: "API" }),
        plan({ plan: "investigate", investigation: "content" }),
        out("# 結果"),
      ],
      { projects, realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    await service.runNext(id);
    expect(service.get(id)?.task.repo).toBe(API);
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: API }],
      githubAccounts: { "github.com": "me" },
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((e) => e.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      WEB,
    );
    projects.put("default", {
      name: "デフォルト",
      targets: [API, WEB].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(1);
    activity.close();
  });

  it("選択した2件目の準備失敗はその名前と原因を示し、再開できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const { service, executor, repos } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" })],
      { projects, realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    await service.pause(id);
    await service.chooseRepository(id, WEB);
    service.resume(id, {});
    repos.fail = "clone failed";
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    const text = failure?.type === "OrchestratorFailed" ? textOf(failure.payload.message) : "";
    expect(text).toContain(WEB);
    expect(text).toContain("clone failed");
    expect(text).not.toContain(API);
    expect(
      failure?.type === "OrchestratorFailed" && renderMessage(failure.payload.message, "en"),
    ).toContain(`Could not prepare the repository (${WEB}): clone failed`);
    repos.fail = undefined;
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it("候補照合中の一時停止を手動停止として記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], { projects: twoRepos() });
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.spyOn(service, "projectRepositories").mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      throw new Error("listing failed");
    });
    const running = service.runNext(id);
    await started.promise;
    const pausing = service.pause(id);
    gate.resolve();
    await Promise.all([running, pausing]);
    expect(executor.calls).toHaveLength(0);
    const paused = activity
      .forTask(id)
      .filter((event) => event.type === "TaskPaused")
      .at(-1);
    expect(paused?.type === "TaskPaused" && paused.payload.reason).toBe("manual");
    activity.close();
  });

  it("作成後に対象から外れた指定を検出し、再開時に照合し直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = twoRepos();
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" }), out("# 結果")],
      { projects, realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: API }],
      githubAccounts: { "github.com": "me" },
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    expect(failure?.type === "OrchestratorFailed" && textOf(failure.payload.message)).toContain(
      WEB,
    );
    projects.put("default", {
      name: "デフォルト",
      targets: [API, WEB].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls.length).toBeGreaterThan(0);
    activity.close();
  });

  it("旧形式の作業履歴は単数とリポジトリ無しの進め方を保つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    for (const [id, repo] of [
      ["legacy-single", API],
      ["legacy-none", undefined],
    ] as const) {
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: id,
                body: "",
                start: "sacty",
                ...(repo ? { repo } : { noRepo: true }),
                budgetCapUsd: 1,
              },
            },
          },
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: { steps: ["investigate"], plan: "investigate", reason: "調査", costUsd: 0 },
            },
          },
        ],
      });
    }
    const { service, repos } = makeService(activity, [out("# 単数"), out("# 無し")], {
      projects: twoRepos(),
    });
    expect(service.get("legacy-single")?.task).toMatchObject({
      repo: API,
      steps: [{ key: "investigate" }],
    });
    expect(service.get("legacy-none")?.task).toMatchObject({
      noRepo: true,
      steps: [{ key: "investigate" }],
    });
    expect(service.get("legacy-single")?.task.repos).toBeUndefined();
    expect(service.get("legacy-none")?.task.repos).toBeUndefined();
    await service.runNext("legacy-single");
    await service.runNext("legacy-none");
    expect(repos.prepared.map((p) => p.url)).toEqual([`${API}.git`]);
    expect(service.get("legacy-single")?.task.gate?.step).toBe("investigate");
    expect(service.get("legacy-none")?.task.gate?.step).toBe("investigate");
    activity.close();
  });

  it("リポジトリを選ばずに作れる（null・対象が複数で省略）。選んだとき・対象がリポジトリ1つで省略したときは今と同じ", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const omitted = service.createTask({ projectId: "default", title: "A" });
    expect(omitted.repo).toBeUndefined();
    expect(omitted.noRepo).toBe(true);
    const none = service.createTask({ projectId: "default", title: "B", repo: null });
    expect(none).toMatchObject({ noRepo: true, status: "queued" });
    // 選んだときは今と同じ（登録した名前にそろえる・noRepo は付けない）
    const chosen = service.createTask({
      projectId: "default",
      title: "C",
      repo: API.toUpperCase(),
    });
    expect(chosen.repo).toBe(API);
    expect(chosen.noRepo).toBeUndefined();
    // 対象の外のリポジトリは、今と同じく作らない
    expect(() =>
      service.createTask({
        projectId: "default",
        title: "D",
        repo: "https://github.com/tools/secret",
      }),
    ).toThrow(/対象リポジトリを、プロジェクト/);
    activity.close();

    // 対象がリポジトリ1つだけなら、省略するとそれにする（今と同じ）。null なら指定しない
    rmSync(dbPath);
    const single = new SqliteActivityStore(dbPath);
    const { service: one } = makeService(single, []);
    expect(one.createTask({ projectId: "default", title: "E" }).repo).toBe(
      "https://github.com/acme/app",
    );
    expect(one.createTask({ projectId: "default", title: "F", repo: null })).toMatchObject({
      noRepo: true,
    });
    single.close();
  });

  it("作成時に進め方を指定でき、レビューだけは対象リポジトリの PR のリンクがあるときだけ選べる", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const doc = service.createTask({
      projectId: "default",
      title: "手順書",
      repo: API,
      plan: "document",
    });
    expect(doc.requestedPlan).toBe("document");
    expect(activity.forTask(doc.id).find((e) => e.type === "TaskCreated")?.payload).toMatchObject({
      repo: API,
      plan: "document",
    });
    // リポジトリを指定しなくても、コードを変える組み合わせを指定できる（リポジトリはオーケストレーターが選ぶ）
    expect(
      service.createTask({ projectId: "default", title: "直す", repo: null, plan: "direct" }),
    ).toMatchObject({ noRepo: true, requestedPlan: "direct" });
    // 省略すれば、今と同じ（オーケストレーターが選ぶ）
    expect(service.createTask({ projectId: "default", title: "A" }).requestedPlan).toBeUndefined();
    for (const input of [
      { repo: API, body: "" },
      { repo: null, body: `${API}/pull/3` },
      { repo: API, body: `${WEB}/pull/3` },
    ]) {
      expect(() =>
        service.createTask({ projectId: "default", title: "見る", plan: "review", ...input }),
      ).toThrow(/レビューだけ/);
    }
    expect(
      service.createTask({
        projectId: "default",
        title: "見る",
        body: `${API}/pull/3 をレビュー`,
        repo: API,
        plan: "review",
      }).requestedPlan,
    ).toBe("review");
    activity.close();
  });

  it("調べものは、オーケストレーターがプロジェクトのコンテキストと対象を読んで選び、リポジトリ無しのまま進めて完了する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(
      activity,
      [
        // リポジトリの無いタスクでは、テストのコマンド・サービス・ベースブランチは使わない
        plan({
          plan: "investigate",
          testCommand: "npm test",
          baseBranch: "develop",
          services: { file: "compose.yml", names: ["db"], steps: ["investigate"] },
          investigation: "content",
        }),
        out("# 調査の結果"),
      ],
      {
        projects: twoRepos(true),
        realPlanner: true,
        contexts: new FakeContexts({
          "https://github.com/acme/context": { "rules.md": "設計書は docs/ に置く" },
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "認証の仕組みを調べる" });
    await service.runNext(id);
    // オーケストレーターには、コードの代わりにプロジェクトの対象・コンテキストを渡す
    const prompt = promptOf(executor, 0);
    expect(prompt).toContain("このタスクには対象リポジトリがありません");
    expect(prompt).toContain(`- ${API}`);
    expect(prompt).toContain(`- ${WEB}`);
    expect(prompt).toContain(
      "プロジェクトのコンテキストリポジトリ：https://github.com/acme/context",
    );
    expect(prompt).toContain("設計書は docs/ に置く");
    expect(prompt).toContain("design-only");
    expect(prompt).not.toContain("review：");
    // リポジトリは用意しない。作業領域は空（コードの写しを作らない）
    expect(repos.prepared).toEqual([]);
    expect(repos.snapshots).toEqual([]);
    expect(executor.workspaceFiles).toEqual([[], []]);
    expect(promptOf(executor, 1)).toContain(
      "作業領域（カレントディレクトリ）は空で、コードはありません",
    );
    const chosen = chosenOf(activity, id);
    expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
      steps: ["investigate"],
      plan: "investigate",
    });
    expect(chosen?.type === "StepsChosen" && chosen.payload.testCommand).toBeUndefined();
    expect(chosen?.type === "StepsChosen" && chosen.payload.services).toBeUndefined();
    const task = service.get(id)?.task;
    expect(task?.gate).toEqual({ step: "investigate", submission: 1 });
    service.approve(id, { step: "investigate", submission: 1 });
    const done = service.get(id)?.task;
    expect(done && isCompleted(done)).toBe(true);
    expect(done?.repository).toBeUndefined();
    activity.close();
  });

  it("images があっても、リポジトリの無いまま進める工程には、既定のイメージの理由を求めない（PBI-105）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" }), out("# 調査の結果")],
      {
        projects: twoRepos(),
        realPlanner: true,
        config: () => ({
          ok: true,
          config: {
            ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
            images: {
              java: { name: "java", image: "sacty-agent-java:test", description: "Java", env: {} },
            },
          },
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "認証の仕組みを調べる" });
    await service.runNext(id);
    expect(promptOf(executor, 0)).not.toContain("defaultReasons");
    const chosen = chosenOf(activity, id);
    expect(chosen?.type === "StepsChosen" && chosen.payload.steps).toEqual(["investigate"]);
    expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
      "imagesUnexplained",
    );
    expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
      "defaultImageReasons",
    );
    activity.close();
  });

  it("全体の設計は、要求要件・設計を sacty の画面で承認して完了し（PR は作らない）、書き出し先があれば書き出す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const confluence = toPlatform(
      "confluence",
      PlatformFile.parse({
        upstream: "https://wiki.example.com",
        description: "Confluence",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "wiki-token" },
        allow: ["GET /rest/api/content/**", "POST /rest/api/content"],
      }),
    );
    const URL1 = "https://wiki.example.com/pages/9";
    const { service, executor, repos, pulls } = makeService(
      activity,
      [
        plan({
          plan: "design-only",
          exports: {
            requirements: { to: "", reason: "要件は書き出さない" },
            design: { to: "confluence", via: "platform", location: "DEV", reason: "規約" },
          },
        }),
        out("# 要求要件"),
        design,
        out(`書きました\n\n${block({ "sacty-export": { url: URL1 } })}`),
      ],
      {
        projects: twoRepos(),
        realPlanner: true,
        config: configOf(agent(), 1, [confluence]),
        gateway: fakeGateway(),
        secrets: { "claude-oauth-token": "oauth-secret", "wiki-token": "wiki-secret" },
        // PR でのレビュー（PBI-57）が使えるプロジェクトでも、リポジトリの無いタスクは画面で承認する
        stepPullRequests: true,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "全体の設計" });
    await service.runNext(id);
    expect(service.get(id)?.task.gate).toEqual({ step: "requirements", submission: 1 });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.exports.design).toMatchObject({ url: URL1 });
    expect(task && isCompleted(task)).toBe(true);
    expect(task?.stepPullRequests).toEqual([]);
    expect(task?.taskBranch).toBeUndefined();
    expect(pulls.calls).toEqual([]);
    expect(repos.prepared).toEqual([]);
    expect(executor.calls).toHaveLength(4);
    activity.close();
  });

  it("コードの変更が要り分けないなら、オーケストレーターが対象からリポジトリを選び、用意してから工程を選び直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(
      activity,
      [
        plan(
          { plan: "standard", repo: "https://github.com/ACME/web", repoReason: "画面の変更" },
          1000,
        ),
        plan({ plan: "investigate", testCommand: "npm test" }),
        out("# 調査"),
      ],
      { projects: twoRepos(), realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "ボタンの文言を直す" });
    await service.runNext(id);
    const chosen = service.get(id)?.task;
    // 登録した名前にそろえ、選んだ理由と費用を残す。まだ工程は決めない
    expect(chosen?.repo).toBe(WEB);
    expect(chosen?.repoChoice).toEqual({ reason: "画面の変更", by: "orchestrator" });
    expect(chosen?.steps).toEqual([]);
    expect(chosen?.budget.usedUsd).toBeCloseTo(0.015, 6);
    expect(activity.forTask(id).find((e) => e.type === "RepositoryChosen")).toMatchObject({
      actor: "orchestrator",
      payload: { repo: WEB },
    });
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    // 選んだリポジトリを用意して、そのコードを読んで工程を選ぶ（いつもの流れ）
    expect(repos.prepared[0]?.url).toBe(`${WEB}.git`);
    expect(promptOf(executor, 1)).toContain(`対象リポジトリ（${WEB}.git）`);
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    activity.close();
  });

  it("リポジトリを選べなかった・対象に無いリポジトリなら止め、人が対象から選んで再開できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, repos } = makeService(
      activity,
      [
        plan({ plan: "skip-design", repo: "", repoReason: "api と web のどちらか分からない" }),
        plan({ plan: "bugfix", repo: "https://github.com/tools/secret", repoReason: "推測" }),
        plan({ plan: "investigate", testCommand: "npm test" }),
        out("# 調査"),
      ],
      { projects: twoRepos(), realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "不具合を直す" });
    await service.runNext(id);
    let task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    expect(textOf(task?.pausedMessage)).toMatch(
      /作業するリポジトリを決められませんでした：api と web のどちらか分からない/,
    );
    expect(task?.repo).toBeUndefined();
    service.resume(id, {});
    await service.runNext(id);
    task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    // 対象に無い（ほかのプロジェクトが担当する）リポジトリは使わない
    expect(textOf(task?.pausedMessage)).toMatch(
      /リポジトリ（https:\/\/github.com\/tools\/secret）は、プロジェクトの対象にありません/,
    );
    expect(task?.repo).toBeUndefined();
    expect(repos.prepared).toEqual([]);
    // 人が選ぶ。対象に無いものは選べない
    await expect(service.chooseRepository(id, "https://github.com/tools/secret")).rejects.toThrow(
      /プロジェクトの対象にありません/,
    );
    const picked = await service.chooseRepository(id, API);
    expect(picked.repo).toBe(API);
    expect(picked.repoChoice?.by).toBe("person");
    service.resume(id, {});
    await service.runNext(id);
    expect(repos.prepared[0]?.url).toBe(`${API}.git`);
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    // 工程を決めた後は、選び直せない
    await expect(service.chooseRepository(id, WEB)).rejects.toThrow(
      /リポジトリを選べるのは、リポジトリを指定せずに作り/,
    );
    activity.close();
  });

  it("リポジトリを指定したタスクでは、リポジトリを選べない（今と同じ）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const { id } = service.createTask({ projectId: "default", title: "A", repo: API });
    await expect(service.chooseRepository(id, WEB)).rejects.toThrow(/リポジトリを選べるのは/);
    activity.close();
  });

  describe("分割する大きなタスク", () => {
    const splitOutput = (children: unknown[]) =>
      out(`分け方\n\n${block({ "sacty-split": { reason: "リポジトリごとに分ける", children } })}`);
    const children = [
      {
        key: "A",
        title: "API を作る",
        body: "- API",
        dependsOn: [],
        repo: "https://github.com/ACME/API",
        repoReason: "API はこちら",
      },
      {
        key: "B",
        title: "画面を作る",
        body: "- 画面",
        dependsOn: ["A"],
        repo: WEB,
        repoReason: "画面",
      },
    ];
    /** 親は分割（統合レビューまで）、子は調査だけ（承認で完了する）を選ぶ。 */
    const planner = async (task: Task) =>
      task.parent
        ? {
            steps: ["investigate" as const],
            plan: "investigate" as const,
            reason: "子",
            fallback: false,
            costUsd: 0,
            estimated: false,
          }
        : {
            steps: [...STEP_PLANS.split].filter((s) => s !== "investigate"),
            plan: "split" as const,
            reason: "大きいので分ける",
            fallback: false,
            // リポジトリの無いタスクでは使わない
            testCommand: "npm test",
            costUsd: 0,
            estimated: false,
          };
    const integration = out(
      block({
        "sacty-integration-review": {
          viewpoints: [{ id: "TV-1", verified: true, reason: "満たす" }],
          remarks: [],
          findings: [],
          summary: "要求要件を満たす",
        },
      }),
    );

    async function splitParent(outcomes: AgentOutcome[]) {
      const activity = new SqliteActivityStore(dbPath);
      const made = makeService(activity, [out("# 要求要件"), design, ...outcomes], {
        projects: twoRepos(),
        planner,
      });
      const { service } = made;
      const { id } = service.createTask({ projectId: "default", title: "決済をまるごと作る" });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      return { ...made, activity, id };
    }

    it("子タスクごとに対象からリポジトリを付け（理由を残す）、親は統合レビューまで今の流れで進む", async () => {
      const { service, executor, repos, activity, id } = await splitParent([
        splitOutput(children),
        out("# A の調査"),
        out("# B の調査"),
        integration,
      ]);
      // 親はリポジトリを用意しない。分割のエージェントには、子に付けられるリポジトリを渡す
      const splitPrompt = promptOf(executor, 2);
      expect(splitPrompt).toContain(
        "子タスクごとに、作業するリポジトリ（repo）を次の候補から1つ選び",
      );
      expect(splitPrompt).toContain(`- ${API}`);
      expect(splitPrompt).toContain('"repoReason"');
      const parent = service.get(id)?.task;
      expect(parent?.status).toBe("waiting_children");
      expect(parent?.repository).toBeUndefined();
      expect(parent?.testCommand).toBeUndefined();
      const [a, b] = (parent?.split?.children ?? []).map((c) => service.get(c.taskId)?.task);
      // 登録した名前にそろえる。子タスクごとに違うリポジトリでよい
      expect(a).toMatchObject({
        repo: API,
        repoChoice: { reason: "API はこちら", by: "orchestrator" },
      });
      expect(b).toMatchObject({ repo: WEB, repoChoice: { reason: "画面", by: "orchestrator" } });
      expect(parent?.split?.children.map((c) => c.repo)).toEqual([API, WEB]);
      expect(repos.prepared).toEqual([]);

      await service.runNext(a?.id ?? "");
      expect(repos.prepared.map((p) => p.url)).toEqual([`${API}.git`]);
      service.approve(a?.id ?? "", { step: "investigate", submission: 1 });
      await service.runNext(id);
      await service.runNext(b?.id ?? "");
      expect(repos.prepared.map((p) => p.url)).toEqual([`${API}.git`, `${WEB}.git`]);
      service.approve(b?.id ?? "", { step: "investigate", submission: 1 });
      await service.runNext(id);
      expect(service.queuedTaskIds()).toEqual([id]);

      // 統合レビューは、子タスクのリポジトリごとにベースブランチの最新を読む
      await service.runNext(id);
      const review = service.get(id)?.task.integration;
      expect(review?.passed).toBe(true);
      expect(review?.repositories).toEqual([
        { repo: API, baseBranch: "main", commit: "c".repeat(40) },
        { repo: WEB, baseBranch: "main", commit: "c".repeat(40) },
      ]);
      expect(repos.fetchedBranches.map((f) => f.gitDir)).toEqual([
        expect.stringContaining(a?.id ?? "-"),
        expect.stringContaining(b?.id ?? "-"),
      ]);
      expect(executor.workspaceFiles.at(-1)).toEqual(["1-acme__api", "2-acme__web"]);
      // 完了した子タスクの作業領域は消してあるので、統合レビューのために用意し直し、読み終えたらまた消す（PBI-157）
      expect(repos.prepared.map((p) => p.url)).toEqual([
        `${API}.git`,
        `${WEB}.git`,
        `${API}.git`,
        `${WEB}.git`,
      ]);
      await service.workspaceCleanupsSettled();
      for (const child of [a, b]) {
        expect(existsSync(join(dir, "workspaces", child?.id ?? "-"))).toBe(false);
        expect(existsSync(join(dir, "workspaces", "_git", `${child?.id}.git`))).toBe(false);
      }
      const integrationPrompt = promptOf(executor, executor.calls.length - 1);
      expect(integrationPrompt).toContain(`- 1-acme__api/：${API} のベースブランチ（main）`);
      expect(integrationPrompt).toContain(`画面を作る（${WEB}）：完了`);
      expect(service.get(id)?.task.gate?.step).toBe("integrate");
      activity.close();
    });

    it("複数指定では分割の候補を絞り、指定外を断ってから指定内で子を作る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const extra = "https://github.com/acme/extra";
      const projects = twoRepos();
      projects.put("default", {
        name: "デフォルト",
        targets: [API, WEB, extra].map((target) => ({ scope: "repo" as const, target })),
        githubAccounts: { "github.com": "me" },
      });
      const { service, executor } = makeService(
        activity,
        [
          out("# 要求要件"),
          design,
          splitOutput([children[0], { ...children[1], repo: extra }]),
          splitOutput(children),
        ],
        { projects, planner },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "大きい",
        repos: [API, WEB],
      });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      expect(promptOf(executor, 2)).toContain(API);
      expect(promptOf(executor, 2)).toContain(WEB);
      expect(promptOf(executor, 2)).not.toContain(extra);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.get(id)?.task.split).toBeUndefined();
      const failure = activity.forTask(id).find((e) => e.type === "AgentRunFailed");
      expect(failure?.type === "AgentRunFailed" && textOf(failure.payload.message)).toContain(
        extra,
      );
      service.resume(id, {});
      await service.runNext(id);
      const kids = service.get(id)?.task.split?.children ?? [];
      expect(kids.map((c) => c.repo)).toEqual([API, WEB]);
      expect(kids.map((c) => service.get(c.taskId)?.task.repo)).toEqual([API, WEB]);
      activity.close();
    });

    it("複数指定の一部を使い同じリポジトリに複数の子を作る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [out("# 要求要件"), design, splitOutput([children[0], { ...children[1], repo: API }])],
        { projects: twoRepos(), planner },
      );
      const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      const kids = service.get(id)?.task.split?.children ?? [];
      expect(kids.map((child) => child.repo)).toEqual([API, API]);
      expect(kids.map((child) => service.get(child.taskId)?.task.repo)).toEqual([API, API]);
      activity.close();
    });

    it.each(["requirements", "design", "split"] as const)(
      "複数指定の%sで対象から外れたら実行せず再開時に照らし直す",
      async (step) => {
        const activity = new SqliteActivityStore(dbPath);
        const projects = twoRepos();
        const setTargets = (targets: string[]) =>
          projects.put("default", {
            name: "デフォルト",
            targets: targets.map((target) => ({ scope: "repo" as const, target })),
            githubAccounts: { "github.com": "me" },
          });
        const id = "multiple-step";
        activity.append({
          taskId: id,
          projectId: "default",
          events: [
            {
              actor: "person",
              event: {
                type: "TaskCreated",
                payload: {
                  title: "複数",
                  body: "",
                  start: "sacty",
                  noRepo: true,
                  repos: [API, WEB],
                  budgetCapUsd: 1,
                },
              },
            },
            {
              actor: "orchestrator",
              event: {
                type: "StepsChosen",
                payload: {
                  steps: [...STEP_PLANS.split],
                  plan: "split",
                  reason: "分割",
                  costUsd: 0,
                },
              },
            },
          ],
        });
        const { service, executor } = makeService(
          activity,
          [out("# 要求要件"), design, splitOutput(children)],
          { projects, planner },
        );
        if (step !== "requirements") {
          await service.runNext(id);
          service.approve(id, { step: "requirements", submission: 1 });
        }
        if (step === "split") {
          await service.runNext(id);
          service.approve(id, { step: "design", submission: 1 });
        }
        const calls = executor.calls.length;
        const listing = vi
          .spyOn(service, "projectRepositories")
          .mockRejectedValueOnce(new Error("listing failed"));
        await service.runNext(id);
        expect(executor.calls).toHaveLength(calls);
        expect(service.get(id)?.task.status).toBe("paused");
        const listingFailure = activity.forTask(id).find((e) => e.type === "AgentRunFailed");
        expect(
          listingFailure?.type === "AgentRunFailed" && textOf(listingFailure.payload.message),
        ).toContain("listing failed");
        listing.mockRestore();
        service.resume(id, {});
        setTargets([API]);
        await service.runNext(id);
        expect(executor.calls).toHaveLength(calls);
        expect(service.get(id)?.task.status).toBe("paused");
        const failure = activity
          .forTask(id)
          .filter((e) => e.type === "AgentRunFailed")
          .at(-1);
        expect(failure?.type === "AgentRunFailed" && failure.payload.step).toBe(step);
        expect(failure?.type === "AgentRunFailed" && textOf(failure.payload.message)).toContain(
          WEB,
        );
        setTargets([API, WEB]);
        service.resume(id, {});
        await service.runNext(id);
        expect(executor.calls).toHaveLength(calls + 1);
        activity.close();
      },
    );

    it("リポジトリを選んだ後も複数指定から子ごとに選ぶ", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const extra = "https://github.com/acme/extra";
      const projects = twoRepos();
      projects.put("default", {
        name: "デフォルト",
        targets: [API, WEB, extra].map((target) => ({ scope: "repo" as const, target })),
        githubAccounts: { "github.com": "me" },
      });
      const { service, executor, repos } = makeService(
        activity,
        [
          plan({ plan: "standard", repo: API, repoReason: "API" }),
          plan({ plan: "split" }),
          out("# 要求要件"),
          design,
          splitOutput([children[0], { ...children[1], repo: extra }]),
          splitOutput(children),
          plan({ plan: "investigate", investigation: "content" }),
          out("# A"),
          plan({ plan: "investigate", investigation: "content" }),
          out("# B"),
          integration,
        ],
        { projects, realPlanner: true },
      );
      const { id } = service.createTask({ projectId: "default", title: "複数", repos: [API, WEB] });
      await service.runNext(id);
      expect(service.get(id)?.task.repo).toBe(API);
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.get(id)?.task.split).toBeUndefined();
      const failure = activity.forTask(id).find((event) => event.type === "AgentRunFailed");
      expect(failure?.type === "AgentRunFailed" && textOf(failure.payload.message)).toContain(
        extra,
      );
      expect(promptOf(executor, 4)).toContain(WEB);
      expect(promptOf(executor, 4)).not.toContain(extra);
      service.resume(id, {});
      await service.runNext(id);
      const kids = service.get(id)?.task.split?.children ?? [];
      expect(kids.map((c) => c.repo)).toEqual([API, WEB]);
      expect(kids.map((c) => service.get(c.taskId)?.task.repo)).toEqual([API, WEB]);
      for (const child of kids) {
        await service.runNext(child.taskId);
        service.approve(child.taskId, { step: "investigate", submission: 1 });
        await service.runNext(id);
      }
      await service.runNext(id);
      expect(service.get(id)?.task.integration?.repositories.map((r) => r.repo)).toEqual([
        API,
        WEB,
      ]);
      expect(executor.workspaceFiles.at(-1)).toEqual(["1-acme__api", "2-acme__web"]);
      expect(repos.fetchedBranches.length).toBeGreaterThanOrEqual(2);
      activity.close();
    });

    it("子タスクのリポジトリが無い・対象に無いなら使わず、再開すると分割をやり直して選び直す", async () => {
      const { service, activity, id } = await splitParent([
        splitOutput([{ ...children[0], repo: "" }, children[1]]),
        splitOutput([children[0], { ...children[1], repo: "https://github.com/tools/secret" }]),
        splitOutput(children),
      ]);
      const failed = () =>
        activity
          .forTask(id)
          .filter((e) => e.type === "AgentRunFailed")
          .map((e) => (e.type === "AgentRunFailed" ? textOf(e.payload.message) : ""));
      expect(service.get(id)?.task.status).toBe("paused");
      expect(failed()).toEqual([expect.stringMatching(/子タスク「A」にありません/)]);
      expect(service.get(id)?.task.split).toBeUndefined();
      service.resume(id, {});
      await service.runNext(id);
      expect(failed()[1]).toMatch(
        /子タスク「B」に付けたリポジトリ（https:\/\/github.com\/tools\/secret）は、プロジェクトの対象にありません/,
      );
      expect(service.get(id)?.task.split).toBeUndefined();
      service.resume(id, {});
      await service.runNext(id);
      expect(service.get(id)?.task.split?.children.map((c) => c.repo)).toEqual([API, WEB]);
      activity.close();
    });

    it("リポジトリのある親の分割は今と同じ（子は親のリポジトリ。分割案のリポジトリは使わない）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件"), design, splitOutput(children)],
        { projects: twoRepos(), planner },
      );
      const { id } = service.createTask({ projectId: "default", title: "大きい", repo: API });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      expect(promptOf(executor, 2)).not.toContain("作業するリポジトリ（repo）");
      const kids = (service.get(id)?.task.split?.children ?? []).map(
        (c) => service.get(c.taskId)?.task,
      );
      expect(kids.map((k) => k?.repo)).toEqual([API, API]);
      expect(kids.map((k) => k?.repoChoice)).toEqual([undefined, undefined]);
      expect(service.get(id)?.task.split?.children.map((c) => c.repo)).toEqual([
        undefined,
        undefined,
      ]);
      activity.close();
    });
  });

  it("コードが要る工程は、リポジトリの無いまま実行しない（工程の実行の前に止める）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 作業履歴を手で作る：リポジトリの無いタスクに、実装の工程が選ばれていた
    activity.append({
      taskId: "t-norepo",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title: "A", body: "", start: "sacty", noRepo: true, budgetCapUsd: 1 },
          },
        },
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["implement"], testCommand: "npm test", costUsd: 0 },
          },
        },
      ],
    });
    const { service, executor, repos } = makeService(activity, [out("# 実装")]);
    await service.runNext("t-norepo");
    const task = service.get("t-norepo")?.task;
    expect(task?.status).toBe("paused");
    const failed = activity.forTask("t-norepo").find((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toMatch(
      /工程（implement）には対象リポジトリが要ります/,
    );
    expect(executor.calls).toHaveLength(0);
    expect(repos.prepared).toEqual([]);
    activity.close();
  });

  it("API でも、リポジトリを選ばずに作り、人がリポジトリを選べる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [plan({ plan: "standard", repo: "", repoReason: "分からない" })],
      { projects: twoRepos(), realPlanner: true },
    );
    const token = "test-token";
    const json = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const app = createApp(service, token);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ projectId: "default", title: "API から", repo: null }),
    });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: Task };
    expect(task.noRepo).toBe(true);
    await service.runNext(task.id);
    const bad = await app.request(`/api/tasks/${task.id}/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ repo: "https://github.com/tools/secret" }),
    });
    expect(bad.status).toBe(409);
    const ok = await app.request(`/api/tasks/${task.id}/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ repo: WEB }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { task: Task }).task.repo).toBe(WEB);
    activity.close();
  });
});

describe("リポジトリを指定しないタスクのリポジトリの選び直し（PBI-73 レビュー指摘）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const plan = (v: Record<string, unknown>) =>
    out(`\`\`\`json\n${JSON.stringify({ "sacty-steps": { reason: "理由", ...v } })}\n\`\`\``);
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  const twoRepos = () => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: API },
        { scope: "repo", target: WEB },
      ],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };

  it("オーケストレーターが選んだリポジトリを用意できなければ止まり、人が別のリポジトリを選び直して再開できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    const { service } = makeService(
      activity,
      [
        plan({ plan: "standard", repo: API, repoReason: "API" }),
        plan({ plan: "investigate", testCommand: "npm test" }),
        out("# 調査"),
      ],
      { projects: twoRepos(), realPlanner: true, repos },
    );
    const { id } = service.createTask({ projectId: "default", title: "直す" });
    await service.runNext(id);
    expect(service.get(id)?.task.repo).toBe(API);
    repos.fail = "Repository not found";
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.repository).toBeUndefined();
    repos.fail = undefined;
    const picked = await service.chooseRepository(id, WEB);
    expect(picked).toMatchObject({ repo: WEB, repoChoice: { by: "person" } });
    service.resume(id, {});
    await service.runNext(id);
    expect(repos.prepared.map((p) => p.url)).toEqual([`${WEB}.git`]);
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    activity.close();
  });

  it("止まっていないタスクでは、人はリポジトリを選べない（オーケストレーターの選択とぶつけない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos(), realPlanner: true });
    const { id } = service.createTask({ projectId: "default", title: "直す" });
    expect(service.get(id)?.task.status).toBe("queued");
    await expect(service.chooseRepository(id, WEB)).rejects.toThrow(/止まっているタスクだけ/);
    expect(service.get(id)?.task.repo).toBeUndefined();
    activity.close();
  });
});
