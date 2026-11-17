import { describe, expect, it, vi } from "vitest";
import type { LanguageImage, SactyConfig } from "./config.js";
import type { ContextImageFile } from "./context.js";
import {
  ContextImageBuilder,
  type ContextImagesDeps,
  contextImageTag,
  PRUNE_ABORT_STOP,
  PRUNE_ABORT_TIMEOUT,
  pruneContextImagesAndBuildCache,
  removeStaleContextImages,
  runDockerStreaming,
} from "./context-images.js";
import { BUILD_CACHE_MAX_UNUSED_DAYS, buildCachePruneArgs } from "./image.js";
import type { ImageState } from "./image-presence.js";

const def = (description: string, extra: Partial<ContextImageFile> = {}): ContextImageFile => ({
  description,
  base_image: "registry.example.com/ci/node:26",
  env: {},
  packages: [],
  enable_repos: [],
  run: [],
  ...extra,
});

const baseConfig = (images: Record<string, LanguageImage> = {}) =>
  ({ image: "sacty-agent:1.0.0", imageBuild: {}, images }) as unknown as SactyConfig;

/** 偽物の依存。build は resolveBuild を呼ぶまで終わらない（作成中を確かめるため）。 */
function setup(
  options: {
    images?: Record<string, { name: string; image: ContextImageFile; from: string }[]>;
    present?: string[];
    inspect?: ImageState;
    config?: SactyConfig;
    fail?: string[];
    load?: ContextImagesDeps["load"];
  } = {},
) {
  let images = options.images ?? {
    p1: [{ name: "node-pw", image: def("Node.js・Playwright"), from: "acme@abc1234" }],
  };
  const projects = Object.keys(images).map((id) => ({ id, name: `project-${id}` }));
  const present = new Set(options.present ?? []);
  const built: string[] = [];
  const pending: { image: string; finish: () => void }[] = [];
  const removed: string[][] = [];
  let auto = true;
  const deps: ContextImagesDeps = {
    projects: () => projects,
    load: options.load ?? (async (id) => ({ images: images[id] ?? [], warnings: [] })),
    config: () => options.config ?? baseConfig(),
    inspect: async (image) => options.inspect ?? (present.has(image) ? "present" : "missing"),
    build: (language, _build, onOutput) =>
      new Promise((resolve) => {
        onOutput(`#1 building ${language.image}\n`);
        const finish = () => {
          built.push(language.image);
          present.add(language.image);
          resolve(
            options.fail?.includes(language.name) ? "イメージを作成できませんでした。" : undefined,
          );
        };
        if (auto) finish();
        else pending.push({ image: language.image, finish });
      }),
    removeStale: async (keep) => {
      removed.push([...keep]);
    },
    now: () => new Date("2026-11-11T00:00:00Z"),
  };
  const builder = new ContextImageBuilder(deps);
  return {
    builder,
    built,
    pending,
    removed,
    present,
    hold: () => {
      auto = false;
    },
    setImages: (next: typeof images) => {
      images = next;
    },
  };
}

