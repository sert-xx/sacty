import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkComposeSources,
  composePorts,
  composeProject,
  DockerComposeServices,
  labelOwner,
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

describe("サービスのビルドが、ホストで共有するタグを書き換えない（PBI-130）", () => {
  const AGENT = "sacty-agent:1.12.1";

  it("ビルドするサービスの image・build.tags を外し、毎回その実行の名前でビルドする（元の設定は変えない）", () => {
    const build = {
      context: ws,
      dockerfile: "Dockerfile",
      tags: [AGENT, "ghcr.io/acme/agent:1"],
    };
    const config = normalized({
      app: { image: AGENT, pull_policy: "build", build },
      cached: { image: AGENT, pull_policy: "missing", build: { context: ws } },
      plain: { build: { context: ws } },
    });
    const result = sanitizeCompose(config, ws, ["app", "cached", "plain"]);
    if (!result.ok) throw new Error(result.problems.join());
    const services = result.config.services as Record<string, Record<string, unknown>>;
    for (const name of ["app", "cached", "plain"]) {
      expect(services[name]).not.toHaveProperty("image");
      expect(services[name]?.build).not.toHaveProperty("tags");
      expect(services[name]?.pull_policy).toBe("build");
    }
    expect(services.app?.build).toEqual({ context: ws, dockerfile: "Dockerfile" });
    // 正規化した元の設定（ほかのサービスの確かめにも使う）は書き換えない
    expect(build.tags).toEqual([AGENT, "ghcr.io/acme/agent:1"]);
    expect((config.services.app as Record<string, unknown>).image).toBe(AGENT);
  });

  it("ビルドしないサービスの image と pull_policy は、そのまま使う", () => {
    const result = sanitizeCompose(
      normalized({ db: { image: "postgres:16", pull_policy: "always" } }),
      ws,
      ["db"],
    );
    if (!result.ok) throw new Error(result.problems.join());
    const db = (result.config.services as Record<string, Record<string, unknown>>).db;
    expect(db?.image).toBe("postgres:16");
    expect(db?.pull_policy).toBe("always");
  });

  it("ビルドの結果を実行の外へ書き出す build.cache_to は拒否する（cache_from は使える）", () => {
    const result = sanitizeCompose(
      normalized({
        app: {
          build: { context: ws, cache_to: ["type=local,dest=/Users/someone/.ssh"] },
        },
        ok: { build: { context: ws, cache_from: ["type=registry,ref=acme/app:cache"] } },
      }),
      ws,
      ["app", "ok"],
    );
    expect(result).toEqual({ ok: false, problems: ["app：build.cache_to は使えません"] });
  });
});

