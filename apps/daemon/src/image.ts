import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonText } from "@sacty/core";
import {
  type ConfigResult,
  DEFAULT_IMAGE,
  DEFAULT_IMAGE_NAME,
  type LanguageImage,
  type SactyConfig,
} from "./config.js";
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
export function imageBuildSettings(config: ConfigResult):
  | {
      ok: true;
      image: string;
      build: SactyConfig["imageBuild"];
      /** 言語ごとのイメージ（PBI-41）。 */
      images: Record<string, LanguageImage>;
    }
  | { ok: false; problem: DaemonText } {
  if (config.ok) {
    return {
      ok: true,
      image: config.config.image,
      build: config.config.imageBuild,
      images: config.config.images ?? {},
    };
  }
  const missing = typeof config.problem !== "string" && config.problem.code === "config.missing";
  return missing ? { ok: true, image: DEFAULT_IMAGE, build: {}, images: {} } : config;
}

/**
 * `sacty image build [名前...]` で作るイメージ（PBI-41）。名前を指定しなければ、既定のイメージと、images に書いた
 * すべての言語ごとのイメージ。default は既定のイメージ。images に無い名前があれば、作らずにその名前を返す。
 */
export function imageBuildTargets(
  images: Record<string, LanguageImage>,
  names: readonly string[],
): { ok: true; targets: (LanguageImage | undefined)[] } | { ok: false; unknown: string[] } {
  if (names.length === 0) return { ok: true, targets: [undefined, ...Object.values(images)] };
  const unknown = names.filter((name) => name !== DEFAULT_IMAGE_NAME && !images[name]);
  if (unknown.length > 0) return { ok: false, unknown };
  return {
    ok: true,
    targets: [...new Set(names)].map((name) =>
      name === DEFAULT_IMAGE_NAME ? undefined : images[name],
    ),
  };
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
  /**
   * 言語ごとのイメージ（PBI-41）。Node.js の入っていない元のイメージに、nodeImage から Node.js を写し、
   * mavenMirror があれば Maven・Gradle の取得先をそこに向ける。
   */
  language?: { nodeImage?: string; mavenMirror?: string };
  /**
   * イメージを作るときに入れる OS のパッケージと、実行するコマンド（PBI-50）。コマンドは、ファイル（setupPath）に
   * 書いて secret の仕組みで渡し、中身のハッシュ（パッケージを含む）で作り直させる。enableRepos は、パッケージを
   * 入れるときに有効にするリポジトリ（PBI-59）。
   */
  setup: {
    packages: readonly string[];
    enableRepos?: readonly string[];
    path: string;
    hash: string;
  };
  /** draw.io の CLI を入れないとき false（image_build.drawio）。 */
  drawio?: false;
}): string[] {
  return [
    "build",
    "-t",
    input.image,
    ...(input.baseImage ? ["--build-arg", `BASE_IMAGE=${input.baseImage}`] : []),
    ...(input.language
      ? [
          "--build-arg",
          "BASE_KIND=lang",
          ...(input.language.nodeImage
            ? ["--build-arg", `NODE_IMAGE=${input.language.nodeImage}`]
            : []),
          ...(input.language.mavenMirror
            ? ["--build-arg", `MAVEN_MIRROR=${input.language.mavenMirror}`]
            : []),
        ]
      : []),
    ...(input.npmVersion ? ["--build-arg", `NPM_VERSION=${input.npmVersion}`] : []),
    ...(input.drawio === false ? ["--build-arg", "SACTY_DRAWIO=0"] : []),
    "--build-arg",
    `NPM_CONFIG_HASH=${input.npmConfigHash}`,
    "--secret",
    `id=npmrc,src=${input.npmrcPath}`,
    // --build-context は Docker の構成によっては使えないので、認証の .npmrc と同じ secret の仕組みで渡す
    "--secret",
    `id=npmconfig,src=${input.npmConfigPath}`,
    ...(input.setup.packages.length > 0
      ? ["--build-arg", `SACTY_PACKAGES=${input.setup.packages.join(" ")}`]
      : []),
    ...(input.setup.enableRepos && input.setup.enableRepos.length > 0
      ? ["--build-arg", `SACTY_ENABLE_REPOS=${input.setup.enableRepos.join(" ")}`]
      : []),
    "--build-arg",
    `SACTY_SETUP_HASH=${input.setup.hash}`,
    "--secret",
    `id=setup,src=${input.setup.path}`,
    input.dockerDir,
  ];
}

