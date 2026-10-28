// ユーザードキュメントのスクリーンショット（docs/user/images/*.png）を撮り直す。
//   npm run build
//   npm install --no-save playwright   # 撮るときだけ使う（依存には入れない）
//   npx playwright install chromium     # Playwright のブラウザーが無ければ入れる
//   node scripts/docs-screenshots/capture.mjs [ja|en]...
// 架空のデータ（seed.mjs）を入れた一時の SACTY_HOME で sacty up を起動し、Playwright で画面を撮る。
// 実際の AI・GitHub・Docker・キーチェーンは使わない（docker・gh・security は、決まった答えを返す代わりのスクリプト）。
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHOTS } from "./shots.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.env.SHOTS_OUT ?? join(ROOT, "docs", "user", "images");
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ["ja", "en"];
const WEB_PORT = 4790;
const DAEMON_PORT = 4791;

const SHIMS = {
  // Docker を使える状態に見せる（画面の上の注意を出さない）。タスクは実行しない
  docker: `#!/bin/sh
case "$1" in
  version) echo 27.0.0 ;;
  image) echo sha256:0000000000000000000000000000000000000000000000000000000000000000 ;;
esac
exit 0
`,
  // gh にログイン済みのアカウントがあるように見せる。GitHub には問い合わせない
  gh: `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then
  echo '{"hosts":{"github.com":[{"login":"acme-dev","active":true,"state":"success"}]}}'
  exit 0
fi
if [ "$1" = auth ] && [ "$2" = token ]; then echo gho_example; exit 0; fi
echo "gh is not available while taking screenshots" >&2
exit 1
`,
  // キーチェーンの秘密情報があるように見せる（値は架空）
  security: `#!/bin/sh
echo example-secret
exit 0
`,
};

const CONFIG = `providers:
  codex:
    auth:
      mode: api-key
      secret: openai-api-key
    available_models:
      gpt-6-luna: { input: 0.25, cached_input: 0.025, output: 2 }
      gpt-6.1-sol: { input: 1.25, cached_input: 0.125, output: 10 }
images:
  java17:
    description: Java 17・Maven・Gradle
    base_image: registry.example.com/ci/java:17
  playwright:
    description: Node.js・Playwright（ブラウザーのテスト）
    base_image: registry.example.com/ci/playwright:1
web:
  auth: false
budget:
  default_per_task_usd: 5
  default_per_audit_usd: 1
`;

async function waitFor(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function capture(lang, chromium) {
  const work = mkdtempSync(join(tmpdir(), "sacty-shots-"));
  // 途中で失敗しても（ブラウザーを起動できないなど）、sacty up を止めて一時のディレクトリを消す
  let up;
  let browser;
  try {
    const home = join(work, "home");
    const bin = join(work, "bin");
    // コンテキストリポジトリを ~/sacty-context に置くので、ホームのディレクトリも一時のものにする
    const userHome = join(work, "user");
    mkdirSync(bin, { recursive: true });
    mkdirSync(userHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: userHome,
      SACTY_HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    };
    for (const [name, body] of Object.entries(SHIMS)) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    const seeded = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/docs-screenshots/seed.mjs"), home, lang],
      {
        stdio: "inherit",
        env,
      },
    );
    if (seeded.status !== 0) throw new Error("seed failed");
    writeFileSync(join(home, "config.yaml"), CONFIG);

    up = spawn(
      process.execPath,
      [
        join(ROOT, "packages/cli/dist/index.js"),
        "up",
        "--port",
        String(WEB_PORT),
        "--daemon-port",
        String(DAEMON_PORT),
      ],
      {
        // 監査の画面は、監査のモックのデータで撮る
        env: { ...env, SACTY_AUDIT_MOCK: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    up.stdout.on("data", (d) => process.stdout.write(`[sacty] ${d}`));
    up.stderr.on("data", (d) => process.stderr.write(`[sacty] ${d}`));
    const base = `http://127.0.0.1:${WEB_PORT}`;
    // 日付の入力欄などの書式は、ブラウザーの言語で決まる
    browser = await chromium.launch({ args: [`--lang=${lang === "en" ? "en-US" : "ja-JP"}`] });
    await waitFor(`${base}/dashboard`);
    const context = await browser.newContext({
      locale: lang === "en" ? "en-US" : "ja-JP",
      colorScheme: "light",
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 1.5,
    });
    await context.addCookies([{ name: "sacty-lang", value: lang, url: base }]);
    const page = await context.newPage();
    for (const shot of SHOTS) {
      await page.goto(`${base}${shot.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      if (shot.prepare) await shot.prepare(page, lang);
      const file = join(OUT, `${shot.name}${lang === "en" ? ".en" : ""}.png`);
      if (shot.selector) {
        const box = await page.locator(shot.selector).first().boundingBox();
        if (!box) throw new Error(`${shot.name}: ${shot.selector} is not visible`);
        const pad = 12;
        await page.screenshot({
          path: file,
          fullPage: true,
          clip: {
            x: Math.max(0, box.x - pad),
            y: Math.max(0, box.y - pad),
            width: box.width + pad * 2,
            height: Math.min(box.height, shot.maxHeight ?? box.height) + pad * 2,
          },
        });
      } else {
        await page.screenshot({
          path: file,
          fullPage: true,
          clip: { x: 0, y: 0, width: 1280, height: shot.height },
        });
      }
      console.log(`wrote ${file}`);
    }
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      console.warn(`failed to close the browser: ${error}`);
    }
    if (up?.pid) {
      try {
        process.kill(-up.pid, "SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    rmSync(work, { recursive: true, force: true });
  }
}

const { chromium } = await import("playwright");
mkdirSync(OUT, { recursive: true });
for (const lang of langs) await capture(lang, chromium);
