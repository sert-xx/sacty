import { z } from "zod";

/** GitHub の名前（owner や repo）。大文字・小文字は区別しない。 */
const Name = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/, "GitHub の名前として正しくありません");
/** owner/name の形のリポジトリ。 */
export const RepoName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/,
    "リポジトリは owner/name の形で入力してください",
  );

/** GitHub Issue の取り込み元。Org 単位かリポジトリ単位で、条件はラベル。 */
export const IssueSource = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("org"), target: Name, label: z.string().trim().min(1).max(50) }),
  z.object({ scope: z.literal("repo"), target: RepoName, label: z.string().trim().min(1).max(50) }),
]);
export type IssueSource = z.infer<typeof IssueSource>;

/** 実装の対象リポジトリの設定（Issue のリポジトリごと）。 */
export const RepositorySettings = z.object({
  repo: RepoName,
  baseBranch: z.string().trim().min(1).max(100).default("main"),
  /** テストを実行するコマンド。sh -c で実行し、終了コード0で合格。 */
  testCommand: z.string().trim().min(1, "テストのコマンドを入力してください").max(1000),
  /** 成果物チェックの前に、GitHub に PR を作るか（作らなければブランチのプッシュまで）。 */
  pullRequest: z.boolean().default(true),
});
export type RepositorySettings = z.infer<typeof RepositorySettings>;

/**
 * プロジェクトの定義。エクスポート・インポートの対象（PBI-5b）なので、
 * 個人の設定や秘密情報は含めない。
 */
export const ProjectDefinition = z.object({
  name: z.string().trim().min(1, "名前を入力してください").max(80),
  sources: z.array(IssueSource).max(50).default([]),
  repositories: z.array(RepositorySettings).max(100).default([]),
});
export type ProjectDefinition = z.infer<typeof ProjectDefinition>;
export type ProjectDefinitionInput = z.input<typeof ProjectDefinition>;

export type Project = ProjectDefinition & { id: string; createdAt: string; updatedAt: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ownerOf = (repo: string) => repo.split("/")[0] ?? "";

/**
 * プロジェクトの定義が、ほかのプロジェクトや自分自身と重複していないかを調べる。
 * 同じ Org・同じリポジトリを、複数のプロジェクトに登録できない
 * （Org とその中のリポジトリを別のプロジェクトに登録するのはよい。範囲が狭いほうが優先される）。
 */
export function projectConflicts(
  projects: readonly Project[],
  id: string | undefined,
  definition: ProjectDefinition,
): string[] {
  const problems: string[] = [];
  const others = projects.filter((p) => p.id !== id);
  const seen = new Set<string>();
  for (const source of definition.sources) {
    const key = `${source.scope}:${source.target.toLowerCase()}`;
    if (seen.has(key)) {
      problems.push(`${scopeLabel(source)}「${source.target}」が重複しています。`);
      continue;
    }
    seen.add(key);
    const owner = others.find((p) =>
      p.sources.some((s) => s.scope === source.scope && same(s.target, source.target)),
    );
    if (owner) {
      problems.push(
        `${scopeLabel(source)}「${source.target}」は、プロジェクト「${owner.name}」に登録されています。`,
      );
    }
  }
  const repos = new Set<string>();
  for (const r of definition.repositories) {
    if (repos.has(r.repo.toLowerCase())) {
      problems.push(`リポジトリの設定「${r.repo}」が重複しています。`);
    }
    repos.add(r.repo.toLowerCase());
  }
  return problems;
}

function scopeLabel(source: IssueSource): string {
  return source.scope === "org" ? "Org" : "リポジトリ";
}

/**
 * そのリポジトリの Issue を担当するプロジェクトと取り込み元。範囲が狭い指定（リポジトリ）が優先し、
 * 無ければ Org の指定。取り込むたびに判定する（設定の変更をすぐに反映するため）。
 */
export function responsibleSource(
  projects: readonly Project[],
  repo: string,
): { project: Project; source: IssueSource } | undefined {
  for (const project of projects) {
    const source = project.sources.find((s) => s.scope === "repo" && same(s.target, repo));
    if (source) return { project, source };
  }
  for (const project of projects) {
    const source = project.sources.find((s) => s.scope === "org" && same(s.target, ownerOf(repo)));
    if (source) return { project, source };
  }
  return undefined;
}

/** Org の取り込み元から除かれる、ほかのプロジェクトがリポジトリ単位で担当しているリポジトリ。 */
export function excludedRepositories(
  projects: readonly Project[],
  projectId: string,
  org: string,
): { repo: string; projectName: string }[] {
  return projects
    .filter((p) => p.id !== projectId)
    .flatMap((p) =>
      p.sources
        .filter((s) => s.scope === "repo" && same(ownerOf(s.target), org))
        .map((s) => ({ repo: s.target, projectName: p.name })),
    );
}

/** プロジェクトの、そのリポジトリの設定。 */
export function repositorySettings(
  project: Project | undefined,
  repo: string,
): RepositorySettings | undefined {
  return project?.repositories.find((r) => same(r.repo, repo));
}
