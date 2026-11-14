// ユーザードキュメントのスクリーンショット用に、架空のプロジェクトとタスクを SACTY_HOME に入れる。
// 設定・操作・トラブルの説明の画面のためのデータで、承認待ち・マージの後の監視・完了のほかに、止まったタスク
// （利用上限・認証のエラー・予算の上限）を含む。
// 実際の AI・GitHub・Docker は使わない。作業履歴に、タスクの状態を作るイベントを直接書く（道具は seed-lib.mjs）。
//   node scripts/docs-screenshots/seed.mjs <SACTY_HOME> <ja|en>
// デーモンのビルド（npm run build）が要る。
// 紹介のページ（docs/user/introduction.md）の画面は、別のデータ（seed-intro.mjs）で撮る。
//
// タスクは、今の実装が記録する流れで書く（seed-lib.mjs の先頭）。
// - sacty が作る PR には、レビューを終えた子タスクを入れる（無いと、デーモンが作って実行し、「エラーで一時停止」が写る）。
// - 以前の版の記録（前段の調査・最終レビューの FinalReviewed）は入れていない。不安定なテストの台帳は、今の監査の画面に
//   出ない（docs/spec/audit.md の「不安定なテストの台帳」）ので、台帳のための FinalReviewed の記録も要らない。
// 撮る画面が使うタスクの ID は、shots.mjs にある。
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSeed } from "./seed-lib.mjs";

const { L, projects, task, usage, finish } = openSeed("seed.mjs");

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

const PAY_REPO = "https://github.com/acme/payments-api";
const WEB_REPO = "https://github.com/acme/billing-web";
const PORTAL_REPO = "https://github.com/acme/portal";

// ---- よく使う中身 ----
const selfReview = { rounds: 2, passed: true, remaining: [], notReviewed: [], summary: "" };
/** マージの後の監視をする（対象のリポジトリに、デプロイの確認のスキルがある）。 */
const watch = { deployment: { skill: ".agents/skills/deployment-observer/SKILL.md" } };
/** マージの後の監視を飛ばす（スキルが無い）。 */
const noWatch = {
  deployment: {
    skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
  },
};
/** PR の本文は、sacty の決まった形（対象のリポジトリに PR テンプレートが無い）。 */
const noTemplate = { template: { fallback: "none" } };
/** 要求要件の PR をレビューした子タスクの本文。 */
const requirementsReview = L(
  "## 総評\n\n指摘はありません。依頼の内容が、確かめられる要求要件になっています。\n",
  "## Summary\n\nNo findings. The request is written as verifiable requirements.\n",
);

/**
 * 要求要件の PR を作り、レビューの子タスクが指摘なしでレビューした。人の承認（PR のマージ）待ちになる。
 * hoursAgo は、要求要件の実行が終わった直後。
 */
function requirementsPr(t, hoursAgo, { child, repo, number, title, commit }) {
  t.stepPr(hoursAgo, "requirements", { repo, number, commit, ...noTemplate });
  t.submit(hoursAgo, "requirements");
  t.reviewed(hoursAgo - 0.02, {
    id: child,
    step: "requirements",
    repo,
    number,
    title,
    commit,
    output: requirementsReview,
  });
}

/**
 * 実装の後：最終レビューをせずに、実装の PR をドラフトで作り、レビューの子タスクが指摘なしにして、sacty がドラフトを
 * 外した。人の承認（PR のマージ）待ちになる。hoursAgo は、実装の実行が終わった直後。
 */
function implementationPr(t, hoursAgo, { child, repo, number, title, commit }) {
  t.add(hoursAgo, "sacty", "FinalReviewSkipped", {});
  t.pr(hoursAgo - 0.02, repo, number, {
    commit,
    ...noTemplate,
    awaitingReview: true,
    draft: true,
  });
  t.submit(hoursAgo - 0.02, "implement");
  t.reviewed(hoursAgo - 0.04, { id: child, step: "implement", repo, number, title, commit });
  // 子タスクがレビューを投稿した後の、次の PR の確認で外す
  t.add(hoursAgo - 0.56, "sacty", "PullRequestMarkedReady", {
    number,
    commit,
    reviewTaskId: child,
  });
}

