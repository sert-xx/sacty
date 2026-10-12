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

/** `docker build` の引数。秘密情報の値は含めない（.npmrc はファイルの場所だけを渡す）。 */
export function imageBuildArgs(input: {
  image: string;
  dockerDir: string;
  baseImage?: string;
  npmrcPath: string;
}): string[] {
  return [
    "build",
    "-t",
    input.image,
    ...(input.baseImage ? ["--build-arg", `BASE_IMAGE=${input.baseImage}`] : []),
    "--secret",
    `id=npmrc,src=${input.npmrcPath}`,
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
    const code = await deps.run(
      imageBuildArgs({
        image: deps.image,
        dockerDir: deps.dockerDir,
        ...(deps.build.baseImage ? { baseImage: deps.build.baseImage } : {}),
        npmrcPath,
      }),
    );
    return code === 0 ? undefined : imageBuildFailure(deps.build);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
