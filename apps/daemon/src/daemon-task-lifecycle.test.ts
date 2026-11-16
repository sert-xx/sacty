import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "@sacty/core";
import {
  awaitingTicketTriage,
  canDecideTests,
  DERIVE_RECORD_HEADING,
  isCompleted,
  isRepoless,
  message,
  RERUN_RECORD_HEADING,
  RESUME_NOTE_HEADING,
  renderMessage,
  rerunEditableBody,
  resumeNoteRoom,
  TASK_BODY_MAX,
} from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { agentFor, type ConfigResult, type SactyConfig } from "./config.js";
import { MemoryProjectStore } from "./projects.js";
import { createApp } from "./server.js";
import { InvalidOperationError, type ServiceDeps, TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  appendLegacy,
  completed,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  FakePulls,
  FakeRepos,
  FakeTickets,
  fakeGateway,
  foundTicket,
  ja,
  jiraPlatform,
  makeService,
  projectsWithAccount,
  stepReview,
  triageOut,
  useTempDir,
} from "./testing/daemon.js";
import { removeEntry } from "./workspace-cleanup.js";

useTempDir();

describe("テストの仕組みが無いリポジトリ（PBI-94）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const NO_TESTS = "README.md だけで、テストのコード・設定・CI が無い";
  const plan = (extra: Record<string, unknown> = {}, value = "skip-design") =>
    out(block({ "sacty-steps": { plan: value, reason: "小さい", noTests: NO_TESTS, ...extra } }));
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const typesOf = (service: TaskService, id: string) =>
    service.get(id)?.activity.map((e) => e.type) ?? [];
  const taskOf = (service: TaskService, id: string) => service.get(id)?.task as Task;

  /** clone した作業領域に、ファイルを置く偽のリポジトリ（起点のコード）。 */
  class FilesRepos extends FakeRepos {
    constructor(private readonly files: Record<string, string>) {
      super();
    }
    override async prepare(...args: Parameters<FakeRepos["prepare"]>) {
      const result = await super.prepare(...args);
      for (const [path, content] of Object.entries(this.files)) {
        mkdirSync(dirname(join(args[0], path)), { recursive: true });
        writeFileSync(join(args[0], path), content);
      }
      return result;
    }
  }

  async function drain(service: TaskService, max = 12) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  it("README だけのリポジトリで Sacty セットアップを実行すると、止まらずに実装の承認待ちまで進み、テストで検証していないことがわかる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, pulls } = makeService(
      activity,
      [
        plan(),
        out("# 要求要件\n\n- AGENTS.md を足す"),
        out("# 実装の説明\n\n- AGENTS.md を足した"),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ template: "sacty-setup", projectId: "default" });
    await service.runNext(id);
    // テストの仕組みが無いと判断した理由を台帳に残し、止めずに工程を進める
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.noTestsReason).toBe(NO_TESTS);
    expect(chosen?.type === "StepsChosen" && chosen.payload.testCommand).toBeUndefined();
    expect(taskOf(service, id).noTestsReason).toBe(NO_TESTS);
    // オーケストレーターには、テストの仕組みが無いときの答え方を伝える
    expect(promptOf(executor, 0)).toContain("noTests");
    await drain(service);
    expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    // テストは実行せず、最終レビューもせずに、実装の承認待ちになる
    expect(typesOf(service, id)).not.toContain("TestsRun");
    expect(typesOf(service, id)).toContain("FinalReviewSkipped");
    expect(task.lastReview).toBeUndefined();
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    expect(task.status).toBe("awaiting_approval");
    // 実装の指示は、テストを書かせず、目的から判定されることを伝える
    const implementPrompt = promptOf(executor, 2);
    expect(implementPrompt).toContain("このリポジトリには、テストの仕組みがありません");
    expect(implementPrompt).toContain("sacty-test-command");
    expect(executor.calls).toHaveLength(3);
    // PR の本文で、テストで検証していないことがわかる
    expect(pulls.calls).toHaveLength(1);
    const body = pulls.calls[0]?.body ?? "";
    expect(body).toContain(
      "テスト：テストの仕組みが無いリポジトリとして進めたため、テストでは検証していません。",
    );
    expect(body).toContain(`テストの仕組みが無いと判断した根拠（オーケストレーター）：${NO_TESTS}`);
    expect(body).toContain("（テストなし。目的から確認）");
    // 人の承認は今どおり要る
    expect(isCompleted(task)).toBe(false);
    activity.close();
  });

  it("テストのファイルがあるのにテストの仕組みが無いと答えたら、テストの無いタスクとして記録しない。sacty はテストを実行しないので、止めずに進める（PBI-336）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [plan(), out("# 要求要件")], {
      realPlanner: true,
      repos: new FilesRepos({ "README.md": "# app", "src/pay.test.js": "test()" }),
    });
    const { id } = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(id);
    const task = taskOf(service, id);
    expect(task.status).not.toBe("paused");
    expect(task.pausedMessage).toBeUndefined();
    // 判断を使えないので、テストの無いタスクとして記録しない
    expect(task.noTestsReason).toBeUndefined();
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.noTestsReason).toBeUndefined();
    // オーケストレーターの後に、要求要件の工程へ進む
    expect(executor.calls).toHaveLength(2);
    expect(task.gate).toEqual({ step: "requirements", submission: 1 });
    activity.close();
  });

  describe("文書だけの依頼（PBI-284）", () => {
    const DOCS_ONLY = "文書だけの依頼で、文書向けの検証（リンクの検査・markdown の lint）が無い";
    const docsPlan = (extra: Record<string, unknown> = {}) =>
      plan({ noTests: DOCS_ONLY, documentsOnly: true, ...extra });
    /** 起点のコードにテストのファイルがあるリポジトリ。差分は、指定したパスにする。 */
    const reposWith = (changed: string[]) => {
      const repos = new FilesRepos({ "README.md": "# app", "src/pay.test.js": "test()" });
      repos.changes = changed.map((path) => ({ path, added: 1, removed: 0 }));
      return repos;
    };
    const implemented = out("# 実装の説明\n\n- 文書を足した");

    it("テストのファイルがあるリポジトリでも、noTests と documentsOnly を答えれば、テストの無いタスクとして承認待ちへ進む", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [docsPlan(), out("# 要求要件\n\n- 文書を足す"), implemented],
        { realPlanner: true, repos: reposWith(["docs/guide.md", "README.md"]) },
      );
      const { id } = service.createTask({ projectId: "default", title: "文書を足す" });
      await service.runNext(id);
      const task = taskOf(service, id);
      // 矛盾の判定で止まらず、テストなしの理由と、文書だけの依頼であることを記録する
      expect(task.status).not.toBe("paused");
      expect(task.noTestsReason).toBe(DOCS_ONLY);
      expect(task.documentsOnly).toBe(true);
      expect(task.testCommand).toBeUndefined();
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.documentsOnly).toBe(true);
      // オーケストレーターには、文書だけの依頼の答え方を伝える
      const prompt = promptOf(executor, 0);
      expect(prompt).toContain("documentsOnly");
      await drain(service);
      service.approve(id, { step: "requirements", submission: 1 });
      await drain(service);
      const done = taskOf(service, id);
      expect(typesOf(service, id)).not.toContain("TestsRun");
      expect(typesOf(service, id)).toContain("FinalReviewSkipped");
      expect(done.lastReview).toBeUndefined();
      expect(done.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("documentsOnly が無ければ、同じ答えでもテストのファイルがあれば、テストの無い判断を記録しない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [plan({ noTests: DOCS_ONLY }), out("# 要求要件")], {
        realPlanner: true,
        repos: reposWith(["README.md"]),
      });
      const { id } = service.createTask({ projectId: "default", title: "文書を足す" });
      await service.runNext(id);
      const task = taskOf(service, id);
      expect(task.status).not.toBe("paused");
      expect(task.noTestsReason).toBeUndefined();
      expect(task.documentsOnly).toBeUndefined();
      activity.close();
    });

    it("不具合の修正（再現の工程がある）では documentsOnly を使わず、テストの無い判断も記録しない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [plan({ noTests: DOCS_ONLY, documentsOnly: true, investigation: "bug" }, "bugfix")],
        { realPlanner: true, repos: reposWith(["README.md"]) },
      );
      const { id } = service.createTask({ projectId: "default", title: "不具合" });
      await service.runNext(id);
      const task = taskOf(service, id);
      expect(task.pausedMessage?.code).not.toBe("orchestrator.bugfixNeedsTests");
      expect(task.noTestsReason).toBeUndefined();
      expect(task.documentsOnly).toBeUndefined();
      activity.close();
    });
  });

  it("テストが決まらずに止まったタスク（以前の版）は、テストなしで進めると決めて再開でき、実装の指示と PR の本文で人が決めた理由だとわかる。人が止めただけなら決められない（PBI-337）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const REASON =
      "スキルを集めたリポジトリで、テストは書かない（scripts/test_helper.sh はテストではない）";
    const { service, executor, pulls } = makeService(
      activity,
      [plan(), out("# 要求要件\n\n- スキルを足す"), out("# 実装の説明\n\n- スキルを足した")],
      {
        realPlanner: true,
        repos: new FilesRepos({ "README.md": "# skills", "scripts/test_helper.sh": "echo" }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "スキルを足す" });
    await service.runNext(id);
    // テストのファイルがあるので、テストの仕組みが無いという判断は使わない。テストは決まらないまま進む
    expect(taskOf(service, id).noTestsReason).toBeUndefined();
    expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
    service.approve(id, { step: "requirements", submission: 1 });
    // 人が止めただけなら、テストが決まっていなくても、テストの扱いは決められない（PBI-337）
    await service.pause(id);
    expect(canDecideTests(taskOf(service, id))).toBe(false);
    expect(() => service.resume(id, { tests: { noTestsReason: REASON } })).toThrow(
      InvalidOperationError,
    );
    expect(typesOf(service, id)).not.toContain("TestsDecided");
    service.resume(id, {});
    // 以前の版で、テストが決まらないことを理由に止めた記録
    appendLegacy(service, id, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: {
            reason: "error",
            message: message("orchestrator.noTestsUncertain", { reason: "テストが無い" }),
          },
        },
      },
    ]);
    expect(canDecideTests(taskOf(service, id))).toBe(true);
    service.resume(id, { tests: { noTestsReason: REASON } });
    // 人の判断を記録し、工程は選び直さない（オーケストレーターをもう一度実行しない）
    const decided = service.get(id)?.activity.find((e) => e.type === "TestsDecided");
    expect(decided?.actor).toBe("person");
    expect(decided?.type === "TestsDecided" && decided.payload).toEqual({ noTestsReason: REASON });
    expect(taskOf(service, id).noTestsReason).toBe(REASON);
    expect(taskOf(service, id).testsDecidedBy).toBe("person");
    await drain(service);
    const task = taskOf(service, id);
    expect(typesOf(service, id).filter((t) => t === "StepsChosen")).toHaveLength(1);
    expect(typesOf(service, id)).not.toContain("TestsRun");
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    // 実装の指示と PR の本文で、人が決めた理由だとわかる
    expect(promptOf(executor, 2)).toContain("人が再開のときにテストなしで進めると決めました");
    expect(pulls.calls[0]?.body).toContain(`テストなしで進める理由（人が決めました）：${REASON}`);
    activity.close();
  });

  it("テストが決まらずに止まったタスク（以前の版）は、テストのコマンドを指定して再開でき、実装の指示で人が指定したコマンドだとわかる（PBI-337）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out(block({ "sacty-steps": { plan: "skip-design", reason: "小さい" } })),
        out("# 要求要件"),
        out(
          `# 実装の説明\n\n${block({ "sacty-test-map": [{ viewpointId: "REQ", tests: ["check › a"] }] })}`,
        ),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "直す" });
    await service.runNext(id);
    // テストのコマンドが分からなくても止めない（sacty はテストを実行しない）
    expect(taskOf(service, id).pausedMessage).toBeUndefined();
    service.approve(id, { step: "requirements", submission: 1 });
    // 以前の版で、テストのコマンドが決まらないことを理由に止めた記録
    appendLegacy(service, id, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: { reason: "error", message: message("orchestrator.testCommandUnknown") },
        },
      },
    ]);
    service.resume(id, { tests: { testCommand: "make test" } });
    expect(taskOf(service, id).testCommand).toBe("make test");
    await drain(service);
    expect(executor.calls).toHaveLength(3);
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 1 });
    // 実装の指示で、人が指定したコマンドだとわかる
    expect(promptOf(executor, 2)).toContain(
      "人が再開のときに指定したテストのコマンド（make test）",
    );
    activity.close();
  });

  it("テストの扱いは、テストが決まらずに止まったタスクでだけ指定でき、不具合の修正はテストなしにできない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [plan({ investigation: "bug" }, "bugfix")], {
      realPlanner: true,
      repos: new FilesRepos({ "README.md": "# app" }),
    });
    const bug = service.createTask({ projectId: "default", title: "不具合" });
    await service.runNext(bug.id);
    // テストが決まらないこと以外で止まったタスクは、テストの扱いを決められない（PBI-337）
    expect(taskOf(service, bug.id).status).toBe("paused");
    expect(() => service.resume(bug.id, { tests: { testCommand: "make test" } })).toThrow(
      expect.objectContaining({ messages: [{ code: "resume.testsNotUndecided" }] }),
    );
    service.resume(bug.id, {});
    // 以前の版で、不具合の修正にテストが要るとして止めた記録
    appendLegacy(service, bug.id, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: {
            reason: "error",
            message: message("orchestrator.bugfixNeedsTests", { reason: "テストは無い" }),
          },
        },
      },
    ]);
    expect(() => service.resume(bug.id, { tests: { noTestsReason: "テストは無い" } })).toThrow(
      expect.objectContaining({ messages: [{ code: "resume.bugfixNeedsTestCommand" }] }),
    );
    expect(taskOf(service, bug.id).status).toBe("paused");
    // テストのコマンドなら指定できる
    service.resume(bug.id, { tests: { testCommand: "make test" } });
    expect(taskOf(service, bug.id).testCommand).toBe("make test");
    // テストが決まらずに止まったのではないタスク（工程を選ぶ前に人が止めた）は、テストの扱いを受け付けない
    const ok = service.createTask({ projectId: "default", title: "ふつう" });
    await service.pause(ok.id);
    expect(taskOf(service, ok.id).status).toBe("paused");
    expect(() => service.resume(ok.id, { tests: { testCommand: "npm test" } })).toThrow(
      expect.objectContaining({ messages: [{ code: "resume.testsNotUndecided" }] }),
    );
    // テストのコマンドと理由の両方は渡せない
    expect(() =>
      service.resume(ok.id, { tests: { testCommand: "npm test", noTestsReason: "x" } }),
    ).toThrow();
    activity.close();
  });

  it("申告を読むのはテストの仕組みが無いタスクの実装だけ。ほかの工程やテストのあるタスクでは、コードブロックを本文に残す（PR #105 再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const example = '```sacty-test-command\n{"command":"make test",}\n```';
    const { service } = makeService(
      activity,
      [
        out(`# 要求要件\n\n申告の例：\n\n${example}`),
        out(
          `# 実装の説明\n\n${example}\n\n${block({ "sacty-test-map": [{ viewpointId: "REQ", tests: ["a.test › a"] }] })}`,
        ),
      ],
      {
        planner: async () => ({
          steps: ["requirements", "implement"],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストのあるタスク" });
    await drain(service);
    // 要求要件の本文から、例が消えない
    expect(taskOf(service, id).outputs.requirements).toContain(example);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    // テストのあるタスクの実装では、申告として扱わない（止めず、本文にも残し、決めたテストのコマンドで検証する）
    expect(task.pausedMessage).toBeUndefined();
    expect(task.outputs.implement).toContain(example);
    expect(task.addedTestCommand).toBeUndefined();
    expect(task.testCommand).toBe("npm test");
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    activity.close();
  });

  it("テストの仕組みが無いタスクでも、要求要件・設計の本文の申告の例は取り除かず、申告として扱わない（PR #105 再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const example = '```sacty-test-command\n{"command":"make test",}\n```';
    const { service } = makeService(
      activity,
      [
        plan({}, "standard"),
        out(`# 要求要件\n\n申告の例：\n\n${example}`),
        // 要求要件の承認の後にも、設計が要るかを見直す（工程の見直し）
        stepReview(),
        out(
          `# 設計\n\n申告の例：\n\n${example}\n\n${block({
            "sacty-test-viewpoints": [{ title: "指示がある", input: "読む", expected: "ある" }],
          })}`,
        ),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "設計する" });
    await drain(service);
    expect(taskOf(service, id).noTestsReason).toBe(NO_TESTS);
    expect(taskOf(service, id).outputs.requirements).toContain(example);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    // 設計の本文にも残り、止まらずに設計の承認待ちになる
    expect(task.outputs.design).toContain(example);
    expect(task.pausedMessage).toBeUndefined();
    expect(task.gate).toEqual({ step: "design", submission: 1 });
    activity.close();
  });

  it("テストのコマンドもテストの仕組みが無いという答えも無くても止めない。テストのコマンドがあればテストの無い判断は捨てる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        out(block({ "sacty-steps": { plan: "skip-design", reason: "小さい" } })),
        out("# 要求要件 A"),
        plan({ testCommand: "make test" }),
        out("# 要求要件 B"),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    expect(taskOf(service, a.id).pausedMessage).toBeUndefined();
    expect(taskOf(service, a.id).status).not.toBe("paused");
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    const task = taskOf(service, b.id);
    expect(task.testCommand).toBe("make test");
    expect(task.noTestsReason).toBeUndefined();
    expect(task.pausedMessage).toBeUndefined();
    activity.close();
  });

  it("テストの仕組みが無いのに不具合の修正を選んだら、テストの無いタスクとして扱わない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [plan({ investigation: "bug" }, "bugfix")], {
      realPlanner: true,
      repos: new FilesRepos({ "README.md": "# app" }),
    });
    const { id } = service.createTask({ projectId: "default", title: "不具合" });
    await service.runNext(id);
    const task = taskOf(service, id);
    expect(task.pausedMessage?.code).not.toBe("orchestrator.bugfixNeedsTests");
    expect(task.noTestsReason).toBeUndefined();
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.noTestsReason).toBeUndefined();
    activity.close();
  });

  it("実装がテストの仕組みを用意して申告したら、そのコマンドを記録し、申告のブロックは説明に残さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        plan(),
        out("# 要求要件\n\n- テストの仕組みを用意する"),
        out(
          `# 実装の説明\n\n\`\`\`sacty-test-command\n${JSON.stringify({ command: "make test" })}\n\`\`\``,
        ),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストを用意する" });
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    expect(task.addedTestCommand).toBe("make test");
    // 申告のブロックは、実装の説明に残さない
    expect(task.outputs.implement).not.toContain("sacty-test-command");
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    activity.close();
  });

  it("以前の版で、実装が申告したテストのコマンドのツールがイメージに無くて止まったタスクは、再開のときの「テストの扱い」を案内しない（PBI-158）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        plan(),
        out("# 要求要件\n\n- テストの仕組みを用意する"),
        out(
          `# 実装の説明\n\n\`\`\`sacty-test-command\n${JSON.stringify({ command: "make test" })}\n\`\`\``,
        ),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストを用意する" });
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id); // 実装
    // 以前の版の最終レビューが、ツールが無くて止めた記録
    appendLegacy(service, id, [
      {
        actor: "sacty",
        event: {
          type: "TaskPaused",
          payload: {
            reason: "error",
            message: message("verify.commandMissing", {
              commands: ["make"],
              image: "default",
              step: "implement",
            }),
          },
        },
      },
    ]);
    const task = taskOf(service, id);
    expect(task.noTestsReason).toBe(NO_TESTS);
    expect(task.addedTestCommand).toBe("make test");
    expect(task.status).toBe("paused");
    // 決め直す欄は出ないので、案内しない（イメージを直す案内だけ）
    expect(canDecideTests(task)).toBe(false);
    expect(ja(task.pausedMessage)).not.toContain("「テストの扱い」");
    expect(ja(task.pausedMessage)).toContain("make");
    activity.close();
  });

  it("実装のテストのコマンドの申告の形が正しくなければ、テストを飛ばさずに止め、再開すると実装をやり直す（PR #105 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        plan(),
        out("# 要求要件"),
        out('# 実装の説明\n\n```sacty-test-command\n{"command": ""}\n```'),
        // JSON として読めない申告も、テストを飛ばさずに止める（PR #105 再レビュー指摘）
        out('# 実装の説明\n\n```sacty-test-command\n{"command" "make test"}\n```'),
        out('# 実装の説明\n\n```sacty-test-command\n{"command": "make test"}\n```'),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストを用意する" });
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const paused = taskOf(service, id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedMessage).toEqual({ code: "implement.testCommandInvalid" });
    expect(typesOf(service, id)).not.toContain("FinalReviewed");
    // 再開すると実装をやり直す。読めない申告でも止まる
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).pausedMessage).toEqual({ code: "implement.testCommandInvalid" });
    expect(typesOf(service, id)).not.toContain("FinalReviewed");
    // もう一度再開すると、正しい申告のコマンドを記録して、実装の承認待ちへ進む
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).addedTestCommand).toBe("make test");
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 1 });
    activity.close();
  });
});