// 1. 実装の PR のマージ待ち（レビューの子タスクが指摘なしにして、ドラフトを外した。タスクの詳細・質問の画面に使う）
{
  const title = L(
    "決済 API のタイムアウトを設定できるようにする",
    "Make the payment API timeout configurable",
  );
  const t = task("a1c3e5f7-0001", PAY);
  t.create(
    5,
    title,
    L(
      "決済 API のタイムアウトを設定ファイルで変えられるようにしたい。",
      "We want to change the payment API timeout in the settings file.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(4.95, PAY_REPO);
  t.gather(
    4.9,
    L(
      "## 目的と背景\n\n決済 API のタイムアウトを、設定ファイルで変えられるようにする。\n\n## やること・受け入れの条件\n\n- 設定ファイルに書いた秒数が、決済 API のタイムアウトになる。\n- 書かなければ、いまと同じ 10 秒になる。\n\n## 関係するコード\n\n- タイムアウトは `src/client.ts` で 10 秒に固定されている。\n- 設定ファイルを読む仕組みは `src/settings.ts` にあり、項目を足せばよい。\n\n## テストの書き方\n\n- Vitest。`npm test` で実行する。テストは、対象のファイルの隣（`src/client.test.ts`）に置く。\n",
      "## Goal and background\n\nMake the payment API timeout changeable in the settings file.\n\n## What to do and acceptance criteria\n\n- The number of seconds written in the settings file becomes the payment API timeout.\n- Without the setting, it stays at 10 seconds as it is now.\n\n## Related code\n\n- The timeout is fixed at 10 seconds in `src/client.ts`.\n- `src/settings.ts` already reads the settings file; adding an item there is enough.\n\n## How tests are written\n\n- Vitest, run with `npm test`. Tests sit next to the file they cover (`src/client.test.ts`).\n",
    ),
    // 折りたたんだ「集めた情報」に、情報源の件数が出る
    { sources: [{ title: "src/client.ts" }, { title: "src/settings.ts" }, { title: "README.md" }] },
  );
  t.plan(
    4.8,
    "direct",
    ["implement", "deployment"],
    L(
      "既存の設定の仕組みに沿った局所的な変更のため",
      "A local change that follows the existing settings mechanism",
    ),
    { testCommand: "npm test", ...watch },
  );
  t.run(
    4.7,
    "implement",
    L(
      "## 実装\n\n- 設定 `payment.timeout_sec`（既定 10）を足し、クライアントに渡した。\n- 観点 REQ のテストを `src/client.test.ts` に足した。\n",
      "## Implementation\n\n- Added the `payment.timeout_sec` setting (default 10) and passed it to the client.\n- Added tests for viewpoint REQ in `src/client.test.ts`.\n",
    ),
    0.64,
    {
      testMap: [{ viewpointId: "REQ", tests: ["src/client.test.ts › timeout from settings"] }],
      selfReview,
    },
  );
  implementationPr(t, 4.38, {
    child: "a1c3e5f7-0101",
    repo: PAY_REPO,
    number: 128,
    title,
    commit: "9e1d0c4b2a7f",
  });
  // オーケストレーターへの質問と答え
  t.add(1.2, "person", "QuestionAsked", {
    questionId: "Q-1",
    text: L(
      "タイムアウトの既定値を 10 秒のままにした理由は？",
      "Why did the default timeout stay at 10 seconds?",
    ),
  });
  t.add(1.18, "orchestrator", "QuestionAnswered", {
    questionId: "Q-1",
    answer: L(
      "依頼が既定値に触れていないので、実装は、いまの固定値の 10 秒をそのまま既定にしました。\n\n- 既定値を変えると、設定を書いていない環境の振る舞いが変わります。\n- 変える場合は、設定 `payment.timeout_sec` を書いてください（実装の PR #128）。\n",
      "The request does not mention the default, so the implementation kept the current fixed value of 10 seconds as the default.\n\n- Changing the default would change the behavior of environments without the setting.\n- To change it, set `payment.timeout_sec` (implementation PR #128).\n",
    ),
    runResult: "completed",
    agentId: "codex_lite",
    authMode: "api-key",
    model: "gpt-6-luna",
    usage: usage(24000, 600),
    costUsd: 0.04,
  });
}

// 2. 利用上限で一時停止（要求要件は PR のマージで承認済み。設計の実行が止まった。一時停止・エラーレポートの画面に使う）
{
  const title = L("注文履歴の CSV エクスポートを追加する", "Add CSV export to the order history");
  const t = task("b2d4f6a8-0002", PAY);
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
  t.gather(
    25.9,
    L(
      "## 目的と背景\n\n経理が、月末に注文履歴を表計算ソフトで集計している。いまは画面から写している。\n\n## 関係するコード\n\n- 注文履歴の一覧は `src/admin/orders.tsx`。絞り込みの条件は、サーバーの `src/api/orders.ts` が受け取る。\n",
      "## Goal and background\n\nAccounting totals the order history in a spreadsheet at month end, copying it from the screen today.\n\n## Related code\n\n- The order history list is `src/admin/orders.tsx`. The server's `src/api/orders.ts` receives the filters.\n",
    ),
  );
  t.plan(
    25.8,
    "standard",
    ["requirements", "design", "implement", "deployment"],
    L("出力の形式と権限の設計が要るため", "The output format and permissions need design"),
    { testCommand: "npm test", ...watch },
  );
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
  requirementsPr(t, 25.38, {
    child: "b2d4f6a8-0102",
    repo: WEB_REPO,
    number: 88,
    title,
    commit: "3c5e7a9b1d2f",
  });
  t.merged(1.7, 88, { commit: "3c5e7a9b1d2f", mergeCommit: "6f8a0c2e4b1d" });
  t.approve(1.7, "requirements", "queued");
  // 工程の見直し：設計を飛ばさずに進めると決めた
  t.add(1.68, "orchestrator", "StepsSkipped", {
    after: "requirements",
    steps: [],
    reason: L(
      "出力の形式と権限を設計で決める必要があるため、設計を飛ばさない",
      "The output format and permissions must be decided in design, so the design step is kept",
    ),
    agentId: "codex_lite",
    authMode: "api-key",
    model: "gpt-6-luna",
    usage: usage(21000, 400),
    costUsd: 0.02,
  });
  t.fail(
    1.6,
    "design",
    "usage_limit",
    L(
      "AI の利用上限に達しました（15:45 に戻ります）",
      "Reached the AI usage limit (resets at 3:45 PM)",
    ),
  );
}

// 3. 要求要件の PR のマージ待ち
{
  const title = L("ポータルの検索を全文検索にする", "Switch the portal search to full-text search");
  const t = task("c3e5a7b9-0003", PORTAL);
  t.create(
    8,
    title,
    L(
      "お知らせとドキュメントを本文でも検索できるようにしたい。",
      "Make announcements and documents searchable by their body text.",
    ),
    { repo: PORTAL_REPO },
  );
  t.repo(7.95, PORTAL_REPO);
  t.gather(
    7.9,
    L(
      "## 目的と背景\n\nいまの検索は題だけを見るので、本文にしか無い語では見つからない。\n\n## 関係するコード\n\n- 検索は `src/search/index.ts`。題の部分一致で絞り込んでいる。\n",
      "## Goal and background\n\nThe search looks at titles only, so words that appear only in the body are not found.\n\n## Related code\n\n- The search is `src/search/index.ts`. It filters by partial matches on titles.\n",
    ),
  );
  t.plan(
    7.8,
    "standard",
    ["requirements", "design", "implement", "deployment"],
    L(
      "検索の仕組みを入れ替える広い変更のため",
      "A broad change that replaces the search mechanism",
    ),
    { testCommand: "npm test", ...noWatch },
  );
  t.run(
    7.7,
    "requirements",
    L(
      "## 要求要件\n\n- R-1 利用者が検索語を入力したとき、システムは題と本文の両方から一致するものを返さなければならない。\n",
      "## Requirements\n\n- R-1 When a user enters a query, the system shall return matches from both titles and bodies.\n",
    ),
    0.31,
    { selfReview },
  );
  requirementsPr(t, 7.38, {
    child: "c3e5a7b9-0103",
    repo: PORTAL_REPO,
    number: 43,
    title,
    commit: "7b9d1f3a5c2e",
  });
}

// 4. マージの後の監視中（実装の PR がマージされ、CI/CD を待っている）
{
  const title = L("請求書 PDF の文字化けを直す", "Fix garbled characters in invoice PDFs");
  const t = task("d4f6b8c0-0004", PAY);
  t.create(
    30,
    title,
    L("請求書 PDF で一部の漢字が文字化けする。", "Some characters are garbled in invoice PDFs."),
    { repo: WEB_REPO },
  );
  t.repo(29.95, WEB_REPO);
  t.gather(
    29.9,
    L(
      "## 目的と背景\n\n請求書 PDF の宛名で、一部の漢字が別の文字になる。\n\n## 関係するコード\n\n- PDF は `src/pdf/invoice.ts` で作る。埋め込むフォントに、その漢字が無い。\n",
      "## Goal and background\n\nSome characters in the addressee of invoice PDFs turn into other characters.\n\n## Related code\n\n- `src/pdf/invoice.ts` builds the PDF. The embedded font lacks those characters.\n",
    ),
  );
  t.plan(
    29.8,
    "direct",
    ["implement", "deployment"],
    L("原因がフォントの指定だと明らかなため", "The cause is clearly the font setting"),
    { testCommand: "npm test", ...watch },
  );
  t.run(
    29.7,
    "implement",
    L(
      "## 実装\n\n- 請求書 PDF に埋め込むフォントを、宛名の漢字を含むものに替えた。\n- 観点 REQ のテストを `src/pdf.test.ts` に足した。\n",
      "## Implementation\n\n- Switched the font embedded in invoice PDFs to one that covers the characters in addressees.\n- Added tests for viewpoint REQ in `src/pdf.test.ts`.\n",
    ),
    0.52,
    {
      testMap: [{ viewpointId: "REQ", tests: ["src/pdf.test.ts › embeds the font"] }],
      selfReview,
    },
  );
  implementationPr(t, 29.38, {
    child: "d4f6b8c0-0104",
    repo: WEB_REPO,
    number: 87,
    title,
    commit: "c4e6a8b0d2f1",
  });
  t.merged(0.4, 87, { commit: "c4e6a8b0d2f1", mergeCommit: "b81f3e5d6c20" });
  t.approve(0.4, "implement", "idle");
  t.add(0.4, "sacty", "DeploymentWatchStarted", {
    number: 87,
    repo: WEB_REPO,
    branch: "main",
    commit: "b81f3e5d6c20",
  });
}

// 5. 完了（実装の PR がマージされた。マージの後の監視は、スキルが無いので飛ばした）
{
  const title = L("README にセットアップ手順を足す", "Add setup steps to the README");
  const t = task("e5a7c9d1-0005", PORTAL);
  t.create(
    52,
    title,
    L(
      "新しく入った人が README だけで動かせるようにしたい。",
      "Newcomers should be able to run it from the README alone.",
    ),
    { repo: PORTAL_REPO },
  );
  t.repo(51.95, PORTAL_REPO);
  t.gather(
    51.9,
    L(
      "## 目的と背景\n\nREADME に、動かすまでの手順が無い。\n\n## 関係するコード\n\n- 起動のコマンドは `package.json` の `scripts` にある。\n",
      "## Goal and background\n\nThe README has no steps to get it running.\n\n## Related code\n\n- The start commands are in `scripts` of `package.json`.\n",
    ),
  );
  t.plan(
    51.8,
    "direct",
    ["implement", "deployment"],
    L("文書の局所的な変更のため", "A local documentation change"),
    { testCommand: "npm test", ...noWatch },
  );
  t.run(
    51.7,
    "implement",
    L(
      "## 実装\n\n- README に、セットアップの手順（要るツール・インストール・起動）を足した。\n- 手順のコマンドを順に実行して、起動できることを確かめた。\n",
      "## Implementation\n\n- Added setup steps (required tools, installation, start) to the README.\n- Ran the commands in order and confirmed that it starts.\n",
    ),
    0.29,
    {
      testMap: [{ viewpointId: "REQ", tests: ["docs check"] }],
      selfReview,
    },
  );
  implementationPr(t, 51.38, {
    child: "e5a7c9d1-0105",
    repo: PORTAL_REPO,
    number: 41,
    title,
    commit: "5a7c9e1b3d0f",
  });
  t.merged(47, 41, { commit: "5a7c9e1b3d0f", mergeCommit: "d2f4b6a8c0e1" });
  t.approve(47, "implement", "idle");
}

// 6. 完了（調査だけ。画面で承認した。監査の画面で、モックの「監査済み」の場面になるよう、プロジェクトでいちばん先に完了させる）
{
  const t = task("f6b8d0e2-0006", PAY);
  t.create(
    76,
    L("在庫同期ジョブが遅い原因を調べる", "Investigate why the inventory sync job is slow"),
    L(
      "夜間の在庫同期が 2 時間かかる原因を知りたい。",
      "Find out why the nightly inventory sync takes two hours.",
    ),
    { repo: PAY_REPO },
  );
  t.repo(75.95, PAY_REPO);
  t.gather(
    75.9,
    L(
      "## 目的と背景\n\n夜間の在庫同期が 2 時間かかり、朝の業務に間に合わない日がある。\n\n## 関係するコード\n\n- 同期のジョブは `src/jobs/inventory-sync.ts`。\n",
      "## Goal and background\n\nThe nightly inventory sync takes two hours and sometimes misses the start of the business day.\n\n## Related code\n\n- The sync job is `src/jobs/inventory-sync.ts`.\n",
    ),
  );
  t.plan(
    75.8,
    "investigate",
    ["investigate"],
    L("原因の調査が目的のため", "The goal is to find the cause"),
    { investigation: "content" },
  );
  t.run(
    75.7,
    "investigate",
    L(
      "## 調査の結果\n\n- 1 件ずつ API を呼んでいるのが原因。まとめて呼べば 10 分ほどになる見込み。\n",
      "## Findings\n\n- It calls the API one item at a time; batching should bring it to about 10 minutes.\n",
    ),
    0.41,
  );
  t.submit(75.35, "investigate");
  t.approve(70, "investigate", "idle");
}

// 7. 認証のエラーで一時停止（最初の工程の実行が、認証のエラーで止まった）
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
  t.repo(2.95, PAY_REPO);
  t.gather(
    2.9,
    L(
      "## 目的と背景\n\n決済の Webhook を、署名を確かめずに処理している。\n\n## 関係するコード\n\n- Webhook の受け口は `src/webhooks/payment.ts`。\n",
      "## Goal and background\n\nPayment webhooks are processed without checking their signature.\n\n## Related code\n\n- The webhook endpoint is `src/webhooks/payment.ts`.\n",
    ),
  );
  t.plan(
    2.8,
    "skip-design",
    ["requirements", "implement", "deployment"],
    L(
      "受け入れ条件の整理が要る局所的な変更のため",
      "A local change whose acceptance criteria need sorting out",
    ),
    { testCommand: "npm test", ...watch },
  );
  t.fail(2.7, "requirements", "auth", "API Error: 401 Invalid authentication credentials");
}

// 8. 予算の上限で一時停止（サブスクリプションの実行なので、費用は換算した概算。予算で止まった画面・費用の表に使う）
{
  const title = L("ポータルのログイン画面を多言語にする", "Localize the portal sign-in page");
  const sub = { authMode: "subscription", estimated: true };
  const t = task("b8d0f2a4-0008", PORTAL);
  t.create(
    9,
    title,
    L(
      "ログイン画面を日本語と英語で出し分けたい。",
      "Show the sign-in page in Japanese or English.",
    ),
    { repo: PORTAL_REPO, budgetCapUsd: 2 },
  );
  t.repo(8.95, PORTAL_REPO);
  t.gather(
    8.9,
    L(
      "## 目的と背景\n\nログイン画面は日本語だけで、英語の利用者が読めない。\n\n## 関係するコード\n\n- ログイン画面は `src/login/page.tsx`。文言は、コードに直接書いてある。\n",
      "## Goal and background\n\nThe sign-in page is in Japanese only, so English-speaking users cannot read it.\n\n## Related code\n\n- The sign-in page is `src/login/page.tsx`. Its text is written directly in the code.\n",
    ),
    { ...sub, usage: usage(150000, 6000), costUsd: 0.25 },
  );
  t.plan(
    8.8,
    "skip-design",
    ["requirements", "implement", "deployment"],
    L(
      "受け入れ条件の整理が要る局所的な変更のため",
      "A local change whose acceptance criteria need sorting out",
    ),
    { ...sub, testCommand: "npm test", ...noWatch },
  );
  t.run(
    8.7,
    "requirements",
    L(
      "## 要求要件\n\n- R-1 利用者のブラウザーの言語が英語のとき、システムはログイン画面を英語で表示しなければならない。\n",
      "## Requirements\n\n- R-1 When the user's browser language is English, the system shall show the sign-in page in English.\n",
    ),
    1.38,
    { ...sub, selfReview },
  );
  t.stepPr(8.38, "requirements", {
    repo: PORTAL_REPO,
    number: 42,
    commit: "8d0f2a4c6e1b",
    ...noTemplate,
  });
  t.submit(8.38, "requirements");
  // 提出の直後に 80% を超えたので、通知を記録する
  t.add(8.38, "sacty", "BudgetWarned", { usedUsd: 1.66, capUsd: 2 });
  t.reviewed(8.36, {
    id: "b8d0f2a4-0108",
    step: "requirements",
    repo: PORTAL_REPO,
    number: 42,
    title,
    commit: "8d0f2a4c6e1b",
    output: requirementsReview,
  });
  t.merged(6, 42, { commit: "8d0f2a4c6e1b", mergeCommit: "e1a3c5d7f9b2" });
  t.approve(6, "requirements", "queued");
  t.run(
    5.9,
    "implement",
    L(
      "## 実装\n\n- ログイン画面の文言を、日本語と英語の辞書に分けた。\n- ブラウザーの言語で辞書を選ぶようにし、観点 R-1 のテストを `src/login.test.ts` に足した。\n",
      "## Implementation\n\n- Split the sign-in page text into Japanese and English dictionaries.\n- Chose the dictionary by the browser language and added tests for viewpoint R-1 in `src/login.test.ts`.\n",
    ),
    0.61,
    sub,
  );
  // 実装の実行の後に、予算の上限を超えた
  t.add(5.6, "sacty", "TaskPaused", { reason: "budget" });
}

finish();
