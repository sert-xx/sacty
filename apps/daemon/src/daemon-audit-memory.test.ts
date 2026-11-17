import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Task } from "@sacty/core";
import { isCompleted } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult } from "./config.js";
import { LedgerAuditService } from "./ledger-audits.js";
import { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import { MemoryProjectStore } from "./projects.js";
import {
  InvalidOperationError,
  MEMORY_STEP_ROLES,
  type ServiceDeps,
  type TaskService,
} from "./service.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  HOLD,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "./testing/daemon.js";
import { idleFor } from "./testing/wait.js";

useTempDir();

describe("完了したタスクの監査（PBI-125）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const json = (value: unknown, usageOutput = 1000) =>
    out(`調べました。\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, usageOutput);
  const survey = (concerns: { step: string; reason: string }[], usageOutput = 1000) =>
    json({ "sacty-audit-survey": { summary: "要約", concerns } }, usageOutput);
  const dive = (findings: unknown[], usageOutput = 1000) =>
    json({ "sacty-audit-findings": { summary: "深掘りの結果", findings } }, usageOutput);
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const isAudit = (invocation: Invocation) => isSurvey(invocation) || isDive(invocation);
  const auditEvents = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).filter((e) => e.type.startsWith("Audit"));
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });

  /** 要求要件だけのタスクを作り、承認して完了させる（監査の応答は respond で決める）。 */
  async function completedTask(
    respond: (invocation: Invocation) => AgentOutcome | undefined,
    options: { audit?: boolean } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, [], {
      audit: options.audit ?? true,
      planner: onlyRequirements,
    });
    made.executor.respond = (invocation) => respond(invocation) ?? out("# 要求要件");
    const task = made.service.createTask({
      projectId: "default",
      title: "決済API",
      body: "冪等にする",
    });
    await made.service.runNext(task.id);
    made.service.approve(task.id, { step: "requirements", submission: 1 });
    return { ...made, activity, id: task.id };
  }

  it("完了した瞬間に監査を待つ記録を足す。監査を有効にしていなければ足さない", async () => {
    const on = await completedTask(() => undefined);
    const queued = auditEvents(on.service, on.id);
    expect(queued.map((e) => e.type)).toEqual(["AuditQueued"]);
    expect(queued[0]?.payload).toMatchObject({ capUsd: 1 });
    expect(on.service.queuedTaskIds()).toContain(on.id);

    const off = makeService(new SqliteActivityStore(join(dir, "off.db")), [], {
      planner: onlyRequirements,
    });
    off.executor.respond = () => out("# 要求要件");
    const task = off.service.createTask({ projectId: "default", title: "A", body: "" });
    await off.service.runNext(task.id);
    off.service.approve(task.id, { step: "requirements", submission: 1 });
    expect(auditEvents(off.service, task.id)).toEqual([]);
    expect(off.service.queuedTaskIds()).not.toContain(task.id);
  });

  it("大まかな監査 → 懸念のある工程の深掘り → 完了。費用はタスクの予算に入れず、監査の予算に入れる", async () => {
    const { service, executor, id } = await completedTask((invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "差し戻しが多い" }])
        : isDive(invocation)
          ? dive([
              {
                title: "受け入れ条件の書き方が決まっていない",
                detail: "説明",
                evidence: [{ kind: "changesRequested", text: "差し戻された", event: "nope" }],
                proposals: [{ title: "規約に書く", body: "本文", target: 0 }],
              },
            ])
          : undefined,
    );
    const budgetBefore = service.get(id)?.task.budget.usedUsd ?? 0;
    await service.runNext(id);
    await service.runNext(id);
    await service.runNext(id);
    expect(auditEvents(service, id).map((e) => e.type)).toEqual([
      "AuditQueued",
      "AuditSurveyed",
      "AuditDeepDived",
      "AuditCompleted",
    ]);
    const task = service.get(id)?.task;
    // 監査の費用（1000出力トークン × 2 = $0.03）は監査の予算に入り、タスクの予算には入らない
    expect(task?.budget.usedUsd).toBeCloseTo(budgetBefore, 6);
    expect(task?.audit?.usedUsd).toBeCloseTo(0.03, 6);
    expect(executor.calls.filter(isAudit)).toHaveLength(2);
    // 無い作業履歴の行は根拠から外し、工程を添える。宛先は候補の番号から選ぶ
    const finding = task?.audit?.findings[0];
    expect(finding?.causeKey).toMatch(/:requirements:0$/);
    expect(finding?.evidence[0]).toEqual({
      kind: "changesRequested",
      text: "差し戻された",
      step: "requirements",
    });
    const candidates = finding?.proposals[0]?.candidates ?? [];
    expect(finding?.proposals[0]?.target).toEqual(candidates[0]);
    expect(candidates.at(-1)).toEqual({ kind: "sacty" });
    // 終わったので、もう待ち行列に入らない
    expect(service.queuedTaskIds()).not.toContain(id);
  });

  it("根拠の件数は sacty が作業履歴から数え、指示に件数と人の指摘を入れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    executor.respond = (invocation) => (isSurvey(invocation) ? survey([]) : out("# 要求要件"));
    const task = service.createTask({ projectId: "default", title: "A", body: "" });
    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: 1,
      comments: ["空のときを書いて", "上限を書いて"],
    });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 2 });
    await service.runNext(task.id);
    const surveyed = auditEvents(service, task.id).find((e) => e.type === "AuditSurveyed");
    expect(surveyed?.payload).toMatchObject({
      counts: {
        changesRequested: 2,
        pullRequestRemark: 0,
        pause: 0,
        retry: 0,
        toolFailure: 0,
        escalation: 0,
      },
      concerns: [],
    });
    const call = executor.calls.find(isSurvey);
    expect(call && prompt(call)).toContain("人の差し戻し：2 件");
    expect(call && prompt(call)).toContain("空のときを書いて");
    // 懸念のある工程が無ければ、深掘りせずに終える
    await service.runNext(task.id);
    expect(auditEvents(service, task.id).at(-1)?.type).toBe("AuditCompleted");
    expect(executor.calls.filter(isDive)).toHaveLength(0);
  });

  it("出力を読めなければ、監査の失敗として記録し、それ以上は進めない", async () => {
    const { service, id } = await completedTask((invocation) =>
      isSurvey(invocation) ? out("形の無い出力") : undefined,
    );
    await service.runNext(id);
    expect(service.get(id)?.task.audit?.failed?.reason).toEqual({ code: "audit.unreadable" });
    expect(service.queuedTaskIds()).not.toContain(id);
  });

  it("深掘りの出力の文字列に二重引用符があっても、読んで深掘りの結果を記録する（S16 r3。PBI-293）", async () => {
    const broken = [
      "```json",
      "{",
      '  "sacty-audit-findings": {',
      '    "summary": "入力が "1,200" や "abc" のときの扱いが決まっていない",',
      '    "findings": []',
      "  }",
      "}",
      "```",
    ].join("\n");
    const { service, id } = await completedTask((invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "差し戻しが多い" }])
        : isDive(invocation)
          ? out(broken)
          : undefined,
    );
    await service.runNext(id);
    await service.runNext(id);
    await service.runNext(id);
    expect(auditEvents(service, id).map((e) => e.type)).toEqual([
      "AuditQueued",
      "AuditSurveyed",
      "AuditDeepDived",
      "AuditCompleted",
    ]);
    expect(service.get(id)?.task.audit?.dives[0]?.summary).toBe(
      '入力が "1,200" や "abc" のときの扱いが決まっていない',
    );
  });

  it("2つ目の深掘りの出力が直しても読めなければ、読めなかった所を作業履歴に残し、記録済みの大まかな監査・1つ目の深掘り・費用は残す（PBI-293）", async () => {
    const twoSteps = async () => ({
      steps: ["requirements" as const, "design" as const],
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, [], { audit: true, planner: twoSteps });
    const { service, executor } = made;
    const brokenSecond = out(
      '```json\n{\n  "sacty-audit-findings": {\n    "summary": "x",\n    "findings": [ { "title": \n```',
      3000,
    );
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) {
        return survey(
          [
            { step: "requirements", reason: "差し戻しが多い" },
            { step: "design", reason: "やり直しが多い" },
          ],
          1000,
        );
      }
      if (isDive(invocation)) {
        return prompt(invocation).includes("深掘りする工程：要求要件")
          ? dive(
              [
                {
                  title: "受け入れ条件の書き方が決まっていない",
                  detail: "説明",
                  evidence: [],
                  proposals: [{ title: "規約に書く", body: "本文", target: 0 }],
                },
              ],
              2000,
            )
          : brokenSecond;
      }
      return out("# 本文");
    };
    const task = service.createTask({ projectId: "default", title: "決済API", body: "冪等にする" });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    await service.runNext(task.id);
    service.approve(task.id, { step: "design", submission: 1 });
    await service.runNext(task.id); // 大まかな監査
    await service.runNext(task.id); // 1つ目の深掘り（成功）
    await service.runNext(task.id); // 2つ目の深掘り（読めない）
    const events = auditEvents(service, task.id);
    expect(events.map((e) => e.type)).toEqual([
      "AuditQueued",
      "AuditSurveyed",
      "AuditDeepDived",
      "AuditFailed",
    ]);
    const audit = service.get(task.id)?.task.audit;
    expect(audit?.failed?.step).toBe("design");
    expect(audit?.failed?.reason).toMatchObject({
      code: "audit.unreadableAt",
      params: { line: 5 },
    });
    // 大まかな監査の結果・1つ目の深掘りとその原因は残る
    expect(audit?.survey?.concerns.map((c) => c.step)).toEqual(["requirements", "design"]);
    expect(audit?.dives).toHaveLength(1);
    expect(audit?.dives[0]).toMatchObject({ step: "requirements" });
    expect(audit?.findings.map((f) => f.title)).toEqual(["受け入れ条件の書き方が決まっていない"]);
    // 費用は、3回の実行の合計（出力トークン 1000 + 2000 + 3000。1000 出力トークン = $0.015）
    expect(audit?.usedUsd).toBeCloseTo(0.09, 6);
    const costs = events.map((e) => (e.payload as { auditCostUsd?: number }).auditCostUsd ?? 0);
    expect(costs.reduce((sum, c) => sum + c, 0)).toBeCloseTo(0.09, 6);
    expect(costs.at(-1)).toBeCloseTo(0.045, 6);
  });

  it("実行に失敗したら、監査の失敗として理由を記録する", async () => {
    const { service, id } = await completedTask((invocation) =>
      isSurvey(invocation)
        ? { kind: "failed", reason: "error", message: "コンテナが起動しない" }
        : undefined,
    );
    await service.runNext(id);
    expect(service.get(id)?.task.audit?.failed?.reason).toEqual({
      code: "audit.runFailed",
      params: { detail: "コンテナが起動しない" },
    });
  });

  it("予算の 80% で記録し、深掘りが終われば予算を超えていても完了する", async () => {
    const { service, id } = await completedTask((invocation) =>
      isSurvey(invocation)
        ? // 60000出力トークン = $0.90（上限 $1 の 90%）
          survey([{ step: "requirements", reason: "理由" }], 60_000)
        : isDive(invocation)
          ? dive([], 20_000)
          : undefined,
    );
    await service.runNext(id);
    expect(auditEvents(service, id).map((e) => e.type)).toEqual([
      "AuditQueued",
      "AuditSurveyed",
      "AuditBudgetWarned",
    ]);
    // まだ上限の前なので深掘りする（$0.90 + $0.30 = $1.20 で上限を超える）。残りの実行が無いので完了する
    await service.runNext(id);
    await service.runNext(id);
    expect(auditEvents(service, id).at(-1)?.type).toBe("AuditCompleted");
  });

  it("予算を使い切ったら次の実行の前に一時停止し、使った額より大きい上限で続きから再開する", async () => {
    const { service, id } = await completedTask((invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }], 70_000)
        : isDive(invocation)
          ? dive([])
          : undefined,
    );
    await service.runNext(id); // $1.05 を使う
    await service.runNext(id);
    expect(service.get(id)?.task.audit?.paused).toBeDefined();
    expect(auditEvents(service, id).at(-1)?.type).toBe("AuditBudgetPaused");
    expect(service.queuedTaskIds()).not.toContain(id);
    expect(() => service.resumeAudit(id, { capUsd: 1 })).toThrow("より大きい金額");
    expect(() => service.resumeAudit(id, {})).toThrow("新しい上限が必要です");
    service.resumeAudit(id, { capUsd: 3 });
    expect(service.queuedTaskIds()).toContain(id);
    await service.runNext(id);
    await service.runNext(id);
    expect(auditEvents(service, id).at(-1)?.type).toBe("AuditCompleted");
    expect(() => service.resumeAudit(id, { capUsd: 5 })).toThrow(
      "予算で一時停止している監査ではありません",
    );
  });

  it("デーモンを止めるときの実行の終わりは記録せず、次にもう一度実行する", async () => {
    let stop: (() => void) | undefined;
    const { service, id } = await completedTask((invocation) => {
      if (!isSurvey(invocation)) return undefined;
      stop?.();
      return { kind: "failed", reason: "error", message: "aborted" };
    });
    stop = () => service.beginShutdown();
    await service.runNext(id);
    expect(auditEvents(service, id).map((e) => e.type)).toEqual(["AuditQueued"]);
  });

  /** 監査で、提案を2つ出す（対象リポジトリ宛てと sacty 宛て）。 */
  async function auditedWithProposals() {
    const made = await completedTask((invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([
              {
                title: "原因",
                detail: "説明",
                evidence: [],
                proposals: [
                  { title: "リポジトリに書く", body: "本文", target: 0 },
                  { title: "プロンプトを直す", body: "本文", target: 99 },
                  { title: "sacty を直す", body: "本文", target: 1 },
                ],
              },
            ])
          : undefined,
    );
    await made.service.runNext(made.id);
    await made.service.runNext(made.id);
    await made.service.runNext(made.id);
    const proposals = made.service.get(made.id)?.task.audit?.findings[0]?.proposals ?? [];
    return { ...made, proposals };
  }

  it("宛先の番号が候補の外の提案は捨てる。採用すると、宛先のリポジトリに改修のタスクを作り、sacty 宛てはタスクを作らない", async () => {
    const { service, id, proposals } = await auditedWithProposals();
    expect(proposals.map((p) => p.title)).toEqual(["リポジトリに書く", "sacty を直す"]);
    const [repo, sacty] = proposals;
    if (!repo || !sacty) throw new Error("proposals");
    expect(repo.target.kind).toBe("repository");
    expect(sacty.target).toEqual({ kind: "sacty" });
    await service.adoptAuditProposal(repo.id, { target: repo.target });
    const decision = service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision;
    const fixId = decision?.kind === "adopted" ? decision.fixTaskId : undefined;
    const fix = fixId ? service.get(fixId)?.task : undefined;
    expect(fix).toMatchObject({
      start: "audit",
      title: "改修：リポジトリに書く",
      auditFix: { taskId: id, proposalId: repo.id },
      status: "queued",
    });
    expect(fix?.body).toContain("監査で見つけた原因：原因");
    // 改修のタスクが完了しても、元のタスクの監査は変わらない（改修のタスク自身の監査は、完了したときに別に待つ）
    expect(service.get(id)?.task.audit?.completedAt).toBeDefined();

    const before = service.list().length;
    await service.adoptAuditProposal(sacty.id, { target: { kind: "sacty" } });
    expect(service.list().length).toBe(before);
    const sactyDecision = service.get(id)?.task.audit?.findings[0]?.proposals[1]?.decision;
    expect(sactyDecision).toMatchObject({ kind: "adopted", target: { kind: "sacty" } });
    expect(sactyDecision && "fixTaskId" in sactyDecision).toBe(false);

    await expect(service.adoptAuditProposal(repo.id, { target: repo.target })).rejects.toThrow(
      "すでに採用か却下をしています",
    );
  });

  it("採用に添えた補足は、記録・改修のタスクの説明に残り、以後の監査にも渡す（PBI-151）", async () => {
    const { service, executor, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    // 中身が空の手入れは受け付けない（手を入れないなら、添えずに採用する）
    await expect(
      service.adoptAuditProposal(repo.id, {
        target: repo.target,
        note: { kind: "supplement", text: "   " },
      }),
    ).rejects.toThrow();
    await service.adoptAuditProposal(repo.id, {
      target: repo.target,
      note: { kind: "supplement", text: "ghp_secret は使わない" },
    });
    const decision = service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision;
    // 手入れも、却下の理由と同じく記録する前に秘密情報を伏せる
    expect(decision).toMatchObject({
      kind: "adopted",
      note: { kind: "supplement", text: "[REDACTED] は使わない" },
    });
    const fixId = decision?.kind === "adopted" ? decision.fixTaskId : undefined;
    const body = (fixId ? service.get(fixId)?.task.body : undefined) ?? "";
    expect(body).toContain("人が足した補足：");
    expect(body).toContain("[REDACTED] は使わない");
    // 改善案（本文）の後に補足が来る（監査の改善案はそのまま残す）
    expect(body.indexOf("本文")).toBeLessThan(body.indexOf("人が足した補足："));

    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([])
          : out("# 要求要件");
    const second = service.createTask({ projectId: "default", title: "B", body: "" });
    await service.runNext(second.id);
    service.approve(second.id, { step: "requirements", submission: 1 });
    await service.runNext(second.id);
    await service.runNext(second.id);
    const call = executor.calls.filter(isDive).at(-1);
    expect(call && prompt(call)).toContain("リポジトリに書く（補足）：[REDACTED] は使わない");
  });

  it("採用で改善案を差し替えると、人の案を改修の指示にし、監査の改善案を記録として添える（PBI-151）", async () => {
    const { service, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    await service.adoptAuditProposal(repo.id, {
      target: repo.target,
      note: { kind: "replace", text: "人の案で直す" },
    });
    const decision = service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision;
    expect(decision).toMatchObject({ kind: "adopted", note: { kind: "replace" } });
    const fixId = decision?.kind === "adopted" ? decision.fixTaskId : undefined;
    const body = (fixId ? service.get(fixId)?.task.body : undefined) ?? "";
    expect(body.startsWith("人の案で直す")).toBe(true);
    expect(body).toContain("人が改善案を差し替えました。監査が出した改善案：");
    expect(body).toContain("監査で見つけた原因：原因");
  });

  it("候補に無い宛先・無い提案では採用できない。却下の理由と既存の原因を以後の監査に渡し、同じ原因はその鍵を使う", async () => {
    const { service, executor, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    await expect(
      service.adoptAuditProposal(repo.id, {
        target: { kind: "repository", repo: "https://github.com/other/x" },
      }),
    ).rejects.toThrow("宛先の候補にありません");
    await expect(
      service.adoptAuditProposal("missing", { target: { kind: "sacty" } }),
    ).rejects.toThrow("その提案はありません");
    await expect(service.rejectAuditProposal(repo.id, { reason: "  " })).rejects.toThrow();
    await service.rejectAuditProposal(repo.id, { reason: "ほかのチームと共有しているため" });
    expect(service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision).toMatchObject({
      kind: "rejected",
      reason: "ほかのチームと共有しているため",
    });

    const causeKey = service.get(id)?.task.audit?.findings[0]?.causeKey ?? "";
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([{ sameAs: causeKey, title: "同じ原因", detail: "", evidence: [], proposals: [] }])
          : out("# 要求要件");
    const second = service.createTask({ projectId: "default", title: "B", body: "" });
    await service.runNext(second.id);
    service.approve(second.id, { step: "requirements", submission: 1 });
    await service.runNext(second.id);
    await service.runNext(second.id);
    const call = executor.calls.filter(isDive).at(-1);
    expect(call && prompt(call)).toContain("リポジトリに書く：ほかのチームと共有しているため");
    expect(call && prompt(call)).toContain(`${causeKey}：原因`);
    expect(service.get(second.id)?.task.audit?.findings[0]?.causeKey).toBe(causeKey);
  });

  it("採用を記録したが作る前に止まった改修のタスクは、起動のときに1回だけ作る", async () => {
    const { activity, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "AuditProposalAdopted",
            payload: { proposalId: repo.id, target: repo.target, fixTaskId: "fix-1" },
          },
        },
      ],
    });
    const restarted = makeService(activity, [], { audit: true }).service;
    expect(restarted.get("fix-1")).toBeUndefined();
    restarted.resumeAuditFixTasks();
    expect(restarted.get("fix-1")?.task.auditFix).toEqual({ taskId: id, proposalId: repo.id });
    restarted.resumeAuditFixTasks();
    expect(restarted.list().filter((t) => t.id === "fix-1")).toHaveLength(1);
  });

  it("この機能より前に完了していたタスク（起動のときに畳み込むだけ）は監査しない", async () => {
    const { activity, id } = await completedTask(() => undefined, { audit: false });
    const restarted = makeService(activity, [], { audit: true }).service;
    expect(restarted.get(id)?.task.audit).toBeUndefined();
    expect(restarted.queuedTaskIds()).not.toContain(id);
  });

  it("中止したタスクの提案は採用・却下できない", async () => {
    const { service, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    await service.cancel(id);
    await expect(service.adoptAuditProposal(repo.id, { target: repo.target })).rejects.toThrow(
      "中止されたため",
    );
    await expect(service.rejectAuditProposal(repo.id, { reason: "理由" })).rejects.toThrow(
      "中止されたため",
    );
  });

  it("完了したタスクに実行待ち・実行中の監査があるあいだは、プロジェクトを削除できず、監査が終われば削除できる", async () => {
    const { service, executor, id } = await completedTask((invocation) =>
      isSurvey(invocation) ? survey([]) : undefined,
    );
    // 実行待ち
    expect(service.queuedTaskIds()).toContain(id);
    expect(() => service.deleteProject("default")).toThrow(/1件/);
    // 実行中（監査の実行の中で削除する）。実行待ちの判定（設定を読めないと取れない）に頼らず、実行中だけで断る
    let during: unknown;
    const respond = executor.respond;
    executor.respond = (invocation) => {
      const queued = vi.spyOn(service, "queuedTaskIds").mockImplementation(() => {
        throw new Error("config");
      });
      try {
        service.deleteProject("default");
      } catch (error) {
        during = error;
      } finally {
        queued.mockRestore();
      }
      return respond?.(invocation);
    };
    await service.runNext(id);
    expect(during).toBeInstanceOf(InvalidOperationError);
    expect((during as InvalidOperationError).messages).toEqual([
      { code: "project.hasActiveTasks", params: { count: 1 } },
    ]);
    expect(service.getProject("default")).toBeDefined();
    // 監査が終われば削除できる
    executor.respond = respond;
    for (let i = 0; i < 5 && service.queuedTaskIds().includes(id); i++) await service.runNext(id);
    expect(service.get(id)?.task.audit?.completedAt).toBeDefined();
    service.deleteProject("default");
    expect(service.getProject("default")).toBeUndefined();
  });

  it("完了したタスクへの質問に回答しているあいだは、プロジェクトを削除できず、回答の後は削除できる", async () => {
    const { service, id } = await completedTask(() => undefined, { audit: false });
    const { answered } = service.askQuestion(id, { text: "何をした？" });
    expect(() => service.deleteProject("default")).toThrow(/1件/);
    await answered;
    service.deleteProject("default");
    expect(service.getProject("default")).toBeUndefined();
  });

  it("採用の途中（秘密情報を伏せる間）にプロジェクトを削除したら、改修のタスクを作らずに断る", async () => {
    const { service, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    // 監査は終わっているので、削除できる
    expect(service.queuedTaskIds()).not.toContain(id);
    const adopting = service.adoptAuditProposal(repo.id, {
      target: repo.target,
      note: { kind: "supplement", text: "補足" },
    });
    service.deleteProject("default");
    const before = service.list().length;
    await expect(adopting).rejects.toThrow(InvalidOperationError);
    expect(service.list().length).toBe(before);
    expect(service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision).toBeUndefined();
  });

  it("採用を記録した後にプロジェクトを消したら、起動のときに改修のタスクを作らない", async () => {
    const { activity, id, proposals } = await auditedWithProposals();
    const [repo] = proposals;
    if (!repo) throw new Error("proposals");
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "AuditProposalAdopted",
            payload: { proposalId: repo.id, target: repo.target, fixTaskId: "fix-1" },
          },
        },
      ],
    });
    // プロジェクトの無い保存先で起動し直す（消したプロジェクト）
    const restarted = makeService(activity, [], {
      audit: true,
      projects: new MemoryProjectStore(),
    }).service;
    restarted.resumeAuditFixTasks();
    expect(restarted.get("fix-1")).toBeUndefined();
  });
});

