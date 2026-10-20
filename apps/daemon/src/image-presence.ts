import { spawn } from "node:child_process";
import { type DaemonText, message } from "@sacty/core";
import { dockerClientEnv } from "./agents/docker.js";
import type { ConfigResult } from "./config.js";
import { imageBuildSettings } from "./image.js";

/**
 * エージェントのイメージが手元にあるかの確かめ（PBI-148）。版を上げると既定のイメージの名前（sacty-agent:<版>）が変わるので、
 * 起動のときと一定の間隔で `docker image inspect` で確かめ、無ければ作るコマンドを、端末と画面の注意で知らせる。起動は止めず、
 * 自動では作らない。
 */

/** 確かめる間隔（1分）。作ったら、次の確かめで注意が消える。 */
export const IMAGE_CHECK_INTERVAL_MS = 60_000;
/** `docker image inspect` を待つ上限。過ぎたら、Docker に接続できないものとして扱う。 */
export const IMAGE_INSPECT_TIMEOUT_MS = 10_000;

/** 手元にある・無い・確かめられない（Docker に接続できない・応答しない）。 */
export type ImageState = "present" | "missing" | "unreachable";

/** 確かめるイメージ。name は `sacty image build` に渡す名前（既定のイメージは undefined）。 */
export type ImageTarget = { image: string; name?: string };

/** 確かめるイメージ（既定のイメージと images のすべて）。設定に誤りがあれば確かめない（設定の誤りは別に知らせている）。 */
export function imageTargets(config: ConfigResult): ImageTarget[] {
  const settings = imageBuildSettings(config);
  if (!settings.ok) return [];
  return [
    { image: settings.image },
    ...Object.values(settings.images).map((l) => ({ image: l.image, name: l.name })),
  ];
}

/**
 * 名前にレジストリのホストを含むか（`registry.example.com/x:1`・`localhost:5000/x` など）。最初の `/` の前に `.`・`:` があるか
 * `localhost` なら、レジストリ（docker の名前の規則と同じ）。それ以外（`sacty-agent:1.5.0`・`library/node`）は Docker Hub の名前で、
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

/**
 * docker でイメージを確かめる。テストでは spawn を差し替える。signal で打ち切ると、docker を止めて、確かめられなかったものとする
 * （デーモンを止めるときに、応答しない docker を残さない。PR #166 レビュー提案）。
 */
export function inspectImage(
  image: string,
  options: { spawnImpl?: typeof spawn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ImageState> {
  const { spawnImpl = spawn, timeoutMs = IMAGE_INSPECT_TIMEOUT_MS, signal } = options;
  return new Promise((done) => {
    if (signal?.aborted) {
      done("unreachable");
      return;
    }
    let settled = false;
    const finish = (state: ImageState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done(state);
    };
    const onAbort = () => {
      child?.kill("SIGKILL");
      finish("unreachable");
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawnImpl("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
        env: dockerClientEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      done("unreachable");
      return;
    }
    const started = child;
    // 応答しなければ止めて、確かめられなかったものとする
    const timer = setTimeout(() => {
      started.kill("SIGKILL");
      finish("unreachable");
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    started.stdout?.on("data", () => {});
    started.stderr?.on("data", (chunk) => {
      // 大きな出力でも、判断に要る先頭だけ持つ
      if (stderr.length < 4096) stderr += chunk;
    });
    started.on("error", () => finish("unreachable"));
    started.on("close", (code) => {
      if (code === 0) finish("present");
      else finish(NO_SUCH_IMAGE.test(stderr) ? "missing" : "unreachable");
    });
  });
}

export type ImagePresenceDeps = {
  /** 確かめるイメージ（使うたびに設定から読む）。 */
  targets: () => ImageTarget[];
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
    // 同じ名前は1回だけ確かめる（images が既定のイメージと同じ名前を指すことがある）
    const targets = new Map<string, ImageTarget>();
    for (const t of this.deps.targets()) if (!targets.has(t.image)) targets.set(t.image, t);
    const results = await Promise.all(
      [...targets.values()].map(async (t) => ({
        target: t,
        state: await this.deps.inspect(t.image, this.controller.signal),
      })),
    );
    // 止めた後の結果は残さない（打ち切った docker を「確かめられない」として出さない）
    if (this.controller.signal.aborted) return this.latest;
    const problems: DaemonText[] = [];
    // Docker に接続できなければ、イメージごとではなく1つにまとめる
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
