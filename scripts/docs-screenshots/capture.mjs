// ユーザードキュメントのスクリーンショット（docs/user/images/*.png）を撮り直す。
//   npm run build
//   npm install --no-save playwright   # 撮るときだけ使う（依存には入れない）
//   npx playwright install chromium     # Playwright のブラウザーが無ければ入れる
//   node scripts/docs-screenshots/capture.mjs [ja|en]... [docs|intro]...
// 架空のデータを入れた一時の SACTY_HOME で sacty up を起動し、Playwright で画面を撮る。
// 実際の AI・GitHub・Docker・キーチェーンは使わない（docker・gh・security は、決まった答えを返す代わりのスクリプト）。
// データは場面（シナリオ）ごとに分ける。言語も場面も、書かなければすべてを撮る。
//   docs ：設定・操作・トラブルの説明の画面（seed.mjs。止まったタスクを含む。監査の画面は監査のモックのデータ）
//   intro：紹介のページの画面（seed-intro.mjs。ふだんの使い方が伝わる状態だけ。監査の画面は作業履歴の監査の記録）
// 画面には日時が写るので、撮り直すと画像が変わる。直したい場面だけを撮る（例 node scripts/docs-screenshots/capture.mjs intro）。
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHOTS } from "./shots.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.env.SHOTS_OUT ?? join(ROOT, "docs", "user", "images");
/** 場面ごとの、データを入れるスクリプトと、sacty up に足す環境変数。 */
const SCENARIOS = {
  // 監査の画面は、監査のモックのデータで撮る
  docs: { seed: "seed.mjs", env: { SACTY_AUDIT_MOCK: "1" } },
  intro: { seed: "seed-intro.mjs", env: {} },
};
const LANGS = ["ja", "en"];
const args = process.argv.slice(2);
const unknown = args.filter((a) => !LANGS.includes(a) && !(a in SCENARIOS));
if (unknown.length) {
  console.error(`unknown argument: ${unknown.join(", ")}`);
  console.error("usage: capture.mjs [ja|en]... [docs|intro]...");
  process.exit(2);
}
const langs = args.some((a) => LANGS.includes(a)) ? LANGS.filter((l) => args.includes(l)) : LANGS;
const scenarios = args.some((a) => a in SCENARIOS)
  ? Object.keys(SCENARIOS).filter((name) => args.includes(name))
  : Object.keys(SCENARIOS);
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
      gpt-6.1-terra: { input: 0.5, cached_input: 0.05, output: 4 }
      gpt-6.1-sol: { input: 1.25, cached_input: 0.125, output: 10 }
      gpt-6-astra: { input: 2.5, cached_input: 0.25, output: 20 }
images:
  java17:
    description: Java 17・Maven・Gradle
    base_image: registry.example.com/ci/java:17
  playwright:
    description: Node.js・Playwright（ブラウザーのテスト）
    base_image: registry.example.com/ci/playwright:1
web:
  auth: false
# 新しい版のお知らせを写さない（リリースの有無とネットワークで、撮るたびに変わるため）
update_check: false
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

async function capture(lang, scenario, chromium) {
  const { seed, env: scenarioEnv } = SCENARIOS[scenario];
  const shots = SHOTS.filter((shot) => (shot.scenario ?? "docs") === scenario);
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
      [join(ROOT, "scripts/docs-screenshots", seed), home, lang],
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
        env: { ...env, ...scenarioEnv },
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
    for (const shot of shots) {
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
      } else if (shot.until) {
        // ページの上から、until の要素の下の端までを撮る（言語で行の折り返しが変わっても、区切りのよい所で切れる）
        const box = await page.locator(shot.until).first().boundingBox();
        if (!box) throw new Error(`${shot.name}: ${shot.until} is not visible`);
        await page.screenshot({
          path: file,
          fullPage: true,
          clip: { x: 0, y: 0, width: 1280, height: Math.ceil(box.y + box.height) + 24 },
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
for (const lang of langs) {
  for (const scenario of scenarios) await capture(lang, scenario, chromium);
}
