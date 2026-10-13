import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeProject, sanitizeCompose } from "./services.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "sacty-services-test-"));
  mkdirSync(join(ws, "db"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** `docker compose config --format json` の出力の形（相対パスは絶対パスに、ネットワーク・ボリュームには名前が付く）。 */
const normalized = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name: "repo",
  networks: { default: { name: "repo_default", ipam: {} } },
  services,
  ...extra,
});

describe("compose の設定の確かめ（PBI-47）", () => {
  it("ホストのポートと固定の名前を外し、sacty のネットワークを足す。ネットワーク・ボリュームの固定の名前も外す", () => {
    const result = sanitizeCompose(
      normalized(
        {
          db: {
            image: "postgres:16",
            container_name: "fixed-db",
            ports: [{ target: 5432, published: "5432", protocol: "tcp" }],
            expose: ["9187/tcp"],
            networks: { default: null },
            volumes: [
              { type: "bind", source: join(ws, "db"), target: "/docker-entrypoint-initdb.d" },
              { type: "volume", source: "data", target: "/var/lib/postgresql/data" },
              { type: "tmpfs", target: "/tmp" },
            ],
          },
        },
        { volumes: { data: { name: "repo_data" } } },
      ),
      ws,
      ["db"],
    );
    if (!result.ok) throw new Error(result.problems.join());
    const db = (result.config.services as Record<string, Record<string, unknown>>).db;
    expect(db).not.toHaveProperty("ports");
    expect(db).not.toHaveProperty("container_name");
    expect(db?.networks).toEqual({ default: null, sacty: null });
    expect(result.config.networks).toEqual({ sacty: {}, default: { ipam: {} } });
    expect(result.config.volumes).toEqual({ data: {} });
    expect(result.services).toEqual([{ name: "db", ports: [5432, 9187] }]);
  });

  it("使うサービスと、その依存（depends_on・network_mode: service:）だけを確かめて残す", () => {
    const config = normalized({
      api: { image: "api", depends_on: { db: { condition: "service_healthy" } } },
      db: { image: "postgres" },
      sidecar: { image: "x", network_mode: "service:db" },
      // 使わないサービスの危ない設定は、起動しないので拒否しない
      dev: { image: "dev", privileged: true },
    });
    const api = sanitizeCompose(config, ws, ["api"]);
    expect(api.ok && Object.keys(api.config.services as object).sort()).toEqual(["api", "db"]);
    const sidecar = sanitizeCompose(config, ws, ["sidecar"]);
    expect(sidecar.ok && Object.keys(sidecar.config.services as object).sort()).toEqual([
      "db",
      "sidecar",
    ]);
    // network_mode のサービスは、ネットワークを足さない（compose が拒否するため）
    expect(
      sidecar.ok && (sidecar.config.services as Record<string, Record<string, unknown>>).sidecar,
    ).not.toHaveProperty("networks");
    // 名前を指定しなければ、すべて（dev の privileged も確かめる）
    expect(sanitizeCompose(config, ws, [])).toEqual({
      ok: false,
      problems: ["dev：privileged は使えません"],
    });
    expect(sanitizeCompose(config, ws, ["nope"])).toEqual({
      ok: false,
      problems: ["サービス nope がありません"],
    });
  });

  it("エージェントにホストの権限が渡る設定は拒否する", () => {
    const problems = (service: Record<string, unknown>) => {
      const result = sanitizeCompose(normalized({ s: { image: "x", ...service } }), ws, ["s"]);
      return result.ok ? [] : result.problems;
    };
    expect(problems({ privileged: true })).toEqual(["s：privileged は使えません"]);
    expect(problems({ cap_add: ["SYS_ADMIN"] })).toEqual(["s：cap_add は使えません"]);
    expect(problems({ network_mode: "host" })).toEqual(["s：network_mode: host は使えません"]);
    expect(problems({ network_mode: "container:abc" })).toHaveLength(1);
    expect(problems({ pid: "host" })).toEqual(["s：pid: host は使えません"]);
    expect(problems({ ipc: "host", userns_mode: "host" })).toHaveLength(2);
    expect(problems({ devices: ["/dev/kvm:/dev/kvm"] })).toEqual(["s：devices は使えません"]);
    expect(problems({ volumes_from: ["other"] })).toEqual(["s：volumes_from は使えません"]);
    expect(problems({ security_opt: ["seccomp:unconfined"] })).toEqual([
      "s：security_opt の unconfined は使えません",
    ]);
    expect(problems({ cgroup_parent: "x" })).toEqual(["s：cgroup_parent は使えません"]);
    // Docker のソケット・作業領域の外のパス・作業領域の外へのリンク
    expect(
      problems({
        volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
      }),
    ).toEqual(["s：作業領域の外のパス（/var/run/docker.sock）はマウントできません"]);
    expect(problems({ volumes: [{ type: "bind", source: "/etc", target: "/x" }] })).toHaveLength(1);
    symlinkSync("/etc", join(ws, "escape"));
    expect(
      problems({ volumes: [{ type: "bind", source: join(ws, "escape"), target: "/x" }] }),
    ).toHaveLength(1);
    expect(
      problems({
        volumes: [{ type: "npipe", source: "\\\\.\\pipe\\docker_engine", target: "/x" }],
      }),
    ).toHaveLength(1);
    // 作業領域の外のビルド・Dockerfile・git の URL
    expect(problems({ build: { context: "/etc" } })).toEqual([
      "s：作業領域の外（/etc）はビルドできません",
    ]);
    expect(problems({ build: { context: ws, dockerfile: "../../Dockerfile" } })).toHaveLength(1);
    expect(problems({ build: { context: "https://github.com/acme/x.git" } })).toHaveLength(1);
    expect(problems({ build: { context: ws, dockerfile: "db/Dockerfile" } })).toEqual([]);
    expect(problems({ env_file: [{ path: "/etc/environment" }] })).toHaveLength(1);
    expect(problems({ env_file: [{ path: join(ws, ".env") }] })).toEqual([]);
  });

  it("外部のネットワーク・ボリューム、ホストに届くドライバー、作業領域の外の secrets は拒否する", () => {
    const service = {
      image: "x",
      networks: { back: null },
      volumes: [{ type: "volume", source: "data", target: "/d" }],
    };
    const check = (extra: Record<string, unknown>) => {
      const result = sanitizeCompose(normalized({ s: service }, extra), ws, ["s"]);
      return result.ok ? [] : result.problems;
    };
    expect(check({ networks: { back: { external: true } } })).toContain(
      "ネットワーク back：external は使えません",
    );
    expect(check({ networks: { back: { driver: "macvlan" } } })).toContain(
      "ネットワーク back：driver: macvlan は使えません",
    );
    expect(
      check({ volumes: { data: { driver: "local", driver_opts: { type: "none", device: "/" } } } }),
    ).toContain("ボリューム data：driver・driver_opts は使えません");
    expect(check({ volumes: { data: { external: true } } })).toContain(
      "ボリューム data：external は使えません",
    );
    expect(check({ secrets: { key: { file: "/Users/me/.ssh/id_rsa" } } })).toEqual([
      "secrets key：作業領域の外のファイルや external は使えません",
    ]);
    expect(check({ secrets: { key: { file: join(ws, "key.txt") } } })).toEqual([]);
  });

  it("compose のプロジェクトの名前は、実行ごとに別にする（並行の実行がぶつからない）", () => {
    expect(composeProject("1F0A-ab_c")).toBe("sacty-svc-1f0aabc");
    expect(composeProject("run-a")).not.toBe(composeProject("run-b"));
  });
});
