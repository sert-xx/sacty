import {
  type ActivityEvent,
  type AuditDashboard,
  type AuditTarget,
  type CleanupTarget,
  type CreateTaskInput,
  type CreateTemplateTaskInput,
  type DaemonText,
  type DashboardSummary,
  type IntakeKind,
  type Project,
  type ProjectAudits,
  type ProjectDefinitionInput,
  renderMessage,
  type SactySettings,
  type SactySettingsInput,
  type StepKey,
  type Task,
  type TaskAudit,
  type TriageKind,
} from "@sacty/core";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getMessages } from "@/i18n/server";
import { currentDaemonSignal } from "@/lib/daemon-signal";
import {
  isValidSession,
  sessionCookieName,
  WEB_AUTH_ENV,
  WEB_PORT_ENV,
  WEB_TOKEN_ENV,
  webAuthDisabled,
} from "@/lib/web-auth";

/**
 * デーモンのAPIを呼ぶ。サーバー側でだけ使う（トークンをブラウザに渡さないため）。
 * 接続先とトークンは `sacty up` が環境変数で渡すので、リクエスト時に読む。
 */
export class DaemonUnavailableError extends Error {}

async function daemonFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await connection();
  const url = process.env.SACTY_DAEMON_URL;
  const token = process.env.SACTY_DAEMON_TOKEN;
  if (!url || !token) {
    throw new DaemonUnavailableError((await getMessages()).common.daemon.notConfigured);
  }
  // 起動した本人のブラウザ（今の起動の cookie）からのリクエストだけを中継する。Proxy でも断るが、Proxy の範囲から外れた
  // 入口（Server Actions など）があっても、デーモンのトークンを使わせない（PBI-129）
  // 認証を OFF にした（config.yaml の web.auth: false。PBI-133）なら確かめない
  const secret = process.env[WEB_TOKEN_ENV];
  const session = (await cookies()).get(sessionCookieName(process.env[WEB_PORT_ENV]))?.value;
  if (!webAuthDisabled(process.env[WEB_AUTH_ENV]) && !isValidSession(session, secret)) {
    const m = (await getMessages()).common.auth;
    throw new DaemonUnavailableError(secret ? m.signIn : m.notConfigured);
  }
  // 画面の取り直しの中なら、ブラウザの中断と期限を、デーモンへの問い合わせ（本文を読む間も）に渡す（PR #119 再レビュー指摘）
  const signal = init.signal ?? currentDaemonSignal();
  try {
    return await fetch(`${url}${path}`, {
      ...init,
      ...(signal ? { signal } : {}),
      cache: "no-store",
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
  } catch {
    throw new DaemonUnavailableError((await getMessages()).common.daemon.unreachable);
  }
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    throw new Error(`daemon responded ${res.status}`);
  }
  return res;
}

/** タスクの一覧。open なら、終わっていないタスクだけ（完了・中止を除く。PBI-114）。 */
export async function listTasks(options: { open?: boolean } = {}): Promise<Task[]> {
  const res = await ensureOk(await daemonFetch(options.open ? "/api/tasks?open=1" : "/api/tasks"));
  return ((await res.json()) as { tasks: Task[] }).tasks;
}

export async function getTask(
  id: string,
): Promise<{ task: Task; activity: ActivityEvent[] } | null> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return (await res.json()) as { task: Task; activity: ActivityEvent[] };
}

/** タスクを作る。作成先のプロジェクトが無いなどは、画面に出せる理由を返す。 */
export async function createTask(
  input: CreateTaskInput | CreateTemplateTaskInput,
): Promise<{ ok: true; task: Task } | { ok: false; message: string }> {
  const res = await daemonFetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  await ensureOk(res);
  return { ok: true, task: ((await res.json()) as { task: Task }).task };
}

