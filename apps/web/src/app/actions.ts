"use server";

import {
  CreateTaskInput,
  type ProjectDefinitionInput,
  renderMessage,
  type SactySettingsInput,
  StepKey,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
  TaskTemplate,
} from "@sacty/core";
import { refresh, revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, LANG_COOKIE, type LanguagePreference } from "@/i18n/locale";
import { getMessages } from "@/i18n/server";
import { currentProjectId, selectProject } from "@/lib/current-project";
import {
  approveStep,
  askQuestion,
  CONTEXT_CHECK_PARAM,
  type ContextPreviewResult,
  cancelTask,
  changeStepAgent,
  changeStepImage,
  chooseTicketRepository,
  createTask,
  decideChange,
  importProject,
  listProjects,
  type PreviewRuntime,
  pauseTask,
  prefetchSecrets,
  previewProjectContext,
  requestChanges,
  rereviewTask,
  resumeTask,
  retryExport,
  runIntake,
  saveProject,
  saveSettings,
  testNotification,
  voidRemark,
} from "@/lib/daemon";
import { projectSettingsPath } from "@/lib/paths";
import { needsProjectSelect } from "@/lib/project-select";

export type CreateTaskState = {
  fieldErrors?: { title?: string[]; body?: string[] };
  message?: string;
  values?: { title: string; body: string; repo?: string; template?: TaskTemplate };
};

/** タスクを作成し、作ったタスクの詳細へ移る。 */
export async function createTaskAction(
  _prev: CreateTaskState,
  formData: FormData,
): Promise<CreateTaskState> {
  const repo = String(formData.get("repo") ?? "").trim();
  const template = TaskTemplate.safeParse(formData.get("template"));
  // テンプレートで作る（PBI-90）。題と説明は sacty が決めるので、リポジトリだけを渡す
  if (template.success) return createTemplateTask(template.data, repo, formData);
  const values = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    // 対象リポジトリ（PBI-21）。プロジェクトの設定にあるかは、デーモンが検査する
    ...(repo ? { repo } : {}),
  };
  const a = (await getMessages()).common.action;
  // 作成先のプロジェクトは、下で別に確かめる（無ければ、入力の誤りではなく理由を返す）
  const parsed = CreateTaskInput.omit({ projectId: true }).safeParse(values);
  // 空欄にした対象リポジトリも、空欄のまま入力に戻す（対象がリポジトリ1つだけのときの既定の値に戻さない。PBI-73）
  const shown = { ...values, repo };
  if (!parsed.success) {
    // 検査の結果を、画面の言語の文言にする
    const fieldErrors: NonNullable<CreateTaskState["fieldErrors"]> = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "title") {
        fieldErrors.title = [
          issue.code === "too_big" ? a.titleTooLong(TASK_TITLE_MAX) : a.titleRequired,
        ];
      }
      if (issue.path[0] === "body") fieldErrors.body = [a.bodyTooLong(TASK_BODY_MAX)];
    }
    return { fieldErrors, values: shown };
  }

  // 作成先は、フォームを表示したときのプロジェクト（送信時の cookie ではない）。存在はデーモンが検査する
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) {
    return { message: a.createNoProject, values: shown };
  }
  let result: Awaited<ReturnType<typeof createTask>>;
  try {
    // 空欄なら、リポジトリを指定しない（対象がリポジトリ1つだけでも。PBI-73）
    result = await createTask({ ...parsed.data, repo: parsed.data.repo ?? null, projectId });
  } catch {
    return { message: a.createFailed, values: shown };
  }
  if (!result.ok) return { message: result.message, values: shown };
  const taskId = result.task.id;
  // 移る先の画面だけでなく、ヘッダー（お知らせ・実行中の間の更新）も描き直す（PBI-98）
  refresh();
  redirect(`/tasks/${taskId}`);
}

/**
 * テンプレートからタスクを作る（PBI-90）。対象リポジトリを空欄にしたら省略し、プロジェクトの対象がリポジトリ1つだけなら
 * デーモンがそれにする（そうでなければ、理由を返す）。
 */
