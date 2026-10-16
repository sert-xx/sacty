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

/**
 * 取り込みの種類（PBI-100）。issues：Issue の取り込み、reviews：PR のレビューの取り込み（レビュー用のラベルと自分への
 * レビューの依頼）、tickets：チケット（JIRA など）の取り込み。種類ごとに、別の間隔で取り込む。
 */
export const IntakeKind = z.enum(["issues", "reviews", "tickets"]);
export type IntakeKind = z.infer<typeof IntakeKind>;

/** 取り込みの間隔（秒）の既定値と下限（PBI-100）。 */
export const DEFAULT_INTAKE_INTERVAL_SEC = 300;
export const MIN_INTAKE_INTERVAL_SEC = 60;

/** 画面の入力（文字列）も受け付ける数。空は「設定しない」。 */
const numberInput = (schema: z.ZodNumber) =>
  z.preprocess(
    (v) =>
      v === undefined || v === null || (typeof v === "string" && v.trim() === "")
        ? undefined
        : typeof v === "string"
          ? Number(v)
          : v,
    schema.optional(),
  );

/**
 * 取り込みの間隔（秒）。設定していなければ DEFAULT_INTAKE_INTERVAL_SEC（PBI-100）。誤りは、どの種類の間隔かがわかる文言にする
 * （画面の3つの欄が同じ名前なので）。
 */
const IntakeIntervalInput = (
  invalid:
    | "input.issueIntervalInvalid"
    | "input.reviewIntervalInvalid"
    | "input.ticketIntervalInvalid",
) =>
  numberInput(
    z.number(code(invalid)).int(code(invalid)).min(MIN_INTAKE_INTERVAL_SEC, code(invalid)),
  );

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
 * Issue のラベル（PR は取り込まない。PBI-99）。設定していなければ取り込まない。maxParallelTasks は、同時に実行するタスクの数
 * （設定していなければ DEFAULT_MAX_PARALLEL_TASKS。PBI-30）。
 * reviewRequested と reviewLabel は、PR のレビューだけを行う取り込み（PBI-44）。PR を取り込むのはこれだけ（PBI-99）。
 * reviewRequested は、自分（そのホストでプロジェクトに選んだ gh のアカウント）にレビューが依頼された PR を取り込むか、
 * reviewLabel は PR のレビュー用のラベル（Issue は取り込まない。sacty が作る PR にも付ける。PBI-88・PBI-99）。
 */
/**
 * 自動のトリアージの種類（PBI-53）。issues：取り込むラベルの Issue、reviewLabel：レビュー用のラベルの PR、
 * tickets：チケット（JIRA など。PBI-52）。自分へのレビューの依頼は、reviewRequested の切り替えで決める。
 */
export const TriageKind = z.enum(["issues", "reviewLabel", "tickets"]);
export type TriageKind = z.infer<typeof TriageKind>;

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
 * Slack の通知先（PBI-38）。Slack API の形（chat.postMessage。Slack Proxy でも使える）か、Incoming Webhook。
 * 秘密情報（トークン・Webhook の URL）は名前か 1Password の参照で書き、値は書かない。sacty の設定に1つだけ持ち、
 * すべてのプロジェクトのタスクの通知をここに送る（PBI-115。以前はプロジェクトごと）。
 */
export const SlackNotification = z.discriminatedUnion("kind", [
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
export type SlackNotification = z.infer<typeof SlackNotification>;

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
  maxParallelTasks: numberInput(z.number().int().min(1).max(MAX_PARALLEL_TASKS_LIMIT)),
  /** 取り込みの種類ごとの間隔（秒。PBI-100）。空は「設定しない」（既定の間隔）。 */
  issueIntervalSec: IntakeIntervalInput("input.issueIntervalInvalid"),
  reviewIntervalSec: IntakeIntervalInput("input.reviewIntervalInvalid"),
  ticketIntervalSec: IntakeIntervalInput("input.ticketIntervalInvalid"),
  /** Slack の通知先（PBI-38。PBI-115 でプロジェクトから移した）。無ければ通知しない。 */
  notification: SlackNotification.optional(),
});
export type SactySettings = z.infer<typeof SactySettings>;
export type SactySettingsInput = z.input<typeof SactySettings>;

