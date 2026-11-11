import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type DaemonMessage, type DaemonText, message } from "@sacty/core";
import { dockerClientEnv } from "./agents/docker.js";
import { DEFAULT_IMAGE, type LanguageImage, type SactyConfig } from "./config.js";
import type { ContextImageFile } from "./context.js";
import { errorText } from "./errors.js";
import type { ImageState } from "./image-presence.js";

/**
 * コンテキストリポジトリの images.yaml のイメージ（PBI-325）。`sacty image build` は config.yaml のイメージだけを作り、
 * コンテキストのイメージは、デーモンが起動した後に、プロジェクトごとに裏で作る。
 * - 起動のとき・プロジェクトの設定を保存したとき・一定の間隔で、コンテキストを読み直す
 * - 作るイメージの名前は、プロジェクトと定義の中身（image_build・sacty の版を含む）のハッシュで決める。中身が同じなら
 *   作り直さず、push で中身が変われば新しい名前で作る
 * - 1つずつ順に作る（Docker の負荷を抑える）。作っている途中のログの末尾を、画面に出すために持つ
 * - 作成に失敗したものは、自動では作り直さない（同じ失敗を繰り返さない）。画面の「作り直す」か、定義を直して push する
 *   （中身が変わり、新しい名前で作る）。Docker に接続できなかったものだけは、次に読み直すときに確かめ直す
 */

/** 読み直す間隔（5分）。push した定義は、遅くともこの間隔で作り始める。 */
export const CONTEXT_IMAGES_REFRESH_MS = 5 * 60_000;
/** 持つログの末尾の大きさ（文字）。 */
export const CONTEXT_IMAGE_LOG_MAX = 16 * 1024;
/** sacty が作るコンテキストのイメージの名前の頭（古いものを片付けるときに、これで見分ける）。 */
export const CONTEXT_IMAGE_REPOSITORY_PREFIX = "sacty-ctx-";

/** 作る順番待ち・作成中・作成済み・失敗。 */
export type ContextImageState = "queued" | "building" | "ready" | "failed";

/** コンテキストのイメージの1つ。 */
export type ContextImageEntry = {
  name: string;
  description: string;
  /** どの層の定義か。 */
  from: string;
  /** 作るイメージの名前（タグ）。 */
  image: string;
  /** 作るための定義（config.yaml の images と同じ形にしたもの）。 */
  language: LanguageImage;
  state: ContextImageState;
  /** 失敗の理由。 */
  error?: DaemonText;
  /** Docker に接続できずに失敗した（次に読み直すときに、確かめ直す）。 */
  retryOnRefresh?: boolean;
  /** 作成のログの末尾（作成中・作り終えたもの）。 */
  log: string;
  startedAt?: string;
  finishedAt?: string;
};

/** プロジェクトごとの、コンテキストのイメージ。 */
type ProjectImages = {
  name: string;
  /** コンテキストを読んでいる。 */
  loading: boolean;
  /** 一度でも読み終えた（読めなかったときも含む）。 */
  loaded: boolean;
  loadError?: DaemonText;
  warnings: DaemonText[];
  entries: ContextImageEntry[];
};

/** 画面に出す形（ログは末尾だけ）。 */
export type ContextImagesView = {
  projectId: string;
  projectName: string;
  loading: boolean;
  loadError?: DaemonText;
  warnings: DaemonText[];
  images: {
    name: string;
    description: string;
    from: string;
    image: string;
    state: ContextImageState;
    error?: DaemonText;
    log?: string;
    startedAt?: string;
    finishedAt?: string;
  }[];
};

export type ContextImagesDeps = {
  /** コンテキストのあるプロジェクト（使うたびに読む）。 */
  projects: () => { id: string; name: string }[];
  /** プロジェクトのコンテキストで合成したイメージ（取得の失敗は例外）。 */
  load: (
    projectId: string,
    signal: AbortSignal,
  ) => Promise<{
    images: { name: string; image: ContextImageFile; from: string }[];
    warnings: DaemonText[];
  }>;
  /** 設定。読めなければ undefined（作らない。プライベートのレジストリの指定を捨てて作らないため）。 */
  config: () => SactyConfig | undefined;
  /** イメージが手元にあるか。 */
  inspect: (image: string, signal: AbortSignal) => Promise<ImageState>;
  /** イメージを作る。出力は onOutput に渡す。失敗なら理由の文を返す。 */
  build: (
    image: LanguageImage,
    build: SactyConfig["imageBuild"],
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  /** keep 以外の、sacty が作ったコンテキストのイメージを消す（使っているものは消えなくてよい）。 */
  removeStale?: (keep: readonly string[]) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
};

/** イメージの名前に使える形にする（Docker のリポジトリの名前は英小文字・数字と区切りの記号だけ）。 */
function slug(value: string, max: number): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return cleaned || createHash("sha256").update(value).digest("hex").slice(0, max);
}

