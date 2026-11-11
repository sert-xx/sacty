import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type DaemonMessage, type DaemonText, message } from "@sacty/core";
import { dockerClientEnv } from "./agents/docker.js";
import { DEFAULT_IMAGE, type LanguageImage, type SactyConfig } from "./config.js";
import type { ContextImageFile } from "./context.js";
import { errorText, MessageError } from "./errors.js";
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
/**
 * 1つのイメージを作るのを待つ上限（60分）。Docker やレジストリが応答しないと、1つずつ作るので後のすべてが作られないため、
 * 過ぎたら止めて失敗にする。
 */
export const CONTEXT_IMAGE_BUILD_TIMEOUT_MS = 60 * 60_000;
/**
 * 1つのプロジェクトのコンテキストを読むのを待つ上限（5分）。git の取得が応答しないと、後のプロジェクトを読めず作り始めない
 * ため、過ぎたら止めて読めなかったことにする。
 */
export const CONTEXT_IMAGES_LOAD_TIMEOUT_MS = 5 * 60_000;

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
  /** 名前（ハッシュ）を決めたときの image_build。作るときも、これを使う（名前と中身を一致させる）。 */
  build: SactyConfig["imageBuild"];
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
  removeStale?: (keep: readonly string[], prefix: string) => Promise<void>;
  /**
   * イメージの名前に入れる、このデーモンの印（SACTY_HOME から作る）。同じ Docker を使う別の SACTY_HOME のデーモンのイメージを、
   * 片付けで消さないように、名前で見分ける。
   */
  owner?: string;
  /** 1つのイメージを作るのを待つ上限（ミリ秒）。無ければ CONTEXT_IMAGE_BUILD_TIMEOUT_MS。 */
  buildTimeoutMs?: number;
  /** 1つのプロジェクトのコンテキストを読むのを待つ上限（ミリ秒）。無ければ CONTEXT_IMAGES_LOAD_TIMEOUT_MS。 */
  loadTimeoutMs?: number;
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

/** このデーモンが作るコンテキストのイメージの名前の頭（owner があれば `sacty-ctx-<owner>-`）。 */
export function contextImagePrefix(owner?: string): string {
  return owner
    ? `${CONTEXT_IMAGE_REPOSITORY_PREFIX}${slug(owner, 12)}-`
    : CONTEXT_IMAGE_REPOSITORY_PREFIX;
}

/**
 * 作るイメージの名前（PBI-325）。`sacty-ctx-[<デーモンの印>-]<プロジェクト>-<名前>:<定義の中身のハッシュ>`。ハッシュには、
 * 定義・image_build（認証の値は含めず、秘密情報の名前だけ）・sacty の版（既定のイメージの名前）を含める（どれかが変われば
 * 作り直す）。
 */
