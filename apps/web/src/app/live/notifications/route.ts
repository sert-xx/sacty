import { withDaemonSignal } from "@/lib/daemon-signal";
import { loadDesktopFeed } from "@/lib/desktop-notifications-data";

/**
 * デスクトップ通知に出す、最近の通知。画面が一定の間隔で取り直す。`?after=<番号>` より後のものを返す（省けば最後の
 * 番号だけ）。デーモンに届かないときは 200 で `{ unavailable: true }`（画面は次の間隔でまた取り直す）。
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("after");
  const after = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
  let reply: unknown;
  try {
    reply = await withDaemonSignal(request, () => loadDesktopFeed(after));
  } catch {
    reply = { unavailable: true };
  }
  return Response.json(reply, { headers: { "cache-control": "no-store" } });
}
