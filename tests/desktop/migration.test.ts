import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_TEMPLATE, DEFAULT_IMAGE } from "@sacty/daemon/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import {
  inspectSettings,
  migrateSettings,
  standardImageUpgrade,
} from "../../apps/desktop/config-tool.mjs";

const require = createRequire(import.meta.url);
const { prepare } = require("../../apps/desktop/runtime.cjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(image = "sacty-agent:1.0.0", available = false, loadFails = false) {
  const home = mkdtempSync(join(tmpdir(), "sacty-migration-test-"));
  dirs.push(home);
  const document = parseDocument(CONFIG_TEMPLATE);
  document.set("image", image);
  document.set("image_build", { drawio: false });
  document.commentBefore = " retained comment";
  const path = join(home, "config.yaml");
  const original = document.toString();
  writeFileSync(path, original);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "calls");
  const loaded = join(home, "loaded");
  const archive = join(home, "agent-image.tar.gz");
  writeFileSync(archive, "fixture");
  const manifest = join(home, "desktop-manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      image: DEFAULT_IMAGE,
      architecture: process.arch === "arm64" ? "arm64" : "amd64",
    }),
  );
  const command = (name: string, source: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${source}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  command("gh", "exit 0");
  command(
    "docker",
    `printf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = info ]; then exit 0; fi\nif [ "$2" = load ]; then ${loadFails ? "exit 1" : `touch '${loaded}'; exit 0`}; fi\nif [ "$2" = inspect ]; then ${available ? "exit 0" : `[ -f '${loaded}' ]; exit $?`}; fi\nexit 1`,
  );
  const paths = {
    root: resolve("."),
    node: process.execPath,
    cli: resolve("packages/cli/bin/sacty.js"),
    configTool: resolve("apps/desktop/config-tool.mjs"),
    imageArchive: archive,
    imageManifest: manifest,
    env: { ...process.env, SACTY_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  };
  return { home, path, original, calls, loaded, paths };
}

describe("standard image upgrades", () => {
  it.each([
    "custom:1.0.0",
    "registry.example.com/sacty-agent:1.0.0",
    "sacty-agent:latest",
    "sacty-agent:99.0.0",
    DEFAULT_IMAGE,
  ])("does not migrate a custom, current, or future image: %s", (image) => {
    expect(standardImageUpgrade(image, DEFAULT_IMAGE)).toBe(false);
  });
  it("backs up the original and preserves comments and other settings", () => {
    const f = fixture();
    const state = inspectSettings(f.home);
    migrateSettings(state.migration.snapshot, f.home);
    const updated = readFileSync(f.path, "utf8");
    expect(updated).toContain(DEFAULT_IMAGE);
    expect(updated).toContain("retained comment");
    expect(parseDocument(updated).getIn(["image_build", "drawio"])).toBe(false);
    const backup = readdirSync(f.home).find((name) =>
      name.startsWith("config.yaml.desktop-backup-"),
    );
    expect(backup).toBeTruthy();
    expect(readFileSync(join(f.home, backup ?? ""), "utf8")).toBe(f.original);
    expect(statSync(join(f.home, backup ?? "")).mode & 0o777).toBe(0o600);
  });
  it.each(["image", "description"])(
    "rejects a shared image anchor used by a custom %s before writing files",
    (field) => {
      const f = fixture();
      const original =
        f.original.replace("image: sacty-agent:1.0.0", "image: &shared sacty-agent:1.0.0") +
        `\nimages:\n  custom:\n    base_image: node:26\n    description: ${field === "description" ? "*shared" : "Custom"}\n    image: ${field === "image" ? "*shared" : "custom:1.0.0"}\n`;
      writeFileSync(f.path, original);
      const state = inspectSettings(f.home);
      expect(state.migration).toBeDefined();
      const files = readdirSync(f.home).sort();
      expect(() => migrateSettings(state.migration.snapshot, f.home)).toThrow("configSharedImage");
      expect(readFileSync(f.path, "utf8")).toBe(original);
      expect(readdirSync(f.home).sort()).toEqual(files);
    },
  );
  it("reports a shared-anchor migration error through the runtime without changing settings", async () => {
    const f = fixture("sacty-agent:1.0.0", true);
    const original =
      f.original.replace("image: sacty-agent:1.0.0", "image: &shared sacty-agent:1.0.0") +
      "\nimages:\n  custom:\n    base_image: node:26\n    description: Custom\n    image: *shared\n";
    writeFileSync(f.path, original);
    const files = readdirSync(f.home).sort();
    await expect(
      prepare(f.paths, () => {}, undefined, { confirmMigration: async () => true }),
    ).rejects.toThrow("参照が共有");
    expect(readFileSync(f.path, "utf8")).toBe(original);
    // Only the fake Docker call log is created; migration must not create files.
    expect(
      readdirSync(f.home)
        .filter((name) => name !== "calls")
        .sort(),
    ).toEqual(files);
  });
  it("can migrate an unshared anchored image", () => {
    const f = fixture();
    const original = f.original.replace(
      "image: sacty-agent:1.0.0",
      "image: &shared sacty-agent:1.0.0",
    );
    writeFileSync(f.path, original);
    migrateSettings(inspectSettings(f.home).migration.snapshot, f.home);
    expect(inspectSettings(f.home).images[0]).toBe(DEFAULT_IMAGE);
    expect(readFileSync(f.path, "utf8")).toContain("&shared");
  });
  it("can replace an image alias without changing its anchor elsewhere", () => {
    const f = fixture();
    const original =
      "images:\n  custom:\n    base_image: node:26\n    description: Custom\n    image: &shared sacty-agent:1.0.0\n" +
      f.original.replace("image: sacty-agent:1.0.0", "image: *shared");
    writeFileSync(f.path, original);
    const before = parseDocument(original).toJS();
    migrateSettings(inspectSettings(f.home).migration.snapshot, f.home);
    expect(parseDocument(readFileSync(f.path, "utf8")).toJS()).toEqual({
      ...before,
      image: DEFAULT_IMAGE,
    });
  });
  it("does not overwrite configuration edited after confirmation", () => {
    const f = fixture();
    const state = inspectSettings(f.home);
    const edited = `${f.original}\n# concurrent edit\n`;
    writeFileSync(f.path, edited);
    expect(() => migrateSettings(state.migration.snapshot, f.home)).toThrow("configChanged");
    expect(readFileSync(f.path, "utf8")).toBe(edited);
  });
  it("imports the current image before migrating an old configuration", async () => {
    const f = fixture();
    const confirm = vi.fn().mockResolvedValue(true);
    await prepare(f.paths, () => {}, undefined, { confirmMigration: confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(existsSync(f.loaded)).toBe(true);
    expect(readFileSync(f.calls, "utf8")).toContain(`image inspect ${DEFAULT_IMAGE}`);
    expect(readFileSync(f.calls, "utf8")).not.toContain("image inspect sacty-agent:1.0.0");
    expect(inspectSettings(f.home).migration).toBeUndefined();
  });
  it("migrates even when the old image still exists", async () => {
    const f = fixture("sacty-agent:1.0.0", true);
    await prepare(f.paths, () => {}, undefined, { confirmMigration: async () => true });
    expect(inspectSettings(f.home).images[0]).toBe(DEFAULT_IMAGE);
    expect(existsSync(f.loaded)).toBe(false);
  });
  it("does not change or load anything when the user cancels", async () => {
    const f = fixture();
    await expect(
      prepare(f.paths, () => {}, undefined, { confirmMigration: async () => false }),
    ).rejects.toThrow("取り消し");
    expect(readFileSync(f.path, "utf8")).toBe(f.original);
    expect(existsSync(f.loaded)).toBe(false);
  });
  it("leaves settings untouched when image import fails", async () => {
    const f = fixture("sacty-agent:1.0.0", false, true);
    await expect(
      prepare(f.paths, () => {}, undefined, { confirmMigration: async () => true }),
    ).rejects.toThrow("読み込めません");
    expect(readFileSync(f.path, "utf8")).toBe(f.original);
    expect(readdirSync(f.home).some((name) => name.startsWith("config.yaml.desktop-backup-"))).toBe(
      false,
    );
  });
  it("never imports the standard archive for a missing custom image", async () => {
    const f = fixture("custom:missing");
    await expect(prepare(f.paths, () => {}, undefined)).rejects.toThrow("custom:missing");
    expect(readFileSync(f.calls, "utf8")).not.toContain("image load");
    expect(existsSync(f.loaded)).toBe(false);
  });
  it("leaves an existing standard tag untouched when only a language image is missing", async () => {
    const f = fixture(DEFAULT_IMAGE, true);
    const document = parseDocument(f.original);
    document.set("images", {
      custom: { base_image: "node:26", description: "Custom", image: "custom:missing" },
    });
    writeFileSync(f.path, document.toString());
    const docker = join(f.home, "bin/docker");
    writeFileSync(
      docker,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${f.calls}'\nif [ "$1" = info ]; then exit 0; fi\nif [ "$2" = inspect ] && [ "$3" = '${DEFAULT_IMAGE}' ]; then exit 0; fi\nif [ "$2" = load ]; then touch '${f.loaded}'; exit 0; fi\nexit 1\n`,
    );
    await expect(prepare(f.paths, () => {}, undefined)).rejects.toThrow("custom:missing");
    expect(readFileSync(f.calls, "utf8")).not.toContain("image load");
    expect(existsSync(f.loaded)).toBe(false);
  });
  it("does not load an archive with no matching manifest", async () => {
    const f = fixture(DEFAULT_IMAGE);
    rmSync(f.paths.imageManifest);
    await expect(prepare(f.paths, () => {}, undefined)).rejects.toThrow(DEFAULT_IMAGE);
    expect(existsSync(f.loaded)).toBe(false);
  });
  it.each(["docker", "gh"])(
    "reports %s failure without changing settings and permits retry",
    async (command) => {
      const f = fixture(DEFAULT_IMAGE, true);
      const path = join(f.home, "bin", command);
      const original = readFileSync(path, "utf8");
      writeFileSync(path, "#!/bin/sh\nexit 1\n");
      await expect(prepare(f.paths, () => {}, undefined, { locale: "en" })).rejects.toThrow(
        command === "docker" ? "Docker" : "GitHub",
      );
      expect(readFileSync(f.path, "utf8")).toBe(f.original);
      writeFileSync(path, original);
      await expect(prepare(f.paths, () => {}, undefined)).resolves.toBeUndefined();
    },
  );
  it("preserves a custom image and never asks to migrate it", async () => {
    const f = fixture("custom:1.0.0", true);
    const confirm = vi.fn();
    await prepare(f.paths, () => {}, undefined, { confirmMigration: confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(f.path, "utf8")).toBe(f.original);
  });
});
