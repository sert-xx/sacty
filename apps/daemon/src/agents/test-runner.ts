import { spawn } from "node:child_process";
import { dockerClientEnv, dockerRunArgs, RunningContainers } from "./docker.js";

/** テストの出力は、末尾のこの文字数だけ残す（台帳と画面に載せるため）。 */
export const TEST_OUTPUT_TAIL = 20_000;

export type TestRunResult = { exitCode: number; output: string; durationMs: number };

/** テストを実行する口。テストでは偽物に差し替える。 */
export interface TestRunner {
  run(input: {
    runId: string;
    image: string;
    workspaceDir: string;
    command: string;
  }): Promise<TestRunResult> /** 実行中のコンテナを止める（人間が一時停止・中止したとき）。無ければ何もしない。 */;
  kill(runId: string): void;
}

/**
 * エージェントとは別のコンテナでテストを実行する。秘密情報（環境変数・認証ファイル）は渡さない。
 * 合否は終了コードで機械的に決める。
 */
export class DockerTestRunner implements TestRunner {
  private readonly containers: RunningContainers;

  private readonly spawnImpl: typeof spawn;

  constructor(
    private readonly timeoutMs = 20 * 60_000,
    spawnImpl: typeof spawn = spawn,
  ) {
    this.containers = new RunningContainers(spawnImpl);
    this.spawnImpl = spawnImpl;
  }

  /** デーモンの停止時に、実行中のテストのコンテナを止める。 */
  kill(runId: string): void {
    this.containers.stop(`sacty-run-${runId}`);
  }

  abortAll(): void {
    this.containers.stopAll();
  }

  async run({ runId, image, workspaceDir, command }: Parameters<TestRunner["run"]>[0]) {
    const name = `sacty-run-${runId}`;
    const args = dockerRunArgs({
      runId,
      image,
      workspaceDir,
      envNames: [],
      mounts: [],
      command: ["sh", "-c", command],
    });
    const started = Date.now();
    this.containers.register(name);
    try {
      return await new Promise<TestRunResult>((resolve) => {
        const child = this.spawnImpl("docker", args, {
          env: dockerClientEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.containers.attach(name, child);
        let output = "";
        const keep = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-TEST_OUTPUT_TAIL);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        const timer = setTimeout(() => {
          output += `\n[sacty] テストの実行が ${this.timeoutMs / 60_000} 分を超えたため止めました。`;
          this.containers.stop(name);
        }, this.timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({
            exitCode: 127,
            output: `dockerを実行できません。Dockerが起動しているか確認してください（${error.message}）。`,
            durationMs: Date.now() - started,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            exitCode: code ?? 1,
            output: output.slice(-TEST_OUTPUT_TAIL),
            durationMs: Date.now() - started,
          });
        });
      });
    } finally {
      this.containers.finish(name);
    }
  }
}
