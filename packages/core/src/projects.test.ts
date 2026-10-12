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
  make("p1", { name: "決済", targets: [{ scope: "org", target: "https://github.com/acme" }] }),
  make("p2", {
    name: "認証",
    targets: [{ scope: "repo", target: "https://github.com/acme/auth" }],
  }),
];

describe("プロジェクトの対象（PBI-5・PBI-25）", () => {
  it("同じ Org・同じリポジトリは、複数のプロジェクトに登録できない（大文字・小文字は区別しない）", () => {
    const def = ProjectDefinition.parse({
      name: "新規",
      targets: [
        { scope: "org", target: "https://github.com/ACME" },
        { scope: "repo", target: "https://github.com/Acme/Auth" },
      ],
    });
    const conflicts = projectConflicts(projects, undefined, def);
    expect(conflicts).toEqual([
      {
        code: "project.targetTaken",
        params: { scope: "org", target: "https://github.com/ACME", project: "決済" },
      },
      {
        code: "project.targetTaken",
        params: { scope: "repo", target: "https://github.com/Acme/Auth", project: "認証" },
      },
    ]);
    expect(conflicts.map((m) => renderMessage(m, "ja"))).toEqual([
      "Org「https://github.com/ACME」は、プロジェクト「決済」に登録されています。",
      "リポジトリ「https://github.com/Acme/Auth」は、プロジェクト「認証」に登録されています。",
    ]);
    expect(renderMessage(conflicts[1], "en")).toBe(
      'The repository "https://github.com/Acme/Auth" is already registered in the project "認証".',
    );
    // 自分自身の登録は重複にしない
    expect(projectConflicts(projects, "p1", ProjectDefinition.parse(projects[0]))).toEqual([]);
    // Org と、その中のリポジトリを別のプロジェクトに登録するのはよい
    const narrower = ProjectDefinition.parse({
      name: "請求",
      targets: [{ scope: "repo", target: "https://github.com/acme/billing" }],
    });
    expect(projectConflicts(projects, undefined, narrower)).toEqual([]);
  });

  it("同じ定義の中での重複も拒否する", () => {
    const def = ProjectDefinition.parse({
      name: "x",
      targets: [
        { scope: "repo", target: "https://github.com/o/r" },
        { scope: "repo", target: "https://github.com/O/R" },
      ],
    });
    expect(projectConflicts([], undefined, def).map((m) => renderMessage(m, "ja"))).toEqual([
      "リポジトリ「https://github.com/O/R」が重複しています。",
    ]);
  });

  it("範囲が狭い指定（リポジトリ）が優先し、無ければ Org の指定が担当する", () => {
    expect(responsibleProject(projects, "https://github.com/acme/auth")?.project.id).toBe("p2");
    expect(responsibleProject(projects, "https://github.com/ACME/payments")).toMatchObject({
      project: { id: "p1" },
      target: { scope: "org", target: "https://github.com/acme" },
    });
    expect(responsibleProject(projects, "https://github.com/other/repo")).toBeUndefined();
  });

  it("Org の対象から除かれる、ほかのプロジェクトのリポジトリを返す", () => {
    expect(excludedRepositories(projects, "p1", "https://github.com/acme")).toEqual([
      { repo: "https://github.com/acme/auth", projectName: "認証" },
    ]);
    expect(excludedRepositories(projects, "p2", "https://github.com/acme")).toEqual([]);
    // 同じ名前の Org でも、ほかのホストなら除かない（PBI-40）
    expect(excludedRepositories(projects, "p1", "https://ghe.example.co.jp/acme")).toEqual([]);
  });

  it("対象はホストを含めた URL で書き、ホストが違えば別の対象として扱う（PBI-40）", () => {
    const def = ProjectDefinition.parse({
      name: "社内",
      targets: [
        { scope: "repo", target: " https://GHE.example.co.jp/acme/auth.git/ " },
        { scope: "org", target: "https://ghe2.example.co.jp:8443/acme/" },
      ],
      githubAccounts: { "ghe.example.co.jp": "corp", "ghe2.example.co.jp:8443": "corp" },
    });
    // 書き方の揺れ（前後の空白・末尾の / と .git・ホストの大文字）はそろえる
    expect(def.targets).toEqual([
      { scope: "repo", target: "https://ghe.example.co.jp/acme/auth" },
      { scope: "org", target: "https://ghe2.example.co.jp:8443/acme" },
    ]);
    // github.com の同じ名前とは重複しない
    expect(projectConflicts(projects, undefined, def)).toEqual([]);
    expect(responsibleProject(projects, "https://ghe.example.co.jp/acme/auth")).toBeUndefined();
    const all = [...projects, make("p3", def)];
    expect(responsibleProject(all, "https://ghe.example.co.jp/acme/auth")?.project.id).toBe("p3");
    expect(responsibleProject(all, "https://ghe2.example.co.jp:8443/acme/x")?.project.id).toBe(
      "p3",
    );
    expect(responsibleProject(all, "https://github.com/acme/auth")?.project.id).toBe("p2");
    // 短縮表記（owner/name・Org の名前だけ）や、http・ホストの無いものは受け付けない
    for (const target of [
      "acme/auth",
      "http://github.com/acme/auth",
      "https://github.com/acme/auth/x",
    ]) {
      expect(() =>
        ProjectDefinition.parse({ name: "x", targets: [{ scope: "repo", target }] }),
      ).toThrow(/input\.invalidRepo/);
    }
    expect(() =>
      ProjectDefinition.parse({ name: "x", targets: [{ scope: "org", target: "acme" }] }),
    ).toThrow(/input\.invalidOrg/);
  });

  it("名前の形を検査し、取り込み元・リポジトリの設定（以前の形）は持たない", () => {
    expect(() =>
      ProjectDefinition.parse({ name: "x", targets: [{ scope: "repo", target: "acme" }] }),
    ).toThrow(/input\.invalidRepo/);
    expect(() => ProjectDefinition.parse({ name: " " })).toThrow(/input\.nameRequired/);
    const parsed = ProjectDefinition.parse({
      name: "x",
      sources: [{ scope: "org", target: "https://github.com/acme", label: "sacty" }],
      repositories: [{ repo: "https://github.com/acme/app", testCommand: "npm test" }],
    });
    expect(parsed).toEqual({ name: "x", targets: [] });
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  const full = make("p9", {
    name: "決済",
    targets: [
      { scope: "org", target: "https://github.com/acme" },
      { scope: "repo", target: "https://github.com/other/payments" },
    ],
    context: { repo: "https://example.com/ctx.git", ref: "main" },
    // 個人の設定（gh のアカウント。PBI-13）は書き出さない
    githubAccounts: { "github.com": "side-job" },
  });

  it("定義の項目だけを書き出し、ID・日時は含めない。書き出したものはそのまま読める", () => {
    const exported = exportProject(full);
    expect(exported).toEqual({
      sacty: "project",
      version: 3,
      project: {
        name: "決済",
        targets: [
          { scope: "org", target: "https://github.com/acme" },
          { scope: "repo", target: "https://github.com/other/payments" },
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
      ProjectExport.parse({
        ...exported,
        project: { ...exported.project, githubAccounts: { "github.com": "x" } },
      }),
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
          targets: [{ scope: "org", target: "https://github.com/acme", token: "t" }],
        },
      }),
    ).toThrow();
  });
});

describe("通知先（PBI-38）", () => {
  it("Slack API の形と Incoming Webhook を受け付け、秘密情報は名前か参照だけ。エクスポートにも含める", () => {
    const api = ProjectDefinition.parse({
      name: "決済",
      notification: {
        kind: "slack-api",
        url: "https://slack-proxy-b.example.com/api/chat.postMessage",
        channel: "#sacty",
      },
    });
    expect(api.notification).toEqual({
      kind: "slack-api",
      url: "https://slack-proxy-b.example.com/api/chat.postMessage",
      channel: "#sacty",
      language: "ja",
    });
    expect(
      ProjectDefinition.safeParse({
        name: "x",
        notification: { kind: "slack-webhook", webhook: "op://Work/Slack/webhook", language: "en" },
      }).success,
    ).toBe(true);
    // 秘密情報の値（URL）をそのまま書いたら受け付けない
    expect(
      ProjectDefinition.safeParse({
        name: "x",
        notification: { kind: "slack-webhook", webhook: "https://hooks.slack.com/services/T/B/X" },
      }).success,
    ).toBe(false);
    expect(
      ProjectDefinition.safeParse({
        name: "x",
        notification: { kind: "slack-api", url: "not a url", channel: "#a" },
      }).success,
    ).toBe(false);
    const exported = exportProject({ ...api, targets: [], id: "p", createdAt: "", updatedAt: "" });
    expect(exported.project.notification).toEqual(api.notification);
    expect(ProjectExport.parse(exported).project.notification).toEqual(api.notification);
  });
});
