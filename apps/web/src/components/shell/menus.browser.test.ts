import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let url: string;

// ヘッダーの実際のメニューと、タスク詳細の見出しと同じ重なりの見出し（sticky top-16 z-20。task-detail.tsx）を並べる。
// 見出しはメニューが開く場所に重なる高さにする。
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectMenu, NotificationsMenu, UserMenu } from '/apps/web/src/components/shell/menus.tsx';
const h = React.createElement;
const projects = [
  { id: 'p1', name: 'Payments', needsYou: 3 },
  { id: 'p2', name: 'Portal', needsYou: 2 },
  { id: 'p3', name: 'Billing', needsYou: 0 },
];
const notice = (n) => ({ taskId: 't' + n, title: 'Task ' + n, projectId: 'p1', projectName: 'Payments', status: 'Waiting', href: '/tasks/t' + n });
createRoot(document.getElementById('root')).render(
  h(React.Fragment, null,
    h('header', { className: 'sticky top-0 z-30 flex h-16 items-center justify-between bg-white px-4' },
      h(ProjectMenu, { projects, current: projects[0] }),
      h('div', { className: 'flex gap-2' },
        h(NotificationsMenu, { others: [notice(1), notice(2)], here: [notice(3), notice(4)], currentName: 'Payments' }),
        h(UserMenu, { language: 'system' }),
      ),
    ),
    h('main', { className: 'px-8' },
      h('div', { className: 'sticky top-16 z-20 h-96 bg-white', 'data-testid': 'task-heading' }, 'Task heading'),
      h('div', { className: 'h-[2000px]' }),
    ),
  ),
);
`;

// テストの部品で使う文言（Next のサーバー境界と同じく、i18n も置き換える）
const i18n = `
export function useMessages() {
  return {
    shell: {
      project: { label: 'Project', all: 'All projects', switch: 'Switch project', manage: 'Manage projects', needsYou: (n) => n + ' waiting', trigger: (n) => 'Project: ' + n },
      notices: { label: 'Notices', labelWithCount: (n) => 'Notices ' + n, title: 'Notices', total: (n) => n + ' items', none: 'None', others: 'Other projects', here: (n) => 'In ' + n },
      user: { label: 'Account', settings: 'Settings', theme: 'Theme', themes: { system: 'System', light: 'Light', dark: 'Dark' }, language: 'Language', languages: { system: 'System', ja: 'Japanese', en: 'English' }, languageNote: 'Note' },
    },
    labels: { action: { newTab: 'Opens in a new tab' } },
  };
}
`;

/** 部品とテストの画面で使う Tailwind のクラスだけの CSS を、実際の Tailwind で作る。 */
async function tailwindCss(): Promise<string> {
  const menus = readFileSync(new URL("./menus.tsx", import.meta.url), "utf8");
  const candidates = new Set(`${menus}\n${entry}`.match(/[^\s"'`{}()<>,;]+/g) ?? []);
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
        "@/app/actions": "virtual:menus-actions",
        "@/i18n/client": "virtual:menus-i18n",
        "next/link": "virtual:menus-next-link",
        "@": fileURLToPath(new URL("../..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@base-ui/react/menu",
        "lucide-react",
        "cn",
      ],
    },
    plugins: [
      {
        name: "menus-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "virtual:menus-actions",
              "virtual:menus-i18n",
              "virtual:menus-next-link",
              "/menus-test-entry",
            ].includes(id)
          )
            return `\0${id}`;
        },
        load(id) {
          if (id === "\0/menus-test-entry") return entry;
          if (id === "\0virtual:menus-actions")
            return "export async function setLanguageAction() {}";
          if (id === "\0virtual:menus-i18n") return i18n;
          if (id === "\0virtual:menus-next-link")
            return "import React from 'react'; export default function Link(props) { return React.createElement('a', props); }";
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<style>${css}</style><div id="root"></div><script type="module" src="/menus-test-entry"></script>`,
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

// Menu.Positioner は transform で位置を決めて重なりの文脈を作るので、z-index を中の Popup に付けると、メニュー全体が
// タスク詳細の sticky な見出しの下に隠れる（PBI-321）。見出しと重なる所で、いちばん上にあるのがメニューかを確かめる。
it.each([
  ["project", "Project: Payments"],
  ["notifications", "Notices 4"],
  ["account", "Account"],
])(
  "the %s menu is drawn above the sticky task heading",
  async (_name, label) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(url);
      await page.getByRole("button", { name: label }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      const heading = await page.getByTestId("task-heading").boundingBox();
      const box = await menu.boundingBox();
      if (!heading || !box) throw new Error("menu or heading is not visible");
      const top = Math.max(box.y, heading.y);
      const bottom = Math.min(box.y + box.height, heading.y + heading.height);
      // 重なる所が無ければ、この確かめ方は意味をなさない
      expect(bottom - top).toBeGreaterThan(40);
      const points = [top + 8, (top + bottom) / 2, bottom - 8].flatMap((y) => [
        [box.x + 16, y],
        [box.x + box.width - 16, y],
      ]);
      const onTop = await page.evaluate(
        (pts) =>
          pts.map(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[role="menu"]'))),
        points,
      );
      expect(onTop).toEqual(points.map(() => true));
    } finally {
      await page.close();
    }
  },
  30000,
);
