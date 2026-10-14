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
/**
 * 対象で使うイメージの名前（config.yaml の images の名前か default。PBI-41）。指定すると、オーケストレーターに
 * 選ばせず、すべての工程でこのイメージを使う。名前があるかは、タスクを始めるときに確かめる（設定は変わるため）。
 */
export const TargetImageName = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, code("input.imageName"))
    .optional(),
);

export const ProjectTarget = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("org"), target: OrgUrl, image: TargetImageName }),
  z.object({ scope: z.literal("repo"), target: RepoUrl, image: TargetImageName }),
]);
export type ProjectTarget = z.infer<typeof ProjectTarget>;

/** 同時に実行するタスクの数の既定値と範囲（PBI-30）。 */
export const DEFAULT_MAX_PARALLEL_TASKS = 3;
export const MAX_PARALLEL_TASKS_LIMIT = 10;

/** 取り込みのラベル。空の入力は「設定しない」として扱う。検索の条件を壊す文字は受け付けない。 */
const IntakeLabelInput = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .trim()
    .max(50)
    .regex(/^[^"\\]*$/, code("input.invalidLabel"))
    .optional(),
);

/**
 * sacty 全体の設定（プロジェクトとは別。PBI-26）。intakeLabel は、すべてのプロジェクトの対象で取り込む
 * Issue・PR のラベル。設定していなければ取り込まない。maxParallelTasks は、同時に実行するタスクの数
 * （設定していなければ DEFAULT_MAX_PARALLEL_TASKS。PBI-30）。
 * reviewRequested と reviewLabel は、PR のレビューだけを行う取り込み（PBI-44）。reviewRequested は、自分
 * （そのホストでプロジェクトに選んだ gh のアカウント）にレビューが依頼された PR を取り込むか、reviewLabel は
 * PR のレビュー用のラベル（Issue は取り込まない）。
 */
/**
 * 自動のトリアージの種類（PBI-53）。issues：取り込むラベルの Issue、pullRequests：取り込むラベルの PR、
 * reviewLabel：レビュー用のラベルの PR、tickets：チケット（JIRA など。PBI-52）。自分へのレビューの依頼は、
 * reviewRequested の切り替えで決める。
 */
export const TriageKind = z.enum(["issues", "pullRequests", "reviewLabel", "tickets"]);
export type TriageKind = z.infer<typeof TriageKind>;

export const SactySettings = z.object({
  intakeLabel: IntakeLabelInput,
  /** チケット（JIRA など）の取り込むラベル。すべての取り込み先で共通（PBI-52）。空なら取り込まない。 */
  ticketLabel: IntakeLabelInput,
  /**
   * Off にした自動のトリアージの種類（PBI-53）。ラベルなどの設定は残したまま止められる。書いていない種類は On
   * （この項目の無い、これまでの設定は、すべて On として動く）。空なら持たない。
   */
  triageOff: z.preprocess(
    (v) => (Array.isArray(v) && v.length === 0 ? undefined : v),
    z
      .array(TriageKind)
      .transform((kinds) => [...new Set(kinds)].sort())
      .optional(),
  ),
  reviewLabel: IntakeLabelInput,
  // 画面のチェックボックス（on）も受け付ける。切っているときは持たない
  reviewRequested: z.preprocess(
    (v) => (v === true || v === "on" || v === "true" ? true : undefined),
    z.literal(true).optional(),
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

/** 通知の種類（PBI-38）。承認待ち・エスカレーション・一時停止・完了。 */
export const NotificationKind = z.enum(["approval", "escalation", "paused", "completed"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** メンションする通知の種類の既定（PBI-69）。人の出番の通知だけで、完了はメンションしない。 */
export const DEFAULT_MENTION_KINDS: readonly NotificationKind[] = [
  "approval",
  "escalation",
  "paused",
];

/**
 * メンションする相手（PBI-69）。Slack では名前（@表示名）では届かないので、ID で書く。ユーザーはメンバー ID
 * （U…・W…）、ユーザーグループは ID（S…）、ほかに @here・@channel。本文に埋め込むので、この形のほかは受け付けない。
 */
export const SlackMentionTarget = z
  .string()
  .trim()
  .regex(/^(?:[UWS][A-Z0-9]{2,30}|@here|@channel)$/, code("input.slackMention"));
export type SlackMentionTarget = z.infer<typeof SlackMentionTarget>;

/** 通知のメンション（PBI-69）。相手と、メンションする通知の種類（書かなければ人の出番の通知だけ）。 */
export const SlackMention = z.object({
  targets: z
    .array(SlackMentionTarget)
    .min(1, code("input.slackMention"))
    .max(20)
    .transform((targets) => [...new Set(targets)]),
  kinds: z
    .array(NotificationKind)
    .min(1, code("input.mentionKinds"))
    .default([...DEFAULT_MENTION_KINDS])
    // 並びを決めておく（保存した設定と画面の入力を比べるため）
    .transform((kinds) => NotificationKind.options.filter((k) => kinds.includes(k))),
});
export type SlackMention = z.infer<typeof SlackMention>;

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
    /** メンション（PBI-69）。無ければメンションしない。 */
    mention: SlackMention.optional(),
  }),
  z.object({
    kind: z.literal("slack-webhook"),
    /** Incoming Webhook の URL（URL そのものが秘密なので、秘密情報として書く）。 */
    webhook: SecretRefInput,
    language: z.enum(["ja", "en"]).default("ja"),
    mention: SlackMention.optional(),
  }),
]);
export type ProjectNotification = z.infer<typeof ProjectNotification>;

/**
 * プロジェクトの定義。エクスポート・インポートの対象（PBI-5b）なので、
 * 個人の設定や秘密情報は含めない。
 */
/**
 * チケットの管理のサービス（PBI-52）。API の形（検索・コメント）を選ぶ。接続先と認証は、ゲートウェイの組織内 PF の
 * 設定（gateway.platforms）に書き、その名前を取り込み先に書く。
 */
export const TicketService = z.enum(["jira-cloud", "jira-server"]);
export type TicketService = z.infer<typeof TicketService>;

/**
 * プロジェクトのチケットの取り込み先（PBI-52）。接続先（gateway.platforms の名前）・種類・JIRA のプロジェクトのキーの組。
 * 書いたキーの、取り込むラベル（sacty の設定）の付いたチケットを、このプロジェクトのタスクにする。
 */
export const TicketSourceConfig = z.object({
  platform: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, code("input.platformName")),
  service: TicketService,
  keys: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]{0,49}$/, code("input.ticketKey")),
    )
    .min(1, code("input.ticketKey"))
    .max(50),
});
export type TicketSourceConfig = z.infer<typeof TicketSourceConfig>;

