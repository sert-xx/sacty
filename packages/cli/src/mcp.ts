/**
 * `sacty mcp`（PBI-392）が、起動中の sacty のデーモンの API を呼ぶところ。ツールの定義は @sacty/daemon/task-mcp にある。
 * 接続先とトークンは、呼び出しのたびに SACTY_HOME の daemon.json から読む（`sacty up` を起動し直すとトークンが変わるので、
 * MCP サーバーを起動し直さなくても、新しい接続先に問い合わせる）。
 */
import type { ActivityEvent, Task } from "@sacty/core";
import { renderMessage } from "@sacty/core";
import {
  type CleanupPlanItem,
  type ProjectChoice,
  READ_REASONS,
  readFailure,
  type SactyApi,
  STALE_LOGS_HEADER,
  STALE_LOGS_OMIT,
  STALE_LOGS_OMITTED,
  STALE_LOGS_QUERY,
  staleChangesMessage,
} from "@sacty/daemon/task-mcp";
import {
  DAEMON_AUTH_MESSAGE,
  DAEMON_TIMEOUT_MESSAGE,
  type DaemonEndpoint,
  daemonRequest,
  type Fetch,
  isTimeout,
  readDaemonFile,
} from "./context-preview.js";

/** デーモンが、応答で断った（操作できない状態・想定外の状態コード）。頼んだことは、行われていない。 */
class DaemonRefusal extends Error {}

/** デーモンが断った理由（{ error: "invalid_operation", messages }）を、文にする。読めなければ、状態コードを伝える。 */
async function refusal(
  res: Response,
  rewrite?: (message: { code?: unknown; params?: unknown }) => string | undefined,
): Promise<DaemonRefusal> {
  const json = (await res.json().catch(() => undefined)) as
    | { error?: unknown; messages?: unknown; issues?: unknown }
    | undefined;
  if (json?.error === "invalid_operation" && Array.isArray(json.messages)) {
    const text = json.messages
      .map((m) => rewrite?.(m as { code?: unknown; params?: unknown }) ?? renderMessage(m, "ja"))
      .join("\n");
    if (text) return new DaemonRefusal(text);
  }
  // 入力の誤り（題が空など）は、誤りごとの文言のコードで返る
  if (json?.error === "invalid_input" && Array.isArray(json.issues)) {
    const text = json.issues
      .map((issue) => renderMessage((issue as { message?: unknown } | null)?.message, "ja"))
      .filter(Boolean)
      .join("\n");
    if (text) return new DaemonRefusal(text);
  }
  return new DaemonRefusal(`デーモンが ${res.status} を返しました。`);
}

/** 古い提出の断りは、画面の「画面を更新して」ではなく、MCP で次にすることを伝える。 */
function staleForMcp(message: { code?: unknown; params?: unknown }): string | undefined {
  if (message.code !== "gate.staleSubmission") return undefined;
  const { submission, current } = (message.params ?? {}) as {
    submission?: unknown;
    current?: unknown;
  };
  return `指定した提出（${String(submission)}回目）は、いまの承認待ち（${String(current)}回目）と違うため、承認しませんでした。get_task の approval で最新の提出の回を確かめ、成果物（list_deliverables・get_deliverable）を確かめ直してから、submission を指定し直してください。`;
}

/** 古い提出の差し戻しの断りは、承認と同じく、MCP で次にすることを伝える（差し戻しの文）。 */
function staleChangesForMcp(message: { code?: unknown; params?: unknown }): string | undefined {
  if (message.code !== "gate.staleSubmission") return undefined;
  const { submission, current } = (message.params ?? {}) as {
    submission?: unknown;
    current?: unknown;
  };
  return staleChangesMessage(submission, current);
}

/** 要求が処理されなかったと分かる失敗（認証できない・接続を断られた）か。 */
function notSent(error: unknown): boolean {
  if (error instanceof Error && error.message === DAEMON_AUTH_MESSAGE) return true;
  for (let e: unknown = error, i = 0; e instanceof Error && i < 5; e = e.cause, i++) {
    if ((e as { code?: unknown }).code === "ECONNREFUSED") return true;
  }
  return false;
}

/** 再レビューを頼んだ後に、結果を受け取れなかったときの案内（始まったかどうかが分からない）。 */
const REREVIEW_UNCERTAIN =
  "再レビューは始まっている可能性があります。get_task で state と review.round を確かめてから、必要なら呼び直してください。";