describe("タスクのテンプレート「Sacty セットアップ」（PBI-90）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
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
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/tools/secret" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };
  const isZod = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof Error && error.name === "ZodError";
    }
    return false;
  };

  it("リポジトリだけで作り、題と説明（ゴール）は sacty が決め、テンプレートを記録する（再起動の後も残る）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const task = service.createTask({
      template: "sacty-setup",
      projectId: "default",
      repo: API.toUpperCase(),
    });
    // 通常のタスクと同じく、画面で作ったタスクとして実行待ちになる。リポジトリは登録した名前にそろえる
    expect(task).toMatchObject({
      template: "sacty-setup",
      start: "sacty",
      repo: API,
      status: "queued",
      title: "Sacty セットアップ（acme/api）",
    });
    expect(task.noRepo).toBeUndefined();
    // ゴール：エージェント向けの指示・テストの実行の仕方・テストに要るサービス・デプロイの確認のスキル
    // URL は行の末尾に置く（画面の Markdown で、後ろの文字までリンクにしない）
    expect(task.body).toContain(`- 対象のリポジトリ：${API}\n`);
    expect(task.body).toContain("AGENTS.md・CLAUDE.md");
    expect(task.body).toContain("テストの実行の仕方");
    expect(task.body).toContain("テストに要るサービス");
    // デプロイの確認のスキルは、マージの後の監視（PBI-89）が探す置き場所・名前・答えの形に合わせる
    expect(task.body).toContain(".agents/skills/deployment-observer/SKILL.md");
    expect(task.body).toContain(".claude/skills/deployment-observer");
    expect(task.body).toContain("../../.agents/skills/deployment-observer");
    expect(task.body).toContain("name: deployment-observer");
    expect(task.body).toContain(
      '{"sacty-deployment": {"ci": {"result": "passed | failed | skipped | unknown"',
    );
    expect(task.body).toContain(".agents/skills/deployment-observer/references/ci.md");
    // 変更が要らなければ、PR を作らずに検査の結果を残して終える
    expect(task.body).toContain("PR を作らずに");
    const created = activity.forTask(task.id).find((e) => e.type === "TaskCreated");
    expect(created?.payload).toMatchObject({ template: "sacty-setup", repo: API });
    // 作業履歴から復元しても、テンプレートで作ったことが残る
    const { service: restarted } = makeService(activity, [], { projects: twoRepos() });
    expect(restarted.get(task.id)?.task.template).toBe("sacty-setup");
    // 通常のタスクには、テンプレートは付かない
    expect(
      service.createTask({ projectId: "default", title: "A", repo: API }).template,
    ).toBeUndefined();
    activity.close();
  });

  it("ゴールは、特定の言語・ツール・sacty 自身に寄せない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    const { body } = service.createTask({ template: "sacty-setup", projectId: "default" });
    for (const word of [
      "npm",
      "Node",
      "node_modules",
      "package.json",
      "vitest",
      "TypeScript",
      "Python",
      "pytest",
      "Maven",
      "Gradle",
      "GitHub Actions",
      "sacty リポジトリ",
    ]) {
      expect(body, word).not.toContain(word);
    }
    activity.close();
  });

  it("リポジトリは必須（対象がリポジトリ1つだけなら省略できる）。題・説明・null・対象の外・知らないテンプレートは受け付けない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    // 対象が複数で省略したら、理由を返して作らない
    expect(() => service.createTask({ template: "sacty-setup", projectId: "default" })).toThrow(
      /このテンプレートでは、対象リポジトリを選んでください/,
    );
    expect(
      isZod(() =>
        service.createTask({ template: "sacty-setup", projectId: "default", repo: "  " }),
      ),
    ).toBe(true);
    expect(
      isZod(() =>
        service.createTask({ template: "sacty-setup", projectId: "default", repo: null }),
      ),
    ).toBe(true);
    // 題・説明は sacty が決めるので、渡せば誤り
    expect(
      isZod(() =>
        service.createTask({
          template: "sacty-setup",
          projectId: "default",
          repo: API,
          title: "X",
        }),
      ),
    ).toBe(true);
    expect(
      isZod(() =>
        service.createTask({ template: "sacty-setup", projectId: "default", repo: API, body: "" }),
      ),
    ).toBe(true);
    expect(
      isZod(() => service.createTask({ template: "unknown", projectId: "default", repo: API })),
    ).toBe(true);
    expect(
      isZod(() =>
        service.createTask({ template: "", projectId: "default", title: "A", repo: API }),
      ),
    ).toBe(true);
    // 対象の外（ほかのプロジェクトのリポジトリ・URL でないもの）は作らない
    expect(() =>
      service.createTask({
        template: "sacty-setup",
        projectId: "default",
        repo: "https://github.com/tools/secret",
      }),
    ).toThrow(/対象リポジトリを、プロジェクト/);
    expect(() =>
      service.createTask({ template: "sacty-setup", projectId: "default", repo: "acme/api" }),
    ).toThrow(/対象リポジトリを、プロジェクト/);
    expect(() =>
      service.createTask({ template: "sacty-setup", projectId: "missing", repo: API }),
    ).toThrow(/プロジェクトが見つかりません/);
    expect(service.list()).toEqual([]);
    activity.close();

    // 対象がリポジトリ1つだけなら、省略するとそれにする
    rmSync(dbPath);
    const single = new SqliteActivityStore(dbPath);
    const { service: one } = makeService(single, []);
    expect(one.createTask({ template: "sacty-setup", projectId: "default" }).repo).toBe(
      "https://github.com/acme/app",
    );
    single.close();

    // 対象が Org なら、その Org のリポジトリを選べる（省略はできない）
    rmSync(dbPath);
    const org = new SqliteActivityStore(dbPath);
    const orgProjects = projectsWithAccount();
    orgProjects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
      githubAccounts: { "github.com": "me" },
    });
    const { service: byOrg } = makeService(org, [], { projects: orgProjects });
    expect(() => byOrg.createTask({ template: "sacty-setup", projectId: "default" })).toThrow(
      /このテンプレートでは、対象リポジトリを選んでください/,
    );
    expect(
      byOrg.createTask({ template: "sacty-setup", projectId: "default", repo: `${API}.git` }).repo,
    ).toBe(API);
    org.close();
  });

  it("通常のタスクと同じく、オーケストレーターがリポジトリを読んで工程を選ぶ。整っていれば調査だけで終え、PR を作らない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, pulls } = makeService(
      activity,
      [
        out(
          block({
            "sacty-steps": {
              plan: "investigate",
              reason: "設定は整っていて、変更は要らない",
              testCommand: "make test",
            },
          }),
        ),
        out("# 検査の結果\n\n- AGENTS.md：ある"),
      ],
      { realPlanner: true },
    );
    const { id } = service.createTask({ template: "sacty-setup", projectId: "default" });
    await service.runNext(id);
    // オーケストレーターにも、調査のエージェントにも、ゴールが渡る
    expect(promptOf(executor, 0)).toContain("あなたはオーケストレーターです");
    expect(promptOf(executor, 0)).toContain(".agents/skills/deployment-observer/SKILL.md");
    expect(promptOf(executor, 1)).toContain("あなたはソフトウェア開発の調査エージェントです");
    expect(promptOf(executor, 1)).toContain(".agents/skills/deployment-observer/SKILL.md");
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    const done = service.approve(id, { step: "investigate", submission: 1 });
    expect(isCompleted(done)).toBe(true);
    // 検査の結果が残り、PR は作らない
    expect(done.approved.investigate?.output).toContain("# 検査の結果");
    expect(done.template).toBe("sacty-setup");
    expect(pulls.calls).toEqual([]);
    activity.close();
  });

  it("API でも、テンプレートで作れる。題・説明・知らないテンプレートは400、リポジトリを選んでいなければ409", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const token = "test-token";
    const app = createApp(makeService(activity, [], { projects: twoRepos() }).service, token);
    const auth = { authorization: `Bearer ${token}` };
    const post = (body: unknown) =>
      app.request("/api/tasks", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await post({ template: "sacty-setup", projectId: "default", repo: WEB });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: Task };
    expect(task).toMatchObject({ template: "sacty-setup", repo: WEB });
    const detail = (await (
      await app.request(`/api/tasks/${task.id}`, { headers: auth })
    ).json()) as { task: Task; activity: { type: string; payload: { template?: string } }[] };
    expect(detail.task.template).toBe("sacty-setup");
    expect(detail.activity[0]?.payload.template).toBe("sacty-setup");
    expect(
      (await post({ template: "sacty-setup", projectId: "default", repo: WEB, title: "X" })).status,
    ).toBe(400);
    expect((await post({ template: "nope", projectId: "default", repo: WEB })).status).toBe(400);
    const missing = await post({ template: "sacty-setup", projectId: "default" });
    expect(missing.status).toBe(409);
    activity.close();
  });
});