export type IntakeStatus = {
  /** 取り込むラベル（sacty の設定。PBI-26）。設定していなければ無い（取り込まない）。 */
  label?: string;
  /** PR のレビューの取り込み（sacty の設定。PBI-44）。 */
  reviewLabel?: string;
  reviewRequested?: boolean;
  /** Off にしたトリアージの種類（PBI-53）。 */
  triageOff?: TriageKind[];
  /** チケットの取り込むラベル（sacty の設定。PBI-52）。 */
  ticketLabel?: string;
  /** 取り込みの種類ごとの、直近の取り込み（PBI-100）。まだ取り込んでいない種類は無い。 */
  runs?: Partial<Record<IntakeKind, IntakeRun>>;
  /** sacty の設定を読めなかった（PBI-100）。 */
  settingsUnreadable?: true;
  /** sacty の設定を読めなかった理由（PBI-100）。 */
  settingsError?: DaemonText;
};

/** 1つの種類の、直近の取り込み（PBI-100）。 */
export type IntakeRun = {
  lastRunAt: string;
  imported: number;
  /** 取り込めなかった対象（検索の条件）と理由。 */
  errors?: { query?: string; message: DaemonText }[];
};

export type DaemonStatus = {
  agent: { id: string; runtime: string; authMode: string } | null;
  problems: DaemonText[];
  /** 動くが、知らせたいこと（認証情報を用意できない組織内 PF など。PBI-35）。古いデーモンには無い。 */
  warnings?: DaemonText[];
  /** 取り込みの状況（設定ファイルを読めなければ null）。 */
  intake: IntakeStatus | null;
  /** プロジェクトの対象で選べる、言語ごとのイメージ（PBI-41）。古いデーモンには無い。 */
  images?: { name: string; description: string }[];
  /** チケットの取り込み先に選べる接続先（PBI-52）。古いデーモンには無い。 */
  platforms?: string[];
  /** 工程のエージェントに選べるもの（config.yaml の agents。PBI-121）。古いデーモンには無い。 */
  agents?: { id: string; runtime: string; model?: string; reasoningEffort?: string }[];
  /** config.yaml で決まる、工程ごとのエージェントの名前（PBI-121）。古いデーモンには無い。 */
  stepAgents?: Partial<Record<StepKey, string>>;
  /** sacty の新しい版（PBI-135）。最新・確かめられない・OFF のときと、古いデーモンには無い。 */
  update?: { behindBy: number; compareUrl: string };
};

export type ProjectView = {
  project: Project;
  exclusions: { org: string; repos: { repo: string; projectName: string }[] }[];
};

export async function listProjects(): Promise<Project[]> {
  const res = await ensureOk(await daemonFetch("/api/projects"));
  return ((await res.json()) as { projects: Project[] }).projects;
}

export async function getProject(id: string): Promise<ProjectView | null> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return (await res.json()) as ProjectView;
}

/**
 * プロジェクトの対象から選べる、タスクの対象リポジトリ（PBI-25）。Org の対象は gh で読む。
 * 読めなかった Org は、理由を返す。
 */
export async function listProjectRepositories(
  id: string,
): Promise<{ repositories: string[]; errors: { org: string; message: DaemonText }[] }> {
  const res = await ensureOk(
    await daemonFetch(`/api/projects/${encodeURIComponent(id)}/repositories`),
  );
  return (await res.json()) as {
    repositories: string[];
    errors: { org: string; message: DaemonText }[];
  };
}

/** 画面に出す外部 PF の要約（PBI-74）。from はコンテキストの層（ホストの config.yaml のものは無い）。 */
export type PlatformSummary = { name: string; from?: string; description: string; allow: string[] };

export type ProjectPlatforms = {
  platforms: PlatformSummary[];
  warnings: DaemonText[];
  /** コンテキストを読めなかった理由（秘密情報は伏せてある）。 */
  error?: DaemonText;
};

