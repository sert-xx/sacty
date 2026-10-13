import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkComposeSources,
  composePorts,
  composeProject,
  DockerComposeServices,
  localForwards,
  sanitizeCompose,
} from "./services.js";

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
    // Docker の API のソケットを渡す・ホストでコマンドを動かす指定（レビュー指摘）
    expect(problems({ use_api_socket: true })).toEqual(["s：use_api_socket は使えません"]);
    expect(problems({ use_api_socket: false })).toEqual([]);
    expect(problems({ provider: { type: "model" } })).toEqual(["s：provider は使えません"]);
    // ビルドにホストの SSH エージェント・ネットワーク・特権を渡す指定
    expect(problems({ build: { context: ws, ssh: ["default"] } })).toEqual([
      "s：build.ssh は使えません",
    ]);
    expect(problems({ build: { context: ws, network: "host" } })).toEqual([
      "s：build.network: host は使えません",
    ]);
    expect(problems({ build: { context: ws, privileged: true } })).toEqual([
      "s：build.privileged は使えません",
    ]);
    expect(problems({ build: { context: ws, entitlements: ["network.host"] } })).toEqual([
      "s：build.entitlements は使えません",
    ]);
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

describe("正規化で元の参照が消えるファイルの確かめ（PBI-47 レビュー指摘）", () => {
  const write = (path: string, body: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  };

  it("include・extends のファイル、include の env_file・project_directory、label_file は作業領域の中だけ", () => {
    write(
      join(ws, "compose.yaml"),
      "include:\n  - path: sub/inc.yaml\nservices:\n  a:\n    image: x\n",
    );
    write(
      join(ws, "sub/inc.yaml"),
      "services:\n  b:\n    image: x\n    label_file: ../labels.txt\n",
    );
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([]);

    // include でたどったファイルの中も確かめる
    write(
      join(ws, "sub/inc.yaml"),
      "services:\n  b:\n    image: x\n    label_file: ../../labels.txt\n",
    );
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([
      "作業領域の外のlabel_file（../../labels.txt）は使えません",
    ]);
    write(
      join(ws, "compose.yaml"),
      [
        "include:",
        "  - ../other.yaml",
        "  - path: inc2.yaml",
        "    env_file: [/etc/values.env]",
        "    project_directory: ..",
        "services:",
        "  a:",
        "    image: x",
        "    extends: { file: ../base.yaml, service: base }",
        "  c:",
        "    image: x",
        "    label_file: $HOME/labels.txt",
      ].join("\n"),
    );
    write(join(ws, "inc2.yaml"), "services:\n  d:\n    image: x\n");
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([
      "作業領域の外のinclude のファイル（../other.yaml）は使えません",
      "作業領域の外のinclude の project_directory（..）は使えません",
      "作業領域の外のinclude の env_file（/etc/values.env）は使えません",
      "作業領域の外のextends のファイル（../base.yaml）は使えません",
      "label_file（$HOME/labels.txt）に変数は使えません",
    ]);
  });

  it("マージキー（<<: *anchor）で継承した label_file・include・extends も確かめる（レビュー指摘）", () => {
    write(
      join(ws, "compose.yaml"),
      [
        "x-base: &base",
        "  label_file: /tmp/outside-labels.txt",
        "x-ext: &ext",
        "  extends: { file: ../base.yaml, service: b }",
        "x-inc: &inc",
        "  env_file: ../values.env",
        "include:",
        "  - <<: *inc",
        "    path: inc.yaml",
        "services:",
        "  a:",
        "    <<: *base",
        "    image: postgres:17",
        "  b:",
        "    <<: [*ext]",
        "    image: x",
      ].join("\n"),
    );
    write(join(ws, "inc.yaml"), "services:\n  c:\n    image: x\n");
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([
      "作業領域の外のinclude の env_file（../values.env）は使えません",
      "作業領域の外のlabel_file（/tmp/outside-labels.txt）は使えません",
      "作業領域の外のextends のファイル（../base.yaml）は使えません",
    ]);
  });

  it("読めない・解析できないファイルは、確かめられないので止める（レビュー指摘）", () => {
    // 別名を多く使うファイル（yaml は資源の枯渇を防ぐために拒否するが、Compose は読める）
    write(
      join(ws, "compose.yaml"),
      [
        "x-base: &base",
        "  label_file: /tmp/outside-labels.txt",
        `x-repeat: [${Array(110).fill("*base").join(", ")}]`,
        "services:",
        "  a:",
        "    <<: *base",
        "    image: postgres:17",
      ].join("\n"),
    );
    const [problem, ...rest] = checkComposeSources(ws, join(ws, "compose.yaml"));
    expect(rest).toEqual([]);
    expect(problem).toMatch(
      /^compose\.yaml を読めないため、参照するファイルを確かめられません（.*alias/i,
    );
    // include したファイルが無い・壊れている・形が違う
    write(join(ws, "compose.yaml"), "include:\n  - missing.yaml\nservices: {}\n");
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([
      expect.stringMatching(/^missing\.yaml を読めないため/),
    ]);
    write(join(ws, "compose.yaml"), "services: [unclosed\n");
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toHaveLength(1);
    write(join(ws, "compose.yaml"), "- a\n- b\n");
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([
      "compose.yaml を読めないため、参照するファイルを確かめられません（compose ファイルの形ではありません）",
    ]);
  });

  it("extends でたどったファイルも確かめる。同じファイルを何度もたどらない", () => {
    write(
      join(ws, "compose.yaml"),
      "services:\n  a:\n    image: x\n    extends: { file: base.yaml, service: b }\n",
    );
    write(
      join(ws, "base.yaml"),
      "services:\n  b:\n    image: x\n    extends: { file: compose.yaml, service: a }\n    label_file: /etc/l\n",
    );
    expect(checkComposeSources(ws, join(ws, "compose.yaml"))).toEqual([
      "作業領域の外のlabel_file（/etc/l）は使えません",
    ]);
  });
});

