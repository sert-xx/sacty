import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_IMAGE, loadConfig, resolveHome } from "@sacty/daemon/config";
import { imageBuildSettings } from "@sacty/daemon/image";
import { parseDocument } from "yaml";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export function standardImageUpgrade(from, to) {
  const pattern = /^sacty-agent:(\d+)\.(\d+)\.(\d+)$/;
  const a = pattern.exec(from);
  const b = pattern.exec(to);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  }
  return false;
}

export function inspectSettings(home = resolveHome()) {
  const config = loadConfig(home);
  if (!config.ok) throw new Error("configFailed");
  if (!config.config.webAuth) throw new Error("authRequired");
  const settings = imageBuildSettings(config);
  if (!settings.ok) throw new Error("configFailed");
  const original = readFileSync(join(home, "config.yaml"), "utf8");
  return {
    images: [settings.image, ...Object.values(settings.images).map((image) => image.image)],
    migration: standardImageUpgrade(settings.image, DEFAULT_IMAGE)
      ? { from: settings.image, to: DEFAULT_IMAGE, snapshot: digest(original) }
      : undefined,
  };
}

export function migrateSettings(snapshot, home = resolveHome()) {
  const path = join(home, "config.yaml");
  const original = readFileSync(path, "utf8");
  const state = inspectSettings(home);
  if (digest(original) !== snapshot || state.migration?.snapshot !== snapshot)
    throw new Error("configChanged");
  const document = parseDocument(original);
  if (document.errors.length) throw new Error("configFailed");
  document.set("image", state.migration.to);
  const suffix = randomUUID();
  const backup = join(home, `config.yaml.desktop-backup-${suffix}`);
  const temporary = join(home, `.config-${suffix}.tmp`);
  try {
    writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
    writeFileSync(temporary, document.toString(), { mode: 0o600, flag: "wx" });
    if (digest(readFileSync(path, "utf8")) !== snapshot) throw new Error("configChanged");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return inspectSettings(home);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result =
      process.argv[2] === "migrate" ? migrateSettings(process.argv[3]) : inspectSettings();
    console.log(JSON.stringify(result));
  } catch (error) {
    const known = ["configFailed", "authRequired", "configChanged"];
    console.error(known.includes(error.message) ? error.message : "updateFailed");
    process.exitCode = 1;
  }
}
