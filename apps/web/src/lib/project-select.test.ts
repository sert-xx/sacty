import type { Project } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { isLocalPath, resolveProject } from "./project-select";

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

  it("切り替えの後の移動先は、画面の中のパスだけを受け付ける", () => {
    expect(isLocalPath("/tasks/1/review")).toBe(true);
    expect(isLocalPath("/tasks/1#proposals")).toBe(true);
    expect(isLocalPath("https://evil.example/")).toBe(false);
    expect(isLocalPath("//evil.example/")).toBe(false);
    expect(isLocalPath("/\\evil.example/")).toBe(false);
    expect(isLocalPath("tasks")).toBe(false);
  });
});