describe("エージェントのイメージを、イメージ ID に確定させる（PBI-130）", () => {
  const ID = `sha256:${"a".repeat(64)}`;
  function docker(stdout: string, code: number) {
    const calls: string[][] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setImmediate(() => {
        child.stdout.emit("data", stdout);
        child.emit("close", code);
      });
      return child;
    }) as never;
    return { calls, runner: new DockerComposeServices(spawnImpl) };
  }

  it("docker image inspect の ID を返す", async () => {
    const { calls, runner } = docker(`${ID}\n`, 0);
    expect(await runner.imageId("sacty-agent:1.12.1", "r1")).toBe(ID);
    expect(calls).toEqual([["image", "inspect", "--format", "{{.Id}}", "sacty-agent:1.12.1"]]);
  });

  it("無いイメージ・ID の形でない出力は、確定させない", async () => {
    expect(await docker("", 1).runner.imageId("missing:1", "r1")).toBeUndefined();
    expect(await docker("sacty-agent:1.12.1\n", 0).runner.imageId("x", "r1")).toBeUndefined();
    expect(await docker(`${ID}\n${ID}\n`, 0).runner.imageId("x", "r1")).toBeUndefined();
  });

  /** 応答しない docker（kill されるまで終わらない。PBI-130 レビュー指摘）。 */
  function hangingDocker() {
    const killed: string[] = [];
    const spawned = Promise.withResolvers<void>();
    const spawnImpl = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: (signal: string) => {
          killed.push(signal);
          setImmediate(() => child.emit("close", null));
          return true;
        },
      });
      spawned.resolve();
      return child;
    }) as never;
    return { killed, spawned: spawned.promise, runner: new DockerComposeServices(spawnImpl) };
  }

  it("docker が応答しなければ、期限で止めて確定させない（名前のまま実行する）", async () => {
    const { killed, runner } = hangingDocker();
    expect(await runner.imageId("x", "r1", 20)).toBeUndefined();
    expect(killed).toEqual(["SIGTERM"]);
  });

  it("確定を待つ間に打ち切られたら（一時停止・中止）、子プロセスを止めて確定させない", async () => {
    const { killed, spawned, runner } = hangingDocker();
    const pending = runner.imageId("x", "r1", 60_000);
    await spawned;
    // ほかの実行の打ち切りでは止めない
    runner.abort("other");
    expect(killed).toEqual([]);
    runner.abort("r1");
    expect(await pending).toBeUndefined();
    expect(killed).toEqual(["SIGTERM"]);
    // 終わった後に打ち切っても、何もしない
    runner.abort("r1");
    expect(killed).toHaveLength(1);
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

describe("共用の compose の起動（PBI-70）", () => {
  /** docker compose の偽物。config は決めた設定を返し、up は決めた終了コードと出力を返す。 */
  function fakeCompose(config: unknown, up: { code: number; out: string } = { code: 0, out: "" }) {
    const calls: string[][] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setTimeout(() => {
        if (args.includes("config")) {
          child.stdout.emit("data", JSON.stringify(config));
          child.emit("close", 0);
        } else if (args.includes("up")) {
          child.stderr.emit("data", up.out);
          child.emit("close", up.code);
        } else {
          child.emit("close", 0);
        }
      }, 0);
      return child;
    }) as never;
    return { spawnImpl, calls };
  }
  const spec = { file: "compose/redis.yml", names: [], shared: "infra" };
  beforeEach(() => {
    mkdirSync(join(ws, "compose", "init"), { recursive: true });
    writeFileSync(join(ws, "compose", "redis.yml"), "services:\n  redis:\n    image: redis\n");
  });

  it("compose ファイルが無ければ、どの共用の compose かを示して、docker compose を実行せずに止まる", async () => {
    const docker = fakeCompose({});
    const result = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r1",
      workspaceDir: ws,
      spec: { ...spec, file: "compose/missing.yml" },
    });
    expect(result).toEqual({
      ok: false,
      message: message("services.sharedMissing", { name: "infra", file: "compose/missing.yml" }),
    });
    // ディレクトリはファイルではない
    const dirAsFile = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r1",
      workspaceDir: ws,
      spec: { ...spec, file: "compose" },
    });
    expect(dirAsFile).toMatchObject({ ok: false, message: { code: "services.sharedMissing" } });
    expect(docker.calls).toEqual([]);
  });

  it("取得したリポジトリの中の相対のマウント（初期化スクリプト）は使える。実行ごとのプロジェクトの名前で起動する", async () => {
    const docker = fakeCompose(
      normalized({
        redis: {
          image: "redis",
          container_name: "shared-redis",
          volumes: [{ type: "bind", source: join(ws, "compose", "init"), target: "/init" }],
        },
      }),
    );
    const result = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r1",
      workspaceDir: ws,
      spec,
    });
    expect(result).toMatchObject({ ok: true, started: { network: "sacty-svc-r1_sacty" } });
    const up = docker.calls.find((a) => a.includes("up"));
    expect(up?.slice(0, 3)).toEqual(["compose", "-p", "sacty-svc-r1"]);
    expect(up).toContain("--wait");
  });

  it("並行する2つのタスクが同じ共用の compose を起動しても、名前・ネットワーク・ボリュームがぶつからない", async () => {
    const config = normalized(
      {
        redis: {
          image: "redis",
          container_name: "shared-redis",
          ports: [{ target: 6379, published: "6379", protocol: "tcp" }],
          networks: { default: null },
          volumes: [{ type: "volume", source: "data", target: "/data" }],
        },
      },
      { volumes: { data: { name: "shared-redis-data" } } },
    );
    // up のときに、sacty が書いた設定（-f のファイル）を読んでおく
    const ups: { project: string; config: Record<string, unknown> }[] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      if (args.includes("up")) {
        ups.push({
          project: args[args.indexOf("-p") + 1] ?? "",
          config: JSON.parse(readFileSync(args[args.indexOf("-f") + 1] ?? "", "utf8")),
        });
      }
      setTimeout(() => {
        if (args.includes("config")) child.stdout.emit("data", JSON.stringify(config));
        child.emit("close", 0);
      }, 0);
      return child;
    }) as never;
    const runner = new DockerComposeServices(spawnImpl);
    const results = await Promise.all(
      ["task-a-run", "task-b-run"].map((runId) => runner.start({ runId, workspaceDir: ws, spec })),
    );
    expect(results.map((r) => r.ok && r.started.network)).toEqual([
      "sacty-svc-taskarun_sacty",
      "sacty-svc-taskbrun_sacty",
    ]);
    expect(ups.map((u) => u.project).sort()).toEqual(["sacty-svc-taskarun", "sacty-svc-taskbrun"]);
    for (const { config: written } of ups) {
      const redis = (written.services as Record<string, Record<string, unknown>>).redis;
      // 固定の名前・ホストのポート・ボリュームとネットワークの固定の名前を外す（プロジェクトごとの名前になる）
      expect(redis).not.toHaveProperty("container_name");
      expect(redis).not.toHaveProperty("ports");
      expect(written.volumes).toEqual({ data: {} });
      expect(written.networks).toEqual({ sacty: {}, default: { ipam: {} } });
    }
  });

  it("取得したリポジトリの外のマウント・privileged は、どの共用の compose かを示して止める", async () => {
    const docker = fakeCompose(
      normalized({
        redis: {
          image: "redis",
          privileged: true,
          volumes: [{ type: "bind", source: "/etc", target: "/host-etc" }],
        },
      }),
    );
    const result = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r1",
      workspaceDir: ws,
      spec,
    });
    expect(result).toEqual({
      ok: false,
      message: message("services.sharedUnsafe", {
        name: "infra",
        file: "compose/redis.yml",
        detail:
          "redis：privileged は使えません、redis：作業領域の外のパス（/etc）はマウントできません",
      }),
    });
    expect(docker.calls.some((a) => a.includes("up"))).toBe(false);
  });

  it("起動に失敗したら、どの共用の compose かを示す。出力の秘密情報は、伏せてから切り詰める", async () => {
    // 切り詰めの境界（末尾 2000 文字）が、秘密情報の途中に来る長さにする（伏せる前に切り詰めると、一部が残る）
    const out = `${"y".repeat(100)}topsecret-value${"z".repeat(1974)}pull access denied`;
    const docker = fakeCompose(normalized({ redis: { image: "redis" } }), { code: 1, out });
    const result = await new DockerComposeServices(docker.spawnImpl).start({
      runId: "r1",
      workspaceDir: ws,
      spec,
      secrets: ["topsecret-value"],
    });
    if (result.ok) throw new Error("started");
    const params = (result.message as { params: { name: string; detail: string } }).params;
    expect(result.message).toMatchObject({ code: "services.sharedFailed" });
    expect(params.name).toBe("infra");
    expect(params.detail).toContain("pull access denied");
    expect(params.detail).not.toMatch(/secret|value|topsec/);
    expect(params.detail.length).toBeLessThanOrEqual(2000);
    // 起動に失敗したら、止めて消す
    expect(docker.calls.some((a) => a.includes("down"))).toBe(true);
  });

  it("起動の待ち（up --wait）を打ち切ると、up を止め、起動したところまでを止めて消し、止めたこととして返す（レビュー指摘）", async () => {
    const calls: string[][] = [];
    const killed: string[] = [];
    const upSpawned = Promise.withResolvers<void>();
    const spawnImpl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: (signal: string) => {
          killed.push(signal);
          setTimeout(() => child.emit("close", 130), 0);
          return true;
        },
      });
      if (args.includes("up")) {
        // 打ち切られるまで終わらない（healthcheck を待っている）
        upSpawned.resolve();
      } else {
        setTimeout(() => {
          if (args.includes("config")) {
            child.stdout.emit("data", JSON.stringify(normalized({ redis: { image: "redis" } })));
          }
          child.emit("close", 0);
        }, 0);
      }
      return child;
    }) as never;
    const runner = new DockerComposeServices(spawnImpl);
    // 起動していない実行を打ち切っても、何もしない
    runner.abort("other-run");
    const starting = runner.start({ runId: "r1", workspaceDir: ws, spec });
    await upSpawned.promise;
    runner.abort("r1");
    expect(await starting).toEqual({ ok: false, message: message("run.stoppedByPerson") });
    expect(killed).toEqual(["SIGTERM"]);
    expect(calls.at(-1)).toEqual([
      "compose",
      "-p",
      "sacty-svc-r1",
      "down",
      "-v",
      "--remove-orphans",
      "--rmi",
      "local",
    ]);
    // 終わった後に打ち切っても、何もしない
    runner.abort("r1");
    expect(killed).toHaveLength(1);
  });

  it("container_name は、共用の compose だけ sacty のネットワークの別名にする（サービスの名前とぶつかるものは付けない）", () => {
    const config = normalized({
      cassandra: { image: "cassandra", container_name: "cassandra-db" },
      redis: { image: "redis", container_name: "redis" },
      cache: { image: "redis", container_name: "cassandra" },
      bad: { image: "redis", container_name: "has space" },
    });
    const shared = sanitizeCompose(config, ws, [], { aliasContainerNames: true });
    if (!shared.ok) throw new Error(shared.problems.join());
    const services = shared.config.services as Record<string, Record<string, unknown>>;
    expect(services.cassandra?.networks).toEqual({
      default: null,
      sacty: { aliases: ["cassandra-db"] },
    });
    // サービスの名前と同じ・ほかのサービスの名前・名前の形でないものは、別名にしない
    expect(services.redis?.networks).toEqual({ default: null, sacty: null });
    expect(services.cache?.networks).toEqual({ default: null, sacty: null });
    expect(services.bad?.networks).toEqual({ default: null, sacty: null });
    for (const service of Object.values(services)) {
      expect(service).not.toHaveProperty("container_name");
    }
    // 対象リポジトリの compose は、これまでどおり外すだけ
    const own = sanitizeCompose(config, ws, []);
    if (!own.ok) throw new Error(own.problems.join());
    const ownServices = own.config.services as Record<string, Record<string, unknown>>;
    expect(ownServices.cassandra?.networks).toEqual({ default: null, sacty: null });
  });
});

