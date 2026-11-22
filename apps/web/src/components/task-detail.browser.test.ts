import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ActivityEvent, project, type Task } from "@sacty/core";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { messagesFor } from "@/i18n";

let server: ViteDevServer;
let browser: Browser;
let url: string;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const mainClass = /<main[^>]*?className="([^"]+)"/.exec(read("../app/layout.tsx"))?.[1] ?? "";
const htmlClass = /<html[^>]*?className="([^"]+)"/.exec(read("../app/layout.tsx"))?.[1] ?? "";

const LONG_TITLE =
  "Make the payment timeout configurable per merchant and show the remaining time in the checkout screen so that buyers know when to retry";
const LONG_CODE = `const value = "${"x".repeat(400)}";`;

/** 長い題・PR・成果物（長いコードブロック）・操作のボタン・エラーの記録を持つ、作業中のタスクの詳細のデータ。 */
function fixture() {
  const created = {
    id: "event-1",
    seq: 1,
    taskId: "task-1",
    projectId: "default",
    actor: "person",
    at: "2026-10-16T00:00:00.000Z",
    type: "TaskCreated",
    payload: {
      title: LONG_TITLE,
      body: `Please do it.\n\n\`\`\`\n${LONG_CODE}\n\`\`\``,
      start: "sacty",
      budgetCapUsd: 5,
    },
  } as ActivityEvent;
  const failed = {
    id: "event-2",
    seq: 2,
    taskId: "task-1",
    projectId: "default",
    actor: "sacty",
    at: "2026-10-16T00:10:00.000Z",
    type: "TestsRun",
    payload: {
      passed: false,
      command: "npm test",
      exitCode: 1,
      unmappedViewpoints: [],
      output: LONG_CODE,
      durationMs: 1000,
    },
  } as unknown as ActivityEvent;
  const task = project([created]).get("task-1") as Task;
  task.status = "running";
  task.steps = [
    { key: "requirements", state: "done" },
    { key: "design", state: "done" },
    { key: "implement", state: "active" },
    { key: "review", state: "todo" },
  ];
  task.approved.requirements = {
    output: `# Requirements\n\n\`\`\`\n${LONG_CODE}\n\`\`\`\n`,
    testViewpoints: [],
    submission: 1,
    at: "2026-10-16T00:00:00.000Z",
  };
  task.pullRequest = {
    url: "https://github.com/acme/payments-api/pull/128",
    number: 128,
    repo: "acme/payments-api",
    branch: "sacty/task-1",
    commit: "9e1d0c4b2a7f",
  } as Task["pullRequest"];
  task.budget = { ...task.budget, usedUsd: 1.5, capUsd: 5, unknownRuns: 1 };
  return {
    task,
    activity: [created, failed],
    projectName: "Payments",
    children: [],
  };
}

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '/apps/web/src/i18n/client.tsx';
import { TaskDetailView } from '/apps/web/src/components/task-detail.tsx';
const h = React.createElement;
const params = new URLSearchParams(location.search);
document.documentElement.className = ${JSON.stringify(htmlClass)};
createRoot(document.getElementById('root')).render(
  h(I18nProvider, { locale: params.get('lang') ?? 'en' },
    h('div', { className: 'flex min-h-screen flex-col' },
      h('header', { className: 'sticky top-0 z-30 h-16 bg-white', 'data-testid': 'header' }, 'Header'),
      h('main', { className: ${JSON.stringify(mainClass)} },
        h(TaskDetailView, { data: window.__data }),
        h("div", { style: { height: 3000 } }),
      ),
    ),
  ),
);
`;

/** 部品の Tailwind のクラスだけの CSS を、アプリの CSS（色などの設定つき）と実際の Tailwind で作る。 */
async function tailwindCss(): Promise<string> {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = [
    ...readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `${dir}/${f}`),
    fileURLToPath(new URL("../app/layout.tsx", import.meta.url)),
  ];
  const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const candidates = new Set(`${source}\n${entry}`.match(/[^\s"'`{}<>;]+/g) ?? []);
  const base = fileURLToPath(new URL("../app", import.meta.url));
  const compiler = await compile(read("../app/globals.css"), {
    base,
    onDependency: () => {},
  });
  return compiler.build([...candidates]);
}