/**
 * プロジェクトで使える外部 PF（PBI-74）。ホストの config.yaml の gateway.platforms と、プロジェクトのコンテキストで
 * 合成したもの。古いデーモン（この API が無い）なら undefined。
 */
export async function getProjectPlatforms(id: string): Promise<ProjectPlatforms | undefined> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(id)}/platforms`);
  if (res.status === 404) return undefined;
  await ensureOk(res);
  return (await res.json()) as ProjectPlatforms;
}

/** 設定の画面の URL の印。あれば、画面でコンテキストの誤りを確かめて知らせる（作成・インポートの後。PBI-76）。 */
export const CONTEXT_CHECK_PARAM = "contextCheck";

/**
 * 保存したプロジェクトのコンテキストの誤り（PBI-76。プレビューと同じ検査）。誤りが無い・確かめられない（古いデーモン・
 * プロジェクトが無い）なら undefined。
 */
export async function getProjectContextError(id: string): Promise<DaemonText | undefined> {
  const res = await daemonFetch(
    `/api/projects/${encodeURIComponent(id)}/context-preview?runtime=claude-code`,
  );
  if (!res.ok) return undefined;
  const json = (await res.json()) as { preview?: unknown; error?: DaemonText };
  return json.error;
}

/** コンテキストのプレビューの AI の種類（PBI-76）。 */
export type PreviewRuntime = "claude-code" | "codex";

/** コンテキストの合成の結果のプレビュー（デーモンの ContextPreviewView。PBI-76）。秘密情報は参照の名前だけ。 */
export type ContextPreview = {
  runtime: PreviewRuntime;
  layers: {
    repo: string;
    ref?: string;
    commit: string;
    locked: { skills: string[]; mcp: string[]; platforms: string[] };
    remove: { skills: string[]; mcp: string[]; platforms: string[] };
  }[];
  files: {
    path: string;
    from?: string;
    generated: boolean;
    size: number;
    content?: string;
    binary?: boolean;
    truncated?: boolean;
    omitted?: boolean;
  }[];
  mcp: {
    name: string;
    from: string;
    agent: { command: string; args: string[] } | { url: string };
    origin:
      | { kind: "direct" }
      | {
          kind: "gateway";
          url: string;
          headers: Record<string, string | { secret: string; prefix: string }>;
        }
      | { kind: "host" }
      | {
          kind: "hostCommand";
          command: string;
          args: string[];
          env: Record<string, string | { secret: string; prefix: string }>;
          cwd: string;
        };
    startup_timeout_sec?: number;
    tool_timeout_sec?: number;
  }[];
  skills: { name: string; from: string }[];
  rules: string[];
  agentSettings: string[];
  effects: {
    kind: "skills" | "mcp" | "platforms";
    name: string;
    effect: "removed" | "locked";
    by: string;
    of?: string;
  }[];
  secrets: { env: string; secret: string; prefix: string; gatewayToken: boolean }[];
  env: Record<string, string>;
  platforms: PlatformSummary[];
  warnings: DaemonText[];
};

export type ContextPreviewResult =
  | { ok: true; preview: ContextPreview }
  | { ok: true; error: DaemonText }
  | { ok: false; message: string };

/**
 * プロジェクトのコンテキストのプレビュー（PBI-76）。definition を渡せば、保存していない設定で作る。取得・設定の誤りは
 * error（文言のコード）で、入力の誤り・プロジェクトが無いことは message（画面の言語の文）で返す。
 */
export async function previewProjectContext(
  id: string,
  runtime: PreviewRuntime,
  definition?: ProjectDefinitionInput,
): Promise<ContextPreviewResult> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(id)}/context-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runtime, ...(definition ? { definition } : {}) }),
  });
  if (res.status === 400) return { ok: false, message: await inputMessage(res) };
  if (res.status === 404) {
    return { ok: false, message: (await getMessages()).projects.preview.unavailable };
  }
  await ensureOk(res);
  const json = (await res.json()) as { preview: ContextPreview } | { error: DaemonText };
  return "preview" in json ? { ok: true, preview: json.preview } : { ok: true, error: json.error };
}

/**
 * プロジェクトを作る（id なし）か変える。入力の誤りや重複は、画面に出せる理由を返す。保存したコンテキストに誤りが
 * あれば、contextError に理由を返す（保存はする。PBI-76）。
 */
export async function saveProject(
  id: string | undefined,
  definition: ProjectDefinitionInput,
): Promise<
  { ok: true; project: Project; contextError?: DaemonText } | { ok: false; message: string }
> {
  const res = await daemonFetch(id ? `/api/projects/${encodeURIComponent(id)}` : "/api/projects", {
    method: id ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(definition),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400) {
    return { ok: false, message: await inputMessage(res) };
  }
  await ensureOk(res);
  const json = (await res.json()) as { project: Project; contextError?: DaemonText };
  return {
    ok: true,
    project: json.project,
    ...(json.contextError !== undefined ? { contextError: json.contextError } : {}),
  };
}

/** sacty 全体の設定（取り込むラベルなど。PBI-26）。 */
export async function getSettings(): Promise<SactySettings> {
  const res = await ensureOk(await daemonFetch("/api/settings"));
  return ((await res.json()) as { settings: SactySettings }).settings;
}

/** sacty 全体の設定を変える。入力の誤りは、画面に出せる理由を返す。 */
export async function saveSettings(
  settings: SactySettingsInput,
): Promise<{ ok: true; settings: SactySettings } | { ok: false; message: string }> {
  const res = await daemonFetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (res.status === 400) return { ok: false, message: await inputMessage(res) };
  await ensureOk(res);
  return { ok: true, settings: ((await res.json()) as { settings: SactySettings }).settings };
}

/** プロジェクトの定義のエクスポート（JSON）。無ければ null。 */
export async function exportProject(id: string): Promise<unknown | null> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(id)}/export`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return res.json();
}

