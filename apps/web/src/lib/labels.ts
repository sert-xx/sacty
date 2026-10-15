import {
  type ActivityEvent,
  deliveredWithoutChanges,
  formatUsd,
  GATED_STEPS,
  gatePullRequest,
  isCompleted,
  MAX_FIX_CHAIN,
  openProposal,
  type StepKey,
  type Task,
} from "@sacty/core";
import type { LabelMessages } from "@/i18n/messages/labels";
import type { TaskMessages } from "@/i18n/messages/task";

/** 画面の表示ラベル。文言は画面の言語の辞書（i18n/messages/labels）から取る。 */
export const usd = formatUsd;

export function statusText(task: Task, l: LabelMessages): string {
  if (task.status === "paused" && task.pausedReason) return l.pause[task.pausedReason];
  const proposal = openProposal(task);
  if (proposal && !proposal.judgement) return l.state.guardianJudging;
  if (task.status === "idle" && isCompleted(task)) {
    // 実装に変更が無く、PR を作らずに完了した（PBI-90）
    return deliveredWithoutChanges(task) ? l.state.completedNoChanges : l.state.completed;
  }
  if (task.status === "idle" && task.verification === "pending") return l.state.testsRunning;
  if (task.status === "idle" && task.reproductionPending) return l.state.testsRunning;
  if (task.status === "idle" && task.verification === "tests_passed") {
    return l.state.finalReviewing;
  }
  if (task.status === "escalated" && proposal) return l.state.changeUndecided;
  if (task.status === "escalated" && task.escalation?.reason === "rework_confirmation") {
    return l.state.reworkConfirmation;
  }
  if (task.status === "awaiting_approval" && task.pendingReview) return l.state.reworkJudging;
  if (task.status === "awaiting_approval" && task.gate?.step === "pr") {
    // 実装に変更が無く、PR を作らなかった（PBI-90）。画面で、変更なしで完了にするかを判断する
    if (deliveredWithoutChanges(task)) return l.state.noChangesReview(task.gate.submission);
    // PR を作ったタスクは、PR のマージで承認する（PBI-14a）
    if (task.pullRequestState === "closed") return l.state.prClosed;
    if (task.pullRequestState === "merged_outdated") return l.state.prMergedOutdated;
    if (task.pullRequestState === "open") return l.state.prAwaitingMerge(task.gate.submission);
    return l.state.deliverableReview(task.gate.submission);
  }
  // 要求要件・設計の PR を作った工程も、PR のマージで承認する（PBI-57）
  const stepPr = task.status === "awaiting_approval" ? gatePullRequest(task) : undefined;
  if (task.gate && stepPr) {
    if (stepPr.state === "closed") return l.state.prClosed;
    if (stepPr.state === "merged_outdated") return l.state.prMergedOutdated;
    return l.state.stepPrAwaitingMerge(l.step[task.gate.step], task.gate.submission);
  }
  // 再現できなかった（PBI-29）。承認ではなく、差し戻すか中止するかの判断
  if (task.status === "awaiting_approval" && task.gate?.step === "reproduce") {
    return l.state.notReproduced;
  }
  // 統合レビューに続けて通らなかった（PBI-31）。不合格のまま承認するか、差し戻すかの判断
  if (
    task.status === "awaiting_approval" &&
    task.gate?.step === "integrate" &&
    task.integration?.passed === false
  ) {
    return l.state.integrationFailed;
  }
  if (task.status === "awaiting_approval" && task.gate) {
    return l.state.stepApproval(l.step[task.gate.step], task.gate.submission);
  }
  return l.status[task.status];
}

/**
 * 状態の表示の種類（PBI-42）。色は意味で分ける。working：AI・sacty が進めている（青）、waiting：順番・依存を
 * 待っている（灰）、person：人の出番（橙）、completed：完了（緑）、cancelled：中止（灰の輪）。
 * 完了と中止は、色に加えて印の形も変える（色だけに頼らない）。
 */
export type StatusTone = "working" | "waiting" | "person" | "completed" | "cancelled";

