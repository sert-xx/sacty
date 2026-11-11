import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkMise,
  checkPath,
  findOnPath,
  globalPrefix,
  installWithMise,
  LAUNCHER_MARK,
  launcherDir,
  launcherScript,
  miseToolDir,
  useMise,
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

describe("mise で入れる", () => {
  it("PATH に mise があり、SACTY_BIN_DIR を指定していなければ mise を使う", () => {
    expect(useMise({ env: {}, hasMise: true })).toBe(true);
    expect(useMise({ env: {}, hasMise: false })).toBe(false);
    expect(useMise({ env: { SACTY_BIN_DIR: "/opt/bin" }, hasMise: true })).toBe(false);
  });

  it("入口は、版ごとのディレクトリ（XDG_DATA_HOME、無ければ ~/.local/share の下）に置く", () => {
    expect(miseToolDir({ version: "1.22.1", env: {}, home: "/home/u" })).toBe(
      "/home/u/.local/share/sacty/mise/1.22.1",
    );
    expect(
      miseToolDir({ version: "1.22.1", env: { XDG_DATA_HOME: "/data" }, home: "/home/u" }),
    ).toBe("/data/sacty/mise/1.22.1");
  });

  it("mise link で版を登録してから、mise use --global でその版にする。失敗したら、どのコマンドが失敗したかを返す", () => {
    const calls: string[][] = [];
    const ok = installWithMise({
      version: "1.22.1",
      dir: "/d",
      run: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(ok).toEqual({ ok: true });
    expect(calls).toEqual([
      ["link", "--force", "sacty@1.22.1", "/d"],
      ["use", "--global", "sacty@1.22.1"],
    ]);
    const failed = installWithMise({
      version: "1.22.1",
      dir: "/d",
      run: () => ({ status: 1, stderr: "unknown tool" }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("mise link --force sacty@1.22.1 /d");
    expect(failed.error).toContain("unknown tool");
  });

  it("mise が選ぶ sacty が入口でない・見つからないときは、注意にする", () => {
    const launcher = "/home/u/.local/share/sacty/mise/1.22.1/bin/sacty";
    const same = (p: string) => (p.includes("installs") ? launcher : p);
    expect(
      checkMise({ launcher, found: "/mise/installs/sacty/1.22.1/bin/sacty", resolveReal: same }),
    ).toEqual({ warnings: [] });
    expect(checkMise({ launcher, found: undefined, resolveReal: same }).warnings[0]).toContain(
      "見つけられません",
    );
    expect(
      checkMise({ launcher, found: "/other/sacty", resolveReal: (p: string) => p }).warnings[0],
    ).toContain("/other/sacty");
  });
});
