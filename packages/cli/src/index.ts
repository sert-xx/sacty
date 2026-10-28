#!/usr/bin/env node
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderMessage } from "@sacty/core";
import { CONFIG_TEMPLATE, configPath, loadConfig, resolveHome } from "@sacty/daemon/config";
import { initContextRepo } from "@sacty/daemon/context-template";
import { ALREADY_RUNNING_EXIT_CODE } from "@sacty/daemon/exit-codes";
import { buildImage, imageBuildSettings, imageBuildTargets } from "@sacty/daemon/image";
import {
  isOnePasswordRef,
  KEYCHAIN_SERVICE,
  KeychainSecretStore,
  OnePasswordSecretStore,
  ResolvingSecretStore,
  SecretNotFoundError,
} from "@sacty/daemon/secrets";
import {
  claimDaemonFile,
  fetchContextPreview,
  previewOutput,
  readDaemonFile,
  removeDaemonFile,
} from "./context-preview.js";
import { daemonEnv, startMessage, webAuthEnabled, webEnv } from "./up-env.js";
import { UpStopper } from "./up-stop.js";

const require = createRequire(import.meta.url);

const USAGE = `Usage:
  sacty up [--port <web port>] [--daemon-port <daemon port>]
      デーモンと画面（Next.js）を起動します。Ctrl+C で両方を終了します。
  sacty config init [--force]
      設定ファイル（~/.sacty/config.yaml）の雛形を作ります。
  sacty context init [<dir>] [--force]
      コンテキストリポジトリ（規則・スキル・MCP・エージェントの設定）の雛形を作ります。<dir> の既定は今のディレクトリです。
  sacty context preview <プロジェクト> [--runtime claude-code|codex] [--json] [--no-content]
      プロジェクト（ID か名前）のコンテキストの合成の結果（実行のときに置くファイルと、層・警告など）を表示します。
      起動中の sacty（sacty up）に問い合わせます。秘密情報は参照の名前だけを表示します。
  sacty secret set <name>
      秘密情報（トークンやAPIキー）をmacOSのキーチェーンに保存します。値は入力を求められます。
  sacty image build [<名前>...]
      エージェント実行用のコンテナイメージを作ります。名前を省くと、既定のイメージと config.yaml の images に
      書いたすべての言語ごとのイメージを作ります（default は既定のイメージ）。`;

/** 終了コードを返して終わる子プロセスを、入出力をつないだまま実行する。 */
function runInherit(command: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function configInit(force: boolean): void {
  const home = resolveHome();
  const path = configPath(home);
  if (existsSync(path) && !force) {
    throw new Error(`${path} はすでにあります。上書きする場合は --force を付けてください。`);
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path, CONFIG_TEMPLATE, { mode: 0o600 });
  console.log(`[sacty] 設定ファイルを作成しました：${path}`);
  console.log(
    "[sacty] 単価と認証方式を確認し、必要な秘密情報を `sacty secret set <名前>` で保存してください。",
  );
}

function contextInit(dir: string | undefined, force: boolean): void {
  const root = resolve(dir ?? ".");
  const files = initContextRepo(root, force);
  console.log(`[sacty] コンテキストリポジトリの雛形を作成しました：${root}`);
  for (const file of files) console.log(`  ${file}`);
  console.log(
    "[sacty] 各ファイルの説明に沿って書いたら、git で管理して push し、画面のプロジェクトの設定の「コンテキストリポジトリ」にそのリポジトリを指定してください。",
  );
}

async function secretSet(name: string | undefined): Promise<void> {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      "秘密情報の名前を、英数字と . _ - で指定してください（例：claude-oauth-token）。",
    );
  }
  // 値は security コマンドが直接たずねる（-w を最後に置く）。sactyは値に触れず、
  // コマンドラインやログにも出さない。
  console.log(
    `[sacty] 「${name}」の値を入力してください（入力は表示されません。確認のため2回たずねられます）。`,
  );
  const code = await runInherit("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    name,
    "-w",
  ]);
  if (code !== 0) throw new Error("キーチェーンに保存できませんでした。");
  console.log(`[sacty] 「${name}」をキーチェーンに保存しました。`);
}

