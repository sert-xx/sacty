/**
 * `sacty mcp`（PBI-392）が、起動中の sacty のデーモンの API を呼ぶところ。ツールの定義は @sacty/daemon/task-mcp にある。
 * 接続先とトークンは、呼び出しのたびに SACTY_HOME の daemon.json から読む（`sacty up` を起動し直すとトークンが変わるので、
 * MCP サーバーを起動し直さなくても、新しい接続先に問い合わせる）。
 */
import type { ActivityEvent, Task } from "@sacty/core";
import { renderMessage } from "@sacty/core";
import type { SactyApi } from "@sacty/daemon/task-mcp";
import {
  type DaemonEndpoint,
  daemonRequest,
  type Fetch,
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

export function daemonApi(
  home: string,
  fetcher: Fetch = fetch,
  read: (home: string) => DaemonEndpoint | undefined = readDaemonFile,
): SactyApi {
  const endpoint = (): DaemonEndpoint => {
    const found = read(home);
    if (!found) {
      throw new Error(
        "起動中の sacty が見つかりません。`sacty up` で起動してから、もう一度呼んでください。",
      );
    }
    return found;
  };
  return {
    async listTasks() {
      const at = endpoint();
      const [res, projectsRes] = await Promise.all([
        daemonRequest(at, "/api/tasks", fetcher),
        daemonRequest(at, "/api/projects", fetcher),
      ]);
      if (!res.ok) throw await refusal(res);
      if (!projectsRes.ok) throw await refusal(projectsRes);
      const { tasks } = (await res.json()) as { tasks: Task[] };
      const { projects } = (await projectsRes.json()) as { projects: { id: string }[] };
      // 消したプロジェクトのタスクは出さない（画面と同じ。詳細の API は、無いものとして返す）
      const alive = new Set(projects.map((p) => p.id));
      return tasks.filter((task) => alive.has(task.projectId));
    },
    async getTask(id) {
      const res = await daemonRequest(endpoint(), `/api/tasks/${encodeURIComponent(id)}`, fetcher);
      if (res.status === 404) return undefined;
      if (!res.ok) throw await refusal(res);
      return (await res.json()) as { task: Task; activity: ActivityEvent[] };
    },
    async rereview(id) {
      const res = await daemonRequest(
        endpoint(),
        `/api/tasks/${encodeURIComponent(id)}/rereview`,
        fetcher,
        { method: "POST", body: {} },
      );
      if (!res.ok) throw await refusal(res);
      return ((await res.json()) as { task: Task }).task;
    },
    webUrl: () => read(home)?.web,
  };
}
