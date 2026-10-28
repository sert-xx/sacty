"use server";

import {
  AUDIT_ADOPT_NOTE_KINDS,
  type AuditAdoptNoteKind,
  AuditTarget,
  CreateTaskInput,
  type ProjectDefinitionInput,
  RESUME_NOTE_MAX,
  renderMessage,
  type SactySettingsInput,
  ScheduleInput,
  SecurityCategory,
  StepKey,
  StepPlan,
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
  adoptAuditProposal,
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
  deleteAuditMemory,
  deleteProject,
  deleteSchedule,
  deriveTask,
  type GitHubAccounts,
  getGitHubAccounts,
  importProject,
  listProjects,
  type PreviewRuntime,
  pauseTask,
  prefetchSecrets,
  previewProjectContext,
  rejectAuditProposal,
  requestChanges,
  requestSecurityFix,
  rereviewTask,
  rerunTask,
  resumeAudit,
  resumeTask,
  retryExport,
  runIntake,
  saveProject,
  saveSchedule,
  saveSettings,
  submitTaskForReview,
  testNotification,
  voidRemark,
} from "@/lib/daemon";
import { projectSchedulesPath, projectSettingsPath, schedulePath } from "@/lib/paths";
import { needsProjectSelect } from "@/lib/project-select";
import { readScheduleForm, type ScheduleFormValues, toScheduleInput } from "@/lib/schedule-form";
import { stepChoicesFrom } from "@/lib/step-options";

export type CreateTaskState = {
  fieldErrors?: { title?: string[]; body?: string[] };
  message?: string;
  values?: { title: string; body: string; repo?: string; template?: TaskTemplate; plan?: string };
};

