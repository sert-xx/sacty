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
 * - `missing`：対象が無い（消えた・プロジェクトを削除したなど）。表示はそのまま残す（描き直すかは画面が決める。useLiveData の missing）。
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

/** 1回の取り直しの期限（PR #119 レビュー指摘）。応答が無くても、期限で打ち切って次の取り直しを予約する。 */
export const LIVE_TIMEOUT_MS = 10_000;

/**
 * 取り直しの結果。
 * - `{ data, version }`：新しいデータ。
 * - `"current"`：いまのデータのままでよい（版が同じ・対象が無い）。
 * - `"failed"`：更新できなかった（デーモンや画面のサーバーに届かない・期限切れ・読めない応答）。画面は「更新が止まって
 *   いる」ことを出す。
 * - `"signedOut"`：画面の認証が無い（401。`sacty up` を起動し直して、前の起動の cookie が使えなくなった。PBI-129）。
 *   画面は、端末に表示された新しい URL で入り直すよう出す。
 */
export type LiveResult<T> =
  | { data: T; version: string }
  | "current"
  | "missing"
  | "failed"
  | "signedOut";

/** 取り直しで更新できない理由（更新できていれば false）。 */
export type LiveStale = false | "failed" | "signedOut";

/**
 * url から最新のデータを取る。例外にはしない。timeoutMs で打ち切る（応答の本文を読む間も含む）。
 */
export async function fetchLive<T>(
  url: string,
  version: string | undefined,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs: number = LIVE_TIMEOUT_MS,
): Promise<LiveResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  // 期限の前に終わったときに、期限の約束の拒否を未処理にしない
  expired.catch(() => {});
  try {
    const reply = await Promise.race([
      (async () => {
        const res = await fetcher(url, {
          cache: "no-store",
          signal: controller.signal,
          headers: version ? { [LIVE_VERSION_HEADER]: version } : {},
        });
        if (res.status === 401) return "signedOut" as const;
        if (!res.ok) return undefined;
        return (await res.json()) as LiveReply<T>;
      })(),
      expired,
    ]);
    if (reply === "signedOut") return reply;
    if (!reply || "unavailable" in reply) return "failed";
    if ("missing" in reply) return "missing";
    return "data" in reply ? reply : "current";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
