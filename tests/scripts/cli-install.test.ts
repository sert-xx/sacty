import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPath,
  findOnPath,
  globalPrefix,
  LAUNCHER_MARK,
  launcherDir,
  launcherScript,
  legacyMiseRoot,
  legacyNotice,
  refreshLegacyLaunchers,
  writeLauncher,
} from "../../scripts/cli-install.mjs";

describe("launcherScript", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("書いた Node.js で、引数をそのまま渡して sacty を動かす（PATH の node は使わない。パスの空白・引用符・$ も崩さない）", () => {
    const root = mkdtempSync(join(tmpdir(), "sacty-launcher-"));
    dirs.push(root);
    const odd = join(root, `my "repo" $HOME 'x'`);
    mkdirSync(odd);
    // 引数と、どの node で動いたかを出す偽の Node.js と entry
    const node = join(odd, "node");
    writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "real-node" "$@"\n');
    chmodSync(node, 0o755);
    const entry = join(odd, "sacty.js");
    writeFileSync(entry, "");
    const launcher = join(root, "sacty");
    writeFileSync(launcher, launcherScript({ node, entry, repo: odd }), { mode: 0o755 });
    const wrongNode = join(root, "path-bin");
    mkdirSync(wrongNode);
    writeFileSync(join(wrongNode, "node"), "#!/bin/sh\necho wrong-node\nexit 42\n");
    chmodSync(join(wrongNode, "node"), 0o755);
    const run = spawnSync(launcher, ["launch", "acme", "--", "a b"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${wrongNode}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean)).toEqual([
      "real-node",
      entry,
      "launch",
      "acme",
      "--",
      "a b",
    ]);
    expect(readFileSync(launcher, "utf8")).toContain(LAUNCHER_MARK);
  });

  it("書いた Node.js が無くなったら、npm run cli:install のやり直しを知らせて失敗する", () => {
    const root = mkdtempSync(join(tmpdir(), "sacty-launcher-"));
    dirs.push(root);
    const launcher = join(root, "sacty");
    writeFileSync(
      launcher,
      launcherScript({ node: join(root, "gone"), entry: join(root, "x.js"), repo: root }),
      { mode: 0o755 },
    );
    const run = spawnSync(launcher, ["--version"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("npm run cli:install をやり直してください");
  });
});

describe("launcherDir", () => {
  it("SACTY_BIN_DIR があればそこ、無ければ ~/.local/bin", () => {
    expect(launcherDir({ env: {}, home: "/home/u" })).toBe("/home/u/.local/bin");
    expect(launcherDir({ env: { SACTY_BIN_DIR: "/opt/bin" }, home: "/home/u" })).toBe("/opt/bin");
  });
});

describe("checkPath", () => {
  const launcher = "/home/u/.local/bin/sacty";

  it("PATH で最初に見つかるのが置いた入口なら、注意は無い", () => {
    expect(checkPath({ launcher, onPath: launcher, resolveReal: (p: string) => p })).toEqual({
      warnings: [],
    });
  });

  it("PATH に無い・PATH で先に別の sacty（前のやり方の npm link など）が見つかるときは、注意にする", () => {
    const missing = checkPath({ launcher, onPath: undefined, resolveReal: (p: string) => p });
    expect(missing.warnings[0]).toContain("PATH にありません");
    const shadowed = checkPath({
      launcher,
      onPath: "/mise/installs/node/20/bin/sacty",
      resolveReal: (p: string) => p,
    });
    expect(shadowed.warnings[0]).toContain("/mise/installs/node/20/bin/sacty");
  });

  it("PATH で先に見つかるのが、入口と同じ中身に書き直した前の版の入口なら、注意は無い", () => {
    const legacy = "/home/u/.local/share/sacty/mise/1.26.0/bin/sacty";
    expect(
      checkPath({ launcher, onPath: legacy, sameAs: [legacy], resolveReal: (p: string) => p }),
    ).toEqual({ warnings: [] });
  });
});

describe("findOnPath", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("PATH の順に、最初に見つかる実行できるファイルを返す（実行できないものは飛ばす）", () => {
    const root = mkdtempSync(join(tmpdir(), "sacty-cli-install-"));
    dirs.push(root);
    const [a, b, c] = ["a", "b", "c"].map((d) => join(root, d));
    for (const dir of [a, b, c]) mkdirSync(dir ?? "");
    writeFileSync(join(a ?? "", "sacty"), "not executable");
    chmodSync(join(a ?? "", "sacty"), 0o644);
    writeFileSync(join(b ?? "", "sacty"), "#!/bin/sh\n");
    chmodSync(join(b ?? "", "sacty"), 0o755);
    writeFileSync(join(c ?? "", "sacty"), "#!/bin/sh\n");
    chmodSync(join(c ?? "", "sacty"), 0o755);
    expect(findOnPath("sacty", [a, b, c].join(delimiter))).toBe(join(b ?? "", "sacty"));
    expect(findOnPath("sacty", "")).toBeUndefined();
  });
});

