import { spawn } from "node:child_process";
import { dockerClientEnv, dockerRunArgs } from "./docker.js";

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
  }): Promise<TestRunResult>;
}

/**
 * エージェントとは別のコンテナでテストを実行する。秘密情報（環境変数・認証ファイル）は渡さない。
 * 合否は終了コードで機械的に決める。
 */
export class DockerTestRunner implements TestRunner {
  private readonly active = new Set<string>();

  constructor(private readonly timeoutMs = 20 * 60_000) {}

  /** デーモンの停止時に、実行中のテストのコンテナを止める。 */
  abortAll(): void {
    for (const name of this.active) {
      spawn("docker", ["kill", name], { stdio: "ignore", env: dockerClientEnv() });
    }
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
    this.active.add(name);
    try {
      return await new Promise<TestRunResult>((resolve) => {
        const child = spawn("docker", args, {
          env: dockerClientEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const keep = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-TEST_OUTPUT_TAIL);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        const timer = setTimeout(() => {
          output += `\n[sacty] テストの実行が ${this.timeoutMs / 60_000} 分を超えたため止めました。`;
          spawn("docker", ["kill", name], { stdio: "ignore", env: dockerClientEnv() });
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
      this.active.delete(name);
    }
  }
}
