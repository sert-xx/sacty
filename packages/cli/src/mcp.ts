/**
 * `sacty mcp`（PBI-392）が、起動中の sacty のデーモンの API を呼ぶところ。ツールの定義は @sacty/daemon/task-mcp にある。
 * 接続先とトークンは、呼び出しのたびに SACTY_HOME の daemon.json から読む（`sacty up` を起動し直すとトークンが変わるので、
 * MCP サーバーを起動し直さなくても、新しい接続先に問い合わせる）。
 */
import type { ActivityEvent, Task } from "@sacty/core";
import { renderMessage } from "@sacty/core";
import type { SactyApi } from "@sacty/daemon/task-mcp";
import {
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
async function refusal(res: Response): Promise<DaemonRefusal> {
  const json = (await res.json().catch(() => undefined)) as
    | { error?: unknown; messages?: unknown }
    | undefined;
  if (json?.error === "invalid_operation" && Array.isArray(json.messages)) {
    const text = json.messages.map((m) => renderMessage(m, "ja")).join("\n");
    if (text) return new DaemonRefusal(text);
  }
  return new DaemonRefusal(`デーモンが ${res.status} を返しました。`);
}

/** 再レビューを頼んだ後に、結果を受け取れなかったときの案内（始まったかどうかが分からない）。 */
const REREVIEW_UNCERTAIN =
  "再レビューは始まっている可能性があります。get_task で state と review.round を確かめてから、必要なら呼び直してください。";

/** デーモンの応答を待つ時間（ミリ秒）。応答しないデーモンで、ツールが戻らなくならないようにする。 */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

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
    webUrl: () => readDaemonFile(home)?.web,
  };
}