describe("中止したタスクの再実行", () => {
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const java = {
    name: "java",
    image: "sacty-agent-java:test",
    description: "Java 17・Maven",
    baseImage: "registry.example.com/ci/java:17",
  };
  const withImages = (): (() => ConfigResult) => () => ({
    ok: true,
    config: {
      ...(configOf(agent(), 1, [jiraPlatform()])() as { ok: true; config: SactyConfig }).config,
      images: { java },
    },
  });
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
    return store;
  };
  const setup = (outcomes: AgentOutcome[] = []) => {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, outcomes, {
      config: withImages(),
      secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
      gateway: fakeGateway(),
      projects: projects(),
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    return { activity, ...made };
  };

  it("再実行で作ったタスクの再開の補足は、前の試行の記録の前に入れ、上限は記録を数えずに確かめる", async () => {
    const taskOf = (id: string) => service.get(id)?.task as Task;
    const { activity, service } = setup([
      {
        kind: "completed",
        output: `# 要求要件\n\n${"あ".repeat(6_000)}`,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
      },
      { kind: "failed", reason: "error", message: "失敗" },
    ]);
    const task = service.createTask({
      projectId: "default",
      title: "決済の再送",
      body: "二重に請求される",
      repo: "https://github.com/acme/app",
    });
    await service.runNext(task.id); // 要求要件（長い成果）
    await service.cancel(task.id);
    const rerun = service.rerunTask(task.id, {
      title: "決済の再送",
      body: "二重に請求される",
      repo: "https://github.com/acme/app",
    });
    await service.runNext(rerun.id);
    expect(service.get(rerun.id)?.task.status).toBe("paused");
    const record = service.get(rerun.id)?.task.body ?? "";
    expect(record.length).toBeGreaterThan(3_000);
    // 直せる部分（説明と補足）は上限を超えないが、記録を合わせると超える補足は受け付ける
    const room = resumeNoteRoom(taskOf(rerun.id));
    // 前の試行の記録は数えない（数えると、残りは記録の分だけ短くなる）
    expect(room).toBe(
      TASK_BODY_MAX - `${rerunEditableBody(taskOf(rerun.id))}\n\n${RESUME_NOTE_HEADING}\n\n`.length,
    );
    expect(room).toBeGreaterThan(TASK_BODY_MAX - record.length);
    expect(() => service.resume(rerun.id, { note: "あ".repeat(room + 1) })).toThrow(
      expect.objectContaining({ messages: [message("resume.bodyTooLong", { room })] }),
    );
    service.resume(rerun.id, { note: "い".repeat(9_000) });
    const resumed = taskOf(rerun.id);
    expect(resumed.body.length).toBeGreaterThan(TASK_BODY_MAX);
    // 補足は前の試行の記録の前にあり、再実行の画面の説明に残る
    expect(resumed.body.indexOf(RESUME_NOTE_HEADING)).toBeLessThan(
      resumed.body.indexOf(RERUN_RECORD_HEADING),
    );
    expect(rerunEditableBody(resumed)).toContain("い".repeat(9_000));
    expect(rerunEditableBody(resumed).length).toBeLessThanOrEqual(TASK_BODY_MAX);
    activity.close();
  });

  it("中止したタスクを引き継いだ新しいタスクを作り、補足と前の試行の記録を説明に足す。再実行は1度だけ", async () => {
    const { activity, service } = setup([completed(10)]);
    const task = service.createTask({
      projectId: "default",
      title: "決済の再送",
      body: "二重に請求される",
      repo: "https://github.com/acme/app",
    });
    // 中止していないタスクは再実行できない
    expect(() => service.rerunTask(task.id, { title: "x", repo: null })).toThrowError(
      InvalidOperationError,
    );
    await service.runNext(task.id); // 要求要件
    await service.cancel(task.id);

    const rerun = service.rerunTask(task.id, {
      title: "決済の再送（やり直し）",
      body: "二重に請求される",
      note: "再送は冪等キーで判定する",
      repo: "https://github.com/acme/api",
      image: "java",
    });
    expect(rerun).toMatchObject({
      title: "決済の再送（やり直し）",
      start: "sacty",
      status: "queued",
      repo: "https://github.com/acme/api",
      rerun: { taskId: task.id, image: "java" },
    });
    expect(rerun.body).toMatch(
      /^二重に請求される\n\n## 補足（再実行で人が足したもの）\n\n再送は冪等キーで判定する\n/,
    );
    expect(rerun.body).toContain(RERUN_RECORD_HEADING);
    expect(rerun.body).toContain(`- 中止したタスク：決済の再送（${task.id}）`);
    expect(rerun.body).toContain("- 作業したリポジトリ：https://github.com/acme/app");
    expect(rerun.body).toContain("### 要求要件の成果（未承認）");
    // 元のタスクに、再実行で作ったタスクを記録する（再起動の後も作業履歴から同じに戻る）
    expect(service.get(task.id)?.task.rerunBy).toBe(rerun.id);
    const { service: restarted } = makeService(activity, [], { projects: projects() });
    expect(restarted.get(task.id)?.task.rerunBy).toBe(rerun.id);
    expect(restarted.get(rerun.id)?.task.rerun).toEqual({ taskId: task.id, image: "java" });
    // 2度目は断る
    expect(() => service.rerunTask(task.id, { title: "again", repo: null })).toThrowError(
      InvalidOperationError,
    );
    // 説明の元は、sacty が足した記録を除いたもの（再実行を重ねても記録が積み重ならない）
    expect(rerunEditableBody(rerun)).toBe(
      "二重に請求される\n\n## 補足（再実行で人が足したもの）\n\n再送は冪等キーで判定する",
    );
    activity.close();
  });

  it("API で再実行でき、作ったタスクを 201 で返す。再実行済みなら 409、入力の誤りは 400", async () => {
    const { activity, service } = setup();
    const task = service.createTask({ projectId: "default", title: "A", repo: null });
    await service.cancel(task.id);
    const app = createApp(service, "tok");
    const post = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/rerun`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ title: " ", repo: null })).status).toBe(400);
    const ok = await post({ title: "A", note: "補足", repo: null });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { task: Task }).task.rerun).toEqual({ taskId: task.id });
    const ng = await post({ title: "A", repo: null });
    expect(ng.status).toBe(409);
    expect(await ng.json()).toEqual({
      error: "invalid_operation",
      messages: [message("rerun.alreadyRerun")],
    });
    activity.close();
  });

  it("人が指定したイメージを、すべての工程で使う（再実行で人が指定したと記録する）", async () => {
    const { activity, service } = setup([completed(10)]);
    const task = service.createTask({ projectId: "default", title: "A", repo: null });
    await service.cancel(task.id);
    const rerun = service.rerunTask(task.id, {
      title: "A",
      repo: "https://github.com/acme/app",
      image: "java",
    });
    await service.runNext(rerun.id);
    const chosen = service.get(rerun.id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
      image: "java",
      imageSource: "rerun",
    });
    expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty("images");
    activity.close();
  });

  it("images に無いイメージ・プロジェクトの対象に無いリポジトリは断る", async () => {
    const { activity, service } = setup();
    const task = service.createTask({ projectId: "default", title: "A", repo: null });
    await service.cancel(task.id);
    expect(() =>
      service.rerunTask(task.id, { title: "A", repo: null, image: "ruby" }),
    ).toThrowError(InvalidOperationError);
    expect(() =>
      service.rerunTask(task.id, { title: "A", repo: "https://github.com/other/x" }),
    ).toThrowError(InvalidOperationError);
    expect(service.get(task.id)?.task.rerunBy).toBeUndefined();
    activity.close();
  });

  it("チケットのタスクは、チケットを引き継ぎ、読み直さずに人が決めたリポジトリ（無しも）で進める。同じチケットは二重に取り込まない", async () => {
    const { activity, service, executor } = setup([
      triageOut({
        repo: "https://github.com/acme/app",
        title: "PAY-1 決済の再送",
        summary: "再送で二重に請求される",
        reason: "決済のコードがある",
      }),
    ]);
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    const id = task?.id ?? "";
    await service.runNext(id); // チケットを読む
    await service.cancel(id);
    const calls = executor.calls.length;

    const rerun = service.rerunTask(id, {
      title: "PAY-1 決済の再送",
      body: "再送で二重に請求される",
      note: "API 側の修正だけでよい",
      repo: null,
    });
    expect(rerun).toMatchObject({
      start: "jira",
      ticket: { key: "PAY-1" },
      noRepo: true,
      rerun: { taskId: id },
    });
    expect(rerun.repo).toBeUndefined();
    expect(rerun.body).toContain("- チケット：PAY-1（https://jira.example.com/browse/PAY-1）");
    expect(awaitingTicketTriage(rerun)).toBe(false);
    expect(isRepoless(rerun)).toBe(true);
    // 工程を選ぶ（チケットは読み直さない。リポジトリ無しで進む）
    await service.runNext(rerun.id);
    expect(executor.calls.length).toBe(calls);
    expect(types(service, rerun.id)).not.toContain("TicketTriaged");
    // コードの変更が要る工程を選んだが、リポジトリを選べなかったので止まる。人が選ぶのは、リポジトリを指定せずに作った
    // タスクと同じ選び方（チケットのリポジトリの選び方ではない）
    expect(service.get(rerun.id)?.task.status).toBe("paused");
    await service.chooseRepository(rerun.id, "https://github.com/acme/api");
    expect(types(service, rerun.id)).toContain("RepositoryChosen");
    expect(service.get(rerun.id)?.task.repo).toBe("https://github.com/acme/api");
    // 同じチケットは、取り込み直さない
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    activity.close();
  });
});

describe("完了したタスクから続きのタスクを作る（派生）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const planner = (plan: "investigate" | "security-check") => async () => ({
    steps: ["investigate" as const],
    plan,
    reason: "調べる",
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  /** 調査だけのタスクを、成果を承認して完了させる。 */
  const completedTask = async (service: TaskService) => {
    const task = service.createTask({ projectId: "default", title: "決済の調査", body: "遅い" });
    await service.runNext(task.id);
    const done = service.approve(task.id, { step: "investigate", submission: 1 });
    expect(isCompleted(done)).toBe(true);
    return task.id;
  };

  it("元のタスクを指す新しいタスクを作り、依頼の後に元のタスクの記録を足す。いくつでも作れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("N+1 のクエリが2か所ある")], {
      planner: planner("investigate"),
    });
    const id = await completedTask(service);
    const derived = service.deriveTask(id, {
      title: "N+1 を直す",
      body: "調査で見つかった N+1 を直す",
      repo: "https://github.com/acme/app",
    });
    expect(derived).toMatchObject({
      title: "N+1 を直す",
      start: "sacty",
      status: "queued",
      repo: "https://github.com/acme/app",
      derivedFrom: { taskId: id },
    });
    expect(derived.requestedPlan).toBeUndefined();
    expect(derived.body).toMatch(/^調査で見つかった N\+1 を直す\n\n/);
    expect(derived.body).toContain(DERIVE_RECORD_HEADING);
    expect(derived.body).toContain(`- 元のタスク：決済の調査（${id}）`);
    expect(derived.body).toContain("### 調査の成果（承認済み）");
    expect(derived.body).toContain("N+1 のクエリが2か所ある");
    // 2つ目も作れる（リポジトリ無し・進め方の指定あり）
    const second = service.deriveTask(id, {
      title: "文書にする",
      body: "調査の結果を文書にまとめる",
      repo: null,
      plan: "document",
    });
    expect(second).toMatchObject({ noRepo: true, requestedPlan: "document" });
    // 元のタスクは完了のまま、作ったタスクを作った順に記録する（再起動の後も作業履歴から同じに戻る）
    expect(service.get(id)?.task).toMatchObject({ derivedTasks: [derived.id, second.id] });
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    const { service: restarted } = makeService(activity, []);
    expect(restarted.get(id)?.task.derivedTasks).toEqual([derived.id, second.id]);
    expect(restarted.get(derived.id)?.task.derivedFrom).toEqual(derived.derivedFrom);
    activity.close();
  });

  it("取り込み元のあるタスクから作っても、取り込み元を引き継がない（記録に URL だけを書く）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service } = makeService(activity, [out("結果")], {
      pulls,
      planner: planner("investigate"),
    });
    const [task] = service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: 7,
        title: "遅い画面を調べて",
        body: "",
        url: "https://github.com/acme/app/issues/7",
        labels: ["sacty"],
      },
    ]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    const derived = service.deriveTask(id, { title: "直す", body: "遅い画面を直す", repo: null });
    expect(derived.start).toBe("sacty");
    expect(derived.source).toBeUndefined();
    expect(derived.ticket).toBeUndefined();
    expect(derived.body).toContain("- 取り込み元：https://github.com/acme/app/issues/7");
    activity.close();
  });

  it("チケットから取り込んだタスクから作っても、チケットを引き継がない（記録にキーと URL だけを書く）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
    });
    const { service } = makeService(
      activity,
      [
        triageOut({
          repo: "https://github.com/acme/app",
          title: "PAY-1 決済の調査",
          summary: "再送が遅い",
          reason: "決済のコードがある",
        }),
        out("結果"),
      ],
      {
        config: configOf(agent(), 1, [jiraPlatform()]),
        secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
        gateway: fakeGateway(),
        projects,
        settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
        tickets: new FakeTickets(),
        planner: planner("investigate"),
      },
    );
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    const id = task?.id ?? "";
    await service.runNext(id); // チケットを読む
    await service.runNext(id); // 調査
    service.approve(id, { step: "investigate", submission: 1 });
    expect(service.get(id)?.task.ticket?.key).toBe("PAY-1");
    const derived = service.deriveTask(id, { title: "直す", body: "再送を直す", repo: null });
    expect(derived.start).toBe("sacty");
    expect(derived.ticket).toBeUndefined();
    expect(derived.source).toBeUndefined();
    expect(derived.body).toContain("- チケット：PAY-1（https://jira.example.com/browse/PAY-1）");
    activity.close();
  });

  it("派生で作ったタスクを中止して再実行すると、人が直す説明から記録を除き、記録は sacty が付け直す（成果に見出しと同じ行があっても・再実行を重ねても）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 成果の本文に、再実行の補足・前の試行の記録・元のタスクの記録と同じ見出しがあっても、境目を誤らない
    const output = [
      "# 結果",
      "## 補足（再実行で人が足したもの）",
      "あ".repeat(5500),
      RERUN_RECORD_HEADING,
      DERIVE_RECORD_HEADING,
    ].join("\n");
    const { service } = makeService(activity, [out(output)], { planner: planner("investigate") });
    const id = await completedTask(service);
    const request = "い".repeat(9000);
    const derived = service.deriveTask(id, { title: "直す", body: request, repo: null });
    expect(derived.body.length).toBeGreaterThan(TASK_BODY_MAX);
    expect(derived.derivedFrom?.record).toBeDefined();
    expect(derived.body).toBe(`${request}\n\n${derived.derivedFrom?.record}`);
    await service.cancel(derived.id);
    const editable = rerunEditableBody(service.get(derived.id)?.task as Task);
    expect(editable).toBe(request);
    // 再実行の画面の初期値のまま送れる
    const rerun = service.rerunTask(derived.id, {
      title: "直す",
      body: editable,
      note: "補足",
      repo: null,
    });
    expect(rerun.derivedFrom).toEqual(derived.derivedFrom);
    expect(rerun.body.startsWith(`${request}\n\n${DERIVE_RECORD_HEADING}\n`)).toBe(true);
    expect(rerun.body).toContain(`- 元のタスク：決済の調査（${id}）`);
    expect(service.get(id)?.task.derivedTasks).toEqual([derived.id, rerun.id]);
    // 再実行のタスクの説明の元も、人が直した説明と補足だけ（記録は重ならない）
    expect(rerunEditableBody(rerun)).toBe(
      `${request}\n\n## 補足（再実行で人が足したもの）\n\n補足`,
    );
    // 再実行を重ねても、記録を人が直す説明に混ぜず、つながりを保つ
    await service.cancel(rerun.id);
    const again = service.rerunTask(rerun.id, {
      title: "直す",
      body: rerunEditableBody(service.get(rerun.id)?.task as Task),
      repo: null,
    });
    expect(again.derivedFrom).toEqual(derived.derivedFrom);
    expect(rerunEditableBody(again).length).toBeLessThanOrEqual(TASK_BODY_MAX);
    expect(rerunEditableBody(again)).not.toContain(DERIVE_RECORD_HEADING);
    activity.close();
  });

  it("完了していないタスク・対象に無いリポジトリからは作らない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("結果")], { planner: planner("investigate") });
    const task = service.createTask({ projectId: "default", title: "A", body: "a" });
    const input = { title: "B", body: "b", repo: null };
    expect(() => service.deriveTask(task.id, input)).toThrowError(InvalidOperationError);
    await service.runNext(task.id); // 承認待ち
    expect(() => service.deriveTask(task.id, input)).toThrowError(InvalidOperationError);
    service.approve(task.id, { step: "investigate", submission: 1 });
    expect(() =>
      service.deriveTask(task.id, { ...input, repo: "https://github.com/other/x" }),
    ).toThrowError(InvalidOperationError);
    expect(service.get(task.id)?.task.derivedTasks).toBeUndefined();
    activity.close();
  });

  it("セキュリティのタスクの続きは、セキュリティの組み合わせだけ（指定しなければセキュリティ対応）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# セキュリティチェックの結果")], {
      planner: planner("security-check"),
    });
    const { id } = service.createTask({ template: "security-check", projectId: "default" });
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    const input = { title: "SF-1 と SF-2 を直す", body: "まとめて直す", repo: null };
    expect(() => service.deriveTask(id, { ...input, plan: "standard" })).toThrowError(
      new InvalidOperationError(message("derive.securityPlanRequired")),
    );
    expect(service.deriveTask(id, input)).toMatchObject({ requestedPlan: "security-fix" });
    expect(service.deriveTask(id, { ...input, plan: "security-check" })).toMatchObject({
      requestedPlan: "security-check",
    });
    activity.close();
  });

  it("API で作り、作ったタスクを 201 で返す。完了していなければ 409、入力の誤りは 400", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("結果")], { planner: planner("investigate") });
    const pending = service.createTask({ projectId: "default", title: "A", body: "a" });
    const app = createApp(service, "tok");
    const post = (taskId: string, body: unknown) =>
      app.request(`/api/tasks/${taskId}/derive`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ng = await post(pending.id, { title: "B", body: "b", repo: null });
    expect(ng.status).toBe(409);
    expect(await ng.json()).toEqual({
      error: "invalid_operation",
      messages: [message("derive.notCompleted")],
    });
    const id = await completedTask(service);
    expect((await post(id, { title: "B", body: " ", repo: null })).status).toBe(400);
    const ok = await post(id, { title: "B", body: "b", repo: null });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { task: Task }).task.derivedFrom?.taskId).toBe(id);
    activity.close();
  });
});