beforeAll(async () => {
  const css = await tailwindCss();
  const actions = [
    ...read("../app/actions.ts").matchAll(/^export (?:async )?(?:function|const) (\w+)/gm),
  ]
    .map((m) => `export async function ${m[1]}() { return {}; }`)
    .join("\n");
  const data = JSON.stringify(fixture());
  server = await createServer({
    configFile: false,
    envDir: false,
    server: { host: "127.0.0.1", port: 0 },
    resolve: {
      alias: {
        "@/app/actions": "virtual:detail-actions",
        "next/link": "virtual:detail-next-link",
        "next/navigation": "virtual:detail-next-navigation",
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
        "@base-ui/react/popover",
        "@base-ui/react/dialog",
        "@base-ui/react/input",
        "lucide-react",
        "cn",
        "class-variance-authority",
        "zod",
      ],
    },
    plugins: [
      {
        name: "task-detail-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:detail-actions",
              "virtual:detail-next-link",
              "virtual:detail-next-navigation",
              "/detail-test-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/detail-test-entry") return entry;
          if (id === "\0virtual:detail-actions") return actions;
          if (id === "\0virtual:detail-next-navigation")
            return "export const useRouter = () => ({ refresh() {}, push() {}, replace() {} }); export const useSearchParams = () => new URLSearchParams(window.location.search); export const usePathname = () => '/'; export const redirect = () => {}; export const unstable_rethrow = () => {}; export const useParams = () => ({}); export const notFound = () => {};";
          if (id === "\0virtual:detail-next-link")
            return "import React from 'react'; export default function Link(props) { return React.createElement('a', props); }";
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/?") && req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script>window.__data = ${data.replace(/</g, "\\u003c")};</script><script type="module" src="/detail-test-entry"></script>`,
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
  // 依存の最適化のし直しでページが読み直されるのを、各テストの上限の中で待たないよう、ここで 1 度開いて済ませる
  const warm = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  try {
    await warm.goto(`${url}/?lang=en`, { timeout: 60000 });
    await warm.getByTestId("task-sticky-bar").waitFor({ timeout: 60000 });
  } finally {
    await warm.close();
  }
}, 180000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(width: number, height = 800, query = "lang=en"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(5000);
  await page.goto(`${url}/?${query}`);
  await page.getByTestId("task-sticky-bar").waitFor();
  return page;
}

const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    });

const scrollBy = async (page: Page, y: number) => {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await page.waitForFunction((to) => Math.abs(window.scrollY - to) < 2, y);
};

const root = (page: Page) =>
  page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));

it("the page does not scroll sideways at 375px in any tab (TV-2)", async () => {
  const page = await open(375);
  try {
    for (const name of ["Overview", "Activity", "Cost", "Step settings"]) {
      await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
      expect(await root(page), name).toEqual({ scroll: 375, client: 375 });
    }
  } finally {
    await page.close();
  }
}, 30000);

it("only the shortened title and the tabs stay on screen under 640px (TV-7)", async () => {
  const page = await open(375, 800);
  try {
    await scrollBy(page, 1500);
    const sticky = await page.evaluate(() => {
      const found: { testid: string | null; top: number; bottom: number }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const position = getComputedStyle(el).position;
        if (position !== "sticky" && position !== "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.bottom <= 0 || r.top > 200) continue;
        found.push({ testid: el.getAttribute("data-testid"), top: r.top, bottom: r.bottom });
      }
      return found;
    });
    expect(sticky.map((s) => s.testid).sort()).toEqual(["header", "task-sticky-bar"]);
    const bar = sticky.find((s) => s.testid === "task-sticky-bar");
    const header = sticky.find((s) => s.testid === "header");
    if (!bar || !header) throw new Error("missing");
    // ヘッダー + 帯が 160px 以下で、帯はヘッダーのすぐ下
    expect(bar.bottom).toBeLessThanOrEqual(160);
    expect(bar.top).toBeCloseTo(header.bottom, 0);
    const title = page.getByTestId("task-sticky-title");
    expect(await title.isVisible()).toBe(true);
    const lines = await title.evaluate((el) => ({
      overflowing: el.scrollWidth > el.clientWidth,
      height: el.getBoundingClientRect().height,
      line: Number.parseFloat(getComputedStyle(el).lineHeight),
      hidden: el.getAttribute("aria-hidden"),
    }));
    expect(lines.overflowing).toBe(true);
    expect(lines.height).toBeLessThan(lines.line * 1.5 + 16);
    expect(lines.hidden).toBe("true");
    const tabs = await rect(page, '[role="tablist"]');
    expect(tabs.top).toBeGreaterThanOrEqual(bar.top);
    expect(tabs.bottom).toBeLessThanOrEqual(bar.bottom + 1);
  } finally {
    await page.close();
  }
}, 30000);