export function statusTone(task: Task): StatusTone {
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "idle" && isCompleted(task)) return "completed";
  // ゴールガーディアンが PR の指摘の戻し先を判断している間は、承認待ちでも AI が進めている
  if (task.status === "awaiting_approval" && task.pendingReview) return "working";
  if (needsPerson(task)) return "person";
  if (task.status === "queued" || task.status === "blocked") return "waiting";
  // 実行中・子タスクの進行中に加え、テスト・最終レビュー・判定など、完了していない idle も sacty が進めている
  return "working";
}

/**
 * テストのコマンドを使うタスクか（工程に実装がある）。調査・レビュー・タスク分割の親など、
 * 実装しないタスクには、テストのコマンドを出さない（PBI-28）。
 */
export function usesTestCommand(task: Task): boolean {
  return task.steps.some((s) => s.key === "implement");
}

/**
 * 実装の成果物に出す、テストの結果と最終レビュー。それぞれ、今の提出の検証のものか（current）を返す（PR #105 再レビュー指摘）。
 * - 今の提出の検証が始まった（verification が pending）なら、どちらも前の提出のもの
 * - 最終レビューは、最新のテストの結果（テストを飛ばしたなら、飛ばした時）より後のものだけが今の検証のもの
 * 前の提出のものは、隠さずに「前の提出の」と区別して出す。
 */
export function verificationResults(task: Task): {
  tests?: NonNullable<Task["lastTests"]>;
  testsCurrent: boolean;
  review?: NonNullable<Task["lastReview"]>;
  reviewCurrent: boolean;
} {
  const tests = task.lastTests;
  const review = task.lastReview;
  const started = task.verification === "pending";
  const checkedAt = task.testsSkippedAt ?? tests?.at;
  return {
    ...(tests ? { tests } : {}),
    testsCurrent: Boolean(tests) && !started,
    ...(review ? { review } : {}),
    reviewCurrent: Boolean(review && checkedAt && review.at >= checkedAt) && !started,
  };
}

/**
 * テストの仕組みが無いタスク（PBI-94）の、今の実装の提出についての、実装で用意したテストの状態。画面の注記と工程の欄を、今の
 * 提出の検証の結果で切り替えるのに使う（PR #105 レビュー指摘・再レビュー指摘・再々レビュー指摘）。
 * - pending：今の提出がテストのコマンドを申告し、まだ実行していない（前の提出のテストの結果は、今の提出のものとして扱わない）
 * - passed・failed：最新の検証で、実装で用意したテストを実行した結果（failed のあとは、実装のやり直しを待っている）
 * - undefined：テストを飛ばした・飛ばす（申告が無い）・まだ実装していない・テストのコマンドがあるタスク
 */
export function addedTestsResult(task: Task): "pending" | "passed" | "failed" | undefined {
  if (!task.noTestsReason) return undefined;
  // 今の提出の検証が始まった（テストの実行待ち）なら、前の提出の結果は使わない
  if (task.verification === "pending") return task.addedTestCommand ? "pending" : undefined;
  if (!task.lastTests || task.testsSkippedAt) return undefined;
  return task.lastTests.passed ? "passed" : "failed";
}

/**
 * sactyやエージェントが作業中か（実行待ち・実行中・ゴールガーディアンの判定中）。
 * 画面はこのあいだ自動で更新する。判定中のタスクは待機（idle）のままなので、状態だけでは分からない。
 */
