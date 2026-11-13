import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildImage,
  imageBuildArgs,
  imageBuildSettings,
  imageBuildTargets,
  npmGlobalConfigContent,
  npmrcContent,
  pruneOldImages,
  staleImages,
} from "./image.js";
import { MemorySecretStore, SecretNotFoundError } from "./secrets.js";

describe("イメージの作成（PBI-33）", () => {
  it("設定ファイルが無ければ既定で作り、設定ファイルに誤りがあれば既定に戻さずに止める（レビュー指摘）", () => {
    expect(
      imageBuildSettings({ ok: false, problem: message("config.missing", { path: "/x" }) }),
    ).toEqual({ ok: true, image: "sacty-agent:1.24.0", build: {}, images: {} });
    const invalid = message("config.invalid", { path: "image_build.npm_registry", detail: "URL" });
    expect(imageBuildSettings({ ok: false, problem: invalid })).toEqual({
      ok: false,
      problem: invalid,
    });
    expect(
      imageBuildSettings({ ok: false, problem: message("config.unreadable", { detail: "YAML" }) }),
    ).toMatchObject({ ok: false });
  });

  it("npm の設定は、レジストリと、そのレジストリのホスト・パスに結びつけたトークンにする", () => {
    expect(npmrcContent(undefined, undefined)).toBe("");
    expect(npmrcContent("https://npm.example.com/repository/npm", undefined)).toBe(
      "registry=https://npm.example.com/repository/npm\n",
    );
    expect(npmrcContent("https://npm.example.com/repository/npm/", "tok")).toBe(
      "registry=https://npm.example.com/repository/npm/\n//npm.example.com/repository/npm/:_authToken=tok\n",
    );
    // レジストリを変えずにトークンだけなら、公開のレジストリに結びつける
    expect(npmrcContent(undefined, "tok")).toBe("//registry.npmjs.org/:_authToken=tok\n");
  });

  it("元のイメージは build-arg で、npm の設定はファイルの場所だけを secret で渡す", () => {
    expect(
      imageBuildArgs({
        image: "registry.example.com/sacty-agent:1.24.0",
        dockerDir: "/pkg/docker",
        baseImage: "registry.example.com/library/node:26",
        npmrcPath: "/tmp/x/npmrc",
        npmVersion: "11",
        npmConfigPath: "/tmp/x/npmconfig",
        npmConfigHash: "abc123",
        setup: { packages: [], path: "/tmp/x/setup.sh", hash: "def456" },
      }),
    ).toEqual([
      "build",
      "-t",
      "registry.example.com/sacty-agent:1.24.0",
      "--build-arg",
      "BASE_IMAGE=registry.example.com/library/node:26",
      "--build-arg",
      "NPM_VERSION=11",
      // secret の中身はキャッシュの判定に入らないので、中身のハッシュで作り直させる
      "--build-arg",
      "NPM_CONFIG_HASH=abc123",
      "--secret",
      "id=npmrc,src=/tmp/x/npmrc",
      // イメージに残す npm 全体の設定は、認証の .npmrc とは別のファイルで渡す（PBI-40）。
      // --build-context は Docker の構成によっては使えないので、使わない
      "--secret",
      "id=npmconfig,src=/tmp/x/npmconfig",
      // イメージを作るときに実行するコマンド（PBI-50）。言語ごとのイメージで書いたときだけ中身がある
      "--build-arg",
      "SACTY_SETUP_HASH=def456",
      "--secret",
      "id=setup,src=/tmp/x/setup.sh",
      "/pkg/docker",
    ]);
    // 書かなければ、Dockerfile の既定（Docker Hub の node・その npm）のまま
    expect(
      imageBuildArgs({
        image: "sacty-agent:1.24.0",
        dockerDir: "/d",
        npmrcPath: "/n",
        npmConfigPath: "/c",
        npmConfigHash: "h",
        setup: { packages: [], path: "/s", hash: "h" },
      }),
    ).not.toContain("BASE_IMAGE=");
  });

  it("トークンはビルドの引数に出さず、作った一時ファイル（本人だけが読める）は終わったら消す", async () => {
    const seen: { args: string[]; npmrc: string; mode: number; path: string }[] = [];
    const failure = await buildImage({
      image: "sacty-agent:1.24.0",
      build: { npmRegistry: "https://npm.example.com/", npmToken: "npm-token" },
      dockerDir: "/d",
      secrets: new MemorySecretStore({ "npm-token": "npm_SECRET" }),
      run: async (args) => {
        const path = (args.find((a) => a.startsWith("id=npmrc,src=")) ?? "").slice(13);
        seen.push({
          args,
          npmrc: readFileSync(path, "utf8"),
          mode: statSync(path).mode & 0o777,
          path,
        });
        return 0;
      },
    });
    expect(failure).toBeUndefined();
    expect(seen[0]?.npmrc).toContain("//npm.example.com/:_authToken=npm_SECRET");
    expect(seen[0]?.mode).toBe(0o600);
    expect(seen[0]?.args.join(" ")).not.toContain("npm_SECRET");
    expect(existsSync(seen[0]?.path ?? "")).toBe(false);
  });

  it("npm 全体の設定は、イメージに残すファイルに書き、認証のトークンは含めない（PBI-40）", async () => {
    const seen: { config: string; npmrc: string; dir: string }[] = [];
    await buildImage({
      image: "sacty-agent:1.24.0",
      build: {
        npmRegistry: "https://npm.example.com/",
        npmToken: "npm-token",
        npmVersion: "11",
        npmConfig: { "replace-registry-host": "always", audit: "false", "min-release-age": "7" },
      },
      dockerDir: "/d",
      secrets: new MemorySecretStore({ "npm-token": "npm_SECRET" }),
      run: async (args) => {
        const dir = (args.find((a) => a.startsWith("id=npmconfig,src=")) ?? "").slice(17);
        const npmrc = (args.find((a) => a.startsWith("id=npmrc,src=")) ?? "").slice(13);
        seen.push({
          config: readFileSync(dir, "utf8"),
          npmrc: readFileSync(npmrc, "utf8"),
          dir,
        });
        return 0;
      },
    });
    // npm_registry は、コンテナの中の npm の registry にもする
    expect(seen[0]?.config).toBe(
      "registry=https://npm.example.com/\nreplace-registry-host=always\naudit=false\nmin-release-age=7\n",
    );
    // トークンは、ビルドのときだけ読む .npmrc にだけある
    expect(seen[0]?.config).not.toContain("npm_SECRET");
    expect(seen[0]?.npmrc).toContain("npm_SECRET");
    expect(existsSync(seen[0]?.dir ?? "")).toBe(false);
    // 設定を変えると、中身のハッシュ（ビルドの引数）が変わる（キャッシュの層を使わずに作り直す）
    const hashes: string[] = [];
    for (const audit of ["false", "true", "true"]) {
      await buildImage({
        image: "sacty-agent:1.24.0",
        build: { npmConfig: { audit } },
        dockerDir: "/d",
        secrets: new MemorySecretStore({}),
        run: async (args) => {
          hashes.push(args.find((a) => a.startsWith("NPM_CONFIG_HASH=")) ?? "");
          return 0;
        },
      });
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);
    expect(npmGlobalConfigContent({})).toBe("");
    // npm_config の registry があれば、そちらを優先する
    expect(
      npmGlobalConfigContent({
        npmRegistry: "https://build.example.com/",
        npmConfig: { registry: "https://run.example.com/" },
      }),
    ).toBe("registry=https://run.example.com/\n");
  });

  it("image_build.drawio が false なら、既定のイメージにも言語ごとのイメージにも draw.io の CLI を入れない", async () => {
    const seen: string[][] = [];
    const run = async (args: string[]) => {
      seen.push(args);
      return 0;
    };
    const secrets = new MemorySecretStore({});
    const language = {
      name: "go",
      image: "sacty-agent-go:1.24.0",
      description: "Go",
      baseImage: "registry.example.com/ci/go:1.23",
    };
    await buildImage({ image: "i", build: { drawio: false }, dockerDir: "/d", secrets, run });
    await buildImage({
      image: "i",
      build: { drawio: false },
      dockerDir: "/d",
      secrets,
      run,
      language,
    });
    // 書かなければ、Dockerfile の既定（入れる）のまま
    await buildImage({ image: "i", build: {}, dockerDir: "/d", secrets, run });
    expect(seen.map((args) => args.includes("SACTY_DRAWIO=0"))).toEqual([true, true, false]);
    expect(seen[0]?.[seen[0].indexOf("SACTY_DRAWIO=0") - 1]).toBe("--build-arg");
    expect(seen[2]?.join(" ")).not.toContain("SACTY_DRAWIO");
  });

  it("失敗したら確かめることを返し、一時ファイルは消す。トークンが無ければ作らずに止める", async () => {
    let path = "";
    const failure = await buildImage({
      image: "sacty-agent:1.24.0",
      build: { baseImage: "registry.example.com/library/node:26" },
      dockerDir: "/d",
      secrets: new MemorySecretStore({}),
      run: async (args) => {
        path = (args.find((a) => a.startsWith("id=npmrc,src=")) ?? "").slice(13);
        return 1;
      },
    });
    expect(failure).toContain("元のイメージ（registry.example.com/library/node:26）を取得できるか");
    expect(failure).toContain("npm のレジストリ（https://registry.npmjs.org/）に届くか");
    expect(existsSync(path)).toBe(false);

    let ran = false;
    await expect(
      buildImage({
        image: "sacty-agent:1.24.0",
        build: { npmToken: "missing" },
        dockerDir: "/d",
        secrets: new MemorySecretStore({}),
        run: async () => {
          ran = true;
          return 0;
        },
      }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(ran).toBe(false);
  });

  it("言語ごとのイメージは、元のイメージに Node.js を写す指定（BASE_KIND=lang）と Maven のミラーを渡す（PBI-41）", async () => {
    const java = {
      name: "java",
      image: "sacty-agent-java:1.24.0",
      description: "Java 17",
      baseImage: "registry.example.com/ci/java:17",
      env: { GOPROXY: "https://proxy.example.com" },
      mavenMirror: "https://maven.example.com/repository/maven-public/",
    };
    let args: string[] = [];
    const failure = await buildImage({
      image: "sacty-agent:1.24.0",
      // Node.js を写す元は、指定が無ければ既定のイメージの元（プライベートのレジストリの node）
      build: { baseImage: "registry.example.com/library/node:26" },
      dockerDir: "/d",
      secrets: new MemorySecretStore({}),
      language: java,
      run: async (a) => {
        args = a;
        return 0;
      },
    });
    expect(failure).toBeUndefined();
    expect(args.slice(0, 11)).toEqual([
      "build",
      "-t",
      "sacty-agent-java:1.24.0",
      "--build-arg",
      "BASE_IMAGE=registry.example.com/ci/java:17",
      "--build-arg",
      "BASE_KIND=lang",
      "--build-arg",
      "NODE_IMAGE=registry.example.com/library/node:26",
      "--build-arg",
      "MAVEN_MIRROR=https://maven.example.com/repository/maven-public/",
    ]);
    // 環境変数はイメージに焼き込まない（実行のときに渡す）
    expect(args.join(" ")).not.toContain("GOPROXY");

    // node_image を書けばそちら。既定のイメージの元も無ければ、Dockerfile の既定（node:26-bookworm-slim）
    await buildImage({
      image: "x",
      build: {},
      dockerDir: "/d",
      secrets: new MemorySecretStore({}),
      language: { ...java, mavenMirror: undefined },
      run: async (a) => {
        args = a;
        return 1;
      },
    }).then((message) => {
      expect(message).toContain("Node.js を写すイメージ（Docker Hub の node:26-bookworm-slim）");
      expect(message).toContain("registry.example.com/ci/java:17");
    });
    expect(args.some((a) => a.startsWith("NODE_IMAGE="))).toBe(false);
    expect(args.some((a) => a.startsWith("MAVEN_MIRROR="))).toBe(false);
    await buildImage({
      image: "x",
      build: { baseImage: "registry.example.com/library/node:26" },
      dockerDir: "/d",
      secrets: new MemorySecretStore({}),
      language: { ...java, nodeImage: "registry.example.com/node:26-slim" },
      run: async (a) => {
        args = a;
        return 0;
      },
    });
    expect(args).toContain("NODE_IMAGE=registry.example.com/node:26-slim");
    // 既定のイメージは BASE_KIND を渡さない（元のイメージをそのまま使う）
    await buildImage({
      image: "sacty-agent:1.24.0",
      build: {},
      dockerDir: "/d",
      secrets: new MemorySecretStore({}),
      run: async (a) => {
        args = a;
        return 0;
      },
    });
    expect(args.join(" ")).not.toMatch(/BASE_KIND|NODE_IMAGE|MAVEN_MIRROR/);
  });

  it("名前を指定しなければ、既定と images のすべてを作る。default は既定、無い名前は作らずに返す（PBI-41）", () => {
    const image = (name: string) => ({
      name,
      image: `sacty-agent-${name}:1.24.0`,
      description: name,
      baseImage: name,
      env: {},
    });
    const images = { java: image("java"), py: image("py") };
    expect(imageBuildTargets(images, [])).toEqual({
      ok: true,
      targets: [undefined, images.java, images.py],
    });
    expect(imageBuildTargets(images, ["py", "default", "py"])).toEqual({
      ok: true,
      targets: [images.py, undefined],
    });
    expect(imageBuildTargets(images, ["go", "py", "rust"])).toEqual({
      ok: false,
      unknown: ["go", "rust"],
    });
    expect(imageBuildTargets({}, [])).toEqual({ ok: true, targets: [undefined] });
  });

  it("言語ごとのイメージの packages と run を渡し、変えたら作り直させる（PBI-50）", async () => {
    const base = {
      name: "rocky",
      image: "sacty-agent-rocky:1.24.0",
      description: "Rocky",
      baseImage: "rockylinux:9",
      env: {},
    };
    const build = async (language: typeof base & { packages?: string[]; run?: string[] }) => {
      let args: string[] = [];
      let script = "";
      await buildImage({
        image: "x",
        build: {},
        dockerDir: "/d",
        secrets: new MemorySecretStore({}),
        language,
        run: async (a) => {
          args = a;
          const path = (a.find((v) => v.startsWith("id=setup,src=")) ?? "").slice(13);
          script = readFileSync(path, "utf8");
          return 0;
        },
      });
      return { args, script, hash: args.find((v) => v.startsWith("SACTY_SETUP_HASH=")) };
    };
    const withSetup = await build({
      ...base,
      packages: ["nss", "nspr", "libdrm"],
      run: ["curl -fsSL https://artifacts.example.com/pf-cli/install.sh | sh", "pf --version"],
    });
    expect(withSetup.args).toContain("SACTY_PACKAGES=nss nspr libdrm");
    // コマンドは上から順に1行ずつ（ファイルで渡し、引数には出さない）
    expect(withSetup.script).toBe(
      "curl -fsSL https://artifacts.example.com/pf-cli/install.sh | sh\npf --version\n",
    );
    expect(withSetup.args.join(" ")).not.toContain("install.sh");
    // パッケージやコマンドを変えると、ハッシュが変わる（作り直させる）
    const changedRun = await build({
      ...base,
      packages: ["nss", "nspr", "libdrm"],
      run: ["pf --version"],
    });
    const changedPackages = await build({
      ...base,
      packages: ["nss"],
      run: withSetup.script.trim().split("\n"),
    });
    expect(new Set([withSetup.hash, changedRun.hash, changedPackages.hash]).size).toBe(3);
    // 書かなければ、パッケージを渡さず、コマンドのファイルは空
    const none = await build(base);
    expect(none.args.some((v) => v.startsWith("SACTY_PACKAGES="))).toBe(false);
    expect(none.script).toBe("");
  });

  it("有効にするリポジトリを渡し、変えたら作り直させる。書かなければ、これまでと同じ（PBI-59）", async () => {
    const base = {
      name: "rocky",
      image: "sacty-agent-rocky:1.24.0",
      description: "Rocky",
      baseImage: "rockylinux:9",
      env: {},
      packages: ["nss", "nspr"],
      run: ["pf --version"],
    };
    const build = async (language: typeof base & { enableRepos?: string[] }) => {
      let args: string[] = [];
      await buildImage({
        image: "x",
        build: {},
        dockerDir: "/d",
        secrets: new MemorySecretStore({}),
        language,
        run: async (a) => {
          args = a;
          return 0;
        },
      });
      const arg = (name: string) => args.find((v) => v.startsWith(`${name}=`));
      return {
        args,
        repos: arg("SACTY_ENABLE_REPOS"),
        hash: arg("SACTY_SETUP_HASH"),
        packages: arg("SACTY_PACKAGES"),
      };
    };
    const one = await build({ ...base, enableRepos: ["corp-baseos"] });
    const two = await build({ ...base, enableRepos: ["corp-baseos", "corp-appstream"] });
    const none = await build(base);
    const empty = await build({ ...base, enableRepos: [] });
    expect(one.repos).toBe("SACTY_ENABLE_REPOS=corp-baseos");
    expect(two.repos).toBe("SACTY_ENABLE_REPOS=corp-baseos corp-appstream");
    // --build-arg の値として、1つの引数で渡す（直前が --build-arg）
    expect(two.args[two.args.indexOf(two.repos ?? "") - 1]).toBe("--build-arg");
    expect(two.packages).toBe("SACTY_PACKAGES=nss nspr");
    // 書かない・空なら渡さず、ハッシュもこれまでと同じ（作り直さない）
    expect(none.repos).toBeUndefined();
    expect(empty.repos).toBeUndefined();
    expect(empty.hash).toBe(none.hash);
    const previous = createHash("sha256")
      .update(JSON.stringify({ packages: base.packages, setupScript: "pf --version\n" }))
      .digest("hex")
      .slice(0, 16);
    expect(none.hash).toBe(`SACTY_SETUP_HASH=${previous}`);
    // 有効にするリポジトリを変えると、ハッシュが変わる（作り直させる）
    expect(new Set([none.hash, one.hash, two.hash]).size).toBe(3);
  });
});

describe("既定のイメージの固定（セキュリティチェックの指摘）", () => {
  const docker = new URL("../../../packages/cli/docker/", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, docker), "utf8");

  it("元のイメージの既定は、タグとマルチアーキのインデックスのダイジェストで固定する", () => {
    const dockerfile = read("Dockerfile");
    for (const name of ["BASE_IMAGE", "NODE_IMAGE"]) {
      expect(dockerfile).toMatch(
        new RegExp(`^ARG ${name}=node:26-bookworm-slim@sha256:[0-9a-f]{64}$`, "m"),
      );
    }
  });

  it("CLI を置いた /opt/sacty/bin は、images の run より前に PATH に通す（run から claude・codex を呼べる。レビュー指摘）", () => {
    const dockerfile = read("Dockerfile");
    const link = dockerfile.indexOf("/opt/sacty/bin/codex");
    const path = dockerfile.indexOf("ENV PATH=/opt/sacty/bin:$PATH");
    const setup = dockerfile.indexOf("/run/secrets/setup;");
    expect(link).toBeGreaterThan(0);
    expect(path).toBeGreaterThan(link);
    expect(setup).toBeGreaterThan(path);
  });

  it("引数は使う手順の直前で宣言し、重い手順のキャッシュを外さない（npm の版・Maven のミラー・draw.io の切り替え）", () => {
    const dockerfile = read("Dockerfile");
    const at = (text: string) => {
      const index = dockerfile.indexOf(text);
      expect(index, text).toBeGreaterThan(0);
      return index;
    };
    const heavy = [
      "/opt/sacty/lib/install-tools.sh\n",
      "/opt/sacty/lib/install-security-tools.sh\n",
      "/opt/sacty/lib/install-drawio.sh\n",
    ].map((text) => dockerfile.lastIndexOf(text));
    for (const index of heavy) expect(index).toBeGreaterThan(0);
    const lastHeavy = Math.max(...heavy);
    expect(at("ARG NPM_VERSION=")).toBeGreaterThan(lastHeavy);
    expect(at("ARG MAVEN_MIRROR=")).toBeGreaterThan(at("ENV PATH=/opt/sacty/bin:$PATH"));
    // draw.io を入れる・入れないの引数より前に、セキュリティの道具を入れる
    expect(at("ARG SACTY_DRAWIO=")).toBeGreaterThan(
      dockerfile.lastIndexOf("/opt/sacty/lib/install-security-tools.sh\n"),
    );
    // 包むスクリプトは draw.io の本体と別に写す（直しても draw.io を入れ直さない）
    expect(dockerfile).not.toMatch(/^COPY .*install-drawio\.sh.*drawio-shim\.cjs/m);
    // エージェントの CLI の後、images の run より前（run から drawio を使える。レビュー指摘）
    const shim = at("COPY --chmod=755 drawio-shim.cjs");
    expect(shim).toBeGreaterThan(at("npm ci --omit=dev"));
    expect(shim).toBeLessThan(at("/run/secrets/setup;"));
  });

  it("写した Node.js が動かなければ、要る共有ライブラリを入れ、それでも動かなければ理由を示して止める（素のイメージ）", () => {
    const dockerfile = read("Dockerfile");
    const lang = dockerfile.slice(
      dockerfile.indexOf("AS base-lang"),
      dockerfile.indexOf("# root では動かさない。元のイメージに node ユーザー"),
    );
    expect(lang).toContain("if ! /opt/sacty-node/bin/node --version >/dev/null 2>&1; then");
    expect(lang).toContain("apt-get install -y --no-install-recommends libatomic1 libstdc++6");
    expect(lang).toContain("dnf install -y libatomic libstdc++");
    expect(lang).toMatch(/元のイメージで動きません[^\n]*\n\s*exit 1;/);
  });

  it("取得物は BuildKit の cache マウントに置き、イメージに npm のキャッシュを残さない", () => {
    const dockerfile = read("Dockerfile");
    for (const script of ["install-tools.sh", "install-security-tools.sh", "install-drawio.sh"]) {
      expect(dockerfile).toContain(
        `--mount=type=cache,id=sacty-build-cache,target=/var/cache/sacty-build,sharing=locked \\\n  /opt/sacty/lib/with-build-cache.sh /opt/sacty/lib/${script}`,
      );
    }
    expect(dockerfile).toContain("NPM_CONFIG_CACHE=/var/cache/sacty-npm");
    expect(dockerfile).toContain(
      "--mount=type=cache,id=sacty-npm-cache,target=/var/cache/sacty-npm",
    );
  });

  it("エージェントの CLI は lockfile のとおりに入れ、lockfile には取得元の URL を書かない（プライベートのレジストリ）", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).not.toMatch(/npm install -g @anthropic-ai|npm install -g @openai/);
    const pkg = JSON.parse(read("agent-cli/package.json"));
    const lock = JSON.parse(read("agent-cli/package-lock.json"));
    // package.json の版と lockfile がそろっている（版を上げたら lockfile も作り直す）
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === "") continue;
      expect(entry).not.toHaveProperty("resolved");
      expect(entry).toHaveProperty("integrity");
    }
  });

  it("draw.io は依存に無い GBM のライブラリも一緒に入れる（PBI-338）", () => {
    const script = read("install-drawio.sh");
    // パッケージの依存に libgbm1 が無く、--no-install-recommends では入らない（無いと本体が起動しない）
    expect(script).toContain(
      'apt-get install -y --no-install-recommends "$dir/$file" xvfb "$alsa" libgbm1 \\',
    );
    expect(script).toContain(
      '$pm install $opts "$dir/$file" xorg-x11-server-Xvfb alsa-lib mesa-libgbm \\',
    );
  });

  it("draw.io の本体が読めない共有ライブラリがあれば、名前を示して警告し、続ける（PBI-338）", () => {
    const script = read("install-drawio.sh");
    const start = script.indexOf("# 本体が読めない共有ライブラリ");
    const block = script.slice(start, script.indexOf("\nfi\n", start) + 4);
    expect(start).toBeGreaterThan(script.indexOf('warn "/opt/drawio/drawio が見つからない"'));
    const dir = mkdtempSync(join(tmpdir(), "sacty-drawio-ldd-"));
    // ldd の出力を差し替えて、警告の部分だけを動かす（終了コード 0 で続くこと・stderr の警告）
    const run = (lddOutput: string) => {
      writeFileSync(join(dir, "ldd"), `#!/bin/sh\nprintf '${lddOutput}'\n`);
      chmodSync(join(dir, "ldd"), 0o755);
      const result = spawnSync("sh", ["-c", `${block}\necho done`], {
        env: { PATH: `${dir}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    try {
      expect(run("\\tlibnss3.so => /usr/lib/libnss3.so (0x1)\\n")).toEqual({
        status: 0,
        stdout: "done\n",
        stderr: "",
      });
      const missing = run("\\tlibgbm.so.1 => not found\\n\\tlibfoo.so.2 => not found\\n");
      expect(missing.status).toBe(0);
      expect(missing.stdout).toBe("done\n");
      expect(missing.stderr).toContain("読めないライブラリがあります（libgbm.so.1 libfoo.so.2）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("古い版のイメージの片付け（PBI-313）", () => {
  it("名前ごとに新しい版から2つ残し、版は数値で比べる", () => {
    expect(
      staleImages(
        [
          "sacty-agent:1.9.1",
          "sacty-agent:1.10.0",
          "sacty-agent:1.18.0",
          "sacty-agent:1.24.0",
          "sacty-agent-java17:1.9.1",
          "sacty-agent-java17:1.10.0",
          "sacty-agent-java17:1.11.0",
        ],
        [],
      ).sort(),
    ).toEqual(["sacty-agent-java17:1.9.1", "sacty-agent:1.10.0", "sacty-agent:1.9.1"]);
  });

  it("版が0・1・2個なら何も消さない", () => {
    expect(staleImages([], [])).toEqual([]);
    expect(staleImages(["sacty-agent:1.0.0"], [])).toEqual([]);
    expect(staleImages(["sacty-agent:1.0.0", "sacty-agent:1.0.1"], [])).toEqual([]);
  });

  it("今回作ったもの・設定が指すものは、古くても残す", () => {
    expect(
      staleImages(
        ["sacty-agent:1.0.0", "sacty-agent:1.1.0", "sacty-agent:1.2.0", "sacty-agent:1.3.0"],
        ["sacty-agent:1.0.0"],
      ),
    ).toEqual(["sacty-agent:1.1.0"]);
  });

  it("版のタグでないもの・sacty の名前でないものは消さない", () => {
    const others = [
      "sacty-agent:latest",
      "sacty-agent:bump-307",
      "sacty-agent:1.18.0-rc1",
      "sacty-agent:<none>",
      "<none>:<none>",
      "",
      "karakuri-id-nest:1.0.0",
      "my-sacty-agent:1.0.0",
      "sacty-agents:1.0.0",
      "ghcr.io/acme/sacty-agent:1.0.0",
      "localhost:5000/sacty-agent:1.0.0",
    ];
    expect(staleImages([...others, ...others], [])).toEqual([]);
    expect(
      staleImages([...others, "sacty-agent:1.0.0", "sacty-agent:1.0.1", "sacty-agent:1.0.2"], []),
    ).toEqual(["sacty-agent:1.0.0"]);
  });

  it("sacty の名前でないイメージは、版がいくつあっても消さない", () => {
    const names = [
      "karakuri-id-nest",
      "my-sacty-agent",
      "sacty-agents",
      "ghcr.io/acme/sacty-agent",
      "localhost:5000/sacty-agent",
    ];
    const listed = names.flatMap((name) => ["1.0.0", "1.0.1", "1.0.2"].map((v) => `${name}:${v}`));
    expect(staleImages(listed, [])).toEqual([]);
  });

  function docker(results: Record<string, { code: number; stdout?: string }>) {
    const calls: string[] = [];
    return {
      calls,
      run: async (args: string[]) => {
        const command = args.join(" ");
        calls.push(command);
        const key = Object.keys(results).find((k) => command.startsWith(k));
        return { code: 0, stdout: "", ...(key ? results[key] : {}) };
      },
    };
  }

  it("古い版を強制せずに消してから、使っていないビルドキャッシュを消す", async () => {
    const { calls, run } = docker({
      "image ls": { code: 0, stdout: "sacty-agent:1.0.0\nsacty-agent:1.0.1\nsacty-agent:1.0.2\n" },
    });
    expect(await pruneOldImages({ kept: ["sacty-agent:1.0.2"], run })).toEqual({
      removed: ["sacty-agent:1.0.0"],
      failed: [],
      listFailed: false,
      cacheFailed: false,
    });
    expect(calls).toEqual([
      "image ls --format {{.Repository}}:{{.Tag}}",
      "image rm sacty-agent:1.0.0",
      "builder prune -f --filter until=168h",
    ]);
  });

  it("1つ消せなくても残りを消し、消せなかったものを返す", async () => {
    const { run } = docker({
      "image ls": {
        code: 0,
        stdout: ["0", "1", "2", "3"].map((n) => `sacty-agent:1.0.${n}`).join("\n"),
      },
      "image rm sacty-agent:1.0.1": { code: 1 },
    });
    expect(await pruneOldImages({ kept: [], run })).toMatchObject({
      removed: ["sacty-agent:1.0.0"],
      failed: ["sacty-agent:1.0.1"],
    });
  });

  it("一覧やキャッシュの片付けに失敗しても例外にしない", async () => {
    const stdout = ["0", "1", "2"].map((n) => `sacty-agent:1.0.${n}`).join("\n");
    const { calls, run } = docker({
      "image ls": { code: 1, stdout },
      "builder prune": { code: 1 },
    });
    expect(await pruneOldImages({ kept: [], run })).toEqual({
      removed: [],
      failed: [],
      listFailed: true,
      cacheFailed: true,
    });
    expect(calls.some((call) => call.startsWith("image rm"))).toBe(false);
  });
});
