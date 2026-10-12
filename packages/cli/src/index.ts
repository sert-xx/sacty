#!/usr/bin/env node
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderMessage } from "@sacty/core";
import { CONFIG_TEMPLATE, configPath, loadConfig, resolveHome } from "@sacty/daemon/config";
import { buildImage, imageBuildSettings } from "@sacty/daemon/image";
import { KEYCHAIN_SERVICE, KeychainSecretStore, SecretNotFoundError } from "@sacty/daemon/secrets";

const require = createRequire(import.meta.url);

const USAGE = `Usage:
  sacty up [--port <web port>] [--daemon-port <daemon port>]
      デーモンと画面（Next.js）を起動します。Ctrl+C で両方を終了します。
  sacty config init [--force]
      設定ファイル（~/.sacty/config.yaml）の雛形を作ります。
  sacty secret set <name>
      秘密情報（トークンやAPIキー）をmacOSのキーチェーンに保存します。値は入力を求められます。
  sacty image build
      エージェント実行用のコンテナイメージを作ります。`;

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

async function imageBuild(): Promise<void> {
  // 元のイメージと npm のレジストリは config.yaml の image_build に従う（PBI-33）。設定ファイルに誤りがあれば、
  // 既定に戻して作らずに止める（プライベートのレジストリの指定を捨てないため）
  const settings = imageBuildSettings(loadConfig(resolveHome()));
  if (!settings.ok) {
    throw new Error(
      `${renderMessage(settings.problem, "ja")}設定ファイルを直してから、もう一度実行してください。`,
    );
  }
  const { image, build } = settings;
  const dockerDir = fileURLToPath(new URL("../docker", import.meta.url));
  console.log(
    `[sacty] イメージ ${image} を作成します（元のイメージ：${build.baseImage ?? "node:22-bookworm-slim"}・npm のレジストリ：${build.npmRegistry ?? "https://registry.npmjs.org/"}）。`,
  );
  let failure: string | undefined;
  try {
    failure = await buildImage({
      image,
      build,
      dockerDir,
      secrets: new KeychainSecretStore(),
      run: (args) => runInherit("docker", args),
    });
  } catch (error) {
    if (error instanceof SecretNotFoundError) {
      throw new Error(
        `npm の認証トークン「${error.secretName}」がキーチェーンにありません。sacty secret set ${error.secretName} で保存してください。`,
      );
    }
    throw error;
  }
  if (failure) throw new Error(failure);
  console.log(`[sacty] イメージ ${image} を作成しました。`);
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
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const children: ChildProcess[] = [];
  let stopping = false;

  const running = () => children.filter((c) => c.exitCode === null && c.signalCode === null);

  /** 子プロセスをすべて止め、止まったのを確かめてから終了コードを返して終わる。 */
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    const alive = running();
    if (alive.length === 0) process.exit(code);
    for (const child of alive) {
      child.once("exit", () => {
        if (running().length === 0) process.exit(code);
      });
      child.kill("SIGTERM");
    }
    // 子が応答しない場合の保険。unref しない（先にイベントループが終わると終了コードが失われるため）。
    // デーモンは実行中の処理の後片付け（認証ファイルの書き戻しなど）に最大20秒かけるので、それより長く待つ。
    setTimeout(() => {
      for (const child of running()) child.kill("SIGKILL");
      process.exit(code);
    }, 30_000);
  };

  const watch = (name: string, child: ChildProcess) => {
    children.push(child);
    child.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(
          `[sacty] ${name} exited unexpectedly (${signal ?? `code ${code}`}). Stopping.`,
        );
        // 想定外の終了は、子の終了コードが0でも失敗として伝える
        stop(code && code !== 0 ? code : 1);
      }
    });
  };

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  const daemonMain = require.resolve("@sacty/daemon");
  watch(
    "daemon",
    spawn(process.execPath, ["--disable-warning=ExperimentalWarning", daemonMain], {
      stdio: "inherit",
      env: {
        ...process.env,
        SACTY_DAEMON_PORT: String(daemonPort),
        SACTY_DAEMON_TOKEN: token,
      },
    }),
  );

  try {
    await waitForDaemon(daemonUrl, token, 15_000);
  } catch (error) {
    console.error("[sacty]", error instanceof Error ? error.message : error);
    stop(1);
    return;
  }
  if (stopping) return;

  const webDir = dirname(require.resolve("@sacty/web/package.json"));
  const nextBin = require.resolve("next/dist/bin/next", { paths: [webDir] });
  watch(
    "web",
    spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(webPort)], {
      cwd: webDir,
      stdio: "inherit",
      env: {
        ...process.env,
        SACTY_DAEMON_URL: daemonUrl,
        SACTY_DAEMON_TOKEN: token,
      },
    }),
  );

  console.log(`\n[sacty] Open http://127.0.0.1:${webPort} in your browser.\n`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4700" },
      "daemon-port": { type: "string", default: "4710" },
      help: { type: "boolean", short: "h", default: false },
      force: { type: "boolean", default: false },
    },
  });

  const [command, sub, arg] = positionals;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (command === "config" && sub === "init") return configInit(values.force);
  if (command === "secret" && sub === "set") return secretSet(arg);
  if (command === "image" && sub === "build") return imageBuild();
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