/** タスクの作成を頼んだ後に、結果を受け取れなかったときの案内（作られたかどうかが分からない）。 */
const CREATE_UNCERTAIN =
  "タスクは作られている可能性があります。list_tasks（query に題）で確かめてから、まだ無ければ呼び直してください。";

/**
 * 書き込み（承認・差し戻し・一時停止・再開・中止）を頼んだ後に、結果を受け取れなかったときの案内（行われたかどうかが分からない）。
 * done は「承認されて」のような、行われたことの言い方。check は get_task で確かめる欄、retry は呼び直してよい状態。
 */
function uncertainNotice(done: string, check: string, retry: string): string {
  return `${done}いる可能性があります。自動でやり直さず、get_task で ${check} を確かめてから、${retry}呼び直してください。`;
}

/**
 * 書き込みごとの、結果を受け取れなかったときの文の作り方。理由があれば（5xx の状態コードなど）それに、なければ原因の種類
 * だけに、案内を続ける。
 */
type Uncertain = (reason?: string) => string;
const uncertainOf =
  (subject: string, notice: string): Uncertain =>
  (reason) =>
    `${reason ?? `${subject}の結果を受け取れませんでした（時間切れ・切断など）。`}${notice}`;

/** 承認を頼んだ後に、結果を受け取れなかったときの案内（承認されたかどうかが分からない）。 */
const APPROVE_UNCERTAIN = uncertainNotice("承認されて", "state と approval", "まだ承認待ちなら");
const uncertainApproval = uncertainOf("承認", APPROVE_UNCERTAIN);

/** 差し戻しを頼んだ後に、結果を受け取れなかったときの案内（差し戻されたかどうかが分からない）。 */
const CHANGES_UNCERTAIN = uncertainNotice("差し戻されて", "state と approval", "まだ承認待ちなら");
const uncertainChanges = uncertainOf("差し戻し", CHANGES_UNCERTAIN);

/**
 * 一時停止を頼んだ後の案内。一時停止は、コンテナを止めて処理の終わりを待ってから応答するので、時間切れの後で一時停止に
 * なる（または承認待ちに達して止まらない）ことがある。
 */
const PAUSE_UNCERTAIN =
  "一時停止されている可能性があります。自動でやり直さず、get_task で state と pausedReason を確かめてください。state が一時停止の前と同じ（running・queued・検証中の idle）なら、一時停止が続いている可能性があるので、呼び直さず wait_for_task で待ってください。paused なら止まっています。awaiting_approval・escalated になったときは、止まらなかったことを利用者に伝えてください。";
const uncertainPause = uncertainOf("一時停止", PAUSE_UNCERTAIN);

/**
 * 中止を頼んだ後の案内。中止は、コンテナを止めて処理の終わりを待ち、PR を閉じ、ブランチを消してから応答するので、時間切れの後で
 * 中止になる（片付けが続く）ことがある。
 */
const CANCEL_UNCERTAIN =
  "中止されている（片付けが続いている）可能性があります。自動でやり直さず、get_task で state を確かめてください。実行中のタスクの中止は、終わるまで paused に見えることがあります。そのときは、中止に失敗した・一時停止になったとも、再開できるとも利用者に伝えず、呼び直さず wait_for_task で cancelled になるまで待ってください。cancelled になったら、get_task の cancelled（片付けの結果と、失敗したもの）を確かめて、利用者に伝えてください。待っても cancelled にならない（中止が進んでいない）ときは、状況を利用者に伝え、利用者が望めば get_cancel_plan から呼び直してください（片付けの途中なら、デーモンが断ります）。";
const uncertainCancel = uncertainOf("中止", CANCEL_UNCERTAIN);

/** 再開を頼んだ後の案内（再開されたかどうかが分からない）。 */
const RESUME_UNCERTAIN = uncertainNotice(
  "再開されて",
  "state と pausedReason",
  "まだ一時停止中なら",
);
const uncertainResume = uncertainOf("再開", RESUME_UNCERTAIN);

/**
 * 再実行を頼んだ後の案内（作られたかどうかが分からない）。再実行は1度だけで、2回目は断られる（MCP の層が先に rerunBy を見て送らずに断る。確かめと送信の間に
 * 別の再実行が入ったときだけ、デーモンが rerun.alreadyRerun で断る。どちらもタスクは増えない）ので、
 * 元のタスクの rerunBy で、作られたかどうかを確かめられる。
 */
