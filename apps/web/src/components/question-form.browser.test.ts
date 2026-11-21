import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let url: string;

// 実際の部品をブラウザに載せる。Next のサーバー境界だけをテスト用に置き換える。
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuestionForm } from '/apps/web/src/components/question-form.tsx';
createRoot(document.getElementById('root')).render(React.createElement(QuestionForm, { taskId: 'browser-task' }));
`;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    server: { host: "127.0.0.1", port: 0 },
    resolve: {
      alias: {
        "@/app/actions": "virtual:question-actions",
        "@/i18n/client": "virtual:question-i18n",
        "@": fileURLToPath(new URL("..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@base-ui/react/button",
        "class-variance-authority",
        "cn",
      ],
    },
    plugins: [
      {
        name: "question-form-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:question-actions",
              "virtual:question-i18n",
              "@sacty/core",
              "/question-test-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/question-test-entry") return entry;
          if (id === "\0virtual:question-actions")
            return `export async function askQuestionAction() { window.requests = (window.requests || 0) + 1; return {}; }`;
          if (id === "\0virtual:question-i18n")
            return `export function useMessages() { return { task: { chat: {label: 'Question', send: 'Ask', sending: 'Sending', placeholder: '', help: ''} } }; }`;
          if (id === "\0@sacty/core") return `export const QUESTION_MAX = 2000;`;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              '<div id="root"></div><script type="module" src="/question-test-entry"></script>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture has no port");
  url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  // 依存の最適化のし直しでページが読み直されるのを、各テストの上限（30 秒）の中で待たないよう、ここで 1 度開いて済ませる。
  // goto と waitFor の上限は、それぞれ 60 秒にする（goto の既定は 30 秒で、初回の準備がそれを超えると落ちるため）。順に待つので、事前の読み込みは最大 120 秒かかる。
  // beforeAll の上限（180 秒）は、サーバーとブラウザーの起動に、この最大 120 秒を足しても収まる値にしている。
  const warm = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  try {
    await warm.goto(url, { timeout: 60000 });
    await warm.locator("textarea").waitFor({ timeout: 60000 });
  } finally {
    await warm.close();
  }
}, 180000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

it.each(["Enter", "Shift+Enter"])(
  "%s inserts one newline at the cursor without sending (REQ R-3/R-4/R-15)",
  async (key) => {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      const input = page.locator("textarea");
      await input.fill("前後");
      await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(1, 1));
      await input.press(key);
      expect(await input.inputValue()).toBe("前\n後");
      expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(2);
      expect(
        await page.evaluate(() => (window as Window & { requests?: number }).requests ?? 0),
      ).toBe(0);
      await input.fill("a".repeat(2000));
      await input.press(key);
      expect(await input.inputValue()).toBe("a".repeat(2000));
      expect(
        await page.evaluate(() => (window as Window & { requests?: number }).requests ?? 0),
      ).toBe(0);
    } finally {
      await page.close();
    }
  },
  15000,
);