export function contextImageTag(
  projectId: string,
  name: string,
  image: ContextImageFile,
  build: SactyConfig["imageBuild"],
  owner?: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: DEFAULT_IMAGE, projectId, name, image, build }))
    .digest("hex")
    .slice(0, 16);
  return `${contextImagePrefix(owner)}${slug(projectId, 12)}-${slug(name, 40)}:${hash}`;
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
  /** 片付けている途中（その間は、手元にあるかを確かめず、片付け終えてから確かめる）。 */
  private pruning: Promise<void> | undefined;
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
      loaded = await this.loadWithTimeout(id);
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
    // 片付けている途中なら、終えてから確かめる（片付けが、確かめた後のイメージを消さないように）
    while (this.pruning) await this.pruning;
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
      const tag = contextImageTag(id, item.name, item.image, config.imageBuild, this.deps.owner);
      const kept = previous.get(tag);
      if (kept) {
        kept.from = item.from;
        entries.push(kept);
        // 作成済みのものも、消えていないかを確かめ直す（docker image prune などで消えたら、作り直す）
        if (kept.state === "ready" || (kept.state === "failed" && kept.retryOnRefresh)) {
          toInspect.push(kept);
        }
        continue;
      }
      const entry: ContextImageEntry = {
        name: item.name,
        description: item.image.description,
        from: item.from,
        image: tag,
        language: contextLanguageImage(item.name, tag, item.image),
        build: config.imageBuild,
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
        // 作成済みのものは、無くなったときだけ作り直す（確かめられないときは、そのまま）
        if (entry.state === "ready") {
          if (state === "missing") entry.state = "queued";
          return;
        }
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
      // 片付けている間に、読み直し・作り直しで順番待ちが増えていれば、続けて作る
      if (this.next()) this.kick();
    });
  }

  /** コンテキストを読む（上限の時間を過ぎたら、取得を止めて失敗にする）。 */
  private async loadWithTimeout(
    id: string,
  ): Promise<Awaited<ReturnType<ContextImagesDeps["load"]>>> {
    const limit = this.deps.loadTimeoutMs ?? CONTEXT_IMAGES_LOAD_TIMEOUT_MS;
    const local = new AbortController();
    const onStop = () => local.abort();
    this.controller.signal.addEventListener("abort", onStop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new MessageError(
            message("contextImage.loadTimedOut", {
              minutes: Math.max(1, Math.round(limit / 60_000)),
            }),
          ),
        );
        // 時間切れとして先に決めてから、取得を止める
        local.abort();
      }, limit);
      timer.unref?.();
    });
    const loading = this.deps.load(id, local.signal);
    // 時間切れで止めた取得の失敗は、時間切れとして扱う
    loading.catch(() => {});
    try {
      return await Promise.race([loading, timeout]);
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", onStop);
    }
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
      // 作るのにも上限を設ける（応答しない Docker・レジストリで、後のすべてが止まらないように）
      const limit = this.deps.buildTimeoutMs ?? CONTEXT_IMAGE_BUILD_TIMEOUT_MS;
      const local = new AbortController();
      const onStop = () => local.abort();
      signal.addEventListener("abort", onStop, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        local.abort();
      }, limit);
      timer.unref?.();
      try {
        const detail = await this.deps.build(
          entry.language,
          entry.build,
          (chunk) => {
            entry.log = appendTail(entry.log, chunk);
          },
          local.signal,
        );
        if (detail) failure = message("contextImage.buildFailed", { detail });
      } catch (error) {
        failure = errorText(error);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onStop);
      }
      if (signal.aborted) return;
      if (timedOut) {
        failure = message("contextImage.buildTimedOut", {
          minutes: Math.max(1, Math.round(limit / 60_000)),
        });
      }
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
    const removeStale = this.deps.removeStale;
    if (!removeStale || this.controller.signal.aborted || this.pruning) return;
    const projects = [...this.projects.values()];
    if (projects.some((p) => p.loadError || !p.loaded || p.loading)) return;
    if (this.refreshing.size > 0) return;
    const keep = projects.flatMap((p) => p.entries.map((e) => e.image));
    // 片付けている間は、読み直しが手元にあるかを確かめない（確かめた後に消さないように。load が待つ）
    this.pruning = removeStale(keep, contextImagePrefix(this.deps.owner))
      .catch(() => {
        // 片付けられなくても、作成には関わらない
      })
      .finally(() => {
        this.pruning = undefined;
      });
    await this.pruning;
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

/**
 * keep 以外の、このデーモンが作ったコンテキストのイメージ（名前の頭が prefix。既定は sacty-ctx-）を消す。
 */
export async function removeStaleContextImages(
  keep: readonly string[],
  run: (args: string[]) => Promise<{ code: number; stdout: string }>,
  prefix: string = CONTEXT_IMAGE_REPOSITORY_PREFIX,
): Promise<string[]> {
  const list = await run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]);
  if (list.code !== 0) return [];
  const stale = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((image) => image.startsWith(prefix) && !image.endsWith(":<none>"))
    .filter((image) => !keep.includes(image));
  const removed: string[] = [];
  for (const image of stale) {
    // 使っているコンテナがあれば消えない（強制では消さない）
    const { code } = await run(["image", "rm", image]);
    if (code === 0) removed.push(image);
  }
  return removed;
}
