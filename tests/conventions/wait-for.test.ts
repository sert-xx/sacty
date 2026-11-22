import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
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
    const source = parse(readFileSync(path, "utf8"), {
      sourceType: "unambiguous",
      plugins: ["typescript"],
    });
    const found: string[] = [];
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const node = value as {
        type?: string;
        callee?: {
          type: string;
          object?: { type: string; name?: string };
          property?: { type: string; name?: string; value?: string };
          computed?: boolean;
        };
        loc?: { start: { line: number } };
      };
      if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
        const target = node.callee;
        if (
          target?.object &&
          target.property &&
          node.loc &&
          (target.type === "MemberExpression" || target.type === "OptionalMemberExpression") &&
          target.object.type === "Identifier" &&
          target.object.name === "vi" &&
          ((!target.computed &&
            target.property.type === "Identifier" &&
            target.property.name === "waitFor") ||
            (target.computed &&
              target.property.type === "StringLiteral" &&
              target.property.value === "waitFor"))
        )
          found.push(`${name}:${node.loc.start.line}`);
      }
      for (const child of Object.values(node)) visit(child);
    }
    visit(source);
    return found;
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
    writeFileSync(
      path,
      `// vi.waitFor(() => {})
const example = "vi.waitFor(() => {})";
vi
  /* comment */ .waitFor
  (() => {});
(vi).waitFor(() => {});
vi["waitFor"](() => {});
vi?.waitFor?.(() => {});
other.waitFor(() => {});
`,
    );
    expect(violations(dir, files(dir))).toEqual([
      "sample.test.ts:3",
      "sample.test.ts:6",
      "sample.test.ts:7",
      "sample.test.ts:8",
    ]);
    writeFileSync(path, "// test\n");
    expect(violations(dir, files(dir))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
