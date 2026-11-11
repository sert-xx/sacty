import { describe, expect, it } from "vitest";
import type { LanguageImage, SactyConfig } from "./config.js";
import type { ContextImageFile } from "./context.js";
import {
  ContextImageBuilder,
  type ContextImagesDeps,
  contextImageTag,
  removeStaleContextImages,
} from "./context-images.js";
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
    const used: SactyConfig["imageBuild"][] = [];
    let release = () => {};
    const builder = new ContextImageBuilder({
      projects: () => [{ id: "p1", name: "p" }],
      load: async () => ({ images: one, warnings: [] }),
      config: () => ({ ...baseConfig(), imageBuild: build }),
      inspect: async () => "missing",
      build: (_l, b) => {
        used.push(b);
        return new Promise((r) => {
          release = () => r(undefined);
        });
      },
    });
    await builder.refresh();
    build = { npmRegistry: "https://b.example.com/" };
    release();
    await builder.idle();
    expect(used).toEqual([{ npmRegistry: "https://a.example.com/" }]);
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
