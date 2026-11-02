// 生成物が openapi/library.yaml から作り直した結果と一致するかを確かめる（一致しなければ exit 1）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "library-api-"));
const targets = [
  [
    "src/generated/schema.d.ts",
    (out) => ["node_modules/.bin/openapi-typescript", ["openapi/library.yaml", "-o", out]],
  ],
  ["docs/api-reference.md", (out) => ["node", ["scripts/generate-docs.mjs", out]]],
];

let drift = false;
for (const [file, command] of targets) {
  const out = join(tmp, file.replaceAll("/", "_"));
  const [bin, args] = command(out);
  execFileSync(bin, args, { cwd: root, stdio: "pipe" });
  if (readFileSync(out, "utf8") !== readFileSync(join(root, file), "utf8")) {
    console.error(
      `${file} は openapi/library.yaml から作り直した結果と違います。npm run generate を実行してください。`,
    );
    drift = true;
  }
}
rmSync(tmp, { recursive: true, force: true });
if (drift) process.exit(1);
console.log("生成物は定義と一致しています。");
