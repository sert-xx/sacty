import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
function violations(base: string, paths: string[]): string[] {
  return paths.flatMap((path) => {
    const name = relative(base, path);
    if (name === "apps/daemon/src/testing/wait.ts" || name === "tests/conventions/wait-for.test.ts")
      return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        /\bvi\s*\.\s*waitFor\s*\(/.test(line) ? [`${name}:${index + 1}`] : [],
      );
  });
}
it("vi.waitFor を直接呼ばない", () => {
  expect(
    violations(
      root,
      ["apps", "packages", "tests"].flatMap((dir) => files(join(root, dir))),
    ),
  ).toEqual([]);
});
it("直接呼び出しのファイルと行を見つけ、除くと通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "wait-check-"));
  try {
    const path = join(dir, "sample.test.ts");
    writeFileSync(path, "// test\nvi.waitFor(() => {});\n");
    expect(violations(dir, files(dir))).toEqual(["sample.test.ts:2"]);
    writeFileSync(path, "// test\n");
    expect(violations(dir, files(dir))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
