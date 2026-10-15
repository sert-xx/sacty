import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 画面の取り直し（`/live/...`）から、デーモンへの問い合わせに渡す中断（PR #119 再レビュー指摘）。ブラウザが打ち切った
 * とき（リクエストの中断）と、画面のサーバーの期限で、デーモンへの問い合わせも止める（応答しないデーモンへの問い合わせを
 * 溜めない）。
 */
const storage = new AsyncLocalStorage<AbortSignal>();

/** 画面のサーバーからデーモンへの、取り直し1回分の期限（ブラウザの期限 10 秒より短くする）。 */
export const LIVE_SERVER_TIMEOUT_MS = 8_000;

/** fn の中のデーモンへの問い合わせに、request の中断と期限を渡す。 */
export function withDaemonSignal<T>(request: Request, fn: () => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("timeout")), LIVE_SERVER_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  return storage.run(signal, fn).finally(() => clearTimeout(timer));
}

/** いまの問い合わせに渡す中断（取り直しの中でなければ undefined）。 */
export function currentDaemonSignal(): AbortSignal | undefined {
  return storage.getStore();
}