export const ProjectDefinition = z.object({
  name: z.string().trim().min(1, code("input.nameRequired")).max(80),
  /** 対象（Org・リポジトリ。PBI-25）。 */
  targets: z.array(ProjectTarget).max(50).default([]),
  /** 工程エージェントに渡すコンテキスト（PBI-6）。 */
  context: ContextSource.optional(),
  /** 人間の出番の通知先（PBI-38）。無ければ通知しない。 */
  notification: ProjectNotification.optional(),
  /** チケットの取り込み先（JIRA など。PBI-52）。複数書ける。 */
  tickets: z.array(TicketSourceConfig).max(20).optional(),
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
  // チケットの取り込み先：同じ接続先の同じキーは、1つのプロジェクトだけ（PBI-52）
  const seenKeys = new Set<string>();
  for (const source of definition.tickets ?? []) {
    for (const key of source.keys) {
      const id = `${source.platform}\u0000${key}`;
      if (seenKeys.has(id)) {
        problems.push(message("project.ticketKeyDuplicated", { platform: source.platform, key }));
        continue;
      }
      seenKeys.add(id);
      const owner = others.find((p) =>
        (p.tickets ?? []).some((t) => t.platform === source.platform && t.keys.includes(key)),
      );
      if (owner) {
        problems.push(
          message("project.ticketKeyTaken", {
            platform: source.platform,
            key,
            project: owner.name,
          }),
        );
      }
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

/**
 * そのリポジトリについて、プロジェクトの対象で指定したイメージの名前（PBI-41）。リポジトリの対象の指定が、
 * Org の対象の指定より優先する（リポジトリの対象にイメージの指定が無ければ、Org の対象の指定）。
 */
export function targetImageOf(project: Project, repo: string): string | undefined {
  const byRepo = project.targets.find((t) => t.scope === "repo" && sameGitHubUrl(t.target, repo));
  const byOrg = project.targets.find(
    (t) => t.scope === "org" && sameGitHubUrl(t.target, orgUrlOf(repo)),
  );
  return byRepo?.image ?? byOrg?.image;
}

/**
 * そのチケットを担当するプロジェクトと取り込み先（PBI-52）。接続先と、チケットのキー（PAY-123 の PAY）で決める。
 */
export function responsibleTicketProject(
  projects: readonly Project[],
  platform: string,
  ticketKey: string,
): { project: Project; source: TicketSourceConfig } | undefined {
  const key = ticketKey.split("-")[0] ?? "";
  for (const project of projects) {
    const source = (project.tickets ?? []).find(
      (t) => t.platform === platform && t.keys.includes(key),
    );
    if (source) return { project, source };
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
        // 通知先（PBI-38）。秘密情報は名前か参照だけなので、エクスポートに含める（メンションの ID も。PBI-69）
        notification: ProjectNotification.optional(),
        // チケットの取り込み先（PBI-52）。秘密情報は含まない（接続先の名前だけ）
        tickets: z.array(TicketSourceConfig.strict()).max(20).optional(),
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
      // 対象ごとのイメージの指定（PBI-41）も含める
      targets: project.targets.map((t) =>
        t.scope === "org"
          ? { scope: "org" as const, target: t.target, ...(t.image ? { image: t.image } : {}) }
          : { scope: "repo" as const, target: t.target, ...(t.image ? { image: t.image } : {}) },
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
      ...(project.tickets && project.tickets.length > 0 ? { tickets: project.tickets } : {}),
    },
  };
}
