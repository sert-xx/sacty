import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { message } from "@sacty/core";
import { MessageError } from "../errors.js";
import { DEFAULT_HOST_ADDRESS } from "../gateway.js";
import type { Invocation } from "./invocation.js";
import { type AgentOutcome, parseClaudeResult, parseCodexEvents } from "./parse.js";
import { redact, redactText, secretStringsInJson } from "./redact.js";

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

/**
 * 実行中のコンテナ（docker run の子プロセス）を覚え、人間の一時停止・中止で止める。
 * コンテナができる前（イメージの取得中など）に止められると `docker kill` は対象が無く失敗するので、
 * そのときは docker run 自体を止め、遅れてコンテナができても止まるよう `docker kill` を繰り返す。
 */
export class RunningContainers {
  private readonly children = new Map<string, ChildProcess | undefined>();
  private readonly stopRequested = new Set<string>();

  constructor(
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly retryMs = 1_000,
    private readonly retries = 10,
  ) {}

  /** docker run を始める前に登録する（起動の途中でも止められるように）。 */
  register(name: string): void {
    this.children.set(name, undefined);
  }

  /** docker run の子プロセスを結びつける。すでに止める要求があれば止める。 */
  attach(name: string, child: ChildProcess): void {
    this.children.set(name, child);
    if (this.stopRequested.has(name)) child.kill("SIGKILL");
  }

  has(name: string): boolean {
    return this.children.has(name);
  }

  /**
   * docker run が終わったら呼ぶ。止める要求があったなら、コンテナが無くなったことを確かめてから返す
   * （docker run の子プロセスが終わっても、Docker 側で遅れてコンテナができていることがあるため）。
   * 確かめられなければ false。
   */
  async finish(name: string): Promise<boolean> {
    this.children.delete(name);
    if (!this.stopRequested.delete(name)) return true;
    return this.ensureStopped(name);
  }

  /** 止める。止める要求は、docker run が終わるまで覚えておく。 */
  stop(name: string): void {
    if (!this.children.has(name)) return;
    this.stopRequested.add(name);
    void this.command(["kill", name]).then(({ code }) => {
      // コンテナがまだ無い（作成中）。docker run 自体を止める（遅れてできたコンテナは finish で止める）
      if (code !== 0) this.children.get(name)?.kill("SIGKILL");
    });
  }

  stopAll(): void {
    for (const name of this.children.keys()) this.stop(name);
  }

  /**
   * コンテナが無いことを確かめる。残っていれば止めて、もう一度確かめる。
   * Docker に問い合わせられない・止まらないまま上限に達したら false。
   */
  async ensureStopped(name: string): Promise<boolean> {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const listed = await this.command(["ps", "-aq", "--filter", `name=^/${name}$`]);
      if (listed.code === 0 && listed.stdout.trim() === "") return true;
      if (listed.code === 0) await this.command(["kill", name]);
      await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
    return false;
  }

  private command(args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
      const proc = this.spawnImpl("docker", args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: dockerClientEnv(),
      });
      let stdout = "";
      proc.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.on("error", () => resolve({ code: 1, stdout: "" }));
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    });
  }
}