describe("完了したタスクの監査の待ち行列（PBI-125 DA）", () => {
  it("監査だけが残る完了したタスクは、後に作った作業中のタスクより後に並べる（作業の実行の枠を塞がない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: async () => ({
        steps: ["requirements" as const],
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    executor.respond = () => ({
      kind: "completed",
      output: "# 要求要件",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    const old = service.createTask({ projectId: "default", title: "古い", body: "" });
    await service.runNext(old.id);
    service.approve(old.id, { step: "requirements", submission: 1 });
    const next = service.createTask({ projectId: "default", title: "新しい", body: "" });
    expect(service.get(old.id)?.task.audit).toBeDefined();
    expect(service.queuedTaskIds()).toEqual([next.id, old.id]);
  });
});

describe("分割した親子のタスクの監査（PBI-125）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
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
          steps: ["requirements" as const, "design" as const, "split" as const],
          plan: "split" as const,
          reason: "大きいので分ける",
          fallback: false,
          costUsd: 0,
          estimated: false,
        };

  it("子タスクも親タスクも、それぞれ完了した瞬間に監査を待つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        out("# 要求要件"),
        out(
          '# 設計\n\n```json\n{"sacty-test-viewpoints": [{"title": "t", "input": "i", "expected": "e"}]}\n```',
        ),
        out(
          `分け方\n\n\`\`\`json\n${JSON.stringify({
            "sacty-split": {
              reason: "分ける",
              children: [
                { key: "A", title: "A", body: "", dependsOn: [] },
                { key: "B", title: "B", body: "", dependsOn: [] },
              ],
            },
          })}\n\`\`\``,
        ),
        out("# A の調査"),
        out("# B の調査"),
      ],
      { planner, audit: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "親" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    const children = (service.get(id)?.task.split?.children ?? []).map((c) => c.taskId);
    expect(children).toHaveLength(2);
    for (const child of children) {
      await service.runNext(child);
      service.approve(child, { step: "investigate", submission: 1 });
      expect(service.get(child)?.task.audit).toBeDefined();
    }
    // 子がすべて終わるまで、親は監査しない
    expect(service.get(id)?.task.audit).toBeUndefined();
    await service.runNext(id);
    const parent = service.get(id)?.task;
    expect(parent && isCompleted(parent)).toBe(true);
    expect(parent?.audit).toBeDefined();
    activity.close();
  });
});

