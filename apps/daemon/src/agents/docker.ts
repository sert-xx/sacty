import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Invocation } from "./invocation.js";
import { type AgentOutcome, parseClaudeResult, parseCodexEvents } from "./parse.js";

export const CONTAINER_WORKSPACE = "/workspace";

function hashOf(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * コンテナの中で更新されたファイル（Codexの認証ファイルなど）を、ホストに書き戻す。
 * トークンの更新で古いトークンが無効になる方式だと、書き戻さないとホストのログインが壊れるため。
 * ただし実行中にホスト側のファイルが変わっていたら、利用者の操作を優先して書き戻さない。
 */
export function syncBackIfChanged(
  hostPath: string,
  stagedPath: string,
  hashAtCopy: string,
): "written" | "unchanged" | "host-changed" {
  const staged = hashOf(stagedPath);
  if (!staged || staged === hashAtCopy) return "unchanged";
  if (hashOf(hostPath) !== hashAtCopy) return "host-changed";
  const temp = join(dirname(hostPath), `.${basename(hostPath)}.sacty-${process.pid}`);
  writeFileSync(temp, readFileSync(stagedPath), { mode: 0o600 });
  renameSync(temp, hostPath);
  return "written";
}

/** エージェントを実行する口。テストでは偽物に差し替える。 */
export interface AgentExecutor {
  run(input: {
    runId: string;
    image: string;
    workspaceDir: string;
    invocation: Invocation;
  }): Promise<AgentOutcome>;
}

/**
 * `docker run` の引数を組み立てる。環境変数は名前だけを渡し（`-e NAME`）、
 * 値はdockerコマンドの環境から読ませる。秘密情報の値をコマンドライン（psで見える）に出さないため。
 */
export function dockerRunArgs(input: {
  runId: string;
  image: string;
  workspaceDir: string;
  envNames: string[];
  mounts: { hostPath: string; containerPath: string; readOnly: boolean }[];
  command: string[];
}): string[] {
  return [
    "run",
    "--rm",
    "--name",
    `sacty-run-${input.runId}`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "-v",
    `${input.workspaceDir}:${CONTAINER_WORKSPACE}`,
    ...input.mounts.flatMap((m) => [
      "-v",
      `${m.hostPath}:${m.containerPath}${m.readOnly ? ":ro" : ""}`,
    ]),
    "-w",
    CONTAINER_WORKSPACE,
    ...input.envNames.flatMap((name) => ["-e", name]),
    input.image,
    ...input.command,
  ];
}

/** dockerコマンド自体に必要なホストの環境変数だけを残す。 */
function dockerClientEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export class DockerExecutor implements AgentExecutor {
  private readonly active = new Set<string>();
  private aborting = false;

  constructor(private readonly timeoutMs = 30 * 60_000) {}

  /**
   * デーモンの停止時に、実行中のコンテナを止める（コンテナだけが残り続けないように）。
   * 後処理（書き戻し・一時ファイルの削除）は run() の中で行われるので、呼び出し側はその完了を待つこと。
   */
  abortAll(): void {
    this.aborting = true;
    for (const name of this.active) {
      spawn("docker", ["kill", name], { stdio: "ignore", env: dockerClientEnv() });
    }
  }

  async run({
    runId,
    image,
    workspaceDir,
    invocation,
  }: Parameters<AgentExecutor["run"]>[0]): Promise<AgentOutcome> {
    // コピーして渡すファイル（Codexの認証ファイルなど）は、実行ごとの一時ディレクトリに置き、
    // ディレクトリごとマウントする（ファイル単体だと親ディレクトリがroot所有になり書き込めないため）
    const staging = invocation.stage ? mkdtempSync(join(tmpdir(), "sacty-run-")) : null;
    const mounts: { hostPath: string; containerPath: string; readOnly: boolean }[] = [];
    const syncBacks: { hostPath: string; stagedPath: string; hashAtCopy: string }[] = [];
    if (invocation.stage && staging) {
      for (const file of invocation.stage.files) {
        const copied = join(staging, basename(file.name));
        try {
          copyFileSync(file.hostPath, copied);
          const hashAtCopy = hashOf(copied);
          if (file.syncBack && hashAtCopy) {
            syncBacks.push({ hostPath: file.hostPath, stagedPath: copied, hashAtCopy });
          }
        } catch {
          rmSync(staging, { recursive: true, force: true });
          return {
            kind: "failed",
            reason: "auth",
            message: `認証ファイル（${file.hostPath}）を読めません。ログインしているか確認してください。`,
          };
        }
        chmodSync(copied, 0o600);
      }
      mounts.push({
        hostPath: staging,
        containerPath: invocation.stage.containerDir,
        readOnly: false,
      });
    }

    const args = dockerRunArgs({
      runId,
      image,
      workspaceDir,
      envNames: Object.keys(invocation.env),
      mounts,
      command: invocation.command,
    });

    const containerName = `sacty-run-${runId}`;
    this.active.add(containerName);
    try {
      const { exitCode, stdout, stderr } = await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn("docker", args, {
          env: { ...dockerClientEnv(), ...invocation.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          err += chunk;
        });
        const timer = setTimeout(() => {
          spawn("docker", ["kill", containerName], { stdio: "ignore", env: dockerClientEnv() });
          reject(
            new Error(`エージェントの実行が ${this.timeoutMs / 60_000} 分を超えたため止めました。`),
          );
        }, this.timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(
            new Error(
              `dockerを実行できません。Dockerが起動しているか確認してください（${error.message}）。`,
            ),
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout: out, stderr: err });
        });
      });

      if (this.aborting) {
        return {
          kind: "failed",
          reason: "error",
          message: "デーモンが停止したため、実行が中断されました。",
        };
      }
      if (/Unable to find image|No such image|pull access denied/i.test(stderr)) {
        return {
          kind: "failed",
          reason: "error",
          message: `エージェント用のイメージ（${image}）がありません。\`sacty image build\` で作成してください。`,
        };
      }
      return invocation.parser === "codex-jsonl"
        ? parseCodexEvents(stdout, exitCode, stderr)
        : parseClaudeResult(stdout, exitCode, stderr);
    } finally {
      this.active.delete(containerName);
      for (const file of syncBacks) {
        try {
          const result = syncBackIfChanged(file.hostPath, file.stagedPath, file.hashAtCopy);
          if (result === "host-changed") {
            console.warn(
              `[daemon] ${file.hostPath} が実行中に変更されたため、コンテナでの更新は書き戻しませんでした。`,
            );
          }
        } catch (error) {
          console.warn(`[daemon] ${file.hostPath} を書き戻せませんでした：`, error);
        }
      }
      if (staging) rmSync(staging, { recursive: true, force: true });
    }
  }
}
