import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { finalizeRuntime } = require("../../apps/desktop/packaging.cjs");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sacty-package-test-"));
  temporary.push(root);
  const stage = join(root, "stage");
  const output = join(root, "output/runtime");
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write(join(stage, "package.json"), "{}");
  write(
    join(stage, "apps/daemon/package.json"),
    JSON.stringify({ name: "@sacty/daemon", exports: { "./config": "./dist/config.cjs" } }),
  );
  write(
    join(stage, "apps/daemon/dist/config.cjs"),
    'module.exports = require("node:path").resolve(__dirname,"../../../config/agents.yaml");',
  );
  write(join(stage, "config/agents.yaml"), "agents: {}\n");
  mkdirSync(join(stage, "node_modules/@sacty"), { recursive: true });
  mkdirSync(join(stage, "node_modules/.bin"), { recursive: true });
  symlinkSync("../../apps/daemon", join(stage, "node_modules/@sacty/daemon"));
  symlinkSync("../@sacty/daemon/dist/config.cjs", join(stage, "node_modules/.bin/example"));
  cpSync(stage, output, { recursive: true });
  return { root, stage, output };
}

describe("desktop package relocation", () => {
  it("resolves only bundled modules and defaults after staging is deleted and the app is moved", () => {
    const { root, stage, output } = fixture();
    expect(isAbsolute(readlinkSync(join(output, "node_modules/@sacty/daemon")))).toBe(true);
    finalizeRuntime(output, stage);
    rmSync(stage, { recursive: true });
    const moved = join(root, "moved/runtime");
    cpSync(output, moved, { recursive: true, verbatimSymlinks: true });
    rmSync(dirname(output), { recursive: true });
    const localRequire = createRequire(join(moved, "package.json"));
    const module = localRequire.resolve("@sacty/daemon/config");
    expect(module).toBe(join(realpathSync(moved), "apps/daemon/dist/config.cjs"));
    const defaults = localRequire("@sacty/daemon/config");
    expect(defaults).toBe(join(realpathSync(moved), "config/agents.yaml"));
    expect(existsSync(defaults)).toBe(true);
    expect(existsSync(join(moved, "node_modules/.bin/example"))).toBe(true);
    expect(isAbsolute(readlinkSync(join(moved, "node_modules/@sacty/daemon")))).toBe(false);
  });

  it("rejects a package missing the required default configuration", () => {
    const { stage, output } = fixture();
    rmSync(join(output, "config/agents.yaml"));
    expect(() => finalizeRuntime(output, stage)).toThrow("既定エージェント");
  });

  it("rejects links that depend on files outside the bundled runtime", () => {
    const { stage, output } = fixture();
    symlinkSync("/usr/bin", join(output, "outside"));
    expect(() => finalizeRuntime(output, stage)).toThrow("同梱範囲外");
  });
});
