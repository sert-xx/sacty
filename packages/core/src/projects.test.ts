import { describe, expect, it } from "vitest";
import { renderMessage } from "./messages.js";
import {
  excludedRepositories,
  exportProject,
  type Project,
  ProjectDefinition,
  type ProjectDefinitionInput,
  ProjectExport,
  projectConflicts,
  responsibleProject,
} from "./projects.js";

const make = (id: string, def: ProjectDefinitionInput): Project => ({
  ...ProjectDefinition.parse(def),
  id,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

const projects = [
  make("p1", { name: "決済", targets: [{ scope: "org", target: "acme" }] }),
  make("p2", { name: "認証", targets: [{ scope: "repo", target: "acme/auth" }] }),
];

describe("プロジェクトの対象（PBI-5・PBI-25）", () => {
  it("同じ Org・同じリポジトリは、複数のプロジェクトに登録できない（大文字・小文字は区別しない）", () => {
    const def = ProjectDefinition.parse({
      name: "新規",
      targets: [
        { scope: "org", target: "ACME" },
        { scope: "repo", target: "Acme/Auth" },
      ],
    });
    const conflicts = projectConflicts(projects, undefined, def);
    expect(conflicts).toEqual([
      { code: "project.targetTaken", params: { scope: "org", target: "ACME", project: "決済" } },
      {
        code: "project.targetTaken",
        params: { scope: "repo", target: "Acme/Auth", project: "認証" },
      },
    ]);
    expect(conflicts.map((m) => renderMessage(m, "ja"))).toEqual([
      "Org「ACME」は、プロジェクト「決済」に登録されています。",
      "リポジトリ「Acme/Auth」は、プロジェクト「認証」に登録されています。",
    ]);
    expect(renderMessage(conflicts[1], "en")).toBe(
      'The repository "Acme/Auth" is already registered in the project "認証".',
    );
    // 自分自身の登録は重複にしない
    expect(projectConflicts(projects, "p1", ProjectDefinition.parse(projects[0]))).toEqual([]);
    // Org と、その中のリポジトリを別のプロジェクトに登録するのはよい
    const narrower = ProjectDefinition.parse({
      name: "請求",
      targets: [{ scope: "repo", target: "acme/billing" }],
    });
    expect(projectConflicts(projects, undefined, narrower)).toEqual([]);
  });

  it("同じ定義の中での重複も拒否する", () => {
    const def = ProjectDefinition.parse({
      name: "x",
      targets: [
        { scope: "repo", target: "o/r" },
        { scope: "repo", target: "O/R" },
      ],
    });
    expect(projectConflicts([], undefined, def).map((m) => renderMessage(m, "ja"))).toEqual([
      "リポジトリ「O/R」が重複しています。",
    ]);
  });

  it("範囲が狭い指定（リポジトリ）が優先し、無ければ Org の指定が担当する", () => {
    expect(responsibleProject(projects, "acme/auth")?.project.id).toBe("p2");
    expect(responsibleProject(projects, "ACME/payments")).toMatchObject({
      project: { id: "p1" },
      target: { scope: "org", target: "acme" },
    });
    expect(responsibleProject(projects, "other/repo")).toBeUndefined();
  });

  it("Org の対象から除かれる、ほかのプロジェクトのリポジトリを返す", () => {
    expect(excludedRepositories(projects, "p1", "acme")).toEqual([
      { repo: "acme/auth", projectName: "認証" },
    ]);
    expect(excludedRepositories(projects, "p2", "acme")).toEqual([]);
  });

  it("名前の形を検査し、取り込み元・リポジトリの設定（以前の形）は持たない", () => {
    expect(() =>
      ProjectDefinition.parse({ name: "x", targets: [{ scope: "repo", target: "acme" }] }),
    ).toThrow(/input\.invalidRepo/);
    expect(() => ProjectDefinition.parse({ name: " " })).toThrow(/input\.nameRequired/);
    const parsed = ProjectDefinition.parse({
      name: "x",
      sources: [{ scope: "org", target: "acme", label: "sacty" }],
      repositories: [{ repo: "acme/app", testCommand: "npm test" }],
    });
    expect(parsed).toEqual({ name: "x", targets: [] });
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  const full = make("p9", {
    name: "決済",
    targets: [
      { scope: "org", target: "acme" },
      { scope: "repo", target: "other/payments" },
    ],
    context: { repo: "https://example.com/ctx.git", ref: "main" },
    // 個人の設定（gh のアカウント。PBI-13）は書き出さない
    githubAccount: "side-job",
  });

  it("定義の項目だけを書き出し、ID・日時は含めない。書き出したものはそのまま読める", () => {
    const exported = exportProject(full);
    expect(exported).toEqual({
      sacty: "project",
      version: 2,
      project: {
        name: "決済",
        targets: [
          { scope: "org", target: "acme" },
          { scope: "repo", target: "other/payments" },
        ],
        context: { repo: "https://example.com/ctx.git", ref: "main" },
      },
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain("p9");
    expect(text).not.toContain("2026-10-10");
    expect(text).not.toContain("side-job");
    expect(ProjectExport.parse(JSON.parse(text))).toEqual(exported);
    // 書き出したファイルに足されていても、読まない（strict）
    expect(() =>
      ProjectExport.parse({ ...exported, project: { ...exported.project, githubAccount: "x" } }),
    ).toThrow();
  });

  it("形式・版の違うファイルや、知らない項目（秘密情報など）は読まない", () => {
    const ok = exportProject(full);
    expect(() => ProjectExport.parse({ ...ok, sacty: "task" })).toThrow(/input\.notExportFile/);
    // 以前の版（取り込み元・リポジトリの設定）は読まない（移行の手段は設けない。PBI-25）
    expect(() => ProjectExport.parse({ ...ok, version: 1 })).toThrow(/input\.unsupportedVersion/);
    expect(() =>
      ProjectExport.parse({ ...ok, project: { ...ok.project, token: "ghp_secret" } }),
    ).toThrow();
    expect(() =>
      ProjectExport.parse({
        ...ok,
        project: {
          ...ok.project,
          targets: [{ scope: "org", target: "acme", token: "t" }],
        },
      }),
    ).toThrow();
  });
});
