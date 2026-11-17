import type { ActivityEvent, DaemonText, Task } from "@sacty/core";

/** 一時停止の案内に、箇条書きで出す件数の上限。理由の文に入れる件数と同じ。 */
export const PAUSED_REMAINING_SHOWN = 5;

export type PausedRemaining = {
  /** 残っていることを除いた理由の文（箇条書きの前に出す）。 */
  message: DaemonText;
  /** 箇条書きで出す、残っていること（上限まで）。 */
  items: string[];
  /** エージェントが申告した件数（出す件数を超えていれば、「ほか、全 N 件」を出す）。 */
  total: number;
};

/**
 * 実装が終わらないための一時停止の「残っていること」を、1 件ずつに分けて返す（PBI-355）。
 *
 * 一時停止の理由（`implement.incomplete`）は、残っていることを「 / 」でつないだ 1 つの文字列で持つ。項目の中に同じ区切りが
 * あると分け直せないので、同じ追記で記録した未完了の記録（ImplementationIncomplete。1 件ずつ持つ）から取る。
 * 記録が見つからない・理由の文字列と合わないときは undefined を返し、呼び出し側は理由の文をそのまま出す。
 */
export function pausedRemaining(
  task: Pick<Task, "status" | "pausedReason" | "pausedMessage">,
  activity: readonly ActivityEvent[],
): PausedRemaining | undefined {
  const stopped = task.pausedMessage;
  if (task.status !== "paused" || task.pausedReason !== "incomplete") return undefined;
  if (typeof stopped !== "object" || stopped.code !== "implement.incomplete") return undefined;
  const params = stopped.params ?? {};
  const { remaining, total } = params;
  if (typeof remaining !== "string" || typeof total !== "number" || total <= 0) return undefined;
  for (let i = activity.length - 1; i >= 0; i--) {
    const event = activity[i];
    if (event?.type !== "ImplementationIncomplete") continue;
    const items = event.payload.remaining.slice(0, PAUSED_REMAINING_SHOWN);
    // 止めたときの未完了の記録でなければ（別の記録を拾った・記録の形が違う）、分けずに出す
    if (items.length === 0 || items.join(" / ") !== remaining) return undefined;
    return {
      message: { code: stopped.code, params: { ...params, remaining: "", total: 0 } },
      items,
      total,
    };
  }
  return undefined;
}
