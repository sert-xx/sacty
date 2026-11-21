import type { PauseReason, StepKey } from "@sacty/core";

/**
 * ダッシュボードの欄の決まり（PBI-118）。画面（クライアント）とデータ（サーバー）の両方から使うので、サーバー専用のものを
 * 読み込まないこのファイルに置く。
 */

/**
 * 止まっているタスクの理由ごとの、並びの順位（小さいほど先）。すべての理由に順位を付ける：理由を足したのに順位を付け忘れると、
 * その理由で止まったタスクがダッシュボードから消えるので、型で確かめる（satisfies）。
 */
const PAUSE_REASON_RANK = {
  usage_limit: 0,
  auth: 1,
  budget: 2,
  error: 3,
  verification: 4,
  incomplete: 5,
  unchanged: 6,
  needs_decision: 7,
  manual: 8,
  child_cancelled: 9,
} satisfies Record<PauseReason, number>;

/**
 * 止まっているタスクの理由の並び。利用上限・認証は1か所直せばまとめて動くことが多いので先頭に置き、画面で目立たせる。
 */
export const PAUSE_REASON_ORDER: readonly PauseReason[] = (
  Object.keys(PAUSE_REASON_RANK) as PauseReason[]
).sort((a, b) => PAUSE_REASON_RANK[a] - PAUSE_REASON_RANK[b]);

/** 1か所直せばまとめて動くことが多い理由（画面で目立たせる）。 */
export const FIX_ONCE_REASONS: readonly PauseReason[] = ["usage_limit", "auth"];

/** 工程ごとの差し戻しで、常に出す工程（要求要件・設計・実装）。ほかの工程は回数があるときだけ出す。 */
export const REWORK_STEPS: readonly StepKey[] = ["requirements", "design", "implement"];