/** エクスポートした定義を、新しいプロジェクトとしてインポートする。 */
export async function importProject(
  exported: unknown,
): Promise<{ ok: true; project: Project } | { ok: false; message: string }> {
  const res = await daemonFetch("/api/projects/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(exported),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400) {
    return { ok: false, message: await inputMessage(res, { file: true }) };
  }
  await ensureOk(res);
  return { ok: true, project: ((await res.json()) as { project: Project }).project };
}

export type CleanupItem = { target: CleanupTarget; present: boolean; detail?: DaemonText };

/** 中止したときに片付けるもの（確認の画面に並べる）。 */
export async function getCleanupPlan(id: string): Promise<CleanupItem[] | null> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(id)}/cleanup-plan`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return ((await res.json()) as { plan: CleanupItem[] }).plan;
}

/** 人間が一時停止する（実行中ならコンテナを止める）。 */
export function pauseTask(id: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/pause`, {});
}

/** 中止して、sacty が作ったものを片付ける。 */
export function cancelTask(id: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/cancel`, {});
}

/** レビューを投稿して完了したタスクを、PR の最新のコミットでもう一度レビューする（PBI-44）。 */
export function rereviewTask(id: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/rereview`, {});
}

/** 書き出せなかった承認済みの成果を、書き出し直す（PBI-56）。書き出しは待たない。 */
export function retryExport(id: string, step: string): Promise<OpResult> {
  return postOp(
    `/api/tasks/${encodeURIComponent(id)}/exports/${encodeURIComponent(step)}/retry`,
    {},
  );
}

