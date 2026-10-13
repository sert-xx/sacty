import { z } from "zod";
import {
  OrgUrl,
  orgUrlOf,
  parseOrgUrl,
  parseRepoUrl,
  RepoUrl,
  sameGitHubUrl,
} from "./github-url.js";
import { code, message } from "./message-code.js";
import type { DaemonMessage } from "./messages.js";

/**
 * プロジェクトの対象（PBI-25）。Org かリポジトリを、ホストを含めた URL で書く（GitHub Enterprise Server も同じ。PBI-40）。
 * 対象のリポジトリには画面からタスクを作れ、対象の Issue・PR は取り込んでタスクにする。
 */
export const ProjectTarget = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("org"), target: OrgUrl }),
  z.object({ scope: z.literal("repo"), target: RepoUrl }),
]);
export type ProjectTarget = z.infer<typeof ProjectTarget>;

/** 同時に実行するタスクの数の既定値と範囲（PBI-30）。 */
export const DEFAULT_MAX_PARALLEL_TASKS = 3;
export const MAX_PARALLEL_TASKS_LIMIT = 10;

/**
 * sacty 全体の設定（プロジェクトとは別。PBI-26）。intakeLabel は、すべてのプロジェクトの対象で取り込む
 * Issue・PR のラベル。設定していなければ取り込まない。maxParallelTasks は、同時に実行するタスクの数
 * （設定していなければ DEFAULT_MAX_PARALLEL_TASKS。PBI-30）。
 */
export const SactySettings = z.object({
  // 空の入力は「設定しない」として扱う
  intakeLabel: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .max(50)
      .regex(/^[^"\\]*$/, code("input.invalidLabel"))
      .optional(),
  ),
  // 画面の入力（文字列）も受け付ける。空は「設定しない」
  maxParallelTasks: z.preprocess(
    (v) =>
      v === undefined || v === null || (typeof v === "string" && v.trim() === "")
        ? undefined
        : typeof v === "string"
          ? Number(v)
          : v,
    z.number().int().min(1).max(MAX_PARALLEL_TASKS_LIMIT).optional(),
  ),
});
export type SactySettings = z.infer<typeof SactySettings>;
export type SactySettingsInput = z.input<typeof SactySettings>;

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

/** 秘密情報：キーチェーンの名前か、1Password の参照（op://…。PBI-34）。値は書かない。 */
const SecretRefInput = z
  .string()
  .trim()
  .regex(/^(?:[A-Za-z0-9._-]+|op:\/\/\S.*)$/, code("input.secretRef"));

/**
 * プロジェクトの通知先（PBI-38）。Slack API の形（chat.postMessage。Slack Proxy でも使える）か、Incoming Webhook。
 * 秘密情報（トークン・Webhook の URL）は名前か 1Password の参照で書き、値は書かない。
 */
export const ProjectNotification = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("slack-api"),
    /** 送り先（例 https://slack.com/api/chat.postMessage、Slack Proxy の chat.postMessage）。 */
    url: z.url({ protocol: /^https?$/, message: code("input.invalidUrl") }),
    channel: z.string().trim().min(1, code("input.channelRequired")).max(80),
    /** Slack のトークン（Proxy では書かない）。 */
    token: SecretRefInput.optional(),
    language: z.enum(["ja", "en"]).default("ja"),
  }),
  z.object({
    kind: z.literal("slack-webhook"),
    /** Incoming Webhook の URL（URL そのものが秘密なので、秘密情報として書く）。 */
    webhook: SecretRefInput,
    language: z.enum(["ja", "en"]).default("ja"),
  }),
]);
export type ProjectNotification = z.infer<typeof ProjectNotification>;

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
  /** 人間の出番の通知先（PBI-38）。無ければ通知しない。 */
  notification: ProjectNotification.optional(),
  /**
   * GitHub へのアクセスに使う、gh にログイン済みのアカウント（PBI-13）。ホストごとに選ぶ（PBI-40。例
   * { "github.com": "me", "ghe.example.co.jp": "me-corp" }）。GitHub にアクセスするには、そのホストのものを必ず選ぶ
   * （gh のアクティブなアカウントは切り替わるので使わない）。個人の設定なので、エクスポートには含めない。
   * 選んでいないあいだは、そのホストへのアクセスを理由つきで止める。
   */
  githubAccounts: z
    .record(
      z.string().regex(/^[A-Za-z0-9.-]+(?::\d+)?$/, code("input.invalidHost")),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/, code("input.invalidGithubName")),
    )
    .optional(),
});
export type ProjectDefinition = z.infer<typeof ProjectDefinition>;
export type ProjectDefinitionInput = z.input<typeof ProjectDefinition>;

export type Project = ProjectDefinition & { id: string; createdAt: string; updatedAt: string };

/** 対象の URL のホスト。 */
export function targetHost(target: ProjectTarget): string {
  return (
    (target.scope === "org" ? parseOrgUrl(target.target) : parseRepoUrl(target.target))?.host ?? ""
  );
}

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
      p.targets.some((t) => t.scope === target.scope && sameGitHubUrl(t.target, target.target)),
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
    const target = project.targets.find((t) => t.scope === "repo" && sameGitHubUrl(t.target, repo));
    if (target) return { project, target };
  }
  for (const project of projects) {
    const target = project.targets.find(
      (t) => t.scope === "org" && sameGitHubUrl(t.target, orgUrlOf(repo)),
    );
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
        .filter((t) => t.scope === "repo" && sameGitHubUrl(orgUrlOf(t.target), org))
        .map((t) => ({ repo: t.target, projectName: p.name })),
    );
}

/** エクスポートの形式の版。形を変えたら上げ、インポートで古い版を読めるようにする。 */
export const PROJECT_EXPORT_VERSION = 3;

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
        // 通知先（PBI-38）。秘密情報は名前か参照だけなので、エクスポートに含める
        notification: ProjectNotification.optional(),
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
      ...(project.notification ? { notification: project.notification } : {}),
    },
  };
}
