import {
  type Actor,
  type AuthMode,
  formatUsd,
  type LedgerEvent,
  openProposal,
  type PauseReason,
  type StepKey,
  type Task,
  type Verdict,
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
  awaiting_approval: "承認待ち",
  escalated: "エスカレーション",
};

export const PAUSE_LABEL: Record<PauseReason, string> = {
  budget: "予算上限で一時停止",
  usage_limit: "利用上限で一時停止",
  auth: "認証エラーで一時停止",
  error: "エラーで一時停止",
  verification: "実装の検証に通らないため一時停止",
};

export const PAUSE_HELP: Record<PauseReason, string> = {
  budget: "予算の上限に達したため止まっています。作業中のものは残っています。",
  usage_limit:
    "サブスクリプションの利用上限に達したため止まっています。上限が戻ってから再開すると、止まった工程を実行し直します。",
  auth: "認証に失敗したため止まっています。トークンやAPIキーを確認してから再開してください。",
  error: "エラーで止まっています。原因を確認してから再開すると、止まった工程を実行し直します。",
  verification:
    "実装がテストか最終レビューに続けて通らないため止まっています。結果を確認し、必要なら設計を見直してから再開すると、実装をやり直します。",
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

export const VERDICT_LABEL: Record<Verdict, string> = {
  approved: "承認",
  rejected: "却下",
  undecidable: "判定できない",
};

export const usd = formatUsd;

export function statusText(task: Task): string {
  if (task.status === "paused" && task.pausedReason) return PAUSE_LABEL[task.pausedReason];
  const proposal = openProposal(task);
  if (proposal && !proposal.judgement) return "ゴールガーディアンが判定中";
  if (task.status === "idle" && task.verification === "pending") return "テストを実行中";
  if (task.status === "idle" && task.verification === "tests_passed") {
    return "ゴールガーディアンが最終レビュー中";
  }
  if (task.status === "escalated" && proposal) return "変更の申し出の判断待ち";
  if (task.status === "awaiting_approval" && task.gate) {
    const nth = task.gate.submission > 1 ? `（${task.gate.submission}回目）` : "";
    return `${STEP_LABEL[task.gate.step]}の承認待ち${nth}`;
  }
  return STATUS_LABEL[task.status];
}

/**
 * sactyやエージェントが作業中か（実行待ち・実行中・ゴールガーディアンの判定中）。
 * 画面はこのあいだ自動で更新する。判定中のタスクは待機（idle）のままなので、状態だけでは分からない。
 */
export function isWorking(task: Task): boolean {
  if (task.status === "queued" || task.status === "running") return true;
  if (task.status === "idle" && task.verification) return true;
  const proposal = openProposal(task);
  return Boolean(proposal && !proposal.judgement);
}

/** 人間が判断する場所への導線。 */
export function personAction(task: Task): { href: string; label: string } {
  // ゴールガーディアンが判定できなかった申し出は、タスク詳細の「変更の申し出と判定」で判断する
  if (task.status === "escalated" && openProposal(task)) {
    return { href: `/tasks/${task.id}#proposals`, label: "判断する" };
  }
  if (task.status === "escalated") return { href: `/tasks/${task.id}/review`, label: "判断する" };
  if (task.status === "awaiting_approval") {
    return { href: `/tasks/${task.id}/review`, label: "チェックする" };
  }
  return { href: `/tasks/${task.id}`, label: "判断する" };
}

/** 人間の判断が必要な状態か（承認待ち・エスカレーション・一時停止）。 */
export function needsPerson(task: Task): boolean {
  return (
    task.status === "awaiting_approval" || task.status === "escalated" || task.status === "paused"
  );
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
      return `${STEP_LABEL[event.payload.step]}の実行が完了（${usd(event.payload.costUsd)}${event.payload.estimated ? "・換算値" : ""}${event.payload.step === "design" ? `・テスト観点${event.payload.testViewpoints.length}件` : ""}）`;
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
    case "StepSubmitted":
      return `${STEP_LABEL[event.payload.step]}を提出（${event.payload.submission}回目）→ 承認待ち`;
    case "StepApproved":
      return `${STEP_LABEL[event.payload.step]}を承認・凍結（${ACTOR_LABEL[event.actor]}）`;
    case "ChangeProposed":
      return `${STEP_LABEL[event.payload.fromStep]}の工程が、${STEP_LABEL[event.payload.target]}の変更を申し出（${event.payload.proposalId}）`;
    case "ChangeJudged":
      return `${event.payload.proposalId}を${VERDICT_LABEL[event.payload.verdict]}：${event.payload.reason}（${ACTOR_LABEL[event.actor]}${event.payload.costUsd > 0 ? `・${usd(event.payload.costUsd)}${event.payload.estimated ? "・換算値" : ""}` : ""}）`;
    case "ChangeDecided":
      return `${event.payload.proposalId}を${event.payload.accept ? "認めた" : "認めなかった"}（${ACTOR_LABEL[event.actor]}）`;
    case "ChangeApplied":
      return `${event.payload.proposalId}の変更を反映`;
    case "RepositoryPrepared":
      return `対象リポジトリを用意（${event.payload.url}・${event.payload.baseBranch}・${event.payload.baseCommit.slice(0, 7)}）`;
    case "TestsRun":
      return `テストを実行：${event.payload.passed ? "合格" : "不合格"}（終了コード ${event.payload.exitCode}${event.payload.unmappedViewpoints.length > 0 ? `・テストの無い観点 ${event.payload.unmappedViewpoints.join(", ")}` : ""}）`;
    case "FinalReviewed": {
      const ng =
        event.payload.viewpoints.filter((v) => !v.verified).length +
        event.payload.remarks.filter((r) => !r.notRecurred).length;
      return `最終レビュー：${event.payload.passed ? "合格" : `不合格（${ng}件）`}（${ACTOR_LABEL[event.actor]}${event.payload.costUsd > 0 ? `・${usd(event.payload.costUsd)}${event.payload.estimated ? "・換算値" : ""}` : ""}）`;
    }
    case "StepQueued":
      return `${STEP_LABEL[event.payload.step]}を実行待ちにした（実行できるようになったため）`;
    case "ChangesRequested":
      if (event.payload.target && event.payload.target !== event.payload.step) {
        return `${STEP_LABEL[event.payload.step]}を差し戻し、${STEP_LABEL[event.payload.target]}からやり直し（${STEP_LABEL[event.payload.target]}の承認を取り消し）：指摘${event.payload.remarks.length}件${event.payload.overLimit ? "（上限を超えて）" : ""}（${ACTOR_LABEL[event.actor]}）`;
      }
      return `${STEP_LABEL[event.payload.step]}を差し戻し：指摘${event.payload.remarks.length}件${event.payload.overLimit ? "（上限を超えて）" : ""}（${ACTOR_LABEL[event.actor]}）`;
    case "RemarkVoided":
      return `指摘 ${event.payload.remarkId} を無効にした（${ACTOR_LABEL[event.actor]}）`;
    case "TaskEscalated":
      if (event.payload.reason === "change_undecidable") {
        return `ゴールガーディアンが${event.payload.proposalId ?? "変更の申し出"}を判定できなかったため、エスカレーション`;
      }
      return `${STEP_LABEL[event.payload.target ?? event.payload.step]}への差し戻しが上限に達したため、エスカレーション`;
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