/** 失敗したときに、確かめることを示す文。 */
export function imageBuildFailure(
  build: SactyConfig["imageBuild"],
  language?: LanguageImage,
): string {
  const node = build.baseImage ?? "Docker Hub の node:26-bookworm-slim";
  const hints = [
    "Docker が起動しているか",
    ...(language
      ? [
          `元のイメージ（${language.baseImage}）と、Node.js を写すイメージ（${language.nodeImage ?? node}）を取得できるか`,
          "元のイメージが Debian・Ubuntu 系か RHEL 系（glibc）で、git が入っているか、パッケージのミラーに届くか",
        ]
      : [`元のイメージ（${node}）を取得できるか`]),
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
  /** 言語ごとのイメージを作るとき（PBI-41）。npm の設定は image_build のものを使う。 */
  language?: LanguageImage;
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
    const language = deps.language;
    // イメージを作るときに実行するコマンド（PBI-50）。上から順に実行し、失敗したら止める（sh -e）
    const setupPath = join(dir, "setup.sh");
    const setupScript = (language?.run ?? []).map((line) => `${line}\n`).join("");
    writeFileSync(setupPath, setupScript);
    const packages = language?.packages ?? [];
    const enableRepos = language?.enableRepos ?? [];
    // 有効にするリポジトリを変えても作り直させる（PBI-59）。書かなければ、これまでと同じハッシュ
    const setupHash = createHash("sha256")
      .update(
        JSON.stringify({
          packages,
          setupScript,
          ...(enableRepos.length > 0 ? { enableRepos } : {}),
        }),
      )
      .digest("hex")
      .slice(0, 16);
    const baseImage = language ? language.baseImage : deps.build.baseImage;
    // Node.js を写す元は、指定が無ければ既定のイメージの元（プライベートのレジストリの node のイメージなど）
    const nodeImage = language?.nodeImage ?? deps.build.baseImage;
    const code = await deps.run(
      imageBuildArgs({
        image: language ? language.image : deps.image,
        dockerDir: deps.dockerDir,
        ...(baseImage ? { baseImage } : {}),
        ...(language
          ? {
              language: {
                ...(nodeImage ? { nodeImage } : {}),
                ...(language.mavenMirror ? { mavenMirror: language.mavenMirror } : {}),
              },
            }
          : {}),
        ...(deps.build.npmVersion ? { npmVersion: deps.build.npmVersion } : {}),
        npmrcPath,
        npmConfigPath,
        npmConfigHash: createHash("sha256").update(npmConfig).digest("hex").slice(0, 16),
        setup: { packages, enableRepos, path: setupPath, hash: setupHash },
        ...(deps.build.drawio === false ? { drawio: false as const } : {}),
      }),
    );
    return code === 0 ? undefined : imageBuildFailure(deps.build, language);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** sacty が版ごとに作るイメージの名前（既定のイメージと、言語ごとのイメージの既定の名前）。 */
const SACTY_IMAGE_REPOSITORY = /^sacty-agent(-[a-z0-9._-]+)?$/;
/** 版のタグ。これ以外のタグ（latest・試しに付けた名前など）は人が付けたものとして残す。 */
const VERSION_TAG = /^(\d+)\.(\d+)\.(\d+)$/;
/** 名前ごとに残す版の数。今の版と、戻すときの1つ前の版。 */
const KEPT_IMAGE_VERSIONS = 2;
/** これより長く使っていないビルドキャッシュを消す。イメージを消しても、層はキャッシュに残るため。 */
const BUILD_CACHE_MAX_UNUSED = "168h";

/**
 * 消してよい古い版のイメージ（PBI-313）。listed は `repository:tag` の一覧。sacty の名前で版のタグのものを、
 * 名前ごとに新しい版から KEPT_IMAGE_VERSIONS 個残す。kept（今回作ったもの・設定が指すもの）は必ず残す。
 */
export function staleImages(listed: readonly string[], kept: readonly string[]): string[] {
  const byRepository = new Map<string, { image: string; version: number[] }[]>();
  for (const image of new Set(listed)) {
    const separator = image.lastIndexOf(":");
    const repository = image.slice(0, separator);
    const version = VERSION_TAG.exec(image.slice(separator + 1));
    if (!version || !SACTY_IMAGE_REPOSITORY.test(repository)) continue;
    const versions = byRepository.get(repository) ?? [];
    versions.push({ image, version: version.slice(1).map(Number) });
    byRepository.set(repository, versions);
  }
  return [...byRepository.values()].flatMap((versions) =>
    versions
      .sort(
        (a, b) =>
          (b.version[0] ?? 0) - (a.version[0] ?? 0) ||
          (b.version[1] ?? 0) - (a.version[1] ?? 0) ||
          (b.version[2] ?? 0) - (a.version[2] ?? 0),
      )
      .slice(KEPT_IMAGE_VERSIONS)
      .map(({ image }) => image)
      .filter((image) => !kept.includes(image)),
  );
}

/**
 * 古い版のイメージと、使っていないビルドキャッシュを消す（PBI-313）。作成は済んでいるので、失敗しても例外にせず、
 * 結果で返す。コンテナが使っているイメージは強制では消さない（消せなかったものとして返す）。
 */
export async function pruneOldImages(deps: {
  kept: readonly string[];
  /** docker を実行して、終了コードと標準出力を返す（テストでは差し替える）。 */
  run: (args: string[]) => Promise<{ code: number; stdout: string }>;
}): Promise<{ removed: string[]; failed: string[]; listFailed: boolean; cacheFailed: boolean }> {
  const list = await deps.run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]);
  const removed: string[] = [];
  const failed: string[] = [];
  if (list.code === 0) {
    for (const image of staleImages(list.stdout.split("\n"), deps.kept)) {
      const { code } = await deps.run(["image", "rm", image]);
      (code === 0 ? removed : failed).push(image);
    }
  }
  const cache = await deps.run([
    "builder",
    "prune",
    "-f",
    "--filter",
    `until=${BUILD_CACHE_MAX_UNUSED}`,
  ]);
  return { removed, failed, listFailed: list.code !== 0, cacheFailed: cache.code !== 0 };
}