/** タスクの詳細で、オーケストレーターに質問する（PBI-54）。答えは待たない（画面が答えの出るまで更新する）。 */
export function askQuestion(id: string, text: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/questions`, { text });
}

/** GitHub Issue の取り込みを、間隔を待たずに実行する。 */
/** sacty の設定の通知先に、テストの通知を送る（PBI-38・PBI-115）。 */
export async function testNotification(): Promise<OpResult> {
  return postOp("/api/settings/notification-test", {});
}

/** 使う秘密情報を取り出し直す（PBI-48）。取り出した数と、取り出せなかった理由を返す（値は返さない）。 */
export async function prefetchSecrets(): Promise<{
  total: number;
  /** 取り出せた数（PBI-107。problems には、コンテキストを読めなかった理由も入る）。 */
  fetched: number;
  /** 読めなかったプロジェクトのコンテキストの数（PBI-107。その中の秘密情報は total に入らない）。 */
  unreadContexts: number;
  problems: DaemonText[];
}> {
  const res = await ensureOk(
    await daemonFetch("/api/secrets/prefetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  const json = (await res.json()) as {
    total: number;
    fetched: number;
    unreadContexts?: number;
    problems: DaemonText[];
  };
  return { ...json, unreadContexts: json.unreadContexts ?? 0 };
}

export async function runIntake(): Promise<OpResult> {
  return postOp("/api/intake/run", {});
}

export type GitHubAccounts =
  | { accounts: { host: string; login: string; active: boolean }[] }
  | { error: DaemonText };

/** gh にログイン済みの GitHub のアカウント（PBI-13）。 */
export async function getGitHubAccounts(): Promise<GitHubAccounts> {
  const res = await ensureOk(await daemonFetch("/api/github/accounts"));
  return (await res.json()) as GitHubAccounts;
}

export async function getStatus(): Promise<DaemonStatus> {
  const res = await ensureOk(await daemonFetch("/api/status"));
  return (await res.json()) as DaemonStatus;
}

/** ダッシュボードの集計（対応待ちの時刻・費用・流量・品質・待ち行列。PBI-118）。 */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const res = await ensureOk(await daemonFetch("/api/dashboard"));
  return (await res.json()) as DashboardSummary;
}

/** 再開する。状態に合わない場合は、画面に出せる理由を返す。 */
export async function resumeTask(
  id: string,
  capUsd: number | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(capUsd === undefined ? {} : { capUsd }),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400)
    return { ok: false, message: (await getMessages()).common.daemon.invalidAmount };
  await ensureOk(res);
  return { ok: true };
}

type OpResult = { ok: true } | { ok: false; message: string };

/** チケットのタスクの、作業するリポジトリを人が選ぶ（PBI-52）。 */
export async function chooseTicketRepository(id: string, repo: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/repository`, { repo });
}

/** タスクの詳細で、工程のエージェントを変える（PBI-121）。agent は config.yaml の agents の名前。 */
export async function changeStepAgent(id: string, step: StepKey, agent: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/agents`, { step, agent });
}

/** タスクの詳細で、工程のイメージを変える（PBI-106）。image は images の名前か default。 */
export async function changeStepImage(id: string, step: StepKey, image: string): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/images`, { step, image });
}

async function postOp(path: string, body: unknown): Promise<OpResult> {
  const res = await daemonFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    return { ok: false, message: await operationMessage(res) };
  }
  if (res.status === 400) {
    return { ok: false, message: await inputMessage(res) };
  }
  await ensureOk(res);
  return { ok: true };
}

export function approveStep(id: string, step: StepKey, submission: number): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/approve`, { step, submission });
}

export function requestChanges(
  id: string,
  input: {
    step: StepKey;
    submission: number;
    target?: StepKey;
    comments: string[];
    continueOverLimit: boolean;
  },
): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(id)}/request-changes`, input);
}

export function decideChange(id: string, proposalId: string, accept: boolean): Promise<OpResult> {
  return postOp(
    `/api/tasks/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/decide`,
    { accept },
  );
}

export function voidRemark(id: string, remarkId: string): Promise<OpResult> {
  return postOp(
    `/api/tasks/${encodeURIComponent(id)}/remarks/${encodeURIComponent(remarkId)}/void`,
    {},
  );
}