describe("タスクの開始時の情報収集", () => {
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const BRIEF = "## 目的と背景\n\nPAY-100 エピック：二重請求をなくす";
  const gathered = (brief = BRIEF, output = 100): AgentOutcome => ({
    kind: "completed",
    output: `集めました\n\n\`\`\`json\n${JSON.stringify({
      "sacty-gathered": {
        brief,
        sources: [{ title: "PAY-100 エピック", url: "https://jira.example.com/browse/PAY-100" }],
      },
    })}\n\`\`\``,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  const investigateOnly: AgentOutcome = {
    kind: "completed",
    output: '```json\n{"sacty-steps": {"plan": "investigate", "reason": "調査だけ"}}\n```',
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
  };

  it("工程を選ぶ前に1回だけ集めて記録し、オーケストレーターと工程の指示に添える", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather.db"));
    const { service, executor, repos } = makeService(
      activity,
      [gathered(), investigateOnly, completed(10)],
      { realPlanner: true, realGatherer: true },
    );
    const task = service.createTask({
      projectId: "default",
      title: "PAY-1 決済の再送",
      body: "再送で二重に請求される",
    });
    await service.runNext(task.id); // 情報を集める
    const recorded = service.get(task.id)?.activity.find((e) => e.type === "InformationGathered");
    expect(recorded?.actor).toBe("gatherer");
    expect(recorded?.type === "InformationGathered" && recorded.payload).toMatchObject({
      brief: BRIEF,
      sources: [{ title: "PAY-100 エピック", url: "https://jira.example.com/browse/PAY-100" }],
      costUsd: 0.0015,
    });
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    expect(service.get(task.id)?.task.budget.usedUsd).toBe(0.0015);
    expect(service.get(task.id)?.task.steps).toEqual([]);
    expect(executor.stdins[0]).toContain("あなたは情報収集エージェントです");
    expect(executor.stdins[0]).toContain("再送で二重に請求される");
    // リポジトリは情報収集の前に用意し、情報収集の作業領域に起点のコードを置いて読ませる
    const order = types(service, task.id);
    expect(order.indexOf("RepositoryPrepared")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("RepositoryPrepared")).toBeLessThan(order.indexOf("InformationGathered"));
    expect(repos.snapshots).toHaveLength(1);
    expect(executor.stdins[0]).toContain(
      "対象リポジトリ https://github.com/acme/app.git のベースブランチ",
    );
    await service.runNext(task.id); // 工程を選ぶ（集め直さない）
    await service.runNext(task.id); // 調査
    expect(types(service, task.id).filter((t) => t === "InformationGathered")).toHaveLength(1);
    expect(executor.stdins[1]).toContain("あなたはオーケストレーターです");
    expect(executor.stdins[2]).toContain("あなたはソフトウェア開発の調査エージェントです");
    for (const prompt of executor.stdins.slice(1)) {
      expect(prompt).toContain("--- タスクの開始時に集めた情報 ---");
      expect(prompt).toContain("PAY-100 エピック：二重請求をなくす");
    }
    activity.close();
  });

  it("リポジトリを指定せずに作ったタスクは、用意せずに集め、プロジェクトの対象を候補として読ませる", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-repoless.db"));
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "repo", target: "https://github.com/acme/api" },
      ],
      githubAccounts: { "github.com": "me" },
    });
    const { service, executor, repos } = makeService(activity, [gathered()], {
      realGatherer: true,
      projects,
      gateway: fakeGateway(),
    });
    const task = service.createTask({ projectId: "default", title: "決済の再送", repo: null });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    expect(types(service, task.id)).not.toContain("RepositoryPrepared");
    expect(repos.prepared).toHaveLength(0);
    expect(executor.stdins[0]).toContain("関係しそうなリポジトリを洗い出し（多くても 3 つ）");
    expect(executor.stdins[0]).toContain("- https://github.com/acme/app");
    expect(executor.stdins[0]).toContain("- https://github.com/acme/api");
    expect(executor.stdins[0]).toContain("--- GitHub（読み取り） ---");
    activity.close();
  });

  it("複数指定の情報収集は指定した全件だけを読み、対象から外れれば再開まで実行しない", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-multiple.db"));
    const targets = [
      "https://github.com/acme/app",
      "https://github.com/acme/api",
      "https://github.com/acme/web",
      "https://github.com/acme/lib",
      "https://github.com/acme/other",
    ];
    const projects = projectsWithAccount();
    const setTargets = (items: string[]) =>
      projects.put("default", {
        name: "デフォルト",
        targets: items.map((target) => ({ scope: "repo" as const, target })),
        githubAccounts: { "github.com": "me" },
      });
    setTargets(targets);
    const { service, executor } = makeService(activity, [gathered()], {
      realGatherer: true,
      projects,
      gateway: fakeGateway(),
    });
    const task = service.createTask({
      projectId: "default",
      title: "複数",
      repos: targets.slice(0, 4),
    });
    const listing = vi
      .spyOn(service, "projectRepositories")
      .mockRejectedValueOnce(new Error("listing failed"));
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task.id)?.task.status).toBe("paused");
    const listingFailure = service
      .get(task.id)
      ?.activity.find((e) => e.type === "OrchestratorFailed");
    expect(
      listingFailure?.type === "OrchestratorFailed" &&
        renderMessage(listingFailure.payload.message, "ja"),
    ).toContain("listing failed");
    listing.mockRestore();
    service.resume(task.id, {});
    setTargets(targets.slice(0, 3));
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task.id)?.task.status).toBe("paused");
    const failure = service
      .get(task.id)
      ?.activity.filter((e) => e.type === "OrchestratorFailed")
      .at(-1);
    expect(
      failure?.type === "OrchestratorFailed" && renderMessage(failure.payload.message, "ja"),
    ).toContain(targets[3]);
    setTargets(targets);
    service.resume(task.id, {});
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    const prompt = executor.stdins[0] ?? "";
    for (const repo of targets.slice(0, 4)) expect(prompt).toContain(repo);
    expect(prompt).not.toContain(targets[4]);
    expect(prompt).toContain("指定した次のリポジトリをすべて");
    expect(prompt).not.toContain("多くても 3 つ");
    activity.close();
  });

  it("情報収集前に選択した後も指定先を照合し全件を読む", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-selected-multiple.db"));
    const api = "https://github.com/acme/api";
    const web = "https://github.com/acme/web";
    const projects = projectsWithAccount();
    const setTargets = (items: string[]) =>
      projects.put("default", {
        name: "デフォルト",
        targets: items.map((target) => ({ scope: "repo" as const, target })),
        githubAccounts: { "github.com": "me" },
      });
    setTargets([api, web]);
    const { service, executor } = makeService(activity, [gathered()], {
      realGatherer: true,
      projects,
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [api, web] });
    await service.pause(id);
    await service.chooseRepository(id, api);
    service.resume(id, {});
    setTargets([api]);
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.status).toBe("paused");
    const failure = activity.forTask(id).find((event) => event.type === "OrchestratorFailed");
    expect(
      failure?.type === "OrchestratorFailed" && renderMessage(failure.payload.message, "ja"),
    ).toContain(web);
    setTargets([api, web]);
    service.resume(id, {});
    await service.runNext(id);
    expect(service.get(id)?.task.gathered?.brief).toBe(BRIEF);
    expect(executor.stdins[0]).toContain(api);
    expect(executor.stdins[0]).toContain(web);
    expect(executor.stdins[0]).toContain("指定した次のリポジトリをすべて");
    activity.close();
  });

  it("情報収集の候補照合後に定義を読めなければ停止し再開する", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-late-definition.db"));
    const api = "https://github.com/acme/api";
    const web = "https://github.com/acme/web";
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [api, web].map((target) => ({ scope: "repo" as const, target })),
      githubAccounts: { "github.com": "me" },
    });
    const { service, executor } = makeService(activity, [gathered()], {
      realGatherer: true,
      projects,
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "複数", repos: [api, web] });
    const list = service.projectRepositories.bind(service);
    const get = projects.get.bind(projects);
    let listings = 0;
    let fail = false;
    const read = vi.spyOn(projects, "get").mockImplementation((projectId) => {
      if (fail) {
        fail = false;
        throw new Error("gather late read");
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
    expect(
      failure?.type === "OrchestratorFailed" && renderMessage(failure.payload.message, "ja"),
    ).toContain("gather late read");
    listing.mockRestore();
    read.mockRestore();
    service.resume(id, {});
    await service.runNext(id);
    expect(service.get(id)?.task.gathered?.brief).toBe(BRIEF);
    activity.close();
  });

  it("複数指定の Org 一覧を読めなければ止まり、読めるようになると再開できる", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-multiple-org.db"));
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
      githubAccounts: { "github.com": "me" },
    });
    const pulls = new FakePulls();
    pulls.ownerRepos["https://github.com/acme"] = [
      "https://github.com/acme/api",
      "https://github.com/acme/web",
    ];
    pulls.repositoriesFail = "unavailable";
    const { service, executor } = makeService(activity, [gathered()], {
      projects,
      pulls,
      realGatherer: true,
      gateway: fakeGateway(),
    });
    const task = service.createTask({
      projectId: "default",
      title: "複数",
      repos: pulls.ownerRepos["https://github.com/acme"],
    });
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task.id)?.task.status).toBe("paused");
    const failure = service.get(task.id)?.activity.find((e) => e.type === "OrchestratorFailed");
    expect(
      failure?.type === "OrchestratorFailed" && renderMessage(failure.payload.message, "ja"),
    ).toContain("https://github.com/acme/api");
    expect(
      failure?.type === "OrchestratorFailed" && renderMessage(failure.payload.message, "ja"),
    ).toContain("unavailable");
    pulls.repositoriesFail = undefined;
    service.resume(task.id, {});
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    activity.close();
  });

  it("リポジトリのあるタスクは、プロジェクトの共用の compose を候補にして、テストと動作確認に要るサービスを分けさせる（PBI-152）", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-services.db"));
    const projects = projectsWithAccount();
    const project = projects.get("default");
    if (!project) throw new Error("no project");
    projects.put("default", {
      ...project,
      sharedComposes: [
        {
          name: "infra",
          repo: "https://github.com/acme/test-infra",
          ref: "main",
          file: "compose/redis.yml",
          description: "Redis。結合テストに要る",
        },
      ],
    });
    const { service, executor } = makeService(activity, [gathered()], {
      realGatherer: true,
      projects,
    });
    const task = service.createTask({ projectId: "default", title: "動作確認" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    expect(executor.stdins[0]).toContain("--- 実行の環境とサービス ---");
    expect(executor.stdins[0]).toContain(
      "     - infra：compose ファイル compose/redis.yml。Redis。結合テストに要る",
    );
    // 取得の先（リポジトリ・ref）は出さない（オーケストレーターと同じく、名前・ファイル・説明だけ）
    expect(executor.stdins[0]).not.toContain("acme/test-infra");
    activity.close();
  });

  it.each([
    ["一部の Org", true],
    ["すべての Org", false],
  ] as const)(
    "候補の一覧を%sで読めなければ、秘密を伏せた理由を情報収集に伝える",
    async (_, withRepo) => {
      const activity = new SqliteActivityStore(join(dir, `gather-org-${withRepo}.db`));
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [
          ...(withRepo ? [{ scope: "repo" as const, target: "https://github.com/acme/app" }] : []),
          { scope: "org", target: "https://github.com/tools" },
        ],
        githubAccounts: { "github.com": "me" },
      });
      const pulls = new FakePulls();
      pulls.repositoriesFail = "401 Bad credentials ghp_secret";
      const { service, executor } = makeService(activity, [gathered()], {
        realGatherer: true,
        projects,
        pulls,
        gateway: fakeGateway(),
      });
      const task = service.createTask({ projectId: "default", title: "決済の再送", repo: null });
      await service.runNext(task.id);
      const prompt = executor.stdins[0] ?? "";
      expect(prompt).toContain(
        "次の Org はリポジトリの一覧を読めなかったので、候補に入っていません",
      );
      expect(prompt).toContain("- https://github.com/tools：");
      expect(prompt).toContain("401 Bad credentials");
      expect(prompt).not.toContain("ghp_secret");
      if (withRepo) {
        expect(prompt).toContain("- https://github.com/acme/app");
        expect(prompt).toContain("上の「コード」のリポジトリで");
      } else {
        expect(prompt).toContain("リポジトリの候補を読めませんでした");
        expect(prompt).not.toContain("上の「コード」のリポジトリで");
      }
      expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
      activity.close();
    },
  );

  it("集められない・読めないときは理由を記録して止め、再開すると集め直す", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-fail.db"));
    const unreadable: AgentOutcome = {
      kind: "completed",
      output: "まとめられませんでした",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
    };
    const { service } = makeService(activity, [unreadable, gathered()], {
      realGatherer: true,
    });
    const task = service.createTask({ projectId: "default", title: "PAY-1 決済の再送" });
    await service.runNext(task.id);
    const failed = service.get(task.id)?.activity.find((e) => e.type === "OrchestratorFailed");
    expect(failed?.actor).toBe("gatherer");
    expect(failed?.type === "OrchestratorFailed" && ja(failed.payload.message)).toContain(
      "集めた情報のまとめを読み取れませんでした",
    );
    expect(service.get(task.id)?.task.status).toBe("paused");
    expect(service.get(task.id)?.task.gathered).toBeUndefined();
    service.resume(task.id, {});
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    activity.close();
  });

  /** チケットのトリアージを兼ねた情報収集の答え。 */
  const gatheredTriage = (triage: Record<string, unknown>): AgentOutcome => ({
    kind: "completed",
    output: `集めました\n\n\`\`\`json\n${JSON.stringify({
      "sacty-gathered": { brief: BRIEF, sources: [{ title: "PAY-100 エピック" }], ...triage },
    })}\n\`\`\``,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const ticketService = (outcomes: AgentOutcome[], name: string) => {
    const activity = new SqliteActivityStore(join(dir, `${name}.db`));
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "repo", target: "https://github.com/acme/api" },
      ],
      githubAccounts: { "github.com": "me" },
      tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
    });
    const made = makeService(activity, outcomes, {
      realGatherer: true,
      config: configOf(agent(), 1, [jiraPlatform()]),
      secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
      gateway: fakeGateway(),
      projects,
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    const [task] = made.service.importTickets([foundTicket("PAY-1")]);
    return { ...made, activity, id: task?.id ?? "" };
  };

  it("チケットのタスクは、情報収集がトリアージも兼ね、1回の実行でリポジトリ・題・概要を決める", async () => {
    const { activity, service, executor, id } = ticketService(
      [
        gatheredTriage({
          repo: "https://github.com/acme/api",
          title: "PAY-1 決済の再送",
          summary: "再送で二重に請求される。エピックの目的は二重請求をなくすこと",
          reason: "エピックに決済 API の変更とある",
        }),
      ],
      "gather-ticket",
    );
    await service.runNext(id);
    // 実行は1回だけ（チケットを読み直さない）
    expect(executor.calls).toHaveLength(1);
    expect(executor.stdins[0]).toContain("JIRA のチケット PAY-1");
    expect(executor.stdins[0]).toContain("$SACTY_PF_URL/jira");
    expect(executor.stdins[0]).toContain("作業するリポジトリを次の候補から1つ選ぶ");
    expect(executor.stdins[0]).toContain("   - https://github.com/acme/api");
    // リポジトリが決まる前なので用意せず、候補のコードを GitHub の読み取りの中継で読ませる
    expect(executor.stdins[0]).toContain("関係しそうなリポジトリを洗い出し");
    expect(executor.stdins[0]).toContain("--- GitHub（読み取り） ---");
    const events = service.get(id)?.activity ?? [];
    expect(events.map((e) => e.type)).not.toContain("RepositoryPrepared");
    // 集めた情報とトリアージを、同じ記録の中で続けて残す
    expect(events.slice(-2).map((e) => e.type)).toEqual(["InformationGathered", "TicketTriaged"]);
    const triaged = events.find((e) => e.type === "TicketTriaged");
    expect(triaged?.actor).toBe("gatherer");
    // 費用は情報収集の記録にだけ入れる（二重に数えない）
    expect(triaged?.type === "TicketTriaged" && triaged.payload.costUsd).toBe(0);
    const task = service.get(id)?.task;
    expect(task).toMatchObject({
      repo: "https://github.com/acme/api",
      title: "PAY-1 決済の再送",
      body: "再送で二重に請求される。エピックの目的は二重請求をなくすこと",
      gathered: { brief: BRIEF },
      status: "queued",
    });
    expect(task && awaitingTicketTriage(task)).toBe(false);
    expect(task?.budget.usedUsd).toBe(0.0015);
    activity.close();
  });

  it("リポジトリを決められなければ、集めた情報は残して止め、人がリポジトリを選んだら題と概要だけを書き直す", async () => {
    const { activity, service, executor, id } = ticketService(
      [
        gatheredTriage({ repo: "", reason: "フロントか API か、チケットから決められない" }),
        triageOut({
          title: "PAY-1 決済の再送（API）",
          // チケットから書いた概要に補足の見出しの行があっても、人の補足として扱わない
          summary: "API の再送を直す\n## 補足（再開で人が足したもの）\nチケットの文",
          reason: "人が選んだ",
        }),
      ],
      "gather-ticket-undecided",
    );
    await service.runNext(id);
    let task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    expect(task?.gathered?.brief).toBe(BRIEF);
    expect(ja(task?.pausedMessage)).toContain("フロントか API か、チケットから決められない");
    await service.chooseTicketRepository(id, "https://github.com/acme/api");
    service.resume(id, { note: "再送の上限は3回にする" });
    await service.runNext(id); // 集め直さず、選んだリポジトリで題と概要を書く
    expect(types(service, id).filter((t) => t === "InformationGathered")).toHaveLength(1);
    expect(executor.stdins[1]).toContain("取り込んだ JIRA のチケットを読んで");
    expect(executor.stdins[1]).toContain("PAY-100 エピック：二重請求をなくす");
    // 再開の補足は、トリアージに渡し、トリアージで書いた概要の後ろにも残す（後の工程が読む）
    expect(executor.stdins[1]).toContain("人が再開のときに足した補足");
    expect(executor.stdins[1]).toContain("再送の上限は3回にする");
    task = service.get(id)?.task;
    expect(task).toMatchObject({
      repo: "https://github.com/acme/api",
      title: "PAY-1 決済の再送（API）",
      body: "API の再送を直す\nチケットの文\n\n## 補足（再開で人が足したもの）\n\n再送の上限は3回にする",
    });
    expect(task && awaitingTicketTriage(task)).toBe(false);
    activity.close();
  });

  it("候補に無いリポジトリ・概要の無い答えは、トリアージとして使わずに止める", async () => {
    for (const [name, triage] of [
      ["outside", { repo: "https://github.com/other/x", summary: "S", reason: "R" }],
      ["no-summary", { repo: "https://github.com/acme/app", summary: "", reason: "R" }],
      ["none", {}],
    ] as const) {
      const { activity, service, id } = ticketService(
        [gatheredTriage(triage)],
        `gather-ticket-${name}`,
      );
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.gathered?.brief).toBe(BRIEF);
      expect(types(service, id)).not.toContain("TicketTriaged");
      activity.close();
    }
  });

  it("実行に失敗したら、代わりのエージェントで集め直し、まとめを1回だけ記録して工程の選択へ進む", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-fallback.db"));
    const main = agent({ fallback: ["claude-api"] });
    const backup = agent({ id: "claude-api", auth: { mode: "api-key", secret: "anthropic-key" } });
    const config = (): ConfigResult => {
      const base = configOf(main)();
      return base.ok
        ? { ok: true, config: { ...base.config, agents: { [main.id]: main, [backup.id]: backup } } }
        : base;
    };
    const { service, executor } = makeService(
      activity,
      [{ kind: "failed", reason: "usage_limit", message: "limit" }, gathered(), investigateOnly],
      {
        realGatherer: true,
        realPlanner: true,
        config,
        secrets: { "claude-oauth-token": "oauth-secret", "anthropic-key": "sk-ant-secret" },
      },
    );
    const task = service.createTask({ projectId: "default", title: "PAY-1 決済の再送" });
    await service.runNext(task.id); // 失敗して、代わりのエージェントに切り替える
    let events = service.get(task.id)?.activity ?? [];
    const failed = events.find((e) => e.type === "OrchestratorFailed");
    expect(failed?.actor).toBe("gatherer");
    expect(events.find((e) => e.type === "AgentFellBack")?.payload).toMatchObject({
      role: "gather",
      agentId: "claude-subscription",
      fallbackAgentId: "claude-api",
    });
    expect(service.get(task.id)?.task.status).toBe("queued");
    await service.runNext(task.id); // 代わりのエージェントで集める
    await service.runNext(task.id); // 工程を選ぶ
    events = service.get(task.id)?.activity ?? [];
    const recorded = events.filter((e) => e.type === "InformationGathered");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type === "InformationGathered" && recorded[0].payload).toMatchObject({
      agentId: "claude-api",
      costUsd: 0.0015,
    });
    expect(executor.calls[1]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(service.get(task.id)?.task.gathered?.brief).toBe(BRIEF);
    expect(events.some((e) => e.type === "StepsChosen")).toBe(true);
    expect(executor.stdins[2]).toContain("PAY-100 エピック：二重請求をなくす");
    activity.close();
  });

  it("情報収集の実行は、ゲートウェイに読み取りだけの実行として登録し、指示に書き込みの API を出さない", async () => {
    const activity = new SqliteActivityStore(join(dir, "gather-readonly.db"));
    const options: unknown[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      ...fakeGateway(),
      register: (...args: unknown[]) => {
        options.push(args[5]);
        return fakeGateway().register();
      },
    };
    const { service, executor } = makeService(activity, [gathered(), investigateOnly], {
      realGatherer: true,
      realPlanner: true,
      config: configOf(agent(), 1, [jiraPlatform()]),
      secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
      gateway,
    });
    const task = service.createTask({ projectId: "default", title: "PAY-1 決済の再送" });
    await service.runNext(task.id); // 集める
    await service.runNext(task.id); // 工程を選ぶ
    // 情報収集だけを読み取りだけの実行にする（工程の選択などの実行はそのまま）
    expect(options[0]).toEqual({ readOnly: true });
    expect(options.length).toBeGreaterThan(1);
    expect(options.slice(1).every((o) => o === undefined)).toBe(true);
    expect(executor.stdins[0]).toContain("GET /rest/api/**");
    expect(executor.stdins[0]).not.toContain("POST /rest/api/2/issue/*/comment");
    // オーケストレーターには、今までどおり書き込みの API も見せる
    expect(executor.stdins[1]).toContain("POST /rest/api/2/issue/*/comment");
    activity.close();
  });

  it("情報収集の AI は step_agents.gather、無ければオーケストレーターの AI", async () => {
    const base = (configOf(agent())() as { ok: true; config: SactyConfig }).config;
    const orchestrator = agent({ id: "orch" });
    const gatherer = agent({ id: "gath" });
    expect(agentFor({ ...base, stepAgents: { orchestrator } }, "gather").id).toBe("orch");
    expect(agentFor({ ...base, stepAgents: { orchestrator, gather: gatherer } }, "gather").id).toBe(
      "gath",
    );
    expect(agentFor(base, "gather").id).toBe(base.defaultAgent.id);
  });
});

