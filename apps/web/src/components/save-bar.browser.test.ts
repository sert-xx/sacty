import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let url: string;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const mainClass = /<main[^>]*?className="([^"]+)"/.exec(read("../app/layout.tsx"))?.[1] ?? "";

// 実際のサイドメニューと「保存する」の帯を、長い設定の画面（ヘッダー sticky h-16・長いフォーム）と同じ並びで置く。
// 画面は最上部に置いたまま（スクロールしない）。
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RailNav } from '/apps/web/src/components/shell/rail.tsx';
import { SaveBar } from '/apps/web/src/components/save-bar.tsx';
const h = React.createElement;
const params = new URLSearchParams(location.search);
globalThis.__locale = params.get('lang') ?? 'ja';
createRoot(document.getElementById('root')).render(
  h('div', { className: 'flex min-h-screen flex-col' },
    h('header', { className: 'sticky top-0 z-30 h-16 bg-white' }, 'Header'),
    h('div', { className: 'flex flex-1' },
      h(RailNav, { pathname: '/settings' }),
      h('main', { className: ${JSON.stringify(mainClass)} },
        h('div', { className: 'mx-auto flex max-w-6xl flex-col gap-6' },
          h('form', { className: 'flex flex-col gap-6' },
            h('div', { className: 'h-[3000px]' }, 'Long form'),
            h(SaveBar, { dirty: params.get('dirty') === '1', disabled: false, label: '保存する' },
              params.get('long') === '1' ? h('p', { role: 'alert' }, Array.from({ length: 80 }, (_, i) => 'エラーの行 ' + i).join('\\n')) : null),
          ),
        ),
      ),
    ),
  ),
);
`;

const i18n = `
import { messagesFor } from '/apps/web/src/i18n/index.ts';
export function useMessages() {
  return messagesFor(globalThis.__locale);
}
`;

async function tailwindCss(): Promise<string> {
  const sources = ["./save-bar.tsx", "./shell/rail.tsx", "./ui/button.tsx", "../app/layout.tsx"]
    .map(read)
    .join("\n");
  const candidates = new Set(`${sources}\n${entry}`.match(/[^\s"'`{}<>;]+/g) ?? []);
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
        "@/i18n/client": "virtual:bar-i18n",
        "next/link": "virtual:bar-next-link",
        "next/navigation": "virtual:bar-next-nav",
        "@": fileURLToPath(new URL("..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    optimizeDeps: {
      include: ["react", "react-dom/client", "react/jsx-runtime", "lucide-react", "cn"],
    },
    plugins: [
      {
        name: "save-bar-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:bar-i18n",
              "virtual:bar-next-link",
              "virtual:bar-next-nav",
              "/bar-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/bar-entry") return entry;
          if (id === "\0virtual:bar-i18n") return i18n;
          if (id === "\0virtual:bar-next-nav") return "export const usePathname = () => '/';";
          if (id === "\0virtual:bar-next-link")
            return "import React from 'react'; export default function Link({ onNavigate, ...props }) { return React.createElement('a', props); }";
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<style>${css}</style><div id="root"></div><script type="module" src="/bar-entry"></script>`,
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

async function open(width: number, dirty = false, long = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.goto(`${url}/?dirty=${dirty ? 1 : 0}&long=${long ? 1 : 0}`);
  await page.getByRole("button", { name: "保存する" }).waitFor();
  return page;
}

const box = async (locator: ReturnType<Page["locator"]>) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
};

it("at 375px the save button is visible at the top of a long screen and is not covered by the bottom menu", async () => {
  const page = await open(375);
  try {
    const button = await box(page.getByRole("button", { name: "保存する" }));
    const nav = await box(page.locator("nav"));
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.y + button.height).toBeLessThanOrEqual(700);
    expect(button.y + button.height).toBeLessThanOrEqual(nav.y);
    // メニューの上の、押せる位置にある（別の要素に覆われない）
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent,
      { x: button.x + button.width / 2, y: button.y + button.height / 2 },
    );
    expect(hit).toBe("保存する");
  } finally {
    await page.close();
  }
}, 30000);

it("at 1280px the save button is visible at the top of a long screen", async () => {
  const page = await open(1280);
  try {
    const button = await box(page.getByRole("button", { name: "保存する" }));
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.y + button.height).toBeLessThanOrEqual(700);
  } finally {
    await page.close();
  }
}, 30000);

it("the save button stays at the bottom of the screen while scrolling", async () => {
  for (const width of [375, 1280]) {
    const page = await open(width);
    try {
      const before = await box(page.getByRole("button", { name: "保存する" }));
      await page.evaluate(() => window.scrollTo(0, 1500));
      const after = await box(page.getByRole("button", { name: "保存する" }));
      expect(after.y).toBe(before.y);
    } finally {
      await page.close();
    }
  }
}, 30000);

it("the unsaved-changes note shows next to the save button, in the same bar", async () => {
  const page = await open(375, true);
  try {
    const note = await box(page.getByText("保存していない変更があります"));
    const bar = await box(page.getByTestId("save-bar"));
    const button = await box(page.getByRole("button", { name: "保存する" }));
    expect(note.y).toBeGreaterThanOrEqual(bar.y);
    expect(note.y + note.height).toBeLessThanOrEqual(bar.y + bar.height);
    expect(button.y + button.height).toBeLessThanOrEqual(bar.y + bar.height);
  } finally {
    await page.close();
  }
}, 30000);

it("a very long result keeps the bar within 40% of the screen and the save button stays visible", async () => {
  for (const width of [375, 1280]) {
    const page = await open(width, true, true);
    try {
      const bar = await box(page.getByTestId("save-bar"));
      const button = await box(page.getByRole("button", { name: "保存する" }));
      expect(bar.height).toBeLessThanOrEqual(700 * 0.4 + 1);
      expect(button.y).toBeGreaterThanOrEqual(bar.y);
      expect(button.y + button.height).toBeLessThanOrEqual(700);
      const results = page.getByTestId("save-bar-results");
      expect(await results.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    } finally {
      await page.close();
    }
  }
}, 30000);
