// docs の図（SVG）とスクリーンショット（PNG）を確かめる。
// - 図は scripts/docs-diagrams の定義から作ったものと一致すること（直したら npm run docs:diagrams で作り直す）
// - 画像は日本語の版（x.svg・x.png）と英語の版（x.en.svg・x.en.png）がそろうこと
// - どの画像も、どれかのページから使われていること
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIAGRAMS } from "../../scripts/docs-diagrams/diagrams/index.mjs";
import { LANGS, outputPaths, render } from "../../scripts/docs-diagrams/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = join(ROOT, "docs");
const IMAGE_DIRS = ["spec/images", "user/images"];

function images(): string[] {
  return IMAGE_DIRS.flatMap((dir) =>
    existsSync(join(DOCS, dir)) ? readdirSync(join(DOCS, dir)).map((name) => `${dir}/${name}`) : [],
  );
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("docs の図とスクリーンショット", () => {
  it("図の SVG が、定義から作ったものと一致する", () => {
    const stale: string[] = [];
    for (const def of DIAGRAMS) {
      for (const lang of LANGS) {
        const { svg } = render(def, lang);
        for (const path of outputPaths(def, lang)) {
          const full = join(DOCS, path);
          if (!existsSync(full) || readFileSync(full, "utf8") !== svg) stale.push(path);
        }
      }
    }
    expect(stale, "npm run docs:diagrams で作り直してください").toEqual([]);
  });

  it("図の名前が重ならない", () => {
    const names = DIAGRAMS.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("画像は SVG か PNG で、日本語の版と英語の版がそろう", () => {
    const all = new Set(images());
    const errors: string[] = [];
    for (const path of all) {
      if (!/\.(svg|png)$/.test(path)) {
        errors.push(`${path}: SVG・PNG ではない`);
        continue;
      }
      const other = path.includes(".en.")
        ? path.replace(/\.en\.(svg|png)$/, ".$1")
        : path.replace(/\.(svg|png)$/, ".en.$1");
      if (!all.has(other)) errors.push(`${path}: ${other} が無い`);
    }
    expect(errors).toEqual([]);
  });

  it("どの画像も、どれかのページから使われている", () => {
    const used = new Set<string>();
    for (const file of markdownFiles(DOCS)) {
      for (const m of readFileSync(file, "utf8").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        used.add(relative(DOCS, resolve(dirname(file), m[1] ?? "")));
      }
    }
    expect(images().filter((path) => !used.has(path))).toEqual([]);
  });
});