export function isWorking(task: Task): boolean {
  if (task.status === "queued" || task.status === "running") return true;
  if (task.status === "idle" && task.verification) return true;
  // 再現のテストを実行して確かめている（PBI-29）
  if (task.status === "idle" && task.reproductionPending) return true;
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

/**
 * オーケストレーターが決めたサービス（PBI-47）と、その理由（PBI-70）。共用の compose を選ばせたのに使わないときも、
 * そのことと理由を出す。
 */
function servicesChoice(
  payload: Extract<ActivityEvent, { type: "StepsChosen" }>["payload"],
  l: LabelMessages,
): string {
  const e = l.event;
  const services = payload.services;
  if (services) {
    const source = services.compose
      ? e.sharedComposeFile(
          services.compose.name,
          services.file,
          `${services.compose.repo}${services.compose.ref ? `#${services.compose.ref}` : ""}`,
        )
      : services.file;
    return e.stepsServices(
      services.names.join(e.imagesJoin),
      source,
      services.steps.map((s) => l.step[s]).join(e.imagesJoin),
      payload.servicesReason,
    );
  }
  const shared = payload.sharedComposes ?? [];
  if (shared.length === 0 && !payload.servicesReason) return "";
  return e.stepsNoServices(shared.join(e.imagesJoin), payload.servicesReason);
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
      return e.TaskCreated(
        actor,
        event.payload.template ? l.template[event.payload.template] : undefined,
      );
    case "StepsChosen": {
      const chosen = e.StepsChosen(
        event.payload.steps.map((s) => l.step[s]).join(e.stepsJoin),
        event.payload.reason === undefined ? undefined : l.text(event.payload.reason),
      );
      // 工程ごとのイメージ（PBI-41）。書いていない工程は既定のイメージ
      const images = Object.entries(event.payload.images ?? {});
      // 工程ごとの書き出し先と理由（PBI-56）
      const exports = Object.entries(event.payload.exports ?? {});
      return (
        chosen +
        (images.length > 0
          ? e.stepsImages(
              images
                .map(([step, image]) => e.stepImage(l.step[step as StepKey], image))
                .join(e.imagesJoin),
              event.payload.imageSource ?? "orchestrator",
              event.payload.imageReason,
            )
          : "") +
        (exports.length > 0
          ? e.stepsExports(
              exports
                .map(([step, plan]) =>
                  e.stepExport(l.step[step as StepKey], plan?.to, plan ? l.text(plan.reason) : ""),
                )
                .join(e.imagesJoin),
            )
          : "") +
        servicesChoice(event.payload, l) +
        // テストの仕組みが無いと判断した根拠（PBI-94）
        (event.payload.noTestsReason ? e.stepsNoTests(event.payload.noTestsReason) : "")
      );
    }
    case "TicketTriaged":
      return e.TicketTriaged(
        event.payload.repo,
        l.text(event.payload.reason),
        event.actor === "person",
      );
    case "RepositoryChosen":
      return e.RepositoryChosen(
        event.payload.repo,
        l.text(event.payload.reason),
        event.actor === "person",
      );
    case "TicketPullRequestCommented":
      return e.TicketPullRequestCommented(event.payload.url);
    case "ServicesStarted":
      return e.ServicesStarted(
        l.step[event.payload.step],
        event.payload.compose
          ? e.sharedComposeFile(
              event.payload.compose.name,
              event.payload.file,
              event.payload.compose.commit.slice(0, 7),
            )
          : event.payload.file,
        event.payload.services
          .map((s) =>
            s.hostPorts && s.hostPorts.length > 0
              ? e.serviceHostPorts(
                  s.name,
                  s.hostPorts
                    .map((h) => `localhost:${h.port} → ${s.name}:${h.target}`)
                    .join(e.imagesJoin),
                )
              : s.name,
          )
          .join(e.imagesJoin),
        event.payload.forTests === true,
        (event.payload.sharedPorts ?? []).join(e.imagesJoin),
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
    case "TestsSkipped":
      return e.TestsSkipped;
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
    case "NoChangesFound":
      return e.NoChangesFound;
    case "PullRequestLabeled":
      return e.PullRequestLabeled(event.payload.number, event.payload.label, event.payload.created);
    case "PullRequestLabelFailed":
      return e.PullRequestLabelFailed(
        event.payload.number,
        event.payload.label,
        l.text(event.payload.message),
      );
    case "BranchPushed":
      return e.BranchPushed(event.payload.branch, event.payload.commit.slice(0, 7));
    case "TaskBranchCreated":
      return e.TaskBranchCreated(event.payload.branch, event.payload.commit.slice(0, 7));
    case "StepBranchPushed":
      return e.StepBranchPushed(
        l.step[event.payload.step],
        event.payload.branch,
        event.payload.commit.slice(0, 7),
      );
    case "StepPullRequestPublished":
      return e.StepPullRequestPublished(
        l.step[event.payload.step],
        event.payload.number,
        event.payload.path,
        event.payload.supersedes,
      );
    case "PullRequestMerged":
      // 前の版の、古い内容でのマージ（承認にしなかった）・人が直してからのマージ（PBI-63）・そのままのマージ
      return event.payload.outdated
        ? e.PullRequestMergedOutdated(event.payload.number, event.payload.by)
        : event.payload.edited
          ? e.PullRequestMergedEdited(
              event.payload.number,
              event.payload.by,
              (event.payload.submitted ?? "").slice(0, 7),
              (event.payload.commit ?? "").slice(0, 7),
              event.payload.document?.fallback,
            )
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
    case "AiRequestsRetried":
      return e.AiRequestsRetried(
        event.payload.retries,
        Math.round(event.payload.waitedMs / 1000),
        // 0 は、上流に届かなかった（接続の失敗）
        event.payload.statuses.map((s) => (s === 0 ? "connection" : String(s))).join(", "),
        event.payload.gaveUp,
      );
    case "AgentSessionArchived":
      if (event.payload.notArchived) return e.AgentSessionNotArchived;
      return e.AgentSessionArchived(
        event.payload.files.length,
        event.payload.files.filter((f) => f.truncated).length,
      );
    case "OrchestratorSessionUsed": {
      const p = event.payload;
      const os = l.orchestratorSession;
      const reason = os.reason[p.reason ?? "first"];
      const text =
        p.role === "chat"
          ? p.mode === "forked" && p.resumedFrom
            ? e.ChatSessionForked(p.resumedFrom, p.sessionId)
            : e.ChatSessionStarted(reason)
          : p.mode === "resumed"
            ? e.OrchestratorSessionResumed(p.sessionId ?? p.resumedFrom ?? "")
            : e.OrchestratorSessionStarted(reason, p.sessionId);
      return p.saved === false && p.notSaved
        ? text + e.sessionNotSaved(os.notSaved[p.notSaved])
        : text;
    }
    case "OrchestratorFailed":
      return e.OrchestratorFailed(
        l.text(event.payload.message),
        cost(event.payload.costUsd, event.payload.estimated),
      );
    case "FinalReviewFailed":
      return e.FinalReviewFailed(
        l.text(event.payload.message),
        cost(event.payload.costUsd, event.payload.estimated),
      );
    case "StepQueued":
      return e.StepQueued(l.step[event.payload.step]);
    case "TaskSplit":
      return e.TaskSplit(event.payload.children.length, event.payload.reason, [
        ...new Set(event.payload.children.flatMap((c) => (c.repo ? [c.repo] : []))),
      ]);
    case "TaskUnblocked":
      return e.TaskUnblocked;
    case "SplitCompleted":
      return e.SplitCompleted;
    case "IntegrationReviewed":
      // リポジトリの無い親（PBI-73）は、子タスクのリポジトリごとに読んだブランチ
      return e.IntegrationReviewed(
        event.payload.passed,
        event.payload.repositories
          ? event.payload.repositories
              .map((r) => `${r.repo} ${r.baseBranch}@${r.commit.slice(0, 7)}`)
              .join("・")
          : event.payload.baseBranch,
        event.payload.repositories ? "" : event.payload.commit.slice(0, 7),
        event.payload.findings.length,
      );
    case "StepCompleted":
      return e.StepCompleted(l.step[event.payload.step]);
    case "ReproductionChecked":
      return event.payload.reproduced
        ? e.reproduced(event.payload.exitCode)
        : e.notReproduced(
            event.payload.note ? l.text(event.payload.note) : e.testsPassed(event.payload.exitCode),
          );
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
      const names = (result: string) => [
        // 要求要件・設計の PR とブランチ（PBI-57）は、対象ごとに複数あるので、名前は1つにまとめる
        ...new Set(
          event.payload.cleanup
            .filter((c) => c.result === result)
            .map((c) => l.cleanupTarget[c.target]),
        ),
      ];
      const cancelled = e.TaskCancelled(names("done"), names("failed"), actor);
      // sacty が中止した理由（レビューの PR がマージされた・閉じられた。PBI-44）
      return event.payload.reason ? e.cancelledBecause(cancelled, event.payload.reason) : cancelled;
    }
    case "ReviewRestarted":
      return e.ReviewRestarted(actor);
    case "ContextResolved":
      return e.ContextResolved(
        event.payload.layers.map(
          (layer) => `${layer.repo}${layer.ref ? `#${layer.ref}` : ""}@${layer.commit.slice(0, 7)}`,
        ),
        event.payload.warnings.map(l.text),
        // 使えるようにした外部 PF（PBI-74）。どの層のものか（ホストは config.yaml）と、使える API
        event.payload.platforms ?? [],
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
    case "QuestionAsked":
      return e.QuestionAsked(event.payload.questionId, actor);
    case "ExportStarted":
      return e.ExportStarted(l.step[event.payload.step]);
    case "OutputExported": {
      const p = event.payload;
      return e.OutputExported(
        l.step[p.step],
        p.name,
        p.url
          ? { url: p.url }
          : p.runResult === "interrupted"
            ? { interrupted: l.text(p.failed ?? "") }
            : { failed: l.text(p.failed ?? "") },
        cost(p.costUsd, p.estimated),
      );
    }
    case "ExportRequested":
      return e.ExportRequested(l.step[event.payload.step], actor);
    case "QuestionAnswered":
      return e.QuestionAnswered(
        event.payload.questionId,
        event.payload.failed === undefined ? undefined : l.text(event.payload.failed),
        cost(event.payload.costUsd, event.payload.estimated),
      );
    case "ReworkJudged":
      return e.ReworkJudged(
        event.payload.target ? l.step[event.payload.target] : undefined,
        l.text(event.payload.reason),
        withCost(event.payload.costUsd, event.payload.estimated),
      );
    // マージの後の監視（PBI-89）
    case "DeploymentWatchStarted":
      return e.DeploymentWatchStarted(event.payload.number, event.payload.commit);
    case "DeploymentCiFinished":
      return e.DeploymentCiFinished(
        event.payload.result,
        event.payload.failures.map((f) => (f.job ? `${f.workflow} / ${f.job}` : f.workflow)),
        event.payload.skill,
        event.payload.skipCheck === undefined ? undefined : l.text(event.payload.skipCheck),
      );
    case "DeploymentCheckStarted":
      return e.DeploymentCheckStarted(event.payload.skill);
    case "DeploymentChecked":
      return e.DeploymentChecked(
        event.payload.result,
        event.payload.failed !== undefined ? l.text(event.payload.failed) : event.payload.summary,
        cost(event.payload.costUsd, event.payload.estimated),
      );
    case "DeploymentWatchSkipped":
      return e.DeploymentWatchSkipped(l.text(event.payload.detail ?? event.payload.reason));
    case "DeploymentFixRegistered":
      return e.DeploymentFixRegistered(event.payload.kind, event.payload.title);
    case "DeploymentFixSuppressed":
      return e.DeploymentFixSuppressed(event.payload.reason, MAX_FIX_CHAIN);
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

/**
 * テストの仕組みが無いタスク（PBI-94）の、工程の欄のテストのコマンドの文。合格のときだけ「検証し、目的から判定します」とし、
 * 不合格・実行待ちはそれぞれの文にする（PR #105 再々レビュー指摘）。
 */
export function testCommandOfNoTests(
  task: Task,
  reason: string,
  m: Pick<
    TaskMessages,
    "testCommandAdded" | "testCommandAddedFailed" | "testCommandAddedPending" | "testCommandNone"
  >,
): string {
  const added = addedTestsResult(task);
  if (added === "passed" && task.lastTests)
    return m.testCommandAdded(task.lastTests.command, reason);
  if (added === "failed" && task.lastTests) {
    return m.testCommandAddedFailed(task.lastTests.command, reason);
  }
  if (added === "pending") return m.testCommandAddedPending(task.addedTestCommand ?? "", reason);
  return m.testCommandNone(reason);
}