describe("この機能より前に完了したタスクへの、後からの記録（PBI-125 DA）", () => {
  it("完了の後に質問しても、監査を始めない（完了した瞬間の追記でだけ始める）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const before = makeService(activity, [], {
      planner: async () => ({
        steps: ["requirements" as const],
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    before.executor.respond = () => ({
      kind: "completed",
      output: "# 要求要件",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    const task = before.service.createTask({ projectId: "default", title: "A", body: "" });
    await before.service.runNext(task.id);
    before.service.approve(task.id, { step: "requirements", submission: 1 });

    const after = makeService(activity, [], { audit: true });
    after.executor.respond = () => ({
      kind: "completed",
      output: "答え",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    await after.service.askQuestion(task.id, { text: "どうだった？" }).answered;
    const latest = after.service.get(task.id)?.task;
    expect(latest?.questions[0]?.answer?.text).toBe("答え");
    expect(latest?.audit).toBeUndefined();
  });
});

describe("監査のレビューの指摘（PR #135）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const survey = (concerns: { step: string; reason: string }[], summary = "要約") =>
    json({ "sacty-audit-survey": { summary, concerns } });
  const dive = (findings: unknown[]) =>
    json({ "sacty-audit-findings": { summary: "深掘り", findings } });
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  /** 監査の実行に渡した台帳の全文（実行の後に消されるので、実行の中で読む）。 */
  const ledgerOf = (invocation: Invocation) => {
    const mount = invocation.mounts?.find((m) => m.containerPath === "/sacty-ledger");
    return mount
      ? {
          readOnly: mount.readOnly,
          text: readFileSync(join(mount.hostPath, "ledger.jsonl"), "utf8"),
        }
      : undefined;
  };

  async function complete(
    service: TaskService,
    executor: FakeExecutor,
    body: string,
  ): Promise<string> {
    const previous = executor.respond;
    executor.respond = (invocation) => previous?.(invocation) ?? out("# 要求要件");
    const task = service.createTask({ projectId: "default", title: "A", body });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    return task.id;
  }

  it("監査の材料（本文・却下の理由）と出力は、切り詰める前に秘密情報を伏せる。台帳の全文も伏せて読み取り専用で渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    const ledgers: { readOnly: boolean; text: string }[] = [];
    // 本文の切り詰める境界（3000 文字）に秘密の値をまたがせる。形で分かる秘密情報も入れる
    const body = `${"あ".repeat(2995)}oauth-secret の後ろ ghp_${"A".repeat(36)}`;
    executor.respond = (invocation) => {
      const ledger = ledgerOf(invocation);
      if (ledger) ledgers.push(ledger);
      if (isSurvey(invocation)) {
        return survey([{ step: "requirements", reason: "理由" }], "要約 ghp_secret を見た");
      }
      if (isDive(invocation)) {
        return dive([
          {
            title: "原因 ghp_secret",
            detail: "",
            evidence: [],
            proposals: [{ title: "直す", body: "ghp_secret を消す", target: 0 }],
          },
        ]);
      }
      return undefined;
    };
    const id = await complete(service, executor, body);
    await service.runNext(id);
    await service.runNext(id);
    const surveyCall = executor.calls.find(isSurvey);
    const text = surveyCall ? prompt(surveyCall) : "";
    expect(text).not.toContain("oauth-secret");
    expect(text).not.toContain("oauth-se");
    expect(text).not.toContain(`ghp_${"A".repeat(36)}`);
    // 伏せてから切るので、境界には伏せた印（の先頭）だけが残る
    expect(text).toContain("あ[REDA");
    // 台帳の全文も伏せる。読み取り専用
    expect(ledgers.length).toBeGreaterThan(0);
    for (const ledger of ledgers) {
      expect(ledger.readOnly).toBe(true);
      expect(ledger.text).not.toContain("oauth-secret");
    }
    // 監査の出力も、記録の前に伏せる
    const audit = service.get(id)?.task.audit;
    expect(audit?.survey?.summary).toBe("要約 [REDACTED] を見た");
    expect(audit?.findings[0]?.title).toBe("原因 [REDACTED]");
    expect(audit?.findings[0]?.proposals[0]?.body).toBe("[REDACTED] を消す");

    // 却下の理由に書いた秘密の値も、次の監査には伏せて渡す
    const proposalId = audit?.findings[0]?.proposals[0]?.id ?? "";
    await service.rejectAuditProposal(proposalId, { reason: "oauth-secret を書いてしまった" });
    const second = await complete(service, executor, "B");
    await service.runNext(second);
    await service.runNext(second);
    const diveCall = executor.calls.filter(isDive).at(-1);
    expect(diveCall && prompt(diveCall)).toContain("[REDACTED] を書いてしまった");
    expect(diveCall && prompt(diveCall)).not.toContain("oauth-secret");
  });

  it("指示で省いた作業履歴の行も、台帳の全文で読める。使ったコンテキストの版を指示に入れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    let ledger = "";
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) {
        ledger = ledgerOf(invocation)?.text ?? "";
        return survey([]);
      }
      return out("# 要求要件");
    };
    const task = service.createTask({ projectId: "default", title: "A", body: "" });
    await service.runNext(task.id);
    // 長い作業履歴（質問と答えを何度も繰り返す）で、指示から中ほどの行を省かせる
    const previous = executor.respond;
    executor.respond = (invocation) =>
      prompt(invocation).includes("--- 質問 ---")
        ? out(`答え ${"y".repeat(400)}`)
        : previous?.(invocation);
    for (let i = 0; i < 60; i++) {
      await service.askQuestion(task.id, { text: `質問 ${i} ${"x".repeat(400)}` }).answered;
    }
    service.approve(task.id, { step: "requirements", submission: 1 });
    await service.runNext(task.id);
    const call = executor.calls.find(isSurvey);
    const text = call ? prompt(call) : "";
    expect(text).toMatch(/件を省きました/);
    expect(text).toContain("/sacty-ledger/ledger.jsonl");
    expect(text).toContain("使ったコンテキストの版");
    // 指示に無い行も、全文にはある
    const ids = (service.get(task.id)?.activity ?? []).map((e) => e.id);
    const missing = ids.filter((eventId) => !text.includes(`(event ${eventId})`));
    expect(missing.length).toBeGreaterThan(0);
    for (const eventId of missing.slice(0, 5)) expect(ledger).toContain(`"id":"${eventId}"`);
  });

  it("完了の記録と監査の登録は、同じ追記で保存する（間で止まっても監査が抜けない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    executor.respond = () => out("# 要求要件");
    const task = service.createTask({ projectId: "default", title: "A", body: "" });
    await service.runNext(task.id);
    const appends: string[][] = [];
    const original = activity.append.bind(activity);
    activity.append = (input) => {
      appends.push(input.events.map((e) => (e.event as { type: string }).type));
      return original(input);
    };
    service.approve(task.id, { step: "requirements", submission: 1 });
    expect(appends).toEqual([["StepApproved", "AuditQueued"]]);
  });

  it("同じプロジェクトの深掘りを同時に始めても、1つずつ実行し、同じ新しい原因は1つの鍵にまとまる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) return survey([{ step: "requirements", reason: "理由" }]);
      if (!isDive(invocation)) return undefined;
      // 既存の原因に同じ題があれば、その鍵を使う（AI の判断の代わり）
      const known = /- ([^\s：]+)：同じ新しい原因/.exec(prompt(invocation))?.[1];
      return dive([
        {
          ...(known ? { sameAs: known } : {}),
          title: "同じ新しい原因",
          detail: "",
          evidence: [],
          proposals: [],
        },
      ]);
    };
    const a = await complete(service, executor, "A");
    const b = await complete(service, executor, "B");
    await service.runNext(a);
    await service.runNext(b);
    await Promise.all([service.runNext(a), service.runNext(b)]);
    const keyOf = (id: string) => service.get(id)?.task.audit?.findings[0]?.causeKey;
    expect(keyOf(a)).toBeDefined();
    expect(keyOf(a)).toBe(keyOf(b));
  });

  it("改修のタスクの対象リポジトリは、元のタスクと同じ形にそろえ、元と同じ URL で clone する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([
              {
                title: "原因",
                detail: "",
                evidence: [],
                proposals: [{ title: "直す", body: "本文", target: 0 }],
              },
            ])
          : undefined;
    const id = await complete(service, executor, "A");
    await service.runNext(id);
    await service.runNext(id);
    const original = repos.prepared[0]?.url ?? "";
    expect(original).toMatch(/\.git$/);
    const proposal = service.get(id)?.task.audit?.findings[0]?.proposals[0];
    if (!proposal) throw new Error("proposal");
    expect(proposal.target).toEqual({ kind: "repository", repo: original.replace(/\.git$/, "") });
    await service.adoptAuditProposal(proposal.id, { target: proposal.target });
    const decision = service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision;
    const fixId = decision?.kind === "adopted" ? (decision.fixTaskId ?? "") : "";
    await service.runNext(fixId);
    expect(repos.prepared.at(-1)?.url).toBe(original);
  });

  it("大まかな監査も深掘りも、毎回新しいセッション（再開しない）で、実行の ID も別", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
      orchestratorSessions: new OrchestratorSessionStore(join(dir, "sessions")),
    });
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([])
          : undefined;
    const id = await complete(service, executor, "A");
    await service.runNext(id);
    await service.runNext(id);
    const audits = executor.calls.filter((c) => isSurvey(c) || isDive(c));
    expect(audits).toHaveLength(2);
    for (const call of audits) {
      expect(call.command).not.toContain("--resume");
      expect(call.command).not.toContain("--continue");
      expect(call.command.includes("resume")).toBe(false);
    }
    const runIds = (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AuditSurveyed" || e.type === "AuditDeepDived" ? [e.payload.runId] : [],
    );
    expect(new Set(runIds).size).toBe(2);
  });
});

