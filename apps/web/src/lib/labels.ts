import {
  type Actor,
  type AuthMode,
  formatUsd,
  type LedgerEvent,
  type PauseReason,
  type StepKey,
  type Task,
} from "@sacty/core";

/** 画面の表示ラベル。多言語化はPBI-4で行う。 */
export const STEP_LABEL: Record<StepKey, string> = {
  requirements: "要求要件",
  design: "設計",
  implement: "実装",
  pr: "PR作成",
};

export const START_LABEL: Record<Task["start"], string> = {
  ticket: "sacty",
};

export const STATUS_LABEL: Record<Task["status"], string> = {
  queued: "実行待ち",
  running: "実行中",
  idle: "待機中",
  paused: "一時停止",
};

export const PAUSE_LABEL: Record<PauseReason, string> = {
  budget: "予算上限で一時停止",
  usage_limit: "利用上限で一時停止",
  auth: "認証エラーで一時停止",
  error: "エラーで一時停止",
};

export const PAUSE_HELP: Record<PauseReason, string> = {
  budget: "予算の上限に達したため止まっています。作業中のものは残っています。",
  usage_limit:
    "サブスクリプションの利用上限に達したため止まっています。上限が戻ってから再開すると、止まった工程を実行し直します。",
  auth: "認証に失敗したため止まっています。トークンやAPIキーを確認してから再開してください。",
  error: "エラーで止まっています。原因を確認してから再開すると、止まった工程を実行し直します。",
};

export const AUTH_LABEL: Record<AuthMode, string> = {
  subscription: "サブスクリプション",
  "api-key": "APIキー",
  bedrock: "Amazon Bedrock",
  stub: "スタブ",
};

export const ACTOR_LABEL: Record<Actor, string> = {
  person: "人間",
  sacty: "sacty",
  orchestrator: "オーケストレーター",
  guardian: "ゴールガーディアン",
  agent: "工程エージェント",
};

export const usd = formatUsd;

export function statusText(task: Task): string {
  return task.status === "paused" && task.pausedReason
    ? PAUSE_LABEL[task.pausedReason]
    : STATUS_LABEL[task.status];
}

/** 台帳の1行を、人が読める文にする。 */
export function describeEvent(event: LedgerEvent): string {
  switch (event.type) {
    case "TaskCreated":
      return `チケットを作成（${ACTOR_LABEL[event.actor]}）`;
    case "StepsChosen":
      return `工程を決定：${event.payload.steps.map((s) => STEP_LABEL[s]).join(" → ")}`;
    case "AgentRunStarted":
      return `${STEP_LABEL[event.payload.step]}の実行を開始（${event.payload.agentId}・${AUTH_LABEL[event.payload.authMode]}）`;
    case "AgentRunCompleted":
      return `${STEP_LABEL[event.payload.step]}の実行が完了（${usd(event.payload.costUsd)}${event.payload.estimated ? "・換算値" : ""}）`;
    case "AgentRunFailed":
      return `${STEP_LABEL[event.payload.step]}の実行が失敗：${event.payload.message}`;
    case "BudgetWarned":
      return `予算の80%に到達（${usd(event.payload.usedUsd)} / ${usd(event.payload.capUsd)}）`;
    case "TaskPaused":
      return PAUSE_LABEL[event.payload.reason];
    case "BudgetCapRaised":
      return `予算の上限を${usd(event.payload.capUsd)}に変更（${ACTOR_LABEL[event.actor]}）`;
    case "TaskResumed":
      return `再開（${ACTOR_LABEL[event.actor]}）`;
  }
}

const stampFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatStamp(iso: string): string {
  return stampFormat.format(new Date(iso));
}
