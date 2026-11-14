// 紹介のページ（docs/user/introduction.md）のスクリーンショット用に、架空のプロジェクトとタスクを SACTY_HOME に入れる。
// はじめて見る人に、ふだんの使い方が伝わる状態だけを作る（あなたの出番・マージの後の監視・完了と、監査の結果）。
// エラーや上限で止まったタスクは、設定やトラブルの説明のためのデータ（seed.mjs）にあり、ここには入れない。
//   node scripts/docs-screenshots/seed-intro.mjs <SACTY_HOME> <ja|en>
// 実際の AI・GitHub・Docker は使わない（道具は seed-lib.mjs）。デーモンのビルド（npm run build）が要る。
//
// デーモンは起動すると、承認待ちの PR にレビューの子タスクが無ければ作って実行する。撮る間に実行させない（失敗して
// 「エラーで一時停止」が写らない）ように、承認待ちの PR には、レビューを終えた子タスクを入れておく。
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSeed } from "./seed-lib.mjs";

const { L, projects, task, usage, finish } = openSeed("seed-intro.mjs");

// ---- コンテキストリポジトリ（改修の提案の宛先に出る。画面には ~/sacty-context と出る） ----
const CONTEXT = "~/sacty-context";
const contextDir = join(homedir(), "sacty-context");
mkdirSync(contextDir, { recursive: true });
writeFileSync(
  join(contextDir, "rules.md"),
  L(
    "# acme の規則\n\n- 変更には必ずテストを足す。\n",
    "# acme rules\n\n- Always add tests for changes.\n",
  ),
);

// ---- プロジェクト ----
const PAY = "payments";
const PAY_REPO = "https://github.com/acme/payments-api";
const WEB_REPO = "https://github.com/acme/billing-web";
projects.put(PAY, {
  name: L("決済基盤", "Payments"),
  targets: [
    { scope: "repo", target: PAY_REPO },
    { scope: "repo", target: WEB_REPO },
  ],
  context: { repo: CONTEXT },
  githubAccounts: { "github.com": "acme-dev" },
});

// ---- よく使う中身 ----
const BASE = "4f2c9a1e7b3d";
const selfReview = { rounds: 2, passed: true, remaining: [], notReviewed: [], summary: "" };
const watch = { deployment: { skill: ".agents/skills/deployment-observer/SKILL.md" } };
const noWatch = {
  deployment: {
    skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
  },
};
const ai = { agentId: "codex_standard", authMode: "api-key", model: "gpt-6.1-sol" };
const implementation = L(
  "## 実装\n\n- 設定 `payment.timeout_sec`（既定 10）を足し、クライアントに渡した。\n- テストを `src/client.test.ts` に足した。\n",
  "## Implementation\n\n- Added the `payment.timeout_sec` setting (default 10) and passed it to the client.\n- Added tests in `src/client.test.ts`.\n",
);

/** タスクの開始時の情報収集（集めた情報のまとめ）。 */
function gather(t, hoursAgo, brief) {
  t.add(hoursAgo, "gatherer", "InformationGathered", {
    brief,
    sources: [],
    agentId: "codex_lite",
    authMode: "api-key",
    model: "gpt-6-luna",
    usage: usage(30000, 1200),
    costUsd: 0.05,
  });
}

/**
 * PR のレビューの子タスク（指摘なしでレビューを投稿して完了したもの）を入れ、親に記録する。
 * commit は、親が PR に積んだコミット（同じコミットなので、デーモンは再レビューを始めない）。
 */
