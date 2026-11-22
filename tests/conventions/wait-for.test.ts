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
      type Node = {
        type?: string;
        name?: string;
        value?: string;
        expression?: Node;
        callee?: Node;
        object?: Node;
        property?: Node;
        computed?: boolean;
        operator?: string;
        left?: Node;
        right?: Node;
        quasis?: { value: { cooked: string | null } }[];
        expressions?: Node[];
        loc?: { start: { line: number } };
      };
      function unwrap(node: Node | undefined): Node | undefined {
        while (
          node &&
          [
            "TSAsExpression",
            "TSTypeAssertion",
            "TSNonNullExpression",
            "TSSatisfiesExpression",
            "TSInstantiationExpression",
            "ParenthesizedExpression",
          ].includes(node.type ?? "")
        )
          node = node.expression;
        return node;
      }
      function staticString(value: Node | undefined): string | undefined {
        const node = unwrap(value);
        if (node?.type === "StringLiteral") return node.value;
        if (node?.type === "TemplateLiteral" && node.expressions?.length === 0)
          return node.quasis?.[0]?.value.cooked ?? undefined;
        if (node?.type === "BinaryExpression" && node.operator === "+") {
          const left = staticString(node.left);
          const right = staticString(node.right);
          if (left !== undefined && right !== undefined) return left + right;
        }
        return undefined;
      }
      const node = value as Node;
      if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
        const target = unwrap(node.callee);
        const object = unwrap(target?.object);
        const property = unwrap(target?.property);
        const key = staticString(property);
        if (
          (target?.type === "MemberExpression" || target?.type === "OptionalMemberExpression") &&
          object?.type === "Identifier" &&
          object.name === "vi" &&
          node.loc &&
          ((!target.computed && property?.type === "Identifier" && property.name === "waitFor") ||
            (target.computed && key === "waitFor"))
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

it("型式と静的なキーを組み合わせた直接呼び出しを検出する", () => {
  const dir = mkdtempSync(join(tmpdir(), "wait-check-"));
  try {
    const path = join(dir, "sample.test.ts");
    const objects = [
      "vi",
      "(vi as typeof vi)",
      "vi!",
      "(vi satisfies typeof vi)",
      "(<typeof vi>vi)",
    ];
    const keys = [
      ".waitFor",
      '["waitFor"]',
      "[`waitFor`]",
      '["wait" + "For"]',
      '[("waitFor" as const)]',
    ];
    const calls = objects.flatMap((object) => keys.map((key) => `${object}${key}(() => {});`));
    writeFileSync(
      path,
      [...calls, 'other["waitFor"](() => {});', `vi[\`wait\${suffix}\`](() => {});`].join("\n"),
    );
    expect(violations(dir, files(dir))).toEqual(
      calls.map((_, index) => `sample.test.ts:${index + 1}`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
