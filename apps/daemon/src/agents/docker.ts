import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { message } from "@sacty/core";
import { assertRealParents, NOFOLLOW_READ_FLAGS } from "../agent-sessions.js";
import { AGENT_RUN_TIMEOUT_MS } from "../context.js";
import { MessageError } from "../errors.js";
import { DEFAULT_HOST_ADDRESS } from "../gateway.js";
import type { SessionLogSink } from "../session-logs.js";
import { forwardNotices, type LocalForward, withLocalForwards } from "./forward.js";
import type { Invocation } from "./invocation.js";
import { withOutputRelay } from "./output-relay.js";
import { type AgentOutcome, ClaudeOutcomeReader, CodexOutcomeReader } from "./parse.js";
import { redact, redactText, secretStringsInJson } from "./redact.js";

export const CONTAINER_WORKSPACE = "/workspace";
/** レビューの工程で、PR の差分の全体を読み取り専用で置くディレクトリ（作業領域の外。PBI-65）。 */
export const CONTAINER_REVIEW_DIR = "/sacty-review";

/**
 * 診断に使う出力（標準エラー出力）の、先頭と末尾だけを持つ（PBI-62）。長い実行でも、デーモンのメモリが出力の大きさに
 * 比例して増えないように。先頭には起動の失敗（イメージが無い・転送の知らせ）、末尾には終わりの原因が出る。
 */
export class HeadTailText {
  private head = "";
  private tail = "";
  private dropped = false;

  constructor(
    private readonly headLimit: number,
    private readonly tailLimit: number,
  ) {}