describe("監査の再レビューの指摘（PR #135）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const survey = (concerns: { step: string; reason: string }[]) =>
    json({ "sacty-audit-survey": { summary: "要約", concerns } });
  const dive = (findings: unknown[]) =>
    json({ "sacty-audit-findings": { summary: "深掘り", findings } });
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const token = `ghp_${"A".repeat(36)}`;

  async function complete(service: TaskService, title: string): Promise<string> {
    const task = service.createTask({ projectId: "default", title, body: "" });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    return task.id;
  }

  it("監査に渡すセッションログは、秘密情報を伏せた写しにする（元のログは変えない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
      sessionLogs,
    });
    executor.respond = (invocation) => (isSurvey(invocation) ? survey([]) : out("# 要求要件"));
    const id = await complete(service, "A");
    // 実行のログにだけある秘密情報（実行に渡した値ではないので、ログの保存では伏せられない）
    const runId = (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunCompleted" ? [e.payload.runId] : [],
    )[0];
    const path = sessionLogs.path(id, runId ?? "", "events") ?? "";
    appendFileSync(path, `${JSON.stringify({ type: "tool_result", content: `token ${token}` })}\n`);
    await service.runNext(id);
    const mounted = executor.logMounts.at(-1);
    const files = Object.entries(mounted?.files ?? {});
    expect(files.some(([name]) => name.endsWith("events.jsonl"))).toBe(true);
    for (const [, text] of files) expect(text).not.toContain(token);
    expect(files.some(([, text]) => text.includes("[REDACTED]"))).toBe(true);
    // 元のログは変えない
    expect(readFileSync(path, "utf8")).toContain(token);
  });

  it("却下の理由は、記録する前に秘密情報を伏せる。前の記録も、画面に出す前に形で伏せる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([
              {
                title: "原因",
                detail: "",
                evidence: [],
                proposals: [
                  { title: "提案1", body: "", target: 0 },
                  { title: "提案2", body: "", target: 0 },
                ],
              },
            ])
          : out("# 要求要件");
    const id = await complete(service, "A");
    await service.runNext(id);
    await service.runNext(id);
    const [first, second] = service.get(id)?.task.audit?.findings[0]?.proposals ?? [];
    await service.rejectAuditProposal(first?.id ?? "", { reason: `値は ${token} と ghp_secret` });
    const stored = service.get(id)?.task.audit?.findings[0]?.proposals[0]?.decision;
    expect(stored).toMatchObject({ kind: "rejected", reason: "値は [REDACTED] と [REDACTED]" });
    // 伏せる前に記録された理由（この修正より前の記録）も、画面の形にするときに伏せる
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "AuditProposalRejected",
            payload: { proposalId: second?.id ?? "", reason: `前の記録 ${token}` },
          },
        },
      ],
    });
    const restarted = makeService(activity, [], { audit: true }).service;
    const view = await new LedgerAuditService(restarted).projectAudits("default");
    const reasons = (view?.proposals ?? []).map((p) =>
      p.decision?.kind === "rejected" ? p.decision.reason : "",
    );
    expect(reasons.join(" ")).not.toContain(token);
    expect(reasons).toContain("前の記録 [REDACTED]");
  });

  it("深掘りの順番を待っているタスクの中止は、先の深掘りの終わりを待たない。後の深掘りは順番を保って進む", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD], {
      audit: true,
      planner: onlyRequirements,
    });
    const order: string[] = [];
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) return survey([{ step: "requirements", reason: "理由" }]);
      if (isDive(invocation)) {
        const title = /題：(監査[ABC])/.exec(prompt(invocation))?.[1] ?? "";
        order.push(title);
        // A の深掘りは、止められるまで終わらない
        return title === "監査A" ? undefined : dive([]);
      }
      return out("# 要求要件");
    };
    const a = await complete(service, "監査A");
    const b = await complete(service, "監査B");
    const c = await complete(service, "監査C");
    for (const id of [a, b, c]) await service.runNext(id);
    const runningA = service.runNext(a);
    const heldRun = await executor.started.promise;
    const waitingB = service.runNext(b);
    const waitingC = service.runNext(c);
    // B は A の深掘りの後を待っている。中止は A の終わりを待たずに終わる
    await service.cancel(b);
    await waitingB;
    expect(service.get(b)?.task.status).toBe("cancelled");
    expect(order).toEqual(["監査A"]);
    // A を終わらせると、C が順番どおりに深掘りする
    executor.kill(heldRun);
    await runningA;
    await waitingC;
    expect(order).toEqual(["監査A", "監査C"]);
    expect(service.get(c)?.task.audit?.dives).toHaveLength(1);
  });
});

describe("監査の再々レビューの指摘（PR #135）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const survey = (concerns: { step: string; reason: string }[]) =>
    json({ "sacty-audit-survey": { summary: "要約", concerns } });
  const dive = (findings: unknown[]) =>
    json({ "sacty-audit-findings": { summary: "深掘り", findings } });
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  async function complete(service: TaskService, title: string, body = ""): Promise<string> {
    const task = service.createTask({ projectId: "default", title, body });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    return task.id;
  }

  it("監査だけで使う AI の秘密の値（決まった形でない値）も、材料・却下の理由・画面の題から伏せる", async () => {
    // 監査の AI だけが使う API キー（よくある秘密情報の形ではない）
    const secretValue = "zz-audit-only-7f3k";
    const base = configOf(agent());
    const config = (): ConfigResult => {
      const c = base();
      if (!c.ok) return c;
      return {
        ok: true,
        config: {
          ...c.config,
          auditAgent: agent({
            id: "auditor",
            runtime: "claude-code",
            auth: { mode: "api-key", secret: "audit-api-key" },
          }),
        },
      };
    };
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
      config,
      secrets: {
        "claude-oauth-token": "oauth-secret",
        "github-token": "ghp_secret",
        "audit-api-key": secretValue,
      },
    });
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? survey([{ step: "requirements", reason: "理由" }])
        : isDive(invocation)
          ? dive([
              {
                title: "原因",
                detail: "",
                evidence: [],
                proposals: [{ title: "直す", body: "", target: 0 }],
              },
            ])
          : out("# 要求要件");
    const id = await complete(service, `題 ${secretValue}`, `本文 ${secretValue}`);
    await service.runNext(id);
    await service.runNext(id);
    const sent = executor.calls
      .filter((c) => isSurvey(c) || isDive(c))
      .map(prompt)
      .join("\n");
    expect(sent).not.toContain(secretValue);
    const proposal = service.get(id)?.task.audit?.findings[0]?.proposals[0];
    await service.rejectAuditProposal(proposal?.id ?? "", { reason: `理由 ${secretValue}` });
    const view = await new LedgerAuditService(service).projectAudits("default");
    const shown = JSON.stringify(view);
    expect(shown).not.toContain(secretValue);
    expect(view?.audits[0]?.taskTitle).toBe("題 [REDACTED]");
  });

  it("末尾の待機を中止した後に来た深掘りも、先の深掘りの終わりを待つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD], {
      audit: true,
      planner: onlyRequirements,
    });
    const order: string[] = [];
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) return survey([{ step: "requirements", reason: "理由" }]);
      if (isDive(invocation)) {
        const title = /題：(監査[ABC])/.exec(prompt(invocation))?.[1] ?? "";
        order.push(title);
        return title === "監査A" ? undefined : dive([]);
      }
      return out("# 要求要件");
    };
    const a = await complete(service, "監査A");
    const b = await complete(service, "監査B");
    const c = await complete(service, "監査C");
    for (const id of [a, b, c]) await service.runNext(id);
    const runningA = service.runNext(a);
    const heldRun = await executor.started.promise;
    const waitingB = service.runNext(b);
    await service.cancel(b);
    await waitingB;
    // B の中止の後に C が来ても、A の深掘りの間は始めない
    const waitingC = service.runNext(c);
    // A の深掘りの間に、C の深掘りが始まっていないこと（何も起きないこと）を見るための猶予
    await idleFor(20);
    expect(order).toEqual(["監査A"]);
    executor.kill(heldRun);
    await runningA;
    await waitingC;
    expect(order).toEqual(["監査A", "監査C"]);
  });
});

describe("監査で伏せる秘密情報の値の使い回し（PR #135 再レビュー指摘）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");

  it("画面を取った後に監査の AI の秘密情報の参照・値を変えても、時間内でも新しい値を材料・却下の理由・画面から伏せる", async () => {
    const values: Record<string, string> = {
      "claude-oauth-token": "oauth-secret",
      "github-token": "ghp_secret",
      "audit-old": "zz-old-value-1",
      "audit-new": "zz-new-value-9",
      "audit-rotated": "zz-before-rotate",
    };
    let ref = "audit-old";
    const base = configOf(agent());
    const config = (): ConfigResult => {
      const c = base();
      if (!c.ok) return c;
      return {
        ok: true,
        config: {
          ...c.config,
          auditAgent: agent({
            id: "auditor",
            auth: { mode: "api-key", secret: ref },
          }),
        },
      };
    };
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      config,
      // 時刻を止めて、使い回す時間の中で確かめる
      now: () => Date.parse("2026-10-17T00:00:00Z"),
      secretStore: { get: async (name: string) => values[name] ?? "" },
      planner: async () => ({
        steps: ["requirements" as const],
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? json({
            "sacty-audit-survey": {
              summary: "要約",
              concerns: [{ step: "requirements", reason: "理由" }],
            },
          })
        : isDive(invocation)
          ? json({
              "sacty-audit-findings": {
                summary: "深掘り",
                findings: [
                  {
                    title: "原因",
                    detail: "",
                    evidence: [],
                    proposals: [{ title: "直す", body: "", target: 0 }],
                  },
                ],
              },
            })
          : out("# 要求要件");
    // 画面を取って、古い参照で値を持たせる
    const view = new LedgerAuditService(service);
    await view.projectAudits("default");
    // 監査の AI の秘密情報の参照を変える（使い回す時間の中）
    ref = "audit-new";
    const task = service.createTask({
      projectId: "default",
      title: "題 zz-new-value-9",
      body: "本文 zz-new-value-9",
    });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    await service.runNext(task.id);
    // 同じ参照のまま値を入れ替えても、送る前は今の値で伏せる
    ref = "audit-rotated";
    await view.projectAudits("default");
    values["audit-rotated"] = "zz-after-rotate";
    await service.runNext(task.id);
    // 大まかな監査は、参照を変えた直後（audit-new の間）に送った。深掘りは値を入れ替えた後（audit-rotated）に送った
    const surveyed = executor.calls.filter(isSurvey).map(prompt).join("\n");
    expect(surveyed).toContain("本文");
    expect(surveyed).not.toContain("zz-new-value-9");
    const proposal = service.get(task.id)?.task.audit?.findings[0]?.proposals[0];
    await service.rejectAuditProposal(proposal?.id ?? "", { reason: "理由 zz-after-rotate" });
    expect(service.get(task.id)?.task.audit?.findings[0]?.proposals[0]?.decision).toMatchObject({
      kind: "rejected",
      reason: "理由 [REDACTED]",
    });
    // 画面は、参照を変えたら使い回さない
    ref = "audit-new";
    const shown = await view.projectAudits("default");
    expect(JSON.stringify(shown)).not.toContain("zz-new-value-9");
    expect(shown?.audits[0]?.taskTitle).toBe("題 [REDACTED]");
  });

  const configWithAuditRef = (current: () => string) => {
    const base = configOf(agent());
    return (): ConfigResult => {
      const c = base();
      if (!c.ok) return c;
      return {
        ok: true,
        config: {
          ...c.config,
          auditAgent: agent({ id: "auditor", auth: { mode: "api-key", secret: current() } }),
        },
      };
    };
  };
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const survey = json({
    "sacty-audit-survey": { summary: "要約", concerns: [{ step: "requirements", reason: "理由" }] },
  });
  const dive = json({ "sacty-audit-findings": { summary: "深掘り", findings: [] } });

  it("同じ参照の値を入れ替えたら、監査を挟まずに画面を取り直しても、時間内でも新しい値を伏せる（PR #135 再レビュー指摘）", async () => {
    const values: Record<string, string> = {
      "claude-oauth-token": "oauth-secret",
      "github-token": "ghp_secret",
      "audit-key": "zz-first-value",
    };
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      config: configWithAuditRef(() => "audit-key"),
      now: () => Date.parse("2026-10-17T00:00:00Z"),
      secretStore: { get: async (name: string) => values[name] ?? "" },
      planner: onlyRequirements,
    });
    executor.respond = (invocation) =>
      isSurvey(invocation) ? survey : isDive(invocation) ? dive : out("# 要求要件");
    const task = service.createTask({
      projectId: "default",
      title: "題 zz-second-value",
      body: "",
    });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    const view = new LedgerAuditService(service);
    expect((await view.projectAudits("default"))?.audits[0]?.taskTitle).toBe("題 zz-second-value");
    // 監査も却下もしないまま、同じ参照の値だけを入れ替える
    values["audit-key"] = "zz-second-value";
    const shown = await view.projectAudits("default");
    expect(JSON.stringify(shown)).not.toContain("zz-second-value");
    expect(shown?.audits[0]?.taskTitle).toBe("題 [REDACTED]");
  });

  it("深掘りの順番を待つ間に監査の AI の秘密情報の参照を変えても、送る前に今の設定の値を伏せる（PR #135 再レビュー指摘）", async () => {
    const values: Record<string, string> = {
      "claude-oauth-token": "oauth-secret",
      "github-token": "ghp_secret",
      "old-ref": "zz-old-ref-value",
      "new-ref": "zz-new-ref-value",
    };
    let ref = "old-ref";
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD], {
      audit: true,
      config: configWithAuditRef(() => ref),
      secretStore: { get: async (name: string) => values[name] ?? "" },
      planner: onlyRequirements,
    });
    const dived: string[] = [];
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) return survey;
      if (isDive(invocation)) {
        dived.push(prompt(invocation));
        // A の深掘りは、止められるまで終わらない
        return prompt(invocation).includes("題：監査A") ? undefined : dive;
      }
      return out("# 要求要件");
    };
    const make = async (title: string, body: string) => {
      const task = service.createTask({ projectId: "default", title, body });
      await service.runNext(task.id);
      service.approve(task.id, { step: "requirements", submission: 1 });
      await service.runNext(task.id);
      return task.id;
    };
    const a = await make("監査A", "");
    const b = await make("監査B", "本文 zz-new-ref-value");
    const runningA = service.runNext(a);
    const heldRun = await executor.started.promise;
    // B は A の深掘りの後を待つ。その間に参照を変える
    const waitingB = service.runNext(b);
    // B が、A の深掘りの後を待つ所まで進むための猶予。猶予が短くても、テストは誤って落ちない
    // （B は、変えた後の参照だけを読むことになり、伏せる値は同じ）
    await idleFor(20);
    ref = "new-ref";
    executor.kill(heldRun);
    await runningA;
    await waitingB;
    const sentB = dived.filter((text) => text.includes("題：監査B")).join("\n");
    expect(sentB).toContain("本文");
    expect(sentB).not.toContain("zz-new-ref-value");
    expect(sentB).toContain("[REDACTED]");
  });

  it("監査の AI の実行中に同じ参照の値を変えても、結果・失敗の理由は記録する前に今の値で伏せる（PR #135 再レビュー指摘）", async () => {
    const values: Record<string, string> = {
      "claude-oauth-token": "oauth-secret",
      "github-token": "ghp_secret",
      "audit-key": "zz-start-value",
    };
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      config: configWithAuditRef(() => "audit-key"),
      secretStore: { get: async (name: string) => values[name] ?? "" },
      planner: onlyRequirements,
    });
    // 監査の AI が動いている間に値を入れ替え、入れ替えた後の値を結果に入れて返す
    executor.respond = (invocation) => {
      const text = prompt(invocation);
      if (isSurvey(invocation)) {
        values["audit-key"] = "zz-during-survey";
        if (text.includes("題：監査B")) {
          return { kind: "failed", reason: "error", message: "失敗 zz-during-survey" };
        }
        // 実行器の例外も、失敗の結果として同じように伏せる
        if (text.includes("題：監査C")) throw new Error("例外 zz-during-survey");
        return json({
          "sacty-audit-survey": {
            summary: "要約 zz-during-survey",
            concerns: [{ step: "requirements", reason: "理由 zz-during-survey" }],
          },
        });
      }
      if (isDive(invocation)) {
        values["audit-key"] = "zz-during-dive";
        return json({
          "sacty-audit-findings": {
            summary: "深掘り zz-during-dive",
            findings: [
              {
                title: "原因 zz-during-dive",
                detail: "",
                evidence: [],
                proposals: [{ title: "直す zz-during-dive", body: "", target: 0 }],
              },
            ],
          },
        });
      }
      return out("# 要求要件");
    };
    const make = async (title: string) => {
      const task = service.createTask({ projectId: "default", title, body: "" });
      await service.runNext(task.id);
      service.approve(task.id, { step: "requirements", submission: 1 });
      return task.id;
    };
    const a = await make("監査A");
    await service.runNext(a);
    await service.runNext(a);
    const b = await make("監査B");
    await service.runNext(b);
    const c = await make("監査C");
    await service.runNext(c);
    const recorded = JSON.stringify(
      [a, b, c].flatMap((id) => activity.forTask(id).filter((e) => e.type.startsWith("Audit"))),
    );
    expect(recorded).toContain("要約 [REDACTED]");
    expect(recorded).toContain("原因 [REDACTED]");
    expect(recorded).toContain("失敗 [REDACTED]");
    expect(recorded).toContain("例外 [REDACTED]");
    expect(recorded).not.toContain("zz-during-survey");
    expect(recorded).not.toContain("zz-during-dive");
  });
});

