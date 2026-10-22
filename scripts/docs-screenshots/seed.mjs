// ユーザードキュメントのスクリーンショット用に、架空のプロジェクトとタスクを SACTY_HOME に入れる。
// 実際の AI・GitHub・Docker は使わない。作業履歴に、タスクの状態を作るイベントを直接書く。
//   node scripts/docs-screenshots/seed.mjs <SACTY_HOME> <ja|en>
// デーモンのビルド（npm run build）が要る。
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteActivityStore } from "../../apps/daemon/dist/activity.js";
import { SqliteProjectStore } from "../../apps/daemon/dist/projects.js";
import { project } from "../../packages/core/dist/index.js";

const [home, lang = "ja"] = process.argv.slice(2);
if (!home) {
  console.error("usage: seed.mjs <SACTY_HOME> <ja|en>");
  process.exit(2);
}
const L = (ja, en) => (lang === "en" ? en : ja);
mkdirSync(home, { recursive: true });

const HOUR = 3_600_000;
const NOW = Date.now();
let clock = NOW;
const db = join(home, "sacty.db");
const activity = new SqliteActivityStore(db, () => new Date(clock));
const projects = new SqliteProjectStore(db, () => new Date(NOW - 30 * 24 * HOUR));

// ---- コンテキストリポジトリ（ホームのディレクトリの下のローカルのディレクトリ。画面には ~/sacty-context と出る） ----
const contextDir = join(homedir(), "sacty-context");
const write = (path, text) => {
  mkdirSync(join(contextDir, path, ".."), { recursive: true });
  writeFileSync(join(contextDir, path), text);
};
write(
  "rules.md",
  L(
    "# acme の規則\n\n- 変更には必ずテストを足す。\n",
    "# acme rules\n\n- Always add tests for changes.\n",
  ),
);
write(
  "skills/payment-api/SKILL.md",
  "---\nname: payment-api\ndescription: Conventions for the acme payment API\n---\n\n# payment-api\n",
);
write(
  "mcp.yaml",
  'servers:\n  docs:\n    url: https://mcp.example.com/mcp\n    headers:\n      Authorization: { secret: docs-token, prefix: "Bearer " }\n',
);
write(
  "platforms.yaml",
  `platforms:\n  ticket:\n    upstream: https://ticket.internal.example.com\n    description: ${L("チケット管理", "Ticket tracker")}\n    auth:\n      header: Authorization\n      prefix: "Bearer "\n      secret: ticket-token\n    allow:\n      - GET /api/v1/tickets/**\n      - POST /api/v1/tickets/*/comments\n`,
);

// ---- プロジェクト ----
const PAY = "payments";
const PORTAL = "portal";
projects.put(PAY, {
  name: L("決済基盤", "Payments"),
  targets: [
    { scope: "repo", target: "https://github.com/acme/payments-api" },
    { scope: "repo", target: "https://github.com/acme/billing-web" },
  ],
  context: { repo: "~/sacty-context" },
  githubAccounts: { "github.com": "acme-dev" },
});
projects.put(PORTAL, {
  name: L("社内ポータル", "Internal portal"),
  targets: [{ scope: "repo", target: "https://github.com/acme/portal" }],
  githubAccounts: { "github.com": "acme-dev" },
});

