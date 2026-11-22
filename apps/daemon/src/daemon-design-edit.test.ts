import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepKey, Task } from "@sacty/core";
import { isSecurityTask, MVP_STEPS, project } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult } from "./config.js";
import type { PullRequestFeedback } from "./github.js";
import { MemoryProjectStore } from "./projects.js";
import { buildPrompt, buildReworkPrompt } from "./prompts.js";
import type { ServiceDeps, TaskService } from "./service.js";
import type { MemorySettingsStore } from "./settings.js";
import {
  dbPath,
  FakeContexts,
  type FakeExecutor,
  FakeGitHub,
  FakePulls,
  FakeRepos,
  makeService,
  noticesSettled,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

describe("実装の PR の局所の設計の直しと、設計に戻した知らせ（PBI-446）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const design = (title = "# 設計") =>
    out(
      [
        title,
        block({
          "sacty-test-viewpoints": [
            { title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
          ],
        }),
      ].join("\n\n"),
    );
  const implement = (
    text = "# 実装の説明",
    map: { viewpointId: string; tests: string[] }[] = [
      { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
    ],
  ) => out([text, block({ "sacty-test-map": map })].join("\n\n"));
  const rework = (target: string, reason = "理由") =>
    out(block({ "sacty-rework": { target, reason } }));
  const at = "2026-10-11T00:00:00Z";
  /** 最後のフィードバックから、書き終わるのを待つ時間がたった時刻。 */
  const later = () => Date.parse(at) + 3 * 60_000;
  const item = (key: string, patch: Partial<PullRequestFeedback> = {}): PullRequestFeedback => ({
    key,
    kind: "comment",
    author: "reviewer",
    at,
    body: "受け入れ条件が曖昧",
    ...patch,
  });
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;
  const taskBranchOf = (id: string) => `sacty/task-${id.slice(0, 8)}`;
  const docOf = (id: string, step: string, dir = "docs/sacty") =>
    `${dir}/${id.slice(0, 8)}/${step}.md`;

  async function drain(service: TaskService, max = 12) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  type Made = Awaited<ReturnType<typeof start>>;
  type Planned = Awaited<ReturnType<NonNullable<ServiceDeps["planner"]>>>;

  /** 要求要件・設計を PR で承認する設定で、タスクを作って最初の工程まで進める。 */
  async function start(
    outcomes: AgentOutcome[],
    options: {
      steps?: StepKey[];
      documentsDir?: string;
      exports?: Planned["exports"];
      pulls?: FakePulls;
      repos?: FakeRepos;
      projects?: MemoryProjectStore;
      contexts?: ServiceDeps["contexts"];
      config?: () => ConfigResult;
      gateway?: ServiceDeps["gateway"];
      db?: string;
      settings?: MemorySettingsStore;
      github?: FakeGitHub;
      secrets?: Record<string, string>;
      /** 工程の選び方（無ければ、どのタスクも steps の工程にする）。 */
      planner?: ServiceDeps["planner"];
      /** PR の CI の読み取り（PR のレビューの子タスクに渡す）。渡すと、実装の PR をドラフトで作る。 */
      ci?: ServiceDeps["ci"];
      /** sacty が作った PR をレビューする子タスクを作る（PBI-330）。 */
      reviewTasks?: boolean;
      /** 情報収集を差し替える（無ければ、集めずに進める）。 */
      gatherer?: ServiceDeps["gatherer"];
      /** レビューの子タスクが CI を読むのを待つ上限（ミリ秒。PBI-331）。 */
      reviewCiTimeoutMs?: number;
      /** ドラフトを外す・戻す・先頭を読む答えを待つ上限（ミリ秒。PBI-331）。 */
      draftTimeoutMs?: number;
      /** 実装を始める前に、ベースブランチの最新を作業領域に取り込む（既定は取り込まない）。 */
      mergeBase?: boolean;
      /** 今の時刻（無ければ、PR の指摘を書き終わるのを待つ時間がたった時刻）。 */
      now?: () => number;
      /** 知らせのタスクの画面の URL（SACTY_WEB_URL）。 */
      webUrl?: string;
    } = {},
  ) {
    const activity = new SqliteActivityStore(options.db ?? dbPath);
    const pulls = options.pulls ?? new FakePulls();
    const repos = options.repos ?? new FakeRepos();
    const made = makeService(activity, outcomes, {
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.webUrl !== undefined ? { webUrl: options.webUrl } : {}),
      ...(options.github ? { github: options.github } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      stepPullRequests: true,
      ...(options.ci ? { ci: options.ci, draftPullRequests: true } : {}),
      ...(options.reviewTasks ? { reviewTasks: true } : {}),
      ...(options.mergeBase ? { mergeBase: true } : {}),
      ...(options.gatherer ? { gatherer: options.gatherer } : {}),
      ...(options.reviewCiTimeoutMs ? { reviewCiTimeoutMs: options.reviewCiTimeoutMs } : {}),
      ...(options.draftTimeoutMs ? { draftTimeoutMs: options.draftTimeoutMs } : {}),
      now: options.now ?? later,
      pulls,
      repos,
      ...(options.projects ? { projects: options.projects } : {}),
      ...(options.contexts ? { contexts: options.contexts } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.gateway ? { gateway: options.gateway } : {}),
      planner:
        options.planner ??
        (async () => ({
          steps: [...(options.steps ?? MVP_STEPS)],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
          ...(options.documentsDir ? { documentsDir: options.documentsDir } : {}),
          ...(options.exports ? { exports: options.exports } : {}),
        })),
    });
    const { id } = made.service.createTask({
      projectId: "default",
      title: "決済API",
      body: "タスクの本文",
    });
    await made.service.runNext(id);
    return { activity, ...made, id };
  }

  /** 工程の PR を、GitHub でマージしたことにする（タスクブランチは、マージのコミットに進む）。 */
  async function merge(made: Pick<Made, "service" | "pulls" | "repos" | "id">, step: StepKey) {
    const { service, pulls, repos, id } = made;
    const task = taskOf(service, id);
    const pr =
      step === "implement"
        ? { number: task.pullRequest?.number ?? 0, commit: task.pullRequest?.commit }
        : task.stepPullRequests.findLast((p) => p.step === step);
    if (!pr) throw new Error(`no pull request for ${step}`);
    pulls.states[pr.number] = { state: "merged", mergedBy: "reviewer", headSha: pr.commit };
    repos.remote[taskBranchOf(id)] = `m${pr.number}`.padEnd(40, "0");
    await service.checkPullRequests();
  }

  const DESIGN = [
    "# 設計",
    "",
    "## スコープ",
    "",
    "決済 API を作る。",
    "",
    "## エラー表",
    "",
    "- 決済失敗：「失敗しました」",
    "- 在庫切れ：「在庫がありません」",
    "",
    "## 既定で決めたこと",
    "",
    "- 再送は 1 回",
  ].join("\n");
  const designText = () => design(DESIGN);
  const edit = (
    remarks: string[],
    before: string,
    after: string,
    extra: Record<string, unknown> = {},
  ) => ({
    remarks,
    before,
    after,
    reason: "指摘の文言に合わせる",
    sensitive: false,
    ...extra,
  });
  const withEdits = (edits: unknown[], text = "# 実装の説明 v2") =>
    out(
      [
        text,
        block({
          "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
        }),
        block({ "sacty-design-edit": { edits } }),
      ].join("\n\n"),
    );

  /** 設計まで承認し、実装の PR の指摘（局所の変更）を、実装の工程で直させる回の直前まで進める。 */
  async function toRework(
    next: AgentOutcome[],
    options: {
      remark?: string;
      reason?: string;
      target?: string;
      start?: Parameters<typeof start>[1];
    } = {},
  ) {
    const made = await start(
      [
        out("# 要求要件 v1"),
        designText(),
        implement(),
        rework(
          options.target ?? "implement",
          options.reason ?? "決定を変える（局所）：エラー表の1行の文言を直すだけ",
        ),
        ...next,
      ],
      options.start,
    );
    const { service, pulls, id } = made;
    await merge(made, "requirements");
    await service.runNext(id);
    await merge(made, "design");
    await drain(service);
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 1 });
    pulls.feedbackBy[9] = [
      item("comment:30", {
        body: options.remark ?? "エラー表の決済失敗の文言を「決済に失敗しました」にしてください",
      }),
    ];
    await service.checkPullRequests();
    return made;
  }

  const bodiesOf = (svc: TaskService, id: string) =>
    Object.values(taskOf(svc, id).pullRequestBodies ?? {});
  const designPath = (id: string) => docOf(id, "design");
  const eventsOf = (made: { activity: SqliteActivityStore; id: string }) =>
    made.activity.forTask(made.id);

  it("作業領域の要求要件の直しを PR のコミットと本文に残す", async () => {
    const made = await toRework([implement(), rework("implement"), implement()]);
    const { service, id, repos, executor, activity, pulls } = made;
    const path = docOf(id, "requirements");
    const head = repos.remote[taskBranchOf(id)] ?? "";
    repos.files[head] = { ...repos.files[head], [path]: "# 要求要件\n\n[この指摘](URL)\n" };
    const run = executor.run.bind(executor);
    let changed = false;
    let codeChanged = false;
    executor.run = async (input) => {
      if (!changed && input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        const before = readFileSync(file, "utf8");
        writeFileSync(file, before.replace("[この指摘](URL)", "`[この指摘](URL)`"));
        executor.respond = () =>
          out(
            [
              "# 変更",
              block({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › test"] }] }),
              block({ "sacty-document-fixes": [{ path, reason: "リンクの誤りを修正" }] }),
            ].join("\n\n"),
          );
        changed = true;
      } else if (changed && !codeChanged && input.workspaceDir.endsWith("/repo")) {
        writeFileSync(
          join(input.workspaceDir, "second-change.js"),
          "export const changed = true;\n",
        );
        codeChanged = true;
      }
      return run(input);
    };
    await service.runNext(id);
    executor.respond = undefined;
    await drain(service);
    expect(changed).toBe(true);
    expect(repos.files[repos.remote[taskBranchOf(id)] ?? ""]?.[path]).toContain(
      "`[この指摘](URL)`",
    );
    const body = bodiesOf(service, id).at(-1) ?? "";
    expect(body).toContain(path);
    expect(body).toContain("リンクの誤りを修正");
    expect(body).toContain("+`[この指摘](URL)`");
    expect(body).toContain("  ```diff\n  --- ");
    expect(body).toContain("  +`[この指摘](URL)`\n  ```");
    pulls.feedbackBy[9] = [item("comment:31", { body: "コードを直してください" })];
    const previousPushes = repos.published.length;
    const previousCalls = pulls.calls.length;
    await service.checkPullRequests();
    await service.runNext(id);
    await drain(service);
    expect(codeChanged).toBe(true);
    expect(repos.published.length).toBeGreaterThan(previousPushes);
    expect(repos.published.at(-1)?.overrides?.[path]).toBeUndefined();
    expect(pulls.calls.length).toBeGreaterThan(previousCalls);
    const laterBody = pulls.calls.at(-1)?.body ?? "";
    expect(laterBody).toContain(path);
    expect(laterBody).toContain("リンクの誤りを修正");
    expect(laterBody).toContain("+`[この指摘](URL)`");
    activity.close();
  });

  it("要求要件と設計を実装の実行時にタスクブランチから配置する", async () => {
    const made = await start([out("# 要求要件"), designText(), implement()]);
    const { service, id, repos, executor, activity } = made;
    await merge(made, "requirements");
    await service.runNext(id);
    await merge(made, "design");
    const head = repos.remote[taskBranchOf(id)] ?? "";
    const paths = [docOf(id, "requirements"), docOf(id, "design")];
    const expected = await Promise.all(paths.map((path) => repos.readFile("", head, path)));
    const run = executor.run.bind(executor);
    let seen: (string | undefined)[] = [];
    executor.run = async (input) => {
      if (input.workspaceDir.endsWith("/repo")) {
        seen = paths.map((path) => readFileSync(join(input.workspaceDir, path), "utf8"));
      }
      return run(input);
    };
    await service.runNext(id);
    expect(seen).toEqual(expected);
    expect(seen).toHaveLength(2);
    activity.close();
  });

  it("離れた文書の修正は間の変更していない行で埋めずに差分に残す", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = docOf(id, "requirements");
    const head = repos.remote[taskBranchOf(id)] ?? "";
    const lines = Array.from({ length: 100 }, (_, i) => `行 ${i}`);
    repos.files[head] = { ...repos.files[head], [path]: `${lines.join("\n")}\n` };
    const run = executor.run.bind(executor);
    executor.run = async (input) => {
      if (input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        writeFileSync(
          file,
          readFileSync(file, "utf8")
            .replace("行 1\n", "最初の修正\n")
            .replace("行 98\n", "最後の修正\n"),
        );
      }
      return run(input);
    };
    await service.runNext(id);
    await drain(service);
    const diff = taskOf(service, id).documentFixes?.at(-1)?.diff ?? "";
    expect(diff).toContain("+最初の修正");
    expect(diff).toContain("+最後の修正");
    expect(diff).not.toContain("行 50");
    activity.close();
  });

  it("利用者の Git 設定と環境変数を分離して文書の修正を公開する", async () => {
    const made = await toRework([implement()]);
    const { service, id, executor, activity } = made;
    const path = docOf(id, "requirements");
    const run = executor.run.bind(executor);
    executor.run = async (input) => {
      if (input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        writeFileSync(file, `${readFileSync(file, "utf8")}\n修正済み\n`);
      }
      return run(input);
    };
    const previous = [
      process.env.GIT_CONFIG_COUNT,
      process.env.GIT_CONFIG_KEY_0,
      process.env.GIT_CONFIG_VALUE_0,
    ];
    try {
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "diff.orderFile";
      process.env.GIT_CONFIG_VALUE_0 = "missing-order-file";
      await service.runNext(id);
      await drain(service);
      expect(taskOf(service, id).documentFixes?.at(-1)?.diff).toContain("+修正済み");
      expect(bodiesOf(service, id).at(-1)).toContain("+修正済み");
    } finally {
      for (const [i, key] of [
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
      ].entries()) {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      }
      activity.close();
    }
  });

  it("文書の配置前の取得は一時停止で中断され、再開後に実装できる", async () => {
    const made = await toRework([implement(), implement()]);
    const { service, id, repos, activity } = made;
    let observed = false;
    let pause: Promise<unknown> | undefined;
    repos.onFetchBranch = async (signal) => {
      if (!signal || observed) return;
      observed = true;
      pause = service.pause(id);
      if (signal.aborted) throw new Error("aborted");
    };
    await service.runNext(id);
    await pause;
    expect(observed).toBe(true);
    expect(taskOf(service, id).status).toBe("paused");
    repos.onFetchBranch = undefined;
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).pullRequest).toBeDefined();
    activity.close();
  });

  it("文書の配置前の取得は中止でも中断される", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, activity } = made;
    let cancellation: Promise<unknown> | undefined;
    repos.onFetchBranch = async (signal) => {
      if (!signal || cancellation) return;
      cancellation = service.cancel(id);
      if (signal.aborted) throw new Error("aborted");
    };
    await service.runNext(id);
    await cancellation;
    expect(cancellation).toBeDefined();
    expect(taskOf(service, id).status).toBe("cancelled");
    activity.close();
  });

  it("公開時のタスクブランチ取得も一時停止で中断し、再開できる", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, activity } = made;
    await service.runNext(id);
    let pause: Promise<unknown> | undefined;
    repos.onFetchBranch = async (signal) => {
      if (!signal || pause) return;
      pause = service.pause(id);
      if (signal.aborted) throw new Error("aborted");
    };
    await drain(service);
    await pause;
    expect(pause).toBeDefined();
    expect(taskOf(service, id).status).toBe("paused");
    repos.onFetchBranch = undefined;
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).status).not.toBe("paused");
    activity.close();
  });

  it("未完了の続きでも公開前の文書の直しを残す", async () => {
    const made = await toRework([implement(), implement(), implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = docOf(id, "requirements");
    const run = executor.run.bind(executor);
    let round = 0;
    executor.run = async (input) => {
      if (input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        round++;
        if (round === 1) {
          writeFileSync(file, `${readFileSync(file, "utf8")}\n続きに残す修正\n`);
          executor.respond = () =>
            out('作業中\n```sacty-completion\n{"status":"incomplete","remaining":["確認"]}\n```');
        } else if (round === 2) {
          expect(readFileSync(file, "utf8")).toContain("続きに残す修正");
          writeFileSync(file, `${readFileSync(file, "utf8")}続きで進めた修正\n`);
          executor.respond = () =>
            out('作業中\n```sacty-completion\n{"status":"incomplete","remaining":["確認"]}\n```');
        } else {
          expect(readFileSync(file, "utf8")).toContain("続きで進めた修正");
          executor.respond = () => implement();
        }
      }
      return run(input);
    };
    await service.runNext(id);
    await drain(service);
    expect(round).toBeGreaterThanOrEqual(3);
    expect(repos.published.at(-1)?.overrides?.[path]).toContain("続きに残す修正");
    activity.close();
  });

  it("同じ承認済み文書を人と実装が別々に直したら公開を止める", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = docOf(id, "requirements");
    const run = executor.run.bind(executor);
    let changed = false;
    executor.run = async (input) => {
      if (!changed && input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        writeFileSync(file, `${readFileSync(file, "utf8")}\n実装の修正\n`);
        const head = repos.remote[taskBranchOf(id)] ?? "";
        repos.files[head] = { ...repos.files[head], [path]: "人の修正\n" };
        changed = true;
      }
      return run(input);
    };
    const count = repos.published.length;
    await service.runNext(id);
    await drain(service);
    expect(repos.published).toHaveLength(count);
    const paused = eventsOf(made).findLast((e) => e.type === "TaskPaused");
    expect(JSON.stringify(paused)).toContain(path);
    expect(JSON.stringify(paused)).toContain("合わせてから再開");
    activity.close();
  });

  it("実装が直していない文書はタスクブランチの人の修正を引き継ぐ", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = designPath(id);
    const run = executor.run.bind(executor);
    let changed = false;
    executor.run = async (input) => {
      if (!changed && input.workspaceDir.endsWith("/repo")) {
        const head = repos.remote[taskBranchOf(id)] ?? "";
        repos.files[head] = { ...repos.files[head], [path]: "人が直した設計\n" };
        changed = true;
      }
      return run(input);
    };
    await service.runNext(id);
    await drain(service);
    const commit = repos.remote[taskBranchOf(id)] ?? "";
    expect(repos.files[commit]?.[path]).toBe("人が直した設計\n");
    expect(bodiesOf(service, id).at(-1)).not.toContain("承認済みの文書の直し");
    activity.close();
  });

  it("控えと作業領域の文書がない提出では承認済み文書を削除しない", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const paths = [docOf(id, "requirements"), designPath(id)];
    const originalHead = repos.remote[taskBranchOf(id)] ?? "";
    const original = await Promise.all(paths.map((path) => repos.readFile("", originalHead, path)));
    const run = executor.run.bind(executor);
    let removed = false;
    executor.run = async (input) => {
      if (!removed && input.workspaceDir.endsWith("/repo")) {
        for (const path of paths) {
          rmSync(join(input.workspaceDir, path));
          rmSync(
            join(
              repos.prepared[0]?.gitDir ?? "",
              "sacty-documents",
              Buffer.from(path).toString("hex"),
            ),
          );
        }
        removed = true;
      }
      return run(input);
    };
    await service.runNext(id);
    await drain(service);
    const commit = repos.remote[taskBranchOf(id)] ?? "";
    for (const [index, path] of paths.entries())
      expect(repos.files[commit]?.[path]).toBe(original[index]);
    expect(bodiesOf(service, id).at(-1)).not.toContain("承認済みの文書の直し");
    activity.close();
  });

  it("配置した文書をシンボリックリンクに替えると公開を止める", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = docOf(id, "requirements");
    const run = executor.run.bind(executor);
    let changed = false;
    executor.run = async (input) => {
      if (!changed && input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        rmSync(file);
        const outside = join(dirname(input.workspaceDir), "outside-document");
        writeFileSync(outside, "リンク先の内容");
        symlinkSync(outside, file);
        changed = true;
      }
      return run(input);
    };
    const count = repos.published.length;
    await service.runNext(id);
    await drain(service);
    expect(changed).toBe(true);
    expect(repos.published).toHaveLength(count);
    expect(JSON.stringify(repos.files)).not.toContain("リンク先の内容");
    expect(JSON.stringify(eventsOf(made).findLast((e) => e.type === "TaskPaused"))).toContain(path);
    activity.close();
  });

  it("文書の全文を伏せてから差分を作り、理由と差分を切り詰める", async () => {
    const secret = "private-line-one\nprivate-line-two\nprivate-line-three";
    const reasonSecret = "reason-secret-value-long";
    const gatewayToken = `sacty-gw-${"a".repeat(48)}`;
    const made = await toRework([implement()], {
      start: {
        secrets: { "claude-oauth-token": secret },
        github: new FakeGitHub({ me: reasonSecret }),
      },
    });
    const { service, id, executor, activity } = made;
    const path = docOf(id, "requirements");
    const run = executor.run.bind(executor);
    let changed = false;
    executor.run = async (input) => {
      if (!changed && input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        const lines = Array.from({ length: 35 }, (_, i) => `line-${i}`).join("\n");
        writeFileSync(
          file,
          `${readFileSync(file, "utf8")}\n${gatewayToken}\n${lines}\n${secret}\n${lines}\n`,
        );
        executor.respond = () =>
          out(
            [
              "# 変更",
              block({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › test"] }] }),
              block({
                "sacty-document-fixes": [
                  { path, reason: `${"a".repeat(490)}${reasonSecret}${"b".repeat(100)}` },
                  { path: "src/index.ts", reason: "外のパス" },
                ],
              }),
            ].join("\n\n"),
          );
        changed = true;
      }
      return run(input);
    };
    await service.runNext(id);
    executor.respond = undefined;
    await drain(service);
    const fix = taskOf(service, id).documentFixes?.at(-1);
    expect(fix?.path).toBe(path);
    expect(fix?.reason).toHaveLength(500);
    expect(fix?.reasonTruncated).toBe(true);
    expect(fix?.diffTruncated).toBe(true);
    expect(fix?.diff.split("\n")).toHaveLength(40);
    const visible = JSON.stringify([taskOf(service, id).documentFixes, bodiesOf(service, id)]);
    expect(visible).not.toContain(gatewayToken);
    for (const part of [...secret.split("\n"), reasonSecret, "src/index.ts"])
      expect(visible).not.toContain(part);
    activity.close();
  });

  it("プロジェクトのコンテキストの MCP と PF の認証値を文書の記録から伏せる", async () => {
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    });
    const contexts = new FakeContexts({
      "https://example.com/context.git": {
        "mcp.yaml":
          "servers:\n  wiki:\n    url: https://example.com/mcp\n    headers:\n      Authorization: { secret: mcp-key, prefix: 'Bearer ' }\n",
        "platforms.yaml":
          "platforms:\n  docs:\n    upstream: https://example.com\n    auth:\n      secret: pf-key\n    allow: [GET /api/**]\n",
      },
    });
    const secrets = {
      "claude-oauth-token": "oauth-secret",
      "mcp-key": "mcp-private-value",
      "pf-key": "pf-private-value",
    };
    const made = await toRework([implement()], { start: { projects, contexts, secrets } });
    const { service, id, executor, activity } = made;
    const path = docOf(id, "requirements");
    const run = executor.run.bind(executor);
    executor.run = async (input) => {
      if (input.workspaceDir.endsWith("/repo")) {
        projects.put("default", {
          name: "A",
          targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
          githubAccounts: { "github.com": "me" },
          context: { repo: "https://example.com/context.git" },
        });
        const file = join(input.workspaceDir, path);
        writeFileSync(
          file,
          `${readFileSync(file, "utf8")}\n${secrets["mcp-key"]}\n${secrets["pf-key"]}\n`,
        );
      }
      return run(input);
    };
    await service.runNext(id);
    await drain(service);
    const visible = JSON.stringify([taskOf(service, id).documentFixes, bodiesOf(service, id)]);
    expect(taskOf(service, id).documentFixes?.length).toBeGreaterThan(0);
    expect(visible).not.toContain(secrets["mcp-key"]);
    expect(visible).not.toContain(secrets["pf-key"]);
    expect(visible).toContain("[REDACTED]");
    activity.close();
  });

  it("局所の直しは、実装の提出の前に1件記録され、承認済みの設計と PR の設計のファイルと PR の本文に反映される（TV-7・TV-9・TV-13）", async () => {
    const made = await toRework([
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
    ]);
    const { service, id, repos, executor, activity } = made;
    const before = taskOf(service, id).approved.design;
    await service.runNext(id);
    // 実装のコミットに入れるまでは、まだコミットに入れていない直しとして残る
    expect(taskOf(service, id).designEdits?.map((e) => e.committed)).toEqual([false]);
    await drain(service);
    const task = taskOf(service, id);
    // ブランチにプッシュした後は、コミットに入れ終えた直しになる（次の回のコミットに、同じ直しを二重に当てない）
    expect(task.designEdits?.map((e) => e.committed)).toEqual([true]);
    const kinds = types(service, id);
    // 実装の提出（最終レビュー・ブランチのプッシュ・PR の更新・提出）の記録より前に、1件だけ記録する
    expect(kinds.filter((t) => t === "DesignEdited")).toHaveLength(1);
    expect(kinds.lastIndexOf("DesignEdited")).toBeLessThan(kinds.lastIndexOf("BranchPushed"));
    expect(kinds.lastIndexOf("DesignEdited")).toBeLessThan(kinds.lastIndexOf("StepSubmitted"));
    // 承認済みの設計は、該当箇所だけが after になる
    const output = DESIGN.replace("「失敗しました」", "「決済に失敗しました」");
    expect(task.approved.design?.output).toBe(output);
    expect(task.outputs.design).toBe(output);
    expect(task.approved.design?.testViewpoints).toEqual(before?.testViewpoints);
    expect(task.approved.design?.at).toBe(before?.at);
    // PR の設計のファイルも、直した後の内容（テスト観点の節は1つのまま）
    const file = repos.published.at(-1)?.overrides?.[designPath(id)] ?? "";
    expect(file).toContain("- 決済失敗：「決済に失敗しました」");
    expect(file).not.toContain("「失敗しました」");
    expect(file.match(/## テスト観点/g)).toHaveLength(1);
    // PR の本文の「設計の直し」に、前・後・指摘が載る
    const body = bodiesOf(service, id).at(-1) ?? "";
    expect(body).toContain("## 設計の直し");
    // 指摘の内部の ID は、本文に出さない（PBI-471）
    expect(body).not.toContain("implement-1-1");
    expect(body).toContain("「失敗しました」");
    expect(body).toContain("「決済に失敗しました」");
    expect(body).toContain("反映した直し（1 件）");
    // 記録した列を空から投影し直すと、同じ設計になる。実装の提出の説明・承認の時刻は、この記録では変わらない
    const events = eventsOf(made);
    let step: { before?: Task; after?: Task } = {};
    const replay = project(events, (e, b, a) => {
      if (e.type === "DesignEdited") step = { ...(b ? { before: b } : {}), after: a };
    }).get(id) as Task;
    expect(replay.approved.design?.output).toBe(output);
    expect(replay.outputs.design).toBe(output);
    expect(replay.approved.design?.testViewpoints).toEqual(task.approved.design?.testViewpoints);
    expect(step.after?.approved.design?.at).toBe(step.before?.approved.design?.at);
    expect(step.after?.implementHistory).toEqual(step.before?.implementHistory);
    expect(step.after?.implementBase).toEqual(step.before?.implementBase);
    expect(step.after?.approved.design?.testViewpoints).toEqual(
      step.before?.approved.design?.testViewpoints,
    );
    // その後の指示は、直した設計を基準にする（次の回の実装の指示）
    expect(promptOf(executor, executor.calls.length - 1)).toContain("sacty-design-edit");
    activity.close();
  });

  it("テスト観点の文言の直しは、観点の ID・数・テストの対応を引き継ぎ、PR の設計のファイルのその行だけが直る（TV-8）", async () => {
    const made = await toRework([
      withEdits([
        edit(["implement-1-1"], "決済は1回", "決済は1回だけ", {
          viewpoint: "TV-1",
          field: "expected",
        }),
      ]),
    ]);
    const { service, id, repos, activity } = made;
    const beforeTask = taskOf(service, id);
    const map = beforeTask.testMap;
    await service.runNext(id);
    await drain(service);
    const task = taskOf(service, id);
    expect(task.approved.design?.testViewpoints).toEqual([
      {
        id: "TV-1",
        title: "同じキーの再送",
        input: "同じキーで2回送る",
        expected: "決済は1回だけ",
      },
    ]);
    expect(task.approved.design?.output).toBe(DESIGN);
    expect(task.testMap.map((m) => m.viewpointId)).toEqual(map.map((m) => m.viewpointId));
    expect(task.testMap[0]?.tests).toEqual(map[0]?.tests);
    const file = repos.published.at(-1)?.overrides?.[designPath(id)] ?? "";
    expect(file).toContain("  - 期待結果：決済は1回だけ");
    expect(file).toContain("- 決済失敗：「失敗しました」");
    expect(file.match(/- \[TV-1\]/g)).toHaveLength(1);
    activity.close();
  });

  it("記録の後、PR を出す前に止まって再開しても、同じ実行の記録は1件のままで、PR の本文には「反映した」と載る（TV-10）", async () => {
    const made = await toRework([
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
    ]);
    const { service, id, repos, activity } = made;
    await service.runNext(id);
    // 実装のコミットを積めずに止まる（DesignEdited の記録の後・提出の前）
    repos.publishFail = "push rejected";
    await drain(service);
    expect(types(service, id).filter((t) => t === "DesignEdited")).toHaveLength(1);
    expect(taskOf(service, id).status).toBe("paused");
    repos.publishFail = undefined;
    service.resume(id, {});
    await drain(service);
    expect(types(service, id).filter((t) => t === "DesignEdited")).toHaveLength(1);
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 2 });
    const body = bodiesOf(service, id).at(-1) ?? "";
    expect(body).toContain("反映した直し（1 件）");
    expect(body).not.toContain("反映しなかった直し");
    expect(repos.published.at(-1)?.overrides?.[designPath(id)]).toContain("「決済に失敗しました」");
    activity.close();
  });

  it("プッシュがリモートに届いた後に失敗して再開しても、設計の直しは当たらずに止まらず、二重にも当たらない", async () => {
    const made = await toRework([
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
    ]);
    const { service, id, repos, activity } = made;
    await service.runNext(id);
    repos.publishFailAfterPush = "connection reset";
    await drain(service);
    expect(taskOf(service, id).status).toBe("paused");
    expect(repos.remote[taskBranchOf(id)]).toBeDefined();
    repos.publishFailAfterPush = undefined;
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).status).not.toBe("paused");
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 2 });
    const last = repos.published.at(-1);
    const file =
      last?.overrides?.[designPath(id)] ??
      repos.files[repos.remote[taskBranchOf(id)] ?? ""]?.[designPath(id)] ??
      "";
    expect(file.match(/「決済に失敗しました」/g) ?? []).toHaveLength(1);
    expect(file).not.toContain("「決済に失敗しましたました」");
    activity.close();
  });

  it("作業領域の文書修正と設計の直しを重ね、プッシュ後の再開でも修正の記録を残す", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = designPath(id);
    const run = executor.run.bind(executor);
    let changed = false;
    executor.run = async (input) => {
      if (!changed && input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        writeFileSync(file, `${readFileSync(file, "utf8")}\n書式修正\n`);
        executor.respond = () =>
          out(
            [
              "# 変更",
              block({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › test"] }] }),
              block({ "sacty-document-fixes": [{ path, reason: "書式を修正" }] }),
              block({
                "sacty-design-edit": {
                  edits: [edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")],
                },
              }),
            ].join("\n\n"),
          );
        changed = true;
      }
      return run(input);
    };
    await service.runNext(id);
    executor.respond = undefined;
    repos.publishFailAfterPush = "connection reset";
    await drain(service);
    expect(taskOf(service, id).status).toBe("paused");
    repos.publishFailAfterPush = undefined;
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).status).not.toBe("paused");
    const content = repos.files[repos.remote[taskBranchOf(id)] ?? ""]?.[path] ?? "";
    expect(content.match(/書式修正/g)).toHaveLength(1);
    expect(content.match(/「決済に失敗しました」/g)).toHaveLength(1);
    const fixes = taskOf(service, id).documentFixes ?? [];
    expect(fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path,
          reason: "書式を修正",
          diff: expect.stringContaining("+書式修正"),
        }),
      ]),
    );
    expect(bodiesOf(service, id).at(-1)).toContain("書式を修正");
    activity.close();
  });

  it("push の記録後に同期が失敗しても、再開して設計の直しを保持する", async () => {
    const made = await toRework([implement()]);
    const { service, id, repos, executor, activity } = made;
    const path = designPath(id);
    const run = executor.run.bind(executor);
    executor.run = async (input) => {
      if (input.workspaceDir.endsWith("/repo")) {
        const file = join(input.workspaceDir, path);
        writeFileSync(file, `${readFileSync(file, "utf8")}\n書式修正\n`);
        executor.respond = () =>
          out(
            [
              "# 変更",
              block({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › test"] }] }),
              block({ "sacty-document-fixes": [{ path, reason: "書式を修正" }] }),
              block({
                "sacty-design-edit": {
                  edits: [edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")],
                },
              }),
            ].join("\n\n"),
          );
      }
      return run(input);
    };
    await service.runNext(id);
    executor.respond = undefined;
    const read = repos.readFile.bind(repos);
    let failed = false;
    repos.readFile = async (gitDir, commit, file) => {
      if (
        !failed &&
        taskOf(service, id).pushedBranch?.commit === commit &&
        file === path &&
        taskOf(service, id).documentFixes?.length
      ) {
        failed = true;
        throw new Error("sync failed");
      }
      return read(gitDir, commit, file);
    };
    await drain(service);
    expect(failed).toBe(true);
    expect(taskOf(service, id).status).toBe("paused");
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).status).not.toBe("paused");
    const content = repos.files[repos.remote[taskBranchOf(id)] ?? ""]?.[path] ?? "";
    expect(content.match(/書式修正/g)).toHaveLength(1);
    expect(content.match(/「決済に失敗しました」/g)).toHaveLength(1);
    expect(bodiesOf(service, id).at(-1)).toContain("書式を修正");
    activity.close();
  });

  it("設計のファイルの取得の間に一時停止されたら、「読めなかった」と記録せず、再開すると直しが反映される", async () => {
    const made = await toRework([
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
    ]);
    const { service, id, repos, activity } = made;
    repos.onFetchBranch = async (signal) => {
      if (signal && !signal.aborted) {
        service.pause(id);
        // 実際の取得は、中断されると例外で終わる
        if (signal.aborted) throw new Error("The operation was aborted");
      }
    };
    await service.runNext(id);
    await drain(service);
    repos.onFetchBranch = undefined;
    expect(
      eventsOf(made).filter((e) => e.type === "DesignEdited" && e.payload.unreadable),
    ).toHaveLength(0);
    expect(JSON.stringify(eventsOf(made).filter((e) => e.type === "DesignEdited"))).not.toContain(
      "読めなかった",
    );
    service.resume(id, {});
    await drain(service);
    const edited = eventsOf(made).filter((e) => e.type === "DesignEdited");
    expect(edited).toHaveLength(1);
    expect(edited[0]?.type === "DesignEdited" ? edited[0].payload.applied : []).toHaveLength(1);
    activity.close();
  });

  it("人が設計の PR で直してマージしたタスクで、2回目の直しは1回目の after に重なる before でも反映され、人の直しは残る（TV-11）", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      designText(),
      implement(),
      rework("implement", "決定を変える（局所）：1回目"),
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
      rework("implement", "決定を変える（局所）：2回目"),
      withEdits([
        edit(["implement-2-1"], "決済に失敗しました", "決済に失敗しました。もう一度お試しください"),
      ]),
    ]);
    const { service, pulls, repos, id, activity } = made;
    await merge(made, "requirements");
    await service.runNext(id);
    // 人が設計の PR で、本文に1行足してからマージする（PR の先頭は sacty のコミットと違う）
    const designPr = taskOf(service, id).stepPullRequests.findLast((p) => p.step === "design");
    const human = [
      `<!-- sacty task ${id} の設計。sacty が作成しました。 -->`,
      "",
      `${DESIGN}\n- 人が足した行`,
      "",
      "## テスト観点",
      "",
      "- [TV-1] 同じキーの再送",
      "  - 入力：同じキーで2回送る",
      "  - 期待結果：決済は1回",
      "",
    ].join("\n");
    const number = designPr?.number ?? 0;
    const mergeCommit = `f${number}`.padEnd(40, "0");
    pulls.states[number] = {
      state: "merged",
      mergedBy: "reviewer",
      headSha: `e${number}`.padEnd(40, "0"),
      mergeCommit,
    };
    repos.remote[taskBranchOf(id)] = mergeCommit;
    repos.files[mergeCommit] = { [designPath(id)]: human };
    await service.checkPullRequests();
    await drain(service);
    expect(taskOf(service, id).approved.design?.output).toContain("- 人が足した行");
    pulls.feedbackBy[9] = [item("comment:30", { body: "1回目の指摘" })];
    await service.checkPullRequests();
    await service.runNext(id);
    await drain(service);
    const first = repos.published.at(-1)?.overrides?.[designPath(id)] ?? "";
    expect(first).toContain("- 決済失敗：「決済に失敗しました」");
    expect(first).toContain("- 人が足した行");
    expect(first.match(/## テスト観点/g)).toHaveLength(1);
    // 次の PR の指摘で、実装に戻した回に、1回目の after の一部を before にした直しを出す
    pulls.feedbackBy[9] = [item("comment:31", { body: "2回目の指摘" })];
    await service.checkPullRequests();
    await service.runNext(id);
    await drain(service);
    const second = repos.published.at(-1)?.overrides?.[designPath(id)] ?? "";
    expect(second).toContain("- 決済失敗：「決済に失敗しました。もう一度お試しください」");
    expect(second).toContain("- 人が足した行");
    expect(second.match(/## テスト観点/g)).toHaveLength(1);
    // 直しの箇所のほかは、人がマージした内容のまま
    expect(second.replace("決済に失敗しました。もう一度お試しください", "失敗しました")).toBe(
      human,
    );
    const body = bodiesOf(service, id).at(-1) ?? "";
    expect(body).toContain("反映した直し（2 件）");
    expect(body).not.toContain("implement-2-1");
    activity.close();
  });

  it("直した後のレビュー・戻し先の判断・設計のやり直しは、直した設計とテスト観点を基準にする（TV-13）", async () => {
    const made = await toRework([
      withEdits([
        edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」"),
        edit(["implement-1-1"], "決済は1回", "決済は1回だけ", {
          viewpoint: "TV-1",
          field: "expected",
        }),
      ]),
    ]);
    const { service, id, activity } = made;
    await service.runNext(id);
    await drain(service);
    const task = taskOf(service, id);
    const targets: StepKey[] = ["implement", "design", "requirements"];
    const reviewTask = {
      ...task,
      steps: [{ key: "review", state: "active" }],
      reviewTarget: {
        repo: "https://github.com/acme/app",
        number: 9,
        url: "https://github.com/acme/app/pull/9",
        title: "t",
        body: "",
        headCommit: "h".repeat(40),
        baseCommit: "b".repeat(40),
        author: "alice",
      },
    } as unknown as Task;
    const prompts = [
      // レビューの子タスクの指示
      buildPrompt(reviewTask, "review", {
        diff: "diff",
        reviewRework: { gateStep: "implement", targets, parent: task },
      }),
      // 戻し先の判断の指示
      buildReworkPrompt(task, ["指摘"], targets, "implement"),
      // 方針の変更で設計に戻したときの設計の指示
      buildPrompt(task, "design"),
    ];
    for (const p of prompts) {
      expect(p).toContain("「決済に失敗しました」");
      expect(p).not.toContain("- 決済失敗：「失敗しました」");
    }
    for (const p of prompts.slice(0, 2)) {
      expect(p).toContain("決済は1回だけ");
    }
    activity.close();
  });

  it("設計のファイルが無いタスクでも、承認済みの設計と PR の本文の直しは反映し、コミットに設計のファイルは足さない（TV-12）", async () => {
    const made = await toRework([
      withEdits([edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")]),
    ]);
    const { service, id, repos, activity } = made;
    // タスクブランチの先頭に、設計のファイルが無い
    const head = repos.remote[taskBranchOf(id)] ?? "";
    repos.files[head] = { [designPath(id)]: null };
    await service.runNext(id);
    await drain(service);
    const task = taskOf(service, id);
    expect(task.approved.design?.output).toContain("「決済に失敗しました」");
    expect(repos.published.at(-1)?.overrides).toBeUndefined();
    expect(bodiesOf(service, id).at(-1)).toContain("反映した直し（1 件）");
    activity.close();
  });

  describe("反映しない直し（TV-14）", () => {
    it("指摘に無い ID・sensitive・承認済みの設計に無い before は反映せず、理由を残して実装の提出は続ける（人が実装の工程で直すと明示した回も同じ）", async () => {
      const made = await toRework(
        [
          withEdits([
            edit(["implement-9-9"], "「失敗しました」", "「別の文言」"),
            edit(["implement-1-1"], "「在庫がありません」", "「在庫切れです」", {
              sensitive: true,
            }),
            edit(["implement-1-1"], "存在しない文", "x"),
          ]),
        ],
        { remark: "実装の工程で直してください。エラー表の文言も直してください" },
      );
      const { service, id, repos, activity } = made;
      await service.runNext(id);
      await drain(service);
      const task = taskOf(service, id);
      expect(task.approved.design?.output).toBe(DESIGN);
      expect(task.designEdits?.[0]?.applied).toEqual([]);
      expect(task.designEdits?.[0]?.rejected.map((r) => String(r.rejection))).toEqual([
        expect.stringMatching(/指摘の ID/),
        expect.stringMatching(/セキュリティ/),
        expect.stringMatching(/承認済みの設計にありません/),
      ]);
      expect(repos.published.at(-1)?.overrides).toBeUndefined();
      // 実装の PR は提出される。本文には、反映しなかった直しと理由が載る
      expect(task.gate).toEqual({ step: "implement", submission: 2 });
      const body = bodiesOf(service, id).at(-1) ?? "";
      expect(body).toContain("反映しなかった直し（3 件）");
      expect(body).toContain("セキュリティ");
      activity.close();
    });

    it("見出しの語だけの直し・内部のパスを含む直しは、service を通しても反映せず、本文・イベントに内部のパスが残らない。反映が0件の本文は「直しました」と書かない（TV-14・TV-17）", async () => {
      const made = await toRework([
        withEdits([
          edit(["implement-1-1"], "エラー表", "失敗表"),
          edit(["implement-1-1"], "「失敗しました」", "詳細は /sacty-input/a を見る"),
          edit(["implement-1-1"], "「在庫がありません」", "「在庫切れです」", {
            reason: "/sacty-input/x.md:3 に合わせる",
          }),
        ]),
      ]);
      const { service, id, repos, activity } = made;
      await service.runNext(id);
      await drain(service);
      const task = taskOf(service, id);
      expect(task.approved.design?.output).toContain("エラー表");
      expect(task.approved.design?.output).not.toContain("失敗表");
      expect(task.designEdits?.[0]?.applied).toHaveLength(1);
      expect(JSON.stringify(task.designEdits)).not.toContain("/sacty-input");
      expect(repos.published.at(-1)?.overrides).toBeDefined();
      const body = bodiesOf(service, id).at(-1) ?? "";
      expect(body).not.toContain("/sacty-input");
      expect(body).toContain("反映しなかった直し（2 件）");
      activity.close();
    });

    it("反映した直しが0件の回の本文は、設計を直したと書かない", async () => {
      const made = await toRework([withEdits([edit(["implement-9-9"], "「失敗しました」", "x")])]);
      const { service, id, activity } = made;
      await service.runNext(id);
      await drain(service);
      const body = bodiesOf(service, id).at(-1) ?? "";
      expect(body).toContain("反映した直しは 0 件");
      expect(body).not.toContain("承認済みの設計も直しました");
      activity.close();
    });

    it("変更の申し出と同時に出した直しは反映せず、申し出だけを扱う", async () => {
      const proposal = block({
        "sacty-change-proposal": {
          target: "design",
          reason: "方針が違う",
          facts: ["事実"],
          proposed: "# 設計（方針を変える）",
        },
      });
      const both = out(
        [
          "# 実装の説明 v2",
          proposal,
          block({
            "sacty-design-edit": {
              edits: [edit(["implement-1-1"], "「失敗しました」", "「決済に失敗しました」")],
            },
          }),
        ].join("\n\n"),
      );
      const made = await toRework([both]);
      const { service, id, activity } = made;
      await service.runNext(id);
      const task = taskOf(service, id);
      expect(task.approved.design?.output).toBe(DESIGN);
      expect(task.designEdits?.[0]).toMatchObject({ applied: [], withProposal: true });
      expect(types(service, id)).toContain("ChangeProposed");
      activity.close();
    });

    it("ブロックが読めなければ、直しは0件とし、読めなかったことを本文に載せる", async () => {
      const broken = out(
        [
          "# 実装の説明 v2",
          block({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["a.test.ts › b"] }] }),
          '```json\n{"sacty-design-edit": {"edits": [\n```',
        ].join("\n\n"),
      );
      const made = await toRework([broken]);
      const { service, id, activity } = made;
      await service.runNext(id);
      await drain(service);
      const task = taskOf(service, id);
      expect(task.approved.design?.output).toBe(DESIGN);
      expect(task.designEdits?.[0]).toMatchObject({ applied: [], unreadable: true });
      expect(bodiesOf(service, id).at(-1)).toContain("読めなかった");
      expect(task.gate).toEqual({ step: "implement", submission: 2 });
      activity.close();
    });

    it("設計の直しの出し方を伝えない回（最初の実装）の出力にブロックがあっても、読まない", async () => {
      const first = out(
        [
          "# 実装の説明",
          block({
            "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
          }),
          block({ "sacty-design-edit": { edits: [edit(["x"], "「失敗しました」", "「別」")] } }),
        ].join("\n\n"),
      );
      const made = await start([out("# 要求要件 v1"), designText(), first]);
      const { service, id, activity } = made;
      await merge(made, "requirements");
      await service.runNext(id);
      await merge(made, "design");
      await drain(service);
      expect(taskOf(service, id).designEdits).toBeUndefined();
      expect(taskOf(service, id).approved.design?.output).toBe(DESIGN);
      activity.close();
    });
  });

  describe("設計に戻したときの知らせ（TV-15・TV-17）", () => {
    const secretReason = `決定を変える（方針）：構成を選び直す @mallory ghp_secret ${"あ".repeat(1_200)}`;
    const marker = (id: string) => `<!-- sacty-rework-notice:${id}:1 -->`;
    const noticesOf = (made: { pulls: FakePulls; id: string }) =>
      made.pulls.issueComments.filter((c) => c.body.includes(marker(made.id)));

    it("判断が設計になったら、実装の PR に知らせを1通だけ投稿する。理由の秘密情報・@・長さは、人に確かめてほしいことの投稿と同じ作法にする", async () => {
      const made = await toRework([], { target: "design", reason: secretReason });
      const { service, id, pulls, activity } = made;
      await noticesSettled(service);
      const notices = noticesOf(made);
      expect(notices).toHaveLength(1);
      const body = notices[0]?.body ?? "";
      expect(notices[0]?.number).toBe(9);
      expect(body).toContain("設計に戻しました");
      expect(body).toContain("設計の PR");
      expect(body).toContain("実装で直す");
      expect(body).not.toContain("ghp_secret");
      expect(body).toContain("@\u200bmallory");
      expect(body).not.toContain("@mallory");
      // 理由は 600 文字で切る
      expect(body.length).toBeLessThan(1_400);
      expect(body).toContain("…");
      // 同じ差し戻しにもう一度知らせようとしても、目印で見つけて書かない
      (
        service as unknown as { announceReworkNotice: (t: Task, i: unknown) => void }
      ).announceReworkNotice(taskOf(service, id), {
        repo: "https://github.com/acme/app",
        number: 9,
        round: 1,
        reason: secretReason,
      });
      await noticesSettled(service);
      expect(noticesOf(made)).toHaveLength(1);
      expect(
        pulls.issueComments.filter((c) => c.body.includes("sacty-rework-notice")),
      ).toHaveLength(1);
      activity.close();
    });

    it.each(["http://127.0.0.1:4700", "https://sacty.example.com"])(
      "設計に戻した知らせには、画面の URL（%s）もタスクの ID も出さず、「Sacty の画面で」の案内だけを書く",
      async (webUrl) => {
        const made = await toRework([], {
          target: "design",
          reason: "決定を変える（方針）：構成を選び直す",
          start: { webUrl },
        });
        await noticesSettled(made.service);
        const body = noticesOf(made)[0]?.body ?? "";
        let visible = body;
        for (let prev = ""; prev !== visible; ) {
          prev = visible;
          visible = visible.replace(/<!--[\s\S]*?-->/g, "");
        }
        expect(visible).not.toContain("http://");
        expect(visible).not.toContain("/tasks/");
        expect(visible).not.toContain(made.id);
        expect(visible).toContain("Sacty の画面で差し戻してください。");
        made.activity.close();
      },
    );

    it("実装に戻した判断（局所の変更）には、知らせを投稿しない", async () => {
      const made = await toRework([]);
      await noticesSettled(made.service);
      expect(noticesOf(made)).toEqual([]);
      made.activity.close();
    });

    it("投稿に失敗しても、タスクの状態は変えない（設計に戻して作り直しが始まる）", async () => {
      const made = await start([
        out("# 要求要件 v1"),
        designText(),
        implement(),
        rework("design", "決定を変える（方針）：構成を選び直す"),
      ]);
      const { service, pulls, id, activity } = made;
      await merge(made, "requirements");
      await service.runNext(id);
      await merge(made, "design");
      await drain(service);
      pulls.commentFail = "boom";
      pulls.feedbackBy[9] = [item("comment:30", { body: "構成を見直してください" })];
      await service.checkPullRequests();
      await noticesSettled(service);
      expect(noticesOf({ pulls, id })).toEqual([]);
      expect(taskOf(service, id).steps.map((s) => s.state)).toEqual(["done", "active", "todo"]);
      activity.close();
    });

    it("セキュリティの組み合わせのタスクでは、知らせを投稿しない（理由に脆弱性の詳細を含みうるため）", async () => {
      const made = await toRework([], {
        target: "design",
        reason: "決定を変える（方針）：認可の方式を選び直す",
        start: {
          planner: async () => ({
            steps: [...MVP_STEPS],
            plan: "security-fix" as const,
            reason: "セキュリティ対応",
            fallback: false,
            testCommand: "npm test",
            costUsd: 0,
            estimated: false,
          }),
        },
      });
      expect(isSecurityTask(taskOf(made.service, made.id))).toBe(true);
      await noticesSettled(made.service);
      expect(noticesOf(made)).toEqual([]);
      made.activity.close();
    });
  });

  describe("直しでは解消できない指摘で止めた回の、戻し先が設計の回（PBI-452。TV-18）", () => {
    const CI = {
      snapshot: async () => ({ checks: [], jobs: [], failedRuns: [] }),
    } as unknown as ServiceDeps["ci"];
    const MARK = "方針の変更が要り、実装の直しでは解消しない";
    const verdict = (target: string) =>
      out(
        [
          "# 評価",
          "",
          "## 指摘",
          "",
          "**[要修正] 構成を選び直す**（src/pay.ts）\n構成の説明。",
          block({
            "sacty-review-verdict": {
              verdict: "changes_required",
              rework: {
                findings: [
                  {
                    finding: "構成を選び直す",
                    target,
                    reason: "決定を変える（方針）：構成を選び直す",
                    needs_decision: MARK,
                  },
                ],
                cause: "guardian_missed",
              },
            },
          }),
        ].join("\n\n"),
      );
    const noticeOfDesign = (pulls: FakePulls) =>
      pulls.issueComments.filter((c) => c.body.includes("sacty-rework-notice"));

    it("止めた時点では設計に戻さず（差し戻しも知らせも無い）、人のコメントで再開した後に、設計に戻して知らせを 1 通出し、設計の指示にコメントの文が入る", async () => {
      const made = await start(
        [
          out("# 要求要件 v1"),
          designText(),
          implement(),
          verdict("design"),
          // 再開の後の、戻し先の判断（人の指摘を含む回は、PR の工程のエージェントが判断する）
          rework("design", "決定を変える（方針）：構成を選び直す"),
          designText(),
        ],
        { reviewTasks: true, ci: CI },
      );
      const { service, pulls, id, executor, activity } = made;
      await merge(made, "requirements");
      await service.runNext(id);
      await merge(made, "design");
      await drain(service);
      expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 1 });
      const childId = taskOf(service, id).reviewTasks?.find((r) => r.number === 9)?.taskId ?? "";
      for (let i = 0; i < 4 && taskOf(service, childId).status !== "completed"; i++) {
        await service.runNext(childId);
      }
      const reviewPost = item("review:60", {
        kind: "review",
        author: "me",
        body: pulls.reviews[0]?.body ?? "",
      });
      pulls.prInfo = {
        ...pulls.prInfo,
        number: 9,
        headSha: taskOf(service, id).pullRequest?.commit ?? "",
      };
      pulls.feedbackBy[9] = [reviewPost];
      await service.checkPullRequests();
      // 止めた時点：承認待ちのまま止まり、設計への差し戻しも、設計に戻した知らせも無い
      expect(taskOf(service, id)).toMatchObject({
        status: "paused",
        pausedReason: "needs_decision",
      });
      expect(types(service, id)).not.toContain("ChangesRequested");
      expect(noticeOfDesign(pulls)).toEqual([]);
      // 人のコメントが held で取り込まれ、同じ追記で再開する
      pulls.feedbackBy[9] = [
        reviewPost,
        item("comment:40", { author: "alice", body: "構成は見直して構いません。進めてください" }),
      ];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      const heldAt = events.findIndex(
        (e) => e.type === "PullRequestReviewImported" && e.payload.held,
      );
      expect(events[heldAt + 1]).toMatchObject({ type: "TaskResumed", actor: "sacty" });
      // 再開の後、既存の流れで、戻し先を判断して設計に戻す。知らせは 1 通
      await service.checkPullRequests();
      await noticesSettled(service);
      const changed = (service.get(id)?.activity ?? []).filter(
        (e) => e.type === "ChangesRequested",
      );
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ payload: { target: "design" } });
      expect(noticeOfDesign(pulls)).toHaveLength(1);
      // 設計のやり直しの指示に、人のコメントの文が入る
      await service.runNext(id);
      expect(promptOf(executor, executor.calls.length - 1)).toContain(
        "構成は見直して構いません。進めてください",
      );
      activity.close();
    });
  });
});