/**
 * 作るイメージの名前（PBI-325）。`sacty-ctx-<プロジェクト>-<名前>:<定義の中身のハッシュ>`。ハッシュには、定義・image_build
 * （認証の値は含めず、秘密情報の名前だけ）・sacty の版（既定のイメージの名前）を含める（どれかが変われば作り直す）。
 */
export function contextImageTag(
  projectId: string,
  name: string,
  image: ContextImageFile,
  build: SactyConfig["imageBuild"],
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: DEFAULT_IMAGE, projectId, name, image, build }))
    .digest("hex")
    .slice(0, 16);
  return `${CONTEXT_IMAGE_REPOSITORY_PREFIX}${slug(projectId, 12)}-${slug(name, 40)}:${hash}`;
}

/** 層の定義を、config.yaml の images と同じ形（作るときに使う）にする。 */
export function contextLanguageImage(
  name: string,
  tag: string,
  image: ContextImageFile,
): LanguageImage {
  return {
    name,
    image: tag,
    description: image.description,
    baseImage: image.base_image,
    ...(image.node_image ? { nodeImage: image.node_image } : {}),
    env: image.env,
    ...(image.maven_mirror ? { mavenMirror: image.maven_mirror } : {}),
    packages: image.packages,
    ...(image.enable_repos.length > 0 ? { enableRepos: image.enable_repos } : {}),
    run: image.run,
  };
}

/** ログの末尾を残す。 */
function appendTail(log: string, chunk: string): string {
  const next = log + chunk;
  return next.length > CONTEXT_IMAGE_LOG_MAX
    ? next.slice(next.length - CONTEXT_IMAGE_LOG_MAX)
    : next;
}

export class ContextImageBuilder {
  private readonly projects = new Map<string, ProjectImages>();
  private readonly refreshing = new Map<string, Promise<void>>();
  /** 状態が変わったら呼ぶ（作り終えるのを待つもの）。 */
  private readonly listeners = new Set<() => void>();
  private working: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly controller = new AbortController();

  constructor(private readonly deps: ContextImagesDeps) {}

