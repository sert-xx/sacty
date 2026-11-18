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

/** デーモンが断った理由（{ error: "invalid_operation", messages }）を、文にする。読めなければ、状態コードを伝える。 */
async function refusal(res: Response): Promise<Error> {
  const json = (await res.json().catch(() => undefined)) as
    | { error?: unknown; messages?: unknown }
    | undefined;
  if (json?.error === "invalid_operation" && Array.isArray(json.messages)) {
    const text = json.messages.map((m) => renderMessage(m, "ja")).join("\n");
    if (text) return new Error(text);
  }
  return new Error(`デーモンが ${res.status} を返しました。`);
}

/** デーモンの応答を待つ時間（ミリ秒）。応答しないデーモンで、ツールが戻らなくならないようにする。 */
export const MCP_REQUEST_TIMEOUT_MS = 30_000;

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
      const res = await request(endpoint(), `/api/tasks/${encodeURIComponent(id)}/rereview`, {
        method: "POST",
        body: {},
      });
      if (!res.ok) throw await refusal(res);
      return (await read<{ task: Task }>(res)).task;
    },
    webUrl: () => readDaemonFile(home)?.web,
  };
}
