import type { DaemonMessage, MessageCode, MessageParams } from "./messages.js";

/*
 * 文言のコードを作る関数（PBI-11）。messages.ts は events.ts・projects.ts の定数を使うので、
 * 循環しないように、検査や重複の判定の側はこのファイル（messages.ts は型だけを参照する）を使う。
 */

/** 入力の検査（zod）の文言に入れる、文言のコード。画面が画面の言語の文言にする。 */
export function code(value: MessageCode): string {
  return value;
}

/** コードと引数の文言を作る。 */
export function message<K extends MessageCode>(
  code: K,
  ...params: MessageParams[K] extends undefined ? [] : [MessageParams[K]]
): DaemonMessage {
  return (params.length > 0 ? { code, params: params[0] } : { code }) as DaemonMessage;
}
