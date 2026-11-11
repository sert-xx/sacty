import { code } from "@sacty/core";
import { z } from "zod";

/**
 * 言語ごとのイメージの定義の形（PBI-41）。config.yaml の images と、コンテキストリポジトリの images.yaml（PBI-325）で
 * 同じものを使う（config.ts と context.ts の両方から読むので、どちらにも依らない場所に置く）。
 */

/** 認証の値と思われる環境変数の名前（images の env には書けない。PBI-41）。 */
const IMAGE_ENV_SECRET_NAME = /TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTH|API_?KEY|PRIVATE_KEY/i;

/**
 * images の env に書けない名前（PBI-41）。docker のコマンド自体や、sacty がエージェントに渡す設定とぶつかるため。
 */
const IMAGE_ENV_RESERVED =
  /^(?:PATH|HOME|USER|SHELL|TMPDIR|NODE_OPTIONS|(?:DOCKER|SACTY|CODEX|CLAUDE|ANTHROPIC|OPENAI|NPM_CONFIG)_\w*)$/;

/** ユーザー名・パスワードを含む URL か（https://user:pass@host のような値）。 */
export function hasUserInfo(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value);
}

/**
 * 言語ごとのイメージの1つ（PBI-41）。名前ごとに、元のイメージ（言語のツールの入った CI のイメージなど）と、
 * オーケストレーターに見せる説明を書く。config.yaml の images と、コンテキストリポジトリの images.yaml（PBI-325）で同じ形。
 */
export const LanguageImageFile = z.object({
  /** オーケストレーターに見せる説明（例 Java 17・Maven・Gradle）。 */
  description: z.string().trim().min(1).max(200),
  /** 元のイメージ（FROM）。Debian・Ubuntu 系か RHEL 系（Rocky Linux など）。 */
  base_image: z.string().trim().min(1),
  /** 作るイメージの名前。書かなければ sacty-agent-<名前>:<版>。 */
  image: z.string().trim().min(1).optional(),
  /**
   * Node.js を写す元のイメージ（元のイメージに Node.js 18 以上と npm が無いとき）。書かなければ image_build.base_image、
   * それも無ければ node:26-bookworm-slim。
   */
  node_image: z.string().trim().min(1).optional(),
  /**
   * コンテナの中の環境変数（言語ごとのレジストリなど。例 PIP_INDEX_URL・GOPROXY・GONOSUMDB）。
   * エージェントの実行とテストの実行の両方に渡す。認証の値は書けない（コンテナの中のすべてのコマンドに見えるため）。
   */
  env: z
    .record(z.string(), z.string().regex(/^[^\r\n]*$/, code("config.imageEnvName")))
    // 名前の形も、record 全体で確かめる（名前の検査は、項目ごとの文言にならないため）
    .superRefine((env, ctx) => {
      for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: code("config.imageEnvName"),
          });
        } else if (IMAGE_ENV_SECRET_NAME.test(key) || hasUserInfo(value)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: code("config.imageEnvSecret"),
          });
        } else if (IMAGE_ENV_RESERVED.test(key)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: code("config.imageEnvReserved"),
          });
        }
      }
    })
    .default({}),
  /**
   * Maven・Gradle の取得先にするリポジトリ（組織のミラー）。Maven は settings.xml の mirror、Gradle は
   * init スクリプトで、すべての Maven のリポジトリをこの URL に向ける。認証の情報は書けない。
   */
  /**
   * イメージを作るときに root で入れる OS のパッケージ（PBI-50）。dnf・microdnf・yum・apt-get のうち、元のイメージに
   * あるもので入れる（組織の rpm リポジトリなど、パッケージのリポジトリの設定は元のイメージか run で行う。無効にして
   * あるリポジトリは enable_repos で有効にする）。
   */
  packages: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+:@~=-]*$/, code("config.imagePackage")))
    .default([]),
  /**
   * packages を入れるときに有効にするパッケージのリポジトリの ID（PBI-59）。元のイメージに設定があるが無効にしてある
   * リポジトリ（組織の rpm リポジトリなど）を、dnf・microdnf・yum の --enablerepo で有効にする（apt-get では使えない）。
   * Dockerfile の RUN にそのまま展開するので、シェルの特別な文字を含まない形に限る。
   */
  enable_repos: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, code("config.imageRepo")))
    .default([]),
  /**
   * イメージを作るときに root で実行するシェルのコマンド（PBI-50。CLI の導入、Playwright の OS のライブラリなど）。
   * 上から順に実行し、失敗したら止める。イメージに残るので、秘密情報は書かない。
   */
  run: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^\r\n]*$/, code("config.imageRun")),
    )
    .default([]),
  maven_mirror: z
    .url({ protocol: /^https?$/ })
    // XML（settings.xml）と Gradle の文字列に埋め込むので、引用符などの記号を含む URL は受け付けない
    .refine((url) => !hasUserInfo(url) && /^[^\s'"<>&\\$`]+$/.test(url), code("config.mavenMirror"))
    .optional(),
});

/**
 * 言語ごとのイメージの一覧（名前ごと）。名前の形と、項目どうしの組み合わせを確かめる。
 */
export function languageImagesFile<T extends z.ZodType<z.output<typeof LanguageImageFile>>>(
  item: T,
) {
  return (
    z
      .record(z.string(), item)
      // 名前の形は record 全体で確かめる（名前の検査は、項目ごとの文言にならないため）
      .superRefine((images, ctx) => {
        for (const [name, image] of Object.entries(images)) {
          if (!/^(?!default$)[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
            ctx.addIssue({ code: "custom", path: [name], message: code("config.imageName") });
          }
          // enable_repos は packages を入れるときだけ効く（packages が無ければ、書いても何も起きないため。PBI-59）
          if (image.enable_repos.length > 0 && image.packages.length === 0) {
            ctx.addIssue({
              code: "custom",
              path: [name, "enable_repos"],
              message: code("config.imageRepoPackages"),
            });
          }
        }
      })
  );
}
