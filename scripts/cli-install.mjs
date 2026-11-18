// `npm run cli:install`（ビルドの後）から呼ぶ。どのディレクトリでも `sacty` を使えるように、Node.js の版に関係しない
// ディレクトリ（既定は ~/.local/bin。SACTY_BIN_DIR で変えられる）に、起動の入口（シェルのスクリプト）を置く。
// mise を使っていても、mise には登録しない。mise も呼ばない（前の版が mise に登録した入口があれば、同じ中身に書き直し、
// 手で外す手順を知らせる）。
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
  readdirSync,
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

/** 前の版が、mise に登録する入口を置いたディレクトリ（XDG_DATA_HOME、無ければ ~/.local/share の下）。中は版ごと。 */
export function legacyMiseRoot({ env = process.env, home = homedir() } = {}) {
  const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return join(data, "sacty", "mise");
}

/**
 * 前の版が mise に登録した入口（root の <版>/bin/sacty。目印のあるもの）を、いまの入口と同じ中身（content）に書き直す。
 * mise の登録は外さない（mise の設定を書き換えず、mise も呼ばない）ので、mise が PATH に載せて先に見つかっても、
 * いま置いた入口と同じに動くようにする。root が無ければ何もしない（found が false）。
 * 書き直した入口を updated、書き直せなかったもの（目印の無いファイル・読めない・書けない）を failed で返す。例外は投げない。
 */
export function refreshLegacyLaunchers({ root, content, entry }) {
  const updated = [];
  const failed = [];
  if (!existsSync(root) && !isSymlink(root)) return { found: false, updated, failed };
  let versions;
  try {
    versions = readdirSync(root);
  } catch (error) {
    return { found: true, updated, failed: [{ path: root, error: error.message }] };
  }
  for (const version of versions) {
    const launcher = join(root, version, "bin", "sacty");
    if (!existsSync(launcher) && !isSymlink(launcher)) continue;
    try {
      if (writeLauncher(launcher, content, entry)) updated.push(launcher);
      else failed.push({ path: launcher, error: "sacty の入口でないファイル（またはリンク）です" });
    } catch (error) {
      failed.push({ path: launcher, error: error.message });
    }
  }
  return { found: true, updated, failed };
}

/** 前の版が mise に登録した sacty が残っているときの注意（手で外す手順）。root は legacyMiseRoot。 */
export function legacyNotice({ root, updated, failed }) {
  const lines = [
    `前の版が mise に登録した sacty が残っています（${root}）。いまの版は mise に登録しません。次の順で、手で外してください：(1) mise の利用者全体の設定（~/.config/mise/config.toml）の [tools] から sacty の行を消す。(2) mise の登録（mise の既定では ~/.local/share/mise/installs/sacty）を消す。(3) ${root} を消す。`,
  ];
  if (updated.length > 0) {
    lines.push(
      `外すまでの間も同じに動くよう、前の版の入口を、いま置いた入口と同じ中身に書き直しました（${updated.join("、")}）。`,
    );
  }
  for (const { path, error } of failed) {
    lines.push(`前の版の入口（${path}）は書き直せませんでした：${error}`);
  }
  return lines;
}

/**
 * 入口を書く。置き場所に、sacty の入口でないファイル・リンクがあれば上書きしない（false）。ただし、このリポジトリの
 * entry を指すリンク（前のやり方の npm link で入れたもの。npm のグローバルの場所が ~/.local だと重なる）は置き換える。
 */
export function writeLauncher(launcher, content, entry) {
  if (existsSync(launcher) || isSymlink(launcher)) {
    const ours = isSymlink(launcher)
      ? real(launcher) === real(entry)
      : safeRead(launcher).includes(LAUNCHER_MARK);
    if (!ours) return false;
    if (isSymlink(launcher)) rmSync(launcher, { force: true });
  }
  mkdirSync(dirname(launcher), { recursive: true });
  // 書きかけの入口を使わせないよう、隣に書いてから置き換える
  const temp = `${launcher}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o755 });
  chmodSync(temp, 0o755);
  renameSync(temp, launcher);
  return true;
}

/** repo（既定は、このスクリプトのあるリポジトリ）の sacty を入れる。 */
export function main({ repo = resolve(dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  if (process.platform === "win32")
    fail("npm run cli:install は Windows では使えません（macOS・Linux だけ）。");
  const cliDir = join(repo, "packages", "cli");
  const entry = realpathSync(join(cliDir, "bin", "sacty.js"));
  const version = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
  // このスクリプトを動かしている Node.js（リポジトリで mise などが選んだ版）
  const node = process.execPath;
  const content = launcherScript({ node, entry, repo });

  // 前のやり方（npm link）で、いまの Node.js のグローバルに入れたこのリポジトリの sacty があれば外す（PATH で先に
  // 見つかって、別の Node.js の版で動くのを防ぐ）。ほかのリポジトリ・ほかのパッケージのものは触らない。
  // 入口を書く前に外す（npm のグローバルの場所が ~/.local だと、前のリンクが入口の置き場所と重なるため）
  const npm = "npm";
  const prefix = globalPrefix({ npmPrefix: () => run(npm, ["prefix", "-g"]).stdout.trim() });
  const linkedCli = join(prefix, "lib", "node_modules", "@sacty", "cli");
  if (isSymlink(linkedCli) && real(linkedCli) === real(cliDir)) {
    // 確かめた場所（prefix）に対して外す（npm が自分で決める場所と違うことがあっても、確かめた場所のリンクを外す）
    const removed = run(npm, ["rm", "-g", "@sacty/cli"], {
      stdio: "inherit",
      env: { ...process.env, npm_config_prefix: prefix },
    });
    if (removed.status === 0 && !isSymlink(linkedCli)) {
      console.log(`[sacty] 前のやり方（npm link）で入れた sacty を外しました（${linkedCli}）。`);
    } else {
      console.warn(
        `[sacty] 注意：前のやり方（npm link）で入れた sacty（${linkedCli}）を外せませんでした。`,
      );
    }
  }

  const launcher = join(launcherDir(), "sacty");
  if (!writeLauncher(launcher, content, entry)) {
    fail(
      `${launcher} に、sacty の入口でないファイル（またはリンク）があります。消すか、SACTY_BIN_DIR で別の置き場所を指定してから、もう一度実行してください。`,
    );
  }

  // 前の版が mise に登録した入口を、同じ中身に書き直す（mise が PATH に載せて先に見つかっても、同じに動くように）
  const legacyRoot = legacyMiseRoot();
  const legacy = refreshLegacyLaunchers({ root: legacyRoot, content, entry });

  // 入口が、このリポジトリの版で動くか（ビルドの結果を読めるか）
  const shown = run(launcher, ["--version"]).stdout.trim();
  if (shown !== version) {
    fail(
      `入れた sacty の版（${shown || "表示されません"}）が、このリポジトリの版（${version}）と違います。npm run build を確かめてください。`,
    );
  }
  const { warnings } = checkPath({ launcher, onPath: findOnPath("sacty") });
  for (const line of warnings) console.warn(`[sacty] 注意：${line}`);
  if (legacy.found) {
    for (const line of legacyNotice({ root: legacyRoot, ...legacy })) {
      console.warn(`[sacty] 注意：${line}`);
    }
  }
  console.log(
    `[sacty] sacty ${version} を入れました（${launcher} → ${cliDir}、Node.js ${process.version}：${node}）。`,
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
