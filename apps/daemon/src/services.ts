import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type DaemonText, message } from "@sacty/core";
import { dockerClientEnv } from "./agents/docker.js";

/**
 * docker compose のサービス（DB・モック API など）を、工程の実行・テストの実行ごとに起動する（PBI-47）。
 * エージェントには Docker の権限を渡さず、sacty（ホスト）が起動し、エージェント・テストのコンテナを
 * そのネットワークにつなぐ。compose ファイルは対象リポジトリ（信用できない入力）から来るので、
 * `docker compose config` で正規化してから危ない設定を拒否し、ホストのポート・固定の名前を外して起動する。
 */

/** 工程で使うサービス（オーケストレーターが決める）。 */
export type ServicesSpec = {
  /** compose ファイル（作業領域からの相対パス）。 */
  file: string;
  /** 起動するサービス（依存するサービスも起動する）。空なら compose ファイルのすべて。 */
  names: string[];
};

/** 起動したサービス。エージェントに伝える接続先。 */
export type StartedServices = {
  /** エージェント・テストのコンテナをつなぐネットワーク。 */
  network: string;
  services: { name: string; ports: number[] }[];
};

/** エージェント・テストのコンテナをつなぐ、sacty が足すネットワークの名前（compose の中の名前）。 */
const SACTY_NETWORK = "sacty";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * path が dir の中か（dir 自身を含む）。シンボリックリンクはたどってから比べる。まだ無いパスは、存在する一番近い親の
 * リンクをたどり、残りをつなげて比べる（macOS の /var → /private/var のように、親がリンクのときもずれないように）。
 */