describe("監査のメモリー（PBI-126）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const isStep = (invocation: Invocation) => !isSurvey(invocation) && !isDive(invocation);
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const memory = (patch: Record<string, unknown> = {}) => ({
    scope: "project",
    title: "テストは npm test で走らせる",
    summary: "テストの走らせ方",
    body: "pnpm ではなく npm を使う",
    ...patch,
  });
  /** 監査が、懸念のある工程を1つ挙げ、その深掘りで memories を登録する。 */
  const auditing =
    (memories: () => unknown[]) =>
    (invocation: Invocation): AgentOutcome | undefined => {
      if (isSurvey(invocation)) {
        return json({
          "sacty-audit-survey": {
            summary: "要約",
            concerns: [{ step: "requirements", reason: "差し戻し" }],
          },
        });
      }
      if (isDive(invocation)) {
        return json({
          "sacty-audit-findings": { summary: "深掘り", findings: [], memories: memories() },
        });
      }
      return out("# 要求要件");
    };
  const memoryRoot = () => join(dir, "memory");
  const projectDir = (id = "default") => join(memoryRoot(), "projects", id);
  const repoDir = () => join(memoryRoot(), "repos", "github.com", "acme", "app");

  /** タスクを作って完了させ、監査を終える。 */
  async function completeAndAudit(
    service: TaskService,
    title: string,
    projectId = "default",
  ): Promise<string> {
    const task = service.createTask({ projectId, title, body: "" });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    for (let i = 0; i < 3 && service.get(task.id)?.task.audit?.completedAt === undefined; i++) {
      await service.runNext(task.id);
    }
    return task.id;
  }

  it("依頼者が決めた答えを書いたメモリーは、プロジェクトの階層もリポジトリの階層も登録せず、登録しなかった題と理由を作業履歴に残す。ほかは登録する（PBI-302 B6。S14 r5）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    executor.respond = auditing(() => [
      // 依頼者を主語にして答えを書いた
      memory({
        title: "rooms の業務のルールは、依頼者が削られたくないものとして扱った",
        summary: "予約のルール",
        body: "依頼者は、15 分にそろえることを削ってほしくないと答えた",
      }),
      // 依頼の本文を写した
      memory({
        scope: "repository",
        title: "予約の戻し方",
        summary: "戻し方",
        body: "削除した予約を、あとから元に戻せるようにしてください。API だけで構いません",
      }),
      // リポジトリの事実
      memory({
        title: "削除は物理削除",
        summary: "削除の実装",
        body: "reservations.ts の delete は行を消す。deletedAt の列は migration にも無い",
      }),
    ]);
    const task = service.createTask({
      projectId: "default",
      title: "削除した予約を元に戻せるようにする",
      body: "予約を間違えて削除してしまう人がいます。削除した予約を、あとから元に戻せるようにしてください。API だけで構いません。",
    });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    for (let i = 0; i < 3 && service.get(task.id)?.task.audit?.completedAt === undefined; i++) {
      await service.runNext(task.id);
    }
    expect(service.get(task.id)?.task.audit?.memories.map((m) => m.title)).toEqual([
      "削除は物理削除",
    ]);
    const dived = service.get(task.id)?.activity.find((e) => e.type === "AuditDeepDived");
    expect(dived?.payload).toMatchObject({
      skippedMemories: [
        {
          title: "rooms の業務のルールは、依頼者が削られたくないものとして扱った",
          reason: "requester_mentioned",
        },
        { title: "予約の戻し方", reason: "requester_text_copied" },
      ],
    });
    // 書き出したメモリーの索引にも、登録しなかったものは無い
    const index = readFileSync(join(projectDir(), "SKILL.md"), "utf8");
    expect(index).toContain("削除は物理削除");
    expect(index).not.toContain("削られたくない");
    expect(existsSync(join(repoDir(), "SKILL.md"))).toBe(false);
    activity.close();
  });

  it("深掘りが登録したメモリーを索引の形で書き出し、次のタスクの工程に読み取り専用で渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    let registered = [
      memory(),
      memory({
        scope: "repository",
        title: "lint は biome",
        summary: "lint の道具",
        body: "biome",
      }),
    ];
    executor.respond = auditing(() => registered);
    const a = await completeAndAudit(service, "A");
    const memories = service.get(a)?.task.audit?.memories ?? [];
    expect(memories.map((m) => [m.scope, m.title])).toEqual([
      ["project", "テストは npm test で走らせる"],
      ["repository", "lint は biome"],
    ]);
    expect(memories[1]).toMatchObject({ repo: "https://github.com/acme/app" });
    // 索引には、リンク・概要・有効な最終利用日だけを書き、中身は references に置く
    const [projectMemory, repoMemory] = memories;
    const index = readFileSync(join(projectDir(), "SKILL.md"), "utf8");
    expect(index).toContain(
      `- [テストは npm test で走らせる](references/${projectMemory?.id}.md)：テストの走らせ方（有効な最終利用日：`,
    );
    expect(index).not.toContain("pnpm ではなく npm を使う");
    expect(
      readFileSync(join(projectDir(), "references", `${projectMemory?.id}.md`), "utf8"),
    ).toContain("pnpm ではなく npm を使う");
    expect(readFileSync(join(repoDir(), "SKILL.md"), "utf8")).toContain(
      `(references/${repoMemory?.id}.md)：lint の道具`,
    );

    // 次のタスクの工程には、両方の階層を読み取り専用でマウントし、読み方を指示する
    registered = [];
    executor.calls.length = 0;
    const b = service.createTask({ projectId: "default", title: "B", body: "" });
    await service.runNext(b.id);
    const step = executor.calls.find(isStep);
    expect(step?.mounts).toEqual(
      expect.arrayContaining([
        { hostPath: projectDir(), containerPath: "/sacty-memory/project", readOnly: true },
        { hostPath: repoDir(), containerPath: "/sacty-memory/repository", readOnly: true },
      ]),
    );
    expect(prompt(step as Invocation)).toContain("--- メモリー ---");
    expect(prompt(step as Invocation)).toContain(
      "いまのタスクに関係するものだけを references/ から開いて",
    );
    expect(step?.command).toEqual(expect.arrayContaining(["--add-dir", "/sacty-memory/project"]));

    // 次の監査の深掘りには、既存のメモリーを渡す（重複を作らない）。メモリーの読み方の指示は足さない
    service.approve(b.id, { step: "requirements", submission: 1 });
    await service.runNext(b.id);
    await service.runNext(b.id);
    const dive = executor.calls.find(isDive);
    expect(prompt(dive as Invocation)).toContain(
      `- ${projectMemory?.id}（プロジェクト）：テストは npm test で走らせる：テストの走らせ方（/sacty-memory/project/references/${projectMemory?.id}.md）`,
    );
    expect(prompt(dive as Invocation)).not.toContain("--- メモリー ---");
    expect(dive?.mounts?.some((m) => m.containerPath === "/sacty-memory/project")).toBe(true);
  });

  it("ゴールガーディアン（判定・最終レビュー・統合レビュー）・オーケストレーター・質問への答え・書き出しにはメモリーを渡さない", () => {
    for (const role of [
      "guardian",
      "final-review",
      "integrate",
      "rework",
      "orchestrator",
      "chat",
      "export",
    ]) {
      expect(MEMORY_STEP_ROLES.has(role as never), role).toBe(false);
    }
    for (const role of ["requirements", "design", "implement", "review"]) {
      expect(MEMORY_STEP_ROLES.has(role as never), role).toBe(true);
    }
  });

  it("プロジェクトの設定を変えて、ほかのプロジェクトが同じリポジトリを扱うと、リポジトリのメモリーだけを渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = projectsWithAccount();
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      projects,
      planner: onlyRequirements,
    });
    let registered = [memory(), memory({ scope: "repository", title: "リポジトリの知見" })];
    executor.respond = auditing(() => registered);
    await completeAndAudit(service, "A");
    // リポジトリの担当を、ほかのプロジェクトに移す
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/web" }],
      githubAccounts: { "github.com": "me" },
    });
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    });
    registered = [];
    executor.calls.length = 0;
    const other = service.createTask({ projectId: "other", title: "B", body: "" });
    await service.runNext(other.id);
    const step = executor.calls.find(isStep);
    const paths = (step?.mounts ?? []).map((m) => m.containerPath);
    expect(paths).toContain("/sacty-memory/repository");
    expect(paths).not.toContain("/sacty-memory/project");
    expect((step?.mounts ?? []).some((m) => m.hostPath.startsWith(projectDir()))).toBe(false);
  });

  it("メモリーが無ければ、マウントも指示もしない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    executor.respond = auditing(() => []);
    const a = await completeAndAudit(service, "A");
    expect(service.get(a)?.task.audit?.memories).toEqual([]);
    expect(existsSync(memoryRoot())).toBe(false);
    executor.calls.length = 0;
    const b = service.createTask({ projectId: "default", title: "B", body: "" });
    await service.runNext(b.id);
    const step = executor.calls.find(isStep);
    // 要求要件の工程は、出典の分類の Input だけをマウントする
    expect((step?.mounts ?? []).map((m) => m.containerPath)).toEqual(["/sacty-input"]);
    expect(prompt(step as Invocation)).not.toContain("--- メモリー ---");
  });

  it("人が消したメモリーはファイルから消え、作業履歴に残る。二度は消せない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    executor.respond = auditing(() => [memory(), memory({ title: "二つめ", summary: "残す" })]);
    const a = await completeAndAudit(service, "A");
    const [first, second] = service.get(a)?.task.audit?.memories ?? [];
    service.deleteAuditMemory(first?.id ?? "");
    expect(existsSync(join(projectDir(), "references", `${first?.id}.md`))).toBe(false);
    expect(existsSync(join(projectDir(), "references", `${second?.id}.md`))).toBe(true);
    expect(readFileSync(join(projectDir(), "SKILL.md"), "utf8")).not.toContain(first?.id ?? "-");
    const deleted = service.get(a)?.task.audit?.memories.find((m) => m.id === first?.id)?.deleted;
    expect(deleted?.reason).toBe("person");
    expect(activity.forTask(a).at(-1)).toMatchObject({
      actor: "person",
      type: "AuditMemoryDeleted",
      payload: { memoryId: first?.id, reason: "person" },
    });
    expect(() => service.deleteAuditMemory(first?.id ?? "")).toThrow(InvalidOperationError);
    expect(() => service.deleteAuditMemory("unknown")).toThrow(InvalidOperationError);
    // 最後の1件を消すと、階層のディレクトリごと消える
    service.deleteAuditMemory(second?.id ?? "");
    expect(existsSync(projectDir())).toBe(false);
  });

  it("階層の件数の上限を超えたら、有効な最終利用日の古いものから消し、登録したタスクの作業履歴に記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      memoryLimit: 2,
      planner: onlyRequirements,
    });
    let n = 0;
    executor.respond = auditing(() => [memory({ title: `知見${++n}` })]);
    const a = await completeAndAudit(service, "A");
    const b = await completeAndAudit(service, "B");
    // 上限ちょうどでは消さない
    expect(service.get(a)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    const c = await completeAndAudit(service, "C");
    expect(service.get(a)?.task.audit?.memories[0]?.deleted?.reason).toBe("capacity");
    expect(service.get(b)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    expect(service.get(c)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    expect(activity.forTask(a).at(-1)).toMatchObject({
      actor: "sacty",
      type: "AuditMemoryDeleted",
      payload: { reason: "capacity" },
    });
    const index = readFileSync(join(projectDir(), "SKILL.md"), "utf8");
    expect(index).not.toContain("知見1");
    expect(index).toContain("知見2");
    expect(index).toContain("知見3");
    expect(readdirSync(join(projectDir(), "references"))).toHaveLength(2);
  });

  it("JSON でエスケープされる文字を含む秘密情報の値も、デコードした後に伏せてからメモリーと原因に記録する（PR #136 レビュー指摘）", async () => {
    // 引用符・バックスラッシュ・末尾の改行を含む値（PR #136 再レビュー指摘）
    const secret = 'zz"q\\p\nend\n';
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
      secrets: { "claude-oauth-token": secret, "github-token": "ghp_secret" },
    });
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) {
        return json({
          "sacty-audit-survey": {
            summary: `要約 ${secret}`,
            concerns: [{ step: "requirements", reason: `理由 ${secret}` }],
          },
        });
      }
      if (isDive(invocation)) {
        return json({
          "sacty-audit-findings": {
            summary: "深掘り",
            findings: [
              {
                title: `原因 ${secret}`,
                detail: "",
                evidence: [{ kind: "retry", text: `根拠 ${secret}` }],
                proposals: [{ title: "直す", body: `本文 ${secret}`, target: 0 }],
              },
            ],
            memories: [
              memory({ title: `題 ${secret}`, summary: `概要 ${secret}`, body: `中身 ${secret}` }),
            ],
          },
        });
      }
      return out("# 要求要件");
    };
    const a = await completeAndAudit(service, "A");
    const recorded = JSON.stringify(activity.forTask(a));
    expect(recorded).not.toContain(JSON.stringify(secret).slice(1, -1));
    const audit = service.get(a)?.task.audit;
    const texts = [
      audit?.survey?.summary,
      audit?.survey?.concerns[0]?.reason,
      audit?.findings[0]?.title,
      audit?.findings[0]?.evidence[0]?.text,
      audit?.findings[0]?.proposals[0]?.body,
      audit?.memories[0]?.title,
      audit?.memories[0]?.summary,
      audit?.memories[0]?.body,
    ];
    for (const text of texts) {
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(secret);
    }
    const files = readdirSync(join(projectDir(), "references")).map((name) =>
      readFileSync(join(projectDir(), "references", name), "utf8"),
    );
    files.push(readFileSync(join(projectDir(), "SKILL.md"), "utf8"));
    for (const file of files) expect(file).not.toContain(secret);
  });

  it("既存のメモリーと同じ（sameAs）なら登録しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    let registered: unknown[] = [memory()];
    executor.respond = auditing(() => registered);
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id;
    registered = [memory({ sameAs: id, title: "同じ知見" })];
    const b = await completeAndAudit(service, "B");
    expect(service.get(b)?.task.audit?.memories).toEqual([]);
    expect(readdirSync(join(projectDir(), "references"))).toEqual([`${id}.md`]);
  });

  it("書き出す場所が無ければ、深掘りにメモリーの登録を求めず、出力にあっても登録しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      planner: onlyRequirements,
    });
    executor.respond = auditing(() => [memory()]);
    const a = await completeAndAudit(service, "A");
    const dive = executor.calls.find(isDive);
    expect(prompt(dive as Invocation)).not.toContain("memories");
    expect(prompt(dive as Invocation)).not.toContain("既存のメモリー");
    expect(service.get(a)?.task.audit?.memories).toEqual([]);
  });

  it("起動のとき、作業履歴に合わせて書き直す（消えたファイルを戻し、記録の無い階層を消す）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    executor.respond = auditing(() => [memory()]);
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id;
    rmSync(join(projectDir(), "references"), { recursive: true });
    mkdirSync(join(projectDir("stale"), "references"), { recursive: true });
    writeFileSync(join(projectDir("stale"), "SKILL.md"), "古い");
    mkdirSync(join(memoryRoot(), "repos", "github.com", "old", "repo"), { recursive: true });

    const restarted = makeService(new SqliteActivityStore(dbPath), [], {
      audit: true,
      memory: true,
    }).service;
    restarted.syncMemories();
    expect(existsSync(join(projectDir(), "references", `${id}.md`))).toBe(true);
    expect(existsSync(projectDir("stale"))).toBe(false);
    expect(existsSync(join(memoryRoot(), "repos", "github.com", "old", "repo"))).toBe(false);
  });
});

