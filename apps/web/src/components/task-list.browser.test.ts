import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let url: string;

// 一覧の実際の部品を、合う行が 120 件のデータで描く（取り直しは止める）。
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/apps/web/src/i18n/client.tsx';
import { LiveTaskList } from '/apps/web/src/components/task-list.tsx';
window.fetch = () => new Promise(() => {});
const rows = Array.from({ length: 120 }, (_, i) => ({
  id: 't' + (i + 1),
  title: 'Task ' + (i + 1),
  child: false,
  depth: 0,
  start: 'sacty',
  repoless: false,
  steps: [],
  status: { text: 'Running', tone: 'working' },
  createdAt: '2026-10-01T12:00:00',
}));
const lang = new URLSearchParams(location.search).get('lang') ?? 'ja';
createRoot(document.getElementById('root')).render(
  React.createElement(I18nProvider, { locale: lang },
    React.createElement('main', { className: 'px-4' },
      React.createElement(LiveTaskList, { projectId: 'p1', initial: { projectId: 'p1', needsYou: [], rows } }),
    ),
  ),
);
`;

/** 部品の Tailwind のクラスだけの CSS を、実際の Tailwind で作る。 */
async function tailwindCss(): Promise<string> {
  const files = ["task-list.tsx", "ui/button.tsx", "ui/input.tsx", "task-bits.tsx", "ui/hint.tsx"];
  const source = files
    .map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8"))
    .join("\n");
  const candidates = new Set(`${source}\n${entry}`.match(/[^\s"'`{}()<>,;]+/g) ?? []);
  const compiler = await compile('@import "tailwindcss";', {
    base: fileURLToPath(new URL(".", import.meta.url)),
    onDependency: () => {},
  });
  return compiler.build([...candidates]);
}

beforeAll(async () => {
  const css = await tailwindCss();
  server = await createServer({
    configFile: false,
    envDir: false,
    server: { host: "127.0.0.1", port: 0 },
    resolve: {
      alias: {
        "@/app/actions": "virtual:list-actions",
        "next/link": "virtual:list-next-link",
        "next/navigation": "virtual:list-next-navigation",
        "@": fileURLToPath(new URL("..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@base-ui/react/button",
        "@base-ui/react/popover",
        "lucide-react",
        "cn",
        "class-variance-authority",
      ],
    },
    plugins: [
      {
        name: "task-list-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:list-actions",
              "virtual:list-next-link",
              "virtual:list-next-navigation",
              "/list-test-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/list-test-entry") return entry;
          if (id === "\0virtual:list-actions")
            return "export async function followProjectAction() {}";
          if (id === "\0virtual:list-next-navigation")
            return "export const useRouter = () => ({ refresh() {}, push() {}, replace() {}, bfcacheId: 'one' }); export const useSearchParams = () => new URLSearchParams(window.location.search);";
          if (id === "\0virtual:list-next-link")
            return "import React from 'react'; export default function Link(props) { return React.createElement('a', props); }";
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/?") && req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<style>${css}</style><div id="root"></div><script type="module" src="/list-test-entry"></script>`,
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
}, 60000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// 狭い幅でも、足した部品（「さらに表示」と件数の文）が、表示の幅から出ない。
it.each([
  ["ja", "さらに表示（残り70件）", "120件中 120件（50件を表示）"],
  ["en", "Show more (70 left)", "120 of 120 (showing 50)"],
])(
  "the show-more button and the count stay inside a 375px viewport (%s)",
  async (lang, buttonName, countText) => {
    const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    try {
      await page.goto(`${url}/?lang=${lang}`);
      const button = page.getByRole("button", { name: buttonName });
      await button.waitFor();
      const count = page.getByTestId("task-filter-count");
      expect(await count.textContent()).toBe(countText);
      for (const target of [button, count]) {
        const box = await target.boundingBox();
        if (!box) throw new Error("not visible");
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(375);
      }
    } finally {
      await page.close();
    }
  },
  30000,
);