/** 取り込みの種類ごとの間隔の、設定の項目（PBI-100）。 */
const INTERVAL_KEYS = {
  issues: "issueIntervalSec",
  reviews: "reviewIntervalSec",
  tickets: "ticketIntervalSec",
} as const satisfies Record<IntakeKind, keyof SactySettings>;

/** その種類の取り込みの間隔（秒）。設定していなければ既定値（PBI-100）。 */
export function intakeIntervalSec(settings: SactySettings, kind: IntakeKind): number {
  return settings[INTERVAL_KEYS[kind]] ?? DEFAULT_INTAKE_INTERVAL_SEC;
}

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

/** 共用の compose の名前（オーケストレーターが選ぶときの名前。PBI-70）。 */
export const SharedComposeName = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, code("input.sharedComposeName"));

/**
 * プロジェクトで共用する docker compose（PBI-70）。チームで共用するリポジトリ（git の URL かローカルのパス）の
 * compose ファイルを、タスクの工程・テストの実行ごとに、そのタスク専用に起動する。設定しただけでは起動せず、
 * オーケストレーターがタスクごとに要るかを判断する。description は、その判断の手がかり（起動するサービスなど）。
 * 認証は対象のリポジトリ・コンテキストリポジトリと同じ（HTTPS の GitHub はプロジェクトの gh のアカウント）なので、
 * URL にユーザー名・パスワードは書かない。
 */