describe("globalPrefix", () => {
  const withUuid = "/tmp/3f2b8c1e-9d4a-4b7e-8f0c-1a2b3c4d5e6f/npm-prefix";

  it("npm run が渡す npm_config_global_prefix を、npm prefix -g より先に使う（npm は出力の UUID を *** に伏せる）", () => {
    let called = false;
    const prefix = globalPrefix({
      env: { npm_config_global_prefix: withUuid },
      npmPrefix: () => {
        called = true;
        return "/tmp/***/npm-prefix";
      },
    });
    expect(prefix).toBe(withUuid);
    expect(called).toBe(false);
  });

  it("環境変数が無い・空のとき（直接実行）は npm prefix -g に戻る", () => {
    expect(globalPrefix({ env: {}, npmPrefix: () => "/usr/local" })).toBe("/usr/local");
    expect(
      globalPrefix({ env: { npm_config_global_prefix: "  " }, npmPrefix: () => "/usr/local" }),
    ).toBe("/usr/local");
  });
});

describe("前の版が mise に登録した入口", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const content = `#!/bin/sh\n${LAUNCHER_MARK}\n# new\n`;

  /** 前の版の入口（root/<版>/bin/sacty）を、版ごとに作る。 */
  function setup(versions: string[]) {
    const base = mkdtempSync(join(tmpdir(), "sacty-legacy-mise-"));
    dirs.push(base);
    const root = join(base, "sacty", "mise");
    mkdirSync(root, { recursive: true });
    for (const version of versions) {
      mkdirSync(join(root, version, "bin"), { recursive: true });
      writeFileSync(join(root, version, "bin", "sacty"), `#!/bin/sh\n${LAUNCHER_MARK}\n# old\n`);
    }
    return { base, root, entry: join(base, "sacty.js") };
  }

  it("前の版の入口のディレクトリは、XDG_DATA_HOME、無ければ ~/.local/share の下の sacty/mise", () => {
    expect(legacyMiseRoot({ env: {}, home: "/home/u" })).toBe("/home/u/.local/share/sacty/mise");
    expect(legacyMiseRoot({ env: { XDG_DATA_HOME: "/data" }, home: "/home/u" })).toBe(
      "/data/sacty/mise",
    );
  });

  it("前の版の入口のディレクトリが無ければ、何もしない", () => {
    const { base, entry } = setup([]);
    expect(refreshLegacyLaunchers({ root: join(base, "none"), content, entry })).toEqual({
      found: false,
      updated: [],
      failed: [],
    });
  });

  it("版が複数あれば、すべての入口を、いまの入口と同じ中身に書き直す（入口の無い版は飛ばす）", () => {
    const { root, entry } = setup(["1.22.1", "1.26.0"]);
    mkdirSync(join(root, "1.20.0"));
    const result = refreshLegacyLaunchers({ root, content, entry });
    const launchers = ["1.22.1", "1.26.0"].map((v) => join(root, v, "bin", "sacty"));
    expect(result.found).toBe(true);
    expect([...result.updated].sort()).toEqual(launchers);
    expect(result.failed).toEqual([]);
    for (const launcher of launchers) expect(readFileSync(launcher, "utf8")).toBe(content);
  });

  it("目印の無いファイルは書き直さず、書き直せなかったものとして返す（ほかの版は書き直す）", () => {
    const { root, entry } = setup(["1.22.1", "1.26.0"]);
    const foreign = join(root, "1.22.1", "bin", "sacty");
    writeFileSync(foreign, "#!/bin/sh\necho other\n");
    const result = refreshLegacyLaunchers({ root, content, entry });
    expect(result.updated).toEqual([join(root, "1.26.0", "bin", "sacty")]);
    expect(result.failed.map((f: { path: string }) => f.path)).toEqual([foreign]);
    expect(readFileSync(foreign, "utf8")).toContain("echo other");
  });

  it("ディレクトリでない・版の中身が読めないときも、例外を投げずに、書き直せなかったものとして返す", () => {
    const { base, root, entry } = setup(["1.26.0"]);
    const file = join(base, "file");
    writeFileSync(file, "");
    const notDir = refreshLegacyLaunchers({ root: file, content, entry });
    expect(notDir.found).toBe(true);
    expect(notDir.failed.map((f: { path: string }) => f.path)).toEqual([file]);
    // 入口の場所がディレクトリ（書き直せない）
    const launcher = join(root, "1.26.0", "bin", "sacty");
    rmSync(launcher);
    mkdirSync(launcher);
    const blocked = refreshLegacyLaunchers({ root, content, entry });
    expect(blocked.updated).toEqual([]);
    expect(blocked.failed.map((f: { path: string }) => f.path)).toEqual([launcher]);
  });

  it("注意は、登録が残っていれば、という形で手で外す手順（設定の行・mise の登録とシム・入口のディレクトリ）と、書き直した・書き直せなかった入口を知らせる", () => {
    const lines = legacyNotice({
      root: "/d/sacty/mise",
      updated: ["/d/sacty/mise/1.26.0/bin/sacty"],
      failed: [{ path: "/d/sacty/mise/1.22.1/bin/sacty", error: "EACCES" }],
      first: "/d/sacty/mise/1.26.0/bin/sacty",
    });
    expect(lines[0]).toContain("登録が残っていれば");
    expect(lines[0]).toContain("mise ls sacty");
    expect(lines[0]).toContain("~/.config/mise/config.toml");
    expect(lines[0]).toContain("~/.local/share/mise/installs/sacty");
    expect(lines[0]).toContain("mise reshim");
    expect(lines[0]).toContain("/d/sacty/mise を消す");
    expect(lines[1]).toContain("/d/sacty/mise/1.26.0/bin/sacty");
    expect(lines[2]).toContain("同じ中身なので、同じに動きます");
    expect(lines[3]).toContain("EACCES");
    expect(
      legacyNotice({ root: "/d/sacty/mise", updated: [], failed: [], first: undefined }),
    ).toHaveLength(1);
  });
});

