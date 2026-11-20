import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let url: string;

// 実際の Hint・SkipLink と、同じ並びで印だけ 20px の箱（変える前の大きさ）に置き換えた参照の行を並べる。
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Hint } from '/apps/web/src/components/ui/hint.tsx';
import { SkipLink, MAIN_ID } from '/apps/web/src/components/shell/skip-link.tsx';
const h = React.createElement;
const oldMark = h('span', { id: 'old-mark', className: 'inline-flex size-5 shrink-0 items-center justify-center rounded-full align-[-0.2em]' },
  h('span', { className: 'size-3.5' }));
createRoot(document.getElementById('root')).render(
  h(React.Fragment, null,
    h(SkipLink),
    h('header', null, h('a', { href: '/dashboard' }, 'Sacty')),
    h('main', { id: MAIN_ID, tabIndex: -1, className: 'outline-none' },
      h('button', { id: 'first-in-main', type: 'button' }, 'First'),
      h('p', { id: 'new-row', className: 'text-sm leading-6' }, 'Label ', h(Hint, { text: 'Body', label: 'Label' }), ' after'),
      h('p', { id: 'old-row', className: 'text-sm leading-6' }, 'Label ', oldMark, ' after'),
    ),
  ),
);
`;
const i18n = `
export function useMessages() {
  return { common: { hint: 'Details', hintOf: (l) => 'Details about ' + l, skipToMain: 'Skip to main content' } };
}
`;

async function tailwindCss(): Promise<string> {
  const files = ["./hint.tsx", "../shell/skip-link.tsx"].map((f) =>
    readFileSync(new URL(f, import.meta.url), "utf8"),
  );
  const candidates = new Set(`${files.join("\n")}\n${entry}`.match(/[^\s"'`{}()<>,;]+/g) ?? []);
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
        "@/i18n/client": "virtual:hint-i18n",
        "@": fileURLToPath(new URL("../..", import.meta.url)),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
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
        name: "hint-browser-fixture",
        enforce: "pre",
        resolveId(id) {
          if (["virtual:hint-i18n", "/hint-test-entry"].includes(id)) return `\0${id}`;
        },
        load(id) {
          if (id === "\0/hint-test-entry") return entry;
          if (id === "\0virtual:hint-i18n") return i18n;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<style>${css}</style><div id="root"></div><script type="module" src="/hint-test-entry"></script>`,
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

it("補足の印は 24×24px 以上で押せ、まわりの行の高さ・印の位置は 20px の印のときと同じ", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.goto(url);
    await page.waitForSelector('[data-slot="hint"]');
    const m = await page.evaluate(() => {
      const rect = (e: Element | null) => e?.getBoundingClientRect();
      const mark = rect(document.querySelector('[data-slot="hint"]'));
      const icon = rect(document.querySelector('[data-slot="hint"] svg'));
      const oldIcon = rect(document.querySelector("#old-mark span"));
      return {
        w: mark?.width,
        h: mark?.height,
        newRow: rect(document.getElementById("new-row"))?.height,
        oldRow: rect(document.getElementById("old-row"))?.height,
        iconDx:
          (icon?.left ?? 0) -
          (document.getElementById("new-row")?.getBoundingClientRect().left ?? 0),
        oldDx:
          (oldIcon?.left ?? 0) -
          (document.getElementById("old-row")?.getBoundingClientRect().left ?? 0),
        iconTop:
          (icon?.top ?? 0) - (document.getElementById("new-row")?.getBoundingClientRect().top ?? 0),
        oldTop:
          (oldIcon?.top ?? 0) -
          (document.getElementById("old-row")?.getBoundingClientRect().top ?? 0),
        iconSize: icon?.width,
      };
    });
    expect(m.w).toBeGreaterThanOrEqual(24);
    expect(m.h).toBeGreaterThanOrEqual(24);
    expect(m.iconSize).toBe(14);
    expect(m.newRow).toBe(m.oldRow);
    expect(m.iconDx).toBeCloseTo(m.oldDx, 1);
    expect(m.iconTop).toBeCloseTo(m.oldTop, 1);
  } finally {
    await page.close();
  }
});

it("最初の Tab で「本文へ移動」が見え、Enter で本文にフォーカスが移り、次の Tab は本文の最初の操作に止まる", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.goto(url);
    await page.waitForSelector("header");
    const hidden = await page.evaluate(() => {
      const r = document.querySelector("a")?.getBoundingClientRect();
      return (r?.width ?? 0) <= 1 && (r?.height ?? 0) <= 1;
    });
    expect(hidden).toBe(true);
    await page.keyboard.press("Tab");
    const shown = await page.evaluate(() => {
      const a = document.activeElement;
      const r = a?.getBoundingClientRect();
      return { text: a?.textContent, w: r?.width ?? 0, h: r?.height ?? 0 };
    });
    expect(shown.text).toBe("Skip to main content");
    expect(shown.w).toBeGreaterThan(40);
    expect(shown.h).toBeGreaterThan(16);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main-content");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("first-in-main");
  } finally {
    await page.close();
  }
});
