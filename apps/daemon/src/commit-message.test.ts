import { describe, expect, it } from "vitest";
import { commitSubject, detectCommitConvention } from "./commit-message.js";

/*
 * sacty が作るコミットのメッセージを、リポジトリが定める形（Conventional Commits）にする（PBI-301 A8。S5 r2）。
 */

describe("リポジトリがコミットメッセージの形を定めているかの判定", () => {
  it("Commitizen・commitlint の設定のファイルがあれば、定めている", () => {
    for (const path of [
      ".czrc",
      ".cz.json",
      ".cz.toml",
      "commitlint.config.js",
      "commitlint.config.ts",
      ".commitlintrc.json",
      ".commitlintrc.yml",
    ]) {
      expect(detectCommitConvention({ [path]: "x" }), path).toBe(true);
    }
  });

  it("package.json は、commitlint・commitizen の設定か依存があるときだけ定めているとする", () => {
    const pkg = (value: unknown) => JSON.stringify(value);
    expect(detectCommitConvention({ "package.json": pkg({ commitlint: { extends: [] } }) })).toBe(
      true,
    );
    expect(
      detectCommitConvention({ "package.json": pkg({ config: { commitizen: { path: "cz" } } }) }),
    ).toBe(true);
    expect(
      detectCommitConvention({
        "package.json": pkg({ devDependencies: { "@commitlint/cli": "^19" } }),
      }),
    ).toBe(true);
    expect(
      detectCommitConvention({ "package.json": pkg({ devDependencies: { commitizen: "^4" } }) }),
    ).toBe(true);
    expect(
      detectCommitConvention({ "package.json": pkg({ devDependencies: { vitest: "^5" } }) }),
    ).toBe(false);
    // 壊れた package.json は、定めの根拠にしない
    expect(detectCommitConvention({ "package.json": "{ commitlint" })).toBe(false);
  });

  it("AGENTS.md・CONTRIBUTING などの決まりが、Conventional Commits などに触れていれば、定めている", () => {
    expect(detectCommitConvention({ "AGENTS.md": "コミットは Conventional Commits に従う" })).toBe(
      true,
    );
    expect(
      detectCommitConvention({ "CONTRIBUTING.md": "Use commitizen (`npm run commit`)." }),
    ).toBe(true);
    expect(detectCommitConvention({ ".github/CONTRIBUTING.md": "We run commitlint in CI" })).toBe(
      true,
    );
    // feat: と fix: の両方を例に挙げている
    expect(
      detectCommitConvention({ "README.md": "コミット：`feat: 機能を足す`、`fix: 不具合を直す`" }),
    ).toBe(true);
  });

  it("定めが無い（文書に触れていない・片方の例だけ・ファイルが無い）ときは、定めていない", () => {
    expect(detectCommitConvention({})).toBe(false);
    expect(detectCommitConvention({ "README.md": "# app\n\nビルド手順" })).toBe(false);
    expect(detectCommitConvention({ "README.md": "例：`fix: 不具合を直す`" })).toBe(false);
    expect(detectCommitConvention({ "AGENTS.md": undefined, "package.json": undefined })).toBe(
      false,
    );
  });

  it("1行目の形を独自に決めている commitlint の設定は、読み解けないので定めていないものとして扱う", () => {
    expect(
      detectCommitConvention({
        "commitlint.config.js":
          "module.exports = { parserPreset: { parserOpts: { headerPattern: /x/ } } }",
      }),
    ).toBe(false);
  });

  it("commitlint の依存と独自の1行目の設定が別のファイルに両方あるときは、独自の形を優先し、種類を付けない", () => {
    const custom = "module.exports = { parserPreset: { parserOpts: { headerPattern: /x/ } } }";
    const deps = JSON.stringify({ devDependencies: { "@commitlint/cli": "^19.0.0" } });
    expect(detectCommitConvention({ "package.json": deps, "commitlint.config.js": custom })).toBe(
      false,
    );
    // 設定のファイルの順に関係なく（Commitizen の設定が先にあっても）独自の形を優先する
    expect(
      detectCommitConvention({
        ".czrc": '{ "path": "cz-conventional-changelog" }',
        ".commitlintrc.js": custom,
      }),
    ).toBe(false);
    // package.json の commitlint の項目に独自の形があるときも
    expect(
      detectCommitConvention({
        "package.json": JSON.stringify({
          commitlint: { parserPreset: { parserOpts: { headerPattern: "^(\\w+-\\d+) (.*)$" } } },
        }),
      }),
    ).toBe(false);
    // 独自の形が無ければ、依存だけでも定めている
    expect(detectCommitConvention({ "package.json": deps })).toBe(true);
    expect(
      detectCommitConvention({
        "package.json": deps,
        "commitlint.config.js": "module.exports = {}",
      }),
    ).toBe(true);
  });
});

describe("コミットの1行目", () => {
  it("定めているリポジトリでは、種類を付ける。種類ごとに feat・fix・docs", () => {
    expect(commitSubject("予約のキャンセルを足す", "feat", true)).toBe(
      "feat: 予約のキャンセルを足す",
    );
    expect(commitSubject("二重請求を直す", "fix", true)).toBe("fix: 二重請求を直す");
    expect(commitSubject("[要求要件] 予約", "docs", true)).toBe("docs: [要求要件] 予約");
  });

  it("題がすでに種類の付いた形なら、重ねて付けない", () => {
    expect(commitSubject("feat: 予約を足す", "feat", true)).toBe("feat: 予約を足す");
    expect(commitSubject("fix(api): 予約を直す", "feat", true)).toBe("fix(api): 予約を直す");
    expect(commitSubject("feat!: 互換を壊す", "feat", true)).toBe("feat!: 互換を壊す");
    // コロンが題の途中にあるだけなら、種類を付ける
    expect(commitSubject("PAY-123: 二重請求を直す", "fix", true)).toBe(
      "fix: PAY-123: 二重請求を直す",
    );
  });

  it("定めが無いリポジトリでは、今と同じにする（題のまま）", () => {
    expect(commitSubject("予約のキャンセルを足す", "feat", false)).toBe("予約のキャンセルを足す");
    expect(commitSubject("", "feat", false)).toBe("");
  });
});
