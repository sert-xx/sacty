import { spawn } from "node:child_process";
import { type DaemonText, message } from "@sacty/core";
import { dockerClientEnv } from "./agents/docker.js";
import { type ConfigResult, DEFAULT_IMAGE, languageImageTag } from "./config.js";
import { imageBuildSettings } from "./image.js";

/**
 * エージェントのイメージが手元にあるかの確かめ（PBI-148）。版を上げると既定のイメージの名前（sacty-agent:<版>）が変わるので、
 * 起動のときと一定の間隔で `docker image inspect` で確かめ、無ければ作るコマンドを、端末と画面の注意で知らせる。起動は止めず、
 * 自動では作らない。先に Docker（デーモン）が動いているかを `docker version` で確かめ、動いていなければイメージは確かめずに
 * そのことだけを知らせる。設定のイメージの版（タグ）が動いている sacty の版と違うときも知らせる。
 */

/** 確かめる間隔（1分）。作ったら、次の確かめで注意が消える。 */
export const IMAGE_CHECK_INTERVAL_MS = 60_000;
/** `docker image inspect` を待つ上限。過ぎたら、Docker に接続できないものとして扱う。 */
export const IMAGE_INSPECT_TIMEOUT_MS = 10_000;

/** 手元にある・無い・確かめられない（Docker に接続できない・応答しない）。 */
export type ImageState = "present" | "missing" | "unreachable";

/** Docker が動いている・docker のコマンドが無い・Docker（デーモン）に接続できない（動いていない・応答しない）。 */
export type DockerState = "running" | "noCli" | "unreachable";

/**
 * 確かめるイメージ。name は `sacty image build` に渡す名前（既定のイメージは undefined）。expected は、動いている sacty の版の
 * イメージの名前（既定は sacty-agent:<版>、言語ごとは sacty-agent-<名前>:<版>）。
 */
export type ImageTarget = { image: string; name?: string; expected?: string };

/** 確かめるイメージ（既定のイメージと images のすべて）。設定に誤りがあれば確かめない（設定の誤りは別に知らせている）。 */
export function imageTargets(config: ConfigResult): ImageTarget[] {
  const settings = imageBuildSettings(config);
  if (!settings.ok) return [];
  return [
    { image: settings.image, expected: DEFAULT_IMAGE },
    ...Object.values(settings.images).map((l) => ({
      image: l.image,
      name: l.name,
      expected: languageImageTag(l.name),
    })),
  ];
}

/** 名前を、リポジトリとタグに分ける（`registry:5000/x` のポートはタグではない）。タグが無ければ undefined。 */
function splitTag(image: string): { repository: string; tag?: string } {
  const colon = image.lastIndexOf(":");
  if (colon < 0 || colon < image.lastIndexOf("/")) return { repository: image };
  return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
}

/**
 * 設定のイメージが、動いている sacty の版のものでないか。sacty が名付けるイメージ（expected と同じリポジトリ）で、タグだけが
 * 違うときに限る（`sacty config init` が書いた `image: sacty-agent:<前の版>` が、版を上げても残っているとき）。ほかの名前は、
 * 利用者が選んだものなので比べない。
 */
export function isOutdatedImage(target: ImageTarget): boolean {
  if (!target.expected) return false;
  const actual = splitTag(target.image);
  const expected = splitTag(target.expected);
  return actual.repository === expected.repository && actual.tag !== expected.tag;
}

/** 設定のどこに書いたイメージか（直す場所の案内）。 */
function configKey(target: ImageTarget): string {
  return target.name ? `images.${target.name}.image` : "image";
}

/**
 * 名前にレジストリのホストを含むか（`registry.example.com/x:1`・`localhost:5000/x` など）。最初の `/` の前に `.`・`:` があるか
 * `localhost` なら、レジストリ（docker の名前の規則と同じ）。それ以外（`sacty-agent:1.12.1`・`library/node`）は Docker Hub の名前で、
 * sacty が作るイメージは公開していないので、実行のときに取得できない。
 */
export function isRegistryImage(image: string): boolean {
  const slash = image.indexOf("/");
  if (slash < 0) return false;
  const host = image.slice(0, slash);
  return host === "localhost" || host.includes(".") || host.includes(":");
}

/** 作るコマンド。言語ごとのイメージは名前を付ける。 */
export function buildCommand(target: ImageTarget): string {
  return target.name ? `npx sacty image build ${target.name}` : "npx sacty image build";
}

/** `docker image inspect` の標準エラー出力のうち、イメージが無いことを示すもの（Docker の版で文言が違う）。 */
const NO_SUCH_IMAGE = /No such (image|object)/i;

type DockerOptions = { spawnImpl?: typeof spawn; timeoutMs?: number; signal?: AbortSignal };

/** docker の結果。終わった（終了コードと標準エラー出力の先頭）・起動できない（docker が無いなど）・時間切れか打ち切り。 */
type DockerRun =
  | { kind: "exit"; code: number | null; stderr: string }
  | { kind: "error"; error: unknown }
  | { kind: "stopped" };

/**
 * docker を動かす。テストでは spawn を差し替える。応答しなければ上限の時間で止める。signal で打ち切ると、docker を止める
 * （デーモンを止めるときに、応答しない docker を残さない。PR #166 レビュー提案）。
 */
