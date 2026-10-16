import type { DaemonText } from "@sacty/core";

/**
 * デーモンの警告のうち、Slack の通知を送れなかった理由（`notify.failed`。sacty 全体で1つ。PBI-115）を、画面の言語の文にする。
 * ダッシュボードと sacty の設定の画面に出す（プロジェクトの画面を開かなくても気づけるように）。
 */
export function notificationProblems(
  warnings: readonly DaemonText[] | undefined,
  text: (value: DaemonText) => string,
): string[] {
  return (warnings ?? [])
    .filter((w) => typeof w !== "string" && w.code === "notify.failed")
    .map((w) => text(w));
}
