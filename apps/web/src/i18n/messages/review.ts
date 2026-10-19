/**
 * 画面の文言：承認（review・gate-form）。英語の用語は labels.ts の用語集に合わせる。
 * 判断に要ることだけを本文に残し、仕組みは *Hint に書く（PBI-117）。
 */
const ja = {
  loading: "読み込み中…",
  notAwaiting: "このタスクは承認待ちではありません。",
  backToTask: "タスクの詳細に戻る",
  breadcrumb: "パンくず",
  approval: "承認",
  stepApproval: (step: string) => `${step}の承認`,
  notReproduced: "再現できなかった",
  submission: (n: number) => `${n}回目の提出`,
  rounds: (n: number) => ` ・ 差し戻し${n}回`,
  escalated: "エスカレーション",
  fromProposalTitle: (id: string) => `${id}による変更案`,
  fromProposalBody: (from: string, byPerson: boolean, step: string) =>
    `${from}の工程の申し出を${byPerson ? "人" : "ゴールガーディアン"}が認めました。承認済みの${step}が変わるので、もう一度承認してください。`,
  reason: (reason: string) => `理由：${reason}`,
  history: "これまでの指摘への対応",
  deliverable: "成果物",
  noOutput: "（出力がありません）",
  viewpoints: "テスト観点",
  viewpointsNote: (n: number) => `${n}件`,
  viewpointsHint: "承認すると凍結し、最終レビューの基準になります。",
  frozenRequirements: "承認済みの要求要件",
  frozenNote: (n: number) => `${n}回目の提出・凍結`,
  frozenHint: "変えるには、要求要件へ差し戻して、もう一度承認します。",
  decision: "判断",
  remark: {
    label: "指摘",
    round: (n: number, current: boolean) => `${n}回目の差し戻し${current ? " ・ 今回" : ""}`,
    voided: "無効",
    response: "対応",
    voidedNote: "無効にした指摘。エージェントに渡しません",
    noResponse: (n: number) => `${n}回目の提出に対応の記載なし`,
    respondedIn: (n: number) => `${n}回目の提出での対応`,
    void: "無効にする",
    voidHint: "前提が変わった指摘を無効にすると、以降はエージェントに渡しません。",
  },
  gate: {
    escalated: (max: number) =>
      `差し戻しが上限の${max}回に達しました。承認するか、上限を超えて差し戻すかを決めてください。`,
    targetLegend: "やり直す工程",
    redo: (step: string) => `${step}をやり直す`,
    redoFrom: (step: string) => `${step}からやり直す`,
    revokeNote: (step: string) => `${step}の承認を取り消し、もう一度承認します。`,
    commentsLabel: "指摘（差し戻すときは必須）",
    commentsLabelRework: "指摘（空なら取り込んだ指摘のまま）",
    commentsHint: (max: number) =>
      `指摘はタスクに累積し、再提出のたびにすべてエージェントに渡します。同じ工程への差し戻しが${max}回を超えるとエスカレーションです。`,
    commentsPlaceholder: "1 行に 1 件。例：受け入れ条件に、エラー時の振る舞いがない",
    requestOverLimit: "上限を超えて差し戻す",
    request: "差し戻す",
    approve: "承認する",
    operationExecutedHelp:
      "外部操作は実行済みのため、差し戻し・再実行はできません。結果を確かめて承認するか、中止して修正を新しいタスクで依頼してください。",
    notReproducedTitle: "再現できませんでした",
    notReproducedHelp:
      "再現のテストが失敗しなかったため、先へ進めません。手順・入力・環境などの手がかりを指摘に書いて差し戻すか、中止してください。",
    noChangesTitle: "変更なし・PR 無し",
    noChangesHelp:
      "実装は起点から何も変えていません。承認すると変更なしで完了し、差し戻すと実装をやり直します。",
    noChangesHint: "変更が要らない理由は、実装の説明・テストの結果・最終レビューで確かめられます。",
    prTitle: "GitHub の PR で判断します",
    prHelp: "マージで承認、コメントで差し戻しです。",
    prHint:
      "レビュー・行へのコメント・コメントを差し戻しとして取り込み、ゴールガーディアンが決めた工程（実装・設計・要求要件）からやり直します。取り込みは、最後のコメントから 2 分後です。設計・要求要件からやり直したら、もう一度承認します。",
    stepPrHelp: (step: string) =>
      `マージで${step}を承認し、次の工程に進みます。コメントは差し戻しです。`,
    stepPrHint: (step: string) =>
      `${step}は、タスクブランチへの PR です。コメントを差し戻しとして取り込み、ゴールガーディアンが${step}のやり直し（同じ PR を更新）か、前の工程への差し戻しかを決めます。Sacty は 1 分ごとに確かめ、最後のコメントから 2 分後に取り込みます。`,
    prOpen: (n: number) => `PR #${n} を GitHub で開く`,
    prClosed: "PR はマージされずに閉じられました。GitHub で開き直すか、中止してください。",
    prRequestNote: "差し戻すときは、ここに指摘を入力してください。",
    reworkTitle: "PR の指摘の戻し先を確かめてください",
    reworkSuggestion: (step: string, note: string) =>
      `ゴールガーディアンの提案：${step}からやり直す（${note}）`,
    reworkHelp: "戻し先を選んで差し戻してください。PR の指摘は取り込み済みです。",
    reworkHint: "指摘を空にすると、取り込んだ指摘をそのまま使います。",
    prMergedOutdated:
      "PR は Sacty の提出と別の内容でマージされました。次の確認で、その内容を承認として進めます。",
  },
};

