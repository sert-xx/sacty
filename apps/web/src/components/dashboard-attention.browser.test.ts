import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let url: string;

// 実際の AttentionCard（ダッシュボードの「あなたの出番」）を、上の組 2 件・下の組 8 件（長く止まっているもの）で描く。
// 欄はスクロールしない状態で、上の組の見出しと先頭の行が見えるかを幅ごとに確かめる（PBI-442）。
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AttentionCard } from '/apps/web/src/components/dashboard.tsx';
import { I18nProvider } from '/apps/web/src/i18n/client.tsx';
const h = React.createElement;
const now = Date.now();
const since = (hours) => new Date(now - hours * 3600_000).toISOString();
const row = (id, group, hours, text) => ({
  id, title: 'タスク ' + id + ' の長い題の例', projectId: 'p1', projectName: '決済', group,
  status: { text, tone: 'person' }, href: '/tasks/' + id, waitingSince: since(hours),
});
const attention = [
  row('d1', 'decision', 1, '実装の修正の PR のマージ待ち（コンフリクトの解消も必要）・AI のレビュー中'),
  row('d2', 'decision', 2, '設計の承認待ち'),
  ...Array.from({ length: 8 }, (_, i) => row('p' + i, 'paused', 100 + i, '利用上限で一時停止')),
];
createRoot(document.getElementById('root')).render(
  h(I18nProvider, { locale: 'ja' },
    h('div', { style: { padding: 16 } }, h(AttentionCard, { data: { attention }, now })),
  ),
);
`;

/** 部品とテストの画面で使う Tailwind のクラスだけの CSS を、実際の Tailwind で作る。 */
async function tailwindCss(): Promise<string> {
  const source = ["dashboard.tsx", "task-bits.tsx", "action-link.tsx", "ui/hint.tsx"]
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
        "@/app/actions": "virtual:attention-actions",
        "next/link": "virtual:attention-next-link",
        "next/navigation": "virtual:attention-next-navigation",
        "@": fileURLToPath(new URL("..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    cacheDir: fileURLToPath(
      new URL("../../node_modules/.vite-dashboard-attention", import.meta.url),
    ),
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@base-ui/react/popover",
        "lucide-react",
        "cn",
      ],
    },
    plugins: [
      {
        name: "attention-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:attention-actions",
              "virtual:attention-next-link",
              "virtual:attention-next-navigation",
              "/attention-test-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/attention-test-entry") return entry;
          if (id === "\0virtual:attention-actions")
            return [
              "runIntakeAction",
              "followProjectAction",
              "adoptAuditProposalAction",
              "deleteAuditMemoryAction",
              "rejectAuditProposalAction",
              "resumeAuditAction",
            ]
              .map((n) => `export async function ${n}() {}`)
              .join("\n");
          if (id === "\0virtual:attention-next-navigation")
            return "export const useRouter = () => ({ refresh() {}, push() {}, replace() {} }); export const usePathname = () => '/dashboard'; export const useSearchParams = () => new URLSearchParams();";
          if (id === "\0virtual:attention-next-link")
            return "import React from 'react'; export default function Link(props) { return React.createElement('a', props); }";
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<style>${css}</style><div id="root"></div><script type="module" src="/attention-test-entry"></script>`,
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

it.each([1440, 375])(
  "下の組が 8 件あっても、幅 %ipx で、欄をスクロールしないまま、上の組の見出しと先頭の行が欄の見える範囲に収まる",
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(url);
      await page.getByTestId("attention-list").waitFor();
      const box = async (selector: string) =>
        page.evaluate((s) => {
          const r = document.querySelector(s)?.getBoundingClientRect();
          return r ? { top: r.top, bottom: r.bottom } : null;
        }, selector);
      const list = await box('[data-testid="attention-list"]');
      const heading = await box("#attention-group-decision");
      const first = await box('[data-testid="attention-d1"]');
      const scrolled = await page.evaluate(
        () => document.querySelector('[data-testid="attention-list"]')?.scrollTop,
      );
      expect(scrolled).toBe(0);
      if (!list || !heading || !first) throw new Error("list, heading or first row is missing");
      // 下の組が多いので、欄は 5 件分の高さで切れている（スクロールする欄）
      const scrollable = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="attention-list"]');
        return el ? el.scrollHeight > el.clientHeight : false;
      });
      expect(scrollable).toBe(true);
      for (const part of [heading, first]) {
        expect(part.top).toBeGreaterThanOrEqual(list.top);
        expect(part.bottom).toBeLessThanOrEqual(list.bottom);
      }
      // 下の組の見出しは、上の組の後ろ
      const paused = await box("#attention-group-paused");
      expect(paused?.top ?? 0).toBeGreaterThan(first.bottom);
    } finally {
      await page.close();
    }
  },
  30000,
);

it("幅 375px で、「レビュー中」を添えた行の状態の文と待っている時間が欄の中に収まり、ページが横にずれない", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  try {
    await page.goto(url);
    await page.getByTestId("attention-list").waitFor();
    const m = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="attention-list"]');
      const row = document.querySelector('[data-testid="attention-d1"]');
      const wait = document.querySelector('[data-testid="attention-waiting-d1"]');
      const status = [...(row?.querySelectorAll("span") ?? [])].find((s) =>
        s.textContent?.includes("AI のレビュー中"),
      );
      const right = (e: Element | null | undefined) =>
        e?.getBoundingClientRect().right ?? Number.NaN;
      const left = (e: Element | null | undefined) => e?.getBoundingClientRect().left ?? Number.NaN;
      return {
        listRight: list ? list.getBoundingClientRect().left + list.clientWidth : Number.NaN,
        listLeft: list ? list.getBoundingClientRect().left : Number.NaN,
        statusLeft: left(status),
        waitLeft: left(wait),
        statusRight: right(status),
        waitRight: right(wait),
        statusScroll: status ? status.scrollWidth - status.clientWidth : Number.NaN,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(m.statusRight).toBeLessThanOrEqual(m.listRight);
    expect(m.statusLeft).toBeGreaterThanOrEqual(m.listLeft);
    expect(m.waitLeft).toBeGreaterThanOrEqual(m.listLeft);
    expect(m.waitRight).toBeLessThanOrEqual(m.listRight);
    expect(m.statusScroll).toBeLessThanOrEqual(0);
    expect(m.pageOverflow).toBeLessThanOrEqual(0);
  } finally {
    await page.close();
  }
}, 30000);