function runDocker(args: string[], options: DockerOptions): Promise<DockerRun> {
  const { spawnImpl = spawn, timeoutMs = IMAGE_INSPECT_TIMEOUT_MS, signal } = options;
  return new Promise((done) => {
    if (signal?.aborted) {
      done({ kind: "stopped" });
      return;
    }
    let settled = false;
    const finish = (result: DockerRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done(result);
    };
    const onAbort = () => {
      child?.kill("SIGKILL");
      finish({ kind: "stopped" });
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawnImpl("docker", args, {
        env: dockerClientEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      done({ kind: "error", error });
      return;
    }
    const started = child;
    // 応答しなければ止める
    const timer = setTimeout(() => {
      started.kill("SIGKILL");
      finish({ kind: "stopped" });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    started.stdout?.on("data", () => {});
    started.stderr?.on("data", (chunk) => {
      // 大きな出力でも、判断に要る先頭だけ持つ
      if (stderr.length < 4096) stderr += chunk;
    });
    started.on("error", (error) => finish({ kind: "error", error }));
    started.on("close", (code) => finish({ kind: "exit", code, stderr }));
  });
}

/** docker のコマンドが見つからない（PATH に無い）ことによる起動の失敗か。 */
function isNoCli(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Docker（デーモン）が動いているかを `docker version` で確かめる。サーバー（デーモン）の版を取れれば動いている。docker の
 * コマンドが無ければ noCli、デーモンに接続できない・応答しない・打ち切ったら unreachable。
 */
export async function pingDocker(options: DockerOptions = {}): Promise<DockerState> {
  const result = await runDocker(["version", "--format", "{{.Server.Version}}"], options);
  if (result.kind === "exit") return result.code === 0 ? "running" : "unreachable";
  if (result.kind === "error" && isNoCli(result.error)) return "noCli";
  return "unreachable";
}

/** docker でイメージを確かめる。打ち切ったら、確かめられなかったものとする。 */
export async function inspectImage(
  image: string,
  options: DockerOptions = {},
): Promise<ImageState> {
  const result = await runDocker(["image", "inspect", "--format", "{{.Id}}", image], options);
  if (result.kind !== "exit") return "unreachable";
  if (result.code === 0) return "present";
  return NO_SUCH_IMAGE.test(result.stderr) ? "missing" : "unreachable";
}

export type ImagePresenceDeps = {
  /** 確かめるイメージ（使うたびに設定から読む）。 */
  targets: () => ImageTarget[];
  /** Docker が動いているか。signal で打ち切られたら、docker を止めて返る。 */
  ping: (signal: AbortSignal) => Promise<DockerState>;
  /** signal で打ち切られたら、docker を止めて返る。 */
  inspect: (image: string, signal: AbortSignal) => Promise<ImageState>;
};

export class ImagePresenceChecker {
  private latest: DaemonText[] = [];
  private running: Promise<DaemonText[]> | undefined;
  /** stop で打ち切る（実行中の docker も止める）。 */
  private readonly controller = new AbortController();

  constructor(private readonly deps: ImagePresenceDeps) {}

  /** 画面と端末に出す注意（最後の確かめの結果）。 */
  problems(): DaemonText[] {
    return this.latest;
  }

  /** 確かめるのをやめる。実行中の docker を止め、それからは確かめない（デーモンを止めるとき）。 */
  stop(): void {
    this.controller.abort();
  }

  /** 確かめて、注意を返す。確かめている最中に呼ばれたら、同じ確かめを待つ（重ねて docker を動かさない）。 */
  check(): Promise<DaemonText[]> {
    if (this.controller.signal.aborted) return Promise.resolve(this.latest);
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<DaemonText[]> {
    // 先に Docker が動いているかを確かめる。動いていなければ、イメージは確かめずにそのことだけを知らせる（タスクを実行できない）
    const docker = await this.deps.ping(this.controller.signal);
    if (this.controller.signal.aborted) return this.latest;
    if (docker !== "running") {
      this.latest = [
        message(docker === "noCli" ? "image.dockerNotInstalled" : "image.dockerUnreachable"),
      ];
      return this.latest;
    }
    const problems: DaemonText[] = [];
    // 同じ名前は1回だけ確かめる（images が既定のイメージと同じ名前を指すことがある）
    const seen = new Set<string>();
    const targets: ImageTarget[] = [];
    for (const t of this.deps.targets()) {
      if (seen.has(t.image)) continue;
      seen.add(t.image);
      // 設定のイメージの版が、動いている sacty の版と違う。作る前に設定を直すので、手元にあるかは確かめない
      if (t.expected && isOutdatedImage(t)) {
        problems.push(
          message("image.outdated", {
            image: t.image,
            expected: t.expected,
            key: configKey(t),
            command: buildCommand(t),
          }),
        );
      } else {
        targets.push(t);
      }
    }
    const results = await Promise.all(
      targets.map(async (t) => ({
        target: t,
        state: await this.deps.inspect(t.image, this.controller.signal),
      })),
    );
    // 止めた後の結果は残さない（打ち切った docker を「確かめられない」として出さない）
    if (this.controller.signal.aborted) return this.latest;
    // 確かめている間に Docker に接続できなくなったら、イメージごとではなく1つにまとめる
    if (results.some((r) => r.state === "unreachable")) {
      problems.push(message("image.dockerUnreachable"));
    }
    for (const { target, state } of results) {
      if (state !== "missing") continue;
      const params = { image: target.image, command: buildCommand(target) };
      problems.push(
        message(isRegistryImage(target.image) ? "image.notLocal" : "image.missing", params),
      );
    }
    this.latest = problems;
    return problems;
  }
}

/**
 * 起動のときに確かめ、それから一定の間隔で確かめ直す。最初の確かめの結果は onFirst に渡す（端末に出す）。止める関数を返す
 * （間隔を止め、実行中の docker も止める。PR #166 レビュー提案）。
 */
export function startImagePresenceCheck(
  checker: ImagePresenceChecker,
  onFirst: (problems: DaemonText[]) => void,
  intervalMs = IMAGE_CHECK_INTERVAL_MS,
): () => void {
  void checker.check().then(onFirst, () => {});
  const timer = setInterval(() => void checker.check().catch(() => {}), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    checker.stop();
  };
}
