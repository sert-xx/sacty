import {
  type ActivityEvent,
  formatUsd,
  GATED_STEPS,
  isCompleted,
  openProposal,
  type Task,
} from "@sacty/core";
import type { LabelMessages } from "@/i18n/messages/labels";

/** 画面の表示ラベル。文言は画面の言語の辞書（i18n/messages/labels）から取る。 */
export const usd = formatUsd;

export function statusText(task: Task, l: LabelMessages): string {
  if (task.status === "paused" && task.pausedReason) return l.pause[task.pausedReason];
  const proposal = openProposal(task);
  if (proposal && !proposal.judgement) return l.state.guardianJudging;
  if (task.status === "idle" && isCompleted(task)) return l.state.completed;
  if (task.status === "idle" && task.verification === "pending") return l.state.testsRunning;
  if (task.status === "idle" && task.verification === "tests_passed") {
    return l.state.finalReviewing;
  }
  if (task.status === "escalated" && proposal) return l.state.changeUndecided;
  if (task.status === "escalated" && task.escalation?.reason === "rework_confirmation") {
    return l.state.reworkConfirmation;
  }
  if (task.status === "awaiting_approval" && task.pendingReview) return l.state.reworkJudging;
  if (task.status === "awaiting_approval" && task.gate?.step === "pr") {
    // PR を作ったタスクは、PR のマージで承認する（PBI-14a）
    if (task.pullRequestState === "closed") return l.state.prClosed;
    if (task.pullRequestState === "merged_outdated") return l.state.prMergedOutdated;
    if (task.pullRequestState === "open") return l.state.prAwaitingMerge(task.gate.submission);
    return l.state.deliverableReview(task.gate.submission);
  }
  if (task.status === "awaiting_approval" && task.gate) {
    return l.state.stepApproval(l.step[task.gate.step], task.gate.submission);
  }
  return l.status[task.status];
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
export function personAction(task: Task, l: LabelMessages): { href: string; label: string } {
  // ゴールガーディアンが判定できなかった申し出は、タスク詳細の「変更の申し出と判定」で判断する
  if (task.status === "escalated" && openProposal(task)) {
    return { href: `/tasks/${task.id}#proposals`, label: l.action.decide };
  }
  if (task.status === "escalated") {
    return { href: `/tasks/${task.id}/review`, label: l.action.decide };
  }
  if (task.status === "awaiting_approval") {
    return { href: `/tasks/${task.id}/review`, label: l.action.review };
  }
  return { href: `/tasks/${task.id}`, label: l.action.decide };
}

/** 一時停止・中止の操作を出すか。中止したタスクと、完了したタスクには出さない。 */
export function canControl(task: Task): boolean {
  return task.status !== "cancelled" && !isCompleted(task);
}

/** 人間の判断が必要な状態か（承認待ち・エスカレーション・一時停止）。 */
export function needsPerson(task: Task): boolean {
  return (
    task.status === "awaiting_approval" || task.status === "escalated" || task.status === "paused"
  );
}

/** 作業履歴の1行を、人が読める文にする。 */
export function describeEvent(event: ActivityEvent, l: LabelMessages): string {
  const e = l.event;
  const actor = l.actor[event.actor];
  const cost = (costUsd: number, estimated: boolean) =>
    `${usd(costUsd)}${estimated ? e.estimated : ""}`;
  const withCost = (costUsd: number, estimated: boolean) =>
    costUsd > 0 ? e.withCost(actor, cost(costUsd, estimated)) : actor;
  switch (event.type) {
    case "TaskCreated":
      return e.TaskCreated(actor);
    case "StepsChosen":
      return e.StepsChosen(
        event.payload.steps.map((s) => l.step[s]).join(e.stepsJoin),
        event.payload.reason === undefined ? undefined : l.text(event.payload.reason),
      );
    case "AgentRunStarted":
      return e.AgentRunStarted(
        l.step[event.payload.step],
        event.payload.agentId,
        l.auth[event.payload.authMode],
      );
    case "AgentRunCompleted":
      return e.AgentRunCompleted(
        l.step[event.payload.step],
        cost(event.payload.costUsd, event.payload.estimated),
        event.payload.step === "design" ? event.payload.testViewpoints.length : undefined,
      );
    case "AgentRunFailed":
      return e.AgentRunFailed(l.step[event.payload.step], l.text(event.payload.message));
    case "BudgetWarned":
      return e.BudgetWarned(usd(event.payload.usedUsd), usd(event.payload.capUsd));
    case "TaskPaused":
      // 人間が止めたときは、だれが止めたかを残す
      return event.payload.reason === "manual"
        ? e.TaskPausedManual(actor)
        : l.pause[event.payload.reason];
    case "BudgetCapRaised":
      return e.BudgetCapRaised(usd(event.payload.capUsd), actor);
    case "TaskResumed":
      return e.TaskResumed(actor);
    case "StepSubmitted":
      return event.payload.step === "pr"
        ? e.submittedDeliverable(event.payload.submission)
        : e.submittedStep(l.step[event.payload.step], event.payload.submission);
    case "StepApproved":
      return event.payload.step === "pr"
        ? e.approvedDeliverable(actor)
        : e.approvedStep(l.step[event.payload.step], actor);
    case "ChangeProposed":
      return e.ChangeProposed(
        l.step[event.payload.fromStep],
        l.step[event.payload.target],
        event.payload.proposalId,
      );
    case "ChangeJudged":
      return e.ChangeJudged(
        event.payload.proposalId,
        l.verdict[event.payload.verdict],
        l.text(event.payload.reason),
        withCost(event.payload.costUsd, event.payload.estimated),
      );
    case "ChangeDecided":
      return e.ChangeDecided(event.payload.proposalId, event.payload.accept, actor);
    case "ChangeApplied":
      return e.ChangeApplied(event.payload.proposalId);
    case "RepositoryPrepared":
      return e.RepositoryPrepared(
        event.payload.url,
        event.payload.baseBranch,
        event.payload.baseCommit.slice(0, 7),
      );
    case "TestsRun":
      return e.TestsRun(
        event.payload.passed,
        event.payload.exitCode,
        event.payload.unmappedViewpoints,
      );
    case "FinalReviewed": {
      const failures =
        event.payload.viewpoints.filter((v) => !v.verified).length +
        event.payload.remarks.filter((r) => !r.notRecurred).length;
      return e.FinalReviewed(
        event.payload.passed,
        failures,
        withCost(event.payload.costUsd, event.payload.estimated),
      );
    }
    case "PullRequestPublished":
      return event.payload.url
        ? e.prPublished(
            event.payload.number,
            event.payload.branch,
            event.payload.commit.slice(0, 7),
          )
        : e.branchPushed(event.payload.branch, event.payload.commit.slice(0, 7));
    case "BranchPushed":
      return e.BranchPushed(event.payload.branch, event.payload.commit.slice(0, 7));
    case "PullRequestMerged":
      return event.payload.outdated
        ? e.PullRequestMergedOutdated(event.payload.number, event.payload.by)
        : e.PullRequestMerged(event.payload.number, event.payload.by);
    case "PullRequestClosed":
      return e.PullRequestClosed(event.payload.number);
    case "PullRequestReopened":
      return e.PullRequestReopened(event.payload.number);
    case "IssueCommented":
      return e.IssueCommented(event.payload.url);
    case "IssueCommentFailed":
      return e.IssueCommentFailed(l.text(event.payload.message));
    case "ReviewTargetResolved":
      return e.ReviewTargetResolved(event.payload.url, event.payload.headCommit.slice(0, 7));
    case "PullRequestReviewPosted":
      return e.PullRequestReviewPosted(event.payload.url);
    case "GuardianMissed":
      return e.GuardianMissed;
    case "FinalReviewFailed":
      return e.FinalReviewFailed(
        l.text(event.payload.message),
        cost(event.payload.costUsd, event.payload.estimated),
      );
    case "StepQueued":
      return e.StepQueued(l.step[event.payload.step]);
    case "ChangesRequested": {
      const where =
        event.payload.step === "pr"
          ? e.changesAtDeliverable
          : e.changesAtStep(l.step[event.payload.step]);
      const tail = e.changesTail(event.payload.remarks.length, event.payload.overLimit, actor);
      const target = event.payload.target;
      if (target && target !== event.payload.step) {
        // 承認ゲートのある工程に戻すときだけ、その承認を取り消す
        return `${e.changesTarget(where, l.step[target], GATED_STEPS.includes(target))}${tail}`;
      }
      return `${where}${tail}`;
    }
    case "TaskCancelled": {
      const names = (result: string) =>
        event.payload.cleanup
          .filter((c) => c.result === result)
          .map((c) => l.cleanupTarget[c.target]);
      return e.TaskCancelled(names("done"), names("failed"), actor);
    }
    case "ContextResolved":
      return e.ContextResolved(
        event.payload.layers.map(
          (layer) => `${layer.repo}${layer.ref ? `#${layer.ref}` : ""}@${layer.commit.slice(0, 7)}`,
        ),
        event.payload.warnings.map(l.text),
      );
    case "RemarkVoided":
      return e.RemarkVoided(event.payload.remarkId, actor);
    case "TaskEscalated":
      return event.payload.reason === "change_undecidable"
        ? e.escalatedUndecidable(event.payload.proposalId)
        : event.payload.reason === "rework_confirmation"
          ? e.escalatedRework(l.step[event.payload.target ?? event.payload.step])
          : e.escalatedTooMany(l.step[event.payload.target ?? event.payload.step]);
    case "PullRequestReviewImported":
      return e.PullRequestReviewImported(
        event.payload.number,
        [...new Set(event.payload.items.map((item) => item.author))].join(", "),
        event.payload.remarks.length,
      );
    case "ReworkJudged":
      return e.ReworkJudged(
        event.payload.target ? l.step[event.payload.target] : undefined,
        l.text(event.payload.reason),
        withCost(event.payload.costUsd, event.payload.estimated),
      );
  }
}

const stampFormats = {
  ja: new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }),
  en: new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }),
};

/** 作業履歴などの日時（月/日 時:分）。 */
export function formatStamp(iso: string, locale: "ja" | "en" = "ja"): string {
  return stampFormats[locale].format(new Date(iso));
}