describe("メモリーの有効な最終利用日と掃除（PBI-127）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const isStep = (invocation: Invocation) => !isSurvey(invocation) && !isDive(invocation);
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const DAY = 86_400_000;
  const day = (n: number) => Date.parse("2026-10-01T00:00:00.000Z") + (n - 1) * DAY;
  const memoryRoot = () => join(dir, "memory");
  const projectDir = () => join(memoryRoot(), "projects", "default");
  const readRef = (id: string) =>
    readFileSync(join(projectDir(), "references", `${id}.md`), "utf8");

  /** 時計を進められる作業履歴とサービス。監査は、survey と dive の出力を差し替えられる。 */
  function setup(options: { retentionDays?: number; memory?: boolean } = {}): {
    service: TaskService;
    executor: FakeExecutor;
    activity: SqliteActivityStore;
    clock: { now: number };
    audit: {
      useful: () => unknown;
      register: () => unknown[];
      concerns: () => unknown[];
    };
  } {
    const clock = { now: day(1) };
    const activity = new SqliteActivityStore(dbPath, () => new Date(clock.now));
    const { service, executor } = makeService(activity, [], {
      audit: true,
      memory: options.memory ?? true,
      planner: onlyRequirements,
      sessionLogs: new SessionLogStore(join(dir, "runs")),
      now: () => clock.now,
      settings: new MemorySettingsStore({
        intakeLabel: "sacty",
        ...(options.retentionDays ? { memoryRetentionDays: options.retentionDays } : {}),
      }),
    });
    const audit = {
      useful: (): unknown => [],
      register: (): unknown[] => [],
      concerns: (): unknown[] => [{ step: "requirements", reason: "差し戻し" }],
    };
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) {
        return json({
          "sacty-audit-survey": {
            summary: "要約",
            concerns: audit.concerns(),
            usefulMemories: audit.useful(),
          },
        });
      }
      if (isDive(invocation)) {
        return json({
          "sacty-audit-findings": { summary: "深掘り", findings: [], memories: audit.register() },
        });
      }
      return out("# 要求要件");
    };
    return { service, executor, activity, clock, audit };
  }

  const memory = (title: string) => ({
    scope: "project",
    title,
    summary: `${title}の概要`,
    body: `${title}の中身`,
  });

  /** タスクを作って完了させる（監査は待たせたまま）。 */
  async function complete(service: TaskService, title: string): Promise<string> {
    const task = service.createTask({ projectId: "default", title, body: "" });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    return task.id;
  }
  async function audit(service: TaskService, id: string): Promise<void> {
    for (let i = 0; i < 3 && service.get(id)?.task.audit?.completedAt === undefined; i++) {
      await service.runNext(id);
    }
  }

  it("タスクで開き、監査が役に立ったと判断したメモリーだけ、有効な最終利用日をそのタスクの完了日にする", async () => {
    const { service, executor, activity, clock, audit: out1 } = setup();
    out1.register = () => [memory("役に立つ"), memory("開かない")];
    const a = await complete(service, "A");
    await audit(service, a);
    const [useful, unopened] = service.get(a)?.task.audit?.memories ?? [];
    expect(readRef(useful?.id ?? "")).toContain("有効な最終利用日：2026-10-01");

    // 10 日目のタスクで、1つめの中身だけを開く（索引に出てくる2つめの場所は、開いたことにしない）
    clock.now = day(10);
    out1.register = () => [];
    out1.concerns = () => [];
    out1.useful = () => [useful?.id, unopened?.id, "unknown"];
    executor.logLines = (invocation) =>
      isStep(invocation)
        ? [
            JSON.stringify({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    name: "Read",
                    input: { file_path: `/sacty-memory/project/references/${useful?.id}.md` },
                  },
                ],
              },
            }),
            JSON.stringify({ type: "user", text: `- [開かない](references/${unopened?.id}.md)` }),
            "",
          ].join("\n")
        : undefined;
    executor.calls.length = 0;
    const b = await complete(service, "B");
    await audit(service, b);
    const survey = executor.calls.find(isSurvey);
    expect(prompt(survey as Invocation)).toContain(
      `- ${useful?.id}：役に立つ：役に立つの概要（1 回）`,
    );
    expect(prompt(survey as Invocation)).not.toContain(`- ${unopened?.id}：`);
    const surveyed = activity.forTask(b).find((e) => e.type === "AuditSurveyed");
    expect(surveyed?.payload).toMatchObject({
      openedMemories: [useful?.id],
      usefulMemories: [useful?.id],
    });
    expect(readRef(useful?.id ?? "")).toContain("有効な最終利用日：2026-10-10");
    expect(readRef(unopened?.id ?? "")).toContain("有効な最終利用日：2026-10-01");
    expect(readFileSync(join(projectDir(), "SKILL.md"), "utf8")).toContain(
      "役に立つの概要（有効な最終利用日：2026-10-10）",
    );
    // 監査の欄：役に立ったメモリーと、登録したメモリーの有効な最終利用日
    const audits = new LedgerAuditService(service);
    expect((await audits.taskAudit(b))?.usefulMemories).toEqual([
      { id: useful?.id, scope: "project", title: "役に立つ" },
    ]);
    expect((await audits.taskAudit(a))?.memories.map((m) => m.lastUsefulAt.slice(0, 10))).toEqual([
      "2026-10-10",
      "2026-10-01",
    ]);
  });

  it("大まかな監査の途中で止めて再起動しても、前の監査だけが開いたメモリーは数えない（PR #137 レビュー指摘）", async () => {
    const clock = { now: day(1) };
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const first = makeService(new SqliteActivityStore(dbPath, () => new Date(clock.now)), [HOLD], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
      sessionLogs,
      now: () => clock.now,
    });
    let id = "";
    const respond = (executor: FakeExecutor, holdSurvey: boolean) => {
      // 監査の実行のセッションを記録する（止めても残る）
      executor.sessionFiles = () => ({ "projects/-workspace/s.jsonl": "{}\n" });
      executor.logLines = (invocation) =>
        isSurvey(invocation) && id ? `/sacty-memory/project/references/${id}.md\n` : undefined;
      executor.respond = (invocation) => {
        if (isSurvey(invocation)) {
          if (!id) {
            return json({
              "sacty-audit-survey": {
                summary: "要約",
                concerns: [{ step: "requirements", reason: "差し戻し" }],
              },
            });
          }
          return holdSurvey
            ? undefined
            : json({
                "sacty-audit-survey": { summary: "要約", concerns: [], usefulMemories: [id] },
              });
        }
        if (isDive(invocation)) {
          return json({
            "sacty-audit-findings": {
              summary: "深掘り",
              findings: [],
              memories: id ? [] : [memory("知見")],
            },
          });
        }
        return out("# 要求要件");
      };
    };
    respond(first.executor, true);
    const a = await complete(first.service, "A");
    await audit(first.service, a);
    id = first.service.get(a)?.task.audit?.memories[0]?.id ?? "";
    // B の大まかな監査の実行中に止める（監査の記録は残らず、セッションの記録だけが残る）
    const b = await complete(first.service, "B");
    const held = first.service.runNext(b);
    const runId = await first.executor.started.promise;
    first.service.beginShutdown();
    first.executor.finishHeld(
      runId,
      json({ "sacty-audit-survey": { summary: "要約", concerns: [], usefulMemories: [id] } }),
    );
    await held;
    const activity = new SqliteActivityStore(dbPath, () => new Date(clock.now));
    expect(activity.forTask(b).some((e) => e.type === "AuditSurveyed")).toBe(false);
    expect(
      activity
        .forTask(b)
        .some((e) => e.type === "AgentSessionArchived" && e.payload.runId === runId),
    ).toBe(true);
    // 再起動した後の大まかな監査では、前の監査のログを数えない
    const second = makeService(activity, [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
      sessionLogs,
      now: () => clock.now,
    });
    respond(second.executor, false);
    second.executor.logLines = () => undefined;
    await audit(second.service, b);
    expect(activity.forTask(b).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      openedMemories: [],
      usefulMemories: [],
    });
  });

  it("監査の実行のログは数えない。開いたメモリーが無ければ、役に立ったものは記録しない", async () => {
    const { service, executor, activity, audit: out1 } = setup();
    out1.register = () => [memory("知見")];
    const a = await complete(service, "A");
    await audit(service, a);
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    out1.register = () => [];
    out1.useful = () => [id];
    // 監査の実行だけが中身を開く
    executor.logLines = (invocation) =>
      isStep(invocation) ? undefined : `/sacty-memory/project/references/${id}.md\n`;
    const b = await complete(service, "B");
    await audit(service, b);
    const surveyed = activity.forTask(b).find((e) => e.type === "AuditSurveyed");
    expect(surveyed?.payload).toMatchObject({ openedMemories: [], usefulMemories: [] });
  });

  it("古いタスクの監査が後から終わっても、有効な最終利用日を前に戻さない", async () => {
    const { service, executor, clock, audit: out1 } = setup();
    out1.register = () => [memory("知見")];
    const a = await complete(service, "A");
    await audit(service, a);
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    out1.register = () => [];
    out1.concerns = () => [];
    out1.useful = () => [id];
    executor.logLines = (invocation) =>
      isStep(invocation) ? `/sacty-memory/project/references/${id}.md\n` : undefined;
    clock.now = day(5);
    const older = await complete(service, "古い");
    clock.now = day(10);
    const newer = await complete(service, "新しい");
    await audit(service, newer);
    expect(readRef(id)).toContain("有効な最終利用日：2026-10-10");
    await audit(service, older);
    expect(service.get(older)?.task.audit?.survey?.usefulMemories).toEqual([id]);
    expect(readRef(id)).toContain("有効な最終利用日：2026-10-10");
  });

  it("掃除：有効な最終利用日から残す日数を超えたものだけを消し、登録したタスクの作業履歴に記録する（ちょうどは残す）", async () => {
    const { service, activity, clock, audit: out1 } = setup({ retentionDays: 10 });
    out1.register = () => [memory("古い")];
    const a = await complete(service, "A");
    await audit(service, a);
    clock.now = day(3);
    out1.register = () => [memory("新しい")];
    const b = await complete(service, "B");
    await audit(service, b);
    const [older] = service.get(a)?.task.audit?.memories ?? [];
    const [newer] = service.get(b)?.task.audit?.memories ?? [];
    const registeredAt = Date.parse(older?.at ?? "");

    clock.now = registeredAt + 10 * DAY - DAY;
    service.cleanupMemories();
    clock.now = registeredAt + 10 * DAY;
    service.cleanupMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    clock.now = registeredAt + 10 * DAY + 1;
    service.cleanupMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted?.reason).toBe("expired");
    expect(service.get(b)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    expect(activity.forTask(a).at(-1)).toMatchObject({
      actor: "sacty",
      type: "AuditMemoryDeleted",
      payload: { memoryId: older?.id, reason: "expired" },
    });
    expect(existsSync(join(projectDir(), "references", `${older?.id}.md`))).toBe(false);
    expect(existsSync(join(projectDir(), "references", `${newer?.id}.md`))).toBe(true);
    // 消したものは、もう一度は消さない
    const before = activity.forTask(a).length;
    service.cleanupMemories();
    expect(activity.forTask(a).length).toBe(before);
  });

  it("残す日数を設定していなければ 90 日。起動のときにも掃除する", async () => {
    const { service, clock, audit: out1 } = setup();
    out1.register = () => [memory("知見")];
    const a = await complete(service, "A");
    await audit(service, a);
    const at = Date.parse(service.get(a)?.task.audit?.memories[0]?.at ?? "");
    clock.now = at + 90 * DAY;
    service.syncMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    clock.now = at + 90 * DAY + 1;
    service.syncMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted?.reason).toBe("expired");
    expect(existsSync(projectDir())).toBe(false);
  });

  it("書き出す場所が無ければ、開いたメモリーの判断を求めず、掃除もしない", async () => {
    const { service, executor, activity, audit: out1 } = setup({ memory: false });
    out1.useful = () => ["m1"];
    const a = await complete(service, "A");
    await audit(service, a);
    const survey = executor.calls.find(isSurvey);
    expect(prompt(survey as Invocation)).not.toContain("このタスクで開いたメモリー");
    expect(prompt(survey as Invocation)).not.toContain("usefulMemories");
    expect(activity.forTask(a).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      usefulMemories: [],
    });
    expect(() => service.cleanupMemories()).not.toThrow();
  });
});