/** タスクを作成し、作ったタスクの詳細へ移る。 */
export async function createTaskAction(
  _prev: CreateTaskState,
  formData: FormData,
): Promise<CreateTaskState> {
  const repo = String(formData.get("repo") ?? "").trim();
  const plan = String(formData.get("plan") ?? "").trim();
  const template = TaskTemplate.safeParse(formData.get("template"));
  // テンプレートで作る（PBI-90）。題と説明は sacty が決めるので、リポジトリだけを渡す
  if (template.success) return createTemplateTask(template.data, repo, formData);
  // 進め方の工程ごとのイメージ・エージェント。進め方を選んだときだけ送る（名前と工程は、デーモンが検査する）
  const { images, agents } = stepChoicesFrom(formData);
  const values = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    // 対象リポジトリ（PBI-21）。プロジェクトの設定にあるかは、デーモンが検査する
    ...(repo ? { repo } : {}),
    // 工程の組み合わせ（進め方）。空なら自動（オーケストレーターが選ぶ）。タスクの形で選べるかは、デーモンが検査する
    ...(plan ? { plan } : {}),
    ...(plan && Object.keys(images).length > 0 ? { images } : {}),
    ...(plan && Object.keys(agents).length > 0 ? { agents } : {}),
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
    // 工程ごとの指定は、ダイアログの別の画面で選ぶので、項目ではなく理由として出す
    const stepSettings = parsed.error.issues.some(
      (issue) => issue.path[0] === "images" || issue.path[0] === "agents",
    );
    return {
      fieldErrors,
      ...(stepSettings ? { message: a.stepSettingsInvalid } : {}),
      values: shown,
    };
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

export type ScheduleFormState = {
  message?: string;
  /** 項目ごとの誤り（name・time・days・day・title・body）。 */
  fieldErrors?: Partial<Record<string, string>>;
  values?: ScheduleFormValues;
};

/**
 * スケジュールタスクを作る（scheduleId が無いとき）か、変える。保存したら、スケジュールタスクの詳細へ移る。入力の誤りは
 * 項目ごとに、作れない内容（対象リポジトリなど）は理由を返す。
 */
export async function saveScheduleAction(
  _prev: ScheduleFormState,
  formData: FormData,
): Promise<ScheduleFormState> {
  const { locale, common } = await getMessages();
  const values = readScheduleForm(formData);
  const input = toScheduleInput(values);
  const parsed = ScheduleInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: NonNullable<ScheduleFormState["fieldErrors"]> = {};
    for (const issue of parsed.error.issues) {
      // rule.time・task.title などの、最後の項目の名前で返す
      const key = String(issue.path.at(-1) ?? "");
      fieldErrors[key] ??= renderMessage(issue.message, locale);
    }
    return { fieldErrors, values };
  }
  const projectId = String(formData.get("projectId") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  if (!projectId) return { message: common.action.createNoProject, values };
  let result: Awaited<ReturnType<typeof saveSchedule>>;
  try {
    result = await saveSchedule(scheduleId ? { id: scheduleId } : { projectId }, input);
  } catch {
    return { message: common.action.daemonDown, values };
  }
  if (!result.ok) return { message: result.message, values };
  revalidatePath(projectSchedulesPath(projectId), "layout");
  redirect(schedulePath(projectId, result.schedule.id));
}

export type DeleteScheduleState = { message?: string };

/** スケジュールタスクを消し、スケジュールタスクの一覧へ戻る（作ったタスクは残る）。 */
export async function deleteScheduleAction(
  _prev: DeleteScheduleState,
  formData: FormData,
): Promise<DeleteScheduleState> {
  const { common } = await getMessages();
  const projectId = String(formData.get("projectId") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  let result: Awaited<ReturnType<typeof deleteSchedule>>;
  try {
    result = await deleteSchedule(scheduleId);
  } catch {
    return { message: common.action.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  revalidatePath(projectSchedulesPath(projectId), "layout");
  redirect(projectSchedulesPath(projectId));
}

export type ResumeState = {
  message?: string;
  capUsd?: string;
  /** テストのコマンドが決まらずに止まったタスクで選んだテストの扱いと、入力した値（エラーのときに戻す）。 */
  tests?: "command" | "none";
  testCommand?: string;
  noTestsReason?: string;
  /** 再開のときに足す補足（エラーのときに戻す）。 */
  note?: string;
};

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

  // テストのコマンドが決まらずに止まったタスクで、人がテストの扱いを決めた
  const choice = String(formData.get("tests") ?? "");
  const testCommand = String(formData.get("testCommand") ?? "").trim();
  const noTestsReason = String(formData.get("noTestsReason") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const kept: ResumeState = {
    capUsd: capText,
    ...(choice === "command" || choice === "none" ? { tests: choice } : {}),
    testCommand,
    noTestsReason,
    note,
  };
  if (note.length > RESUME_NOTE_MAX) {
    return { ...kept, message: a.resumeNoteTooLong(RESUME_NOTE_MAX) };
  }
  // 再開と一緒に変える工程のイメージ・エージェント（image:<工程>・agent:<工程>。今と同じ名前はデーモンが変えない）
  const images: Partial<Record<StepKey, string>> = {};
  const agents: Partial<Record<StepKey, string>> = {};
  for (const [name, value] of formData.entries()) {
    const [kind, rawStep] = name.split(":");
    const step = StepKey.safeParse(rawStep);
    if (!step.success || typeof value !== "string" || !value) continue;
    if (kind === "image") images[step.data] = value;
    else if (kind === "agent") agents[step.data] = value;
  }
  let tests: { testCommand: string } | { noTestsReason: string } | undefined;
  if (choice === "command") {
    if (!testCommand || testCommand.length > 1000)
      return { ...kept, message: a.testCommandInvalid };
    tests = { testCommand };
  } else if (choice === "none") {
    if (!noTestsReason || noTestsReason.length > 2000) {
      return { ...kept, message: a.noTestsReasonInvalid };
    }
    tests = { noTestsReason };
  }

  // チケットのタスクで、リポジトリを人が選んだ（PBI-52）
  const repo = String(formData.get("repo") ?? "");
  try {
    if (repo) {
      const chosen = await chooseTicketRepository(taskId, repo);
      if (!chosen.ok) return { ...kept, message: chosen.message };
    }
    const result = await resumeTask(taskId, capUsd, tests, { note, images, agents });
    if (!result.ok) return { ...kept, message: result.message };
  } catch {
    return { ...kept, message: a.resumeFailed };
  }
  refresh();
  return {};
}

/** 実装の検証が続けて通らずに止まったタスクを、人の判断でレビュー（実装の承認）へ進める。 */
export async function submitForReviewAction(
  _prev: { message?: string },
  formData: FormData,
): Promise<{ message?: string }> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  try {
    const result = await submitTaskForReview(taskId);
    if (!result.ok) return { message: result.message };
  } catch {
    return { message: a.toReviewFailed };
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

export type DeleteProjectState = { message?: string };

/**
 * プロジェクトを削除する（プロジェクトの設定の「危険な操作」）。打ち間違いで消さないよう、確認に入力したプロジェクトの名前が
 * 一致したときだけ消す。消したらプロジェクトの一覧へ移る（表示しているプロジェクトは、cookie のプロジェクトが無ければ
 * 最初のプロジェクトになる）。
 */
export async function deleteProjectAction(
  _prev: DeleteProjectState,
  formData: FormData,
): Promise<DeleteProjectState> {
  const messages = await getMessages();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id || String(formData.get("confirm") ?? "") !== name) {
    return { message: messages.projects.danger.mismatch };
  }
  let result: Awaited<ReturnType<typeof deleteProject>>;
  try {
    result = await deleteProject(id);
  } catch {
    return { message: messages.common.action.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  // ヘッダー・サイドメニューのプロジェクトも作り直す。redirect は例外で画面を移すので、try の外で呼ぶ
  revalidatePath("/", "layout");
  redirect("/projects");
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

/** アカウントの読み直しの期限。gh auth status は、届かない GitHub Enterprise Server を待つことがあるので長めにする。 */
const RELOAD_GITHUB_ACCOUNTS_TIMEOUT_MS = 30_000;

/**
 * gh にログイン済みのアカウントを読み直す（gh auth status をもう一度確かめる）。画面で gh にログインし直したあと、
 * 編集中の入力を残したまま選べるアカウントを新しくする。デーモンに届かない・期限までに答えなければ、その理由
 * （応答しないデーモンを待ち続けて、ボタンが止まったままにならないようにする。PR #194 レビュー指摘）。
 */
export async function reloadGitHubAccountsAction(): Promise<GitHubAccounts> {
  const signal = AbortSignal.timeout(RELOAD_GITHUB_ACCOUNTS_TIMEOUT_MS);
  try {
    return await getGitHubAccounts(signal);
  } catch {
    const messages = await getMessages();
    return {
      error: signal.aborted
        ? messages.projects.editor.githubReloadTimeout
        : messages.common.action.daemonDown,
    };
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
      // レビューの投稿で、PR の作者ではなく自分にメンションする
      reviewMentionSelf: formData.get("reviewMentionSelf") === "on",
      // チェックを外した種類を Off にする（PBI-53）
      // チケット（PBI-52）
      ticketLabel: String(formData.get("ticketLabel") ?? ""),
      triageOff: (["issues", "reviewLabel", "tickets"] as const).filter(
        (kind) => formData.get(`triage-${kind}`) !== "on",
      ),
      maxParallelTasks: String(formData.get("maxParallelTasks") ?? ""),
      // メモリーを残す日数（PBI-127）
      memoryRetentionDays: String(formData.get("memoryRetentionDays") ?? ""),
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

/** 承認したセキュリティチェックのレポートの区分から、セキュリティ対応のタスクを作る。 */
export async function requestSecurityFixAction(
  _prev: TaskControlState,
  formData: FormData,
): Promise<TaskControlState> {
  const a = (await getMessages()).common.action;
  const category = SecurityCategory.safeParse(formData.get("category"));
  if (!category.success) return { message: a.invalidCategory };
  let result: Awaited<ReturnType<typeof requestSecurityFix>>;
  try {
    result = await requestSecurityFix(String(formData.get("taskId") ?? ""), category.data);
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

export type RerunTaskState = {
  message?: string;
  values?: { title: string; body: string; note: string; repo: string; image: string };
};

/**
 * 中止したタスクを、最初からやり直す（再実行）。作ったタスクの詳細に移る。リポジトリが空欄なら、リポジトリを指定しない。
 * イメージが空なら、いつもどおり決める。入力の検査・リポジトリとイメージの確かめは、デーモンが行う。
 */
export async function rerunTaskAction(
  _prev: RerunTaskState,
  formData: FormData,
): Promise<RerunTaskState> {
  const a = (await getMessages()).common.action;
  const values = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    note: String(formData.get("note") ?? ""),
    repo: String(formData.get("repo") ?? "").trim(),
    image: String(formData.get("image") ?? "").trim(),
  };
  let result: Awaited<ReturnType<typeof rerunTask>>;
  try {
    result = await rerunTask(String(formData.get("taskId") ?? ""), {
      title: values.title,
      body: values.body,
      note: values.note,
      repo: values.repo || null,
      ...(values.image ? { image: values.image } : {}),
    });
  } catch {
    return { message: a.daemonDown, values };
  }
  if (!result.ok) return { message: result.message, values };
  refresh();
  redirect(`/tasks/${encodeURIComponent(result.task.id)}`);
}

export type DeriveTaskState = {
  message?: string;
  values?: { title: string; body: string; repo: string; plan: string };
};

/**
 * 完了したタスクから、続きの作業のタスクを作る（派生）。作ったタスクの詳細に移る。リポジトリが空欄なら、リポジトリを
 * 指定しない。進め方が空なら、オーケストレーターが選ぶ。入力の検査・リポジトリと進め方の確かめは、デーモンが行う。
 */
export async function deriveTaskAction(
  _prev: DeriveTaskState,
  formData: FormData,
): Promise<DeriveTaskState> {
  const a = (await getMessages()).common.action;
  const values = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    repo: String(formData.get("repo") ?? "").trim(),
    plan: String(formData.get("plan") ?? ""),
  };
  const plan = StepPlan.safeParse(values.plan);
  let result: Awaited<ReturnType<typeof deriveTask>>;
  try {
    result = await deriveTask(String(formData.get("taskId") ?? ""), {
      title: values.title,
      body: values.body,
      repo: values.repo || null,
      ...(plan.success ? { plan: plan.data } : {}),
    });
  } catch {
    return { message: a.daemonDown, values };
  }
  if (!result.ok) return { message: result.message, values };
  refresh();
  redirect(`/tasks/${encodeURIComponent(result.task.id)}`);
}

export type AuditProposalState = {
  message?: string;
  reason?: string;
  /** 採用に添える手入れ（入力をやり直すときに残す。PBI-151）。 */
  note?: string;
  noteKind?: AuditAdoptNoteKind;
};

/**
 * 監査の改修の提案を採用する（PBI-124）。宛先は選んだ候補（JSON）。手入れ（`noteKind` と `note`）を書いていれば
 * 添える。原因は認めつつ、改善案に補足する・人の案に差し替えるときに使う（PBI-151）。
 */
export async function adoptAuditProposalAction(
  _prev: AuditProposalState,
  formData: FormData,
): Promise<AuditProposalState> {
  const a = (await getMessages()).common.action;
  const proposalId = String(formData.get("proposalId") ?? "");
  const text = String(formData.get("note") ?? "").trim();
  const kindValue = String(formData.get("noteKind") ?? "");
  const noteKind = AUDIT_ADOPT_NOTE_KINDS.find((k) => k === kindValue);
  const values = { ...(text ? { note: text } : {}), ...(noteKind ? { noteKind } : {}) };
  let target: AuditTarget;
  try {
    target = AuditTarget.parse(JSON.parse(String(formData.get("target") ?? "")));
  } catch {
    return { message: a.invalidTarget, ...values };
  }
  // 種類だけ選んで中身が空、中身を書いて種類が無いときは、どちらを採用するかが決まらないので断る
  if (text && !noteKind) return { message: a.invalidAdoptNote, ...values };
  if (!text && kindValue) return { message: a.adoptNoteRequired, ...values };
  let result: Awaited<ReturnType<typeof adoptAuditProposal>>;
  try {
    result = await adoptAuditProposal(
      proposalId,
      target,
      text && noteKind ? { kind: noteKind, text } : undefined,
    );
  } catch {
    return { message: a.daemonDown, ...values };
  }
  if (!result.ok) return { message: result.message, ...values };
  refresh();
  return {};
}

/** 監査の改修の提案を、理由を添えて却下する（PBI-124）。 */
export async function rejectAuditProposalAction(
  _prev: AuditProposalState,
  formData: FormData,
): Promise<AuditProposalState> {
  const a = (await getMessages()).common.action;
  const proposalId = String(formData.get("proposalId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  let result: Awaited<ReturnType<typeof rejectAuditProposal>>;
  try {
    result = await rejectAuditProposal(proposalId, reason);
  } catch {
    return { message: a.daemonDown, reason };
  }
  if (!result.ok) return { message: result.message, reason };
  refresh();
  return {};
}

export type DeleteAuditMemoryState = { message?: string };

/** 監査が登録したメモリーを消す（PBI-126）。 */
export async function deleteAuditMemoryAction(
  _prev: DeleteAuditMemoryState,
  formData: FormData,
): Promise<DeleteAuditMemoryState> {
  const a = (await getMessages()).common.action;
  let result: Awaited<ReturnType<typeof deleteAuditMemory>>;
  try {
    result = await deleteAuditMemory(String(formData.get("memoryId") ?? ""));
  } catch {
    return { message: a.daemonDown };
  }
  if (!result.ok) return { message: result.message };
  refresh();
  return {};
}

export type ResumeAuditState = { message?: string; capUsd?: string };

/** 予算で一時停止した監査を、新しい上限で再開する（PBI-124）。 */
export async function resumeAuditAction(
  _prev: ResumeAuditState,
  formData: FormData,
): Promise<ResumeAuditState> {
  const a = (await getMessages()).common.action;
  const taskId = String(formData.get("taskId") ?? "");
  const capText = String(formData.get("capUsd") ?? "").trim();
  const capUsd = Number(capText);
  if (!capText || !Number.isFinite(capUsd) || capUsd <= 0) {
    return { message: a.capPositive, capUsd: capText };
  }
  let result: Awaited<ReturnType<typeof resumeAudit>>;
  try {
    result = await resumeAudit(taskId, capUsd);
  } catch {
    return { message: a.daemonDown, capUsd: capText };
  }
  if (!result.ok) return { message: result.message, capUsd: capText };
  refresh();
  return {};
}