describe("終わったタスクと、中断された実行の作業領域の片付け（PBI-157）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const isSurvey = (invocation: Invocation) =>
    invocation.command.join(" ").includes("いまは大まかな監査です");
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const root = () => join(dir, "workspaces");
  const workspaceOf = (id: string) => join(root(), id);
  const gitDirOf = (id: string) => join(root(), "_git", `${id}.git`);

  /** 要求要件だけのタスクを作り、要求要件の承認待ちにする（作業領域を用意済み）。 */
  async function submittedTask(
    options: {
      audit?: boolean;
      containerMounts?: ServiceDeps["containerMounts"];
      db?: string;
    } = {},
  ) {
    const activity = new SqliteActivityStore(options.db ?? dbPath);
    const made = makeService(activity, [], {
      planner: onlyRequirements,
      ...(options.audit ? { audit: true } : {}),
      ...(options.containerMounts ? { containerMounts: options.containerMounts } : {}),
    });
    made.executor.respond = (invocation) =>
      isSurvey(invocation)
        ? out(
            `\`\`\`json\n${JSON.stringify({ "sacty-audit-survey": { summary: "要約", concerns: [] } })}\n\`\`\``,
          )
        : out("# 要求要件");
    const { id } = made.service.createTask({ projectId: "default", title: "決済API", body: "" });
    await made.service.runNext(id);
    expect(existsSync(workspaceOf(id))).toBe(true);
    expect(existsSync(gitDirOf(id))).toBe(true);
    return { ...made, activity, id };
  }

  it("監査しないタスクは、完了したときに作業領域と退避した git のメタデータを消す", async () => {
    const { service, id } = await submittedTask();
    service.approve(id, { step: "requirements", submission: 1 });
    // 完了の追記で消し始めたものを、消し終わるまで待つ（新しくは消し始めない）
    await service.workspaceCleanupsSettled();
    expect(existsSync(workspaceOf(id))).toBe(false);
    expect(existsSync(gitDirOf(id))).toBe(false);
  });

  it("監査するタスクは、監査が終わるまで残し、監査を終えた実行の終わりに消す", async () => {
    const { service, id } = await submittedTask({ audit: true });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.workspaceCleanupsSettled();
    // 監査の大まかな監査は、実装の作業領域の写しを読む
    expect(existsSync(workspaceOf(id))).toBe(true);
    await service.runNext(id); // 大まかな監査
    await service.workspaceCleanupsSettled();
    expect(existsSync(workspaceOf(id))).toBe(true);
    await service.runNext(id); // 懸念が無いので完了
    expect(service.get(id)?.task.audit?.completedAt).toBeDefined();
    await service.workspaceCleanupsSettled();
    expect(existsSync(workspaceOf(id))).toBe(false);
    expect(existsSync(gitDirOf(id))).toBe(false);
  });

  it("完了していないタスク・動いているコンテナがマウントしている作業領域は消さない", async () => {
    const { service, id } = await submittedTask();
    await service.workspaceCleanupsSettled();
    expect(existsSync(workspaceOf(id))).toBe(true);
    // 完了しても、動いているコンテナがマウントしていれば残す。Docker に問い合わせられなくても残す
    for (const reachable of [true, false]) {
      let mounted = "";
      const other = await submittedTask({
        containerMounts: async () => (reachable ? [mounted] : undefined),
        db: join(dir, `other-${reachable}.db`),
      });
      mounted = join(workspaceOf(other.id), "repo");
      other.service.approve(other.id, { step: "requirements", submission: 1 });
      await other.service.workspaceCleanupsSettled();
      // 作業領域と退避した git のメタデータは、片方がマウントと重なれば両方残す
      expect(existsSync(workspaceOf(other.id)), String(reachable)).toBe(true);
      expect(existsSync(gitDirOf(other.id)), String(reachable)).toBe(true);
      other.activity.close();
    }
  });

  it("完了の後に消した作業領域は、質問に答えるときに同じ起点で用意し直し、答えた後にまた消す", async () => {
    const { service, repos, executor, id } = await submittedTask();
    service.approve(id, { step: "requirements", submission: 1 });
    await service.workspaceCleanupsSettled();
    expect(existsSync(gitDirOf(id))).toBe(false);
    executor.respond = () => out("完了しています。");
    await service.askQuestion(id, { text: "どうなった？" }).answered;
    expect(service.get(id)?.task.questions[0]?.answer?.text).toBe("完了しています。");
    expect(repos.prepared.at(-1)).toMatchObject({ recorded: "base123" });
    await service.workspaceCleanupsSettled();
    expect(existsSync(workspaceOf(id))).toBe(false);
    expect(existsSync(gitDirOf(id))).toBe(false);
  });

  it("作業領域と退避した git のメタデータが両方とも無ければ、完了していないタスクでも質問の前に用意し直す", async () => {
    // 消した後に再レビューなどで実行待ちに戻り、工程の準備の前に質問したとき（PBI-157 レビュー指摘）
    const { service, repos, executor, id } = await submittedTask();
    rmSync(workspaceOf(id), { recursive: true, force: true });
    rmSync(gitDirOf(id), { recursive: true, force: true });
    const prepared = repos.prepared.length;
    executor.respond = () => out("承認待ちです。");
    await service.askQuestion(id, { text: "いまは？" }).answered;
    expect(service.get(id)?.task.questions[0]?.answer?.text).toBe("承認待ちです。");
    expect(repos.prepared).toHaveLength(prepared + 1);
    // 完了していないので、答えた後も消さない
    await service.workspaceCleanupsSettled();
    expect(existsSync(gitDirOf(id))).toBe(true);
    // 片方だけ残っているときは、これまでどおり用意し直さない（作業中の変更を消さない）
    rmSync(gitDirOf(id), { recursive: true, force: true });
    await service.askQuestion(id, { text: "もう一度" }).answered;
    expect(repos.prepared).toHaveLength(prepared + 1);
  });

  it("同じタスクの作業領域の用意は、1つずつにする", async () => {
    const { service, repos, id } = await submittedTask();
    rmSync(workspaceOf(id), { recursive: true, force: true });
    rmSync(gitDirOf(id), { recursive: true, force: true });
    const gate = Promise.withResolvers<void>();
    repos.prepareGate = gate.promise;
    const svc = service as unknown as {
      prepareRepository: (task: Task, config: unknown) => Promise<{ ok: boolean }>;
    };
    const task = service.get(id)?.task as Task;
    const loaded = configOf(agent())();
    if (!loaded.ok) throw new Error("config");
    const prepared = repos.prepared.length;
    const first = svc.prepareRepository(task, loaded.config);
    const second = svc.prepareRepository(task, loaded.config);
    gate.resolve();
    repos.prepareGate = undefined;
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    // 後の用意は、先の用意が終わってから確かめるので、clone し直さない
    expect(repos.prepared).toHaveLength(prepared + 1);
  });

  it("中止時と起動時に中止済みタスクの準備中の印を消す", async () => {
    const { service, activity, id } = await submittedTask();
    const marker = `${gitDirOf(id)}.preparing`;
    writeFileSync(marker, "");
    await service.cancel(id);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(marker, "");
    await service.cleanupWorkspacesAtStartup();
    expect(existsSync(marker)).toBe(false);
    activity.close();
  });

  it("起動時に、残った実行ごとの一時領域と、もう使わない・どのタスクのものでもない作業領域を消す", async () => {
    const { service, id: open } = await submittedTask();
    const runIds = Object.fromEntries(
      [
        "_code-copy",
        "_guardian",
        "_snapshots",
        "_review",
        "_input",
        "_repos",
        "_audit-logs",
        "_audit-ledger",
      ].map((name) => [name, randomUUID()]),
    );
    for (const [name, runId] of Object.entries(runIds)) {
      mkdirSync(join(root(), name, runId, "src"), { recursive: true });
      writeFileSync(join(root(), name, runId, "src", "a.ts"), "x");
    }
    // ID の形でない名前・キャッシュ・作業履歴は消さない
    mkdirSync(join(root(), "_guardian", "not-a-run"), { recursive: true });
    mkdirSync(join(root(), "_cache", "shared-compose"), { recursive: true });
    mkdirSync(join(dir, "runs", randomUUID()), { recursive: true });
    // リンクの先はたどらない（リンクだけを消す）
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    const linkRun = randomUUID();
    symlinkSync(outside, join(root(), "_snapshots", linkRun));
    // どのタスクのものでもない作業領域と、退避した git のメタデータ
    const orphan = randomUUID();
    mkdirSync(join(root(), orphan, "repo"), { recursive: true });
    mkdirSync(join(root(), "_git", `${orphan}.git`), { recursive: true });

    const markerOnly = randomUUID();
    writeFileSync(join(root(), "_git", `${markerOnly}.git.preparing`), "");
    const removed = await service.cleanupWorkspacesAtStartup();
    expect(existsSync(join(root(), "_git", `${markerOnly}.git.preparing`))).toBe(false);
    for (const [name, runId] of Object.entries(runIds)) {
      expect(existsSync(join(root(), name, runId)), name).toBe(false);
    }
    expect(existsSync(join(root(), "_snapshots", linkRun))).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(root(), orphan))).toBe(false);
    expect(existsSync(join(root(), "_git", `${orphan}.git`))).toBe(false);
    expect(removed).toBe(8 + 1 + 2 + 1);
    expect(existsSync(join(root(), "_guardian", "not-a-run"))).toBe(true);
    expect(existsSync(join(root(), "_cache", "shared-compose"))).toBe(true);
    expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
    // 完了していないタスクの作業領域は残す
    expect(existsSync(workspaceOf(open))).toBe(true);
    expect(existsSync(gitDirOf(open))).toBe(true);
  });

  it("起動時の片付けの間も API は応答し、片付けの間に始まった実行・作ったタスクのものは消さない（PBI-157 レビュー指摘）", async () => {
    const held = Promise.withResolvers<string[]>();
    const { service, id } = await submittedTask({ containerMounts: () => held.promise });
    const stale = randomUUID();
    mkdirSync(join(root(), "_guardian", stale), { recursive: true });
    const cleanup = service.cleanupWorkspacesAtStartup();
    // 問い合わせを待っている間に、質問のログ・新しいタスクの作業領域ができた
    const fresh = randomUUID();
    mkdirSync(join(root(), "_question-logs", fresh), { recursive: true });
    const newTask = randomUUID();
    mkdirSync(join(root(), newTask, "repo"), { recursive: true });
    const res = await createApp(service, "tok").request(`/api/tasks/${id}`, {
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    held.resolve([]);
    expect(await cleanup).toBe(1);
    expect(existsSync(join(root(), "_guardian", stale))).toBe(false);
    expect(existsSync(join(root(), "_question-logs", fresh))).toBe(true);
    expect(existsSync(join(root(), newTask))).toBe(true);
  });

  it("起動時に、_git がリンクでも、リンクの先は消さない", async () => {
    const { service } = await submittedTask();
    const outside = join(dir, "outside-git");
    const orphan = randomUUID();
    mkdirSync(join(outside, `${orphan}.git`), { recursive: true });
    writeFileSync(join(outside, `${orphan}.git`, "HEAD"), "keep");
    rmSync(join(root(), "_git"), { recursive: true, force: true });
    symlinkSync(outside, join(root(), "_git"));
    // 作業領域の根の直下の ID から、リンクの下の <ID>.git を消そうとしない
    mkdirSync(join(root(), orphan, "repo"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await service.cleanupWorkspacesAtStartup();
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(join(outside, `${orphan}.git`, "HEAD"), "utf8")).toBe("keep");
    expect(existsSync(join(root(), orphan))).toBe(false);
  });

  it("起動時に、動いているコンテナがマウントしているもの・停止を確かめられなかった実行のものは消さない", async () => {
    const mounted = randomUUID();
    const unconfirmed = randomUUID();
    const mounts = [join(root(), "_guardian", mounted), join(root(), "_repos", mounted, "repo")];
    const { service, id } = await submittedTask({ containerMounts: async () => mounts });
    for (const runId of [mounted, unconfirmed]) {
      mkdirSync(join(root(), "_guardian", runId), { recursive: true });
      mkdirSync(join(root(), "_repos", runId), { recursive: true });
    }
    // 停止を確かめられなかった実行（運用の工程の中断など）は、タスクの状態に残る
    const task = service.get(id)?.task;
    if (task) task.unstoppedRuns = [unconfirmed];
    await service.cleanupWorkspacesAtStartup();
    expect(existsSync(join(root(), "_guardian", mounted))).toBe(true);
    expect(existsSync(join(root(), "_guardian", unconfirmed))).toBe(true);
    expect(existsSync(join(root(), "_repos", mounted))).toBe(true);
    expect(existsSync(join(root(), "_repos", unconfirmed))).toBe(true);
  });

  it("起動時に、このリリースより前に完了したタスクの作業領域を、同じ基準で消す", async () => {
    const done = await submittedTask({ audit: true });
    done.service.approve(done.id, { step: "requirements", submission: 1 });
    // 監査の途中は残す
    expect(await done.service.cleanupWorkspacesAtStartup()).toBe(0);
    expect(existsSync(workspaceOf(done.id))).toBe(true);
    await done.service.runNext(done.id);
    await done.service.runNext(done.id);
    await done.service.workspaceCleanupsSettled();
    done.activity.close();
    // 監査が終わった後、消す前に止まった（このリリースより前に完了した）ものとして、作業領域を作り直して起動し直す
    mkdirSync(join(workspaceOf(done.id), "repo"), { recursive: true });
    mkdirSync(gitDirOf(done.id), { recursive: true });
    const restarted = makeService(new SqliteActivityStore(dbPath), [], { audit: true });
    expect(await restarted.service.cleanupWorkspacesAtStartup()).toBe(2);
    expect(existsSync(workspaceOf(done.id))).toBe(false);
    expect(existsSync(gitDirOf(done.id))).toBe(false);
  });

  it("問い合わせられない・1つを消せないときも、理由をログに残して続ける", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = randomUUID();
      const removable = randomUUID();
      mkdirSync(join(root(), "_guardian", failing), { recursive: true });
      mkdirSync(join(root(), "_guardian", removable), { recursive: true });
      // 問い合わせられないときは消さずに、理由を残す
      const blind = makeService(new SqliteActivityStore(join(dir, "blind.db")), [], {
        containerMounts: async () => {
          throw new Error("docker: not found");
        },
      });
      expect(await blind.service.cleanupWorkspacesAtStartup()).toBe(0);
      expect(existsSync(join(root(), "_guardian", failing))).toBe(true);
      expect(warn.mock.calls.flat().join("\n")).toContain("確かめられない");
      // 1つを消せなくても、もう1つは消す
      const activity = new SqliteActivityStore(join(dir, "partial.db"));
      const service = new TaskService({
        ...(makeService(activity).service as unknown as { deps: ServiceDeps }).deps,
        removeWorkspaceEntry: async (base, path) => {
          if (path.endsWith(failing)) throw new Error("EACCES: permission denied");
          return removeEntry(base, path);
        },
      });
      expect(await service.cleanupWorkspacesAtStartup()).toBe(1);
      expect(existsSync(join(root(), "_guardian", failing))).toBe(true);
      expect(existsSync(join(root(), "_guardian", removable))).toBe(false);
      expect(warn.mock.calls.flat().join("\n")).toContain(
        `作業領域を消せませんでした：${join(root(), "_guardian", failing)}：EACCES`,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("タスクごとの依存のキャッシュ（PBI-319）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const root = () => join(dir, "workspaces");
  const cacheOf = (id: string) => join(root(), "_task-cache", id);

  /** 要求要件だけのタスクを作り、要求要件の承認待ちにする。実行の間に、キャッシュに置いてあったものを記録する。 */
  async function submittedTask(db = dbPath) {
    const activity = new SqliteActivityStore(db);
    const made = makeService(activity, [], {
      planner: async () => ({
        steps: ["requirements" as const],
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    const seen: (string[] | undefined)[] = [];
    made.executor.respond = (invocation) => {
      // 依存のインストールの代わりに、キャッシュに書く
      if (invocation.taskCache) {
        seen.push(readdirSync(invocation.taskCache).sort());
        writeFileSync(join(invocation.taskCache, `pkg-${seen.length}`), "downloaded");
      } else {
        seen.push(undefined);
      }
      return out("# 要求要件");
    };
    const { id } = made.service.createTask({ projectId: "default", title: "決済API", body: "" });
    await made.service.runNext(id);
    return { ...made, activity, id, seen };
  }

  it("工程の実行は、同じタスクでは同じキャッシュを使い回し、別のタスクとは分ける", async () => {
    const { service, executor, id, seen } = await submittedTask();
    expect(executor.calls[0]?.taskCache).toBe(cacheOf(id));
    // キャッシュを渡す実行には、使い方の案内を指示に足す
    expect(executor.calls[0]?.command.join(" ")).toContain("## 依存のキャッシュ");
    // 差し戻して出し直した実行は、前の実行が置いたものを使う
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["直して"] });
    await service.runNext(id);
    expect(executor.calls[1]?.taskCache).toBe(cacheOf(id));
    expect(seen).toEqual([[], ["pkg-1"]]);
    // 別のタスクは、別の空のキャッシュ
    const other = await submittedTask(join(dir, "other.db"));
    expect(other.executor.calls[0]?.taskCache).toBe(cacheOf(other.id));
    expect(other.seen).toEqual([[]]);
    other.activity.close();
  });

  it("タスクのリポジトリを扱わない実行（質問への答え）には渡さない", async () => {
    const { service, executor, id } = await submittedTask();
    executor.respond = () => out("承認待ちです。");
    await service.askQuestion(id, { text: "いまは？" }).answered;
    expect(executor.calls.at(-1)?.taskCache).toBeUndefined();
    expect(executor.calls.at(-1)?.env.XDG_CACHE_HOME).toBeUndefined();
    expect(executor.calls.at(-1)?.command.join(" ")).not.toContain("## 依存のキャッシュ");
  });

  it("完了したら消す", async () => {
    const { service, id } = await submittedTask();
    expect(existsSync(cacheOf(id))).toBe(true);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.workspaceCleanupsSettled();
    expect(existsSync(cacheOf(id))).toBe(false);
  });

  it("中止したら消し、片付けの結果に作業領域として含める", async () => {
    const { service, id } = await submittedTask();
    expect(service.cleanupPlan(id)?.find((c) => c.target === "workspace")?.present).toBe(true);
    await service.cancel(id);
    expect(existsSync(cacheOf(id))).toBe(false);
    // 作業領域が先に無くても、キャッシュが残っていれば消す
    const other = await submittedTask(join(dir, "other.db"));
    rmSync(join(root(), other.id), { recursive: true, force: true });
    rmSync(join(root(), "_git", `${other.id}.git`), { recursive: true, force: true });
    expect(
      other.service.cleanupPlan(other.id)?.find((c) => c.target === "workspace")?.present,
    ).toBe(true);
    const cancelled = await other.service.cancel(other.id);
    expect(existsSync(cacheOf(other.id))).toBe(false);
    expect(cancelled.cancelled?.cleanup).toContainEqual({ target: "workspace", result: "done" });
    other.activity.close();
  });

  it("起動時に、どのタスクのものでもない・中止したタスクのキャッシュを消し、進行中のタスクのものは残す", async () => {
    const { service, activity, id: open } = await submittedTask();
    const { id: cancelled } = service.createTask({ projectId: "default", title: "請求", body: "" });
    await service.runNext(cancelled);
    await service.cancel(cancelled);
    activity.close();
    // 中止の片付けの途中で止まった（キャッシュが残った）ものとして、作り直して起動し直す
    mkdirSync(join(cacheOf(cancelled), "pip"), { recursive: true });
    const orphan = randomUUID();
    mkdirSync(join(cacheOf(orphan), "pip"), { recursive: true });
    // ID の形でない名前は消さない
    mkdirSync(join(root(), "_task-cache", "not-a-task"), { recursive: true });
    const restarted = makeService(new SqliteActivityStore(dbPath));
    expect(await restarted.service.cleanupWorkspacesAtStartup()).toBe(2);
    expect(existsSync(cacheOf(cancelled))).toBe(false);
    expect(existsSync(cacheOf(orphan))).toBe(false);
    expect(existsSync(join(root(), "_task-cache", "not-a-task"))).toBe(true);
    // 進行中のタスクのキャッシュは、再起動しても使い回す
    expect(readdirSync(cacheOf(open))).toEqual(["pkg-1"]);
  });

  it("起動時に、中止したタスクの作業領域がマウントされていれば、キャッシュも消さない（PBI-319 レビュー指摘）", async () => {
    const { service, activity, id } = await submittedTask();
    await service.cancel(id);
    activity.close();
    // 中止の片付けで消せなかった作業領域を、動いているコンテナがまだマウントしている
    mkdirSync(join(root(), id, "repo"), { recursive: true });
    mkdirSync(join(cacheOf(id), "pip"), { recursive: true });
    const mounted = [join(root(), id, "repo")];
    const restarted = makeService(new SqliteActivityStore(dbPath), [], {
      containerMounts: async () => mounted,
    });
    expect(await restarted.service.cleanupWorkspacesAtStartup()).toBe(0);
    expect(existsSync(cacheOf(id))).toBe(true);
    // マウントが無くなれば、次の起動で消す
    mounted.length = 0;
    expect(await restarted.service.cleanupWorkspacesAtStartup()).toBe(1);
    expect(existsSync(cacheOf(id))).toBe(false);
  });

  it("キャッシュが壊れていたら作り直し、用意できなければキャッシュを使わずに実行する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 壊れた（ファイルになった）キャッシュは作り直す
      const first = await submittedTask();
      rmSync(cacheOf(first.id), { recursive: true });
      writeFileSync(cacheOf(first.id), "broken");
      first.service.requestChanges(first.id, {
        step: "requirements",
        submission: 1,
        comments: ["直して"],
      });
      await first.service.runNext(first.id);
      expect(first.executor.calls.at(-1)?.taskCache).toBe(cacheOf(first.id));
      expect(first.seen.at(-1)).toEqual([]);
      // キャッシュの根がリンクなら、使わずに進める（リンクの先には書かない）
      const outside = join(dir, "outside");
      mkdirSync(outside);
      rmSync(join(root(), "_task-cache"), { recursive: true, force: true });
      symlinkSync(outside, join(root(), "_task-cache"));
      const second = await submittedTask(join(dir, "second.db"));
      expect(second.executor.calls[0]?.taskCache).toBeUndefined();
      expect(second.service.get(second.id)?.task.status).toBe("awaiting_approval");
      expect(readdirSync(outside)).toEqual([]);
      expect(warn.mock.calls.flat().join("\n")).toContain("キャッシュを使わずに実行します");
      second.activity.close();
    } finally {
      warn.mockRestore();
    }
  });
});