async function imageBuild(names: string[]): Promise<void> {
  // 元のイメージと npm のレジストリは config.yaml の image_build に従う（PBI-33）。設定ファイルに誤りがあれば、
  // 既定に戻して作らずに止める（プライベートのレジストリの指定を捨てないため）
  const config = loadConfig(resolveHome());
  const settings = imageBuildSettings(config);
  if (!settings.ok) {
    throw new Error(
      `${renderMessage(settings.problem, "ja")}設定ファイルを直してから、もう一度実行してください。`,
    );
  }
  const { image, build, images } = settings;
  // 名前を指定すれば、そのイメージだけ作る（default は既定のイメージ。PBI-41）
  const selected = imageBuildTargets(images, names);
  if (!selected.ok) {
    throw new Error(
      `config.yaml の images に ${selected.unknown.join("・")} がありません（作れるのは default${Object.keys(
        images,
      )
        .map((n) => `・${n}`)
        .join("")}）。`,
    );
  }
  const dockerDir = fileURLToPath(new URL("../docker", import.meta.url));
  // npm のトークンは、キーチェーンの名前か 1Password の参照（PBI-34）
  const secrets = new ResolvingSecretStore(
    new KeychainSecretStore(),
    new OnePasswordSecretStore({
      account: () => (config.ok ? config.config.onePasswordAccount : undefined),
    }),
  );
  for (const language of selected.targets) {
    const tag = language?.image ?? image;
    console.log(
      language
        ? `[sacty] イメージ ${tag}（${language.name}）を作成します（元のイメージ：${language.baseImage}・npm のレジストリ：${build.npmRegistry ?? "https://registry.npmjs.org/"}）。`
        : `[sacty] イメージ ${tag} を作成します（元のイメージ：${build.baseImage ?? "node:26-bookworm-slim"}・npm のレジストリ：${build.npmRegistry ?? "https://registry.npmjs.org/"}）。`,
    );
    let failure: string | undefined;
    try {
      failure = await buildImage({
        image,
        build,
        dockerDir,
        secrets,
        run: (args) => runInherit("docker", args),
        ...(language ? { language } : {}),
      });
    } catch (error) {
      if (error instanceof SecretNotFoundError && isOnePasswordRef(error.secretName)) {
        throw new Error(error.message);
      }
      if (error instanceof SecretNotFoundError) {
        throw new Error(
          `npm の認証トークン「${error.secretName}」がキーチェーンにありません。sacty secret set ${error.secretName} で保存してください。`,
        );
      }
      throw error;
    }
    if (failure) throw new Error(failure);
    console.log(`[sacty] イメージ ${tag} を作成しました。`);
  }
}

async function contextPreview(
  project: string | undefined,
  runtime: string,
  json: boolean,
  content: boolean,
): Promise<void> {
  if (!project) throw new Error("プロジェクトの ID か名前を指定してください。");
  if (runtime !== "claude-code" && runtime !== "codex") {
    throw new Error(`--runtime は claude-code か codex で指定してください（指定：${runtime}）。`);
  }
  const endpoint = readDaemonFile(resolveHome());
  if (!endpoint) {
    throw new Error("起動中の sacty が見つかりません。`sacty up` で起動してから実行してください。");
  }
  const result = await fetchContextPreview(endpoint, project, runtime);
  console.log(previewOutput(result, { json, content }));
  // 誤りがあれば、終了コードで知らせる
  if ("error" in result) process.exitCode = 1;
}

