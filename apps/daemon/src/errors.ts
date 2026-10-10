import { type DaemonMessage, type DaemonText, renderMessage } from "@sacty/core";

/**
 * 利用者に向けた理由を、文言のコードと引数で持つエラー（PBI-11）。画面が画面の言語の文にする。
 * message は日本語の文（デーモンのログ・CLI 用）。
 */
export class MessageError extends Error {
  constructor(readonly text: DaemonMessage) {
    super(renderMessage(text, "ja"));
  }
}

/** エラーの理由。sacty のエラーはコードと引数、それ以外（外から来たエラー）はその文のまま。 */
export function errorText(error: unknown): DaemonText {
  if (error instanceof MessageError) return error.text;
  return error instanceof Error ? error.message : String(error);
}