const RERUN_UNCERTAIN =
  "新しいタスクが作られている可能性があります。自動でやり直さず、元のタスクを get_task で読み、rerunBy を確かめてください。あれば作られているので、その ID のタスクを見てください。無ければ作られていないので、呼び直してよいです（二重には作られません）。";
const uncertainRerun = uncertainOf("再実行", RERUN_UNCERTAIN);

/** 再実行の断りのうち、リポジトリがプロジェクトの対象でないもの（task.repositoryUnknown）は、画面で選び直せることを伝える。対象が1つも無いもの（task.repositoryMissing）は、デーモンの文（プロジェクトの設定で対象を足す）のままにする。 */
function rerunRepositoryForMcp(message: { code?: unknown; params?: unknown }): string | undefined {
  if (message.code !== "task.repositoryUnknown") return undefined;
  return `${renderMessage(message, "ja")}画面の「再実行」で、作業するリポジトリを選び直して再実行できます（作られていません）。`;
}

/**
 * 続きの作成（派生）を頼んだ後の案内（作られたかどうかが分からない）。派生は何度でも作れ、呼び直すと二重に作られうるので、
 * 元のタスクの derivedTasks に、呼ぶ前に無かった ID が増えたかで、作られたかどうかを確かめる。
 */
const DERIVE_UNCERTAIN =
  "続きのタスクが作られている可能性があります。自動でやり直さず（呼び直すと二重に作られます）、元のタスクを get_task で読み、derivedTasks に、呼ぶ前に無かった ID が増えていないかを確かめてください。増えていれば作られているので、その ID のタスクを見てください。増えていなければ作られていないので、呼び直してよいです。";
const uncertainDerive = uncertainOf("続きの作成", DERIVE_UNCERTAIN);

/** 題の変更を頼んだ後の案内（変わったかどうかが分からない）。同じ題での2回目は断られるだけなので、呼び直しても害は無い。 */
const RENAME_UNCERTAIN =
  "題が変わっている可能性があります。get_task の title を確かめてください。変わっていれば済んでいます。変わっていなければ、呼び直してよいです（同じ題での2回目は断られるだけです）。";
const uncertainRename = uncertainOf("題の変更", RENAME_UNCERTAIN);

/** 続きの作成の断りのうち、リポジトリがプロジェクトの対象でないもの（task.repositoryUnknown）は、画面で選び直せることを伝える。 */
function deriveRepositoryForMcp(message: { code?: unknown; params?: unknown }): string | undefined {
  if (message.code !== "task.repositoryUnknown") return undefined;
  return `${renderMessage(message, "ja")}画面の「続きのタスクを作る」で、作業するリポジトリを選び直して作れます（作られていません）。`;
}

/** デーモンの応答を待つ時間（ミリ秒）。応答しないデーモンで、ツールが戻らなくならないようにする。 */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

type ReadApi = Pick<
  SactyApi,
  "listDeliverables" | "getDeliverable" | "listRuns" | "getErrorReport"
>;

/**
 * 成果物・実行を読む API（PBI-395）の呼び出し。理由は、定型の文だけにする（デーモンの応答の本文・成果物の中身を、
 * 理由にも、例外の原因にも入れない）。タスクが無いときは undefined。前の版のデーモン（本文が error の JSON でない 404）は、
 * 「タスクが無い」と区別して、更新を促す理由にする。
 */
