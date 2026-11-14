// スクリーンショット用の架空のデータを書く道具（seed.mjs・seed-intro.mjs が使う）。
// 実際の AI・GitHub・Docker は使わない。作業履歴に、タスクの状態を作るイベントを直接書く。
// デーモンのビルド（npm run build）が要る。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteActivityStore } from "../../apps/daemon/dist/activity.js";
import { SqliteProjectStore } from "../../apps/daemon/dist/projects.js";
import { project } from "../../packages/core/dist/index.js";

const HOUR = 3_600_000;

/**
 * SACTY_HOME を開き、データを書く道具を返す。
 * @param {string} name 使い方の表示に出すスクリプトの名前
 * @param {string[]} [argv] `<SACTY_HOME> <ja|en>`
 */
export function openSeed(name, argv = process.argv.slice(2)) {
  const [home, lang = "ja"] = argv;
  if (!home) {
    console.error(`usage: ${name} <SACTY_HOME> <ja|en>`);
    process.exit(2);
  }
  const L = (ja, en) => (lang === "en" ? en : ja);
  mkdirSync(home, { recursive: true });

  const NOW = Date.now();
  let clock = NOW;
  const db = join(home, "sacty.db");
  const activity = new SqliteActivityStore(db, () => new Date(clock));
  const projects = new SqliteProjectStore(db, () => new Date(NOW - 30 * 24 * HOUR));

  let runSeq = 0;
  const usage = (input, output) => ({
    input,
    cacheRead: Math.round(input * 0.6),
    cacheWrite: 0,
    output,
  });

  /** タスクのイベントを書く道具。hoursAgo は、今から何時間前の出来事か。 */
  function task(id, projectId) {
    const add = (hoursAgo, actor, type, payload) => {
      clock = NOW - hoursAgo * HOUR;
      activity.append({ taskId: id, projectId, events: [{ actor, event: { type, payload } }] });
    };
    return {
      add,
      create(hoursAgo, title, body, extra = {}) {
        add(hoursAgo, "person", "TaskCreated", {
          title,
          body,
          start: "sacty",
          budgetCapUsd: 5,
          ...extra,
        });
      },
      repo(hoursAgo, url) {
        add(hoursAgo, "sacty", "RepositoryPrepared", {
          url,
          baseBranch: "main",
          baseCommit: "4f2c9a1e7b3d",
        });
      },
      plan(hoursAgo, plan, steps, reason, extra = {}) {
        add(hoursAgo, "orchestrator", "StepsChosen", {
          steps,
          plan,
          reason,
          agentId: "codex_lite",
          authMode: "api-key",
          model: "gpt-6-luna",
          usage: usage(18000, 900),
          costUsd: 0.03,
          ...extra,
        });
      },
      run(hoursAgo, step, output, cost, extra = {}) {
        const runId = `run-${id}-${++runSeq}`;
        const agent = { agentId: "codex_standard", authMode: extra.authMode ?? "api-key" };
        add(hoursAgo, "sacty", "AgentRunStarted", {
          runId,
          step,
          ...agent,
          model: "gpt-6.1-sol",
          reasoningEffort: "low",
        });
        add(hoursAgo - 0.3, "agent", "AgentRunCompleted", {
          runId,
          step,
          ...agent,
          usage: usage(Math.round(cost * 400000), Math.round(cost * 20000)),
          costUsd: cost,
          estimated: false,
          output,
          ...extra,
        });
      },
      fail(hoursAgo, step, reason, message) {
        const runId = `run-${id}-${++runSeq}`;
        add(hoursAgo, "sacty", "AgentRunStarted", {
          runId,
          step,
          agentId: "codex_standard",
          authMode: "api-key",
          model: "gpt-6.1-sol",
        });
        add(hoursAgo - 0.1, "sacty", "AgentRunFailed", {
          runId,
          step,
          agentId: "codex_standard",
          reason,
          message,
        });
        add(hoursAgo - 0.1, "sacty", "TaskPaused", { reason, message });
      },
      complete(hoursAgo, step) {
        add(hoursAgo, "sacty", "StepCompleted", { step, next: "queued" });
      },
      submit(hoursAgo, step, submission = 1) {
        add(hoursAgo, "sacty", "StepSubmitted", { step, submission });
      },
      approve(hoursAgo, step, next) {
        add(hoursAgo, "person", "StepApproved", { step, next });
      },
      review(hoursAgo, viewpoints, tests = {}) {
        add(hoursAgo, "guardian", "FinalReviewed", {
          passed: true,
          viewpoints: viewpoints.map((viewpointId) => ({
            viewpointId,
            verified: true,
            reason: L("テストが観点を確かめている", "The test checks the viewpoint"),
          })),
          remarks: [],
          summary: L("すべての観点を満たしている。", "All viewpoints are satisfied."),
          tests: { command: "npm test", exitCode: 0, output: "Tests  42 passed (42)", ...tests },
          agentId: "codex_standard",
          authMode: "api-key",
          model: "gpt-6.1-sol",
          usage: usage(60000, 2500),
          costUsd: 0.18,
        });
      },
      pr(hoursAgo, repo, number, extra = {}) {
        add(hoursAgo, "sacty", "PullRequestPublished", {
          branch: `sacty/task-${id.slice(0, 8)}`,
          commit: "9e1d0c4b2a7f",
          url: `${repo}/pull/${number}`,
          number,
          repo,
          ...extra,
        });
      },
      merged(hoursAgo, number) {
        add(hoursAgo, "sacty", "PullRequestMerged", {
          number,
          by: "acme-lead",
          commit: "9e1d0c4b2a7f",
          mergeCommit: "b81f3e5d6c20",
        });
      },
    };
  }

  /** 作業履歴が投影できることを確かめ（デーモンの起動と同じ読み方）、タスクの一覧を出して閉じる。 */
  function finish() {
    const tasks = project(activity.all());
    console.log(`seeded ${tasks.size} tasks into ${db}`);
    for (const t of tasks.values()) console.log(`  ${t.status.padEnd(18)} ${t.title}`);
    activity.close();
    projects.close();
  }

  return { L, projects, task, usage, finish };
}