describe("docker compose の実行（PBI-47 レビュー指摘）", () => {
  /** docker compose の偽物。config は決めた stdout・stderr を返し、ほかは成功する。 */
  function fakeCompose(config: { stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setTimeout(() => {
        if (args.includes("config")) {
          child.stdout.emit("data", config.stdout);
          child.stderr.emit("data", config.stderr);
        }
        child.emit("close", 0);
      }, 0);
      return child;
    }) as never;
    return { spawnImpl, calls };
  }

  it("警告（stderr）が出ても、stdout の JSON で確かめて起動する。正規化では env_file を読まない", async () => {
    writeFileSync(
      join(ws, "compose.yaml"),
      'version: "3.8"\nservices:\n  db:\n    image: postgres\n',
    );
    const docker = fakeCompose({
      stdout: JSON.stringify(normalized({ db: { image: "postgres" } })),
      stderr: 'level=warning msg="the attribute `version` is obsolete"\n',
    });
    const result = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r1",
      workspaceDir: ws,
      spec: { file: "compose.yaml", names: ["db"] },
    });
    expect(result).toMatchObject({ ok: true, started: { services: [{ name: "db" }] } });
    const config = docker.calls.find((a) => a.includes("config"));
    expect(config).toContain("--no-env-resolution");
    expect(docker.calls.some((a) => a.includes("up"))).toBe(true);
  });

  it("正規化の前に、作業領域の外を参照するファイルがあれば、docker compose を実行せずに止まる", async () => {
    writeFileSync(
      join(ws, "compose.yaml"),
      "services:\n  db:\n    image: postgres\n    label_file: ../outside.txt\n",
    );
    const docker = fakeCompose({ stdout: "{}", stderr: "" });
    const result = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r2",
      workspaceDir: ws,
      spec: { file: "compose.yaml", names: ["db"] },
    });
    expect(result).toEqual({
      ok: false,
      message: message("services.unsafe", {
        file: "compose.yaml",
        detail: "作業領域の外のlabel_file（../outside.txt）は使えません",
      }),
    });
    expect(docker.calls).toEqual([]);
  });
});

describe("localhost に転送するポート（PBI-60）", () => {
  it("サービスが無い・ポートが無いサービスだけなら、転送しない", () => {
    expect(localForwards([])).toEqual({ forwards: [], shared: [] });
    expect(localForwards([{ name: "worker", ports: [] }])).toEqual({ forwards: [], shared: [] });
  });

  it("サービスのポートを、同じポートでサービス名に転送する（1つ・複数）", () => {
    expect(localForwards([{ name: "db", ports: [5432] }])).toEqual({
      forwards: [{ port: 5432, host: "db" }],
      shared: [],
    });
    expect(
      localForwards([
        { name: "mock", ports: [8080, 3000] },
        { name: "db", ports: [5432] },
        { name: "worker", ports: [] },
      ]),
    ).toEqual({
      forwards: [
        { port: 3000, host: "mock" },
        { port: 5432, host: "db" },
        { port: 8080, host: "mock" },
      ],
      shared: [],
    });
  });

  it("複数のサービスが使うポートは転送しない（ほかのポートは転送する）", () => {
    expect(
      localForwards([
        { name: "api", ports: [8080, 9000] },
        { name: "mock", ports: [8080] },
        { name: "db", ports: [5432] },
        { name: "db2", ports: [5432] },
      ]),
    ).toEqual({ forwards: [{ port: 9000, host: "api" }], shared: [5432, 8080] });
  });

  it("1つのサービスに同じポートが重なっていても、複数のサービスとは数えない", () => {
    expect(localForwards([{ name: "db", ports: [5432, 5432] }])).toEqual({
      forwards: [{ port: 5432, host: "db" }],
      shared: [],
    });
  });
});