describe("前回の残りのサービスの片付け（PBI-78 レビュー指摘）", () => {
  const T1 = "Wed Oct 14 01:00:00 2026";
  const T2 = "Wed Oct 14 02:00:00 2026";
  /** プロジェクトごとのコンテナの所有元のラベル（docker ps の出力）。 */
  function fakeDocker(owners: Record<string, string>, options: { psFails?: boolean } = {}) {
    const downs: string[] = [];
    const ups: Record<string, unknown>[] = [];
    const spawnImpl = ((_cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setTimeout(() => {
        let code = 0;
        if (args[0] === "compose" && args.includes("ls")) {
          child.stdout.emit(
            "data",
            JSON.stringify([...Object.keys(owners), "other-project"].map((Name) => ({ Name }))),
          );
        } else if (args[0] === "ps") {
          const filter = args[args.indexOf("--filter") + 1] ?? "";
          const name = filter.replace("label=com.docker.compose.project=", "");
          if (options.psFails) code = 1;
          else child.stdout.emit("data", owners[name] ?? "");
        } else if (args.includes("down")) {
          downs.push(args[args.indexOf("-p") + 1] ?? "");
          // ビルドしたイメージ（実行ごとの名前。PBI-130）も消す
          expect(args.slice(args.indexOf("down"))).toEqual([
            "down",
            "-v",
            "--remove-orphans",
            "--rmi",
            "local",
          ]);
        } else if (args.includes("config")) {
          child.stdout.emit("data", JSON.stringify({ services: { db: { image: "postgres" } } }));
        } else if (args.includes("up")) {
          ups.push(JSON.parse(readFileSync(args[args.indexOf("-f") + 1] ?? "", "utf8")));
        }
        child.emit("close", code);
      }, 0);
      return child;
    }) as never;
    return { spawnImpl, downs, ups };
  }
  const table = async () => [
    { pid: 50, ppid: 1, pgid: 50, started: T1 },
    { pid: 70, ppid: 1, pgid: 70, started: T2 },
  ];

  it("起動したデーモンが動いているもの（ほかの sacty が使っている）は止めず、終わったもの・PID が再利用されたもの・ラベルの無いものは止める", async () => {
    const docker = fakeDocker({
      "sacty-svc-alive": `50 ${T1}\n50 ${T1}\n`,
      "sacty-svc-dead": `60 ${T1}\n`,
      "sacty-svc-reused": `70 ${T1}\n`,
      "sacty-svc-legacy": "\n",
    });
    await new DockerComposeServices(docker.spawnImpl, 300, { table }).cleanupAll();
    expect(docker.downs.sort()).toEqual(["sacty-svc-dead", "sacty-svc-legacy", "sacty-svc-reused"]);
  });

  it("所有元を確かめられない（ps・docker ps が使えない）ときは止めない", async () => {
    const docker = fakeDocker({ "sacty-svc-dead": `60 ${T1}\n` });
    await new DockerComposeServices(docker.spawnImpl, 300, { table: async () => [] }).cleanupAll();
    const failing = fakeDocker({ "sacty-svc-dead": `60 ${T1}\n` }, { psFails: true });
    await new DockerComposeServices(failing.spawnImpl, 300, { table }).cleanupAll();
    expect([...docker.downs, ...failing.downs]).toEqual([]);
  });

  it("起動するサービスに、起動したデーモンのラベルを付ける", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sacty-svc-owner-"));
    try {
      writeFileSync(join(dir, "compose.yaml"), "services:\n  db:\n    image: postgres\n");
      const docker = fakeDocker({});
      const result = await new DockerComposeServices(docker.spawnImpl, 300, {
        owner: { pid: 50, started: T1 },
      }).start({ runId: "r1", workspaceDir: dir, spec: { file: "compose.yaml", names: [] } });
      expect(result).toMatchObject({ ok: true });
      expect(docker.ups[0]).toMatchObject({
        services: { db: { labels: { "io.sacty.owner": `50 ${T1}` } } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("書いてあるラベル（名前と値の組・名前=値の並び）は残す", () => {
    const config = {
      services: { a: { labels: { team: "x" } }, b: { labels: ["team=y", "io.sacty.owner=1 old"] } },
    };
    labelOwner(config, { pid: 50, started: T1 });
    expect(config.services.a.labels).toEqual({ team: "x", "io.sacty.owner": `50 ${T1}` });
    expect(config.services.b.labels).toEqual(["team=y", `io.sacty.owner=50 ${T1}`]);
  });
});
