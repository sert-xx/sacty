import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonText, message, renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IMAGE, loadConfig } from "./config.js";
import {
  buildCommand,
  type DockerState,
  IMAGE_CHECK_INTERVAL_MS,
  IMAGE_INSPECT_TIMEOUT_MS,
  ImagePresenceChecker,
  type ImageState,
  imageTargets,
  inspectImage,
  isOutdatedImage,
  isRegistryImage,
  pingDocker,
  startImagePresenceCheck,
} from "./image-presence.js";

/*
 * 起動のときのエージェントのイメージの確かめ（PBI-148）。
 */

type Reply = { code?: number; stderr?: string; error?: Error; hang?: boolean; throws?: boolean };

/** docker の代わり。返す結果を決め、呼ばれた引数と止められたかを記録する。 */
function fakeSpawn(reply: Reply) {
  const calls: string[][] = [];
  const killed: string[] = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    calls.push(args);
    if (reply.throws) throw new Error("spawn failed");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (signal: string) => {
        killed.push(signal);
        return true;
      },
    });
    setImmediate(() => {
      if (reply.hang) return;
      if (reply.error) {
        child.emit("error", reply.error);
        return;
      }
      if (reply.stderr) child.stderr.emit("data", reply.stderr);
      if (!reply.code) child.stdout.emit("data", `sha256:${"a".repeat(64)}\n`);
      child.emit("close", reply.code ?? 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls, killed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("docker でイメージを確かめる", () => {
  it("あれば present、無ければ missing（Docker の版による文言の違いも）", async () => {
    const present = fakeSpawn({});
    expect(await inspectImage("sacty-agent:1.12.0", { spawnImpl: present.spawnImpl })).toBe(
      "present",
    );
    expect(present.calls).toEqual([
      ["image", "inspect", "--format", "{{.Id}}", "sacty-agent:1.12.0"],
    ]);
    for (const stderr of [
      "Error: No such image: sacty-agent:1.12.0\n",
      "Error response from daemon: No such object: sacty-agent:1.12.0\n",
      "error: no such image: x\n",
    ]) {
      expect(
        await inspectImage("x", { spawnImpl: fakeSpawn({ code: 1, stderr }).spawnImpl }),
        stderr,
      ).toBe("missing");
    }
  });

  it("Docker に接続できない・docker が無い・起動できないときは、無いではなく unreachable", async () => {
    for (const reply of [
      {
        code: 1,
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      },
      { code: 1, stderr: "error during connect: Get ...: open //./pipe/docker_engine\n" },
      { code: 1 },
      { error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) },
      { throws: true },
    ] as Reply[]) {
      expect(
        await inspectImage("x", { spawnImpl: fakeSpawn(reply).spawnImpl }),
        JSON.stringify(reply),
      ).toBe("unreachable");
    }
  });

  it("応答しなければ、上限の時間で止めて unreachable（境界：上限の 1 ミリ秒前はまだ待つ）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hang = fakeSpawn({ hang: true });
    let state: ImageState | undefined;
    void inspectImage("x", { spawnImpl: hang.spawnImpl }).then((s) => {
      state = s;
    });
    await vi.advanceTimersByTimeAsync(IMAGE_INSPECT_TIMEOUT_MS - 1);
    expect(state).toBeUndefined();
    expect(hang.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe("unreachable");
    expect(hang.killed).toEqual(["SIGKILL"]);
  });
});

describe("Docker が動いているかを確かめる", () => {
  it("サーバーの版を取れれば running、デーモンに接続できなければ unreachable、docker が無ければ noCli", async () => {
    const running = fakeSpawn({});
    expect(await pingDocker({ spawnImpl: running.spawnImpl })).toBe("running");
    expect(running.calls).toEqual([["version", "--format", "{{.Server.Version}}"]]);
    for (const reply of [
      {
        code: 1,
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      },
      { code: 1, stderr: "error during connect: Get ...: open //./pipe/docker_engine\n" },
      { error: new Error("spawn docker EACCES") },
      { throws: true },
    ] as Reply[]) {
      expect(
        await pingDocker({ spawnImpl: fakeSpawn(reply).spawnImpl }),
        JSON.stringify(reply),
      ).toBe("unreachable");
    }
    const noCli = fakeSpawn({
      error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
    });
    expect(await pingDocker({ spawnImpl: noCli.spawnImpl })).toBe("noCli");
  });

  it("応答しなければ、上限の時間で止めて unreachable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hang = fakeSpawn({ hang: true });
    let state: DockerState | undefined;
    void pingDocker({ spawnImpl: hang.spawnImpl }).then((s) => {
      state = s;
    });
    await vi.advanceTimersByTimeAsync(IMAGE_INSPECT_TIMEOUT_MS - 1);
    expect(state).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe("unreachable");
    expect(hang.killed).toEqual(["SIGKILL"]);
  });
});

describe("止めるときに、実行中の docker を残さない（PR #166 レビュー提案）", () => {
  it("確かめている最中に打ち切ると、docker を止めて unreachable で返る", async () => {
    const hang = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const running = inspectImage("x", { spawnImpl: hang.spawnImpl, signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    expect(hang.calls).toHaveLength(1);
    controller.abort();
    expect(await running).toBe("unreachable");
    expect(hang.killed).toEqual(["SIGKILL"]);
  });

  it("打ち切った後は docker を起動しない", async () => {
    const spawned = fakeSpawn({});
    const controller = new AbortController();
    controller.abort();
    expect(
      await inspectImage("x", { spawnImpl: spawned.spawnImpl, signal: controller.signal }),
    ).toBe("unreachable");
    expect(spawned.calls).toEqual([]);
  });

  it("止める関数は、間隔を止め、実行中の確かめを打ち切り、その結果を残さない", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signals: AbortSignal[] = [];
    let calls = 0;
    const checker = new ImagePresenceChecker({
      targets: () => [{ image: "sacty-agent:1.12.0" }],
      ping: async () => "running",
      inspect: (_image, signal) => {
        calls += 1;
        signals.push(signal);
        // 応答しない docker の代わり。打ち切られたら返る
        return new Promise((done) =>
          signal.addEventListener("abort", () => done("unreachable"), { once: true }),
        );
      },
    });
    const first: DaemonText[][] = [];
    const stop = startImagePresenceCheck(checker, (p) => first.push(p));
    await vi.waitFor(() => expect(calls).toBe(1));
    stop();
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(first).toHaveLength(1));
    // 打ち切った確かめを「Docker に接続できない」として残さない
    expect(first[0]).toEqual([]);
    expect(checker.problems()).toEqual([]);
    // 止めた後は、間隔が来ても、呼ばれても確かめない
    await vi.advanceTimersByTimeAsync(IMAGE_CHECK_INTERVAL_MS * 2);
    await checker.check();
    expect(calls).toBe(1);
  });
});

describe("確かめるイメージと案内", () => {
  it("名前にレジストリのホストを含むかで、レジストリのイメージを見分ける", () => {
    for (const image of [
      "registry.example.com/sacty-agent:1.12.0",
      "localhost:5000/sacty-agent:1.12.0",
      "localhost/sacty-agent",
      "ghcr.io/acme/agent:1",
    ]) {
      expect(isRegistryImage(image), image).toBe(true);
    }
    for (const image of ["sacty-agent:1.12.0", "library/node:22", "acme/agent:1", "sacty-agent"]) {
      expect(isRegistryImage(image), image).toBe(false);
    }
  });

  it("作るコマンドは、言語ごとのイメージなら名前を付ける", () => {
    expect(buildCommand({ image: "sacty-agent:1.12.0" })).toBe("npx sacty image build");
    expect(buildCommand({ image: "sacty-agent-java:1.12.0", name: "java" })).toBe(
      "npx sacty image build java",
    );
  });

  it("設定ファイルが無ければ既定のイメージだけ、images があればそれも、設定に誤りがあれば確かめない", () => {
    expect(imageTargets({ ok: false, problem: message("config.missing", { path: "/x" }) })).toEqual(
      [{ image: DEFAULT_IMAGE, expected: DEFAULT_IMAGE }],
    );
    expect(
      imageTargets({ ok: false, problem: message("config.unreadable", { detail: "YAML" }) }),
    ).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "sacty-pbi148-config-"));
    try {
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "default_agent: s",
          "agents:",
          "  s:",
          "    runtime: stub",
          "images:",
          "  java:",
          "    description: Java 21",
          "    base_image: eclipse-temurin:21",
        ].join("\n"),
      );
      const java = DEFAULT_IMAGE.replace("sacty-agent:", "sacty-agent-java:");
      expect(imageTargets(loadConfig(dir))).toEqual([
        { image: DEFAULT_IMAGE, expected: DEFAULT_IMAGE },
        { image: java, name: "java", expected: java },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("設定のイメージの版", () => {
  it("sacty が名付けるイメージで、タグだけが動いている版と違えば、版が違う", () => {
    const expected = "sacty-agent:1.12.0";
    expect(isOutdatedImage({ image: "sacty-agent:1.6.0", expected })).toBe(true);
    // タグを書いていない（latest）のも、動いている版のイメージではない
    expect(isOutdatedImage({ image: "sacty-agent", expected })).toBe(true);
    expect(
      isOutdatedImage({
        image: "sacty-agent-java:1.6.0",
        name: "java",
        expected: "sacty-agent-java:1.12.0",
      }),
    ).toBe(true);
    expect(isOutdatedImage({ image: expected, expected })).toBe(false);
    // 利用者が選んだ名前（別の名前・レジストリのイメージ）は比べない
    for (const image of [
      "acme-agent:1.0.0",
      "registry.example.com/sacty-agent:1.6.0",
      "localhost:5000/sacty-agent:1.6.0",
      "sacty-agent-java:1.6.0",
    ]) {
      expect(isOutdatedImage({ image, expected }), image).toBe(false);
    }
    expect(isOutdatedImage({ image: "sacty-agent:1.6.0" })).toBe(false);
  });
});

describe("確かめた結果の注意", () => {
  const ja = (problems: DaemonText[]) => problems.map((p) => renderMessage(p, "ja"));

  function setup(
    states: Record<string, ImageState>,
    targets = Object.keys(states),
    docker: DockerState = "running",
  ) {
    const asked: string[] = [];
    const state = { states: { ...states }, docker };
    const checker = new ImagePresenceChecker({
      targets: () =>
        targets.map((image) => {
          // 言語ごとのイメージ（sacty-agent-<名前>:<版>）だけ名前を付ける
          const name = /sacty-agent-(\w+):/.exec(image)?.[1];
          return name ? { image, name } : { image };
        }),
      ping: async () => state.docker,
      inspect: async (image) => {
        asked.push(image);
        return state.states[image] ?? "present";
      },
    });
    return { checker, asked, state };
  }

  it("すべてあれば注意は無い", async () => {
    const { checker } = setup({
      "sacty-agent:1.12.0": "present",
      "sacty-agent-java:1.12.0": "present",
    });
    expect(await checker.check()).toEqual([]);
    expect(checker.problems()).toEqual([]);
  });

  it("無いイメージごとに、名前と作るコマンドを出す（一部だけ無いときは、その分だけ）", async () => {
    const { checker } = setup({
      "sacty-agent:1.12.0": "missing",
      "sacty-agent-java:1.12.0": "missing",
      "sacty-agent-go:1.12.0": "present",
    });
    expect(ja(await checker.check())).toEqual([
      "エージェント用のイメージ（sacty-agent:1.12.0）がありません。`npx sacty image build` で作成してください。",
      "エージェント用のイメージ（sacty-agent-java:1.12.0）がありません。`npx sacty image build java` で作成してください。",
    ]);
  });

  it("レジストリのイメージが手元に無いときは、取得を試みることと、作るコマンドを伝える", async () => {
    const { checker } = setup({ "registry.example.com/sacty-agent:1.12.0": "missing" });
    expect(ja(await checker.check())).toEqual([
      "エージェント用のイメージ（registry.example.com/sacty-agent:1.12.0）が手元にありません。実行のときにレジストリから取得を試みます。取得できなければ `npx sacty image build` で作成してください。",
    ]);
  });

  it("Docker に接続できなければ、イメージごとではなく 1 つにまとめ、無いとは言わない", async () => {
    const { checker } = setup({
      "sacty-agent:1.12.0": "unreachable",
      "sacty-agent-java:1.12.0": "unreachable",
    });
    expect(await checker.check()).toEqual([message("image.dockerUnreachable")]);
  });

  it("Docker が動いていない・docker が無ければ、イメージは確かめずに、そのことだけを 1 つ出す", async () => {
    const { checker, asked, state } = setup(
      { "sacty-agent:1.12.0": "missing", "sacty-agent-java:1.12.0": "missing" },
      undefined,
      "unreachable",
    );
    expect(await checker.check()).toEqual([message("image.dockerUnreachable")]);
    state.docker = "noCli";
    expect(await checker.check()).toEqual([message("image.dockerNotInstalled")]);
    expect(asked).toEqual([]);
    // Docker が動き出したら、次の確かめでイメージの注意に変わる
    state.docker = "running";
    expect(await checker.check()).toHaveLength(2);
  });

  it("設定のイメージの版が違えば、直す場所と動いている版のイメージを出し、手元にあるかは確かめない", async () => {
    const asked: string[] = [];
    const checker = new ImagePresenceChecker({
      targets: () => [
        { image: "sacty-agent:1.6.0", expected: "sacty-agent:1.12.0" },
        { image: "sacty-agent-java:1.6.0", name: "java", expected: "sacty-agent-java:1.12.0" },
        { image: "sacty-agent-go:1.12.0", name: "go", expected: "sacty-agent-go:1.12.0" },
      ],
      ping: async () => "running",
      inspect: async (image) => {
        asked.push(image);
        return "missing";
      },
    });
    expect(ja(await checker.check())).toEqual([
      "config.yaml の image（sacty-agent:1.6.0）が、動いている Sacty の版のイメージ（sacty-agent:1.12.0）と違います。config.yaml の image の値を `sacty-agent:1.12.0` に直してから `npx sacty image build` で作成してください。",
      "config.yaml の images.java.image（sacty-agent-java:1.6.0）が、動いている Sacty の版のイメージ（sacty-agent-java:1.12.0）と違います。config.yaml の images.java.image の値を `sacty-agent-java:1.12.0` に直してから `npx sacty image build java` で作成してください。",
      "エージェント用のイメージ（sacty-agent-go:1.12.0）がありません。`npx sacty image build go` で作成してください。",
    ]);
    expect(asked).toEqual(["sacty-agent-go:1.12.0"]);
  });

  it("同じ名前は 1 回だけ確かめ、同時に呼ばれても docker は重ねて動かさない", async () => {
    const { checker, asked } = setup({ "sacty-agent:1.12.0": "missing" }, [
      "sacty-agent:1.12.0",
      "sacty-agent:1.12.0",
    ]);
    await Promise.all([checker.check(), checker.check()]);
    expect(asked).toEqual(["sacty-agent:1.12.0"]);
    expect(checker.problems()).toHaveLength(1);
  });

  it("作った後の確かめで注意が消える", async () => {
    const { checker, state } = setup({ "sacty-agent:1.12.0": "missing" });
    await checker.check();
    expect(checker.problems()).toHaveLength(1);
    state.states["sacty-agent:1.12.0"] = "present";
    await checker.check();
    expect(checker.problems()).toEqual([]);
  });

  it("英語の文言もある", () => {
    expect(
      renderMessage(
        message("image.missing", { image: "sacty-agent:1.12.0", command: "npx sacty image build" }),
        "en",
      ),
    ).toBe(
      "The agent image (sacty-agent:1.12.0) is missing. Create it with `npx sacty image build`.",
    );
    expect(renderMessage(message("image.dockerUnreachable"), "en")).toContain(
      "Docker is not reachable",
    );
    expect(renderMessage(message("image.dockerNotInstalled"), "en")).toContain(
      "The docker command was not found",
    );
    expect(
      renderMessage(
        message("image.outdated", {
          image: "sacty-agent:1.6.0",
          expected: "sacty-agent:1.12.0",
          key: "image",
          command: "npx sacty image build",
        }),
        "en",
      ),
    ).toBe(
      "image in config.yaml (sacty-agent:1.6.0) does not match the image for the running version of Sacty (sacty-agent:1.12.0). Change the value of image in config.yaml to `sacty-agent:1.12.0`, then create it with `npx sacty image build`.",
    );
  });
});

describe("起動のときと、それからの間隔", () => {
  it("起動のときに確かめて最初の結果を渡し、それから間隔ごとに確かめ直す", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let calls = 0;
    const checker = new ImagePresenceChecker({
      targets: () => [{ image: "sacty-agent:1.12.0" }],
      ping: async () => "running",
      inspect: async () => {
        calls += 1;
        return "missing";
      },
    });
    const first: DaemonText[][] = [];
    const stop = startImagePresenceCheck(checker, (p) => first.push(p));
    await vi.waitFor(() => expect(first).toHaveLength(1));
    expect(first[0]).toHaveLength(1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(IMAGE_CHECK_INTERVAL_MS);
    expect(calls).toBe(2);
    // 最初の結果だけを渡す（端末には起動のときだけ出す）
    expect(first).toHaveLength(1);
    stop();
    await vi.advanceTimersByTimeAsync(IMAGE_CHECK_INTERVAL_MS);
    expect(calls).toBe(2);
  });
});
