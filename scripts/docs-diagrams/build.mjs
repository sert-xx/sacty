// docs の図（SVG）を、定義（diagrams/）から作り直す。
//   node scripts/docs-diagrams/build.mjs          作り直して書き出す
//   node scripts/docs-diagrams/build.mjs --check  書き出さずに、ファイルが定義と一致するかだけを確かめる
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIAGRAMS } from "./diagrams/index.mjs";
import { LANGS, outputPaths, render } from "./lib.mjs";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
const check = process.argv.includes("--check");
let stale = 0;
let warnings = 0;

for (const def of DIAGRAMS) {
  for (const lang of LANGS) {
    const { svg, warnings: found } = render(def, lang);
    for (const w of found) console.warn(`warning: ${w}`);
    warnings += found.length;
    for (const path of outputPaths(def, lang)) {
      const full = join(DOCS, path);
      let current = "";
      try {
        current = readFileSync(full, "utf8");
      } catch {}
      if (current === svg) continue;
      if (check) {
        console.error(`stale: docs/${path}`);
        stale++;
      } else {
        writeFileSync(full, svg);
        console.log(`wrote docs/${path}`);
      }
    }
  }
}
if (warnings) console.warn(`${warnings} warning(s)`);
if (stale) {
  console.error("npm run docs:diagrams で作り直してください");
  process.exit(1);
}
