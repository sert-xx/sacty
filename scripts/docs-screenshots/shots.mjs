// 撮る画面の一覧。name は docs/user/images/<name>.png（英語の版は <name>.en.png）になる。
// height を書いたものは、ページの上からその高さまでを撮る（幅は capture.mjs の画面の幅）。
// prepare で操作してから、selector の要素を撮る（maxHeight で高さを切る）。
export const SHOTS = [
  { name: "dashboard", path: "/dashboard", height: 880 },
  { name: "task-list", path: "/projects/payments/tasks", height: 960 },
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
    // 進め方を選び、工程ごとの設定で設計のイメージと実装のエージェントを指定したところ
    name: "new-task-steps",
    path: "/projects/payments/tasks",
    prepare: async (page) => {
      await page.getByRole("button", { name: /^(タスクを作成|Create task)$/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.locator("select[name=plan]").selectOption("standard");
      await dialog.getByTestId("step-settings-open").click();
      await dialog
        .getByTestId("task-step-image-design")
        .locator("option", { hasText: "java17" })
        .waitFor({ state: "attached" });
      await dialog.getByTestId("task-step-image-implement").selectOption("java17");
      await dialog.getByTestId("task-step-agent-implement").selectOption("codex_advanced");
      await page.waitForTimeout(500);
    },
    selector: '[role="dialog"]',
  },
  // タスクの詳細の並び（上に固定した見出し・タブ・右の列のプロパティ）
  { name: "task-detail", path: "/tasks/a1c3e5f7-0001", height: 900 },
  { name: "task-pull-request", path: "/tasks/a1c3e5f7-0001", height: 760 },
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
  { name: "audit", path: "/projects/payments/audit", height: 1000 },
];