function reviewed(parent, parentId, hoursAgo, { id, step, repo, number, title, commit }) {
  const url = `${repo}/pull/${number}`;
  const r = task(id, PAY);
  r.add(hoursAgo, "sacty", "TaskCreated", {
    title: `[PR #${number}] ${title}`,
    body: "",
    start: "github_pull_request",
    budgetCapUsd: 5,
    source: { kind: "github_pull_request", repo, number, url, review: "sacty" },
    reviewOf: { taskId: parentId, step },
  });
  parent.add(hoursAgo, "sacty", "ReviewTaskCreated", { taskId: id, step, repo, number });
  r.add(hoursAgo - 0.02, "sacty", "StepsChosen", { steps: ["review"] });
  r.add(hoursAgo - 0.04, "sacty", "ReviewTargetResolved", {
    repo,
    number,
    url,
    title,
    headCommit: commit,
    baseCommit: BASE,
    author: "acme-dev",
  });
  r.run(
    hoursAgo - 0.06,
    "review",
    L(
      "## 総評\n\n指摘はありません。受け入れ条件を満たし、テストも通っています。\n",
      "## Summary\n\nNo findings. The acceptance criteria are met and the tests pass.\n",
    ),
    0.24,
    { reviewVerdict: "no_findings" },
  );
  r.add(hoursAgo - 0.5, "sacty", "PullRequestReviewPosted", {
    url: `${url}#pullrequestreview-1`,
  });
}

