import { readFailure, type SactyApi } from "../task-mcp.js";

/** 成果物・実行を読む API（PBI-395）を、CLI の daemonApi と同じ要求で呼ぶ。 */
export function readApiOver(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  headers: Record<string, string>,
): Pick<SactyApi, "listDeliverables" | "getDeliverable" | "listRuns" | "getErrorReport"> {
  const get = async (path: string) => {
    const res = await app.request(path, { headers });
    const json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (res.ok && json) return json;
    const failure = readFailure(res.status, json);
    if (failure === "task_not_found") return undefined;
    throw failure;
  };
  const report: SactyApi["getErrorReport"] = async (id, i) => {
    const res = await app.request(
      `/api/tasks/${encodeURIComponent(id)}/error-report?lang=${i.lang}&stale=omit`,
      {
        headers,
      },
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const failure = readFailure(res.status, json);
      if (failure === "task_not_found") return undefined;
      throw failure;
    }
    return { text: await res.text(), omitted: res.headers.get("x-sacty-stale-logs") === "omitted" };
  };
  const q = (v: Record<string, string | number | undefined>) =>
    `?${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}=${encodeURIComponent(String(x))}`)
      .join("&")}`;
  const e = encodeURIComponent;
  return {
    getErrorReport: report,
    listDeliverables: async (id) => (await get(`/api/tasks/${e(id)}/deliverables`)) as never,
    getDeliverable: async (id, i) =>
      (await get(
        `/api/tasks/${e(id)}/deliverables/${e(i.step)}/${e(i.kind)}${q({ offset: i.offset, max: i.maxBytes })}`,
      )) as never,
    listRuns: async (id, i) =>
      (await get(`/api/tasks/${e(id)}/runs${q({ offset: i.offset, limit: i.limit })}`)) as never,
  };
}
