import { describe, expect, it } from "vitest";
import {
  excludedRepositories,
  exportProject,
  type Project,
  ProjectDefinition,
  type ProjectDefinitionInput,
  ProjectExport,
  projectConflicts,
  responsibleSource,
} from "./projects.js";

const make = (id: string, def: ProjectDefinitionInput): Project => ({
  ...ProjectDefinition.parse(def),
  id,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

const projects = [
  make("p1", { name: "決済", sources: [{ scope: "org", target: "acme", label: "sacty" }] }),
  make("p2", {
    name: "認証",
    sources: [{ scope: "repo", target: "acme/auth", label: "ai" }],
  }),
];

describe("プロジェクトの取り込み元（PBI-5）", () => {
  it("同じ Org・同じリポジトリは、複数のプロジェクトに登録できない（大文字・小文字は区別しない）", () => {
    const def = ProjectDefinition.parse({
      name: "新規",
      sources: [
        { scope: "org", target: "ACME", label: "x" },
        { scope: "repo", target: "Acme/Auth", label: "x" },
      ],
    });
    expect(projectConflicts(projects, undefined, def)).toEqual([
      "Org「ACME」は、プロジェクト「決済」に登録されています。",
      "リポジトリ「Acme/Auth」は、プロジェクト「認証」に登録されています。",
    ]);
    // 自分自身の登録は重複にしない
    expect(projectConflicts(projects, "p1", ProjectDefinition.parse(projects[0]))).toEqual([]);
    // Org と、その中のリポジトリを別のプロジェクトに登録するのはよい
    const narrower = ProjectDefinition.parse({
      name: "請求",
      sources: [{ scope: "repo", target: "acme/billing", label: "x" }],
    });
    expect(projectConflicts(projects, undefined, narrower)).toEqual([]);
  });

  it("同じ定義の中での重複も拒否する", () => {
    const def = ProjectDefinition.parse({
      name: "x",
      sources: [
        { scope: "repo", target: "o/r", label: "a" },
        { scope: "repo", target: "O/R", label: "b" },
      ],
      repositories: [
        { repo: "o/r", testCommand: "npm test" },
        { repo: "o/R", testCommand: "npm test" },
      ],
    });
    expect(projectConflicts([], undefined, def)).toEqual([
      "リポジトリ「O/R」が重複しています。",
      "リポジトリの設定「o/R」が重複しています。",
    ]);
  });

  it("範囲が狭い指定（リポジトリ）が優先し、無ければ Org の指定が担当する", () => {
    expect(responsibleSource(projects, "acme/auth")?.project.id).toBe("p2");
    expect(responsibleSource(projects, "ACME/payments")?.project.id).toBe("p1");
    expect(responsibleSource(projects, "other/repo")).toBeUndefined();
  });

  it("Org の取り込み元から除かれる、ほかのプロジェクトのリポジトリを返す", () => {
    expect(excludedRepositories(projects, "p1", "acme")).toEqual([
      { repo: "acme/auth", projectName: "認証" },
    ]);
    expect(excludedRepositories(projects, "p2", "acme")).toEqual([]);
  });

  it("名前の形を検査する", () => {
    expect(() =>
      ProjectDefinition.parse({
        name: "x",
        sources: [{ scope: "repo", target: "acme", label: "a" }],
      }),
    ).toThrow(/owner\/name/);
    expect(() => ProjectDefinition.parse({ name: " " })).toThrow(/名前を入力/);
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  const full = make("p9", {
    name: "決済",
    sources: [{ scope: "org", target: "acme", label: "sacty" }],
    repositories: [{ repo: "acme/payments", testCommand: "npm test" }],
  });

  it("定義の項目だけを書き出し、ID・日時は含めない。書き出したものはそのまま読める", () => {
    const exported = exportProject(full);
    expect(exported).toEqual({
      sacty: "project",
      version: 1,
      project: {
        name: "決済",
        sources: [{ scope: "org", target: "acme", label: "sacty" }],
        repositories: [
          { repo: "acme/payments", baseBranch: "main", testCommand: "npm test", pullRequest: true },
        ],
      },
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain("p9");
    expect(text).not.toContain("2026-10-10");
    expect(ProjectExport.parse(JSON.parse(text))).toEqual(exported);
  });

  it("形式・版の違うファイルや、知らない項目（秘密情報など）は読まない", () => {
    const ok = exportProject(full);
    expect(() => ProjectExport.parse({ ...ok, sacty: "task" })).toThrow(
      /プロジェクト定義のファイルではありません/,
    );
    expect(() => ProjectExport.parse({ ...ok, version: 2 })).toThrow(/対応していない版/);
    expect(() =>
      ProjectExport.parse({ ...ok, project: { ...ok.project, token: "ghp_secret" } }),
    ).toThrow();
    expect(() =>
      ProjectExport.parse({
        ...ok,
        project: {
          ...ok.project,
          repositories: [{ ...ok.project.repositories[0], token_secret: "github-token" }],
        },
      }),
    ).toThrow();
    expect(() =>
      ProjectExport.parse({
        ...ok,
        project: {
          ...ok.project,
          sources: [{ scope: "org", target: "acme", label: "x", token: "t" }],
        },
      }),
    ).toThrow();
  });
});
