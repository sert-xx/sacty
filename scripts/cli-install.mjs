// `npm run cli:install`（ビルドの後）から呼ぶ。どのディレクトリでも `sacty` を使えるように、Node.js の版に関係しない
// ディレクトリ（既定は ~/.local/bin。SACTY_BIN_DIR で変えられる）に、起動の入口（シェルのスクリプト）を置く。
// 入口には、このスクリプトを動かした Node.js（sacty のリポジトリで mise などが選んだもの）の絶対パスを書く。mise などで
// ディレクトリごとに Node.js の版が違っても、sacty はいつもこの Node.js で動く。
// 入口はリポジトリの packages/cli を指すので、版を上げた後にビルドし直せば新しい版で動く。Node.js の版を変えたときは、
// もう一度実行すると入口の Node.js が切り替わる。何度実行してもよく、別の場所の clone で実行すると、その clone を指す。
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 入口に書く目印。この目印の無いファイルは、sacty のものではないので上書きしない。 */
export const LAUNCHER_MARK = "# sacty-launcher: npm run cli:install が作った sacty の起動の入口";

/** realpath（無い・読めないなら undefined）。 */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** シェルの1つの引数として安全に書く（単一引用符で囲む）。 */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 起動の入口の中身。node と entry は絶対パス。 */
export function launcherScript({ node, entry, repo }) {
  return [
    "#!/bin/sh",
    LAUNCHER_MARK,
    "# Node.js の版を変えた・リポジトリを動かしたときは、リポジトリで npm run cli:install をやり直してください。",
    `node=${shellQuote(node)}`,
    `entry=${shellQuote(entry)}`,
    `repo=${shellQuote(repo)}`,
    'if [ ! -x "$node" ]; then',
    '  echo "[sacty] sacty を動かす Node.js（$node）がありません。sacty のリポジトリ（$repo）で npm run cli:install をやり直してください。" >&2',
    "  exit 1",
    "fi",
    'if [ ! -f "$entry" ]; then',
    '  echo "[sacty] sacty（$entry）がありません。sacty のリポジトリ（$repo）で npm run cli:install をやり直してください。" >&2',
    "  exit 1",
    "fi",
    'exec "$node" "$entry" "$@"',
    "",
  ].join("\n");
}

/** 入口を置くディレクトリ（SACTY_BIN_DIR、無ければ ~/.local/bin）。 */
export function launcherDir({ env = process.env, home = homedir() } = {}) {
  const fromEnv = env.SACTY_BIN_DIR?.trim();
  return fromEnv ? resolve(fromEnv) : join(home, ".local", "bin");
}

/** PATH の中で最初に見つかる、実行できる name。 */
export function findOnPath(name, pathValue = process.env.PATH ?? "") {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 無い・実行できない
    }
  }
  return undefined;
}

/**
 * 入れた後の確かめ。onPath（PATH で最初に見つかる sacty）が launcher（置いた入口）か。止めるべき誤りは無く、
 * 知らせることを warnings で返す（PATH の順は利用者の環境なので止めない）。
 */
export function checkPath({ launcher, onPath, resolveReal = real }) {
  const warnings = [];
  if (!onPath) {
    warnings.push(
      `${dirname(launcher)} が PATH にありません。PATH に足すと、どのディレクトリでも sacty と打って使えます（SACTY_BIN_DIR で置き場所を変えられます）。`,
    );
  } else if (resolveReal(onPath) !== resolveReal(launcher)) {
    warnings.push(
      `PATH で先に見つかる sacty（${onPath}）は、いま置いた入口ではありません。そちらを消すか、PATH の順を変えてください（${dirname(launcher)} を前に置く）。`,
    );
  }
  return { warnings };
}

/**
 * npm のグローバルの場所。`npm run` が渡す npm_config_global_prefix を先に使う。npm は自分の出力の中の UUID の形の
 * 文字列を `***` に伏せるので、`npm prefix -g` の出力は、パスに UUID があると実在しないパスになる（環境変数は伏せない）。
 * 直接実行して環境変数が無いときだけ `npm prefix -g` に戻る。
 */
export function globalPrefix({ env = process.env, npmPrefix }) {
  const fromEnv = env.npm_config_global_prefix?.trim();
  return fromEnv ? fromEnv : npmPrefix();
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function fail(message) {
  console.error(`[sacty] ${message}`);
  process.exit(1);
}

/**
 * mise で入れた後の確かめ。found（mise which sacty の結果）が launcher（置いた入口）か。注意を warnings で返す。
 */
export function checkMise({ launcher, found, resolveReal = real }) {
  const warnings = [];
  if (!found) {
    warnings.push(
      "mise が sacty を見つけられません。mise activate かシムの設定を確かめてください（mise ls sacty で、登録した版を確かめられます）。",
    );
  } else if (resolveReal(found) !== resolveReal(launcher)) {
    warnings.push(
      `mise が選ぶ sacty（${found}）は、いま置いた入口ではありません。mise.toml で sacty の版を指定していないか確かめてください。`,
    );
  }
  return { warnings };
}

/** mise で入れるか（PATH に mise があり、SACTY_BIN_DIR で置き場所を指定していないとき）。 */
export function useMise({ env = process.env, hasMise }) {
  return !env.SACTY_BIN_DIR?.trim() && hasMise;
}

/** mise に登録する、版ごとの入口のディレクトリ（XDG_DATA_HOME、無ければ ~/.local/share の下）。中の bin/sacty が入口。 */
export function miseToolDir({ version, env = process.env, home = homedir() }) {
  const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return join(data, "sacty", "mise", version);
}

/**
 * mise に、dir を sacty の版 version として登録し（mise link）、利用者全体で使う版にする（mise use --global）。
 * 失敗したら、どのコマンドがどう失敗したかを返す。
 */
export function installWithMise({ version, dir, run }) {
  for (const args of [
    ["link", "--force", `sacty@${version}`, dir],
    ["use", "--global", `sacty@${version}`],
  ]) {
    const result = run("mise", args);
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
      return {
        ok: false,
        error: `mise ${args.join(" ")} に失敗しました${detail ? `：${detail}` : ""}`,
      };
    }
  }
  return { ok: true };
}

