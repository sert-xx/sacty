// `npm run cli:install`（ビルドの後）から呼ぶ。packages/cli を npm link して、どのディレクトリでも `sacty` を使えるようにし、
// PATH の `sacty` がこのリポジトリを指し、このリポジトリの版で動くことを確かめる。
// リンクはリポジトリの packages/cli を指すので、版を上げた後にビルドし直せば新しい版で動く。何度実行してもよく、別の
// 場所の clone で実行すると、リンクの向き先がその clone に置き換わる。
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** realpath（無い・読めないなら undefined）。 */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
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
 * リンクの確かめ。globalBin（npm のグローバルの bin の sacty）と onPath（PATH で最初に見つかる sacty）が、
 * expected（このリポジトリの packages/cli/bin/sacty.js）を指すか。止めるべき誤りは errors、知らせることは warnings。
 */
export function checkLink({ expected, globalBin, onPath, resolveReal = real }) {
  const errors = [];
  const warnings = [];
  const linked = resolveReal(globalBin);
  if (linked !== expected) {
    errors.push(
      `npm のグローバルの ${globalBin} が、このリポジトリ（${expected}）を指していません（${linked ?? "ありません"}）。`,
    );
  } else if (!onPath) {
    warnings.push(
      `${dirname(globalBin)} が PATH にありません。PATH に足すと、どのディレクトリでも sacty と打って使えます。`,
    );
  } else if (resolveReal(onPath) !== expected) {
    warnings.push(
      `PATH で先に見つかる sacty（${onPath}）は、このリポジトリのものではありません。そちらを消すか、PATH の順を変えてください（${dirname(globalBin)} を前に置く）。`,
    );
  }
  return { errors, warnings };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
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

function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliDir = join(repo, "packages", "cli");
  const expected = realpathSync(join(cliDir, "bin", "sacty.js"));
  const version = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  const linked = run(npm, ["link"], { cwd: cliDir, stdio: "inherit" });
  if (linked.status !== 0) {
    console.error(
      "[sacty] npm link に失敗しました。ほかのパッケージの sacty がグローバルに入っていれば、npm ls -g で名前を確かめ、npm uninstall -g <名前> で消してから、もう一度実行してください。",
    );
    process.exit(1);
  }
  const prefix = globalPrefix({ npmPrefix: () => run(npm, ["prefix", "-g"]).stdout.trim() });
  const globalBin = join(prefix, "bin", "sacty");
  const onPath = findOnPath("sacty");
  const { errors, warnings } = checkLink({ expected, globalBin, onPath });
  for (const line of errors) console.error(`[sacty] ${line}`);
  if (errors.length > 0) process.exit(1);
  for (const line of warnings) console.warn(`[sacty] 注意：${line}`);

  // リンクした sacty が、このリポジトリの版で動くか（ビルドの結果を読めるか）
  const shown = run(globalBin, ["--version"]).stdout.trim();
  if (shown !== version) {
    console.error(
      `[sacty] リンクした sacty の版（${shown || "表示されません"}）が、このリポジトリの版（${version}）と違います。npm run build を確かめてください。`,
    );
    process.exit(1);
  }
  console.log(`[sacty] sacty ${version} を入れました（${globalBin} → ${cliDir}）。`);
  console.log(
    "[sacty] 動いている sacty up は前の版のままです。止めてから起動し直してください（シェルの alias で sacty を定義していれば、そちらが先に使われます）。",
  );
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
