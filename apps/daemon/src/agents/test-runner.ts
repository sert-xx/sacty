import { spawn } from "node:child_process";
import { type DaemonText, message } from "@sacty/core";
import { DEFAULT_TEST_TIMEOUT_MINUTES } from "../run-timeouts.js";
import { dockerClientEnv, dockerRunArgs, RunningContainers } from "./docker.js";
import { type LocalForward, withLocalForwards } from "./forward.js";
import { withOutputRelay } from "./output-relay.js";

/** docker run が、Docker 自身の失敗で終わったときの終了コード（コンテナの中のコマンドの結果ではない）。 */
const DOCKER_RUN_FAILED = 125;

/** テストの出力は、末尾のこの文字数だけ残す（作業履歴と画面に載せるため）。 */
export const TEST_OUTPUT_TAIL = 20_000;

export type TestRunResult = {
  exitCode: number;
  output: string;
  /** sacty の注記（テストを止めた理由など）。テストの出力とは分けて持つ（PBI-11）。 */
  note?: DaemonText;
  /**
   * テストの実行基盤の失敗（Docker を起動できない・時間切れ・コンテナの停止を確かめられない）。
   * 終了コードはテストの結果ではない（再現の確かめでは、テストの失敗と区別する。PBI-29）。
   */
  infrastructure?: boolean;
  durationMs: number;
};

/** テストを実行する口。テストでは偽物に差し替える。 */
export interface TestRunner {
  run(input: {
    runId: string;
    image: string;
    workspaceDir: string;
    command: string;
    /** イメージの環境変数（言語ごとのイメージの env。PBI-41）。 */
    env?: Record<string, string>;
    /** つなぐネットワーク（docker compose のサービス。PBI-47）。 */
    network?: string;
    /**
     * コンテナの中で localhost に転送するサービスのポート（PBI-60）。無ければ、コマンドはそのまま。
     * 転送しなかったポートの理由は、テストの出力（標準エラー出力）に出る。
     */
    forwards?: readonly LocalForward[];
    /** この実行の上限（ミリ秒。config.yaml の run_timeout.test_minutes。PBI-150）。無ければ既定（20 分）。 */
    timeoutMs?: number;
  }): Promise<TestRunResult>;
  /** 実行中のコンテナを止める（人間が一時停止・中止したとき）。無ければ何もしない。 */
  kill(runId: string): void;
  /** コンテナが無いことを確かめる（残っていれば止める）。確かめられなければ false。 */
  ensureStopped(runId: string): Promise<boolean>;
}

/**
 * エージェントとは別のコンテナでテストを実行する。秘密情報（環境変数・認証ファイル）は渡さない。
 * 合否は終了コードで機械的に決める。
 */
export class DockerTestRunner implements TestRunner {
  private readonly containers: RunningContainers;

  private readonly spawnImpl: typeof spawn;

  constructor(
    private readonly timeoutMs = DEFAULT_TEST_TIMEOUT_MINUTES * 60_000,
    spawnImpl: typeof spawn = spawn,
  ) {
    this.containers = new RunningContainers(spawnImpl);
    this.spawnImpl = spawnImpl;
  }

  /** デーモンの停止時に、実行中のテストのコンテナを止める。 */
  kill(runId: string): void {
    this.containers.stop(`sacty-run-${runId}`);
  }

  ensureStopped(runId: string): Promise<boolean> {
    return this.containers.ensureStopped(`sacty-run-${runId}`);
  }

  abortAll(): void {
    this.containers.stopAll();
  }

  async run({
    runId,
    image,
    workspaceDir,
    command,
    env = {},
    network,
    forwards = [],
    timeoutMs = this.timeoutMs,
  }: Parameters<TestRunner["run"]>[0]) {
    const name = `sacty-run-${runId}`;
    const args = dockerRunArgs({
      runId,
      image,
      workspaceDir,
      envNames: Object.keys(env),
      mounts: [],
      ...(network ? { network } : {}),
      // 出力は中継を通して受け取る（標準出力が非ブロッキングにされても、テストが EAGAIN で落ちないように。PBI-64）
      command: withOutputRelay(withLocalForwards(["sh", "-c", command], forwards)),
    });
    const started = Date.now();
    this.containers.register(name);
    let result: TestRunResult;
    try {
      result = await new Promise<TestRunResult>((resolve) => {
        const child = this.spawnImpl("docker", args, {
          env: { ...dockerClientEnv(), ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.containers.attach(name, child);
        let output = "";
        const keep = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-TEST_OUTPUT_TAIL);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        let note: DaemonText | undefined;
        const timer = setTimeout(() => {
          note = message("run.testTimeout", { minutes: timeoutMs / 60_000 });
          this.containers.stop(name);
        }, timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({
            exitCode: 127,
            output: "",
            note: message("run.dockerUnavailable", { detail: error.message }),
            infrastructure: true,
            durationMs: Date.now() - started,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          // docker run の終了コード 125 は、Docker 自身の失敗（デーモンに接続できない・イメージを取得できないなど）。
          // テストは実行されていない（PBI-29 レビュー指摘）
          if (!note && code === DOCKER_RUN_FAILED) note = message("run.dockerFailed");
          resolve({
            exitCode: code ?? 1,
            output: output.slice(-TEST_OUTPUT_TAIL),
            // 時間切れで止めた・Docker 自身が失敗したなら、終了コードはテストの結果ではない
            ...(note ? { note, infrastructure: true } : {}),
            durationMs: Date.now() - started,
          });
        });
      });
    } finally {
      // 止める要求があったなら、コンテナが無くなったことを確かめるまで完了にしない
      if (!(await this.containers.finish(name))) {
        result = {
          exitCode: 1,
          output: "",
          note: message("run.containerNotConfirmed", { name }),
          infrastructure: true,
          durationMs: Date.now() - started,
        };
      }
    }
    return result;
  }
}