/** 入口を書く。置き場所に、sacty の入口でないファイル・リンクがあれば上書きしない（false）。 */
function writeLauncher(launcher, content) {
  if (existsSync(launcher) || isSymlink(launcher)) {
    const current = isSymlink(launcher) ? "" : safeRead(launcher);
    if (!current.includes(LAUNCHER_MARK)) return false;
  }
  mkdirSync(dirname(launcher), { recursive: true });
  // 書きかけの入口を使わせないよう、隣に書いてから置き換える
  const temp = `${launcher}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o755 });
  chmodSync(temp, 0o755);
  renameSync(temp, launcher);
  return true;
}

function main() {
  if (process.platform === "win32")
    fail("npm run cli:install は Windows では使えません（macOS・Linux だけ）。");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliDir = join(repo, "packages", "cli");
  const entry = realpathSync(join(cliDir, "bin", "sacty.js"));
  const version = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
  // このスクリプトを動かしている Node.js（リポジトリで mise などが選んだ版）
  const node = process.execPath;
  const content = launcherScript({ node, entry, repo });
  const binLauncher = join(launcherDir(), "sacty");

  // mise があれば、版ごとのディレクトリに入口を置いて mise に登録する。登録できなければ、置き場所（~/.local/bin など）に置く
  let launcher;
  let via = "bin";
  if (useMise({ hasMise: Boolean(findOnPath("mise")) })) {
    const toolDir = miseToolDir({ version });
    const miseLauncher = join(toolDir, "bin", "sacty");
    if (!writeLauncher(miseLauncher, content)) {
      fail(
        `${miseLauncher} に、sacty の入口でないファイル（またはリンク）があります。消してから、もう一度実行してください。`,
      );
    }
    const installed = installWithMise({ version, dir: toolDir, run });
    if (installed.ok) {
      launcher = miseLauncher;
      via = "mise";
    } else {
      console.warn(`[sacty] 注意：${installed.error}。mise を使わずに ${binLauncher} に置きます。`);
    }
  }
  if (!launcher) {
    if (!writeLauncher(binLauncher, content)) {
      fail(
        `${binLauncher} に、sacty の入口でないファイル（またはリンク）があります。消すか、SACTY_BIN_DIR で別の置き場所を指定してから、もう一度実行してください。`,
      );
    }
    launcher = binLauncher;
  } else if (existsSync(binLauncher) && safeRead(binLauncher).includes(LAUNCHER_MARK)) {
    // mise で入れたら、前に置き場所に置いた入口は消す（PATH で mise のものより先に見つかるのを防ぐ）
    rmSync(binLauncher, { force: true });
    console.log(`[sacty] 前に置いた入口（${binLauncher}）を消しました（mise で入れたため）。`);
  }

  // 前のやり方（npm link）で、いまの Node.js のグローバルに入れたこのリポジトリの sacty があれば外す（PATH で先に
  // 見つかって、別の Node.js の版で動くのを防ぐ）。ほかのリポジトリ・ほかのパッケージのものは触らない
  const npm = "npm";
  const prefix = globalPrefix({ npmPrefix: () => run(npm, ["prefix", "-g"]).stdout.trim() });
  const linkedCli = join(prefix, "lib", "node_modules", "@sacty", "cli");
  if (isSymlink(linkedCli) && real(linkedCli) === real(cliDir)) {
    const removed = run(npm, ["rm", "-g", "@sacty/cli"], { stdio: "inherit" });
    if (removed.status === 0) {
      console.log(`[sacty] 前のやり方（npm link）で入れた sacty を外しました（${linkedCli}）。`);
    } else {
      console.warn(
        `[sacty] 注意：前のやり方（npm link）で入れた sacty（${linkedCli}）を外せませんでした。`,
      );
    }
  }

  // 入口が、このリポジトリの版で動くか（ビルドの結果を読めるか）
  const shown = run(launcher, ["--version"]).stdout.trim();
  if (shown !== version) {
    fail(
      `入れた sacty の版（${shown || "表示されません"}）が、このリポジトリの版（${version}）と違います。npm run build を確かめてください。`,
    );
  }
  // mise で入れたら、mise が選ぶ sacty が入口か（シムを使う設定では、PATH にはシムが見つかるため、mise に尋ねる）
  const { warnings } =
    via === "mise"
      ? checkMise({ launcher, found: run("mise", ["which", "sacty"]).stdout?.trim() || undefined })
      : checkPath({ launcher, onPath: findOnPath("sacty") });
  for (const line of warnings) console.warn(`[sacty] 注意：${line}`);
  console.log(
    via === "mise"
      ? `[sacty] sacty ${version} を mise で入れました（mise use --global sacty@${version}、${launcher} → ${cliDir}、Node.js ${process.version}：${node}）。`
      : `[sacty] sacty ${version} を入れました（${launcher} → ${cliDir}、Node.js ${process.version}：${node}）。`,
  );
  console.log(
    "[sacty] 動いている sacty up は前の版のままです。止めてから起動し直してください（シェルの alias で sacty を定義していれば、そちらが先に使われます）。",
  );
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