describe("main（入れる流れ）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 版を出すだけの偽のリポジトリ・仮のホーム・呼ばれたら記録する偽の mise を作り、main を別のプロセスで動かす。 */
  function install({
    legacy = false,
    legacyFirst = false,
    foreign = false,
    mismatch = false,
  }: {
    legacy?: boolean;
    legacyFirst?: boolean;
    foreign?: boolean;
    mismatch?: boolean;
  } = {}) {
    const base = mkdtempSync(join(tmpdir(), "sacty-cli-install-main-"));
    dirs.push(base);
    const repo = join(base, "repo");
    mkdirSync(join(repo, "packages", "cli", "bin"), { recursive: true });
    writeFileSync(join(repo, "packages", "cli", "package.json"), '{"version":"9.9.9"}');
    writeFileSync(
      join(repo, "packages", "cli", "bin", "sacty.js"),
      `console.log("${mismatch ? "1.0.0" : "9.9.9"}");\n`,
    );
    const home = join(base, "home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const legacyLauncher = join(home, ".local", "share", "sacty", "mise", "1.26.0", "bin", "sacty");
    if (legacy) {
      mkdirSync(join(legacyLauncher, ".."), { recursive: true });
      writeFileSync(legacyLauncher, `#!/bin/sh\n${LAUNCHER_MARK}\necho old\n`, { mode: 0o755 });
    }
    if (foreign) writeFileSync(join(bin, "sacty"), "#!/bin/sh\necho other\n", { mode: 0o755 });
    const fake = join(base, "fake");
    mkdirSync(fake);
    const miseCalls = join(base, "mise-calls");
    writeFileSync(join(fake, "mise"), `#!/bin/sh\necho "$@" >> '${miseCalls}'\n`);
    chmodSync(join(fake, "mise"), 0o755);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      PATH: [
        ...(legacyFirst ? [join(legacyLauncher, "..")] : []),
        bin,
        fake,
        process.env.PATH ?? "",
      ].join(delimiter),
      npm_config_global_prefix: join(base, "npm-prefix"),
    };
    delete env.SACTY_BIN_DIR;
    delete env.XDG_DATA_HOME;
    const script = new URL("../../scripts/cli-install.mjs", import.meta.url).href;
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { main } = await import(${JSON.stringify(script)}); main({ repo: ${JSON.stringify(repo)} });`,
      ],
      { encoding: "utf8", env },
    );
    return { run, launcher: join(bin, "sacty"), legacyLauncher, miseCalls, env };
  }

  it("mise があっても、mise を呼ばずに ~/.local/bin に入口を置く", () => {
    const { run, launcher, miseCalls, env } = install();
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("注意");
    expect(readFileSync(launcher, "utf8")).toContain(LAUNCHER_MARK);
    expect(spawnSync(launcher, ["--version"], { encoding: "utf8", env }).stdout.trim()).toBe(
      "9.9.9",
    );
    expect(existsSync(miseCalls)).toBe(false);
  });

  it("前の版が mise に登録した入口があれば、同じ中身に書き直し、手で外す手順を注意に出して、終了コード 0 で終わる", () => {
    const { run, launcher, legacyLauncher, miseCalls } = install({ legacy: true });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("登録が残っていれば");
    expect(run.stderr).toContain(legacyLauncher);
    expect(readFileSync(legacyLauncher, "utf8")).toBe(readFileSync(launcher, "utf8"));
    expect(existsSync(miseCalls)).toBe(false);
  });

  it("前の版の入口が PATH で先に見つかるときは、消すようには勧めず、同じ中身で同じに動くと知らせる", () => {
    const { run, launcher, legacyLauncher } = install({ legacy: true, legacyFirst: true });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("そちらを消すか");
    expect(run.stderr).toContain("同じ中身なので、同じに動きます");
    expect(readFileSync(legacyLauncher, "utf8")).toBe(readFileSync(launcher, "utf8"));
  });

  it("置き場所に sacty の入口でないファイルがあれば、上書きせずに終了コード 1 で終わる", () => {
    const { run, launcher } = install({ foreign: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sacty の入口でないファイル");
    expect(readFileSync(launcher, "utf8")).toContain("echo other");
  });

  it("入れた sacty の版がリポジトリの版と違えば、終了コード 1 で終わり、前の版の入口は書き直さない", () => {
    const { run, legacyLauncher } = install({ legacy: true, mismatch: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("このリポジトリの版（9.9.9）と違います");
    expect(readFileSync(legacyLauncher, "utf8")).toContain("echo old");
  });
});

describe("writeLauncher", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("前のやり方（npm link）でこのリポジトリを指すリンクは置き換え、ほかのリンク・ファイルは上書きしない", () => {
    const root = mkdtempSync(join(tmpdir(), "sacty-write-launcher-"));
    dirs.push(root);
    const entry = join(root, "repo", "sacty.js");
    mkdirSync(join(root, "repo"));
    writeFileSync(entry, "");
    const content = `#!/bin/sh\n${LAUNCHER_MARK}\n`;
    // npm のグローバルの場所が ~/.local だと、前の npm link のリンクが入口の置き場所と重なる
    const overlap = join(root, "a", "sacty");
    mkdirSync(join(root, "a"));
    symlinkSync(entry, overlap);
    expect(writeLauncher(overlap, content, entry)).toBe(true);
    expect(lstatSync(overlap).isSymbolicLink()).toBe(false);
    expect(readFileSync(overlap, "utf8")).toBe(content);
    // ほかのリポジトリを指すリンク・sacty のものでないファイルは守る
    const other = join(root, "other.js");
    writeFileSync(other, "");
    const linked = join(root, "b", "sacty");
    mkdirSync(join(root, "b"));
    symlinkSync(other, linked);
    expect(writeLauncher(linked, content, entry)).toBe(false);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    const foreign = join(root, "c", "sacty");
    mkdirSync(join(root, "c"));
    writeFileSync(foreign, "#!/bin/sh\necho other\n");
    expect(writeLauncher(foreign, content, entry)).toBe(false);
    expect(readFileSync(foreign, "utf8")).toContain("echo other");
    // 前に置いた入口（目印のあるもの）は書き直す
    expect(writeLauncher(overlap, `${content}# v2\n`, entry)).toBe(true);
    expect(readFileSync(overlap, "utf8")).toContain("# v2");
  });
});