export type ReviewMessages = typeof ja;

const en: ReviewMessages = {
  loading: "Loading…",
  notAwaiting: "This task is not awaiting approval.",
  backToTask: "Back to task details",
  breadcrumb: "Breadcrumb",
  approval: "Approval",
  stepApproval: (step) => `${step} approval`,
  notReproduced: "Not reproduced",
  submission: (n) => `Submission ${n}`,
  rounds: (n) => ` · changes requested ${n} time${n === 1 ? "" : "s"}`,
  escalated: "Escalated",
  fromProposalTitle: (id) => `Revised by ${id}`,
  fromProposalBody: (from, byPerson, step) =>
    `${byPerson ? "A person" : "The Goal Guardian"} accepted a change request from the ${from} step. It changes the approved ${step}, so approve it again.`,
  reason: (reason) => `Reason: ${reason}`,
  history: "Responses to earlier comments",
  deliverable: "Deliverable",
  noOutput: "(No output)",
  viewpoints: "Test viewpoints",
  viewpointsNote: (n) => `${n} viewpoint${n === 1 ? "" : "s"}`,
  viewpointsHint: "Frozen on approval and used as the basis for the final review.",
  frozenRequirements: "Approved requirements",
  frozenNote: (n) => `Submission ${n} · frozen`,
  frozenHint: "To change it, request changes on Requirements and approve again.",
  decision: "Decision",
  remark: {
    label: "Comment",
    round: (n, current) => `Changes requested, round ${n}${current ? " · this round" : ""}`,
    voided: "Voided",
    response: "Response",
    voidedNote: "Voided comment; not passed to the agent",
    noResponse: (n) => `Not addressed in submission ${n}`,
    respondedIn: (n) => `Addressed in submission ${n}`,
    void: "Void",
    voidHint: "Void a comment whose premise changed; it is no longer passed to the agent.",
  },
  gate: {
    escalated: (max) =>
      `Changes have been requested the maximum ${max} time${max === 1 ? "" : "s"}. Approve as is, or request changes beyond the limit.`,
    targetLegend: "Step to redo",
    redo: (step) => `Redo ${step}`,
    redoFrom: (step) => `Redo from ${step}`,
    revokeNote: (step) => `Revokes the ${step} approval; approve it again afterwards.`,
    commentsLabel: "Comments (required to request changes)",
    commentsLabelRework: "Comments (empty keeps the imported ones)",
    commentsHint: (max) =>
      `Comments accumulate on the task and are all passed to the agent on every resubmission. Requesting changes on the same step more than ${max} time${max === 1 ? "" : "s"} escalates the task.`,
    commentsPlaceholder: "One per line, e.g. The acceptance criteria don't cover error behavior",
    requestOverLimit: "Request changes beyond the limit",
    request: "Request changes",
    approve: "Approve",
    operationExecutedHelp:
      "The external operation has already run, so it cannot be sent back or rerun. Check the result and approve it, or cancel and request any correction in a new task.",
    notReproducedTitle: "The bug was not reproduced",
    notReproducedHelp:
      "The reproduction test did not fail, so the task can't move on. Request changes with hints (steps, input, environment), or cancel the task.",
    noChangesTitle: "No changes, no PR",
    noChangesHelp:
      "The implementation changed nothing from the base. Approving finishes the task without changes; requesting changes redoes the implementation.",
    noChangesHint:
      "Check why no change is needed in the implementation notes, test results, and final review.",
    prTitle: "Decide on the GitHub PR",
    prHelp: "Merging approves; comments request changes.",
    prHint:
      "Comments in reviews, on lines, or on the PR are imported as change requests, and the work is redone from the step the Goal Guardian picks (implementation, design, or requirements). Comments are imported two minutes after the last one. When design or requirements are redone, approve the reworked deliverable again.",
    stepPrHelp: (step) =>
      `Merging approves the ${step} and moves on to the next step; comments request changes.`,
    stepPrHint: (step) =>
      `The ${step} is a PR to the task branch. Comments are imported as change requests, and the Goal Guardian decides whether to redo the ${step} (updating the same PR) or go back to an earlier step. Sacty checks every minute and imports two minutes after the last comment.`,
    prOpen: (n) => `Open PR #${n} on GitHub`,
    prClosed: "The PR was closed without merging. Reopen it on GitHub, or cancel the task.",
    prRequestNote: "To request changes, enter your comments here.",
    reworkTitle: "Confirm the step to redo for the PR comments",
    reworkSuggestion: (step, note) => `Goal Guardian's suggestion: redo from ${step} (${note})`,
    reworkHelp: "Choose the step to redo, then request changes. The PR comments are imported.",
    reworkHint: "Leave the comments empty to use the imported comments as they are.",
    prMergedOutdated:
      "The PR was merged with content different from Sacty's submission. On the next check, that content is approved and the task moves on.",
  },
};

export const review = { ja, en };