function readApi(
  endpoint: () => DaemonEndpoint,
  request: (at: DaemonEndpoint, path: string) => Promise<Response>,
): ReadApi {
  /** 本文を JSON として読む。読めなければ undefined（時間切れだけは、時間切れの理由にする）。 */
  const body = async (res: Response): Promise<Record<string, unknown> | undefined> => {
    try {
      const json = (await res.json()) as unknown;
      return json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
    } catch (error) {
      if (isTimeout(error)) throw new Error(DAEMON_TIMEOUT_MESSAGE, { cause: error });
      return undefined;
    }
  };
  const call = async <T>(path: string): Promise<T | undefined> => {
    const res = await request(endpoint(), path);
    const json = await body(res);
    if (res.ok) {
      if (!json) throw new Error(READ_REASONS.unreadable);
      return json as T;
    }
    const failure = readFailure(res.status, json);
    if (failure === "task_not_found") return undefined;
    throw failure;
  };
  const id = encodeURIComponent;
  const query = (values: Record<string, string | number | undefined>) => {
    const entries = Object.entries(values).filter(
      (e): e is [string, string | number] => e[1] !== undefined,
    );
    return entries.length === 0
      ? ""
      : `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`;
  };
  return {
    listDeliverables: (taskId) => call(`/api/tasks/${id(taskId)}/deliverables`),
    getDeliverable: (taskId, input) =>
      call(
        `/api/tasks/${id(taskId)}/deliverables/${id(input.step)}/${id(input.kind)}${query({
          offset: input.offset,
          max: input.maxBytes,
        })}`,
      ),
    // エラーレポートは Markdown の本文で返る。省いたことを示す印（応答のヘッダー）も読む。失敗の理由には、本文を入れない
    getErrorReport: async (taskId, input) => {
      const res = await request(
        endpoint(),
        `/api/tasks/${id(taskId)}/error-report${query({ lang: input.lang, [STALE_LOGS_QUERY]: STALE_LOGS_OMIT })}`,
      );
      if (!res.ok) {
        const failure = readFailure(res.status, await body(res));
        if (failure === "task_not_found") return undefined;
        throw failure;
      }
      // 印が無い（前の版のデーモン）ときは、本文を読まない（省いていないレポートを持ち回らない）
      if (res.headers.get(STALE_LOGS_HEADER) !== STALE_LOGS_OMITTED) return { omitted: false };
      try {
        return { omitted: true, text: await res.text() };
      } catch (error) {
        if (isTimeout(error)) throw new Error(DAEMON_TIMEOUT_MESSAGE, { cause: error });
        throw new Error(READ_REASONS.unreadable);
      }
    },
    listRuns: (taskId, input) =>
      call(`/api/tasks/${id(taskId)}/runs${query({ offset: input.offset, limit: input.limit })}`),
  };
}

