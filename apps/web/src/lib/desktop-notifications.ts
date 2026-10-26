/**
 * ブラウザのデスクトップ通知（承認待ち・エスカレーション・一時停止・完了。Slack の通知と同じもの）。
 * 通知の許可はブラウザごとなので、On/Off もブラウザごとに持つ（localStorage）。画面のサーバーから最近の通知を取り直し、
 * 前に受け取った番号より後のものを出す。同じブラウザで画面を複数のタブで開いていても、1回だけ出す。
 */

/** 取り直す間隔。タブが隠れている間も取り直す（ブラウザは隠れたタブのタイマーを間引くので、遅れることがある）。 */
export const DESKTOP_INTERVAL_MS = 5_000;

/** 最近の通知の取り直し先。 */
export const DESKTOP_FEED_URL = "/live/notifications";

export const DESKTOP_PREF_KEY = "sacty-desktop-notifications";
const SEEN_KEY = "sacty-desktop-notifications-seen";
/** 同じタブの中で On/Off を変えたことを知らせるイベント（ほかのタブには storage イベントで届く）。 */
export const DESKTOP_PREF_EVENT = "sacty-desktop-notifications";

/** 画面のサーバーが返す、出す通知。 */
export type DesktopItem = { seq: number; title: string; body: string; href: string };

export type DesktopFeed = { boot: string; latest: number; items: DesktopItem[] };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storage = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** このブラウザでデスクトップ通知を出すか（既定は出さない）。 */
export function readDesktopPref(store: Store | undefined = storage()): boolean {
  try {
    return store?.getItem(DESKTOP_PREF_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeDesktopPref(on: boolean, store: Store | undefined = storage()): void {
  try {
    if (on) store?.setItem(DESKTOP_PREF_KEY, "on");
    else store?.removeItem(DESKTOP_PREF_KEY);
  } catch {
    // 保存できなければ、変えない
  }
  globalThis.dispatchEvent?.(new Event(DESKTOP_PREF_EVENT));
}

/** ブラウザがデスクトップ通知を出せるか（https か localhost でないと使えない）。 */
export function desktopSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

/** 出した通知を覚えておく件数の上限（古いものから忘れる。デーモンが持つ最近の通知の件数より多くする）。 */
const SEEN_MAX = 200;

/**
 * その通知をこのタブが出してよいか。ほかのタブがすでに出していれば false。出すなら、出したことを記録する（同じブラウザの
 * タブで共有）。出した通知は boot と番号の組で覚える（いちばん大きい番号だけで比べると、タブごとに取り始めた位置が違うとき、
 * 先に後の番号を出したタブのせいで、まだ出していない前の番号を捨ててしまう）。
 */
export function claimDesktopItem(
  boot: string,
  seq: number,
  store: Store | undefined = storage(),
): boolean {
  const key = `${boot}:${seq}`;
  try {
    let seen: string[] = [];
    try {
      const parsed: unknown = JSON.parse(store?.getItem(SEEN_KEY) ?? "[]");
      if (Array.isArray(parsed)) seen = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      // 読めない記録（前の形など）は捨てる
    }
    if (seen.includes(key)) return false;
    store?.setItem(SEEN_KEY, JSON.stringify([...seen, key].slice(-SEEN_MAX)));
  } catch {
    // 共有できなければ、このタブの判断で出す
  }
  return true;
}

/** 1回の取り直し（本文を読むまで）の期限。過ぎたら打ち切り、次の間隔でまた取り直す。 */
export const DESKTOP_TIMEOUT_MS = 10_000;

const LOCK_NAME = "sacty-desktop-notifications";

type Locks = { request<T>(name: string, fn: () => Promise<T> | T): Promise<T> };

/**
 * fn を、同じブラウザのタブの間で1つずつ実行する（Web Locks）。出したかの確認・記録・通知を出すまでを、ほかのタブと
 * 重ねないため（重なると、両方のタブが同じ通知を出せる）。Web Locks が無いブラウザでは、そのまま実行する。
 */
export function withDesktopLock<T>(
  fn: () => Promise<T> | T,
  locks: Locks | undefined = (globalThis.navigator as { locks?: Locks } | undefined)?.locks,
): Promise<T> {
  return locks ? locks.request(LOCK_NAME, fn) : Promise.resolve().then(fn);
}

/** 取り直しの状態。after が無ければ、まだ最後の番号を知らない（最初の問い合わせ）。 */
export type FeedCursor = { boot?: string; after?: number };

/** 問い合わせる URL。 */
export function feedUrl(cursor: FeedCursor): string {
  return cursor.after === undefined
    ? DESKTOP_FEED_URL
    : `${DESKTOP_FEED_URL}?after=${cursor.after}`;
}

/**
 * 返事を受けて、出す通知と次の状態を決める。最初の問い合わせでは出さない（画面を開く前の通知は出さない）。デーモンを
 * 起動し直した（boot が変わった）ら、起動し直した後の通知を次の問い合わせで取る（番号は 1 から数え直す）。
 */
export function advanceFeed(
  cursor: FeedCursor,
  feed: DesktopFeed,
): { cursor: FeedCursor; show: DesktopItem[] } {
  if (cursor.after === undefined)
    return { cursor: { boot: feed.boot, after: feed.latest }, show: [] };
  if (cursor.boot !== feed.boot) return { cursor: { boot: feed.boot, after: 0 }, show: [] };
  const show = feed.items.filter((item) => item.seq > (cursor.after ?? 0));
  return { cursor: { boot: feed.boot, after: Math.max(cursor.after, feed.latest) }, show };
}