describe("監査によるメモリーの昇格（PBI-128）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const json = (value: unknown) => out(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  const prompt = (invocation: Invocation) => invocation.command.join(" ");
  const isSurvey = (invocation: Invocation) =>
    prompt(invocation).includes("いまは大まかな監査です");
  const isDive = (invocation: Invocation) => prompt(invocation).includes("深掘りする工程：");
  const isStep = (invocation: Invocation) => !isSurvey(invocation) && !isDive(invocation);
  const onlyRequirements = async () => ({
    steps: ["requirements" as const],
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const memoryRoot = () => join(dir, "memory");
  const projectDir = () => join(memoryRoot(), "projects", "default");
  const repoDir = () => join(memoryRoot(), "repos", "github.com", "acme", "app");

  function setup(
    options: { secretStore?: ServiceDeps["secrets"]; memoryLimit?: number; held?: boolean } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, options.held ? [HOLD] : [], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
      sessionLogs: new SessionLogStore(join(dir, "runs")),
      ...(options.secretStore ? { secretStore: options.secretStore } : {}),
      ...(options.memoryLimit ? { memoryLimit: options.memoryLimit } : {}),
    });
    const audit = {
      register: (): unknown[] => [],
      survey: (): Record<string, unknown> => ({}),
      onSurvey: () => {},
    };
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) {
        audit.onSurvey();
        return json({
          "sacty-audit-survey": {
            summary: "要約",
            concerns: [{ step: "requirements", reason: "差し戻し" }],
            ...audit.survey(),
          },
        });
      }
      if (isDive(invocation)) {
        return json({
          "sacty-audit-findings": { summary: "深掘り", findings: [], memories: audit.register() },
        });
      }
      return out("# 要求要件");
    };
    return { service, executor, activity, audit };
  }
  async function completeAndAudit(service: TaskService, title: string): Promise<string> {
    const task = service.createTask({ projectId: "default", title, body: "" });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    for (let i = 0; i < 3 && service.get(task.id)?.task.audit?.completedAt === undefined; i++) {
      await service.runNext(task.id);
    }
    return task.id;
  }
  const memory = {
    scope: "project",
    title: "lint は biome",
    summary: "lint の道具",
    body: "biome check を使う",
  };

  it("大まかな監査に、タスクの階層のメモリー（有効な最終利用日・役に立った回数）と宛先の候補を渡し、別の階層に移す", async () => {
    const { service, executor, activity, audit } = setup();
    audit.register = () => [memory];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    audit.register = () => [];
    // 2つめのタスクで開いて役に立ち、リポジトリそのものの知見なので、リポジトリの階層に移す
    executor.logLines = (invocation) =>
      isStep(invocation) ? `/sacty-memory/project/references/${id}.md\n` : undefined;
    audit.survey = () => ({ usefulMemories: [id], memoryMoves: [{ id, to: "repository" }] });
    executor.calls.length = 0;
    const b = await completeAndAudit(service, "B");
    const survey = executor.calls.find(isSurvey);
    expect(prompt(survey as Invocation)).toContain(
      `- ${id}（プロジェクト）：lint は biome：lint の道具（有効な最終利用日 `,
    );
    expect(prompt(survey as Invocation)).toContain("役に立った回数 0 回");
    expect(prompt(survey as Invocation)).toContain(
      "- 0：対象リポジトリ（https://github.com/acme/app）",
    );
    expect(prompt(survey as Invocation)).not.toContain("sacty の既定のコンテキスト（");
    expect(activity.forTask(b).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      memoryMoves: [{ id, scope: "repository", repo: "https://github.com/acme/app" }],
    });
    // 移した先にだけ置く。プロジェクトの階層はメモリーが無くなったので消える
    expect(existsSync(projectDir())).toBe(false);
    expect(readFileSync(join(repoDir(), "SKILL.md"), "utf8")).toContain(`references/${id}.md`);
    expect((await new LedgerAuditService(service).taskAudit(b))?.movedMemories).toEqual([
      { id, title: "lint は biome", scope: "repository", repo: "https://github.com/acme/app" },
    ]);

    // 3つめのタスクでは、移した先の階層として渡り、役に立った回数が数えてある。プロジェクトに戻せる
    audit.survey = () => ({ memoryMoves: [{ id, to: "project" }] });
    executor.calls.length = 0;
    const c = await completeAndAudit(service, "C");
    const third = executor.calls.find(isSurvey);
    expect(prompt(third as Invocation)).toContain(`- ${id}（リポジトリ）：lint は biome`);
    expect(prompt(third as Invocation)).toContain("役に立った回数 1 回");
    expect(activity.forTask(c).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      memoryMoves: [{ id, scope: "project", projectId: "default" }],
    });
    expect(existsSync(repoDir())).toBe(false);
    expect(existsSync(join(projectDir(), "references", `${id}.md`))).toBe(true);
  });

  it("記録の時点で、消えたメモリー・すでに移す先にあるメモリーは移さない", async () => {
    const { service, activity, audit } = setup();
    audit.register = () => [memory, { ...memory, title: "二つめ" }];
    const a = await completeAndAudit(service, "A");
    const [first, second] = service.get(a)?.task.audit?.memories ?? [];
    audit.register = () => [];
    // 大まかな監査の実行中に、1つめが人に消される
    audit.onSurvey = () => {
      if (!service.get(a)?.task.audit?.memories[0]?.deleted) {
        service.deleteAuditMemory(first?.id ?? "");
      }
    };
    audit.survey = () => ({
      memoryMoves: [
        { id: first?.id, to: "repository" },
        { id: second?.id, to: "project" },
      ],
    });
    const b = await completeAndAudit(service, "B");
    expect(activity.forTask(b).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      memoryMoves: [],
    });
  });

  it("コンテキストにする提案は、元のメモリーの中身を添えた改修の提案になり、採用すると改修のタスクができる。提案中は重ねない", async () => {
    const { service, activity, audit } = setup();
    audit.register = () => [memory];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    audit.register = () => [];
    audit.survey = () => ({
      memoryPromotions: [
        { id, target: 0, title: "AGENTS.md に lint の手順を書く", body: "AGENTS.md に書く" },
      ],
    });
    const b = await completeAndAudit(service, "B");
    const finding = service.get(b)?.task.audit?.findings.find((f) => f.causeKey === `memory:${id}`);
    // 題は元のメモリーの題だけ（定型の題と説明は、画面の言語で出す。PR #138 レビュー指摘）
    expect(finding?.title).toBe("lint は biome");
    expect(finding?.detail).toBe("");
    const proposal = finding?.proposals[0];
    expect(proposal).toMatchObject({
      title: "AGENTS.md に lint の手順を書く",
      memoryId: id,
      target: { kind: "repository", repo: "https://github.com/acme/app" },
    });
    // 元のメモリーは、提案の本文と別に持つ
    expect(proposal?.body).toBe("AGENTS.md に書く");
    expect(proposal?.memoryOriginal).toEqual({
      title: "lint は biome",
      summary: "lint の道具",
      body: "biome check を使う",
    });
    expect(proposal?.candidates.some((c) => c.kind === "sacty")).toBe(false);
    // 提案中のものは、次の監査でも重ねて提案しない（記録の時点で外す）
    const c = await completeAndAudit(service, "C");
    expect(activity.forTask(c).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      promotions: [],
    });
    // 採用すると改修のタスクができる。マージまではメモリーを残す
    await service.adoptAuditProposal(proposal?.id ?? "", { target: proposal?.target });
    const fixId = service
      .get(b)
      ?.task.audit?.findings.flatMap((f) => f.proposals)
      .find((p) => p.id === proposal?.id)?.decision;
    expect(fixId?.kind).toBe("adopted");
    service.cleanupMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted).toBeUndefined();
  });

  it("改修の PR がマージされたメモリーを消す確認は、PR の確認・掃除・起動のときに行う", async () => {
    const { service } = setup();
    const spy = vi.spyOn(service as never, "retirePromotedMemories");
    await service.checkPullRequests();
    service.cleanupMemories();
    service.syncMemories();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("同時に動いた大まかな監査が先に提案していれば、記録の時点で同じ提案を重ねない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD], {
      audit: true,
      memory: true,
      planner: onlyRequirements,
    });
    let registered: unknown[] = [memory];
    let id = "";
    const promote = () =>
      json({
        "sacty-audit-survey": {
          summary: "要約",
          concerns: [],
          memoryPromotions: [{ id, target: 0, title: "AGENTS.md に書く", body: "本文" }],
        },
      });
    executor.respond = (invocation) => {
      if (isSurvey(invocation)) {
        if (!id) {
          return json({
            "sacty-audit-survey": {
              summary: "要約",
              concerns: [{ step: "requirements", reason: "差し戻し" }],
            },
          });
        }
        // B の大まかな監査は止めておき、その間に C が提案する
        return prompt(invocation).includes("題：B") ? undefined : promote();
      }
      if (isDive(invocation)) {
        return json({
          "sacty-audit-findings": { summary: "深掘り", findings: [], memories: registered },
        });
      }
      return out("# 要求要件");
    };
    const a = await completeAndAudit(service, "A");
    id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    registered = [];
    const b = service.createTask({ projectId: "default", title: "B", body: "" });
    await service.runNext(b.id);
    service.approve(b.id, { step: "requirements", submission: 1 });
    const held = service.runNext(b.id);
    const runId = await executor.started.promise;
    const c = await completeAndAudit(service, "C");
    expect(
      service.get(c)?.task.audit?.findings.filter((f) => f.causeKey === `memory:${id}`),
    ).toHaveLength(1);
    executor.finishHeld(runId, promote());
    await held;
    expect(activity.forTask(b.id).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      promotions: [],
    });
  });

  it("元のメモリーも、今の秘密情報の値で伏せてから提案に添える（PR #138 レビュー指摘）", async () => {
    const values: Record<string, string> = {
      "claude-oauth-token": "oauth-secret",
      "github-token": "ghp_secret",
    };
    const { service, audit } = setup({
      secretStore: { get: async (name: string) => values[name] ?? "" },
    });
    // 登録したときには秘密情報ではなかった値が、後から秘密情報になる
    audit.register = () => [
      { ...memory, title: "題 zz-later", summary: "概要 zz-later", body: "中身 zz-later" },
    ];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    values["claude-oauth-token"] = "zz-later";
    audit.register = () => [];
    audit.survey = () => ({
      memoryPromotions: [{ id, target: 0, title: "書く", body: "本文" }],
    });
    const b = await completeAndAudit(service, "B");
    const finding = service.get(b)?.task.audit?.findings.find((f) => f.causeKey === `memory:${id}`);
    expect(JSON.stringify(finding)).not.toContain("zz-later");
    expect(finding?.title).toBe("題 [REDACTED]");
    expect(finding?.proposals[0]?.memoryOriginal).toEqual({
      title: "題 [REDACTED]",
      summary: "概要 [REDACTED]",
      body: "中身 [REDACTED]",
    });
  });

  it("提案の本文と元のメモリーが上限の長さでも、どちらも欠けずに改修のタスクへ渡す（PR #138 レビュー指摘）", async () => {
    const { service, audit } = setup();
    const longBody = `${"あ".repeat(3990)}末尾の知見`;
    audit.register = () => [{ ...memory, body: longBody }];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    audit.register = () => [];
    const longProposal = `${"い".repeat(3990)}提案の末尾`;
    audit.survey = () => ({
      memoryPromotions: [{ id, target: 0, title: "書く", body: longProposal }],
    });
    const b = await completeAndAudit(service, "B");
    const proposal = service.get(b)?.task.audit?.findings.find((f) => f.causeKey === `memory:${id}`)
      ?.proposals[0];
    expect(proposal?.body).toBe(longProposal);
    expect(proposal?.memoryOriginal?.body).toBe(longBody);
    await service.adoptAuditProposal(proposal?.id ?? "", { target: proposal?.target });
    const decision = service
      .get(b)
      ?.task.audit?.findings.flatMap((f) => f.proposals)
      .find((p) => p.id === proposal?.id)?.decision;
    const fixId = decision?.kind === "adopted" ? (decision.fixTaskId ?? "") : "";
    const fixBody = service.get(fixId)?.task.body ?? "";
    expect(fixBody).toContain("提案の末尾");
    expect(fixBody).toContain("末尾の知見");
  });

  it("移したメモリーを人が消すと、移した先の階層からも消える（両方の向き。PR #138 レビュー指摘）", async () => {
    const { service, audit } = setup();
    audit.register = () => [memory, { ...memory, scope: "repository", title: "リポジトリの知見" }];
    const a = await completeAndAudit(service, "A");
    const [toRepo, toProject] = service.get(a)?.task.audit?.memories ?? [];
    audit.register = () => [];
    audit.survey = () => ({
      memoryMoves: [
        { id: toRepo?.id, to: "repository" },
        { id: toProject?.id, to: "project" },
      ],
    });
    await completeAndAudit(service, "B");
    expect(existsSync(join(repoDir(), "references", `${toRepo?.id}.md`))).toBe(true);
    expect(existsSync(join(projectDir(), "references", `${toProject?.id}.md`))).toBe(true);
    service.deleteAuditMemory(toRepo?.id ?? "");
    expect(existsSync(join(repoDir(), "references", `${toRepo?.id}.md`))).toBe(false);
    service.deleteAuditMemory(toProject?.id ?? "");
    expect(existsSync(projectDir())).toBe(false);
    expect(existsSync(repoDir())).toBe(false);
  });

  it("移した先が件数の上限を超えたら、登録のときと同じく古いものから消す（PR #138 レビュー指摘）", async () => {
    const { service, activity, audit } = setup({ memoryLimit: 1 });
    audit.register = () => [{ ...memory, scope: "repository", title: "リポジトリの知見" }];
    const a = await completeAndAudit(service, "A");
    audit.register = () => [{ ...memory, title: "プロジェクトの知見" }];
    const b = await completeAndAudit(service, "B");
    const older = service.get(a)?.task.audit?.memories[0];
    const moving = service.get(b)?.task.audit?.memories[0];
    audit.register = () => [];
    audit.survey = () => ({ memoryMoves: [{ id: moving?.id, to: "repository" }] });
    await completeAndAudit(service, "C");
    expect(service.get(a)?.task.audit?.memories[0]?.deleted?.reason).toBe("capacity");
    expect(activity.forTask(a).at(-1)).toMatchObject({
      type: "AuditMemoryDeleted",
      payload: { memoryId: older?.id, reason: "capacity" },
    });
    expect(readdirSync(join(repoDir(), "references"))).toEqual([`${moving?.id}.md`]);
  });

  it("監査の後に中止したタスクのメモリーも、起動のときに上限を超えれば消し、人も消せる（PBI-335）", async () => {
    const { service, activity, audit } = setup();
    audit.register = () => [{ ...memory, title: "古い知見" }];
    const a = await completeAndAudit(service, "A");
    audit.register = () => [{ ...memory, title: "新しい知見" }];
    const b = await completeAndAudit(service, "B");
    audit.register = () => [{ ...memory, title: "人が消す知見" }];
    const c = await completeAndAudit(service, "C");
    const older = service.get(a)?.task.audit?.memories[0];
    const newer = service.get(b)?.task.audit?.memories[0];
    const byPerson = service.get(c)?.task.audit?.memories[0];
    // 監査の後に、レビューのやり直しなどで中止になった
    for (const id of [a, c]) {
      activity.append({
        taskId: id,
        projectId: "default",
        events: [{ actor: "person", event: { type: "TaskCancelled", payload: { cleanup: [] } } }],
      });
    }

    const restarted = makeService(new SqliteActivityStore(dbPath), [], {
      audit: true,
      memory: true,
      memoryLimit: 2,
    }).service;
    expect(restarted.get(a)?.task.status).toBe("cancelled");
    expect(() => restarted.syncMemories()).not.toThrow();
    expect(restarted.get(a)?.task.audit?.memories[0]?.deleted?.reason).toBe("capacity");
    expect(restarted.get(a)?.task.status).toBe("cancelled");
    expect(readdirSync(join(projectDir(), "references")).sort()).toEqual(
      [`${newer?.id}.md`, `${byPerson?.id}.md`].sort(),
    );
    restarted.deleteAuditMemory(byPerson?.id ?? "");
    expect(restarted.get(c)?.task.audit?.memories[0]?.deleted?.reason).toBe("person");
    expect(readdirSync(join(projectDir(), "references"))).toEqual([`${newer?.id}.md`]);
    expect(activity.forTask(a).at(-1)).toMatchObject({
      type: "AuditMemoryDeleted",
      payload: { memoryId: older?.id, reason: "capacity" },
    });
  });

  it("別の監査が先に移していれば、記録の時点で移さない（PR #138 レビュー指摘）", async () => {
    const { service, activity, executor, audit } = setup({ held: true });
    audit.register = () => [memory];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    audit.register = () => [];
    const move = () =>
      json({
        "sacty-audit-survey": {
          summary: "要約",
          concerns: [],
          memoryMoves: [{ id, to: "repository" }],
        },
      });
    const previous = executor.respond;
    executor.respond = (invocation) =>
      isSurvey(invocation)
        ? prompt(invocation).includes("題：B")
          ? undefined
          : move()
        : previous?.(invocation);
    const b = service.createTask({ projectId: "default", title: "B", body: "" });
    await service.runNext(b.id);
    service.approve(b.id, { step: "requirements", submission: 1 });
    const held = service.runNext(b.id);
    const runId = await executor.started.promise;
    const c = await completeAndAudit(service, "C");
    expect(activity.forTask(c).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      memoryMoves: [{ id, scope: "repository" }],
    });
    executor.finishHeld(runId, move());
    await held;
    expect(activity.forTask(b.id).find((e) => e.type === "AuditSurveyed")?.payload).toMatchObject({
      memoryMoves: [],
    });
  });

  it("改修の PR がマージされたら、元のメモリーを promoted で消し、索引と中身から消す（PR #138 レビュー指摘）", async () => {
    const { service, activity, audit } = setup();
    audit.register = () => [memory];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    audit.register = () => [];
    audit.survey = () => ({
      memoryPromotions: [{ id, target: 0, title: "書く", body: "本文" }],
    });
    const b = await completeAndAudit(service, "B");
    const proposal = service.get(b)?.task.audit?.findings.find((f) => f.causeKey === `memory:${id}`)
      ?.proposals[0];
    await service.adoptAuditProposal(proposal?.id ?? "", { target: proposal?.target });
    const decision = service
      .get(b)
      ?.task.audit?.findings.flatMap((f) => f.proposals)
      .find((p) => p.id === proposal?.id)?.decision;
    const fixId = decision?.kind === "adopted" ? (decision.fixTaskId ?? "") : "";
    // マージの前は残す
    service.cleanupMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    // 改修のタスクの PR がマージされた状態にする（マージの流れは PR の見守りのテストで確かめている）
    const tasks = (service as unknown as { tasks: Map<string, Task> }).tasks;
    const fix = tasks.get(fixId) as Task;
    tasks.set(fixId, { ...fix, pullRequestMerge: { at: "2026-10-18T00:00:00.000Z" } as never });
    service.cleanupMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted?.reason).toBe("promoted");
    expect(activity.forTask(a).at(-1)).toMatchObject({
      actor: "sacty",
      type: "AuditMemoryDeleted",
      payload: { memoryId: id, reason: "promoted" },
    });
    expect(existsSync(projectDir())).toBe(false);
  });

  it("却下した提案は、理由を次の大まかな監査に渡し、メモリーは残す", async () => {
    const { service, executor, audit } = setup();
    audit.register = () => [memory];
    const a = await completeAndAudit(service, "A");
    const id = service.get(a)?.task.audit?.memories[0]?.id ?? "";
    audit.register = () => [];
    audit.survey = () => ({
      memoryPromotions: [{ id, target: 0, title: "書く", body: "本文" }],
    });
    const b = await completeAndAudit(service, "B");
    const proposalId =
      service.get(b)?.task.audit?.findings.find((f) => f.causeKey === `memory:${id}`)?.proposals[0]
        ?.id ?? "";
    await service.rejectAuditProposal(proposalId, { reason: "まだ早い" });
    service.cleanupMemories();
    expect(service.get(a)?.task.audit?.memories[0]?.deleted).toBeUndefined();
    audit.survey = () => ({});
    executor.calls.length = 0;
    await completeAndAudit(service, "C");
    const survey = executor.calls.find(isSurvey);
    expect(prompt(survey as Invocation)).toContain("コンテキストにする提案は却下：まだ早い");
    // 深掘りの「既存の原因」には、コンテキストにする提案を入れない
    const dive = executor.calls.find(isDive);
    expect(prompt(dive as Invocation)).not.toContain(`memory:${id}`);
  });
});
