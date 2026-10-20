import { StepKey } from "@sacty/core";

/**
 * エージェントの実行とテストの実行の上限（PBI-150）。config.yaml の run_timeout で、既定と役割ごとの上書きを決める。
 * 書かなければ、エージェントは 30 分・テストは 20 分（PBI-150 より前の固定の値）。
 */

/** エージェントの1回の実行の上限の既定（分）。 */
export const DEFAULT_AGENT_TIMEOUT_MINUTES = 30;
/** テストのコマンドの1回の実行の上限の既定（分）。 */
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

/** その役割のエージェントの実行の上限（ミリ秒）。役割の上書きがあればそれ、無ければ既定。設定を読めなければ固定の既定。 */
export function agentTimeoutMs(timeouts: RunTimeouts | undefined, role?: string): number {
  const roleMinutes = role !== undefined ? timeouts?.roles[role as RunTimeoutRole] : undefined;
  return (roleMinutes ?? timeouts?.agentMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES) * 60_000;
}

/** テストのコマンドの実行の上限（ミリ秒）。 */
export function testTimeoutMs(timeouts: RunTimeouts | undefined): number {
  return (timeouts?.testMinutes ?? DEFAULT_TEST_TIMEOUT_MINUTES) * 60_000;
}