it("status, steps and controls are at the top of the page and scroll away under 640px (TV-8)", async () => {
  const page = await open(375, 800);
  try {
    const targets = {
      h1: page.getByRole("heading", { level: 1 }),
      edit: page.getByTestId("task-title-edit"),
      pause: page.getByRole("button", { name: /Pause/ }),
      cancel: page.getByRole("button", { name: /Cancel|Stop/ }),
      head: page.getByTestId("task-sticky-bar").locator("xpath=preceding-sibling::div[1]"),
      steps: page.getByRole("list", { name: /Steps/i }).first(),
    };
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    const tops = async () => {
      const out: Record<string, { top: number; bottom: number }> = {};
      for (const [key, locator] of Object.entries(targets)) {
        const box = await locator.first().boundingBox();
        if (!box) throw new Error(`${key} not visible`);
        const scrolled = await page.evaluate(() => window.scrollY);
        out[key] = { top: box.y, bottom: box.y + box.height };
        void scrolled;
      }
      return out;
    };
    const before = await tops();
    for (const [key, box] of Object.entries(before)) {
      expect(box.top, key).toBeGreaterThanOrEqual(64);
      expect(box.bottom, key).toBeLessThanOrEqual(800);
    }
    await scrollBy(page, 1500);
    for (const [key, locator] of Object.entries(targets)) {
      const box = await locator.first().boundingBox();
      if (!box) throw new Error(`${key} not visible`);
      expect(box.y + box.height, key).toBeLessThan(0 + 64);
    }
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30000);

it("the jump target keeps clear of the box that is fixed at that width and re-measures when the width changes (TV-9)", async () => {
  const measure = async (page: Page) =>
    page.evaluate(() => {
      const offset = Number.parseFloat(
        document.documentElement.style.getPropertyValue("--sticky-offset"),
      );
      const bar = document.querySelector<HTMLElement>('[data-testid="task-sticky-bar"]');
      const outer = bar?.parentElement;
      return { offset, bar: bar?.offsetHeight ?? 0, outer: outer?.offsetHeight ?? 0 };
    });
  const jump = async (page: Page) => {
    await page.evaluate(() => {
      window.location.hash = "";
      window.location.hash = "#error-report";
    });
    await page.waitForFunction(() => window.scrollY > 0);
    await page.waitForTimeout(100);
  };
  const narrow = await open(375, 800);
  try {
    await jump(narrow);
    const m = await measure(narrow);
    expect(m.offset).toBe(64 + m.bar + 16);
    const bar = await rect(narrow, '[data-testid="task-sticky-bar"]');
    const target = await rect(narrow, "#error-report");
    expect(target.top).toBeGreaterThanOrEqual(bar.bottom);
    // 幅を広げると、外側の箱の高さで測り直す
    await narrow.setViewportSize({ width: 1280, height: 800 });
    await narrow.waitForFunction(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="task-sticky-bar"]');
      const outer = bar?.parentElement;
      const offset = Number.parseFloat(
        document.documentElement.style.getPropertyValue("--sticky-offset"),
      );
      return !!outer && offset === 64 + outer.offsetHeight + 16;
    });
    await jump(narrow);
    const wide = await measure(narrow);
    expect(wide.outer).toBeGreaterThan(wide.bar);
    expect(wide.offset).toBe(64 + wide.outer + 16);
    const outerBox = await rect(narrow, '[data-testid="task-sticky-bar"] >> xpath=..');
    const wideTarget = await rect(narrow, "#error-report");
    expect(wideTarget.top).toBeGreaterThanOrEqual(outerBox.bottom);
  } finally {
    await narrow.close();
  }
  const direct = await open(1280, 800);
  try {
    await jump(direct);
    const m = await measure(direct);
    expect(m.offset).toBe(64 + m.outer + 16);
    const outerBox = await rect(direct, '[data-testid="task-sticky-bar"] >> xpath=..');
    const target = await rect(direct, "#error-report");
    expect(target.top).toBeGreaterThanOrEqual(outerBox.bottom);
  } finally {
    await direct.close();
  }
}, 30000);

