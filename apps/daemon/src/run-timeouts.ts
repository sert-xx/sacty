import { StepKey } from "@sacty/core";

/**
 * エージェントの実行の上限（PBI-150）。config.yaml の run_timeout で、既定と役割ごとの上書きを決める。
 * 書かなければ、エージェントは 30 分・テストは 20 分（PBI-150 より前の固定の値）。テストの上限は、テストを実行する役割
 * （最終レビュー・再現・PR のレビュー。TEST_RUNNING_ROLES）の既定に足す。
 */

/** エージェントの1回の実行の上限の既定（分）。 */
export const DEFAULT_AGENT_TIMEOUT_MINUTES = 30;
/** テストの実行の上限の既定（分）。テストを実行する役割の、エージェントの上限の既定に足す。 */
export const DEFAULT_TEST_TIMEOUT_MINUTES = 20;
/** 設定できる上限の範囲（分）。止まったエージェントを放っておかないよう、最長は 12 時間にする。 */
export const RUN_TIMEOUT_MIN_MINUTES = 1;
export const RUN_TIMEOUT_MAX_MINUTES = 720;

/** 上限を役割ごとに上書きできる役割（工程と、ゴールガーディアン・オーケストレーターなど。エージェントを実行する役割のすべて）。 */
export const RUN_TIMEOUT_ROLES = [
  ...StepKey.options,
  "guardian",
  "final-review",
  "rework",
  "orchestrator",
  "gather",
  "chat",
  "export",
  "audit",
  "audit-dive",
] as const;
export type RunTimeoutRole = (typeof RUN_TIMEOUT_ROLES)[number];

/** 読んだ設定（分）。 */
export type RunTimeouts = {
  agentMinutes: number;
  testMinutes: number;
  roles: Partial<Record<RunTimeoutRole, number>>;
};

/**
 * テストを実行する役割（PBI-150 の後、sacty がテストを別のコンテナで実行するのをやめ、最終レビューのゴールガーディアンと
 * 再現の工程のエージェントが自分でテストを実行する。PR のレビューの工程も、依存関係を取得して検証を実行する（PBI-153））。役割の上書きが無ければ、エージェントとテストの上限を足した分にする
 * （テストを別に実行していたときの合計と同じにする）。
 */
const TEST_RUNNING_ROLES: readonly string[] = ["final-review", "reproduce", "review"];

/**
 * その役割のエージェントの実行の上限（ミリ秒）。役割の上書きがあればそれ、無ければ既定（テストを実行する役割は、既定に
 * テストの上限を足したもの）。設定を読めなければ固定の既定。
 */
export function agentTimeoutMs(timeouts: RunTimeouts | undefined, role?: string): number {
  const roleMinutes = role !== undefined ? timeouts?.roles[role as RunTimeoutRole] : undefined;
  if (roleMinutes !== undefined) return roleMinutes * 60_000;
  const agentMinutes = timeouts?.agentMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES;
  const testMinutes =
    role !== undefined && TEST_RUNNING_ROLES.includes(role)
      ? (timeouts?.testMinutes ?? DEFAULT_TEST_TIMEOUT_MINUTES)
      : 0;
  return (agentMinutes + testMinutes) * 60_000;
}