describe("コンテキストのイメージ（PBI-325）", () => {
  it("手元に無いイメージを作り、作り終えたら作成済みにする", async () => {
    const { builder, built } = setup();
    await builder.refresh();
    await builder.idle();
    const [entry] = builder.images("p1");
    expect(entry?.state).toBe("ready");
    expect(entry?.image).toMatch(/^sacty-ctx-p1-node-pw:[0-9a-f]{16}$/);
    expect(built).toEqual([entry?.image]);
    expect(entry?.log).toContain("building");
    expect(builder.pending("p1")).toBe(false);
  });

  it("手元にあるイメージは作らない", async () => {
    const tag = contextImageTag("p1", "node-pw", def("Node.js・Playwright"), {});
    const { builder, built } = setup({ present: [tag] });
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1")[0]?.state).toBe("ready");
    expect(built).toEqual([]);
  });

  it("作っている間は pending で、作り終えるまで settled が待つ", async () => {
    const { builder, pending, hold } = setup();
    hold();
    await builder.refresh();
    expect(builder.pending("p1")).toBe(true);
    expect(builder.images("p1")[0]?.state).toBe("building");
    expect(builder.view()[0]?.images[0]?.state).toBe("building");
    const waiting = builder.settled("p1", 10_000);
    pending[0]?.finish();
    await expect(waiting).resolves.toBe("settled");
    expect(builder.images("p1")[0]?.state).toBe("ready");
  });

  it("待つ上限を過ぎたら timeout を返す", async () => {
    const { builder, hold } = setup();
    hold();
    await builder.refresh();
    await expect(builder.settled("p1", 10)).resolves.toBe("timeout");
  });

  it("1つずつ順に作る", async () => {
    const { builder, pending, hold } = setup({
      images: {
        p1: [
          { name: "a", image: def("A"), from: "acme" },
          { name: "b", image: def("B"), from: "acme" },
        ],
      },
    });
    hold();
    await builder.refresh();
    expect(builder.images("p1").map((e) => e.state)).toEqual(["building", "queued"]);
    pending[0]?.finish();
    await new Promise((r) => setImmediate(r));
    expect(builder.images("p1").map((e) => e.state)).toEqual(["ready", "building"]);
    pending[1]?.finish();
    await builder.idle();
    expect(builder.images("p1").map((e) => e.state)).toEqual(["ready", "ready"]);
  });

  it("失敗したら理由とログを残し、自動では作り直さない。作り直すと、もう一度作る", async () => {
    const { builder, built } = setup({ fail: ["node-pw"] });
    await builder.refresh();
    await builder.idle();
    const entry = builder.images("p1")[0];
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toEqual({
      code: "contextImage.buildFailed",
      params: { detail: "イメージを作成できませんでした。" },
    });
    expect(builder.pending("p1")).toBe(false);
    // 読み直しても、失敗したものは作らない
    await builder.refresh();
    await builder.idle();
    expect(built).toHaveLength(1);
    expect(builder.images("p1")[0]?.state).toBe("failed");
    // 作り直す
    expect(builder.rebuild("p1", "node-pw")).toEqual({ ok: true });
    await builder.idle();
    expect(built).toHaveLength(2);
  });

  it("失敗していないもの・無いものは作り直せない", async () => {
    const { builder } = setup();
    await builder.refresh();
    await builder.idle();
    expect(builder.rebuild("p1", "node-pw")).toEqual({
      ok: false,
      message: { code: "contextImage.notFailed", params: { name: "node-pw" } },
    });
    expect(builder.rebuild("p1", "missing")).toEqual({
      ok: false,
      message: { code: "contextImage.notFound", params: { name: "missing" } },
    });
  });

  it("定義が変われば、新しい名前で作る", async () => {
    const { builder, built, setImages } = setup();
    await builder.refresh();
    await builder.idle();
    const before = builder.images("p1")[0]?.image;
    setImages({
      p1: [
        {
          name: "node-pw",
          image: def("Node.js・Playwright", { packages: ["git"] }),
          from: "acme@def5678",
        },
      ],
    });
    await builder.refresh("p1");
    await builder.idle();
    const after = builder.images("p1")[0]?.image;
    expect(after).not.toBe(before);
    expect(built).toEqual([before, after]);
  });

  it("config.yaml の images と同じ名前は作らず、警告を残す", async () => {
    const config = baseConfig({
      "node-pw": {
        name: "node-pw",
        image: "sacty-agent-node-pw:1.0.0",
        description: "x",
        baseImage: "node:26",
        env: {},
      },
    });
    const { builder, built } = setup({ config });
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1")).toEqual([]);
    expect(built).toEqual([]);
    expect(builder.view()[0]?.warnings).toEqual([
      { code: "contextImage.configOverride", params: { project: "project-p1", name: "node-pw" } },
    ]);
  });

  it("Docker に接続できなければ失敗にし、次に読み直すときに確かめ直す", async () => {
    let state: ImageState = "unreachable";
    const s = setup();
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "project-p1" }],
      load: async () => ({
        images: [{ name: "node-pw", image: def("x"), from: "acme" }],
        warnings: [],
      }),
      config: () => baseConfig(),
      inspect: async () => state,
      build: async () => undefined,
    });
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1")[0]?.state).toBe("failed");
    expect(builder.images("p1")[0]?.error).toEqual({ code: "image.dockerUnreachable" });
    state = "present";
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1")[0]?.state).toBe("ready");
    expect(s.built).toEqual([]);
  });

  it("コンテキストを読めなければ、理由を残して待たせない", async () => {
    const { builder } = setup({
      load: async () => {
        throw new Error("clone failed");
      },
    });
    await builder.refresh();
    expect(builder.pending("p1")).toBe(false);
    expect(builder.view()[0]?.loadError).toEqual({
      code: "contextImage.loadFailed",
      params: { project: "project-p1", detail: "clone failed" },
    });
  });

  it("読み終える前は pending（イメージを作るかが分からないため）", () => {
    const { builder } = setup();
    expect(builder.pending("p1")).toBe(true);
    // コンテキストの無いプロジェクトは待たせない
    expect(builder.pending("other")).toBe(false);
  });

  it("作り終えたら、今の定義のイメージ以外を片付ける", async () => {
    const { builder, removed } = setup();
    await builder.refresh();
    await builder.idle();
    expect(removed).toEqual([[builder.images("p1")[0]?.image]]);
  });

  it("名前はプロジェクトごとに分かれ、Docker の名前に使える形になる", () => {
    const a = contextImageTag("Project_A", "node_pw", def("x"), {});
    const b = contextImageTag("Project_B", "node_pw", def("x"), {});
    expect(a).toMatch(/^sacty-ctx-project-a-node-pw:[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    // image_build が変われば作り直す
    expect(
      contextImageTag("Project_A", "node_pw", def("x"), {
        npmRegistry: "https://npm.example.com/",
      }),
    ).not.toBe(a);
  });
});