describe("compose の ports から、ホストに出すポートとコンテナのポートの組を取る（PBI-60）", () => {
  it("短い書き方", () => {
    expect(composePorts("5432")).toEqual([{ target: 5432 }]);
    expect(composePorts(5432)).toEqual([{ target: 5432 }]);
    expect(composePorts("15432:5432")).toEqual([{ target: 5432, published: 15432 }]);
    expect(composePorts("127.0.0.1:15432:5432")).toEqual([{ target: 5432, published: 15432 }]);
    expect(composePorts("[::1]:15432:5432")).toEqual([{ target: 5432, published: 15432 }]);
    expect(composePorts("15432:5432/tcp")).toEqual([{ target: 5432, published: 15432 }]);
    expect(composePorts("8000-8001:8000-8001")).toEqual([
      { target: 8000, published: 8000 },
      { target: 8001, published: 8001 },
    ]);
    expect(composePorts("9000-9001:8000-8001")).toEqual([
      { target: 8000, published: 9000 },
      { target: 8001, published: 9001 },
    ]);
    expect(composePorts("8000-8001")).toEqual([{ target: 8000 }, { target: 8001 }]);
  });

  it("長い書き方（正規化した設定）", () => {
    expect(composePorts({ target: 5432, published: "15432", protocol: "tcp" })).toEqual([
      { target: 5432, published: 15432 },
    ]);
    expect(composePorts({ target: 5432, published: 15432 })).toEqual([
      { target: 5432, published: 15432 },
    ]);
    expect(composePorts({ target: 5432, host_ip: "127.0.0.1", protocol: "tcp" })).toEqual([
      { target: 5432 },
    ]);
  });

  it("published が無い・範囲が合わない・読めない・UDP なら、コンテナのポートだけ", () => {
    expect(composePorts("127.0.0.1::7000")).toEqual([{ target: 7000 }]);
    expect(composePorts("[::1]::7000")).toEqual([{ target: 7000 }]);
    expect(composePorts({ target: 9000, published: "9000-9001" })).toEqual([{ target: 9000 }]);
    expect(composePorts("9000-9002:8000-8001")).toEqual([{ target: 8000 }, { target: 8001 }]);
    expect(composePorts("abc:5432")).toEqual([{ target: 5432 }]);
    expect(composePorts("70000:5432")).toEqual([{ target: 5432 }]);
    // TCP 以外は、プロトコルを付けて返す（published は付けない）
    expect(composePorts("15353:53/udp")).toEqual([{ target: 53, protocol: "udp" }]);
    expect(composePorts("53/UDP")).toEqual([{ target: 53, protocol: "udp" }]);
    expect(composePorts({ target: 53, published: "15353", protocol: "udp" })).toEqual([
      { target: 53, protocol: "udp" },
    ]);
    expect(composePorts("9000/sctp")).toEqual([{ target: 9000, protocol: "sctp" }]);
    expect(composePorts("x")).toEqual([]);
    expect(composePorts(null)).toEqual([]);
    expect(composePorts({ target: "x" })).toEqual([]);
  });

  it("正規化した設定から、ホストに出すポートが違うものだけを返す（同じなら1つ）", () => {
    const result = sanitizeCompose(
      {
        services: {
          db: {
            image: "postgres",
            ports: [
              { target: 5432, published: "15432", protocol: "tcp" },
              { target: 5432, published: "25432", protocol: "tcp" },
              { target: 6379, published: "6379", protocol: "tcp" },
              { target: 7000, protocol: "tcp" },
            ],
          },
          worker: { image: "w" },
        },
      },
      ws,
      [],
    );
    if (!result.ok) throw new Error(result.problems.join());
    expect(result.services).toEqual([
      {
        name: "db",
        ports: [5432, 6379, 7000],
        hostPorts: [
          { port: 15432, target: 5432 },
          { port: 25432, target: 5432 },
        ],
      },
      { name: "worker", ports: [] },
    ]);
    // ホストのポートには出さない（これまでどおり）
    expect(
      (result.config.services as Record<string, Record<string, unknown>>).db,
    ).not.toHaveProperty("ports");
  });
});