/** タスクの監査（PBI-124）。監査が無ければ null。 */
export async function getTaskAudit(taskId: string): Promise<TaskAudit | null> {
  const res = await daemonFetch(`/api/tasks/${encodeURIComponent(taskId)}/audit`);
  // 監査の API の無い古いデーモン
  if (res.status === 404) return null;
  await ensureOk(res);
  return ((await res.json()) as { audit: TaskAudit | null }).audit;
}

/** プロジェクトの監査（監査の画面。PBI-124）。プロジェクトが無ければ null。 */
export async function getProjectAudits(projectId: string): Promise<ProjectAudits | null> {
  const res = await daemonFetch(`/api/projects/${encodeURIComponent(projectId)}/audits`);
  if (res.status === 404) return null;
  await ensureOk(res);
  return (await res.json()) as ProjectAudits;
}

/** ダッシュボードの監査の指標（PBI-124）。 */
export async function getAuditDashboard(): Promise<AuditDashboard> {
  const res = await ensureOk(await daemonFetch("/api/audits/dashboard"));
  return (await res.json()) as AuditDashboard;
}

/** 改修の提案を採用する（PBI-124）。宛先は提案の宛先の候補から選ぶ。 */
export function adoptAuditProposal(proposalId: string, target: AuditTarget): Promise<OpResult> {
  return postOp(`/api/audits/proposals/${encodeURIComponent(proposalId)}/adopt`, { target });
}

/** 改修の提案を却下する（PBI-124）。理由は必須。 */
export function rejectAuditProposal(proposalId: string, reason: string): Promise<OpResult> {
  return postOp(`/api/audits/proposals/${encodeURIComponent(proposalId)}/reject`, { reason });
}

/** 監査が登録したメモリーを消す（PBI-126）。 */
export function deleteAuditMemory(memoryId: string): Promise<OpResult> {
  return postOp(`/api/audits/memories/${encodeURIComponent(memoryId)}/delete`, {});
}

/** 予算で一時停止した監査を、新しい上限（累計）で再開する（PBI-124）。 */
export function resumeAudit(taskId: string, capUsd: number): Promise<OpResult> {
  return postOp(`/api/tasks/${encodeURIComponent(taskId)}/audit/resume`, { capUsd });
}

/**
 * 状態に合わない操作（409）の理由を、画面の言語の文にする。デーモンは文言のコードと引数で返す（PBI-11）。
 */
async function operationMessage(res: Response): Promise<string> {
  const { locale } = await getMessages();
  const json = (await res.json()) as { messages?: unknown[]; message?: unknown };
  // 古いデーモンは、日本語の文（message）で返す
  const list = json.messages ?? [json.message];
  return list.map((m) => renderMessage(m, locale)).join("\n");
}

/**
 * 入力の誤り（400）の理由を、画面の言語の文にする。デーモンは誤りを文言のコードと引数で返す（PBI-11）。
 * どの項目の誤りかが分かるように、場所（例：repositories.0.baseBranch）を添える。
 */
async function inputMessage(res: Response, options: { file?: boolean } = {}): Promise<string> {
  const m = await getMessages();
  const json = (await res.json()) as { issues?: { message?: unknown; path?: unknown[] }[] };
  const issue = json.issues?.[0];
  const text = issue?.message
    ? renderMessage(issue.message, m.locale)
    : options.file
      ? m.common.daemon.checkFile
      : m.common.daemon.checkInput;
  return issue?.path?.length ? m.common.daemon.atPath(text, issue.path.join(".")) : text;
}

