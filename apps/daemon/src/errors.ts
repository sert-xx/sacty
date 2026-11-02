import { type DaemonMessage, type DaemonText, renderMessage, type TokenUsage } from "@sacty/core";

/**
 * 利用者に向けた理由を、文言のコードと引数で持つエラー（PBI-11）。画面が画面の言語の文にする。
 * message は日本語の文（デーモンのログ・CLI 用）。
 */
export class MessageError extends Error {
  constructor(readonly text: DaemonMessage) {
    super(renderMessage(text, "ja"));
  }
}

/**
 * エージェントの実行が上限の時間を超えて止められた（PBI-150）。止めるまでに読めた使用量を持つ（PBI-281）。usage があれば
 * 読めた分（下限）で、costUnknown は使った分の全体が分からないこと。
 */
export class AgentTimeoutError extends MessageError {
  usage: TokenUsage | undefined;
  costUnknown = false;
  /** 止めた後、コンテナが止まったことを確かめられなかったときの、コンテナの名前。動いたままかもしれないので、代わりの実行を始めない。 */
  unconfirmedContainer: string | undefined;
}

/** エラーの理由。sacty のエラーはコードと引数、それ以外（外から来たエラー）はその文のまま。 */
export function errorText(error: unknown): DaemonText {
  if (error instanceof MessageError) return error.text;
  return error instanceof Error ? error.message : String(error);
}
