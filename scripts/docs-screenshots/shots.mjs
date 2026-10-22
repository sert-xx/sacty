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
  { name: "task-pull-request", path: "/tasks/a1c3e5f7-0001", height: 760 },
  { name: "task-paused", path: "/tasks/b2d4f6a8-0002", height: 520 },
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