async function createTemplateTask(
  template: TaskTemplate,
  repo: string,
  formData: FormData,
): Promise<CreateTaskState> {
  const a = (await getMessages()).common.action;
  const shown = { title: "", body: "", repo, template };
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return { message: a.createNoProject, values: shown };
  let result: Awaited<ReturnType<typeof createTask>>;
  try {
    result = await createTask({ template, projectId, ...(repo ? { repo } : {}) });
  } catch {
    return { message: a.createFailed, values: shown };
  }
  if (!result.ok) return { message: result.message, values: shown };
  refresh();
  redirect(`/tasks/${result.task.id}`);
}

export type ResumeState = { message?: string; capUsd?: string };

/** 一時停止中のタスクを再開する。予算で止まった場合は、累計の新しい上限を受け取る。 */
export async function resumeTaskAction(
  _prev: ResumeState,
  formData: FormData,
): Promise<ResumeState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const rawCap = formData.get("capUsd");
  const capText = typeof rawCap === "string" ? rawCap.trim() : "";
  let capUsd: number | undefined;
  if (capText) {
    capUsd = Number(capText);
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      return { message: a.capPositive, capUsd: capText };
    }
  }

  // チケットのタスクで、リポジトリを人が選んだ（PBI-52）
  const repo = String(formData.get("repo") ?? "");
  try {
    if (repo) {
      const chosen = await chooseTicketRepository(taskId, repo);
      if (!chosen.ok) return { message: chosen.message, capUsd: capText };
    }
    const result = await resumeTask(taskId, capUsd);
    if (!result.ok) return { message: result.message, capUsd: capText };
  } catch {
    return { message: a.resumeFailed, capUsd: capText };
  }
  refresh();
  return {};
}

export type GateState = { message?: string; comments?: string; target?: StepKey };

/** 承認ゲートでの判断（承認・差し戻し・上限を超えた差し戻し）。どれを押したかは decision で受け取る。 */
export async function gateAction(_prev: GateState, formData: FormData): Promise<GateState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const step = StepKey.safeParse(formData.get("step"));
  const decision = String(formData.get("decision") ?? "");
  const comments = String(formData.get("comments") ?? "");
  const submission = Number(formData.get("submission"));
  const rawTarget = formData.get("target");
  const target = rawTarget === null ? undefined : StepKey.safeParse(rawTarget).data;
  if (!step.success || (rawTarget !== null && !target)) {
    return { message: a.invalidStep, comments };
  }
  if (!Number.isInteger(submission) || submission < 1) {
    return { message: a.invalidSubmission, comments };
  }

  let result: Awaited<ReturnType<typeof approveStep>>;
  try {
    if (decision === "approve") {
      result = await approveStep(taskId, step.data, submission);
    } else {
      const lines = comments
        .split("\n")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      result = await requestChanges(taskId, {
        step: step.data,
        submission,
        target,
        comments: lines,
        continueOverLimit: decision === "continue",
      });
    }
  } catch {
    return { message: a.daemonDown, comments, target };
  }
  if (!result.ok) return { message: result.message, comments, target };
  // 承認・差し戻しでお知らせの対象が変わるので、ヘッダーも描き直す（redirect だけでは、移る先の画面と共通のレイアウト
  // ＝ヘッダーは描き直されず、古いお知らせが残る。PBI-98）
  refresh();
  // redirect は例外で画面を移すので、try の外で呼ぶ
  redirect(`/tasks/${taskId}`);
}

export async function voidRemarkAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get("taskId") ?? "");
  const remarkId = String(formData.get("remarkId") ?? "");
  await voidRemark(taskId, remarkId);
  refresh();
}

export type ChangeStepImageState = { message?: string };