async function waitForDaemon(url: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`);
}

async function up(webPort: number, daemonPort: number) {
  const token = randomBytes(32).toString("hex");
  // 画面の入り口の秘密（PBI-129）。デーモンのトークンとは別にし、画面にだけ渡す。config.yaml で画面の認証を OFF に
  // したときは作らない（PBI-133）
  const webToken = webAuthEnabled(loadConfig(resolveHome()))
    ? randomBytes(32).toString("base64url")
    : undefined;
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const stopper = new UpStopper({
    exit: (code) => process.exit(code),
    log: (line) => console.error(line),
  });
  const stop = (code: number) => stopper.stop(code);

  const watch = (name: string, child: ChildProcess) => {
    stopper.add(name, child);
    child.on("exit", (code, signal) => {
      if (!stopper.stopping) {
        if (name === "daemon" && code === ALREADY_RUNNING_EXIT_CODE) {
          // 同じ SACTY_HOME で、ほかの sacty が動いている（デーモンが接続先と PID を表示した。PBI-79）
          console.error(
            "[sacty] 同じ SACTY_HOME で、ほかの sacty が動いているため、起動しませんでした。",
          );
          stop(1);
          return;
        }
        console.error(
          `[sacty] ${name} exited unexpectedly (${signal ?? `code ${code}`}). Stopping.`,
        );
        // 想定外の終了は、子の終了コードが0でも失敗として伝える
        stop(code && code !== 0 ? code : 1);
      }
    });
  };

  process.on("SIGINT", () => stopper.signal());
  process.on("SIGTERM", () => stopper.signal());

  const daemonMain = require.resolve("@sacty/daemon");
  watch(
    "daemon",
    spawn(process.execPath, ["--disable-warning=ExperimentalWarning", daemonMain], {
      stdio: "inherit",
      env: daemonEnv(process.env, { daemonPort, daemonToken: token, webPort }),
    }),
  );

  try {
    await waitForDaemon(daemonUrl, token, 15_000);
  } catch (error) {
    console.error("[sacty]", error instanceof Error ? error.message : error);
    stop(1);
    return;
  }
  if (stopper.stopping) return;

  // CLI のコマンド（sacty context preview）が、起動中のデーモンに問い合わせるための接続先とトークン（PBI-76）。デーモンが
  // 応答してから書き（起動に失敗した sacty は書かない）、ほかの sacty が動いていれば上書きしない
  const home = resolveHome();
  const endpoint = { url: daemonUrl, token };
  if (await claimDaemonFile(home, endpoint)) {
    process.on("exit", () => removeDaemonFile(home, endpoint));
  } else {
    console.warn(
      "[sacty] 同じ SACTY_HOME で、ほかの sacty が動いています。sacty context preview は、そちらに問い合わせます。",
    );
  }
  if (stopper.stopping) return;

  const webDir = dirname(require.resolve("@sacty/web/package.json"));
  const nextBin = require.resolve("next/dist/bin/next", { paths: [webDir] });
  watch(
    "web",
    spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(webPort)], {
      cwd: webDir,
      stdio: "inherit",
      env: webEnv(process.env, { daemonUrl, daemonToken: token, webPort, webToken }),
    }),
  );

  // この URL を開いたブラウザだけが画面を使える（PBI-129）。起動し直すと、新しい URL になる
  console.log(startMessage(webPort, webToken));
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4700" },
      "daemon-port": { type: "string", default: "4710" },
      help: { type: "boolean", short: "h", default: false },
      force: { type: "boolean", default: false },
      runtime: { type: "string", default: "claude-code" },
      json: { type: "boolean", default: false },
      "no-content": { type: "boolean", default: false },
    },
  });

  const [command, sub, arg] = positionals;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (command === "config" && sub === "init") return configInit(values.force);
  if (command === "context" && sub === "init") return contextInit(arg, values.force);
  if (command === "context" && sub === "preview") {
    return contextPreview(arg, values.runtime, values.json, !values["no-content"]);
  }
  if (command === "secret" && sub === "set") return secretSet(arg);
  if (command === "image" && sub === "build") return imageBuild(positionals.slice(2));
  if (command !== "up") {
    console.log(USAGE);
    process.exit(1);
  }
  const webPort = parsePort("--port", values.port);
  const daemonPort = parsePort("--daemon-port", values["daemon-port"]);
  if (webPort === daemonPort) {
    throw new Error("--port and --daemon-port must be different");
  }
  await up(webPort, daemonPort);
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

main().catch((error: unknown) => {
  console.error("[sacty]", error instanceof Error ? error.message : error);
  process.exit(1);
});