function inside(dir: string, path: string): boolean {
  const real = (p: string): string => {
    const absolute = resolve(p);
    try {
      return realpathSync(absolute);
    } catch {
      const parent = dirname(absolute);
      return parent === absolute ? absolute : join(real(parent), basename(absolute));
    }
  };
  const rel = relative(real(dir), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 正規化した compose の設定（`docker compose config --format json` の出力）を確かめ、起動に使う設定にする。
 * 使うサービスと、その依存（depends_on・network_mode: service:）の範囲だけを確かめて残す。
 * 危ない設定があれば、理由を返す（起動しない）。
 */
export function sanitizeCompose(
  config: unknown,
  workspaceDir: string,
  names: readonly string[],
):
  | { ok: true; config: Json; services: StartedServices["services"] }
  | { ok: false; problems: string[] } {
  if (!isObject(config) || !isObject(config.services)) {
    return { ok: false, problems: ["services がありません"] };
  }
  const all = config.services as Record<string, Json>;
  const problems: string[] = [];
  const missing = names.filter((name) => !isObject(all[name]));
  if (missing.length > 0)
    return { ok: false, problems: [`サービス ${missing.join("・")} がありません`] };

  // 使うサービスと、その依存
  const wanted = new Set<string>();
  const visit = (name: string) => {
    if (wanted.has(name)) return;
    const service = all[name];
    if (!isObject(service)) {
      problems.push(`${name}：依存するサービスがありません`);
      return;
    }
    wanted.add(name);
    const deps = Array.isArray(service.depends_on)
      ? (service.depends_on as string[])
      : isObject(service.depends_on)
        ? Object.keys(service.depends_on)
        : [];
    for (const dep of deps) visit(dep);
    const mode = typeof service.network_mode === "string" ? service.network_mode : "";
    if (mode.startsWith("service:")) visit(mode.slice("service:".length));
  };
  for (const name of names.length > 0 ? names : Object.keys(all)) visit(name);

  const services: Record<string, Json> = {};
  const usedNetworks = new Set<string>();
  const usedVolumes = new Set<string>();
  for (const name of wanted) {
    const service = { ...(all[name] as Json) };
    const bad = (detail: string) => problems.push(`${name}：${detail}`);
    if (service.privileged === true) bad("privileged は使えません");
    if (Array.isArray(service.cap_add) && service.cap_add.length > 0) bad("cap_add は使えません");
    for (const key of ["devices", "device_cgroup_rules", "volumes_from"]) {
      if (Array.isArray(service[key]) && (service[key] as unknown[]).length > 0) {
        bad(`${key} は使えません`);
      }
    }
    if (service.cgroup_parent !== undefined) bad("cgroup_parent は使えません");
    const mode = typeof service.network_mode === "string" ? service.network_mode : undefined;
    if (mode !== undefined && !mode.startsWith("service:") && mode !== "bridge") {
      bad(`network_mode: ${mode} は使えません`);
    }
    for (const key of ["pid", "ipc", "uts", "userns_mode", "cgroup"]) {
      const value = service[key];
      if (typeof value === "string" && (value === "host" || value.startsWith("container:"))) {
        bad(`${key}: ${value} は使えません`);
      }
    }
    if (
      Array.isArray(service.security_opt) &&
      (service.security_opt as unknown[]).some((o) => String(o).includes("unconfined"))
    ) {
      bad("security_opt の unconfined は使えません");
    }
    // ボリューム：ホストのパスは作業領域の中だけ（Docker のソケットも外になる）
    for (const volume of Array.isArray(service.volumes) ? (service.volumes as Json[]) : []) {
      const type = volume.type;
      const source = typeof volume.source === "string" ? volume.source : "";
      if (type === "bind") {
        if (!isAbsolute(source) || !inside(workspaceDir, source)) {
          bad(`作業領域の外のパス（${source}）はマウントできません`);
        }
      } else if (type === "volume") {
        if (source) usedVolumes.add(source);
      } else if (type !== "tmpfs") {
        bad(`volumes の type: ${String(type)} は使えません`);
      }
    }
    // ビルド：context と Dockerfile は作業領域の中だけ（git の URL なども使えない）
    if (isObject(service.build)) {
      const context = typeof service.build.context === "string" ? service.build.context : "";
      const dockerfile =
        typeof service.build.dockerfile === "string" ? service.build.dockerfile : "Dockerfile";
      if (!isAbsolute(context) || !inside(workspaceDir, context)) {
        bad(`作業領域の外（${context}）はビルドできません`);
      } else if (!inside(workspaceDir, resolve(context, dockerfile))) {
        bad(`作業領域の外の Dockerfile（${dockerfile}）は使えません`);
      }
      if (isObject(service.build.additional_contexts))
        bad("build.additional_contexts は使えません");
    }
    for (const file of Array.isArray(service.env_file) ? (service.env_file as unknown[]) : []) {
      const path = isObject(file) ? file.path : file;
      if (typeof path !== "string" || !inside(workspaceDir, path)) {
        bad(`作業領域の外の env_file（${String(path)}）は使えません`);
      }
    }
    // ホストのポートに出さない・固定の名前を使わない（ほかのタスクとぶつかるため）。つなぐ先はネットワークの中
    const ports = [
      ...(Array.isArray(service.ports) ? (service.ports as Json[]) : []).map((p) =>
        Number(p.target),
      ),
      ...(Array.isArray(service.expose) ? (service.expose as unknown[]) : []).map((p) =>
        Number(String(p).split("/")[0]),
      ),
    ].filter((p) => Number.isInteger(p) && p > 0);
    delete service.ports;
    delete service.container_name;
    if (mode === undefined) {
      const networks = isObject(service.networks) ? { ...service.networks } : { default: null };
      for (const network of Object.keys(networks)) usedNetworks.add(network);
      service.networks = { ...networks, [SACTY_NETWORK]: null };
    }
    services[name] = { ...service, _ports: [...new Set(ports)].sort((a, b) => a - b) };
  }

  // ネットワーク・ボリューム：外部のもの・ホストに届くドライバーは使えない。固定の名前は外す（プロジェクトごとにする）
  const networks: Json = { [SACTY_NETWORK]: {} };
  for (const name of usedNetworks) {
    const network =
      isObject(config.networks) && isObject(config.networks[name])
        ? { ...config.networks[name] }
        : {};
    if (network.external === true) problems.push(`ネットワーク ${name}：external は使えません`);
    if (network.driver !== undefined && network.driver !== "bridge") {
      problems.push(`ネットワーク ${name}：driver: ${String(network.driver)} は使えません`);
    }
    delete network.name;
    networks[name] = network;
  }
  const volumes: Json = {};
  for (const name of usedVolumes) {
    const volume =
      isObject(config.volumes) && isObject(config.volumes[name]) ? { ...config.volumes[name] } : {};
    if (volume.external === true) problems.push(`ボリューム ${name}：external は使えません`);
    // local ドライバーの driver_opts（type: none・o: bind）はホストのパスをマウントできる
    if (volume.driver !== undefined || volume.driver_opts !== undefined) {
      problems.push(`ボリューム ${name}：driver・driver_opts は使えません`);
    }
    delete volume.name;
    volumes[name] = volume;
  }
  for (const key of ["secrets", "configs"]) {
    for (const [name, value] of Object.entries(
      isObject(config[key]) ? (config[key] as Json) : {},
    )) {
      if (
        isObject(value) &&
        (value.external === true ||
          (typeof value.file === "string" && !inside(workspaceDir, value.file)))
      ) {
        problems.push(`${key} ${name}：作業領域の外のファイルや external は使えません`);
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const started = Object.entries(services).map(([name, service]) => {
    const ports = service._ports as number[];
    delete service._ports;
    return { name, ports };
  });
  return {
    ok: true,
    config: {
      services,
      networks,
      ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
      ...(isObject(config.secrets) ? { secrets: config.secrets } : {}),
      ...(isObject(config.configs) ? { configs: config.configs } : {}),
    },
    services: started,
  };
}

/** compose のプロジェクトの名前（実行ごと。ほかのタスク・実行とぶつからない）。 */
export function composeProject(runId: string): string {
  return `sacty-svc-${runId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32)}`;
}

/** サービスを起動・停止する口。テストでは偽物に差し替える。 */
export interface ServiceRunner {
  start(input: {
    runId: string;
    workspaceDir: string;
    spec: ServicesSpec;
  }): Promise<{ ok: true; started: StartedServices } | { ok: false; message: DaemonText }>;
  /** 止めて消す（コンテナ・ネットワーク・ボリューム）。無ければ何もしない。 */
  stop(runId: string): Promise<void>;
}

/** 出力の末尾（失敗の理由に添える）。 */
const LOG_TAIL = 2000;

export class DockerComposeServices implements ServiceRunner {
  constructor(
    private readonly spawnImpl: typeof spawn = spawn,
    /** サービスの準備（healthcheck）を待つ上限（秒）。 */
    private readonly waitSec = 300,
  ) {}

  private compose(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
    return new Promise((done) => {
      const child = this.spawnImpl("docker", ["compose", ...args], {
        env: dockerClientEnv(),
        ...(cwd ? { cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", (error) => done({ code: 127, out: error.message }));
      child.on("close", (code) => done({ code: code ?? 1, out }));
    });
  }

  async start({ runId, workspaceDir, spec }: Parameters<ServiceRunner["start"]>[0]) {
    const file = resolve(workspaceDir, spec.file);
    if (!inside(workspaceDir, file)) {
      return {
        ok: false as const,
        message: message("services.unsafe", {
          file: spec.file,
          detail: "作業領域の外のファイルです",
        }),
      };
    }
    // 正規化（include・extends・変数の展開・相対パスの解決）してから確かめる
    const normalized = await this.compose(["-f", file, "config", "--format", "json"], workspaceDir);
    if (normalized.code !== 0) {
      return {
        ok: false as const,
        message: message("services.failed", {
          file: spec.file,
          detail: normalized.out.slice(-LOG_TAIL),
        }),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.out);
    } catch {
      return {
        ok: false as const,
        message: message("services.failed", {
          file: spec.file,
          detail: normalized.out.slice(-LOG_TAIL),
        }),
      };
    }
    const safe = sanitizeCompose(parsed, workspaceDir, spec.names);
    if (!safe.ok) {
      return {
        ok: false as const,
        message: message("services.unsafe", { file: spec.file, detail: safe.problems.join("、") }),
      };
    }
    const project = composeProject(runId);
    const dir = mkdtempSync(join(tmpdir(), "sacty-compose-"));
    try {
      const sanitized = join(dir, "compose.json");
      writeFileSync(sanitized, JSON.stringify(safe.config));
      const up = await this.compose(
        [
          "-p",
          project,
          "-f",
          sanitized,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          String(this.waitSec),
          ...safe.services.map((s) => s.name),
        ],
        workspaceDir,
      );
      if (up.code !== 0) {
        await this.stop(runId);
        return {
          ok: false as const,
          message: message("services.failed", { file: spec.file, detail: up.out.slice(-LOG_TAIL) }),
        };
      }
      return {
        ok: true as const,
        started: { network: `${project}_${SACTY_NETWORK}`, services: safe.services },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** sacty が起動したサービス（プロジェクトの名前が sacty-svc-）をすべて止めて消す（デーモンの起動時）。 */
  async cleanupAll(): Promise<void> {
    const listed = await this.compose(["ls", "--all", "--format", "json"]);
    if (listed.code !== 0) return;
    let projects: { Name?: string }[] = [];
    try {
      projects = JSON.parse(listed.out) as { Name?: string }[];
    } catch {
      return;
    }
    for (const name of projects
      .map((p) => p.Name ?? "")
      .filter((n) => n.startsWith("sacty-svc-"))) {
      await this.compose(["-p", name, "down", "-v", "--remove-orphans"]);
    }
  }

  async stop(runId: string): Promise<void> {
    // プロジェクトの名前だけで止めて消せる（compose ファイルは要らない）
    await this.compose(["-p", composeProject(runId), "down", "-v", "--remove-orphans"]);
  }
}