/** エージェントを実行する口。テストでは偽物に差し替える。 */
export interface AgentExecutor {
  run(input: {
    runId: string;
    image: string;
    workspaceDir: string;
    invocation: Invocation;
    /** イメージの環境変数（言語ごとのイメージの env。PBI-41）。実行の環境変数が同じ名前なら、そちらを使う。 */
    imageEnv?: Record<string, string>;
  }): Promise<AgentOutcome>;
  /** 実行中のコンテナを止める（人間が一時停止・中止したとき）。無ければ何もしない。 */
  kill(runId: string): void;
  /** コンテナが無いことを確かめる（残っていれば止める）。確かめられなければ false。 */
  ensureStopped(runId: string): Promise<boolean>;
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
  /**
   * ホストのゲートウェイに届くよう、host.docker.internal をホストのアドレスに向ける（PBI-37）。
   * host-gateway（Docker Desktop）か、ホストのアドレス（Rancher Desktop など。PBI-40）。
   */
  hostGateway?: string;
}): string[] {
  return [
    "run",
    "--rm",
    ...(input.hostGateway ? ["--add-host", `host.docker.internal:${input.hostGateway}`] : []),
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
export function dockerClientEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export class DockerExecutor implements AgentExecutor {
  private readonly containers: RunningContainers;
  private aborting = false;

  constructor(
    private readonly timeoutMs = 30 * 60_000,
    spawnImpl: typeof spawn = spawn,
  ) {
    this.containers = new RunningContainers(spawnImpl);
    this.spawnImpl = spawnImpl;
  }

  private readonly spawnImpl: typeof spawn;

  /**
   * デーモンの停止時に、実行中のコンテナを止める（コンテナだけが残り続けないように）。
   * 後処理（書き戻し・一時ファイルの削除）は run() の中で行われるので、呼び出し側はその完了を待つこと。
   */
  kill(runId: string): void {
    this.containers.stop(`sacty-run-${runId}`);
  }

  ensureStopped(runId: string): Promise<boolean> {
    return this.containers.ensureStopped(`sacty-run-${runId}`);
  }

  abortAll(): void {
    this.aborting = true;
    this.containers.stopAll();
  }

  async run({
    runId,
    image,
    workspaceDir,
    invocation,
    imageEnv = {},
  }: Parameters<AgentExecutor["run"]>[0]): Promise<AgentOutcome> {
    const env = { ...imageEnv, ...invocation.env };
    // コピーして渡すファイル（Codexの認証ファイルなど）は、実行ごとの一時ディレクトリに置き、
    // ディレクトリごとマウントする（ファイル単体だと親ディレクトリがroot所有になり書き込めないため）
    const staging = invocation.stage ? mkdtempSync(join(tmpdir(), "sacty-run-")) : null;
    const mounts: { hostPath: string; containerPath: string; readOnly: boolean }[] = [];
    const syncBacks: { hostPath: string; stagedPath: string; hashAtCopy: string }[] = [];
    // ステージした認証ファイルの値（実行前と、コンテナで更新された後の両方）。出力から取り除く。
    const stagedPaths: string[] = [];
    const stagedSecrets: string[] = [];
    const collectSecrets = () => {
      for (const path of stagedPaths) {
        try {
          stagedSecrets.push(...secretStringsInJson(readFileSync(path, "utf8")));
        } catch {
          // 消えていれば何もしない
        }
      }
    };
    if (invocation.stage && staging) {
      // 合成したコンテキストなどを先に写す（認証ファイルは、そのあとに置く）
      if (invocation.stage.seedDir) {
        cpSync(invocation.stage.seedDir, staging, { recursive: true });
      }
      for (const file of invocation.stage.files) {
        const copied = join(staging, basename(file.name));
        try {
          copyFileSync(file.hostPath, copied);
          stagedPaths.push(copied);
          const hashAtCopy = hashOf(copied);
          if (file.syncBack && hashAtCopy) {
            syncBacks.push({ hostPath: file.hostPath, stagedPath: copied, hashAtCopy });
          }
        } catch {
          rmSync(staging, { recursive: true, force: true });
          return {
            kind: "failed",
            reason: "auth",
            message: message("run.authFileUnreadable", { path: file.hostPath }),
          };
        }
        chmodSync(copied, 0o600);
      }
      collectSecrets();
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
      envNames: Object.keys(env),
      mounts,
      command: invocation.command,
      ...(invocation.hostGateway
        ? { hostGateway: invocation.hostAddress ?? DEFAULT_HOST_ADDRESS }
        : {}),
    });

    const containerName = `sacty-run-${runId}`;
    this.containers.register(containerName);
    let outcome: AgentOutcome;
    try {
      const { exitCode, stdout, stderr } = await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = this.spawnImpl("docker", args, {
          env: { ...dockerClientEnv(), ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.containers.attach(containerName, child);
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          err += chunk;
        });
        const timer = setTimeout(() => {
          this.containers.stop(containerName);
          reject(new MessageError(message("run.timeout", { minutes: this.timeoutMs / 60_000 })));
        }, this.timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(new MessageError(message("run.dockerUnavailable", { detail: error.message })));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout: out, stderr: err });
        });
      });

      if (this.aborting) {
        outcome = {
          kind: "failed",
          reason: "error",
          message: message("run.daemonStopped"),
        };
      } else if (/Unable to find image|No such image|pull access denied/i.test(stderr)) {
        outcome = {
          kind: "failed",
          reason: "error",
          message: message("run.imageMissing", { image }),
        };
      } else {
        outcome =
          invocation.parser === "codex-jsonl"
            ? parseCodexEvents(stdout, exitCode, stderr)
            : parseClaudeResult(stdout, exitCode, stderr);
      }
    } finally {
      // 止める要求があったなら、コンテナが無くなったことを確かめるまで完了にしない
      if (!(await this.containers.finish(containerName))) {
        outcome = {
          kind: "failed",
          reason: "error",
          message: message("run.containerNotConfirmed", { name: containerName }),
        };
      }
      collectSecrets(); // コンテナで更新された認証情報も、出力から取り除く対象にする
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
    return outcome.kind === "failed"
      ? { ...outcome, message: redactText(outcome.message, stagedSecrets) }
      : { ...outcome, output: redact(outcome.output, stagedSecrets) };
  }
}
