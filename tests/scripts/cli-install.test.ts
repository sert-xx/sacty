import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLink, findOnPath, globalPrefix } from "../../scripts/cli-install.mjs";

const expected = "/repo/packages/cli/bin/sacty.js";
const globalBin = "/usr/local/bin/sacty";

describe("checkLink", () => {
  it("グローバルの bin と PATH の sacty がこのリポジトリを指せば、誤りも注意も無い", () => {
    const resolveReal = () => expected;
    expect(checkLink({ expected, globalBin, onPath: globalBin, resolveReal })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("グローバルの bin がこのリポジトリを指さなければ誤りにする（前の clone のまま・別のパッケージ）", () => {
    const resolveReal = () => "/old/packages/cli/bin/sacty.js";
    const result = checkLink({ expected, globalBin, onPath: globalBin, resolveReal });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("/old/packages/cli/bin/sacty.js");
  });

  it("PATH に無い・PATH で先に別の sacty が見つかるときは、注意にする", () => {
    const missing = checkLink({
      expected,
      globalBin,
      onPath: undefined,
      resolveReal: () => expected,
    });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings[0]).toContain("PATH にありません");
    const shadowed = checkLink({
      expected,
      globalBin,
      onPath: "/opt/other/sacty",
      resolveReal: (p: string) => (p === globalBin ? expected : p),
    });
    expect(shadowed.errors).toEqual([]);
    expect(shadowed.warnings[0]).toContain("/opt/other/sacty");
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
