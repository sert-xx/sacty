import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonText } from "@sacty/core";
import { type ConfigResult, DEFAULT_IMAGE, type SactyConfig } from "./config.js";
import type { SecretStore } from "./secrets.js";

/**
 * `sacty image build`（PBI-33）。config.yaml の image_build に従い、元のイメージ（FROM）と npm のレジストリを
 * 変えてイメージを作る。npm の認証は .npmrc を一時ファイルに書き、BuildKit の secret でビルドのときだけ読ませる
 * （イメージの層・履歴・ビルドの引数には残さない）。一時ファイルは終わったら必ず消す。
 */

/**
 * 設定から、作るイメージの名前と元を決める（PBI-33）。設定ファイルがまだ無ければ既定で作る。設定ファイルに
 * 誤りがあれば作らない（プライベートのレジストリの指定を捨てて、公開のレジストリ・既定の名前で作らないため）。
 */
export function imageBuildSettings(
  config: ConfigResult,
):
  | { ok: true; image: string; build: SactyConfig["imageBuild"] }
  | { ok: false; problem: DaemonText } {
  if (config.ok) return { ok: true, image: config.config.image, build: config.config.imageBuild };
  const missing = typeof config.problem !== "string" && config.problem.code === "config.missing";
  return missing ? { ok: true, image: DEFAULT_IMAGE, build: {} } : config;
}

/** npm の設定（.npmrc）。レジストリと、そのレジストリへの認証トークン。 */
export function npmrcContent(registry: string | undefined, token: string | undefined): string {
  const lines: string[] = [];
  if (registry) lines.push(`registry=${registry}`);
  if (token) {
    // トークンは、レジストリのホストとパスに結びつける（ほかのホストには送られない）
    const url = new URL(registry ?? "https://registry.npmjs.org/");
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    lines.push(`//${url.host}${path}:_authToken=${token}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * イメージの中の npm 全体の設定（global の npmrc。PBI-40）。npm_registry があれば、コンテナの中の npm の registry にも
 * する（npm_config の registry があれば、そちらを優先）。トークンは含めない（イメージに残るため）。
 */
export function npmGlobalConfigContent(build: {
  npmRegistry?: string;
  npmConfig?: Record<string, string>;
}): string {
  const config = {
    ...(build.npmRegistry ? { registry: build.npmRegistry } : {}),
    ...build.npmConfig,
  };
  const lines = Object.entries(config).map(([key, value]) => `${key}=${value}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** `docker build` の引数。秘密情報の値は含めない（.npmrc はファイルの場所だけを渡す）。 */
export function imageBuildArgs(input: {
  image: string;
  dockerDir: string;
  baseImage?: string;
  npmrcPath: string;
  /** イメージに入れる npm の版（PBI-40）。 */
  npmVersion?: string;
  /** イメージの中の npm 全体の設定（npmrc）のファイル（PBI-40）。 */
  npmConfigPath: string;
  /**
   * npm 全体の設定の中身のハッシュ。secret の中身はビルドのキャッシュの判定に入らないので、これを引数で渡し、
   * 設定を変えたら作り直させる（PBI-40）。
   */
  npmConfigHash: string;
}): string[] {
  return [
    "build",
    "-t",
    input.image,
    ...(input.baseImage ? ["--build-arg", `BASE_IMAGE=${input.baseImage}`] : []),
    ...(input.npmVersion ? ["--build-arg", `NPM_VERSION=${input.npmVersion}`] : []),
    "--build-arg",
    `NPM_CONFIG_HASH=${input.npmConfigHash}`,
    "--secret",
    `id=npmrc,src=${input.npmrcPath}`,
    // --build-context は Docker の構成によっては使えないので、認証の .npmrc と同じ secret の仕組みで渡す
    "--secret",
    `id=npmconfig,src=${input.npmConfigPath}`,
    input.dockerDir,
  ];
}

/** 失敗したときに、確かめることを示す文。 */
export function imageBuildFailure(build: SactyConfig["imageBuild"]): string {
  const hints = [
    "Docker が起動しているか",
    `元のイメージ（${build.baseImage ?? "Docker Hub の node:22-bookworm-slim"}）を取得できるか`,
    `npm のレジストリ（${build.npmRegistry ?? "https://registry.npmjs.org/"}）に届くか${build.npmToken ? "・認証トークンが正しいか" : ""}`,
    "元のイメージに git が無い場合は、Debian のミラーに届くか",
  ];
  return `イメージを作成できませんでした。上のログで原因を確認してください。確かめること：${hints.join("、")}。`;
}

/**
 * イメージを作る。run は docker を実行して終了コードを返す（テストでは差し替える）。
 * 成功なら undefined、失敗なら理由の文を返す。
 */
export async function buildImage(deps: {
  image: string;
  build: SactyConfig["imageBuild"];
  dockerDir: string;
  secrets: SecretStore;
  run: (args: string[]) => Promise<number>;
}): Promise<string | undefined> {
  const token = deps.build.npmToken ? await deps.secrets.get(deps.build.npmToken) : undefined;
  const dir = mkdtempSync(join(tmpdir(), "sacty-image-"));
  try {
    const npmrcPath = join(dir, "npmrc");
    writeFileSync(npmrcPath, npmrcContent(deps.build.npmRegistry, token), { mode: 0o600 });
    // イメージに残す npm 全体の設定は、認証の .npmrc とは別のディレクトリに置く（PBI-40）
    const npmConfigPath = join(dir, "npmconfig");
    const npmConfig = npmGlobalConfigContent(deps.build);
    writeFileSync(npmConfigPath, npmConfig);
    const code = await deps.run(
      imageBuildArgs({
        image: deps.image,
        dockerDir: deps.dockerDir,
        ...(deps.build.baseImage ? { baseImage: deps.build.baseImage } : {}),
        ...(deps.build.npmVersion ? { npmVersion: deps.build.npmVersion } : {}),
        npmrcPath,
        npmConfigPath,
        npmConfigHash: createHash("sha256").update(npmConfig).digest("hex").slice(0, 16),
      }),
    );
    return code === 0 ? undefined : imageBuildFailure(deps.build);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