export function daemonApi(
  home: string,
  fetcher: Fetch = fetch,
  timeoutMs: number = MCP_REQUEST_TIMEOUT_MS,
): SactyApi {
  const endpoint = (): DaemonEndpoint => {
    const found = readDaemonFile(home);
    if (!found) {
      throw new Error(
        "起動中の sacty が見つかりません。`sacty up` で起動してから、もう一度呼んでください。",
      );
    }
    return found;
  };
  const request = (
    at: DaemonEndpoint,
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ) => daemonRequest(at, path, fetcher, { timeoutMs, ...init });
  /** 応答の本文を読む。読んでいる途中の時間切れも、応答しなかったという理由にする。 */
  const read = async <T>(res: Response): Promise<T> => {
    try {
      return (await res.json()) as T;
    } catch (error) {
      if (isTimeout(error)) throw new Error(DAEMON_TIMEOUT_MESSAGE, { cause: error });
      throw new Error("デーモンの応答を読めませんでした。", { cause: error });
    }
  };
  /**
   * 書き込みの POST を送り、更新後のタスクを返す（承認・差し戻し・一時停止・再開・中止で共通）。失敗の振り分け：
   * 送る前の失敗（認証できない・接続を断られた）はそのまま、送った後に結果を受け取れなかった（時間切れ・切断・5xx・
   * 本文を読めない）ときは uncertain の案内、デーモンが応答で断った（4xx）ときは、その理由（行われていない）。
   */
  const writeTask = async (
    at: DaemonEndpoint,
    path: string,
    body: unknown,
    uncertain: Uncertain,
    rewrite?: (message: { code?: unknown; params?: unknown }) => string | undefined,
  ): Promise<Task> => {
    let res: Response;
    try {
      res = await request(at, path, { method: "POST", body });
    } catch (error) {
      // 認証できない・接続を断られた（要求が処理されていない）ときは、行われていない
      if (notSent(error)) throw error;
      // 頼んだ後に結果を受け取れなかった（時間切れ・切断）ときは、行われたかどうかが分からない
      // 元の文（「もう一度試してください」など）は案内と矛盾するので使わず、原因の種類だけを書く（元の例外は cause に残す）
      throw new Error(uncertain(), { cause: error });
    }
    // 5xx は、処理の途中で失敗したのかもしれず、行われたかどうかが分からない（案内は 1 か所で付ける）
    if (res.status >= 500) {
      const failed = await refusal(res).catch(() => undefined);
      throw new Error(uncertain(failed?.message), { cause: failed });
    }
    // デーモンが応答で断ったなら、行われていない。その理由を返す
    if (!res.ok) throw await refusal(res, rewrite);
    try {
      return (await read<{ task: Task }>(res)).task;
    } catch (error) {
      // 本文を読めなかったときも、行われたかどうかが分からない
      throw new Error(uncertain(), { cause: error });
    }
  };
  return {
    async listTasks() {
      const at = endpoint();
      const [res, projectsRes] = await Promise.all([
        request(at, "/api/tasks"),
        request(at, "/api/projects"),
      ]);
      if (!res.ok) throw await refusal(res);
      if (!projectsRes.ok) throw await refusal(projectsRes);
      const { tasks } = await read<{ tasks: Task[] }>(res);
      const { projects } = await read<{ projects: { id: string }[] }>(projectsRes);
      // 消したプロジェクトのタスクは出さない（画面と同じ。詳細の API は、無いものとして返す）
      const alive = new Set(projects.map((p) => p.id));
      return tasks.filter((task) => alive.has(task.projectId));
    },
    async getTask(id, options) {
      // 期限・取り消しを渡されたとき（wait_for_task）だけ、既定の時間（30 秒）の代わりに使う。ほかの呼び出しは変わらない
      const res = await request(endpoint(), `/api/tasks/${encodeURIComponent(id)}`, {
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw await refusal(res);
      return read<{ task: Task; activity: ActivityEvent[] }>(res);
    },
    async rereview(id) {
      const at = endpoint();
      const path = `/api/tasks/${encodeURIComponent(id)}`;
      // 消したプロジェクトのタスクは、無いものとして断る（一覧・詳細と同じ。再レビューの API は、プロジェクトを確かめない）
      const found = await request(at, path);
      if (found.status === 404) throw new Error(renderMessage({ code: "task.notFound" }, "ja"));
      if (!found.ok) throw await refusal(found);
      try {
        const res = await request(at, `${path}/rereview`, { method: "POST", body: {} });
        if (!res.ok) throw await refusal(res);
        return (await read<{ task: Task }>(res)).task;
      } catch (error) {
        // デーモンが応答で断ったなら、始まっていない。その理由をそのまま返す
        if (error instanceof DaemonRefusal) throw error;
        // 頼んだ後に結果を受け取れなかった（時間切れ・接続が切れた・本文を読めなかった）ときは、始まったかどうかが
        // 分からない（デーモンが記録した後に、応答が届かなかったのかもしれない）
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason}${REREVIEW_UNCERTAIN}`, { cause: error });
      }
    },
    async approve(id, input) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（承認していない）
      const path = `/api/tasks/${encodeURIComponent(id)}`;
      // 消したプロジェクトのタスクは、無いものとして断る（承認の API は、プロジェクトを確かめない）
      const found = await request(at, path);
      if (found.status === 404) throw new Error(renderMessage({ code: "task.notFound" }, "ja"));
      if (!found.ok) throw await refusal(found);
      return writeTask(at, `${path}/approve`, input, uncertainApproval, staleForMcp);
    },
    async requestChanges(id, input) {
      // 消したプロジェクトのタスクの確かめと、差し戻せる状態かの確かめは、ツールが先に getTask で行う
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（差し戻していない）
      // 送るのは step・submission・comments だけ（target・cause・image・agents・continueOverLimit は送らない）
      const body = { step: input.step, submission: input.submission, comments: input.comments };
      return writeTask(
        at,
        `/api/tasks/${encodeURIComponent(id)}/request-changes`,
        body,
        uncertainChanges,
        staleChangesForMcp,
      );
    },
    // 消したプロジェクトのタスクの確かめと、一時停止できる状態かの確かめは、ツールが先に getTask で行う（完了したタスクを
    // デーモンは断らないので、先に断る）。送るのは {} だけ
    async pause(id) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（一時停止していない）
      return writeTask(at, `/api/tasks/${encodeURIComponent(id)}/pause`, {}, uncertainPause);
    },
    // 送るのは {} か { note } だけ（capUsd・tests・image・agents は送らない）
    async resume(id, input) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（再開していない）
      const body = input.note ? { note: input.note } : {};
      return writeTask(at, `/api/tasks/${encodeURIComponent(id)}/resume`, body, uncertainResume);
    },
    // 消したプロジェクトのタスクの確かめと、中止できる状態かの確かめ・片付けの対象の確かめは、ツールが先に getTask で行う
    // （完了したタスクをデーモンは断らない）。送るのは {} だけ
    async cancel(id) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（中止していない）
      return writeTask(at, `/api/tasks/${encodeURIComponent(id)}/cancel`, {}, uncertainCancel);
    },
    // 消したプロジェクトのタスクの確かめと、再実行できる状態かの確かめ・画面の既定値の組み立ては、ツールが先に getTask で行う。
    // 送るのは title・body・repo と、あれば note だけ（image は送らない）
    async rerun(id, input) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（作られていない）
      const body = {
        title: input.title,
        body: input.body,
        repo: input.repo,
        ...(input.note ? { note: input.note } : {}),
      };
      return writeTask(
        at,
        `/api/tasks/${encodeURIComponent(id)}/rerun`,
        body,
        uncertainRerun,
        rerunRepositoryForMcp,
      );
    },
    // 消したプロジェクトのタスクの確かめと、続きを作れる状態かの確かめ・画面の既定値の組み立ては、ツールが先に getTask で行う。
    // 送るのは title・body・repo だけ（plan は送らない＝自動）
    async derive(id, input) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（作られていない）
      const body = { title: input.title, body: input.body, repo: input.repo };
      return writeTask(
        at,
        `/api/tasks/${encodeURIComponent(id)}/derive`,
        body,
        uncertainDerive,
        deriveRepositoryForMcp,
      );
    },
    // 消したプロジェクトのタスクの確かめと、中止したタスクの確かめは、ツールが先に getTask で行う。送るのは title だけ
    async rename(id, input) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（変わっていない）
      return writeTask(
        at,
        `/api/tasks/${encodeURIComponent(id)}/title`,
        { title: input.title },
        uncertainRename,
      );
    },
    async cleanupPlan(id) {
      const res = await request(endpoint(), `/api/tasks/${encodeURIComponent(id)}/cleanup-plan`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw await refusal(res);
      return (await read<{ plan: CleanupPlanItem[] }>(res)).plan;
    },
    async listProjects() {
      const res = await request(endpoint(), "/api/projects");
      if (!res.ok) throw await refusal(res);
      return (await read<{ projects: ProjectChoice[] }>(res)).projects;
    },
    async waitingSince() {
      const res = await request(endpoint(), "/api/dashboard");
      if (!res.ok) throw await refusal(res);
      const { waitingSince } = await read<{ waitingSince?: unknown }>(res);
      if (
        !waitingSince ||
        typeof waitingSince !== "object" ||
        Array.isArray(waitingSince) ||
        Object.values(waitingSince).some((at) => typeof at !== "string")
      ) {
        throw new Error(
          "デーモンの応答に、待ち始めの時刻（waitingSince）がありません。起動中の sacty が前の版かもしれません。sacty を更新して起動し直してください。",
        );
      }
      return waitingSince as Record<string, string>;
    },
    async createTask(input) {
      const at = endpoint(); // 接続先が無いのは、頼む前の失敗（作られていない）
      try {
        // 画面と同じく、対象リポジトリを空欄（リポジトリを指定しない）にし、進め方は送らない（自動）
        const res = await request(at, "/api/tasks", {
          method: "POST",
          body: { ...input, repo: null },
        });
        // 5xx は、処理の途中で失敗したのかもしれず、作られたかどうかが分からない
        if (!res.ok && res.status >= 500) {
          const failed = await refusal(res);
          throw new Error(failed.message, { cause: failed });
        }
        if (!res.ok) throw await refusal(res);
        return (await read<{ task: Task }>(res)).task;
      } catch (error) {
        // デーモンが応答で断ったなら、作られていない。その理由をそのまま返す
        if (error instanceof DaemonRefusal) throw error;
        // 認証できない・接続を断られた（要求が処理されていない）ときも、作られていない
        if (notSent(error)) throw error;
        // 頼んだ後に結果を受け取れなかったときは、作られたかどうかが分からない
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason}${CREATE_UNCERTAIN}`, { cause: error });
      }
    },
    ...readApi(endpoint, request),
    webUrl: () => readDaemonFile(home)?.web,
  };
}
