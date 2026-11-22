import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium, type Page } from "playwright";
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
const plain = Array.from({ length: 120 }, (_, i) => ({
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
// 子タスク・複数のリポジトリ・長い題・CI 失敗・テンプレート・取り込み元の番号を含む 120 件
const long = 'Make the payment timeout configurable per merchant and show the remaining time in the checkout screen so that buyers know when to retry ';
const stepList = [{ key: 'requirements', state: 'done' }, { key: 'design', state: 'done' }, { key: 'implement', state: 'active' }, { key: 'review', state: 'todo' }];
const rich = Array.from({ length: 120 }, (_, i) => {
  const kind = i % 6;
  return {
    id: 't' + (i + 1),
    title: kind === 0 ? long + (i + 1) : 'Task ' + (i + 1),
    child: kind === 1,
    depth: kind === 1 ? 1 : 0,
    parentId: kind === 1 ? 't' + i : undefined,
    parentTitle: kind === 1 ? 'Parent' : undefined,
    start: kind === 2 ? 'github_issue' : 'sacty',
    template: kind === 3 ? 'bugfix' : undefined,
    source: kind === 2 ? { repo: 'acme/payments-api', number: 100 + i } : undefined,
    repoless: kind === 4,
    repoName: kind === 5 ? 'payments-api' : kind === 0 ? 'checkout-web-frontend-with-a-long-name' : undefined,
    repos: kind === 0 ? ['https://github.com/acme/checkout-web-frontend-with-a-long-name', 'https://github.com/acme/payments-api'] : undefined,
    steps: stepList,
    status: { text: kind === 0 ? 'Waiting for your approval' : 'Running', tone: kind === 0 ? 'person' : 'working' },
    ciFailed: kind === 0 ? true : undefined,
    createdAt: '2026-10-01T12:00:00',
  };
});
const rows = new URLSearchParams(location.search).get('data') === 'rich' ? rich : plain;
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
  const candidates = new Set(`${source}\n${entry}`.match(/[^\s"'`{}<>;]+/g) ?? []);
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
        "react/jsx-dev-runtime",
        "@base-ui/react/input",
        "zod",
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
  // 依存の最適化のし直しでページが読み直されるのを、各テストの上限（30 秒）の中で待たないよう、ここで 1 度開いて済ませる。
  // goto と waitFor の上限は、それぞれ 60 秒にする（goto の既定は 30 秒で、初回の準備がそれを超えると落ちるため）。順に待つので、事前の読み込みは最大 120 秒かかる。
  // beforeAll の上限（180 秒）は、サーバーとブラウザーの起動に、この最大 120 秒を足しても収まる値にしている。
  const warm = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  try {
    await warm.goto(`${url}/?lang=ja`, { timeout: 60000 });
    await warm.getByTestId("task-filter-count").waitFor({ timeout: 60000 });
  } finally {
    await warm.close();
  }
}, 180000);

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

const open = async (width: number, query: string, height = 800): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${url}/?${query}`);
  await page.getByTestId("task-filter-count").waitFor();
  return page;
};

it("the page does not scroll sideways at 375px with children, repositories, long titles and CI failures (TV-1)", async () => {
  const page = await open(375, "lang=en&data=rich");
  try {
    expect(await page.getByTestId("task-row-t1").count()).toBe(1);
    expect(await page.getByTestId("task-ci-failed-t1").isVisible()).toBe(true);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths).toEqual({ scroll: 375, client: 375 });
  } finally {
    await page.close();
  }
}, 30000);

it.each([375, 639])(
  "each task is one card under 640px: no header row, rows stacked, title within two lines (%ipx) (TV-3)",
  async (width) => {
    const page = await open(width, "lang=en&data=rich");
    try {
      expect(await page.locator("thead").isVisible()).toBe(false);
      const boxes = [];
      for (const id of ["t1", "t2", "t3"]) {
        const box = await page.getByTestId(`task-row-${id}`).boundingBox();
        if (!box) throw new Error("row not visible");
        boxes.push(box);
      }
      for (const [i, box] of boxes.entries()) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        if (i > 0) expect(box.y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height - 1);
      }
      const row = page.getByTestId("task-row-t1");
      const link = row.locator('a[href="/tasks/t1"]');
      const style = await link.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          line: Number.parseFloat(cs.lineHeight),
          scrollHeight: el.scrollHeight,
        };
      });
      // 全文は 3 行以上に折り返す長さ。2 行に省略されている
      expect(style.scrollHeight).toBeGreaterThan(style.height + 1);
      expect(style.height).toBeLessThanOrEqual(style.line * 2 + 1);
      const status = row.getByText("Waiting for your approval");
      const steps = row.getByRole("list", { name: /./ }).first();
      for (const target of [status, steps]) {
        const box = await target.boundingBox();
        const card = await row.boundingBox();
        if (!box || !card) throw new Error("not visible");
        expect(box.x).toBeGreaterThanOrEqual(card.x);
        expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      }
    } finally {
      await page.close();
    }
  },
  30000,
);

it("the start point and the repository are small and under the title in the card (TV-4)", async () => {
  const page = await open(375, "lang=en&data=rich");
  try {
    const row = page.getByTestId("task-row-t1");
    const linkBox = await row.locator('a[href="/tasks/t1"]').boundingBox();
    const repoBox = await page.getByTestId("task-repo-t1").boundingBox();
    if (!linkBox || !repoBox) throw new Error("not visible");
    expect(repoBox.y).toBeGreaterThanOrEqual(linkBox.y + linkBox.height - 1);
    expect(
      await page.getByTestId("task-repo-t1").evaluate((e) => getComputedStyle(e).fontSize),
    ).toBe("12px");
    // 開始地点（2 件目は GitHub のチケット。取り込み元の番号つき）
    const second = page.getByTestId("task-row-t3");
    const start = second.getByText("#102");
    const titleBox = await second.locator('a[href="/tasks/t3"]').boundingBox();
    const startBox = await start.boundingBox();
    if (!titleBox || !startBox) throw new Error("not visible");
    expect(startBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
    expect(await start.evaluate((e) => getComputedStyle(e).fontSize)).toBe("12px");
    const label = second.locator("td").nth(1);
    expect(await label.evaluate((e) => getComputedStyle(e).fontSize)).toBe("12px");
  } finally {
    await page.close();
  }
}, 30000);

it("under 640px only search and status show; Filter opens the rest (TV-5)", async () => {
  const page = await open(375, "lang=en&data=rich");
  try {
    const search = page.getByLabel("Search");
    const status = page.getByLabel("Status");
    const hidden = [
      page.getByLabel("Start date (from)"),
      page.getByLabel("Start date (to)"),
      page.getByLabel("Started from"),
      page.getByLabel("Repository"),
    ];
    expect(await search.isVisible()).toBe(true);
    expect(await status.isVisible()).toBe(true);
    for (const field of hidden) expect(await field.isVisible()).toBe(false);
    const toggle = page.getByRole("button", { name: "Filter", exact: true });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    for (const field of hidden) expect(await field.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  } finally {
    await page.close();
  }
}, 30000);

it.each([
  ["en", "Filter (2)"],
  ["ja", "絞り込む（2）"],
])(
  "the closed Filter button counts the hidden conditions, the URL conditions apply and stay while searching (%s) (TV-6)",
  async (lang, name) => {
    const page = await open(375, `lang=${lang}&data=rich&start=sacty&repo=payments-api`);
    try {
      expect(await page.getByRole("button", { name }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name }).getAttribute("aria-expanded")).toBe("false");
      // 開始地点が sacty で、作業・指定のリポジトリに payments-api を持つ行（i % 6 が 0 か 5）だけ
      const kinds = async () =>
        (
          await page
            .locator('[data-testid^="task-row-"]')
            .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid") ?? ""))
        ).map((id) => (Number(id.replace("task-row-t", "")) - 1) % 6);
      const shown = await kinds();
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((kind) => kind === 0 || kind === 5)).toBe(true);
      await page.getByLabel(lang === "ja" ? "検索" : "Search").fill("Task");
      const query = new URLSearchParams(await page.evaluate(() => location.search));
      expect(query.get("start")).toBe("sacty");
      expect(query.get("repo")).toBe("payments-api");
      expect(query.get("q")).toBe("Task");
      // 検索を足しても、閉じたままで条件は 2 つのまま。題に Task を含む行（i % 6 が 5）だけになる
      expect(await page.getByRole("button", { name }).isVisible()).toBe(true);
      const narrowed = await kinds();
      expect(narrowed.length).toBeGreaterThan(0);
      expect(narrowed.every((kind) => kind === 5)).toBe(true);
    } finally {
      await page.close();
    }
  },
  30000,
);

it.each([640, 1023, 1280])(
  "the table, six filter fields and no Filter button show at %ipx (TV-12)",
  async (width) => {
    const page = await open(width, "lang=en&data=rich");
    try {
      expect(await page.locator("thead").isVisible()).toBe(true);
      for (const label of [
        "Search",
        "Start date (from)",
        "Start date (to)",
        "Started from",
        "Repository",
        "Status",
      ])
        expect(await page.getByLabel(label).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /^Filter/ }).isVisible()).toBe(false);
      const row = await page
        .getByTestId("task-row-t2")
        .evaluate((e) => getComputedStyle(e).display);
      expect(row).toBe("table-row");
      const table = await page.locator("table").evaluate((e) => ({
        display: getComputedStyle(e).display,
        min: getComputedStyle(e).minWidth,
      }));
      expect(table).toEqual({ display: "table", min: "760px" });
    } finally {
      await page.close();
    }
  },
  30000,
);