it.each([375, 640, 1023])(
  "the PR and the cost come before the content in the overview, and the properties rows are hidden at %ipx (TV-10)",
  async (width) => {
    const page = await open(width);
    try {
      const box = page.getByTestId("overview-pr-cost");
      expect(await box.isVisible()).toBe(true);
      const link = box.getByRole("link", { name: "#128" });
      expect(await link.getAttribute("href")).toBe("https://github.com/acme/payments-api/pull/128");
      const text = (await box.textContent()) ?? "";
      expect(text).toContain("$1.50");
      expect(text).toContain("$5.00");
      // 棒と、未計上の注記
      expect(await box.locator("[aria-hidden='true']").count()).toBe(1);
      expect(text).toContain(messagesFor("en").task.layout.costUnknown(1));
      const boxRect = await rect(page, '[data-testid="overview-pr-cost"]');
      const content = await rect(page, "#content");
      expect(boxRect.bottom).toBeLessThanOrEqual(content.top);
      expect(await page.getByTestId("properties-pull-request").isVisible()).toBe(false);
      expect(await page.getByTestId("properties-cost").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  },
  30000,
);

it("at 1024px the PR and the cost show only in the properties (TV-11)", async () => {
  const page = await open(1024);
  try {
    expect(await page.getByTestId("overview-pr-cost").isVisible()).toBe(false);
    const pr = page.getByTestId("properties-pull-request");
    const cost = page.getByTestId("properties-cost");
    expect(await pr.isVisible()).toBe(true);
    expect(await cost.isVisible()).toBe(true);
    expect(await pr.getByRole("link", { name: "#128" }).isVisible()).toBe(true);
    expect(await cost.textContent()).toContain("$1.50");
  } finally {
    await page.close();
  }
}, 30000);

it.each([640, 1023, 1280])(
  "the fixed box holds the title, status, steps, controls and tabs, and stays at the top at %ipx (TV-12)",
  async (width) => {
    const page = await open(width, 800);
    try {
      const bar = page.getByTestId("task-sticky-bar");
      const outer = bar.locator("xpath=..");
      const style = await outer.evaluate((el) => ({
        position: getComputedStyle(el).position,
        display: getComputedStyle(el).display,
        top: getComputedStyle(el).top,
        h1: !!el.querySelector("h1"),
        tablist: !!el.querySelector('[role="tablist"]'),
        pause: [...el.querySelectorAll("button")].some((b) => /Pause/.test(b.textContent ?? "")),
        steps: !!el.querySelector("ul[aria-label]"),
      }));
      expect(style).toEqual({
        position: "sticky",
        display: "flex",
        top: "64px",
        h1: true,
        tablist: true,
        pause: true,
        steps: true,
      });
      // 省略の題は出さない
      expect(await page.getByTestId("task-sticky-title").isVisible()).toBe(false);
      expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("static");
      await scrollBy(page, 1500);
      const box = await rect(page, '[data-testid="task-sticky-bar"] >> xpath=..');
      expect(box.top).toBeCloseTo(64, 0);
      // プロパティは、PR と費用の行のほかが見える
      expect(await page.locator("#properties").isVisible()).toBe(true);
      expect(
        await page
          .locator('section[aria-labelledby="properties"]')
          .getByText("Payments")
          .isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  },
  30000,
);