describe("ホストに出すポートからも localhost に転送する（PBI-60）", () => {
  it("ホストのポート → コンテナのポートと、コンテナのポートの両方を転送する", () => {
    expect(
      localForwards([{ name: "db", ports: [5432], hostPorts: [{ port: 15432, target: 5432 }] }]),
    ).toEqual({
      forwards: [
        { port: 5432, host: "db" },
        { port: 15432, host: "db", target: 5432 },
      ],
      shared: [],
    });
  });

  it("ホストのポートが、ほかのサービスのコンテナのポート・ホストのポートとぶつかれば、その番号は転送しない", () => {
    expect(
      localForwards([
        { name: "db", ports: [5432], hostPorts: [{ port: 8080, target: 5432 }] },
        { name: "mock", ports: [8080] },
      ]),
    ).toEqual({ forwards: [{ port: 5432, host: "db" }], shared: [8080] });
    expect(
      localForwards([
        { name: "db", ports: [5432], hostPorts: [{ port: 15432, target: 5432 }] },
        { name: "db2", ports: [5433], hostPorts: [{ port: 15432, target: 5433 }] },
      ]),
    ).toEqual({
      forwards: [
        { port: 5432, host: "db" },
        { port: 5433, host: "db2" },
      ],
      shared: [15432],
    });
  });

  it("同じサービスの中で、ホストのポートがほかのコンテナのポートと同じ番号なら、ホストのポートの対応を優先する", () => {
    expect(
      localForwards([{ name: "app", ports: [80, 8080], hostPorts: [{ port: 8080, target: 80 }] }]),
    ).toEqual({
      forwards: [
        { port: 80, host: "app" },
        { port: 8080, host: "app", target: 80 },
      ],
      shared: [],
    });
  });
});

describe("正規化した compose の設定から、localhost に転送するポートを決める（PBI-60 レビュー指摘）", () => {
  const startedFrom = (services: Record<string, unknown>) => {
    const result = sanitizeCompose({ services }, ws, []);
    if (!result.ok) throw new Error(result.problems.join());
    return result.services;
  };

  it("UDP のポートは、転送の候補にも、ぶつかりの判定にも入れない（同じ番号の TCP は転送する）", () => {
    const services = startedFrom({
      tcp: { image: "a", ports: [{ target: 8125, published: "8125", protocol: "tcp" }] },
      udp: {
        image: "b",
        ports: [{ target: 8125, published: "8125", protocol: "udp" }],
        expose: ["9125/udp", "9126"],
      },
    });
    expect(services).toEqual([
      { name: "tcp", ports: [8125] },
      {
        name: "udp",
        ports: [9126],
        otherPorts: [
          { port: 8125, protocol: "udp" },
          { port: 9125, protocol: "udp" },
        ],
      },
    ]);
    expect(localForwards(services)).toEqual({
      forwards: [
        { port: 8125, host: "tcp" },
        { port: 9126, host: "udp" },
      ],
      shared: [],
    });
    // 短い書き方でも同じ
    expect(
      localForwards(
        startedFrom({
          tcp: { image: "a", ports: ["8125:8125/tcp"] },
          udp: { image: "b", ports: ["8125:8125/udp"] },
        }),
      ),
    ).toEqual({ forwards: [{ port: 8125, host: "tcp" }], shared: [] });
  });

  it('"8080:80" と "18080:8080" なら、localhost:8080 は app:80、localhost:18080 は app:8080 に転送する', () => {
    const services = startedFrom({
      app: {
        image: "a",
        ports: [
          { target: 80, published: "8080", protocol: "tcp" },
          { target: 8080, published: "18080", protocol: "tcp" },
        ],
      },
    });
    expect(services).toEqual([
      {
        name: "app",
        ports: [80, 8080],
        hostPorts: [
          { port: 8080, target: 80 },
          { port: 18080, target: 8080 },
        ],
      },
    ]);
    expect(localForwards(services)).toEqual({
      forwards: [
        { port: 80, host: "app" },
        { port: 8080, host: "app", target: 80 },
        { port: 18080, host: "app", target: 8080 },
      ],
      shared: [],
    });
  });

  it("ほかのサービスとぶつかる番号は、これまでどおり転送しない", () => {
    const services = startedFrom({
      app: { image: "a", ports: ["8080:80", "18080:8080"] },
      mock: { image: "m", ports: ["8080"] },
    });
    expect(localForwards(services)).toEqual({
      forwards: [
        { port: 80, host: "app" },
        { port: 18080, host: "app", target: 8080 },
      ],
      shared: [8080],
    });
  });
});