  /** 起動のときに読み、それから一定の間隔で読み直す。 */
  start(intervalMs = CONTEXT_IMAGES_REFRESH_MS): void {
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), intervalMs);
    this.timer.unref();
  }

  /** 読み直すのをやめ、作成中の docker を止める（デーモンを止めるとき）。待っているものは返す。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    this.notify();
  }

  /**
   * コンテキストを読み直し、無いイメージを作り始める（作り終えるのは待たない）。projectId を指定すれば、そのプロジェクト
   * だけ（プロジェクトの設定を保存したとき）。コンテキストの無くなったプロジェクトは忘れる。
   */
  async refresh(projectId?: string): Promise<void> {
    if (this.controller.signal.aborted) return;
    const projects = this.deps.projects();
    const ids = new Set(projects.map((p) => p.id));
    for (const id of [...this.projects.keys()]) {
      if (!ids.has(id)) this.projects.delete(id);
    }
    const targets = projectId ? projects.filter((p) => p.id === projectId) : projects;
    if (projectId && targets.length === 0) this.projects.delete(projectId);
    this.notify();
    // コンテキストの取得は、プロジェクトごとに順に（同じプロジェクトを重ねて読まない）
    for (const project of targets) await this.refreshProject(project.id, project.name);
    this.kick();
  }

  /** プロジェクトの、コンテキストのイメージ（config.yaml と同じ名前のものは含まない）。 */
  images(projectId: string): readonly ContextImageEntry[] {
    return this.projects.get(projectId)?.entries ?? [];
  }

  /** プロジェクトのコンテキストを読んでいる・読む前か、作る順番待ち・作成中のイメージがあるか。 */
  pending(projectId: string): boolean {
    if (!this.deps.projects().some((p) => p.id === projectId)) return false;
    const project = this.projects.get(projectId);
    if (!project) return !this.controller.signal.aborted;
    return (
      project.loading ||
      !project.loaded ||
      project.entries.some((e) => e.state === "queued" || e.state === "building")
    );
  }

  /** プロジェクトのイメージを作り終えるまで待つ（上限まで）。止めたら、その時点で返す。 */
  async settled(
    projectId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"settled" | "timeout" | "stopped"> {
    if (!this.pending(projectId)) return "settled";
    return new Promise((done) => {
      const finish = (result: "settled" | "timeout" | "stopped") => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener("abort", onAbort);
        done(result);
      };
      const check = () => {
        if (this.controller.signal.aborted) finish("stopped");
        else if (!this.pending(projectId)) finish("settled");
      };
      const onAbort = () => finish("stopped");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref?.();
      this.listeners.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 失敗したイメージを作り直す（画面の「作り直す」）。失敗していないもの・無いものは、理由を返す。 */
  rebuild(projectId: string, name: string): { ok: true } | { ok: false; message: DaemonMessage } {
    const entry = this.projects.get(projectId)?.entries.find((e) => e.name === name);
    if (!entry) return { ok: false, message: message("contextImage.notFound", { name }) };
    if (entry.state !== "failed") {
      return { ok: false, message: message("contextImage.notFailed", { name }) };
    }
    entry.state = "queued";
    delete entry.error;
    delete entry.retryOnRefresh;
    delete entry.startedAt;
    delete entry.finishedAt;
    entry.log = "";
    this.notify();
    this.kick();
    return { ok: true };
  }

  /** 画面に出す形。コンテキストのイメージの無いプロジェクトは出さない（読めなかったものは出す）。 */
  view(): ContextImagesView[] {
    return [...this.projects.entries()]
      .filter(([, p]) => p.entries.length > 0 || p.loadError || p.warnings.length > 0)
      .map(([projectId, p]) => ({
        projectId,
        projectName: p.name,
        loading: p.loading,
        ...(p.loadError ? { loadError: p.loadError } : {}),
        warnings: p.warnings,
        images: p.entries.map((e) => ({
          name: e.name,
          description: e.description,
          from: e.from,
          image: e.image,
          state: e.state,
          ...(e.error ? { error: e.error } : {}),
          ...(e.log ? { log: e.log } : {}),
          ...(e.startedAt ? { startedAt: e.startedAt } : {}),
          ...(e.finishedAt ? { finishedAt: e.finishedAt } : {}),
        })),
      }));
  }

  /** 作り終えるまで待つ（テスト・片付けのため）。 */
  async idle(): Promise<void> {
    while (this.working || this.refreshing.size > 0) {
      await Promise.all([this.working, ...this.refreshing.values()]);
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private refreshProject(id: string, name: string): Promise<void> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const work = this.load(id, name).finally(() => {
      this.refreshing.delete(id);
      this.notify();
    });
    this.refreshing.set(id, work);
    return work;
  }

  private async load(id: string, name: string): Promise<void> {
    const signal = this.controller.signal;
    const project: ProjectImages = this.projects.get(id) ?? {
      name,
      loading: true,
      loaded: false,
      warnings: [],
      entries: [],
    };
    project.name = name;
    project.loading = true;
    this.projects.set(id, project);
    this.notify();
    const config = this.deps.config();
    if (!config) {
      // 設定を読めなければ作らない（設定の誤りは、別に知らせている）。待たせないよう、読み終えたことにする
      project.loading = false;
      project.loaded = true;
      return;
    }
    let loaded: Awaited<ReturnType<ContextImagesDeps["load"]>>;
    try {
      loaded = await this.deps.load(id, signal);
    } catch (error) {
      // 読めなければ、前に読んだもの（あれば）を使い続ける
      project.loadError = message("contextImage.loadFailed", {
        project: name,
        detail: errorText(error),
      });
      project.loading = false;
      project.loaded = true;
      this.deps.log?.(`[daemon] context images (project "${name}" [${id}]): load failed`);
      return;
    }
    if (signal.aborted) return;
    const warnings = [...loaded.warnings];
    const previous = new Map(project.entries.map((e) => [e.image, e]));
    const entries: ContextImageEntry[] = [];
    const toInspect: ContextImageEntry[] = [];
    for (const item of loaded.images) {
      // config.yaml の images と同じ名前なら、config.yaml のものを使う（gateway.mcp_servers と mcp.yaml と同じ）
      if (config.images?.[item.name]) {
        warnings.push(message("contextImage.configOverride", { project: name, name: item.name }));
        continue;
      }
      const tag = contextImageTag(id, item.name, item.image, config.imageBuild);
      const kept = previous.get(tag);
      if (kept) {
        kept.from = item.from;
        entries.push(kept);
        if (kept.state === "failed" && kept.retryOnRefresh) toInspect.push(kept);
        continue;
      }
      const entry: ContextImageEntry = {
        name: item.name,
        description: item.image.description,
        from: item.from,
        image: tag,
        language: contextLanguageImage(item.name, tag, item.image),
        // 手元にあるかを確かめるまでは、順番待ちとして扱う（作り始めるのは確かめた後）
        state: "queued",
        log: "",
      };
      entries.push(entry);
      toInspect.push(entry);
    }
    await Promise.all(
      toInspect.map(async (entry) => {
        const state = await this.deps.inspect(entry.image, signal);
        if (state === "present") {
          entry.state = "ready";
          delete entry.error;
          delete entry.retryOnRefresh;
        } else if (state === "unreachable") {
          entry.state = "failed";
          entry.error = message("image.dockerUnreachable");
          entry.retryOnRefresh = true;
        } else {
          entry.state = "queued";
          delete entry.error;
          delete entry.retryOnRefresh;
        }
      }),
    );
    if (signal.aborted) return;
    project.entries = entries;
    project.warnings = warnings;
    delete project.loadError;
    project.loading = false;
    project.loaded = true;
  }

  /** 順番待ちのものを、1つずつ作る（作っている途中なら、その続きで作る）。 */
  private kick(): void {
    if (this.working || this.controller.signal.aborted) return;
    this.working = this.work().finally(() => {
      this.working = undefined;
    });
  }

  private next(): { projectId: string; entry: ContextImageEntry } | undefined {
    for (const [projectId, project] of this.projects) {
      // 読み直している途中のものは、読み終えてから作る（古い定義で作らない）
      if (this.refreshing.has(projectId)) continue;
      const entry = project.entries.find((e) => e.state === "queued");
      if (entry) return { projectId, entry };
    }
    return undefined;
  }

  private async work(): Promise<void> {
    const signal = this.controller.signal;
    for (let next = this.next(); next && !signal.aborted; next = this.next()) {
      const { projectId, entry } = next;
      const config = this.deps.config();
      if (!config) return;
      entry.state = "building";
      entry.log = "";
      entry.startedAt = this.now();
      delete entry.finishedAt;
      this.notify();
      const projectName = this.projects.get(projectId)?.name ?? projectId;
      this.deps.log?.(
        `[daemon] context image "${entry.name}" (project "${projectName}"): building ${entry.image}`,
      );
      let failure: DaemonText | undefined;
      try {
        const detail = await this.deps.build(
          entry.language,
          config.imageBuild,
          (chunk) => {
            entry.log = appendTail(entry.log, chunk);
          },
          signal,
        );
        if (detail) failure = message("contextImage.buildFailed", { detail });
      } catch (error) {
        failure = errorText(error);
      }
      if (signal.aborted) return;
      entry.finishedAt = this.now();
      if (failure) {
        entry.state = "failed";
        entry.error = failure;
      } else {
        entry.state = "ready";
      }
      this.deps.log?.(
        `[daemon] context image "${entry.name}" (project "${projectName}"): ${entry.state}`,
      );
      this.notify();
    }
    await this.prune();
  }

  /** 使っていない、sacty が作ったコンテキストのイメージを消す。読めなかったプロジェクトがあれば消さない。 */
  private async prune(): Promise<void> {
    if (!this.deps.removeStale || this.controller.signal.aborted) return;
    const projects = [...this.projects.values()];
    if (projects.some((p) => p.loadError || !p.loaded || p.loading)) return;
    if (this.refreshing.size > 0) return;
    const keep = projects.flatMap((p) => p.entries.map((e) => e.image));
    try {
      await this.deps.removeStale(keep);
    } catch {
      // 片付けられなくても、作成には関わらない
    }
  }
}

/**
 * docker を動かして、出力（標準出力と標準エラー出力）を onOutput に渡す。signal で打ち切ると止める。終了コードを返す
 * （起動できなければ例外）。
 */
export function runDockerStreaming(
  args: string[],
  onOutput: (chunk: string) => void,
  signal?: AbortSignal,
  spawnImpl: typeof spawn = spawn,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(1);
      return;
    }
    const child = spawnImpl("docker", args, {
      env: dockerClientEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => onOutput(String(chunk)));
    child.stderr?.on("data", (chunk) => onOutput(String(chunk)));
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(code ?? 1);
    });
  });
}

/** keep 以外の、sacty が作ったコンテキストのイメージ（名前の頭が sacty-ctx-）を消す。 */
export async function removeStaleContextImages(
  keep: readonly string[],
  run: (args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<string[]> {
  const list = await run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (list.code !== 0) return [];
  const stale = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (image) => image.startsWith(CONTEXT_IMAGE_REPOSITORY_PREFIX) && !image.endsWith(":<none>"),
    )
    .filter((image) => !keep.includes(image));
  const removed: string[] = [];
  for (const image of stale) {
    // 使っているコンテナがあれば消えない（強制では消さない）
    const { code } = await run(["image", "rm", image]);
    if (code === 0) removed.push(image);
  }
  return removed;
}