describe("コンテキストのイメージ（PBI-325 レビュー指摘）", () => {
  const one = [{ name: "node-pw", image: def("x"), from: "acme" }];

  it("作成済みのものも読み直すときに確かめ、消えていれば作り直す", async () => {
    const { builder, built, present } = setup();
    await builder.refresh();
    await builder.idle();
    const tag = builder.images("p1")[0]?.image ?? "";
    present.delete(tag);
    await builder.refresh();
    await builder.idle();
    expect(built).toEqual([tag, tag]);
    expect(builder.images("p1")[0]?.state).toBe("ready");
  });

  it("名前を決めたときの image_build で作る（順番待ちの間に設定が変わっても、名前と中身を一致させる）", async () => {
    let build: SactyConfig["imageBuild"] = { npmRegistry: "https://a.example.com/" };
    const used: { name: string; build: SactyConfig["imageBuild"] }[] = [];
    let release = () => {};
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({
        images: [
          { name: "a", image: def("A"), from: "acme" },
          { name: "b", image: def("B"), from: "acme" },
        ],
        warnings: [],
      }),
      config: () => ({ ...baseConfig(), imageBuild: build }),
      inspect: async () => "missing",
      build: (language, b) => {
        used.push({ name: language.name, build: b });
        if (language.name === "b") return Promise.resolve(undefined);
        // 先の作成で順番を塞ぐ（b は名前を決めたまま、順番待ちになる）
        return new Promise((r) => {
          release = () => r(undefined);
        });
      },
    });
    await builder.refresh();
    expect(builder.images("p1").map((e) => e.state)).toEqual(["building", "queued"]);
    // b の名前を決めた後に、設定を変える
    build = { npmRegistry: "https://b.example.com/" };
    release();
    await builder.idle();
    expect(used).toEqual([
      { name: "a", build: { npmRegistry: "https://a.example.com/" } },
      { name: "b", build: { npmRegistry: "https://a.example.com/" } },
    ]);
  });

  it("作るのが上限の時間を過ぎたら止めて失敗にし、後のものを作る", async () => {
    const started: string[] = [];
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({
        images: [
          { name: "a", image: def("A"), from: "acme" },
          { name: "b", image: def("B"), from: "acme" },
        ],
        warnings: [],
      }),
      config: () => baseConfig(),
      inspect: async () => "missing",
      build: (language, _b, _o, signal) => {
        started.push(language.name);
        if (language.name === "b") return Promise.resolve(undefined);
        return new Promise((r) => signal.addEventListener("abort", () => r("止めました")));
      },
      buildTimeoutMs: 20,
    });
    await builder.refresh();
    await builder.idle();
    expect(started).toEqual(["a", "b"]);
    expect(builder.images("p1").map((e) => e.state)).toEqual(["failed", "ready"]);
    expect(builder.images("p1")[0]?.error).toEqual({
      code: "contextImage.buildTimedOut",
      params: { minutes: 1 },
    });
  });

  it("コンテキストの取得が上限の時間を過ぎたら止めて、後のプロジェクトを読む", async () => {
    const aborted: string[] = [];
    const builder = new ContextImageBuilder({
      projects: () => [
        { id: "p1", name: "p1" },
        { id: "p2", name: "p2" },
      ],
      load: (id, signal) =>
        id === "p1"
          ? new Promise((_, reject) =>
              signal.addEventListener("abort", () => {
                aborted.push(id);
                reject(new Error("aborted"));
              }),
            )
          : Promise.resolve({ images: one, warnings: [] }),
      config: () => baseConfig(),
      inspect: async () => "present",
      build: async () => undefined,
      loadTimeoutMs: 20,
    });
    await builder.refresh();
    expect(aborted).toEqual(["p1"]);
    expect(builder.view().find((p) => p.projectId === "p1")?.loadError).toEqual({
      code: "contextImage.loadFailed",
      params: {
        project: "p1",
        detail: { code: "contextImage.loadTimedOut", params: { minutes: 1 } },
      },
    });
    expect(builder.images("p2")[0]?.state).toBe("ready");
  });

  it("片付けている間は、読み直しが手元にあるかを確かめない（片付けた後に確かめる）", async () => {
    const order: string[] = [];
    let finishPrune = () => {};
    let images = one;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images, warnings: [] }),
      config: () => baseConfig(),
      inspect: async (image) => {
        order.push(`inspect ${image.split(":")[0]}`);
        return "present";
      },
      build: async () => undefined,
      removeStale: () =>
        new Promise((r) => {
          order.push("prune start");
          finishPrune = () => {
            order.push("prune end");
            r();
          };
        }),
    });
    await builder.refresh();
    // 片付けの途中で、定義を変えて読み直す
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["inspect sacty-ctx-p1-node-pw", "prune start"]);
    images = [{ name: "other", image: def("y"), from: "acme" }];
    const refreshing = builder.refresh();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["inspect sacty-ctx-p1-node-pw", "prune start"]);
    finishPrune();
    await refreshing;
    expect(order.slice(2, 4)).toEqual(["prune end", "inspect sacty-ctx-p1-other"]);
  });

  it("片付けている間に順番待ちが増えたら、片付けの後に続けて作る", async () => {
    let finishPrune = () => {};
    let pruneCalls = 0;
    const built: string[] = [];
    let images = one;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images, warnings: [] }),
      config: () => baseConfig(),
      inspect: async (image) =>
        built.some((n) => image.includes(`-${n}:`)) ? "present" : "missing",
      build: async (language) => {
        built.push(language.name);
        return undefined;
      },
      removeStale: () => {
        pruneCalls++;
        return pruneCalls === 1
          ? new Promise((r) => {
              finishPrune = r;
            })
          : Promise.resolve();
      },
    });
    await builder.refresh();
    await new Promise((r) => setImmediate(r));
    images = [...one, { name: "other", image: def("y"), from: "acme" }];
    const refreshing = builder.refresh();
    finishPrune();
    await refreshing;
    await builder.idle();
    expect(built).toEqual(["node-pw", "other"]);
  });

  it("止めるときは、作成中の docker を止め、作成の後片付けが終わるまで待つ", async () => {
    let cleaned = false;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images: one, warnings: [] }),
      config: () => baseConfig(),
      inspect: async () => "missing",
      build: (_l, _b, _o, signal) =>
        new Promise((r) =>
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              cleaned = true;
              r("止めました");
            }, 10),
          ),
        ),
    });
    await builder.refresh();
    expect(builder.images("p1")[0]?.state).toBe("building");
    await builder.stop();
    expect(cleaned).toBe(true);
  });

  it("設定を読めないときは、片付けない（定義を確かめていない空の一覧で消さないように）", async () => {
    let removed = 0;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images: one, warnings: [] }),
      config: () => undefined,
      inspect: async () => "present",
      build: async () => undefined,
      removeStale: async () => {
        removed++;
      },
    });
    await builder.refresh();
    await builder.idle();
    builder.rebuild("p1", "node-pw");
    await builder.idle();
    expect(removed).toBe(0);
    expect(builder.pending("p1")).toBe(false);
  });

  it("片付けが上限の時間を過ぎたら止めて、読み直しと作成を先に進める", async () => {
    let aborted = false;
    let images = one;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images, warnings: [] }),
      config: () => baseConfig(),
      inspect: async () => "present",
      build: async () => undefined,
      removeStale: (_keep, _prefix, signal) =>
        new Promise((r) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            r();
          });
        }),
      pruneTimeoutMs: 20,
    });
    await builder.refresh();
    await builder.idle();
    expect(aborted).toBe(true);
    images = [{ name: "other", image: def("y"), from: "acme" }];
    await builder.refresh();
    expect(builder.images("p1").map((e) => e.name)).toEqual(["other"]);
  });

  it("config.yaml に無い constructor などの名前を、同じ名前と取り違えない", async () => {
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({
        images: [{ name: "constructor", image: def("x"), from: "acme" }],
        warnings: [],
      }),
      config: () => baseConfig(),
      inspect: async () => "present",
      build: async () => undefined,
    });
    await builder.refresh();
    expect(builder.images("p1").map((e) => e.name)).toEqual(["constructor"]);
    expect(builder.view()[0]?.warnings).toEqual([]);
  });

  it("読んでいる途中に読み直しを求められたら、読み終えた後にもう一度読んでから待ちを解く", async () => {
    let images = one;
    let releaseFirst = () => {};
    let loads = 0;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => {
        loads++;
        if (loads === 1) {
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
          return { images: one, warnings: [] };
        }
        return { images, warnings: [] };
      },
      config: () => baseConfig(),
      inspect: async () => "present",
      build: async () => undefined,
    });
    const first = builder.refresh();
    await new Promise((r) => setImmediate(r));
    // 保存で定義が変わり、読み直しを求める
    images = [{ name: "other", image: def("y"), from: "acme" }];
    const second = builder.refresh("p1");
    releaseFirst();
    await Promise.all([first, second]);
    expect(loads).toBe(2);
    expect(builder.images("p1").map((e) => e.name)).toEqual(["other"]);
  });

  it("片付けの時間切れの後も、止めた片付けが終わるまでは、読み直しが手元にあるかを確かめない", async () => {
    const order: string[] = [];
    let images = one;
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images, warnings: [] }),
      config: () => baseConfig(),
      inspect: async (image) => {
        order.push(`inspect ${image.split(":")[0]}`);
        return "present";
      },
      build: async () => undefined,
      removeStale: (_keep, _prefix, signal) =>
        new Promise((r) => {
          // 止められても、すぐには終わらない（止めた docker の終わりを待つ）
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              order.push("prune end");
              r();
            }, 30),
          );
        }),
      pruneTimeoutMs: 10,
    });
    await builder.refresh();
    await new Promise((r) => setTimeout(r, 15));
    images = [{ name: "other", image: def("y"), from: "acme" }];
    await builder.refresh();
    expect(order.slice(1, 3)).toEqual(["prune end", "inspect sacty-ctx-p1-other"]);
  });

  it("止めても終わらない作成（秘密情報の取り出しが応答しないなど）は、見切って失敗にし、次を作る", async () => {
    const started: string[] = [];
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({
        images: [
          { name: "a", image: def("A"), from: "acme" },
          { name: "b", image: def("B"), from: "acme" },
        ],
        warnings: [],
      }),
      config: () => baseConfig(),
      inspect: async () => "missing",
      build: (language) => {
        started.push(language.name);
        // a は止めても終わらない
        return language.name === "a" ? new Promise(() => {}) : Promise.resolve(undefined);
      },
      buildTimeoutMs: 10,
      abandonMs: 10,
    });
    await builder.refresh();
    await builder.idle();
    expect(started).toEqual(["a", "b"]);
    expect(builder.images("p1").map((e) => e.state)).toEqual(["failed", "ready"]);
    expect(builder.images("p1")[0]?.error).toEqual({
      code: "contextImage.buildTimedOut",
      params: { minutes: 1 },
    });
  });

  it("設定を読めないときに読んだプロジェクトは、設定が戻っても、読み直すまで片付けの対象にしない", async () => {
    let config: SactyConfig | undefined;
    let removed = 0;
    const builder = new ContextImageBuilder({
      projects: () => [
        { id: "p1", name: "p1" },
        { id: "p2", name: "p2" },
      ],
      load: async () => ({ images: one, warnings: [] }),
      config: () => config,
      inspect: async () => "present",
      build: async () => undefined,
      removeStale: async () => {
        removed++;
      },
    });
    await builder.refresh();
    await builder.idle();
    // 設定が戻ってから、p2 だけを読み直す（p1 は、設定を読めないときに読んだまま）
    config = baseConfig();
    await builder.refresh("p2");
    await builder.idle();
    expect(removed).toBe(0);
    // p1 も読み直せば、片付ける
    await builder.refresh("p1");
    await builder.idle();
    expect(removed).toBe(1);
  });

  it("デーモンの印を名前に入れ、片付けはその印のものだけを消す", async () => {
    const prefixes: string[] = [];
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images: one, warnings: [] }),
      config: () => baseConfig(),
      inspect: async () => "present",
      build: async () => undefined,
      owner: "abc123",
      removeStale: async (_keep, prefix) => {
        prefixes.push(prefix);
      },
    });
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1")[0]?.image).toMatch(/^sacty-ctx-abc123-p1-node-pw:/);
    expect(prefixes).toEqual(["sacty-ctx-abc123-"]);
  });
});

