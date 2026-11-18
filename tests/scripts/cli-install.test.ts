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
  removeMiseRegistration,
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

describe("前の版が mise に登録した sacty を外す", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 前の版の入口（root/1.22.1/bin/sacty）と、それを指す mise の登録のリンク（installs/1.22.1）を作る。 */
  function setup() {
    const base = mkdtempSync(join(tmpdir(), "sacty-legacy-mise-"));
    dirs.push(base);
    const root = join(base, "sacty", "mise");
    mkdirSync(join(root, "1.22.1", "bin"), { recursive: true });
    writeFileSync(join(root, "1.22.1", "bin", "sacty"), `#!/bin/sh\n${LAUNCHER_MARK}\n`);
    const installs = join(base, "installs");
    mkdirSync(installs);
    const link = join(installs, "1.22.1");
    symlinkSync(join(root, "1.22.1"), link);
    return { root, link };
  }

  it("前の版の入口のディレクトリは、XDG_DATA_HOME、無ければ ~/.local/share の下の sacty/mise", () => {
    expect(legacyMiseRoot({ env: {}, home: "/home/u" })).toBe("/home/u/.local/share/sacty/mise");
    expect(legacyMiseRoot({ env: { XDG_DATA_HOME: "/data" }, home: "/home/u" })).toBe(
      "/data/sacty/mise",
    );
  });

  it("前の版の入口が無ければ、mise を呼ばずに何もしない", () => {
    const calls: string[][] = [];
    const result = removeMiseRegistration({
      root: join(tmpdir(), "sacty-legacy-mise-none", "sacty", "mise"),
      hasMise: true,
      run: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(result).toEqual({ status: "none" });
    expect(calls).toEqual([]);
  });

  it("mise の設定から sacty を外し、入口を指す登録のリンクと、入口のディレクトリを消す", () => {
    const { root, link } = setup();
    const calls: string[][] = [];
    const result = removeMiseRegistration({
      root,
      hasMise: true,
      run: (_command: string, args: string[]) => {
        calls.push(args);
        return args[0] === "where" ? { status: 0, stdout: `${link}\n` } : { status: 0 };
      },
    });
    expect(result).toEqual({ status: "removed" });
    expect(calls).toEqual([
      ["where", "sacty@1.22.1"],
      ["unuse", "--global", "sacty"],
    ]);
    expect(existsSync(root)).toBe(false);
    expect(() => lstatSync(link)).toThrow();
  });

  it("mise の登録が入口でない場所（ほかの方法で入れた sacty）なら、その登録は消さない", () => {
    const { root, link } = setup();
    const other = join(root, "..", "other");
    mkdirSync(other);
    const result = removeMiseRegistration({
      root,
      hasMise: true,
      run: (_command: string, args: string[]) =>
        args[0] === "where" ? { status: 0, stdout: `${other}\n` } : { status: 0 },
    });
    expect(result).toEqual({ status: "removed" });
    expect(existsSync(other)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("設定から外せない・mise が無いときは、何も消さずに理由を返す", () => {
    const { root, link } = setup();
    const failed = removeMiseRegistration({
      root,
      hasMise: true,
      run: (_command: string, args: string[]) =>
        args[0] === "where"
          ? { status: 0, stdout: `${link}\n` }
          : { status: 1, stderr: "no such tool" },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("mise unuse --global sacty");
    expect(failed.error).toContain("no such tool");
    const noMise = removeMiseRegistration({
      root,
      hasMise: false,
      run: () => {
        throw new Error("mise を呼ばない");
      },
    });
    expect(noMise.status).toBe("failed");
    expect(existsSync(join(root, "1.22.1", "bin", "sacty"))).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
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