export const SharedCompose = z.object({
  name: SharedComposeName,
  repo: z
    .string()
    .trim()
    .min(1, code("input.sharedComposeRepoRequired"))
    .max(500)
    // URL に認証の値を書かせない（画面・台帳・ログに出るため）
    .refine((repo) => !/^[a-z][a-z0-9+.-]*:\/\/[^/]*:[^/]*@/i.test(repo), {
      message: code("input.sharedComposeRepoCredential"),
    })
    .refine((repo) => !/^https?:\/\/[^/]*@/i.test(repo), {
      message: code("input.sharedComposeRepoCredential"),
    })
    // git の URL（https://・ssh://・git@host:path）か、ローカルの絶対パス。相対パスは、デーモンのカレントディレクトリ
    // 次第で取得先が変わるので使えない
    .refine(
      (repo) =>
        repo === "" ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) ||
        /^[^/\s:]+:/.test(repo) ||
        repo.startsWith("/"),
      { message: code("input.sharedComposeRepoForm") },
    ),
  ref: ContextSource.shape.ref,
  /** compose ファイルの、リポジトリの根からの相対パス。 */
  file: z
    .string()
    .trim()
    .min(1, code("input.sharedComposeFile"))
    .max(300)
    .refine(
      (file) =>
        !file.startsWith("/") &&
        !file.startsWith("-") &&
        !file.split(/[\\/]/).includes("..") &&
        !file.includes("$"),
      { message: code("input.sharedComposeFile") },
    ),
  description: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(1000).optional(),
  ),
});
export type SharedCompose = z.infer<typeof SharedCompose>;

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
  /** チケットの取り込み先（JIRA など。PBI-52）。複数書ける。 */
  tickets: z.array(TicketSourceConfig).max(20).optional(),
  /** 共用の docker compose（PBI-70）。複数書ける。名前はプロジェクトの中で重ならない。 */
  sharedComposes: z.array(SharedCompose).max(20).optional(),
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
  options: {
    /**
     * チケットの取り込み先の接続先が、プロジェクトをまたいで共有する PF（ホストの gateway.platforms）か（PBI-74）。
     * 共有しない PF（プロジェクトのコンテキストの platforms.yaml）は、同じ名前でもプロジェクトごとに別の接続先なので、
     * ほかのプロジェクトとの重複を調べない。無ければ、すべて共有する PF として調べる。
     */
    sharedPlatform?: (name: string) => boolean;
  } = {},
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
      if (options.sharedPlatform && !options.sharedPlatform(source.platform)) continue;
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
  // 共用の compose：名前は、オーケストレーターが選ぶ名前なので重ならない（PBI-70）
  const composeNames = new Set<string>();
  for (const shared of definition.sharedComposes ?? []) {
    if (composeNames.has(shared.name)) {
      problems.push(message("project.sharedComposeDuplicated", { name: shared.name }));
    }
    composeNames.add(shared.name);
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
  /** プロジェクトのコンテキストの PF で見つけたチケットなら、そのプロジェクト（PBI-74）。ほかのプロジェクトは見ない。 */
  projectId?: string,
): { project: Project; source: TicketSourceConfig } | undefined {
  const key = ticketKey.split("-")[0] ?? "";
  for (const project of projects) {
    if (projectId !== undefined && project.id !== projectId) continue;
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

/**
 * エクスポートの形式の版。形を変えたら上げる。古い版は読まない（移行の手段は設けない）。
 * 5 から、Slack の通知先を含めない（通知先は sacty の設定に移った。PBI-115）。
 */
export const PROJECT_EXPORT_VERSION = 5;

/**
 * 通知先を含んでいた版（3 はメンションも含んでいた。PBI-69・PBI-103）。インポートでは、理由を示して断る（PBI-115）。
 */
const EXPORT_VERSIONS_WITH_NOTIFICATION: readonly unknown[] = [3, 4];

/** インポートでは知らない項目を拒否する（秘密情報などを、気づかずに取り込まないため）。 */
const StrictProjectTarget = z.discriminatedUnion("scope", [
  ProjectTarget.options[0].strict(),
  ProjectTarget.options[1].strict(),
]);

/**
 * プロジェクト定義のエクスポートの形式。プロジェクトの定義（名前・対象・コンテキストリポジトリ）
 * だけを含め、ID・日時、個人の設定や秘密情報（トークンなど）は含めない。Slack の通知先は sacty の設定なので含めない
 * （PBI-115）。通知先を書いたファイルは、知らない項目として拒否する。
 */
export const ProjectExport = z
  .object({
    sacty: z.literal("project", { error: code("input.notExportFile") }),
    version: z.literal(PROJECT_EXPORT_VERSION, {
      error: (issue) =>
        code(
          EXPORT_VERSIONS_WITH_NOTIFICATION.includes(issue.input)
            ? "input.exportVersionWithNotification"
            : "input.unsupportedVersion",
        ),
    }),
    project: z
      .object({
        name: ProjectDefinition.shape.name,
        targets: z.array(StrictProjectTarget).max(50).default([]),
        context: ContextSource.strict().optional(),
        // チケットの取り込み先（PBI-52）。秘密情報は含まない（接続先の名前だけ）
        tickets: z.array(TicketSourceConfig.strict()).max(20).optional(),
        // 共用の compose（PBI-70）。認証の値は含まない（URL に書かせない）
        sharedComposes: z.array(SharedCompose.strict()).max(20).optional(),
        // マージの後の監視の On・Off（PBI-89）は無くした（PBI-116。工程にし、タスクごとに決める）。以前の版で書き出した
        // ファイルにあっても、読まずに捨てる（読み込みを止めない）
        deploymentWatch: z.unknown().optional(),
      })
      .strict()
      .transform(({ deploymentWatch: _dropped, ...project }) => project),
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
      ...(project.tickets && project.tickets.length > 0 ? { tickets: project.tickets } : {}),
      ...(project.sharedComposes && project.sharedComposes.length > 0
        ? { sharedComposes: project.sharedComposes }
        : {}),
    },
  };
}
