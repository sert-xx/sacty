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
// 本文（main）の実際のクラスは layout.tsx から取る（余白の確かめが、実際の画面と食い違わないように）
const mainClass = /<main[^>]*?className="([^"]+)"/.exec(read("../../app/layout.tsx"))?.[1] ?? "";

const htmlClass = /<html[^>]*?className="([^"]+)"/.exec(read("../../app/layout.tsx"))?.[1] ?? "";

// 実際のサイドメニューと質問のパネルの丸いボタンを、ヘッダー（sticky h-16）・長い本文と同じ並びで置く
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RailNav } from '/apps/web/src/components/shell/rail.tsx';
import { ChatPanel } from '/apps/web/src/components/chat-panel.tsx';
const h = React.createElement;
const params = new URLSearchParams(location.search);
const path = params.get('path') ?? '/projects/p1/tasks';
document.documentElement.className = ${JSON.stringify(htmlClass)};
createRoot(document.getElementById('root')).render(
  h('div', { className: 'flex min-h-screen flex-col' },
    h('header', { className: 'sticky top-0 z-30 h-16 bg-white' }, 'Header'),
    h('div', { className: 'flex flex-1' },
      h(RailNav, params.get('fallback') ? {} : { pathname: path }),
      h('main', { className: ${JSON.stringify(mainClass)}, 'data-testid': 'main' },
        h('div', { className: 'h-[1500px]' }, 'Body'),
        h('p', { 'data-testid': 'last' }, 'Last line'),
        h(ChatPanel, { pending: false, count: 0, form: h('div', null, 'form') }, h('div', null, 'chat')),
      ),
    ),
  ),
);
`;

const i18n = `
export function useMessages() {
  return {
    shell: { nav: { main: 'Main', tasks: 'Tasks', schedules: 'Schedules', audit: 'Audit', settings: 'Settings' } },
    common: { help: 'Help' },
    task: { chat: { open: 'Open chat', openPending: 'Open chat (pending)', close: 'Close', title: 'Chat', note: 'Note', hint: 'Hint' } },
  };
}
`;

async function tailwindCss(): Promise<string> {
  const sources = ["./rail.tsx", "../chat-panel.tsx", "../ui/button.tsx", "../../app/layout.tsx"]
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
        "@/i18n/client": "virtual:rail-i18n",
        "next/link": "virtual:rail-next-link",
        "next/navigation": "virtual:rail-next-nav",
        "@": fileURLToPath(new URL("../..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@base-ui/react/dialog",
        "@base-ui/react/popover",
        "lucide-react",
        "cn",
      ],
    },
    plugins: [
      {
        name: "rail-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:rail-i18n",
              "virtual:rail-next-link",
              "virtual:rail-next-nav",
              "/rail-test-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/rail-test-entry") return entry;
          if (id === "\0virtual:rail-i18n") return i18n;
          if (id === "\0virtual:rail-next-nav") return "export const usePathname = () => '/';";
          if (id === "\0virtual:rail-next-link")
            return "import React from 'react'; export default function Link(props) { return React.createElement('a', props); }";
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<style>${css}</style><div id="root"></div><script type="module" src="/rail-test-entry"></script>`,
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

async function open(width: number, path = "/projects/p1/tasks", fallback = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.goto(`${url}/?path=${encodeURIComponent(path)}${fallback ? "&fallback=1" : ""}`);
  await page.getByRole("navigation", { name: "Main" }).waitFor();
  return page;
}

const box = async (locator: ReturnType<Page["locator"]>) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
};

it("at 375px the menu is a fixed bar at the bottom and the body uses the full width", async () => {
  const page = await open(375);
  try {
    const nav = page.getByRole("navigation", { name: "Main" });
    const n = await box(nav);
    expect(n.x).toBe(0);
    expect(n.width).toBe(375);
    expect(n.y + n.height).toBe(700);
    // スクロールしても画面の下に固定されたまま
    await page.evaluate(() => window.scrollTo(0, 500));
    expect((await box(nav)).y + n.height).toBe(700);
    const main = await box(page.getByTestId("main"));
    expect(main.x).toBe(0);
    expect(main.width).toBe(375);
  } finally {
    await page.close();
  }
}, 30000);

it("at 375px the items keep their order, names and destinations, in one row", async () => {
  const page = await open(375, "/projects/p1/audit");
  try {
    const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
    expect(await links.allTextContents()).toEqual(["Tasks", "Schedules", "Audit", "Settings"]);
    expect(await links.evaluateAll((els) => els.map((e) => e.getAttribute("href")))).toEqual([
      "/projects/current/tasks",
      "/projects/current/schedules",
      "/projects/current/audit",
      "/projects/current",
    ]);
    expect(
      await links.evaluateAll((els) => els.map((e) => e.getAttribute("aria-current"))),
    ).toEqual([null, null, "page", null]);
    const ys = await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
    expect(new Set(ys).size).toBe(1);
  } finally {
    await page.close();
  }
}, 30000);

it("at 375px the all-projects screens show only one item, Settings", async () => {
  const page = await open(375, "/");
  try {
    const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
    expect(await links.allTextContents()).toEqual(["Settings"]);
    expect(await links.first().getAttribute("href")).toBe("/projects");
  } finally {
    await page.close();
  }
}, 30000);

