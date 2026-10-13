import { existsSync, readFileSync, statSync } from "node:fs";
import { message } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildImage,
  imageBuildArgs,
  imageBuildSettings,
  npmGlobalConfigContent,
  npmrcContent,
} from "./image.js";
import { MemorySecretStore, SecretNotFoundError } from "./secrets.js";

describe("イメージの作成（PBI-33）", () => {
  it("設定ファイルが無ければ既定で作り、設定ファイルに誤りがあれば既定に戻さずに止める（レビュー指摘）", () => {
    expect(
      imageBuildSettings({ ok: false, problem: message("config.missing", { path: "/x" }) }),
    ).toEqual({ ok: true, image: "sacty-agent:0.1.0", build: {} });
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
        image: "registry.example.com/sacty-agent:0.1.0",
        dockerDir: "/pkg/docker",
        baseImage: "registry.example.com/library/node:22",
        npmrcPath: "/tmp/x/npmrc",
        npmVersion: "11",
        npmConfigPath: "/tmp/x/npmconfig",
        npmConfigHash: "abc123",
      }),
    ).toEqual([
      "build",
      "-t",
      "registry.example.com/sacty-agent:0.1.0",
      "--build-arg",
      "BASE_IMAGE=registry.example.com/library/node:22",
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
      "/pkg/docker",
    ]);
    // 書かなければ、Dockerfile の既定（Docker Hub の node・その npm）のまま
    expect(
      imageBuildArgs({
        image: "sacty-agent:0.1.0",
        dockerDir: "/d",
        npmrcPath: "/n",
        npmConfigPath: "/c",
        npmConfigHash: "h",
      }),
    ).not.toContain("BASE_IMAGE=");
  });

  it("トークンはビルドの引数に出さず、作った一時ファイル（本人だけが読める）は終わったら消す", async () => {
    const seen: { args: string[]; npmrc: string; mode: number; path: string }[] = [];
    const failure = await buildImage({
      image: "sacty-agent:0.1.0",
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
      image: "sacty-agent:0.1.0",
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
        image: "sacty-agent:0.1.0",
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

  it("失敗したら確かめることを返し、一時ファイルは消す。トークンが無ければ作らずに止める", async () => {
    let path = "";
    const failure = await buildImage({
      image: "sacty-agent:0.1.0",
      build: { baseImage: "registry.example.com/library/node:22" },
      dockerDir: "/d",
      secrets: new MemorySecretStore({}),
      run: async (args) => {
        path = (args.find((a) => a.startsWith("id=npmrc,src=")) ?? "").slice(13);
        return 1;
      },
    });
    expect(failure).toContain("元のイメージ（registry.example.com/library/node:22）を取得できるか");
    expect(failure).toContain("npm のレジストリ（https://registry.npmjs.org/）に届くか");
    expect(existsSync(path)).toBe(false);

    let ran = false;
    await expect(
      buildImage({
        image: "sacty-agent:0.1.0",
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
});
