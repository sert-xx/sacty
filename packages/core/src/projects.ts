import { z } from "zod";
import { code, message } from "./message-code.js";
import type { DaemonMessage } from "./messages.js";

/** GitHub の名前（owner や repo）。大文字・小文字は区別しない。 */
const Name = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/, code("input.invalidGithubName"));
/** owner/name の形のリポジトリ。 */
export const RepoName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/, code("input.invalidRepo"));

/**
 * プロジェクトの対象（PBI-25）。Org かリポジトリ。対象のリポジトリには画面からタスクを作れ、
 * 対象の Issue・PR は取り込んでタスクにする。
 */
export const ProjectTarget = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("org"), target: Name }),
  z.object({ scope: z.literal("repo"), target: RepoName }),
]);
export type ProjectTarget = z.infer<typeof ProjectTarget>;

/**
 * 取り込むラベル（PBI-25）。sacty 全体の設定にするまで（PBI-26）、すべての対象でこのラベルを使う。
 */
export const INTAKE_LABEL = "sacty";

/**
 * コンテキストリポジトリの指定。repo は git の URL かローカルのパス、ref はブランチやタグ
 * （省略すると既定のブランチ）。
 */
export const ContextSource = z.object({
  repo: z.string().trim().min(1, code("input.contextRepoRequired")).max(500),
  ref: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\w./-]*$/, code("input.invalidRef"))
    .optional(),
});
export type ContextSource = z.infer<typeof ContextSource>;

/**
 * プロジェクトの定義。エクスポート・インポートの対象（PBI-5b）なので、
 * 個人の設定や秘密情報は含めない。
 */
export const ProjectDefinition = z.object({
  name: z.string().trim().min(1, code("input.nameRequired")).max(80),
  /** 対象（Org・リポジトリ。PBI-25）。 */
  targets: z.array(ProjectTarget).max(50).default([]),
  /** 工程エージェントに渡すコンテキスト（PBI-6）。 */
  context: ContextSource.optional(),
  /**
   * GitHub へのアクセスに使う、gh にログイン済みのアカウント（PBI-13）。GitHub にアクセスするには必ず選ぶ
   * （gh のアクティブなアカウントは切り替わるので使わない）。個人の設定なので、エクスポートには含めない。
   * インポートしたプロジェクトなど、選んでいないあいだは、GitHub へのアクセスを理由つきで止める。
   */
  githubAccount: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, code("input.invalidGithubName"))
    .optional(),
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
): DaemonMessage[] {
  const problems: DaemonMessage[] = [];
  const others = projects.filter((p) => p.id !== id);
  const seen = new Set<string>();
  for (const target of definition.targets) {
    const key = `${target.scope}:${target.target.toLowerCase()}`;
    if (seen.has(key)) {
      problems.push(
        message("project.targetDuplicated", { scope: target.scope, target: target.target }),
      );
      continue;
    }
    seen.add(key);
    const owner = others.find((p) =>
      p.targets.some((t) => t.scope === target.scope && same(t.target, target.target)),
    );
    if (owner) {
      problems.push(
        message("project.targetTaken", {
          scope: target.scope,
          target: target.target,
          project: owner.name,
        }),
      );
    }
  }
  return problems;
}

/**
 * そのリポジトリを担当するプロジェクトと対象。範囲が狭い指定（リポジトリ）が優先し、
 * 無ければ Org の指定。使うたびに判定する（設定の変更をすぐに反映するため）。
 */
export function responsibleProject(
  projects: readonly Project[],
  repo: string,
): { project: Project; target: ProjectTarget } | undefined {
  for (const project of projects) {
    const target = project.targets.find((t) => t.scope === "repo" && same(t.target, repo));
    if (target) return { project, target };
  }
  for (const project of projects) {
    const target = project.targets.find((t) => t.scope === "org" && same(t.target, ownerOf(repo)));
    if (target) return { project, target };
  }
  return undefined;
}

/** Org の対象から除かれる、ほかのプロジェクトがリポジトリ単位で担当しているリポジトリ。 */
export function excludedRepositories(
  projects: readonly Project[],
  projectId: string,
  org: string,
): { repo: string; projectName: string }[] {
  return projects
    .filter((p) => p.id !== projectId)
    .flatMap((p) =>
      p.targets
        .filter((t) => t.scope === "repo" && same(ownerOf(t.target), org))
        .map((t) => ({ repo: t.target, projectName: p.name })),
    );
}

/** エクスポートの形式の版。形を変えたら上げ、インポートで古い版を読めるようにする。 */
export const PROJECT_EXPORT_VERSION = 2;

/** インポートでは知らない項目を拒否する（秘密情報などを、気づかずに取り込まないため）。 */
const StrictProjectTarget = z.discriminatedUnion("scope", [
  ProjectTarget.options[0].strict(),
  ProjectTarget.options[1].strict(),
]);

/**
 * プロジェクト定義のエクスポートの形式。プロジェクトの定義（名前・対象・コンテキストリポジトリ）
 * だけを含め、ID・日時、個人の設定や秘密情報（トークンなど）は含めない。
 */
export const ProjectExport = z
  .object({
    sacty: z.literal("project", { error: code("input.notExportFile") }),
    version: z.literal(PROJECT_EXPORT_VERSION, { error: code("input.unsupportedVersion") }),
    project: z
      .object({
        name: ProjectDefinition.shape.name,
        targets: z.array(StrictProjectTarget).max(50).default([]),
        context: ContextSource.strict().optional(),
      })
      .strict(),
  })
  .strict();
export type ProjectExport = z.infer<typeof ProjectExport>;

/** プロジェクトを、エクスポートの形式にする（定義の項目だけを取り出す）。 */
export function exportProject(project: Project): ProjectExport {
  return {
    sacty: "project",
    version: PROJECT_EXPORT_VERSION,
    project: {
      name: project.name,
      targets: project.targets.map((t) =>
        t.scope === "org"
          ? { scope: "org" as const, target: t.target }
          : { scope: "repo" as const, target: t.target },
      ),
      ...(project.context
        ? {
            context: {
              repo: project.context.repo,
              ...(project.context.ref ? { ref: project.context.ref } : {}),
            },
          }
        : {}),
    },
  };
}
