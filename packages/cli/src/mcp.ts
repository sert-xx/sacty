/**
 * `sacty mcp`（PBI-392）が、起動中の sacty のデーモンの API を呼ぶところ。ツールの定義は @sacty/daemon/task-mcp にある。
 * 接続先とトークンは、呼び出しのたびに SACTY_HOME の daemon.json から読む（`sacty up` を起動し直すとトークンが変わるので、
 * MCP サーバーを起動し直さなくても、新しい接続先に問い合わせる）。
 */
import type { ActivityEvent, Task } from "@sacty/core";
import { renderMessage } from "@sacty/core";
import {
  type ProjectChoice,
  READ_REASONS,
  readFailure,
  type SactyApi,
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

/** 承認を頼んだ後に、結果を受け取れなかったときの案内（承認されたかどうかが分からない）。 */
const APPROVE_UNCERTAIN =
  "承認されている可能性があります。自動でやり直さず、get_task で state と approval を確かめてから、まだ承認待ちなら呼び直してください。";

/** デーモンの応答を待つ時間（ミリ秒）。応答しないデーモンで、ツールが戻らなくならないようにする。 */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

type ReadApi = Pick<SactyApi, "listDeliverables" | "getDeliverable" | "listRuns">;

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
    init: { method?: string; body?: unknown } = {},
  ) => daemonRequest(at, path, fetcher, { ...init, timeoutMs });
  /** 応答の本文を読む。読んでいる途中の時間切れも、応答しなかったという理由にする。 */
  const read = async <T>(res: Response): Promise<T> => {
    try {
      return (await res.json()) as T;
    } catch (error) {
      if (isTimeout(error)) throw new Error(DAEMON_TIMEOUT_MESSAGE, { cause: error });
      throw new Error("デーモンの応答を読めませんでした。", { cause: error });
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
    async getTask(id) {
      const res = await request(endpoint(), `/api/tasks/${encodeURIComponent(id)}`);
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
      try {
        const res = await request(at, `${path}/approve`, { method: "POST", body: input });
        // 5xx は、処理の途中で失敗したのかもしれず、承認されたかどうかが分からない
        if (!res.ok && res.status >= 500) {
          const failed = await refusal(res);
          throw new Error(`${failed.message}${APPROVE_UNCERTAIN}`, { cause: failed });
        }
        if (!res.ok) throw await refusal(res, staleForMcp);
        return (await read<{ task: Task }>(res)).task;
      } catch (error) {
        // デーモンが応答で断ったなら、承認していない。その理由をそのまま返す
        if (error instanceof DaemonRefusal) throw error;
        // 認証できない・接続を断られた（要求が処理されていない）ときも、承認していない
        if (notSent(error)) throw error;
        // 5xx は、上で案内を付けて投げ直したもの（そのまま返す）
        if (error instanceof Error && error.cause instanceof DaemonRefusal) throw error;
        // 頼んだ後に結果を受け取れなかったときは、承認されたかどうかが分からない
        // 元の文（「もう一度試してください」など）は案内と矛盾するので使わず、原因の種類だけを書く（元の例外は cause に残す）
        throw new Error(
          `承認の結果を受け取れませんでした（時間切れ・切断など）。${APPROVE_UNCERTAIN}`,
          {
            cause: error,
          },
        );
      }
    },
    async listProjects() {
      const res = await request(endpoint(), "/api/projects");
      if (!res.ok) throw await refusal(res);
      return (await read<{ projects: ProjectChoice[] }>(res)).projects;
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