it("at 375px every item is at least 44px wide and tall", async () => {
  for (const path of ["/projects/p1/tasks", "/"]) {
    const page = await open(375, path);
    try {
      const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
      for (let i = 0; i < (await links.count()); i++) {
        const b = await box(links.nth(i));
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await page.close();
    }
  }
}, 30000);

it("at 375px the chat button sits above the menu without overlapping it", async () => {
  const page = await open(375);
  try {
    const nav = await box(page.getByRole("navigation", { name: "Main" }));
    const button = await box(page.getByRole("button", { name: "Open chat" }));
    expect(button.y + button.height).toBeLessThanOrEqual(nav.y);
    expect(button.x + button.width).toBe(375 - 16);
    // 開いたパネルは、メニューの上に全幅で重なる
    await page.getByRole("button", { name: "Open chat" }).click();
    const panel = page.getByRole("dialog");
    await panel.waitFor();
    const p = await box(panel);
    expect(p).toMatchObject({ x: 0, y: 0, width: 375, height: 700 });
    const top = await page.evaluate(() =>
      document.elementFromPoint(187, 690)?.closest("nav") ? "nav" : "panel",
    );
    expect(top).toBe("panel");
  } finally {
    await page.close();
  }
}, 30000);

it("at 375px the end of the body is not hidden by the menu, and the bar reserves the home-bar inset", async () => {
  const page = await open(375);
  try {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const nav = await box(page.getByRole("navigation", { name: "Main" }));
    const last = await box(page.getByTestId("last"));
    expect(last.y + last.height).toBeLessThanOrEqual(nav.y);
    // ホームバー・切り欠きの余白は、この環境では 0 になるので、env() で決まることを CSS で確かめる
    const rules = await page.evaluate(() =>
      [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\n"),
    );
    expect(rules).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom\)/);
    expect(rules).toMatch(/height:\s*calc\(3\.5rem \+ env\(safe-area-inset-bottom\)\)/);
    expect(rules).toMatch(/padding-left:\s*max\(0\.25rem, env\(safe-area-inset-left\)\)/);
    expect(rules).toMatch(/padding-right:\s*max\(1rem, env\(safe-area-inset-right\)\)/);
    expect(rules).toMatch(/padding-bottom:\s*calc\(5\.5rem \+ env\(safe-area-inset-bottom\)\)/);
    expect(rules).toMatch(/bottom:\s*calc\(4\.5rem \+ env\(safe-area-inset-bottom\)\)/);
  } finally {
    await page.close();
  }
}, 30000);

it("at 375px assistive technology sees a single main navigation", async () => {
  const page = await open(375);
  try {
    const navs = page.getByRole("navigation");
    expect(await navs.count()).toBe(1);
    expect(await navs.first().getAttribute("aria-label")).toBe("Main");
  } finally {
    await page.close();
  }
}, 30000);

it("at 1280px the menu stays a left column of 88px and the chat button stays 24px from the corner", async () => {
  const page = await open(1280);
  try {
    const nav = page.getByRole("navigation", { name: "Main" });
    const n = await box(nav);
    expect(n).toMatchObject({ x: 0, y: 64, width: 88, height: 700 - 64 });
    expect(await nav.evaluate((e) => getComputedStyle(e).position)).toBe("sticky");
    expect(await page.getByRole("navigation").count()).toBe(1);
    const links = nav.getByRole("link");
    const first = await box(links.first());
    const second = await box(links.nth(1));
    expect(second.y).toBeGreaterThan(first.y);
    const main = await box(page.getByTestId("main"));
    expect(main.x).toBe(88);
    const button = await box(page.getByRole("button", { name: "Open chat" }));
    expect(1280 - (button.x + button.width)).toBe(24);
    expect(700 - (button.y + button.height)).toBe(24);
  } finally {
    await page.close();
  }
}, 30000);

it("at 375px focusing an element near the bottom scrolls it above the menu", async () => {
  const page = await open(375);
  try {
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.textContent = "Near bottom";
      b.style.cssText = "position:absolute;top:1480px;left:16px";
      document.querySelector("[data-testid=main]")?.appendChild(b);
      (document.querySelector("[data-testid=main]") as HTMLElement).style.position = "relative";
      window.scrollTo(0, 0);
      b.scrollIntoView({ block: "nearest" });
    });
    await page.waitForTimeout(100);
    const nav = await box(page.getByRole("navigation", { name: "Main" }));
    const target = await box(page.getByRole("button", { name: "Near bottom" }));
    expect(target.y + target.height).toBeLessThanOrEqual(nav.y);
  } finally {
    await page.close();
  }
}, 30000);

it("the menu switches between the bottom bar and the left column exactly at 640px", async () => {
  for (const [width, bottom] of [
    [639, true],
    [640, false],
  ] as const) {
    const page = await open(width);
    try {
      const n = await box(page.getByRole("navigation", { name: "Main" }));
      if (bottom) expect(n).toMatchObject({ x: 0, width, y: 700 - n.height });
      else expect(n).toMatchObject({ x: 0, y: 64, width: 88 });
    } finally {
      await page.close();
    }
  }
}, 30000);

it("at 375px the loading fallback (no pathname) is also a bottom bar with no item highlighted", async () => {
  const page = await open(375, "/projects/p1/tasks", true);
  try {
    const nav = page.getByRole("navigation", { name: "Main" });
    const n = await box(nav);
    expect(n.width).toBe(375);
    expect(n.y + n.height).toBe(700);
    expect(await nav.locator("[aria-current]").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30000);

it("at 852px (landscape phone) the layout matches the left-column layout", async () => {
  const page = await open(852);
  try {
    const n = await box(page.getByRole("navigation", { name: "Main" }));
    expect(n).toMatchObject({ x: 0, y: 64, width: 88 });
    expect((await box(page.getByTestId("main"))).x).toBe(88);
    const button = await box(page.getByRole("button", { name: "Open chat" }));
    expect(852 - (button.x + button.width)).toBe(24);
    expect(700 - (button.y + button.height)).toBe(24);
  } finally {
    await page.close();
  }
}, 30000);