/** タスクの詳細で、工程のイメージを変える（PBI-106）。images に無い名前は、デーモンが理由を示して断る。 */
export async function changeStepImageAction(
  _prev: ChangeStepImageState,
  formData: FormData,
): Promise<ChangeStepImageState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const step = StepKey.safeParse(formData.get("step"));
  const image = String(formData.get("image") ?? "");
  if (!step.success) return { message: a.invalidStep };
  let result: Awaited<ReturnType<typeof changeStepImage>>;
  try {
    result = await changeStepImage(taskId, step.data, image);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

export type ChangeStepAgentState = { message?: string };

/** タスクの詳細で、工程のエージェントを変える（PBI-121）。agents に無い名前は、デーモンが理由を示して断る。 */
export async function changeStepAgentAction(
  _prev: ChangeStepAgentState,
  formData: FormData,
): Promise<ChangeStepAgentState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const step = StepKey.safeParse(formData.get("step"));
  const agent = String(formData.get("agent") ?? "");
  if (!step.success) return { message: a.invalidStep };
  let result: Awaited<ReturnType<typeof changeStepAgent>>;
  try {
    result = await changeStepAgent(taskId, step.data, agent);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

export type DecideChangeState = { message?: string };

/** ゴールガーディアンが判定できなかった変更の申し出を、認めるか認めないかを決める。 */
export async function decideChangeAction(
  _prev: DecideChangeState,
  formData: FormData,
): Promise<DecideChangeState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const proposalId = String(formData.get("proposalId") ?? "");
  const accept = formData.get("decision") === "accept";
  let result: Awaited<ReturnType<typeof decideChange>>;
  try {
    result = await decideChange(taskId, proposalId, accept);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

/**
 * message は保存できなかった理由。contextError は、保存したがコンテキストに誤りがあること（PBI-76。画面の言語の文）。
 */
export type SaveProjectState = { message?: string; saved?: boolean; contextError?: string };

/** プロジェクトを作る・変える。定義は編集画面が JSON にまとめて送る。 */
export async function saveProjectAction(
  _prev: SaveProjectState,
  formData: FormData,
): Promise<SaveProjectState> {
  const a = (await getMessages()).common.action;
  const id = String(formData.get("id") ?? "") || undefined;
  let definition: unknown;
  try {
    definition = JSON.parse(String(formData.get("definition") ?? ""));
  } catch {
    return { message: a.unreadableInput };
  }
  let result: Awaited<ReturnType<typeof saveProject>>;
  try {
    result = await saveProject(id, definition as ProjectDefinitionInput);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  // 保存したコンテキストの誤り（PBI-76）。保存はしたので、知らせるだけにする
  if (!id) {
    // 最初のプロジェクトなら、作成画面だけを出していた画面の枠（ヘッダー・サイドメニュー）も作り直す（PBI-22）
    revalidatePath("/", "layout");
    // 作ったプロジェクトを、表示しているプロジェクトにする（設定の画面に移るので、ヘッダーもそのプロジェクトにする。PBI-98）
    await selectProject(result.project.id);
    // コンテキストに誤りがあれば、移った先の設定の画面で確かめ直して知らせる（PBI-76）
    redirect(projectSettingsPathAfterSave(result.project.id, result.contextError !== undefined));
  }
  const contextError =
    result.contextError !== undefined
      ? renderMessage(result.contextError, (await getMessages()).locale)
      : undefined;
  refresh();
  return { saved: true, ...(contextError ? { contextError } : {}) };
}

/**
 * プロジェクトのコンテキストの合成の結果をプレビューする（PBI-76）。definition は編集画面が JSON にまとめた、保存して
 * いない設定（空なら保存した設定）。
 */
export async function previewContextAction(
  id: string,
  runtime: PreviewRuntime,
  definition: string,
): Promise<ContextPreviewResult> {
  const a = (await getMessages()).common.action;
  let parsed: ProjectDefinitionInput | undefined;
  if (definition) {
    try {
      parsed = JSON.parse(definition) as ProjectDefinitionInput;
    } catch {
      return { ok: false, message: a.unreadableInput };
    }
  }
  try {
    return await previewProjectContext(id, runtime, parsed);
  } catch {
    return { ok: false, message: a.daemonDown };
  }
}

export type SaveSettingsState = { message?: string; saved?: boolean };

/** sacty 全体の設定（取り込むラベルなど。PBI-26）を保存する。 */
export async function saveSettingsAction(
  _prev: SaveSettingsState,
  formData: FormData,
): Promise<SaveSettingsState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof saveSettings>>;
  try {
    result = await saveSettings({
      intakeLabel: String(formData.get("intakeLabel") ?? ""),
      // PR のレビューの取り込み（PBI-44）
      reviewLabel: String(formData.get("reviewLabel") ?? ""),
      reviewRequested: formData.get("reviewRequested") === "on",
      // チェックを外した種類を Off にする（PBI-53）
      // チケット（PBI-52）
      ticketLabel: String(formData.get("ticketLabel") ?? ""),
      triageOff: (["issues", "reviewLabel", "tickets"] as const).filter(
        (kind) => formData.get(`triage-${kind}`) !== "on",
      ),
      maxParallelTasks: String(formData.get("maxParallelTasks") ?? ""),
      // 取り込みの種類ごとの間隔（PBI-100）
      issueIntervalSec: String(formData.get("issueIntervalSec") ?? ""),
      reviewIntervalSec: String(formData.get("reviewIntervalSec") ?? ""),
      ticketIntervalSec: String(formData.get("ticketIntervalSec") ?? ""),
      // Slack の通知先（PBI-115）。画面が JSON で渡す。空なら通知しない
      ...notificationInput(formData.get("notification")),
    });
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return { saved: true };
}

/**
 * 画面の通知先の入力（JSON）。空なら通知しない。読めない JSON は、そのまま渡してデーモンの検査で断る（黙って消さない）。
 */
function notificationInput(
  value: FormDataEntryValue | null,
): Pick<SactySettingsInput, "notification"> {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return {};
  let notification: unknown;
  try {
    notification = JSON.parse(text);
  } catch {
    notification = text;
  }
  return { notification } as Pick<SactySettingsInput, "notification">;
}

export type TestNotificationState = { message?: string; sent?: boolean };

/** sacty の設定の通知先に、テストの通知を送る（保存済みの設定で送る。PBI-38・PBI-115）。 */
export async function testNotificationAction(
  _prev: TestNotificationState,
  _formData: FormData,
): Promise<TestNotificationState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof testNotification>>;
  try {
    result = await testNotification();
  } catch {
    return { message: a.daemonDown };
  }
  // 送れなかった理由の警告（sacty の設定の画面に出す）を、今の状態に描き直す
  refresh();
  return result.ok ? { sent: true } : { message: result.message };
}

export type PrefetchSecretsState = {
  message?: string;
  total?: number;
  fetched?: number;
  unreadContexts?: number;
  problems?: string[];
};

/** 使う秘密情報を取り出し直す（PBI-48）。1Password はまとめて取り出すので、認証は1回。 */
export async function prefetchSecretsAction(): Promise<PrefetchSecretsState> {
  const messages = await getMessages();
  try {
    const { total, fetched, unreadContexts, problems } = await prefetchSecrets();
    refresh();
    return {
      total,
      fetched,
      unreadContexts,
      problems: problems.map((p) => messages.labels.text(p)),
    };
  } catch {
    return { message: messages.common.action.daemonDown };
  }
}

export async function runIntakeAction(): Promise<void> {
  await runIntake();
  refresh();
}

export type ImportProjectState = { message?: string };

/** ファイルの大きさの上限（プロジェクトの定義なので、十分に小さい）。 */
const IMPORT_MAX_BYTES = 1_000_000;

/** エクスポートしたプロジェクトの定義のファイルを、新しいプロジェクトとしてインポートする。 */
export async function importProjectAction(
  _prev: ImportProjectState,
  formData: FormData,
): Promise<ImportProjectState> {
  const a = (await getMessages()).common.action;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { message: a.chooseFile };
  }
  if (file.size > IMPORT_MAX_BYTES) {
    return { message: a.fileTooLarge };
  }
  let exported: unknown;
  try {
    exported = JSON.parse(await file.text());
  } catch {
    return { message: a.notJson };
  }
  let result: Awaited<ReturnType<typeof importProject>>;
  try {
    result = await importProject(exported);
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  // 最初のプロジェクトなら、作成画面だけを出していた画面の枠も作り直す（PBI-22）。
  // redirect は例外で画面を移すので、try の外で呼ぶ
  revalidatePath("/", "layout");
  // インポートしたプロジェクトを、表示しているプロジェクトにする（PBI-98）
  await selectProject(result.project.id);
  // コンテキストリポジトリを持つ定義なら、移った先の設定の画面で誤りを確かめて知らせる（PBI-76）
  redirect(projectSettingsPathAfterSave(result.project.id, result.project.context !== undefined));
}

/**
 * プロジェクトの設定の画面の URL。contextCheck なら、画面でコンテキストの誤りを確かめて知らせる（PBI-76。作成・インポート
 * の後は画面を移るので、保存の結果の誤りをその場では出せないため）。
 */
function projectSettingsPathAfterSave(id: string, contextCheck: boolean): string {
  return `${projectSettingsPath(id)}${contextCheck ? `?${CONTEXT_CHECK_PARAM}=1` : ""}`;
}

/**
 * 表示しているプロジェクトを、開いた画面のプロジェクトに合わせる（PBI-98）。cookie を変えると、画面とヘッダーが
 * 描き直される。ID の形が違えば何もしない。
 */
export async function selectProjectAction(id: string): Promise<void> {
  await selectProject(id);
}

/**
 * 描いたときにデーモンに届かなかった画面で、後から取り直した中身のプロジェクトに合わせる（PR #119 レビュー指摘）。
 * FollowProject と同じく、表示しているプロジェクト（cookie）と違うときだけ、デーモンのプロジェクトの一覧にあれば合わせる
 * （一覧を取れなければ、無いとは扱わずに合わせる）。同じなら何もしない（画面を描き直さない）。
 */
export async function followProjectAction(id: string): Promise<void> {
  if (!needsProjectSelect(await currentProjectId(), id)) return;
  const exists = await listProjects()
    .then((projects) => projects.some((p) => p.id === id))
    .catch(() => undefined);
  if (exists === false) return;
  await selectProject(id);
}

/** 画面の言語を選ぶ（system はブラウザの言語に従う）。 */
export async function setLanguageAction(preference: LanguagePreference): Promise<void> {
  const store = await cookies();
  if (isLocale(preference)) {
    store.set(LANG_COOKIE, preference, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    store.delete(LANG_COOKIE);
  }
  refresh();
}

export type TaskControlState = { message?: string };

/** 人間が一時停止する。 */
export async function pauseTaskAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof pauseTask>>;
  try {
    result = await pauseTask(String(formData.get("taskId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

/** 再レビュー（PBI-44）。PR の最新のコミットでもう一度レビューして投稿する。 */
export async function rereviewTaskAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof rereviewTask>>;
  try {
    result = await rereviewTask(String(formData.get("taskId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

/** 書き出せなかった承認済みの成果を、書き出し直す（PBI-56）。 */
export async function retryExportAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof retryExport>>;
  try {
    result = await retryExport(
      String(formData.get("taskId") ?? ""),
      String(formData.get("step") ?? ""),
    );
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

export type QuestionState = { message?: string; text?: string };

/** タスクの詳細で、オーケストレーターに質問する（PBI-54）。送れなければ、書いた質問を残して理由を出す。 */
export async function askQuestionAction(
  _prev: QuestionState,
  formData: FormData,
): Promise<QuestionState> {
  const a = (await getMessages()).common.action;
  const text = String(formData.get("text") ?? "");
  let result: Awaited<ReturnType<typeof askQuestion>>;
  try {
    result = await askQuestion(String(formData.get("taskId") ?? ""), text);
  } catch {
    return { message: a.daemonDown, text };
  }
  if (!result.ok) return { message: result.message, text };
  refresh();
  return {};
}

/** 中止して、sacty が作ったものを片付ける。 */
export async function cancelTaskAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof cancelTask>>;
  try {
    result = await cancelTask(String(formData.get("taskId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}