// ---- イベントを書く道具 ----
let runSeq = 0;
const usage = (input, output) => ({
  input,
  cacheRead: Math.round(input * 0.6),
  cacheWrite: 0,
  output,
});
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
      const agent = { agentId: "codex_standard", authMode: "api-key" };
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
    review(hoursAgo, viewpoints) {
      add(hoursAgo, "guardian", "FinalReviewed", {
        passed: true,
        viewpoints: viewpoints.map((viewpointId) => ({
          viewpointId,
          verified: true,
          reason: L("テストが観点を確かめている", "The test checks the viewpoint"),
        })),
        remarks: [],
        summary: L("すべての観点を満たしている。", "All viewpoints are satisfied."),
        tests: { command: "npm test", exitCode: 0, output: "Tests  42 passed (42)" },
        agentId: "codex_standard",
        authMode: "api-key",
        model: "gpt-6.1-sol",
        usage: usage(60000, 2500),
        costUsd: 0.18,
      });
    },
    pr(hoursAgo, repo, number) {
      add(hoursAgo, "sacty", "PullRequestPublished", {
        branch: `sacty/task-${id.slice(0, 8)}`,
        commit: "9e1d0c4b2a7f",
        url: `${repo}/pull/${number}`,
        number,
        repo,
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

const investigation = L(
  "## 調査の結果\n\n- 決済 API のタイムアウトは `src/client.ts` で 10 秒に固定されている。\n- 設定ファイルから読む仕組みは既にあり、そこに項目を足せばよい。\n",
  "## Findings\n\n- The payment API timeout is fixed at 10 seconds in `src/client.ts`.\n- A mechanism to read settings already exists; adding an item there is enough.\n",
);
const implementation = L(
  "## 実装\n\n- 設定 `payment.timeout_sec`（既定 10）を足し、クライアントに渡した。\n- 観点 REQ のテストを `src/client.test.ts` に足した。\n",
  "## Implementation\n\n- Added the `payment.timeout_sec` setting (default 10) and passed it to the client.\n- Added tests for viewpoint REQ in `src/client.test.ts`.\n",
);
const PAY_REPO = "https://github.com/acme/payments-api";
const WEB_REPO = "https://github.com/acme/billing-web";
const PORTAL_REPO = "https://github.com/acme/portal";
const selfReview = { rounds: 2, passed: true, remaining: [], notReviewed: [], summary: "" };

// 1. 実装の承認待ち（PR が開いている）
{
  const t = task("a1c3e5f7-0001", PAY);
  t.create(
    5,
    L("決済 API のタイムアウトを設定できるようにする", "Make the payment API timeout configurable"),
    L(
      "決済 API のタイムアウトを設定ファイルで変えられるようにしたい。",
      "We want to change the payment API timeout in the settings file.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(4.9, PAY_REPO);
  t.plan(
    4.8,
    "direct",
    ["investigate", "implement", "deployment"],
    L(
      "既存の設定の仕組みに沿った局所的な変更のため",
      "A local change that follows the existing settings mechanism",
    ),
    {
      testCommand: "npm test",
      deployment: { skill: ".agents/skills/deployment-observer/SKILL.md" },
    },
  );
  t.run(4.6, "investigate", investigation, 0.21);
  t.complete(4.2, "investigate");
  t.run(4.1, "implement", implementation, 0.64, {
    testMap: [{ viewpointId: "REQ", tests: ["src/client.test.ts › timeout from settings"] }],
    selfReview,
  });
  t.review(3.2, ["REQ"]);
  t.pr(3.0, PAY_REPO, 128);
  t.submit(3.0, "implement");
}

// 2. 利用上限で一時停止
{
  const t = task("b2d4f6a8-0002", PAY);
  t.create(
    26,
    L("注文履歴の CSV エクスポートを追加する", "Add CSV export to the order history"),
    L(
      "管理画面の注文履歴を CSV でダウンロードできるようにしたい。",
      "Let admins download the order history as CSV.",
    ),
    { repo: WEB_REPO },
  );
  t.repo(25.9, WEB_REPO);
  t.plan(
    25.8,
    "standard",
    ["investigate", "requirements", "design", "implement", "deployment"],
    L("出力の形式と権限の設計が要るため", "The output format and permissions need design"),
    {
      testCommand: "npm test",
      deployment: { skill: ".agents/skills/deployment-observer/SKILL.md" },
    },
  );
  t.run(25.5, "investigate", investigation, 0.25);
  t.complete(25.1, "investigate");
  t.run(
    25.0,
    "requirements",
    L(
      "## 要求要件\n\n- R-1 管理者が注文履歴を表示しているとき、システムは CSV のダウンロードを提供しなければならない。\n",
      "## Requirements\n\n- R-1 While an admin views the order history, the system shall offer a CSV download.\n",
    ),
    0.33,
    { selfReview },
  );
  t.submit(24.6, "requirements");
  t.approve(20, "requirements", "queued");
  t.fail(
    1.5,
    "design",
    "usage_limit",
    L(
      "AI の利用上限に達しました（15:45 に戻ります）",
      "Reached the AI usage limit (resets at 3:45 PM)",
    ),
  );
}

// 3. 要求要件の承認待ち（画面で承認する）
{
  const t = task("c3e5a7b9-0003", PORTAL);
  t.create(
    8,
    L("ポータルの検索を全文検索にする", "Switch the portal search to full-text search"),
    L(
      "お知らせとドキュメントを本文でも検索できるようにしたい。",
      "Make announcements and documents searchable by their body text.",
    ),
    { repo: PORTAL_REPO },
  );
  t.repo(7.9, PORTAL_REPO);
  t.plan(
    7.8,
    "standard",
    ["investigate", "requirements", "design", "implement", "deployment"],
    L(
      "検索の仕組みを入れ替える広い変更のため",
      "A broad change that replaces the search mechanism",
    ),
    {
      testCommand: "npm test",
      deployment: {
        skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
      },
    },
  );
  t.run(7.6, "investigate", investigation, 0.27);
  t.complete(7.2, "investigate");
  t.run(
    7.1,
    "requirements",
    L(
      "## 要求要件\n\n- R-1 利用者が検索語を入力したとき、システムは題と本文の両方から一致するものを返さなければならない。\n",
      "## Requirements\n\n- R-1 When a user enters a query, the system shall return matches from both titles and bodies.\n",
    ),
    0.31,
    { selfReview },
  );
  t.submit(6.5, "requirements");
}

// 4. マージの後の監視中
{
  const t = task("d4f6b8c0-0004", PAY);
  t.create(
    30,
    L("請求書 PDF の文字化けを直す", "Fix garbled characters in invoice PDFs"),
    L("請求書 PDF で一部の漢字が文字化けする。", "Some characters are garbled in invoice PDFs."),
    { repo: WEB_REPO },
  );
  t.repo(29.9, WEB_REPO);
  t.plan(
    29.8,
    "direct",
    ["investigate", "implement", "deployment"],
    L("原因がフォントの指定だと明らかなため", "The cause is clearly the font setting"),
    {
      testCommand: "npm test",
      deployment: { skill: ".agents/skills/deployment-observer/SKILL.md" },
    },
  );
  t.run(29.6, "investigate", investigation, 0.18);
  t.complete(29.2, "investigate");
  t.run(29.1, "implement", implementation, 0.52, {
    testMap: [{ viewpointId: "REQ", tests: ["src/pdf.test.ts › embeds the font"] }],
    selfReview,
  });
  t.review(28.4, ["REQ"]);
  t.pr(28.2, WEB_REPO, 87);
  t.submit(28.2, "implement");
  t.merged(0.4, 87);
  t.approve(0.4, "implement", "idle");
  t.add(0.4, "sacty", "DeploymentWatchStarted", {
    number: 87,
    repo: WEB_REPO,
    branch: "main",
    commit: "b81f3e5d6c20",
  });
}

// 5. 完了（マージの後の監視は飛ばした）
{
  const t = task("e5a7c9d1-0005", PORTAL);
  t.create(
    52,
    L("README にセットアップ手順を足す", "Add setup steps to the README"),
    L(
      "新しく入った人が README だけで動かせるようにしたい。",
      "Newcomers should be able to run it from the README alone.",
    ),
    { repo: PORTAL_REPO },
  );
  t.repo(51.9, PORTAL_REPO);
  t.plan(
    51.8,
    "direct",
    ["investigate", "implement", "deployment"],
    L("文書の局所的な変更のため", "A local documentation change"),
    {
      testCommand: "npm test",
      deployment: {
        skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
      },
    },
  );
  t.run(51.6, "investigate", investigation, 0.12);
  t.complete(51.3, "investigate");
  t.run(51.2, "implement", implementation, 0.29, {
    testMap: [{ viewpointId: "REQ", tests: ["docs check"] }],
    selfReview,
  });
  t.review(50.8, ["REQ"]);
  t.pr(50.7, PORTAL_REPO, 41);
  t.submit(50.7, "implement");
  t.merged(47, 41);
  t.approve(47, "implement", "idle");
}

// 6. 完了（調査だけ）
{
  const t = task("f6b8d0e2-0006", PAY);
  t.create(
    28,
    L("在庫同期ジョブが遅い原因を調べる", "Investigate why the inventory sync job is slow"),
    L(
      "夜間の在庫同期が 2 時間かかる原因を知りたい。",
      "Find out why the nightly inventory sync takes two hours.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(27.9, PAY_REPO);
  t.plan(
    27.8,
    "investigate",
    ["investigate"],
    L("原因の調査が目的のため", "The goal is to find the cause"),
    { investigation: "content" },
  );
  t.run(
    27.5,
    "investigate",
    L(
      "## 調査の結果\n\n- 1 件ずつ API を呼んでいるのが原因。まとめて呼べば 10 分ほどになる見込み。\n",
      "## Findings\n\n- It calls the API one item at a time; batching should bring it to about 10 minutes.\n",
    ),
    0.41,
  );
  t.submit(27.1, "investigate");
  t.approve(22, "investigate", "idle");
}

// 7. 認証のエラーで一時停止
{
  const t = task("a7c9e1f3-0007", PAY);
  t.create(
    3,
    L("Webhook の署名を検証する", "Verify webhook signatures"),
    L(
      "決済の Webhook の署名を検証してから処理したい。",
      "Verify the signature of payment webhooks before processing them.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(2.9, PAY_REPO);
  t.plan(
    2.8,
    "skip-design",
    ["investigate", "requirements", "implement", "deployment"],
    L(
      "受け入れ条件の整理が要る局所的な変更のため",
      "A local change whose acceptance criteria need sorting out",
    ),
    {
      testCommand: "npm test",
      deployment: { skill: ".agents/skills/deployment-observer/SKILL.md" },
    },
  );
  t.fail(
    2.6,
    "investigate",
    "auth",
    L(
      "API Error: 401 Invalid authentication credentials",
      "API Error: 401 Invalid authentication credentials",
    ),
  );
}

// 作業履歴が投影できることを確かめる（デーモンの起動と同じ読み方）
const tasks = project(activity.all());
console.log(`seeded ${tasks.size} tasks into ${db}`);
for (const t of tasks.values()) console.log(`  ${t.status.padEnd(18)} ${t.title}`);
activity.close();
projects.close();