  push(text: string): void {
    if (!text) return;
    const room = this.headLimit - this.head.length;
    if (room > 0) {
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail += text;
    // 毎回切り出すと遅いので、上限の2倍を超えたら末尾の上限の分だけにする
    if (this.tail.length > this.tailLimit * 2) {
      this.tail = this.tail.slice(-this.tailLimit);
      this.dropped = true;
    }
  }

  toString(): string {
    if (this.tail.length > this.tailLimit) {
      this.tail = this.tail.slice(-this.tailLimit);
      this.dropped = true;
    }
    return this.dropped ? `${this.head}\n…\n${this.tail}` : this.head + this.tail;
  }
}

/** 標準エラー出力の、持っておく先頭と末尾（文字数）。 */
const STDERR_HEAD = 64 * 1024;
const STDERR_TAIL = 256 * 1024;

function hashOf(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** ステージしたファイル（実行ごとの一時ディレクトリ dir の中の、相対パス name。区切りは /）。 */
export type StagedFile = { dir: string; name: string };

/**
 * ステージしたファイルを、リンクを辿らずに読む（PBI-71）。一時ディレクトリはコンテナにマウントするので、コンテナが
 * 中のファイルや途中のディレクトリを、ホストのほかのファイルへのリンクや FIFO に差し替えられる。リンクを辿らずに
 * 待たずに開き、開いたものが通常のファイルであること、一時ディレクトリと途中のディレクトリがリンクでないこと
 * （開く前と後）を確かめる。違えば例外（ホストのほかのファイルの中身を読まない）。
 */
export function readStagedFile(staged: StagedFile): Buffer {
  const assertRealDirs = () => {
    if (!lstatSync(staged.dir).isDirectory()) throw new Error(`${staged.dir}: not a directory`);
    assertRealParents(staged.dir, staged.name);
  };
  assertRealDirs();
  const fd = openSync(join(staged.dir, ...staged.name.split("/")), NOFOLLOW_READ_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${staged.name}: not a regular file`);
    assertRealDirs();
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hashOfStaged(staged: StagedFile): string | undefined {
  try {
    return createHash("sha256").update(readStagedFile(staged)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * コンテナの中で更新されたファイル（Codexの認証ファイルなど）を、ホストに書き戻す。
 * トークンの更新で古いトークンが無効になる方式だと、書き戻さないとホストのログインが壊れるため。
 * ただし実行中にホスト側のファイルが変わっていたら、利用者の操作を優先して書き戻さない。
 * ステージしたファイルはリンクを辿らずに1度だけ読み、確かめた中身をそのまま書く（PBI-71）。リンク・通常のファイル
 * 以外に差し替えられていれば読まず、書き戻さない（"not-regular"）。
 */
export function syncBackIfChanged(
  hostPath: string,
  staged: StagedFile,
  hashAtCopy: string,
): "written" | "unchanged" | "host-changed" | "not-regular" {
  let content: Buffer;
  try {
    content = readStagedFile(staged);
  } catch (error) {
    // 消えていれば何もしない。リンクなどに差し替えられていれば書き戻さない
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unchanged" : "not-regular";
  }
  if (createHash("sha256").update(content).digest("hex") === hashAtCopy) return "unchanged";
  if (hashOf(hostPath) !== hashAtCopy) return "host-changed";
  const temp = join(dirname(hostPath), `.${basename(hostPath)}.sacty-${process.pid}`);
  writeFileSync(temp, content, { mode: 0o600 });
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
    /** つなぐネットワーク（docker compose のサービス。PBI-47）。 */
    network?: string;
    /** コンテナの中で localhost に転送するサービスのポート（PBI-60）。無ければ、コマンドはそのまま。 */
    forwards?: readonly LocalForward[];
    /** 標準出力・標準エラー出力を、届くたびに渡す先（セッションログ。PBI-62）。 */
    log?: SessionLogSink;
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
  /** つなぐネットワーク（docker compose のサービスのネットワーク。PBI-47）。 */
  network?: string;
}): string[] {
  return [
    "run",
    "--rm",
    ...(input.network ? ["--network", input.network] : []),
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
    private readonly timeoutMs = AGENT_RUN_TIMEOUT_MS,
    spawnImpl: typeof spawn = spawn,
    containers?: RunningContainers,
  ) {
    this.containers = containers ?? new RunningContainers(spawnImpl);
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
    network,
    forwards = [],
    log,
  }: Parameters<AgentExecutor["run"]>[0]): Promise<AgentOutcome> {
    const env = { ...imageEnv, ...invocation.env };
    // コピーして渡すファイル（Codexの認証ファイルなど）は、実行ごとの一時ディレクトリに置き、
    // ディレクトリごとマウントする（ファイル単体だと親ディレクトリがroot所有になり書き込めないため）
    const staging = invocation.stage ? mkdtempSync(join(tmpdir(), "sacty-run-")) : null;
    const mounts: { hostPath: string; containerPath: string; readOnly: boolean }[] = [];
    const syncBacks: { hostPath: string; staged: StagedFile; hashAtCopy: string }[] = [];
    // ステージした認証ファイルの値（実行前と、コンテナで更新された後の両方）。出力から取り除く。
    const stagedFiles: StagedFile[] = [];
    const stagedSecrets: string[] = [];
    const collectSecrets = () => {
      for (const staged of stagedFiles) {
        try {
          // リンクを辿らずに読む（コンテナが差し替えたリンクの先や FIFO を読まない。PBI-71）
          stagedSecrets.push(...secretStringsInJson(readStagedFile(staged).toString("utf8")));
        } catch {
          // 消えていれば・リンクなどに差し替えられていれば何もしない
        }
      }
      // セッションログからも伏せる（PBI-62）
      log?.addSecrets(stagedSecrets);
    };
    if (invocation.stage && staging) {
      // 合成したコンテキストなどを先に写す（認証ファイルは、そのあとに置く）
      if (invocation.stage.seedDir) {
        cpSync(invocation.stage.seedDir, staging, { recursive: true });
      }
      // 保存したオーケストレーターのセッションを、設定の場所に戻す（PBI-67）。戻せなければ、起動せずに失敗にする
      // （呼ぶ側が、新しいセッションで始め直す）
      if (invocation.stage.sessionDir) {
        try {
          cpSync(invocation.stage.sessionDir, staging, { recursive: true });
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          return {
            kind: "failed",
            reason: "error",
            message: message("run.sessionRestoreFailed", {
              detail: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      }
      for (const file of invocation.stage.files) {
        const staged: StagedFile = { dir: staging, name: basename(file.name) };
        const copied = join(staging, staged.name);
        try {
          copyFileSync(file.hostPath, copied);
          stagedFiles.push(staged);
          const hashAtCopy = hashOfStaged(staged);
          if (file.syncBack && hashAtCopy) {
            syncBacks.push({ hostPath: file.hostPath, staged, hashAtCopy });
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

    // 追加のマウント（レビューの差分の全体など。sacty が管理する場所だけ。PBI-65）
    mounts.push(...(invocation.mounts ?? []));

    const args = dockerRunArgs({
      runId,
      image,
      workspaceDir,
      envNames: Object.keys(env),
      mounts,
      ...(network ? { network } : {}),
      // 出力は中継を通して受け取る（標準出力が非ブロッキングにされても、コマンドが EAGAIN で落ちないように。PBI-64）
      command: withOutputRelay(withLocalForwards(invocation.command, forwards)),
      ...(invocation.hostGateway
        ? { hostGateway: invocation.hostAddress ?? DEFAULT_HOST_ADDRESS }
        : {}),
    });

    const containerName = `sacty-run-${runId}`;
    this.containers.register(containerName);
    let outcome: AgentOutcome;
    // 標準出力は全体を持たず、行ごとに読んで最後の答えに要るものだけを持つ（PBI-62）
    const reader =
      invocation.parser === "codex-jsonl" ? new CodexOutcomeReader() : new ClaudeOutcomeReader();
    try {
      const { exitCode, stderr } = await new Promise<{
        exitCode: number;
        stderr: string;
      }>((resolve, reject) => {
        const child = this.spawnImpl("docker", args, {
          env: { ...dockerClientEnv(), ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.containers.attach(containerName, child);
        const err = new HeadTailText(STDERR_HEAD, STDERR_TAIL);
        // 届いた分の境目で、複数バイトの文字が壊れないようにつなげて読む
        const outText = new StringDecoder("utf8");
        const errText = new StringDecoder("utf8");
        const text = (decoder: StringDecoder, chunk: Buffer | string) =>
          typeof chunk === "string" ? chunk : decoder.write(chunk);
        child.stdout.on("data", (chunk: Buffer | string) => {
          const piece = text(outText, chunk);
          reader.push(piece);
          log?.stdout(piece);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          const piece = text(errText, chunk);
          err.push(piece);
          log?.stderr(piece);
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
          const outRest = outText.end();
          const errRest = errText.end();
          reader.push(outRest);
          err.push(errRest);
          log?.stdout(outRest);
          log?.stderr(errRest);
          resolve({ exitCode: code ?? 1, stderr: err.toString() });
        });
      });

      // 転送しなかったポート（すでに使われていたなど。PBI-60）は、デーモンのログに残す
      for (const notice of forwardNotices(stderr))
        console.warn(`[daemon] ${containerName}：${notice}`);
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
        outcome = reader.finish(exitCode, stderr);
      }
    } finally {
      // 止める要求があったなら、コンテナが無くなったことを確かめるまで完了にしない
      const stopped = await this.containers.finish(containerName);
      if (!stopped) {
        outcome = {
          kind: "failed",
          reason: "error",
          message: message("run.containerNotConfirmed", { name: containerName }),
        };
      }
      collectSecrets(); // コンテナで更新された認証情報も、出力から取り除く対象にする
      // コンテナが止まったことを確かめられなければ、認証ファイルを書き戻さない（動いたままのコンテナは、書き戻す途中の
      // ファイルをホストのほかのファイルへのリンクに差し替えられる。PBI-71）。書き戻さなかったことと理由は、デーモンの
      // ログに残す（値は出さない）
      for (const file of syncBacks) {
        if (!stopped) {
          console.warn(
            `[daemon] ${containerName} が止まったことを確かめられないため、${file.hostPath} への書き戻しをしませんでした。`,
          );
          continue;
        }
        try {
          const result = syncBackIfChanged(file.hostPath, file.staged, file.hashAtCopy);
          if (result === "host-changed") {
            console.warn(
              `[daemon] ${file.hostPath} が実行中に変更されたため、コンテナでの更新は書き戻しませんでした。`,
            );
          } else if (result === "not-regular") {
            console.warn(
              `[daemon] ${containerName} の中の ${file.staged.name} を通常のファイルとして読めない（リンクなどに差し替えられた）ため、${file.hostPath} へは書き戻しませんでした。`,
            );
          }
        } catch (error) {
          console.warn(`[daemon] ${file.hostPath} を書き戻せませんでした：`, error);
        }
      }
      // エージェントの元のセッションのファイルを、一時的な場所を消す前に写す（失敗・止めた・中止した実行も。PBI-66）。
      // 認証ファイルの書き戻しの後（大きなファイルを写す間、更新されたトークンの書き戻しを待たせない）に写す
      // コンテナが止まったことを確かめられなければ写さない（動いたままのコンテナは、写す途中のファイルをホストの
      // ほかのファイルへのリンクに差し替えられる）。写さなかったことと理由は、作業履歴に記録する
      if (staging && invocation.sessionFiles && log) {
        const session = {
          runtime: invocation.sessionFiles,
          ...(reader.sessionId ? { sessionId: reader.sessionId } : {}),
        };
        if (stopped) await log.archiveAgentFiles({ dir: staging, ...session });
        else log.agentFilesNotArchived({ ...session, reason: "container_not_confirmed" });
      }
      if (staging) rmSync(staging, { recursive: true, force: true });
    }
    return outcome.kind === "failed"
      ? { ...outcome, message: redactText(outcome.message, stagedSecrets) }
      : { ...outcome, output: redact(outcome.output, stagedSecrets) };
  }
}
