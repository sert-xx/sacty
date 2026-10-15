/**
 * 画面のデータだけを取り直す仕組み（PBI-108）。画面をリロード（router.refresh を含む、画面の全体の描き直し）せず、
 * 一定の間隔でデータを取り直し、変わった所だけを React が画面に反映する。入力の途中の文字・選択・開いたダイアログや
 * 欄・フォーカス・スクロールの位置は、画面の要素がそのまま残るので消えない。
 */

/** データを取り直す間隔（タスクが動いていた間だけ画面を更新していたころと同じ 3 秒）。 */
export const LIVE_INTERVAL_MS = 3_000;

/** 前に受け取ったデータの版を送るヘッダー。同じなら、画面のサーバーは中身を送らない（`{ unchanged: true }`）。 */
export const LIVE_VERSION_HEADER = "x-sacty-live-version";

/**
 * 画面のサーバーの返事。
 * - `data`：最新のデータと、その版。
 * - `unchanged`：送った版から変わっていない。
 * - `unavailable`：デーモンに届かない・データを読めなかった（いまの画面をそのまま残す。エラーにはしない）。
 * - `missing`：対象が無い（消えたなど）。いまの画面をそのまま残す。
 */
export type LiveReply<T> =
  | { data: T; version: string }
  | { unchanged: true }
  | { unavailable: true; message?: string }
  | { missing: true };

type VisibilityDoc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * 画面が見えている間、load を intervalMs ごとに呼ぶ。前の load が終わってから次を数え始めるので、問い合わせは重ならない。
 * 隠れている（タブが隠れた）間は呼ばない。見えるようになったら、すぐに一度呼ぶ。返り値で止める。
 */
export function pollWhileVisible({
  doc,
  intervalMs,
  load,
}: {
  doc: VisibilityDoc;
  intervalMs: number;
  load: () => Promise<void>;
}): () => void {
  let stopped = false;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => doc.visibilityState === "visible";
  const schedule = () => {
    if (stopped || timer !== undefined || loading || !visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, intervalMs);
  };
  const run = async () => {
    if (stopped || loading || !visible()) return;
    loading = true;
    try {
      await load();
    } catch {
      // 取り直しに失敗しても、いまの画面をそのまま残し、次の間隔でまた取り直す
    } finally {
      loading = false;
    }
    schedule();
  };
  const onChange = () => {
    if (visible()) {
      // 見えたらすぐに取り直す（待っていた間隔は数え直す）
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      void run();
    } else if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  doc.addEventListener("visibilitychange", onChange);
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    doc.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * url から最新のデータを取る。版が同じ・届かない・対象が無いときは undefined（いまのデータを使い続ける）。
 * 画面のサーバーに届かないときも、例外にせず undefined にする。
 */
export async function fetchLive<T>(
  url: string,
  version: string | undefined,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ data: T; version: string } | undefined> {
  let reply: LiveReply<T>;
  try {
    const res = await fetcher(url, {
      cache: "no-store",
      headers: version ? { [LIVE_VERSION_HEADER]: version } : {},
    });
    if (!res.ok) return undefined;
    reply = (await res.json()) as LiveReply<T>;
  } catch {
    return undefined;
  }
  return "data" in reply ? reply : undefined;
}