/** エージェントの実行のセッションログの記録（デーモンの SessionLogMeta。PBI-62）。 */
export type RunLogMeta = {
  runId: string;
  taskId: string;
  role: string;
  agentId: string;
  runtime: string;
  authMode: string;
  model?: string;
  startedAt: string;
  /** 無ければ、終わりを記録できなかった（デーモンが落ちたなど）か、実行中。 */
  finishedAt?: string;
  outcome?: { kind: "completed" } | { kind: "failed"; reason: string; message: DaemonText };
  /** 上限で間を省いたファイルと、省いた大きさ（バイト）・行数。 */
  truncated?: {
    events?: { droppedBytes: number; droppedLines: number };
    stderr?: { droppedBytes: number; droppedLines: number };
  };
  /** 残す先頭と末尾の大きさ（バイト）。 */
  limits: { events: { head: number; tail: number }; stderr: { head: number; tail: number } };
};

export type RunLog = {
  meta: RunLogMeta;
  events: string;
  stderr: string;
  /** 返した文の、ファイルの中の位置（バイト。PR #119 レビュー指摘）。 */
  offsets: { events: { from: number; next: number }; stderr: { from: number; next: number } };
};

const runPath = (taskId: string, runId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`;

/**
 * 実行のセッションログ（PBI-62）。タスク・ログが無い（ID の形が違うことも含む）なら null。from（バイト）を渡すと、
 * 実行中は、その位置より後（足された分）だけを返す（PR #119 レビュー指摘）。
 */
export async function getRunLog(
  taskId: string,
  runId: string,
  from: { events?: number; stderr?: number } = {},
): Promise<RunLog | null> {
  const query = new URLSearchParams();
  if (from.events) query.set("eventsFrom", String(from.events));
  if (from.stderr) query.set("stderrFrom", String(from.stderr));
  const res = await daemonFetch(
    `${runPath(taskId, runId)}/log${query.size > 0 ? `?${query}` : ""}`,
  );
  if (res.status === 404 || res.status === 400) return null;
  await ensureOk(res);
  return (await res.json()) as RunLog;
}

/** セッションログの生のファイル（ダウンロード用。PBI-62）。無ければ null。 */
export async function getRunLogFile(
  taskId: string,
  runId: string,
  file: "events" | "stderr",
): Promise<Response | null> {
  const res = await daemonFetch(`${runPath(taskId, runId)}/files/${file}`);
  if (res.status === 404 || res.status === 400) return null;
  return ensureOk(res);
}

/** 写したエージェントの元のファイル1つと、作業履歴に記録したハッシュとの一致（デーモンの CheckedAgentFile。PBI-66）。 */
export type AgentFile = {
  /** 実行の設定の場所（CLAUDE_CONFIG_DIR・CODEX_HOME）からの相対パス。 */
  path: string;
  bytes: number;
  sha256: string;
  sourceBytes: number;
  truncated?: { droppedBytes: number; droppedLines: number };
  status: "match" | "mismatch" | "missing";
  current?: { bytes: number; sha256: string };
};

export type AgentFiles = {
  runId: string;
  role: string;
  agentId: string;
  runtime: "claude-code" | "codex";
  sessionId?: string;
  limitBytes: number;
  skipped: string[];
  /** 写さなかった理由（files は空）。 */
  notArchived?: "container_not_confirmed";
  archivedAt: string;
  files: AgentFile[];
};

/** 実行で写したエージェントの元のファイル（PBI-66）。写していない（ID の形が違うことも含む）なら null。 */
export async function getAgentFiles(taskId: string, runId: string): Promise<AgentFiles | null> {
  const res = await daemonFetch(`${runPath(taskId, runId)}/agent-files`);
  if (res.status === 404 || res.status === 400) return null;
  await ensureOk(res);
  return (await res.json()) as AgentFiles;
}

/** 写したエージェントの元のファイル1つ（ダウンロード用。PBI-66）。無ければ null。 */
export async function getAgentFile(
  taskId: string,
  runId: string,
  path: string,
): Promise<Response | null> {
  const res = await daemonFetch(
    `${runPath(taskId, runId)}/agent-files/raw?path=${encodeURIComponent(path)}`,
  );
  if (res.status === 404 || res.status === 400) return null;
  return ensureOk(res);
}
