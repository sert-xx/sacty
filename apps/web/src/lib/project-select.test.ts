import type { Project } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { isProjectId, needsProjectSelect, resolveProject, safeLocalPath } from "./project-select";

const project = (id: string): Project => ({
  id,
  name: id,
  targets: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

describe("表示するプロジェクトの切り替え（PBI-4a）", () => {
  it("cookie のプロジェクトを表示し、無い・無くなっていれば最初のプロジェクトにする（PBI-22）", () => {
    // 「default」という ID のプロジェクトがあっても、特別扱いしない
    const projects = [project("p0"), project("default"), project("p1")];
    expect(resolveProject(projects, "p1")?.id).toBe("p1");
    expect(resolveProject(projects, "deleted")?.id).toBe("p0");
    expect(resolveProject(projects, "")?.id).toBe("p0");
    expect(resolveProject([project("p1")], "x")?.id).toBe("p1");
    expect(resolveProject([], "x")).toBeUndefined();
  });

  it("切り替えの後の移動先は、画面の中のパスだけを、正規化して受け付ける（レビュー指摘）", () => {
    expect(safeLocalPath("/tasks/1/review")).toBe("/tasks/1/review");
    expect(safeLocalPath("/tasks/1#proposals")).toBe("/tasks/1#proposals");
    expect(safeLocalPath("/tasks/../projects?x=1")).toBe("/projects?x=1");
    for (const bad of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/\t/evil.example/", // タブはブラウザが取り除くので「//evil.example/」になる
      "/\n/evil.example/",
      "/\r/evil.example/",
      "/a/..//evil.example/", // 正規化すると「//evil.example/」になる（レビュー指摘）
      "/%2e//evil.example/",
      "/./..//evil.example/x?y#z",
      "tasks",
      "",
    ]) {
      expect(safeLocalPath(bad), bad).toBeUndefined();
    }
    // ブラウザと同じ解釈で、外部のホストに解決されないこと
    expect(new URL(decodeURIComponent("%2F%09%2Fevil.example%2F"), "http://localhost").host).toBe(
      "evil.example",
    );
    expect(safeLocalPath(decodeURIComponent("%2F%09%2Fevil.example%2F"))).toBeUndefined();
  });
});

describe("開いた画面のプロジェクトに合わせる（PBI-98）", () => {
  it("cookie のプロジェクトと画面のプロジェクトが違うときだけ合わせる", () => {
    expect(needsProjectSelect("p-a", "p-a")).toBe(false);
    expect(needsProjectSelect("p-a", "p-b")).toBe(true);
    // cookie が無い・無くなったプロジェクトのときも、開いたプロジェクトにしておく
    expect(needsProjectSelect("", "p-a")).toBe(true);
    expect(needsProjectSelect("deleted", "p-a")).toBe(true);
    // cookie に入れられない ID には合わせない（何度も合わせ直そうとしない）
    expect(needsProjectSelect("p-a", "a b")).toBe(false);
  });

  it("cookie に入れてよい ID の形", () => {
    expect(isProjectId("2941302e-4ea3-4045-8572-2df08da209f1")).toBe(true);
    expect(isProjectId("default")).toBe(true);
    for (const bad of ["", "a b", "a;b", "x".repeat(101), "../x"])
      expect(isProjectId(bad)).toBe(false);
  });
});
