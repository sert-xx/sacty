import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { packager } from "@electron/packager";

const root = fileURLToPath(new URL("../../../", import.meta.url));
if (process.platform !== "darwin")
  throw new Error("現在は macOS の同一アーキテクチャのビルドだけに対応しています。");
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 26 || (major === 26 && (minor < 12 || (minor === 12 && patch < 1))))
  throw new Error("Node.js 26.12.1 以上で実行してください。");
const require = createRequire(import.meta.url);
const { finalizeRuntime } = require("../packaging.cjs");
const { DEFAULT_IMAGE } = require(join(root, "apps/daemon/dist/config.js"));
const temporary = mkdtempSync(join(tmpdir(), "sacty-desktop-"));
const runtime = join(temporary, "runtime");
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} が失敗しました。`);
};

try {
  for (const path of [
    "package.json",
    "package-lock.json",
    "LICENSE",
    "config/agents.yaml",
    "packages/core",
    "apps/daemon",
    "apps/web",
    "packages/cli",
  ]) {
    cpSync(join(root, path), join(runtime, path), {
      recursive: true,
      filter: (source) =>
        !/(^|\/)(node_modules|\.next|src|\.sacty|\.git)(\/|$)/.test(relative(root, source)) &&
        ![".npmrc", ".DS_Store"].includes(basename(source)) &&
        !basename(source).startsWith(".env"),
    });
  }
  cpSync(join(root, "apps/desktop/config-tool.mjs"), join(runtime, "desktop/config-tool.mjs"));
  const config = JSON.parse(
    readFileSync(join(root, "apps/web/.next/required-server-files.json"), "utf8"),
  ).config;
  cpSync(join(root, "apps/web/.next"), join(runtime, "apps/web/.next"), {
    recursive: true,
    filter: (source) => !/(^|\/)cache(\/|$)/.test(relative(join(root, "apps/web/.next"), source)),
  });
  for (const file of ["next.config.ts", "next.config.js", "next.config.mjs"])
    rmSync(join(runtime, "apps/web", file), { force: true });
  writeFileSync(
    join(runtime, "apps/web/next.config.mjs"),
    `export default ${JSON.stringify(config)};\n`,
  );
  if (existsSync(join(root, "apps/web/public")))
    cpSync(join(root, "apps/web/public"), join(runtime, "apps/web/public"), { recursive: true });
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], runtime);
  mkdirSync(join(runtime, "bin"), { recursive: true });
  cpSync(process.execPath, join(runtime, "bin/node"));
  // Preserve Node's license alongside its redistributed executable.
  const nodeLicense = join(process.execPath, "../../LICENSE");
  if (!existsSync(nodeLicense)) throw new Error("Node.js の LICENSE が見つかりません。");
  cpSync(nodeLicense, join(runtime, "NODE-LICENSE"));
  const image = spawnSync(
    "docker",
    ["image", "inspect", DEFAULT_IMAGE, "--format", "{{.Architecture}}"],
    { encoding: "utf8" },
  );
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  if (image.status !== 0 || image.stdout.trim() !== architecture)
    throw new Error(`同じ CPU 向けの ${DEFAULT_IMAGE} を先にビルドしてください。`);
  console.log(`イメージ ${DEFAULT_IMAGE} を同梱しています…`);
  const save = spawn("docker", ["image", "save", DEFAULT_IMAGE], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const completed = new Promise((resolve, reject) => {
    save.once("error", reject);
    save.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("イメージの書き出しに失敗しました。")),
    );
  });
  await Promise.all([
    pipeline(
      save.stdout,
      createGzip({ level: 1 }),
      createWriteStream(join(runtime, "agent-image.tar.gz")),
    ),
    completed,
  ]);
  writeFileSync(
    join(runtime, "desktop-manifest.json"),
    JSON.stringify({ image: DEFAULT_IMAGE, architecture, node: process.versions.node }, null, 2),
  );
  const output = process.env.SACTY_DESKTOP_OUT || join(root, "dist/desktop");
  const result = await packager({
    dir: join(root, "apps/desktop"),
    name: "sacty",
    appBundleId: "io.sacty.desktop.preview",
    appVersion: require(join(root, "packages/cli/package.json")).version,
    platform: "darwin",
    arch: process.arch,
    out: output,
    overwrite: true,
    asar: true,
    prune: false,
    extraResource: [runtime],
    electronVersion: require("electron/package.json").version,
    osxSign: false,
  });
  for (const directory of result) {
    finalizeRuntime(join(directory, "sacty.app/Contents/Resources/runtime"), runtime);
  }
  console.log(result.join("\n"));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
