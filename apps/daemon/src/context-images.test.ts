import { describe, expect, it, vi } from "vitest";
import type { LanguageImage, SactyConfig } from "./config.js";
import type { ContextImageFile } from "./context.js";
import {
  BUILD_CACHE_PRUNE_INTERVAL_MS,
  type BuildCachePruneState,
  ContextImageBuilder,
  type ContextImagesDeps,
  contextImageTag,
  PRUNE_ABORT_STOP,
  PRUNE_ABORT_TIMEOUT,
  pruneContextImagesAndBuildCache,
  removeStaleContextImages,
  runDockerStreaming,
} from "./context-images.js";
import { buildCachePruneArgs } from "./image.js";
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
  const removed: (string[] | null)[] = [];
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
      removed.push(keep === null ? null : [...keep]);
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
  const CACHE = "builder prune -f";
  const LS = "image ls --format {{.Repository}}:{{.Tag}}";
  const images = [{ name: "node-pw", image: def("x"), from: "acme" }];
  const ran = (detail?: string) =>
    `[daemon] 使っていないビルドキャッシュの片付けを実行しました${detail ? `（docker の出力の最後の行：${detail}）` : ""}。`;
  /** 警告（warn）に出た行は、頭に `warn: ` を付けて、出た順のまま logs に並べる。 */
  const failed = (detail: string) =>
    `warn: [daemon] 使っていないビルドキャッシュを消せませんでした（${detail}）。`;

  /**
   * 偽物の docker。results は、コマンドの頭ごとの結果（無ければ成功・出力なし）。同じ偽物で続けて片付けると、同じ覚え
   * （前に成功した時刻）を使う（デーモンと同じ）。時刻は clock.now を進めて動かす。
   */
  function docker(
    results: Record<string, { code?: number; stdout?: string; error?: Error }> = {},
    signal: AbortSignal = new AbortController().signal,
    state: BuildCachePruneState = {},
  ) {
    const calls: string[] = [];
    const logs: string[] = [];
    const clock = { now: 1_000_000 };
    return {
      calls,
      logs,
      clock,
      state,
      cacheCalls: () => calls.filter((c) => c === CACHE).length,
      prune: (keep: readonly string[] | null = [], prefix = "sacty-ctx-") =>
        pruneContextImagesAndBuildCache({
          keep,
          prefix,
          signal,
          state,
          now: () => clock.now,
          run: async (args) => {
            const command = args.join(" ");
            calls.push(command);
            const result = results[Object.keys(results).find((k) => command.startsWith(k)) ?? ""];
            if (result?.error) throw result.error;
            return { code: result?.code ?? 0, stdout: result?.stdout ?? "" };
          },
          log: (line) => logs.push(line),
          warn: (line) => logs.push(`warn: ${line}`),
        }),
    };
  }

  it("使わなくなったイメージを消した後に、使っていないビルドキャッシュを消し、docker の出力の最後の行をログに出す", async () => {
    const { calls, logs, prune } = docker({
      "image ls": { stdout: "sacty-ctx-p1-a:1\nsacty-ctx-p1-a:0\n" },
      "builder prune": { stdout: "ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1GB\nTotal:\t1.2GB\n" },
    });
    await prune(["sacty-ctx-p1-a:1"]);
    expect(calls).toEqual([LS, "image rm sacty-ctx-p1-a:0", CACHE]);
    expect(logs).toEqual([
      "[daemon] 使わなくなったコンテキストのイメージを消しました：sacty-ctx-p1-a:0",
      ran("Total: 1.2GB"),
    ]);
  });

  it("結果は解釈せずに出す（消すものが無かった 0B も、出力が無いときも）", async () => {
    const zero = docker({ "builder prune": { stdout: "Total:\t0B\n" } });
    await zero.prune();
    expect(zero.calls).toEqual([LS, CACHE]);
    expect(zero.logs).toEqual([ran("Total: 0B")]);
    const empty = docker();
    await empty.prune();
    expect(empty.logs).toEqual([ran()]);
  });

  it("docker が失敗したら、例外にせず、終了コードと出力の最後の行をログに出す", async () => {
    const { logs, prune } = docker({
      "builder prune": {
        code: 1,
        stdout: "warning\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.\n\n",
      },
    });
    await expect(prune()).resolves.toBeUndefined();
    expect(logs).toEqual([
      failed(
        "docker の終了コード 1：Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      ),
    ]);
  });

  it("失敗の出力が長ければ、切ってログに出す", async () => {
    const { logs, prune } = docker({ "builder prune": { code: 125, stdout: "x".repeat(1000) } });
    await prune();
    expect(logs).toEqual([failed(`docker の終了コード 125：${"x".repeat(300)}…`)]);
  });

  it("イメージの一覧を取れなくても、ビルドキャッシュは消す", async () => {
    const { calls, logs, prune } = docker({
      "image ls": { code: 1 },
      "builder prune": { stdout: "Total:\t5GB\n" },
    });
    await prune();
    expect(calls.at(-1)).toBe(CACHE);
    expect(logs).toEqual([ran("Total: 5GB")]);
  });

  it("docker を起動できなくても（例外）、例外にせず、消せなかったことをログに出す", async () => {
    const { calls, logs, prune } = docker({
      image: { error: new Error("spawn docker ENOENT") },
      builder: { error: new Error("spawn docker ENOENT") },
    });
    await expect(prune()).resolves.toBeUndefined();
    expect(calls).toEqual([LS, CACHE]);
    expect(logs).toEqual([failed("docker を実行できません：spawn docker ENOENT")]);
  });

  it("前に成功してから間隔（6時間）が経つまでは走らせず、過ぎたら走らせる", async () => {
    expect(BUILD_CACHE_PRUNE_INTERVAL_MS).toBe(6 * 60 * 60_000);
    const { calls, logs, clock, cacheCalls, prune } = docker({
      "image ls": { stdout: "sacty-ctx-p1-a:0\n" },
      "builder prune": { stdout: "Total:\t0B\n" },
    });
    await prune();
    expect(cacheCalls()).toBe(1);
    // 間隔の内：イメージの片付けは動くが、ビルドキャッシュの片付けは走らず、ログも出さない
    clock.now += 1;
    await prune();
    clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS - 2;
    await prune();
    expect(cacheCalls()).toBe(1);
    expect(calls.filter((c) => c === LS)).toHaveLength(3);
    expect(logs.filter((l) => l.includes("ビルドキャッシュ"))).toEqual([ran("Total: 0B")]);
    // ちょうど間隔が経ったら走らせ、そこからまた間隔を数える
    clock.now += 1;
    await prune();
    expect(cacheCalls()).toBe(2);
    clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS - 1;
    await prune();
    expect(cacheCalls()).toBe(2);
    clock.now += 1;
    await prune();
    expect(cacheCalls()).toBe(3);
  });

  it("成功は log に、失敗と打ち切りは warn に出す", async () => {
    const outputs = async (
      results: Parameters<typeof docker>[0],
      signal: AbortSignal = new AbortController().signal,
    ) => {
      const logged: string[] = [];
      const warned: string[] = [];
      await pruneContextImagesAndBuildCache({
        keep: [],
        prefix: "sacty-ctx-",
        signal,
        state: {},
        run: async (args) => {
          const result = results[args[0] ?? ""];
          if (result?.error) throw result.error;
          return { code: result?.code ?? 0, stdout: result?.stdout ?? "" };
        },
        log: (line) => logged.push(line),
        warn: (line) => warned.push(line),
      });
      return { logged: logged.length, warned: warned.length };
    };
    // 成功（イメージを消したことと、ビルドキャッシュの片付けを実行したこと）
    expect(await outputs({ image: { stdout: "sacty-ctx-p1-a:0\n" } })).toEqual({
      logged: 2,
      warned: 0,
    });
    // 失敗（終了コード・例外）
    expect(await outputs({ builder: { code: 1 } })).toEqual({ logged: 0, warned: 1 });
    expect(await outputs({ builder: { error: new Error("x") } })).toEqual({ logged: 0, warned: 1 });
    // 打ち切り（時間切れ・停止・理由なし）
    for (const reason of [PRUNE_ABORT_TIMEOUT, PRUNE_ABORT_STOP, undefined]) {
      const controller = new AbortController();
      controller.abort(reason);
      expect(await outputs({}, controller.signal)).toEqual({ logged: 0, warned: 1 });
    }
  });

  it("時計が戻って、前に成功した時刻より前になっても、片付けを止めない", async () => {
    const { clock, state, cacheCalls, prune } = docker();
    await prune();
    expect(cacheCalls()).toBe(1);
    // 時計が戻った（前に成功した時刻より前）：間隔が過ぎたものとして走らせ、時刻を今の時計で覚え直す
    clock.now -= 3 * BUILD_CACHE_PRUNE_INTERVAL_MS;
    await prune();
    expect(cacheCalls()).toBe(2);
    expect(state.succeededAt).toBe(clock.now);
    // 覚え直した時刻からは、ふつうに間隔を数える
    clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS - 1;
    await prune();
    expect(cacheCalls()).toBe(2);
    clock.now += 1;
    await prune();
    expect(cacheCalls()).toBe(3);
  });

  it("失敗では時刻を進めず、次の片付けで試し直す（失敗の行は、そのたびに出す）", async () => {
    const results: Parameters<typeof docker>[0] = {
      "builder prune": { code: 1, stdout: "permission denied\n" },
    };
    const { logs, state, cacheCalls, prune } = docker(results);
    await prune();
    await prune();
    results["builder prune"] = { error: new Error("spawn docker ENOENT") };
    await prune();
    expect(cacheCalls()).toBe(3);
    expect(state.succeededAt).toBeUndefined();
    expect(logs).toEqual([
      failed("docker の終了コード 1：permission denied"),
      failed("docker の終了コード 1：permission denied"),
      failed("docker を実行できません：spawn docker ENOENT"),
    ]);
    // 成功したら、そこから間隔を数える
    results["builder prune"] = { stdout: "Total:\t2GB\n" };
    await prune();
    await prune();
    expect(cacheCalls()).toBe(4);
    expect(logs.slice(3)).toEqual([ran("Total: 2GB")]);
  });

  it("成功した後の失敗でも、前に成功した時刻を変えない", async () => {
    const results: Parameters<typeof docker>[0] = {};
    const { clock, state, cacheCalls, prune } = docker(results);
    await prune();
    const first = state.succeededAt;
    clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
    results["builder prune"] = { code: 1 };
    await prune();
    await prune();
    expect(cacheCalls()).toBe(3);
    expect(state.succeededAt).toBe(first);
  });

  it("デーモンを起動した後の最初の片付けでは走らせる（前に成功した時刻は、起動し直すと忘れる）", async () => {
    const before = docker();
    await before.prune();
    await before.prune();
    expect(before.cacheCalls()).toBe(1);
    // 起動し直した後（覚えが空）は、直前に成功していても走らせる
    const after = docker();
    after.clock.now = before.clock.now;
    await after.prune();
    expect(after.cacheCalls()).toBe(1);
    // 時刻が 0 に近くても（前に成功した時刻が無ければ）走らせる
    const early = docker();
    early.clock.now = 0;
    await early.prune();
    expect(early.cacheCalls()).toBe(1);
  });

  it("イメージを消している間に打ち切られていたら、ビルドキャッシュの docker を動かさず、理由ごとの文言を出す", async () => {
    const expected: [unknown, string][] = [
      [
        PRUNE_ABORT_TIMEOUT,
        "warn: [daemon] 片付けが上限の時間を過ぎたので、ビルドキャッシュの片付けは始めていません。次の読み直しで試し直します。",
      ],
      [
        PRUNE_ABORT_STOP,
        "warn: [daemon] デーモンを止めるので、ビルドキャッシュの片付けは始めていません。",
      ],
      [
        undefined,
        "warn: [daemon] 片付けを打ち切ったので、ビルドキャッシュの片付けは始めていません。",
      ],
    ];
    for (const [reason, line] of expected) {
      const controller = new AbortController();
      controller.abort(reason);
      const { calls, logs, state, prune } = docker({}, controller.signal);
      await prune();
      expect(calls).toEqual([LS]);
      expect(logs).toEqual([line]);
      expect(state.succeededAt).toBeUndefined();
    }
  });

  it("間隔の内なら、打ち切られていても、ビルドキャッシュのことは何も出さない", async () => {
    const controller = new AbortController();
    controller.abort(PRUNE_ABORT_TIMEOUT);
    const { calls, logs, prune } = docker({}, controller.signal, { succeededAt: 1_000_000 });
    await prune();
    expect(calls).toEqual([LS]);
    expect(logs).toEqual([]);
  });

  it("ログの期間と docker の引数は、同じ定数から作る", async () => {
    expect(buildCachePruneArgs()).toEqual(["builder", "prune", "-f"]);
    const { calls, logs, prune } = docker();
    await prune();
    // 動かす docker にも、期間の絞り込み（--filter until=…）と --all が無い
    const cache = calls.filter((c) => c.startsWith("builder "));
    expect(cache).toEqual(["builder prune -f"]);
    expect(cache.join(" ")).not.toMatch(/--filter|until|--all|(^| )-a( |$)/);
    // ログにも、期間を書かない
    expect(logs).toEqual(["[daemon] 使っていないビルドキャッシュの片付けを実行しました。"]);
  });

  /**
   * 実際のビルダーに、片付けをつなぐ。builder prune は、止められるか release で解放されるまで終わらない（hold）か、
   * すぐ成功する。止められたら 1 で終わる（runDockerStreaming と同じ）。
   */
  function wired(options: {
    hold?: boolean;
    pruneTimeoutMs?: number;
    build?: ContextImagesDeps["build"];
    load?: ContextImagesDeps["load"];
    projects?: { id: string; name: string }[];
    /** 設定（無ければ、読める設定）。 */
    config?: () => SactyConfig | undefined;
    /** docker image ls が返すイメージ（無ければ、何も返さない）。 */
    listed?: () => string[];
  }) {
    const calls: string[] = [];
    const logs: string[] = [];
    const releases: ((code: number) => void)[] = [];
    const clock = { now: 1_000_000 };
    let running = 0;
    let maxRunning = 0;
    const state: BuildCachePruneState = {};
    const builder = new ContextImageBuilder({
      projects: () => options.projects ?? [{ id: "p1", name: "p" }],
      load: options.load ?? (async () => ({ images, warnings: [] })),
      config: options.config ?? (() => baseConfig()),
      inspect: async () => (options.build ? "missing" : "present"),
      build: options.build ?? (async () => undefined),
      ...(options.pruneTimeoutMs ? { pruneTimeoutMs: options.pruneTimeoutMs } : {}),
      removeStale: (keep, prefix, signal) =>
        pruneContextImagesAndBuildCache({
          keep,
          prefix,
          signal,
          state,
          now: () => clock.now,
          run: (args) => {
            calls.push(args.join(" "));
            if (args[0] === "image" && args[1] === "ls") {
              return Promise.resolve({ code: 0, stdout: (options.listed?.() ?? []).join("\n") });
            }
            if (args[0] !== "builder") return Promise.resolve({ code: 0, stdout: "" });
            if (signal.aborted) return Promise.resolve({ code: 1, stdout: "" });
            if (!options.hold) return Promise.resolve({ code: 0, stdout: "Total:\t1GB\n" });
            running++;
            maxRunning = Math.max(maxRunning, running);
            return new Promise((resolve) => {
              const done = (code: number) => {
                running--;
                resolve({ code, stdout: "Total:\t1GB\n" });
              };
              releases.push(done);
              signal.addEventListener("abort", () => done(1), { once: true });
            });
          },
          log: (line) => logs.push(line),
          warn: (line) => logs.push(`warn: ${line}`),
        }),
    });
    return {
      builder,
      calls,
      logs,
      clock,
      state,
      /** いちばん前の、終わっていない builder prune を、終了コード code で終わらせる。 */
      release: (code: number) => releases.shift()?.(code),
      cacheCalls: () => calls.filter((c) => c === CACHE).length,
      max: () => maxRunning,
    };
  }

  it("片付けの上限の時間を過ぎたら、止めて読み直しを先に進め、時刻を進めずに次の読み直しで試し直す", async () => {
    const { builder, logs, state, cacheCalls } = wired({ hold: true, pruneTimeoutMs: 20 });
    await builder.refresh();
    await builder.idle();
    expect(cacheCalls()).toBe(1);
    const timedOut =
      "warn: [daemon] 片付けが上限の時間を過ぎたので、ビルドキャッシュの片付けを打ち切りました。次の読み直しで試し直します。";
    expect(logs).toEqual([timedOut]);
    expect(state.succeededAt).toBeUndefined();
    // 止まった後も、読み直しは動き、次の片付けで試し直す（続けて時間切れになったことも、そのたびに出す）
    await builder.refresh();
    await builder.idle();
    expect(builder.images("p1").map((e) => e.state)).toEqual(["ready"]);
    expect(cacheCalls()).toBe(2);
    expect(logs).toEqual([timedOut, timedOut]);
  });

  it("デーモンを止めると、ビルドキャッシュを消している途中でも止まる", async () => {
    const { builder, logs, state, cacheCalls } = wired({ hold: true });
    await builder.refresh();
    await vi.waitFor(() => expect(cacheCalls()).toBe(1));
    await builder.stop();
    expect(logs).toEqual([
      "warn: [daemon] デーモンを止めるので、ビルドキャッシュの片付けを打ち切りました。",
    ]);
    expect(state.succeededAt).toBeUndefined();
    // 止めた後は、片付けない
    await builder.refresh();
    expect(cacheCalls()).toBe(1);
  });

  it("読み直しのたびに片付けが動いても、ビルドキャッシュは間隔が経つまで消さない", async () => {
    const { builder, calls, clock, cacheCalls } = wired({});
    await builder.refresh();
    await builder.idle();
    await builder.refresh();
    await builder.idle();
    expect(calls.filter((c) => c === LS)).toHaveLength(2);
    expect(cacheCalls()).toBe(1);
    clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
    await builder.refresh();
    await builder.idle();
    expect(cacheCalls()).toBe(2);
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
    const { builder, clock, cacheCalls } = wired({
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
    // 間隔が経った後で、p2 の読み直しが終わらない間に、p1 を読み直す（p1 の読み直しの終わりで、片付けが試みられる）
    clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
    holdP2 = true;
    const p2 = builder.refresh("p2");
    await builder.refresh("p1");
    await new Promise((r) => setTimeout(r, 20));
    expect(cacheCalls()).toBe(1);
    releaseP2();
    await p2;
    await builder.idle();
    expect(cacheCalls()).toBe(2);
  });

  it("片付けの途中に次の片付けが求められても、ビルドキャッシュの片付けを同時に2つ動かさない", async () => {
    const { builder, calls, release, cacheCalls, max } = wired({ hold: true });
    await builder.refresh();
    await vi.waitFor(() => expect(cacheCalls()).toBe(1));
    // 1つ目が builder prune の途中にいる間に、読み直しを終える（読むプロジェクトが無いので、すぐ終わって作成と片付けを求める）
    await builder.refresh("no-such-project");
    await builder.refresh("no-such-project");
    await new Promise((r) => setTimeout(r, 20));
    expect(cacheCalls()).toBe(1);
    expect(calls.filter((c) => c === LS)).toHaveLength(1);
    expect(max()).toBe(1);
    // 1つ目を失敗で終わらせる（時刻は進まない）。その後の読み直しでは、次の片付けが動く
    release(1);
    await builder.idle();
    await builder.refresh("no-such-project");
    await vi.waitFor(() => expect(cacheCalls()).toBe(2));
    expect(max()).toBe(1);
    release(0);
    await builder.idle();
  });

  describe("コンテキストを読めないプロジェクトがある間の片付け（PBI-389）", () => {
    const two = [
      { id: "p1", name: "p1" },
      { id: "p2", name: "p2" },
    ];
    /** 手元にある、このデーモンの印のイメージ。どれも今の定義の名前ではないので、イメージの片付けが動けば消される。 */
    const listed = () => ["sacty-ctx-p1-old:1", "sacty-ctx-p2-old:1", "sacty-ctx-gone-old:1"];
    const RM = "image rm ";
    /** unreadable のプロジェクトは、読めない（取得の失敗）。ほかは読める。 */
    const loadExcept =
      (unreadable: () => string[]): ContextImagesDeps["load"] =>
      async (id) => {
        if (unreadable().includes(id)) throw new Error("clone failed");
        return { images, warnings: [] };
      };
    const imageCalls = (calls: string[]) => calls.filter((c) => c.startsWith("image "));

    it("読めないプロジェクトが1つあっても、ビルドキャッシュは片付け、イメージは1つも消さない", async () => {
      const { builder, calls, logs, state } = wired({
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
      });
      await builder.refresh();
      await builder.idle();
      expect(builder.view().find((v) => v.projectId === "p2")?.loadError).toBeDefined();
      // イメージの一覧も取らず、消しもしない（ビルドキャッシュの片付けだけ）
      expect(calls).toEqual([CACHE]);
      expect(logs).toEqual([ran("Total: 1GB")]);
      expect(state.succeededAt).toBe(1_000_000);
    });

    it("どのプロジェクトも読めなくても、ビルドキャッシュは片付け、イメージは1つも消さない", async () => {
      const { builder, calls, logs } = wired({
        projects: two,
        load: loadExcept(() => ["p1", "p2"]),
        listed,
      });
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE]);
      expect(logs).toEqual([ran("Total: 1GB")]);
    });

    it("読めないプロジェクトが無ければ、使わなくなったイメージを消してから、ビルドキャッシュを片付ける", async () => {
      const { builder, calls } = wired({ projects: two, load: loadExcept(() => []), listed });
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([LS, ...listed().map((image) => `${RM}${image}`), CACHE]);
    });

    it("前に読めていたプロジェクトが読めなくなっても、そのプロジェクトのイメージを含めて1つも消さない", async () => {
      let unreadable: string[] = [];
      const { builder, calls, clock } = wired({
        projects: two,
        load: loadExcept(() => unreadable),
        listed,
      });
      await builder.refresh();
      await builder.idle();
      expect(imageCalls(calls).filter((c) => c.startsWith(RM))).toHaveLength(3);
      calls.length = 0;
      // p2 が読めなくなる（前に読んだ定義を使い続ける）。間隔が過ぎていれば、ビルドキャッシュだけを片付ける
      unreadable = ["p2"];
      clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
      await builder.refresh();
      await builder.idle();
      expect(builder.images("p2").map((e) => e.state)).toEqual(["ready"]);
      expect(calls).toEqual([CACHE]);
    });

    it("読めるようになったら、次の読み直しからイメージも消す（間隔の内なら、ビルドキャッシュは片付けない）", async () => {
      let unreadable = ["p2"];
      const { builder, calls } = wired({
        projects: two,
        load: loadExcept(() => unreadable),
        listed,
      });
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE]);
      unreadable = [];
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE, LS, ...listed().map((image) => `${RM}${image}`)]);
    });

    it("読めない間も、前に成功してから間隔（6時間）が経つまでは走らせず、過ぎたら走らせる", async () => {
      const { builder, calls, clock, cacheCalls } = wired({
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
      });
      await builder.refresh();
      await builder.idle();
      expect(cacheCalls()).toBe(1);
      clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS - 1;
      await builder.refresh();
      await builder.idle();
      expect(cacheCalls()).toBe(1);
      clock.now += 1;
      await builder.refresh();
      await builder.idle();
      expect(cacheCalls()).toBe(2);
      expect(imageCalls(calls)).toEqual([]);
    });

    it("設定を読めないときは、読めないプロジェクトがあっても、ビルドキャッシュも片付けない", async () => {
      let config: SactyConfig | undefined = baseConfig();
      const { builder, calls, logs, clock } = wired({
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
        config: () => config,
      });
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE]);
      calls.length = 0;
      logs.length = 0;
      // 設定を読めなくなる（p2 は、前の読み込みの失敗を持ったまま）。間隔は過ぎている
      config = undefined;
      clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([]);
      expect(logs).toEqual([]);
    });

    it("設定を読めないときに読んだままのプロジェクトがあれば、ほかが読めなくても、読み直すまで何も片付けない", async () => {
      let config: SactyConfig | undefined;
      let unreadable: string[] = [];
      const { builder, calls } = wired({
        projects: two,
        load: loadExcept(() => unreadable),
        listed,
        config: () => config,
      });
      await builder.refresh();
      await builder.idle();
      // 設定が戻ってから、p2 だけを読み直して、読めない（p1 は、設定を読めないときに読んだまま）
      config = baseConfig();
      unreadable = ["p2"];
      await builder.refresh("p2");
      await builder.idle();
      expect(calls).toEqual([]);
      // p1 も読み直せば、ビルドキャッシュだけを片付ける（p2 は読めないまま）
      await builder.refresh("p1");
      await builder.idle();
      expect(calls).toEqual([CACHE]);
    });

    it("読めなかった後に、設定を読めないときに読んだままのプロジェクトも、読み直すまで何も片付けない", async () => {
      let config: SactyConfig | undefined = baseConfig();
      const { builder, calls, clock } = wired({
        projects: two,
        load: loadExcept(() => ["p1"]),
        listed,
        config: () => config,
      });
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE]);
      clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
      // 設定を読めない間に読む（p1 は、前の読み込みの失敗を持ったまま、読み終えたことになる）
      config = undefined;
      await builder.refresh();
      await builder.idle();
      // 設定が戻ってから、p2 だけを読み直す
      config = baseConfig();
      await builder.refresh("p2");
      await builder.idle();
      expect(builder.view().find((v) => v.projectId === "p1")?.loadError).toBeDefined();
      expect(calls).toEqual([CACHE]);
      // p1 も読み直せば（読めないまま）、ビルドキャッシュだけを片付ける
      await builder.refresh("p1");
      await builder.idle();
      expect(calls).toEqual([CACHE, CACHE]);
    });

    it("読めないプロジェクトがあっても、ほかのプロジェクトを読み直している最中には、片付けない", async () => {
      let releaseP2 = () => {};
      let holdP2 = false;
      const { builder, calls, clock } = wired({
        projects: two,
        listed,
        load: async (id) => {
          if (id === "p1") throw new Error("clone failed");
          if (holdP2) {
            await new Promise<void>((r) => {
              releaseP2 = r;
            });
          }
          return { images, warnings: [] };
        },
      });
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE]);
      clock.now += BUILD_CACHE_PRUNE_INTERVAL_MS;
      holdP2 = true;
      const p2 = builder.refresh("p2");
      await builder.refresh("p1");
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual([CACHE]);
      releaseP2();
      await p2;
      await builder.idle();
      expect(calls).toEqual([CACHE, CACHE]);
    });

    it("読めないプロジェクトがあっても、イメージを作っている最中には、片付けない（作り終えてから、ビルドキャッシュだけ）", async () => {
      let finish = () => {};
      const { builder, calls } = wired({
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
        build: () =>
          new Promise((r) => {
            finish = () => r(undefined);
          }),
      });
      await builder.refresh();
      await vi.waitFor(() => expect(builder.images("p1")[0]?.state).toBe("building"));
      await builder.refresh();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual([]);
      finish();
      await builder.idle();
      expect(calls).toEqual([CACHE]);
    });

    it("読めない間の片付けも、同時に2つ動かさない", async () => {
      const { builder, calls, release, cacheCalls, max } = wired({
        hold: true,
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
      });
      await builder.refresh();
      await vi.waitFor(() => expect(cacheCalls()).toBe(1));
      await builder.refresh("no-such-project");
      await builder.refresh("no-such-project");
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual([CACHE]);
      expect(max()).toBe(1);
      release(0);
      await builder.idle();
    });

    it("読めない間の片付けも、上限の時間を過ぎたら止め、時刻を進めずに次の読み直しで試し直す", async () => {
      const { builder, calls, logs, state } = wired({
        hold: true,
        pruneTimeoutMs: 20,
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
      });
      await builder.refresh();
      await builder.idle();
      const timedOut =
        "warn: [daemon] 片付けが上限の時間を過ぎたので、ビルドキャッシュの片付けを打ち切りました。次の読み直しで試し直します。";
      expect(logs).toEqual([timedOut]);
      expect(state.succeededAt).toBeUndefined();
      await builder.refresh();
      await builder.idle();
      expect(calls).toEqual([CACHE, CACHE]);
      expect(logs).toEqual([timedOut, timedOut]);
    });

    it("読めない間の片付けも、デーモンを止めると止まり、止めた後は片付けない", async () => {
      const { builder, calls, logs, state, cacheCalls } = wired({
        hold: true,
        projects: two,
        load: loadExcept(() => ["p2"]),
        listed,
      });
      await builder.refresh();
      await vi.waitFor(() => expect(cacheCalls()).toBe(1));
      await builder.stop();
      expect(logs).toEqual([
        "warn: [daemon] デーモンを止めるので、ビルドキャッシュの片付けを打ち切りました。",
      ]);
      expect(state.succeededAt).toBeUndefined();
      await builder.refresh();
      expect(calls).toEqual([CACHE]);
    });

    it("残す一覧が無い（null）片付けは、イメージの一覧を取らず・消さず、ビルドキャッシュだけを消す", async () => {
      const { calls, logs, prune } = docker({
        "image ls": { stdout: "sacty-ctx-p1-old:1\nsacty-ctx-p2-old:1\n" },
        builder: { stdout: "Total:\t0B\n" },
      });
      await prune(null);
      expect(calls).toEqual([CACHE]);
      expect(logs).toEqual([ran("Total: 0B")]);
    });

    it("残す一覧が無い（null）片付けも、始める前に打ち切られていたら、docker を動かさず、理由を出す", async () => {
      const controller = new AbortController();
      controller.abort(PRUNE_ABORT_STOP);
      const { calls, logs, prune } = docker({}, controller.signal);
      await prune(null);
      expect(calls).toEqual([]);
      expect(logs).toEqual([
        "warn: [daemon] デーモンを止めるので、ビルドキャッシュの片付けは始めていません。",
      ]);
    });
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