// 1. 実装の PR のマージ待ち（AI のレビューが指摘なしにして、ドラフトを外した）
{
  const id = "a1c3e5f7-1001";
  const title = L(
    "決済 API のタイムアウトを設定できるようにする",
    "Make the payment API timeout configurable",
  );
  const t = task(id, PAY);
  t.create(
    3.2,
    title,
    L(
      "決済 API のタイムアウトを設定ファイルで変えられるようにしたい。",
      "We want to change the payment API timeout in the settings file.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(3.15, PAY_REPO);
  gather(
    t,
    3.1,
    L(
      "## 目的と背景\n\n決済 API のタイムアウトは `src/client.ts` で 10 秒に固定されている。設定ファイルから読む仕組みは既にある。\n",
      "## Goal and background\n\nThe payment API timeout is fixed at 10 seconds in `src/client.ts`. A mechanism to read settings already exists.\n",
    ),
  );
  t.plan(
    3.0,
    "direct",
    ["implement", "deployment"],
    L(
      "既存の設定の仕組みに沿った局所的な変更のため",
      "A local change that follows the existing settings mechanism",
    ),
    { testCommand: "npm test", ...watch },
  );
  t.run(2.9, "implement", implementation, 0.64, {
    testMap: [{ viewpointId: "REQ", tests: ["src/client.test.ts › timeout from settings"] }],
    selfReview,
  });
  t.add(2.5, "sacty", "FinalReviewSkipped", {});
  t.pr(2.45, PAY_REPO, 128, { awaitingReview: true, draft: true });
  t.submit(2.45, "implement");
  reviewed(t, id, 2.4, {
    id: "a1c3e5f7-1101",
    step: "implement",
    repo: PAY_REPO,
    number: 128,
    title,
    commit: "9e1d0c4b2a7f",
  });
  t.add(1.8, "sacty", "PullRequestMarkedReady", {
    number: 128,
    commit: "9e1d0c4b2a7f",
    reviewTaskId: "a1c3e5f7-1101",
  });
}

// 2. 設計の PR のマージ待ち（要求要件は PR のマージで承認済み）
{
  const id = "b2d4f6a8-1002";
  const title = L("注文履歴の CSV エクスポートを追加する", "Add CSV export to the order history");
  const branch = "sacty/task-b2d4f6a8";
  const t = task(id, PAY);
  t.create(
    26,
    title,
    L(
      "管理画面の注文履歴を CSV でダウンロードできるようにしたい。",
      "Let admins download the order history as CSV.",
    ),
    { repo: WEB_REPO },
  );
  t.repo(25.95, WEB_REPO);
  gather(
    t,
    25.9,
    L(
      "## 目的と背景\n\n経理が、月末に注文履歴を表計算ソフトで集計している。いまは画面から写している。\n",
      "## Goal and background\n\nAccounting totals the order history in a spreadsheet at month end, copying it from the screen today.\n",
    ),
  );
  t.plan(
    25.8,
    "standard",
    ["requirements", "design", "implement", "deployment"],
    L("出力の形式と権限の設計が要るため", "The output format and permissions need design"),
    { testCommand: "npm test", documentsDir: "docs/sacty", ...watch },
  );
  t.add(25.75, "sacty", "TaskBranchCreated", { branch, commit: BASE });
  t.run(
    25.7,
    "requirements",
    L(
      "## 要求要件\n\n- R-1 管理者が注文履歴を表示しているとき、システムは CSV のダウンロードを提供しなければならない。\n",
      "## Requirements\n\n- R-1 While an admin views the order history, the system shall offer a CSV download.\n",
    ),
    0.33,
    { selfReview },
  );
  t.add(25.3, "sacty", "StepPullRequestPublished", {
    step: "requirements",
    branch: `${branch}-requirements-1`,
    commit: "1a2b3c4d5e6f",
    base: BASE,
    path: "docs/sacty/b2d4f6a8/requirements.md",
    url: `${WEB_REPO}/pull/44`,
    number: 44,
    repo: WEB_REPO,
  });
  t.submit(25.3, "requirements");
  t.add(20, "sacty", "PullRequestMerged", {
    number: 44,
    by: "acme-lead",
    commit: "1a2b3c4d5e6f",
    mergeCommit: "5d6e7f8091a2",
  });
  t.approve(20, "requirements", "queued");
  t.run(
    19.9,
    "design",
    L(
      "## 設計\n\n- 一覧と同じ絞り込みの条件で、サーバーが CSV を作って返す。\n- テスト観点：権限の無い利用者には出さない。\n",
      "## Design\n\n- The server builds the CSV with the same filters as the list.\n- Test viewpoint: users without permission cannot download it.\n",
    ),
    0.48,
    { selfReview },
  );
  t.add(1.6, "sacty", "StepPullRequestPublished", {
    step: "design",
    branch: `${branch}-design-1`,
    commit: "2b3c4d5e6f70",
    base: "5d6e7f8091a2",
    path: "docs/sacty/b2d4f6a8/design.md",
    url: `${WEB_REPO}/pull/45`,
    number: 45,
    repo: WEB_REPO,
  });
  t.submit(1.6, "design");
  reviewed(t, id, 1.55, {
    id: "b2d4f6a8-1102",
    step: "design",
    repo: WEB_REPO,
    number: 45,
    title,
    commit: "2b3c4d5e6f70",
  });
}

// 3. マージの後の監視中（不具合の修正。再現してから直した）
{
  const t = task("d4f6b8c0-1003", PAY);
  t.create(
    9,
    L("請求書 PDF の文字化けを直す", "Fix garbled characters in invoice PDFs"),
    L("請求書 PDF で一部の漢字が文字化けする。", "Some characters are garbled in invoice PDFs."),
    { repo: WEB_REPO },
  );
  t.repo(8.95, WEB_REPO);
  gather(
    t,
    8.9,
    L(
      "## 目的と背景\n\n請求書 PDF の宛名で、一部の漢字が別の文字になる。\n",
      "## Goal and background\n\nSome characters in the addressee of invoice PDFs turn into other characters.\n",
    ),
  );
  t.plan(
    8.8,
    "bugfix",
    ["reproduce", "implement", "deployment"],
    L("不具合の報告のため、まず再現する", "A bug report, so it is reproduced first"),
    { testCommand: "npm test", ...watch },
  );
  t.run(
    8.7,
    "reproduce",
    L(
      "## 再現\n\n- PDF に埋め込むフォントに無い漢字で再現した。失敗するテストを足した。\n",
      "## Reproduction\n\n- Reproduced with characters missing from the embedded font. Added a failing test.\n",
    ),
    0.19,
  );
  t.add(8.3, "sacty", "ReproductionChecked", {
    reproduced: true,
    tests: ["src/pdf.test.ts › embeds the font"],
    command: "npm test",
    exitCode: 1,
    output: "Tests  1 failed | 41 passed (42)",
  });
  t.run(8.2, "implement", implementation, 0.52, {
    testMap: [{ viewpointId: "REQ", tests: ["src/pdf.test.ts › embeds the font"] }],
    selfReview,
  });
  t.add(7.8, "sacty", "FinalReviewSkipped", {});
  t.pr(7.75, WEB_REPO, 87);
  t.submit(7.75, "implement");
  t.merged(0.4, 87);
  t.approve(0.4, "implement", "idle");
  t.add(0.4, "sacty", "DeploymentWatchStarted", {
    number: 87,
    repo: WEB_REPO,
    branch: "main",
    commit: "b81f3e5d6c20",
  });
}

/** 実装まで終えて PR がマージされ、完了したタスク（マージの後の監視は無い）。 */
function delivered(t, hoursAgo, repo, number, plan, steps, reason, cost) {
  t.repo(hoursAgo - 0.05, repo);
  gather(
    t,
    hoursAgo - 0.1,
    L("## 目的と背景\n\n依頼のとおり。\n", "## Goal and background\n\nAs requested.\n"),
  );
  t.plan(hoursAgo - 0.2, plan, steps, reason, { testCommand: "npm test", ...noWatch });
  t.run(hoursAgo - 0.3, "implement", implementation, cost, { selfReview });
  t.add(hoursAgo - 0.7, "sacty", "FinalReviewSkipped", {});
  t.pr(hoursAgo - 0.75, repo, number);
  t.submit(hoursAgo - 0.75, "implement");
  t.merged(hoursAgo - 3, number);
  t.approve(hoursAgo - 3, "implement", "idle");
}

/** 監査の実行の記録（費用を含む）。 */
const auditRun = (cost) => ({ ...ai, usage: usage(52000, 2100), auditCostUsd: cost });

// 4. 完了（監査が原因を見つけ、改修を提案した。提案はまだ決めていない）
{
  const id = "a7c9e1f3-1004";
  const auditId = "audit-1004";
  const t = task(id, PAY);
  t.create(
    50,
    L("Webhook の署名を検証する", "Verify webhook signatures"),
    L(
      "決済の Webhook の署名を検証してから処理したい。",
      "Verify the signature of payment webhooks before processing them.",
    ),
    { repo: PAY_REPO },
  );
  delivered(
    t,
    50,
    PAY_REPO,
    131,
    "direct",
    ["implement", "deployment"],
    L("既存の受け口に検証を足す局所的な変更のため", "A local change to the existing endpoint"),
    0.71,
  );
  t.add(46.9, "sacty", "AuditQueued", { auditId, capUsd: 1 });
  t.add(46.5, "auditor", "AuditSurveyed", {
    auditId,
    summary: L(
      "実装の PR で、設計書の置き場所の指摘を受けて作り直していた。",
      "The implementation PR was reworked after a remark about where the design document belongs.",
    ),
    counts: { pullRequestRemark: 1, aiReviewRemark: 2, retry: 1 },
    concerns: [
      {
        step: "implement",
        reason: L(
          "同じ種類の指摘で、実装を 2 回作り直した",
          "The implementation was redone twice for the same kind of remark",
        ),
      },
    ],
    ...auditRun(0.14),
  });
  t.add(46.2, "auditor", "AuditDeepDived", {
    auditId,
    step: "implement",
    summary: L(
      "設計書の置き場所が決まっていないことが原因だった。",
      "The cause was that no location is set for design documents.",
    ),
    findings: [
      {
        causeKey: `${auditId}:implement:1`,
        title: L(
          "設計書の置き場所が決まっておらず、PR で移動の指摘を受けた",
          "No location is set for design documents, so the PR got a remark to move one",
        ),
        detail: L(
          "規約に置き場所が無く、エージェントが毎回ちがう場所に置いていた。",
          "The rules name no location, so the agent put the document somewhere different each time.",
        ),
        step: "implement",
        evidence: [
          {
            kind: "pullRequestRemark",
            text: L(
              "設計書は docs/design の下に置いてください",
              "Please put design documents under docs/design",
            ),
            step: "implement",
          },
        ],
        proposals: [
          {
            id: "proposal-1004-1",
            title: L(
              "コンテキストの規約に、設計書の置き場所を書く",
              "Write the location of design documents in the context rules",
            ),
            body: L(
              "設計書は `docs/design/<タスクの名前>.md` に置く、と規約に書く。",
              "State in the rules that design documents go in `docs/design/<task name>.md`.",
            ),
            target: { kind: "context", repo: CONTEXT, depth: 0 },
            candidates: [
              { kind: "context", repo: CONTEXT, depth: 0 },
              { kind: "repository", repo: PAY_REPO },
              { kind: "sacty" },
            ],
          },
        ],
      },
    ],
    memories: [
      {
        id: "memory-1004-1",
        scope: "repository",
        repo: PAY_REPO,
        title: L(
          "Webhook のテストは、署名の鍵をテスト用の値に差し替える",
          "Webhook tests swap the signing key for a test value",
        ),
        summary: L(
          "本物の鍵が無いと失敗するテストがある。差し替えの仕方は test/helpers にある。",
          "Some tests fail without the real key. test/helpers shows how to swap it.",
        ),
        body: L(
          "`test/helpers/signing.ts` の `withTestKey` を使う。",
          "Use `withTestKey` in `test/helpers/signing.ts`.",
        ),
      },
    ],
    ...auditRun(0.22),
  });
  t.add(46.2, "sacty", "AuditCompleted", { auditId });
}

// 5. 完了（監査の提案を採用し、改修のタスクの PR もマージ済み）
const FIX_ID = "c9e1a3b5-1006";
{
  const id = "e5a7c9d1-1005";
  const auditId = "audit-1005";
  const t = task(id, PAY);
  t.create(
    120,
    L("返金の通知の文面を直す", "Fix the refund notice text"),
    L("返金の通知メールの文面を、新しい規約に合わせたい。", "Update the refund notice email."),
    { repo: PAY_REPO },
  );
  delivered(
    t,
    120,
    PAY_REPO,
    119,
    "direct",
    ["implement", "deployment"],
    L("文面だけの局所的な変更のため", "A local change to the text only"),
    0.38,
  );
  t.add(116.9, "sacty", "AuditQueued", { auditId, capUsd: 1 });
  t.add(116.5, "auditor", "AuditSurveyed", {
    auditId,
    summary: L(
      "書式の指摘が、PR で 3 回繰り返されていた。",
      "Formatting remarks were repeated three times on the PR.",
    ),
    counts: { aiReviewRemark: 3, retry: 2 },
    concerns: [
      {
        step: "implement",
        reason: L("書式の指摘の繰り返し", "Repeated formatting remarks"),
      },
    ],
    ...auditRun(0.12),
  });
  t.add(116.2, "auditor", "AuditDeepDived", {
    auditId,
    step: "implement",
    summary: L(
      "フォーマッターの設定が無いことが原因だった。",
      "The cause was the missing formatter configuration.",
    ),
    findings: [
      {
        causeKey: `${auditId}:implement:1`,
        title: L(
          "フォーマッターの設定が無く、書式の指摘が PR で繰り返された",
          "With no formatter configuration, formatting remarks kept recurring on the PR",
        ),
        detail: L(
          "書式を機械的に確かめる手段が無く、レビューで初めて気づいていた。",
          "Nothing checked the formatting mechanically, so it was only noticed in review.",
        ),
        step: "implement",
        evidence: [
          {
            kind: "aiReviewRemark",
            text: L("インデントがそろっていません", "The indentation is inconsistent"),
            step: "implement",
          },
        ],
        proposals: [
          {
            id: "proposal-1005-1",
            title: L(
              "リポジトリにフォーマッターの設定と、確かめるコマンドを足す",
              "Add a formatter configuration and a check command to the repository",
            ),
            body: L(
              "- フォーマッターの設定ファイルを置く\n- `AGENTS.md` に、提出の前に実行するコマンドを書く\n",
              "- Add a formatter configuration file\n- Write the command to run before submitting in `AGENTS.md`\n",
            ),
            target: { kind: "repository", repo: PAY_REPO },
            candidates: [{ kind: "repository", repo: PAY_REPO }, { kind: "sacty" }],
          },
        ],
      },
    ],
    ...auditRun(0.2),
  });
  t.add(116.2, "sacty", "AuditCompleted", { auditId });
  t.add(96, "person", "AuditProposalAdopted", {
    proposalId: "proposal-1005-1",
    target: { kind: "repository", repo: PAY_REPO },
    fixTaskId: FIX_ID,
  });
}

// 6. 完了（採用した提案から作った、改修のタスク）
{
  const t = task(FIX_ID, PAY);
  t.add(96, "person", "TaskCreated", {
    title: L(
      "改修：リポジトリにフォーマッターの設定と、確かめるコマンドを足す",
      "Fix: add a formatter configuration and a check command to the repository",
    ),
    body: L(
      "監査の提案を採用して作ったタスク。フォーマッターの設定と、提出の前に実行するコマンドを足す。",
      "Created by adopting an audit proposal. Add a formatter configuration and the command to run before submitting.",
    ),
    start: "audit",
    budgetCapUsd: 5,
    repo: PAY_REPO,
    auditFix: { taskId: "e5a7c9d1-1005", proposalId: "proposal-1005-1" },
  });
  delivered(
    t,
    96,
    PAY_REPO,
    121,
    "direct",
    ["implement", "deployment"],
    L("設定のファイルを足す局所的な変更のため", "A local change that adds configuration files"),
    0.29,
  );
}

// 7. 完了（調査だけ。監査は、懸念が無いので深掘りせずに終えた）
{
  const auditId = "audit-1007";
  const t = task("f6b8d0e2-1007", PAY);
  t.create(
    74,
    L("在庫同期ジョブが遅い原因を調べる", "Investigate why the inventory sync job is slow"),
    L(
      "夜間の在庫同期が 2 時間かかる原因を知りたい。",
      "Find out why the nightly inventory sync takes two hours.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(73.95, PAY_REPO);
  gather(
    t,
    73.9,
    L(
      "## 目的と背景\n\n夜間の在庫同期が 2 時間かかる。\n",
      "## Goal and background\n\nThe nightly inventory sync takes two hours.\n",
    ),
  );
  t.plan(
    73.8,
    "investigate",
    ["investigate"],
    L("原因の調査が目的のため", "The goal is to find the cause"),
    { investigation: "content" },
  );
  t.run(
    73.7,
    "investigate",
    L(
      "## 調査の結果\n\n- 1 件ずつ API を呼んでいるのが原因。まとめて呼べば 10 分ほどになる見込み。\n",
      "## Findings\n\n- It calls the API one item at a time; batching should bring it to about 10 minutes.\n",
    ),
    0.41,
  );
  t.submit(73.3, "investigate");
  t.approve(70, "investigate", "idle");
  t.add(70, "sacty", "AuditQueued", { auditId, capUsd: 1 });
  t.add(69.7, "auditor", "AuditSurveyed", {
    auditId,
    summary: L(
      "差し戻しも試行錯誤も無く、懸念のある工程は無い。",
      "No changes requested and no trial and error; no step raises a concern.",
    ),
    counts: {},
    concerns: [],
    ...auditRun(0.09),
  });
  t.add(69.7, "sacty", "AuditCompleted", { auditId });
}

finish();
