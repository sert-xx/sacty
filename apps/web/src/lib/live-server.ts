import { createHash } from "node:crypto";
import { LIVE_VERSION_HEADER, type LiveReply } from "@/lib/live";

/** データの版（中身が同じなら同じ）。画面が前に受け取った版と同じなら、中身を送らない（PBI-108）。 */
export function liveVersion(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("base64url");
}

/**
 * 画面がデータだけを取り直すための返事（PBI-108）。load が null なら対象が無い。デーモンに届かない・読めないときも
 * 200 で `{ unavailable: true }` を返す（画面はいまのまま残し、ブラウザのコンソールにエラーを出し続けない）。
 */
export async function liveResponse<T>(
  request: Request,
  load: () => Promise<T | null>,
): Promise<Response> {
  let reply: LiveReply<T>;
  try {
    const data = await load();
    if (data === null) {
      reply = { missing: true };
    } else {
      const version = liveVersion(data);
      reply =
        request.headers.get(LIVE_VERSION_HEADER) === version
          ? { unchanged: true }
          : { data, version };
    }
  } catch {
    reply = { unavailable: true };
  }
  return Response.json(reply, { headers: { "cache-control": "no-store" } });
}
