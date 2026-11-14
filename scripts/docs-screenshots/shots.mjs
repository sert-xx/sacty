// 撮る画面の一覧。name は docs/user/images/<name>.png（英語の版は <name>.en.png）になる。
// height を書いたものは、ページの上からその高さまでを撮る（幅は capture.mjs の画面の幅）。
// prepare で操作してから、selector の要素を撮る（maxHeight で高さを切る）。
// prepare では、作業履歴に書く操作（タスクの作成・承認など）をしない（capture.mjs が、撮る間の書き足しを失敗にする）。
// until を書いたものは、ページの上から、その要素の下の端までを撮る（要素をいくつか書いたら、いちばん下の端まで）。
// 下に足す余白は pad（書かなければ 24）。画面の高さは、撮る高さに合わせる。
// scenario は、撮るときのデータの場面（capture.mjs の SCENARIOS。書かなければ docs）。

/**
 * タスクの詳細の「Sacty の AI のレビュー」が、付いている状態になるまで待つ。デーモンが起動の後の PR の確認で PR の先頭を
 * 読むまでは「分かりません」と出るので、読む前に撮らない（読めないままなら、撮影を失敗にする）。
 */
async function aiReviewAttached(page) {
  const attached = page.locator('[data-testid="ai-review"][data-status="attached"]');
  for (let i = 0; i < 30 && !(await attached.isVisible()); i++) {
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: "networkidle" });
  }
  await attached.waitFor({ timeout: 1000 });
}

export const SHOTS = [
  {
    // 上の2段の欄（あなたの出番・止まっているタスクの理由・終わっていないタスク・費用と予算）まで
    name: "dashboard",
    path: "/dashboard",
    until: ['section[aria-labelledby="open-tasks"]', 'section[aria-labelledby="costs"]'],
  },
  {
    // あなたの出番のカードと、すべてのタスク（PR のレビューの子タスクが、親の下に並ぶ）
    name: "task-list",
    path: "/projects/payments/tasks",
    until: 'section[aria-labelledby="all-tasks"]',
  },
  {
    name: "new-task",
    path: "/projects/payments/tasks",
    prepare: async (page) => {
      await page.getByRole("button", { name: /^(タスクを作成|Create task)$/ }).click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(800);
    },
    selector: '[role="dialog"]',
  },
  {
    // 進め方を選び、工程ごとの設定でタスクのイメージ（PBI-318）と実装のエージェントを指定したところ
    name: "new-task-steps",
    path: "/projects/payments/tasks",
    prepare: async (page) => {
      await page.getByRole("button", { name: /^(タスクを作成|Create task)$/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.locator("select[name=plan]").selectOption("standard");
      await dialog.getByTestId("step-settings-open").click();
      await dialog
        .getByTestId("task-image")
        .locator("option", { hasText: "java17" })
        .waitFor({ state: "attached" });
      await dialog.getByTestId("task-image").selectOption("java17");
      await dialog.getByTestId("task-step-agent-implement").selectOption("codex_advanced");
      await page.waitForTimeout(500);
    },
    selector: '[role="dialog"]',
  },
  {
    // タスクの詳細の並び（上に固定した見出し・タブ、人の対応の案内、概要のタブ、右の列のプロパティと最近の作業履歴）。
    // 左の列の最後（折りたたんだ「集めた情報」）と、右の列の最後（最近の作業履歴）の、下にあるほうまでを撮る
    name: "task-detail",
    path: "/tasks/a1c3e5f7-0001",
    prepare: aiReviewAttached,
    until: ['details[aria-labelledby="gathered"]', 'section[aria-labelledby="recent"]'],
  },
  {
    name: "task-pull-request",
    path: "/tasks/a1c3e5f7-0001",
    prepare: aiReviewAttached,
    height: 760,
  },
  { name: "task-paused", path: "/tasks/b2d4f6a8-0002", height: 520 },
  { name: "task-budget-paused", path: "/tasks/b8d0f2a4-0008", height: 760 },
  {
    // エラーの記録があるタスクの、右の列のエラーレポートの欄
    name: "task-error-report",
    path: "/tasks/b2d4f6a8-0002",
    selector: 'section[aria-labelledby="error-report"]',
  },
  {
    name: "task-costs",
    // 工程ごとの費用は、費用のタブにある
    path: "/tasks/b8d0f2a4-0008?tab=costs",
    selector: 'section[aria-labelledby="step-costs"]',
  },
  {
    name: "task-chat",
    path: "/tasks/a1c3e5f7-0001",
    prepare: async (page) => {
      await aiReviewAttached(page);
      await page
        .getByRole("button", { name: /^(オーケストレーターに質問|Ask the Orchestrator)$/ })
        .click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(800);
    },
    // サイドパネルは画面の右に重なるので、タスクの詳細ごと撮る
    height: 1000,
  },
  { name: "project-settings", path: "/projects/payments/settings", height: 900 },
  {
    name: "context-preview",
    path: "/projects/payments/settings",
    prepare: async (page) => {
      await page
        .getByRole("button", { name: /保存した設定でプレビュー|Preview the saved settings/ })
        .click();
      await page
        .getByText(/保存した設定で作りました|Built from the saved settings/)
        .waitFor({ timeout: 30_000 });
      await page.waitForTimeout(500);
    },
    selector: 'section[aria-labelledby="context-preview"]',
    maxHeight: 1100,
  },
  {
    // 原因（再発を先に）と、判断待ちの改修の提案（2件）まで。提案どうしの間は狭いので、次の提案が入らない余白にする
    name: "audit",
    path: "/projects/payments/audit",
    until: 'section[aria-labelledby="audit-proposals"] > ul > li:nth-child(2)',
    pad: 4,
  },
  // 紹介のページ（introduction.md）の画面。ふだんの使い方が伝わる状態のデータ（seed-intro.mjs）で撮る
  {
    // あなたの出番のカードと、タスクの一覧（工程・PR のレビューの子タスク・状態）
    name: "intro-tasks",
    scenario: "intro",
    path: "/projects/payments/tasks",
    until: 'section[aria-labelledby="all-tasks"]',
  },
  {
    // 監査が見つけた原因と、改修の提案（判断待ちと、採用して改修のタスクになったもの）
    name: "intro-audit",
    scenario: "intro",
    path: "/projects/payments/audit",
    until: 'section[aria-labelledby="audit-proposals"]',
  },
];
