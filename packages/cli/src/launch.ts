import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderMessage } from "@sacty/core";
import {
  claudeLaunch,
  codexLaunch,
  codexUserMcpServers,
  type LaunchFile,
  type LaunchPlan,
} from "@sacty/daemon/local-launch";
import {
  type DaemonEndpoint,
  daemonRequest,
  type Fetch,
  resolveProjectId,
} from "./context-preview.js";

/** デーモンが返すローカルのセッション（apps/daemon の LocalSessionView）。 */
export type LocalSession = {
  id: string;
  runtime: "claude-code" | "codex";
  files: LaunchFile[];
  env: Record<string, string>;
  mcpServers: string[];
  warnings: unknown[];
};

export type LaunchOptions = {
  project: string;
  runtime: "claude-code" | "codex";
  cwd: string;
  extraArgs: string[];
};

/** `sacty launch` の引数を、sacty の分と、`--` の後の AI の CLI に渡す分に分ける。 */
export function splitLaunchArgs(argv: readonly string[]): { own: string[]; extra: string[] } {
  const at = argv.indexOf("--");
  return at < 0
    ? { own: [...argv], extra: [] }
    : { own: argv.slice(0, at), extra: argv.slice(at + 1) };
}

/** AI の CLI の起動の組み立て（ファイルの置き方と引数）。 */
export function launchPlan(session: LocalSession, dir: string, options: LaunchOptions): LaunchPlan {
  return session.runtime === "codex"
    ? codexLaunch(dir, session.files, codexUserMcpServers(options.cwd), options.extraArgs)
    : claudeLaunch(dir, session.files, options.extraArgs);
}

/** 置くファイルを書く（本人だけが読める権限）。 */
export function writeLaunchFiles(dir: string, files: LaunchPlan["files"]): void {
  for (const file of files) {
    const to = join(dir, file.path);
    if (!resolve(to).startsWith(`${dir}/`)) throw new Error(`置けないパスです：${file.path}`);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, file.content, { mode: 0o600 });
  }
}

type Deps = {
  fetcher?: Fetch;
  spawn?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  log?: (line: string) => void;
};

/**
 * `sacty launch`：起動中のデーモンにローカルのセッションを作らせ、一時ディレクトリにコンテキストを置いて、AI の CLI を端末の
 * 子プロセスとして起動する。終わったら（失敗・シグナルでも）セッションを終え、一時ディレクトリを消す。AI の CLI の終了コードを返す。
 */
export async function launch(
  endpoint: DaemonEndpoint,
  options: LaunchOptions,
  deps: Deps = {},
): Promise<number> {
  const fetcher = deps.fetcher ?? fetch;
  const log = deps.log ?? ((line: string) => console.error(line));
  const id = await resolveProjectId(endpoint, options.project, fetcher);
  // 本人だけが読める一時ディレクトリ（mkdtemp は 0700 で作る）。macOS の /var → /private/var のようなリンクは解いて渡す
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sacty-launch-")));
  let sessionId: string | undefined;
  const close = async () => {
    if (sessionId) {
      const closing = sessionId;
      sessionId = undefined;
      try {
        await daemonRequest(
          endpoint,
          `/api/local-sessions/${encodeURIComponent(closing)}`,
          fetcher,
          {
            method: "DELETE",
          },
        );
      } catch {
        // デーモンが止まっていれば、登録も残っていない
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const res = await daemonRequest(
      endpoint,
      `/api/projects/${encodeURIComponent(id)}/local-sessions`,
      fetcher,
      { method: "POST", body: { runtime: options.runtime, dir } },
    );
    if (!res.ok) throw new Error(`デーモンが ${res.status} を返しました。`);
    const result = (await res.json()) as { session: LocalSession } | { error: unknown };
    if ("error" in result) {
      throw new Error(`コンテキストを用意できませんでした：${renderMessage(result.error, "ja")}`);
    }
    const session = result.session;
    sessionId = session.id;
    for (const warning of session.warnings) log(`[sacty] 注意：${renderMessage(warning, "ja")}`);
    const plan = launchPlan(session, dir, options);
    for (const file of plan.notApplied) {
      log(
        `[sacty] 注意：${file.from ? `${file.from} の ` : ""}${file.path} は、手元の起動では渡せないため渡しませんでした。`,
      );
    }
    for (const { from, to } of plan.renamed ?? []) {
      log(
        `[sacty] 注意：MCP サーバー「${from}」は、手元の Codex の設定に同じ名前があるため、「${to}」として渡しました（手元の「${from}」は使いません）。`,
      );
    }
    writeLaunchFiles(dir, plan.files);
    const env = { ...process.env, ...session.env };
    const start =
      deps.spawn ??
      ((command, args, cwd, childEnv) =>
        spawn(command, args, { stdio: "inherit", cwd, env: childEnv }));
    return await new Promise<number>((done, fail) => {
      const child = start(plan.command, plan.args, options.cwd, env);
      // 端末の Ctrl+C は、子プロセスにも届く。sacty は止まらずに子の終了を待ち、後片付けをする
      const ignore = () => {};
      const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
      const onTerm = forward("SIGTERM");
      const onHup = forward("SIGHUP");
      process.on("SIGINT", ignore);
      process.on("SIGTERM", onTerm);
      process.on("SIGHUP", onHup);
      const off = () => {
        process.off("SIGINT", ignore);
        process.off("SIGTERM", onTerm);
        process.off("SIGHUP", onHup);
      };
      child.on("error", (error: NodeJS.ErrnoException) => {
        off();
        fail(
          error.code === "ENOENT"
            ? new Error(
                `${plan.command} が見つかりません。インストールして PATH に置いてから実行してください。`,
              )
            : error,
        );
      });
      child.on("close", (code, signal) => {
        off();
        done(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1));
      });
    });
  } finally {
    await close();
  }
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}
