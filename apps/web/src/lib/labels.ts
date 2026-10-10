import type { Actor, LedgerEvent, StepKey, Task } from "@sacty/core";

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
};

export const ACTOR_LABEL: Record<Actor, string> = {
  person: "人間",
  sacty: "sacty",
  orchestrator: "オーケストレーター",
  guardian: "ゴールガーディアン",
  agent: "工程エージェント",
};

/** 台帳の1行を、人が読める文にする。 */
export function describeEvent(event: LedgerEvent): string {
  switch (event.type) {
    case "TaskCreated":
      return `チケットを作成（${ACTOR_LABEL[event.actor]}）`;
    case "StepsChosen":
      return `工程を決定：${event.payload.steps.map((s) => STEP_LABEL[s]).join(" → ")}`;
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
