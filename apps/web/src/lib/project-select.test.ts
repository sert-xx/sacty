import type { Project } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { resolveProject, safeLocalPath } from "./project-select";

const project = (id: string): Project => ({
  id,
  name: id,
  sources: [],
  repositories: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

describe("表示するプロジェクトの切り替え（PBI-4a）", () => {
  it("cookie のプロジェクトを表示し、無くなっていれば既定のプロジェクトにする", () => {
    const projects = [project("default"), project("p1")];
    expect(resolveProject(projects, "p1")?.id).toBe("p1");
    expect(resolveProject(projects, "deleted")?.id).toBe("default");
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
