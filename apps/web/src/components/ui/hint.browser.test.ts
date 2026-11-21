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
      h('p', { id: 'small-row', className: 'text-sm leading-6' }, 'Small ', h(Hint, { text: 'Body', label: 'Small', className: 'size-4' }), ' after'),
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
        "react/jsx-dev-runtime",
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
  // 依存の最適化のし直しでページが読み直されるのを、各テストの上限（30 秒）の中で待たないよう、ここで 1 度開いて済ませる。
  // goto と waitFor の上限は、それぞれ 60 秒にする（goto の既定は 30 秒で、初回の準備がそれを超えると落ちるため）。順に待つので、事前の読み込みは最大 120 秒かかる。
  // beforeAll の上限（180 秒）は、サーバーとブラウザーの起動に、この最大 120 秒を足しても収まる値にしている。
  const warm = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  try {
    await warm.goto(url, { timeout: 60000 });
    await warm.locator('[data-slot="hint"]').first().waitFor({ timeout: 60000 });
  } finally {
    await warm.close();
  }
}, 180000);

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
    // 押せる範囲：印（className で size-4 にしたものも）の擬似要素が、印の中心に 24×24px で広がる
    const hits = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="hint"]')].map((el) => {
        const r = el.getBoundingClientRect();
        const a = getComputedStyle(el, "::after");
        return { box: r.width, w: a.width, h: a.height, pos: a.position };
      }),
    );
    expect(hits.map((x) => x.box)).toEqual([20, 16]);
    for (const x of hits) expect([x.w, x.h, x.pos]).toEqual(["24px", "24px", "absolute"]);
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
