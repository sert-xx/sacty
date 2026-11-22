import { describe, expect, it } from "vitest";
import { formattingOnly } from "./formatting-only.js";

describe("formattingOnly", () => {
  it("compares long sequences of comments around trailing commas", () => {
    const comments = "// comment\n".repeat(20000);
    expect(formattingOnly("a.js", `f(a,${comments});`, `f( a ${comments});`)).toBe(true);
    expect(formattingOnly("a.js", `f(a,${comments}b);`, `f(a ${comments}b);`)).toBe(false);
  });
  it.each([
    ["a.ts", "const x = { a: 1, b: 2 };", "const x = {\n  a: 1,\n  b: 2,\n};"],
    ["a.tsx", "const x = <A p={1} />;", "const x = <A\n  p={1}\n/>;"],
    ["a.js", "f(a, b);", "f(\n  a,\n  b,\n);"],
    ["a.json", '{"a":1}', '{\n  "a": 1\n}'],
  ])("recognizes formatting in %s", (path, before, after) => {
    expect(formattingOnly(path, before, after)).toBe(true);
  });

  it.each([
    ["a.ts", 'const x = "New York";', 'const x = "NewYork";'],
    ["a.js", "function f(){return x}", "function f(){return\nx}"],
    ["a.tsx", "const x = <p>hello world</p>;", "const x = <p>helloworld</p>;"],
    ["a.js", "const x = `a\nb`;", "const x = `ab`;"],
    ["a.js", "const x = /a b/;", "const x = /ab/;"],
    ["a.js", "const x = [a,,b];", "const x = [a,b];"],
    ["a.js", "// one\nf();", "// two\nf();"],
    ["a.js", "const x = 'a';", 'const x = "a";'],
    ["a.js", "const x = 1;", "const x = 1"],
    ["a.js", "const x = (a);", "const x = a;"],
    ["a.json", '{"a":1}', '{"a":1,}'],
    ["a.jsonc", '{"a":1}', '{ "a": 1 }'],
    ["a.py", "x=1", "x = 1"],
    ["a.ts", "const x = ;", "const x=;"],
    ["a.ts", "\0a", "\0 a"],
  ])("preserves changes that cannot safely be classified in %s", (path, before, after) => {
    expect(formattingOnly(path, before, after)).toBe(false);
  });
});