describe("docker の実行（PBI-325）", () => {
  it("止めるときは SIGTERM を送り、終わらなければ SIGKILL を送ってから、終わりを返す", async () => {
    const { EventEmitter } = await import("node:events");
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (signal: string) => {
        signals.push(signal);
        // SIGTERM では終わらず、SIGKILL で終わる
        if (signal === "SIGKILL") setImmediate(() => child.emit("close", null));
        return true;
      },
    });
    const controller = new AbortController();
    const running = runDockerStreaming(
      ["build", "."],
      () => {},
      controller.signal,
      (() => child) as unknown as typeof import("node:child_process").spawn,
      10,
    );
    controller.abort();
    await expect(running).resolves.toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("使わなくなったコンテキストのイメージの片付け（PBI-325）", () => {
  it("sacty-ctx- のもので、残すもの以外を消す", async () => {
    const calls: string[][] = [];
    const removed = await removeStaleContextImages(["sacty-ctx-p1-a:1"], async (args) => {
      calls.push(args);
      if (args[1] === "ls") {
        return {
          code: 0,
          stdout: "sacty-ctx-p1-a:1\nsacty-ctx-p1-a:0\nsacty-agent:1.0.0\nsacty-ctx-p2-b:<none>\n",
        };
      }
      return { code: 0, stdout: "" };
    });
    expect(removed).toEqual(["sacty-ctx-p1-a:0"]);
    expect(calls.filter((c) => c[1] === "rm")).toEqual([["image", "rm", "sacty-ctx-p1-a:0"]]);
  });

  it("印を指定すれば、その印のものだけを消す（別の SACTY_HOME のデーモンのものは消さない）", async () => {
    const removed = await removeStaleContextImages(
      [],
      async (args) =>
        args[1] === "ls"
          ? { code: 0, stdout: "sacty-ctx-aaaa-p1-a:1\nsacty-ctx-bbbb-p1-a:1\n" }
          : { code: 0, stdout: "" },
      "sacty-ctx-aaaa-",
    );
    expect(removed).toEqual(["sacty-ctx-aaaa-p1-a:1"]);
  });
});

describe("使っていないビルドキャッシュの片付け（PBI-388）", () => {
  const CACHE = "builder prune -f --filter until=72h";
  const images = [{ name: "node-pw", image: def("x"), from: "acme" }];

  /** 偽物の docker。results は、コマンドの頭ごとの結果（無ければ成功・出力なし）。 */
  function docker(
    results: Record<string, { code?: number; stdout?: string; error?: Error }> = {},
    signal: AbortSignal = new AbortController().signal,
  ) {
    const calls: string[] = [];
    const logs: string[] = [];
    // 同じ偽物で続けて片付けると、同じ覚えを使う（デーモンと同じ）
    const memory = {};
    return {
      calls,
      logs,
      prune: (keep: readonly string[] = [], prefix = "sacty-ctx-") =>
        pruneContextImagesAndBuildCache({
          keep,
          prefix,
          signal,
          memory,
          run: async (args) => {
            const command = args.join(" ");
            calls.push(command);
            const result = results[Object.keys(results).find((k) => command.startsWith(k)) ?? ""];
            if (result?.error) throw result.error;
            return { code: result?.code ?? 0, stdout: result?.stdout ?? "" };
          },
          log: (line) => logs.push(line),
        }),
    };
  }

  it("使わなくなったイメージを消した後に、3日使っていないビルドキャッシュを消し、ログに出す", async () => {
    const { calls, logs, prune } = docker({
      "image ls": { stdout: "sacty-ctx-p1-a:1\nsacty-ctx-p1-a:0\n" },
      "builder prune": { stdout: "ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1GB\nTotal:\t1.2GB\n" },
    });
    await prune(["sacty-ctx-p1-a:1"]);
    expect(calls).toEqual([
      "image ls --format {{.Repository}}:{{.Tag}}",
      "image rm sacty-ctx-p1-a:0",
      CACHE,
    ]);
    expect(logs).toEqual([
      "[daemon] 使わなくなったコンテキストのイメージを消しました：sacty-ctx-p1-a:0",
      "[daemon] 3日使っていないビルドキャッシュを消しました（空いた容量：1.2GB）。",
    ]);
  });

  it("消すイメージが無くても、ビルドキャッシュは消す（古い形の出力の量も読む）", async () => {
    const { calls, logs, prune } = docker({
      "builder prune": {
        stdout: "Deleted build cache objects:\nabc\n\nTotal reclaimed space: 3.4GB\n",
      },
    });
    await prune();
    expect(calls).toEqual(["image ls --format {{.Repository}}:{{.Tag}}", CACHE]);
    expect(logs).toEqual([
      "[daemon] 3日使っていないビルドキャッシュを消しました（空いた容量：3.4GB）。",
    ]);
  });

  it("消すキャッシュが無かった（0B）ときは、ログを出さない", async () => {
    for (const stdout of ["Total:\t0B\n", "Total reclaimed space: 0B\n", "Total: 0 B\n"]) {
      const { logs, prune } = docker({ "builder prune": { stdout } });
      await prune();
      expect(logs).toEqual([]);
    }
  });

  it("消した量を読めない出力では、消したと言い切らず、同じ行を続けて出さない", async () => {
    const { logs, prune } = docker({ "builder prune": { stdout: "done\n" } });
    await prune();
    await prune();
    await prune();
    expect(logs).toEqual([
      "[daemon] 3日使っていないビルドキャッシュの片付けを実行しました（空いた容量は読めませんでした）。",
    ]);
  });

  it("同じ失敗は続けて出さず、内容が変わったときと、消せるようになったときに出す", async () => {
    const results: Parameters<typeof docker>[0] = {
      "builder prune": { code: 1, stdout: "Cannot connect to the Docker daemon.\n" },
    };
    const { logs, prune } = docker(results);
    const failed = (detail: string) =>
      `[daemon] 使っていないビルドキャッシュを消せませんでした（${detail}）。`;
    await prune();
    await prune();
    expect(logs).toEqual([failed("docker の終了コード 1：Cannot connect to the Docker daemon.")]);
    // 内容が変われば出す
    results["builder prune"] = { code: 1, stdout: "permission denied\n" };
    await prune();
    await prune();
    results["builder prune"] = { error: new Error("spawn docker ENOENT") };
    await prune();
    await prune();
    expect(logs.slice(1)).toEqual([
      failed("docker の終了コード 1：permission denied"),
      failed("docker を実行できません：spawn docker ENOENT"),
    ]);
    // 消せるようになったら、消すものが無くても1度だけ出す
    results["builder prune"] = { stdout: "Total:\t0B\n" };
    await prune();
    await prune();
    expect(logs.slice(3)).toEqual([
      "[daemon] 3日使っていないビルドキャッシュを消せるようになりました（消すものはありませんでした）。",
    ]);
    // 戻った後の同じ失敗は、また出す
    results["builder prune"] = { code: 1, stdout: "permission denied\n" };
    await prune();
    expect(logs.slice(4)).toEqual([failed("docker の終了コード 1：permission denied")]);
    // 消したものがあって戻ったときは、消したことだけを出す
    results["builder prune"] = { stdout: "Total:\t2GB\n" };
    await prune();
    expect(logs.slice(5)).toEqual([
      "[daemon] 3日使っていないビルドキャッシュを消しました（空いた容量：2GB）。",
    ]);
  });

  it("量を読めなかった後に 0B を読めても、消せるようになったとは出さない", async () => {
    const results: Parameters<typeof docker>[0] = { "builder prune": { stdout: "done\n" } };
    const { logs, prune } = docker(results);
    await prune();
    results["builder prune"] = { stdout: "Total:\t0B\n" };
    await prune();
    expect(logs).toHaveLength(1);
  });

  it("ログの期間と docker の引数は、同じ定数から作る", async () => {
    expect(buildCachePruneArgs().at(-1)).toBe(`until=${BUILD_CACHE_MAX_UNUSED_DAYS * 24}h`);
    const { logs, prune } = docker({ "builder prune": { stdout: "Total:\t1GB\n" } });
    await prune();
    expect(logs[0]).toContain(`${BUILD_CACHE_MAX_UNUSED_DAYS}日使っていないビルドキャッシュ`);
  });

  it("docker が失敗したら、例外にせず、消せなかったことをログに出す", async () => {
    const { logs, prune } = docker({
      "builder prune": {
        code: 1,
        stdout: "warning\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.\n\n",
      },
    });
    await expect(prune()).resolves.toBeUndefined();
    expect(logs).toEqual([
      "[daemon] 使っていないビルドキャッシュを消せませんでした（docker の終了コード 1：Cannot connect to the Docker daemon at unix:///var/run/docker.sock.）。",
    ]);
  });

  it("失敗の出力が長ければ、切ってログに出す", async () => {
    const { logs, prune } = docker({ "builder prune": { code: 125, stdout: "x".repeat(1000) } });
    await prune();
    expect(logs).toEqual([
      `[daemon] 使っていないビルドキャッシュを消せませんでした（docker の終了コード 125：${"x".repeat(300)}…）。`,
    ]);
  });

  it("イメージの一覧を取れなくても、ビルドキャッシュは消す", async () => {
    const { calls, logs, prune } = docker({
      "image ls": { code: 1 },
      "builder prune": { stdout: "Total:\t5GB\n" },
    });
    await prune();
    expect(calls.at(-1)).toBe(CACHE);
    expect(logs).toEqual([
      "[daemon] 3日使っていないビルドキャッシュを消しました（空いた容量：5GB）。",
    ]);
  });

  it("docker を起動できなくても（例外）、例外にせず、消せなかったことをログに出す", async () => {
    const { calls, logs, prune } = docker({
      image: { error: new Error("spawn docker ENOENT") },
      builder: { error: new Error("spawn docker ENOENT") },
    });
    await expect(prune()).resolves.toBeUndefined();
    expect(calls).toEqual(["image ls --format {{.Repository}}:{{.Tag}}", CACHE]);
    expect(logs).toEqual([
      "[daemon] 使っていないビルドキャッシュを消せませんでした（docker を実行できません：spawn docker ENOENT）。",
    ]);
  });

  it("イメージを消している間に打ち切られていたら、ビルドキャッシュの docker を動かさない", async () => {
    const expected: [unknown, string][] = [
      [
        PRUNE_ABORT_TIMEOUT,
        "[daemon] 片付けが上限の時間を過ぎたので、ビルドキャッシュの片付けは始めていません。次の片付けで消します。",
      ],
      [
        PRUNE_ABORT_STOP,
        "[daemon] デーモンを止めるので、ビルドキャッシュの片付けは始めていません。",
      ],
      [undefined, "[daemon] 片付けを打ち切ったので、ビルドキャッシュの片付けは始めていません。"],
    ];
    for (const [reason, line] of expected) {
      const controller = new AbortController();
      controller.abort(reason);
      const { calls, logs, prune } = docker({}, controller.signal);
      await prune();
      expect(calls).toEqual(["image ls --format {{.Repository}}:{{.Tag}}"]);
      expect(logs).toEqual([line]);
    }
  });

  /** 実際のビルダーに、片付けをつなぐ。builder prune は、hang なら止められるまで終わらない（止めたら 1 で終わる）。 */
  function wired(options: {
    hang?: boolean;
    pruneTimeoutMs?: number;
    build?: ContextImagesDeps["build"];
    load?: ContextImagesDeps["load"];
    projects?: { id: string; name: string }[];
  }) {
    const calls: string[] = [];
    const logs: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const memory = {};
    const builder = new ContextImageBuilder({
      projects: () => options.projects ?? [{ id: "p1", name: "p" }],
      load: options.load ?? (async () => ({ images, warnings: [] })),
      config: () => baseConfig(),
      inspect: async () => (options.build ? "missing" : "present"),
      build: options.build ?? (async () => undefined),
      ...(options.pruneTimeoutMs ? { pruneTimeoutMs: options.pruneTimeoutMs } : {}),
      removeStale: (keep, prefix, signal) =>
        pruneContextImagesAndBuildCache({
          keep,
          prefix,
          signal,
          memory,
          run: (args) => {
            calls.push(args.join(" "));
            if (args[0] !== "builder") return Promise.resolve({ code: 0, stdout: "" });
            // runDockerStreaming と同じく、止められていれば動かさず、止められたら終わる
            if (signal.aborted) return Promise.resolve({ code: 1, stdout: "" });
            running++;
            maxRunning = Math.max(maxRunning, running);
            const done = (code: number) => {
              running--;
              return { code, stdout: "Total:\t1GB\n" };
            };
            if (!options.hang) return new Promise((r) => setTimeout(() => r(done(0)), 5));
            return new Promise((r) => signal.addEventListener("abort", () => r(done(1))));
          },
          log: (line) => logs.push(line),
        }),
    });
    return {
      builder,
      calls,
      logs,
      cacheCalls: () => calls.filter((c) => c === CACHE).length,
      max: () => maxRunning,
    };
  }

  it("片付けの上限の時間を過ぎたら、ビルドキャッシュの片付けを止めて、読み直しを先に進める", async () => {
    const { builder, logs, cacheCalls } = wired({ hang: true, pruneTimeoutMs: 20 });
    await builder.refresh();
    await builder.idle();
    expect(cacheCalls()).toBe(1);
    const timedOut =
      "[daemon] 片付けが上限の時間を過ぎたので、ビルドキャッシュの片付けを打ち切りました。次の片付けで消します。";
    expect(logs).toEqual([timedOut]);
    // 止まった後も、読み直しと次の片付けは動く
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1").map((e) => e.state)).toEqual(["ready"]);
    expect(cacheCalls()).toBe(2);
    // 続けて時間切れになっても、同じ行は出さない
    expect(logs).toEqual([timedOut]);
  });

  it("デーモンを止めると、ビルドキャッシュを消している途中でも止まる", async () => {
    const { builder, logs, cacheCalls } = wired({ hang: true });
    await builder.refresh();
    await vi.waitFor(() => expect(cacheCalls()).toBe(1));
    await builder.stop();
    expect(logs).toEqual([
      "[daemon] デーモンを止めるので、ビルドキャッシュの片付けを打ち切りました。",
    ]);
    // 止めた後は、片付けない
    await builder.refresh();
    expect(cacheCalls()).toBe(1);
  });

  it("イメージを作っている最中には、ビルドキャッシュを消さない（作り終えてから消す）", async () => {
    let finish = () => {};
    const { builder, calls, cacheCalls } = wired({
      build: () =>
        new Promise((r) => {
          finish = () => r(undefined);
        }),
    });
    await builder.refresh();
    await vi.waitFor(() => expect(builder.images("p1")[0]?.state).toBe("building"));
    // 作っている最中に読み直しても、片付けは動かない
    await builder.refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    finish();
    await builder.idle();
    expect(cacheCalls()).toBe(1);
  });

  it("ほかのプロジェクトを読み直している最中には、ビルドキャッシュを消さない", async () => {
    let releaseP2 = () => {};
    let holdP2 = false;
    const { builder, calls, cacheCalls } = wired({
      projects: [
        { id: "p1", name: "p1" },
        { id: "p2", name: "p2" },
      ],
      load: async (id) => {
        if (id === "p2" && holdP2) {
          await new Promise<void>((r) => {
            releaseP2 = r;
          });
        }
        return { images, warnings: [] };
      },
    });
    await builder.refresh();
    await builder.idle();
    expect(cacheCalls()).toBe(1);
    // p2 の読み直しが終わらない間に、p1 を読み直す（p1 の読み直しの終わりで、片付けが試みられる）
    holdP2 = true;
    const p2 = builder.refresh("p2");
    await builder.refresh("p1");
    await new Promise((r) => setTimeout(r, 20));
    expect(cacheCalls()).toBe(1);
    releaseP2();
    await p2;
    await builder.idle();
    expect(cacheCalls()).toBe(2);
    expect(calls.filter((c) => c.startsWith("builder")).every((c) => c === CACHE)).toBe(true);
  });

  it("片付けが重なっても、ビルドキャッシュの片付けを同時に2つ動かさない", async () => {
    const { builder, cacheCalls, max } = wired({});
    await Promise.all([builder.refresh(), builder.refresh("p1"), builder.refresh()]);
    await builder.refresh();
    await builder.idle();
    expect(cacheCalls()).toBeGreaterThanOrEqual(1);
    expect(max()).toBe(1);
  });
});

describe("images の名前の判定（PBI-325 レビュー指摘）", () => {
  it("継承したプロパティ（constructor など）を、images の名前と取り違えない", async () => {
    const { imageDefined, resolveImage } = await import("./config.js");
    const config = baseConfig();
    expect(imageDefined(config, "constructor")).toBe(false);
    expect(resolveImage(config, "constructor")).toEqual({
      ok: false,
      message: { code: "image.unknown", params: { name: "constructor" } },
    });
  });
});
