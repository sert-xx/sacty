/** 画面の文言：承認・成果物チェック（review・gate-form）。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  loading: "読み込み中…",
  notAwaiting: "このタスクは承認待ちではありません。",
  backToTask: "タスクの詳細に戻る",
  breadcrumb: "パンくず",
  deliverableReview: "成果物チェック",
  stepApproval: (step: string) => `${step}の承認`,
  submission: (n: number) => `${n}回目の提出`,
  rounds: (n: number) => ` ・ 差し戻し${n}回`,
  escalated: "エスカレーション",
  fromProposalTitle: (id: string) => `変更の申し出（${id}）による変更案です`,
  fromProposalBody: (from: string, byPerson: boolean, step: string) =>
    `${from}の工程からの申し出を、${byPerson ? "人間" : "ゴールガーディアン"}が認めました。承認済みの${step}を変えるため、もう一度承認してください。`,
  reason: (reason: string) => `理由：${reason}`,
  history: "これまでの指摘への対応",
  deliverable: "成果物",
  noOutput: "（出力がありません）",
  viewpoints: "テスト観点",
  viewpointsNote: (n: number) => `${n}件・承認すると凍結され、最終レビューの基準になります`,
  frozenRequirements: "承認済みの要求要件",
  frozenNote: (n: number) => `${n}回目の提出・凍結（変えるには要求要件へ差し戻し、再承認が必要）`,
  decision: "判断",
  remark: {
    label: "指摘",
    round: (n: number, current: boolean) => `${n}回目の差し戻し${current ? " ・ 今回" : ""}`,
    voided: "無効",
    response: "対応",
    voidedNote: "（無効にした指摘のため、エージェントに渡していません）",
    noResponse: (n: number) => `（${n}回目の提出では、対応の記載がありません）`,
    respondedIn: (n: number) => `${n}回目の提出での対応`,
    void: "この指摘を無効にする（前提が変わったため、以降エージェントに渡さない）",
  },
  gate: {
    escalated: (max: number) =>
      `差し戻しが上限（${max}回）に達しました。要求そのものを見直すなど、方針を判断してください。このまま承認するか、上限を超えて差し戻しを続けられます。`,
    targetLegend: "差し戻す場合の、やり直す工程",
    redo: (step: string) => `${step}をやり直す`,
    redoFrom: (step: string) => `${step}からやり直す`,
    revokeNote: (step: string) =>
      `${step}の承認を取り消します。再提出された${step}を、もう一度承認する必要があります。`,
    commentsLabel: "指摘（差し戻す場合は必須。1行に1件）",
    commentsPlaceholder: "例：受け入れ条件に、エラー時の振る舞いがない",
    requestOverLimit: "上限を超えて差し戻す",
    request: "差し戻す",
    approve: "承認する",
    note: (max: number) =>
      `指摘はタスクに累積し、再提出のたびにすべてエージェントに渡されます。同じ工程への差し戻しが${max}回を超えるとエスカレーションになります。`,
    prTitle: "GitHub の PR で判断します",
    prHelp:
      "PR をレビューしてマージすると、成果物チェックの承認になり、タスクが完了します（sacty が1分ごとに確かめます）。",
    prOpen: (n: number) => `PR #${n} を GitHub で開く`,
    prClosed:
      "PR はマージされずに閉じられました。GitHub で開き直すと、またマージを待ちます。不要なら、タスク詳細から中止してください。",
    prRequestNote: "差し戻す場合は、ここで指摘を入力してください。",
    prMergedOutdated:
      "PR は、最新の提出より前の内容でマージされました。差し戻すと、作り直した内容を新しい PR で出します。不要なら、タスク詳細から中止してください。",
  },
};

export type ReviewMessages = typeof ja;

const en: ReviewMessages = {
  loading: "Loading…",
  notAwaiting: "This task is not awaiting approval.",
  backToTask: "Back to task details",
  breadcrumb: "Breadcrumb",
  deliverableReview: "Deliverable review",
  stepApproval: (step) => `${step} approval`,
  submission: (n) => `Submission ${n}`,
  rounds: (n) => ` · changes requested ${n} time${n === 1 ? "" : "s"}`,
  escalated: "Escalated",
  fromProposalTitle: (id) => `Revised by a change request (${id})`,
  fromProposalBody: (from, byPerson, step) =>
    `${byPerson ? "A person" : "The Goal Guardian"} accepted a change request from the ${from} step. It changes the approved ${step}, so approve it again.`,
  reason: (reason) => `Reason: ${reason}`,
  history: "Responses to earlier comments",
  deliverable: "Deliverable",
  noOutput: "(No output)",
  viewpoints: "Test viewpoints",
  viewpointsNote: (n) =>
    `${n} viewpoint${n === 1 ? "" : "s"} · frozen on approval and used as the basis for the final review`,
  frozenRequirements: "Approved requirements",
  frozenNote: (n) =>
    `Submission ${n} · frozen (to change it, request changes on Requirements and approve again)`,
  decision: "Decision",
  remark: {
    label: "Comment",
    round: (n, current) => `Changes requested, round ${n}${current ? " · this round" : ""}`,
    voided: "Voided",
    response: "Response",
    voidedNote: "(Voided comment; not passed to the agent)",
    noResponse: (n) => `(Submission ${n} does not address this)`,
    respondedIn: (n) => `Addressed in submission ${n}`,
    void: "Void this comment (the premise changed; stop passing it to the agent)",
  },
  gate: {
    escalated: (max) =>
      `Changes have been requested the maximum ${max} time${max === 1 ? "" : "s"}. Decide how to proceed, for example by revisiting the requirements themselves. You can approve as is, or keep requesting changes beyond the limit.`,
    targetLegend: "If requesting changes, the step to redo",
    redo: (step) => `Redo ${step}`,
    redoFrom: (step) => `Redo from ${step}`,
    revokeNote: (step) =>
      `This revokes the ${step} approval. The resubmitted ${step} must be approved again.`,
    commentsLabel: "Comments (required to request changes; one per line)",
    commentsPlaceholder: "e.g. The acceptance criteria don't cover error behavior",
    requestOverLimit: "Request changes beyond the limit",
    request: "Request changes",
    approve: "Approve",
    prTitle: "Decide on the GitHub PR",
    prHelp:
      "Review and merge the PR to approve the deliverable review and complete the task (sacty checks every minute).",
    prOpen: (n) => `Open PR #${n} on GitHub`,
    prClosed:
      "The PR was closed without merging. Reopen it on GitHub to wait for a merge again, or cancel the task from its details.",
    prRequestNote: "To request changes, enter your comments here.",
    prMergedOutdated:
      "The PR was merged with content older than the latest submission. Request changes to open the reworked content as a new PR, or cancel the task from its details.",
    note: (max) =>
      `Comments accumulate on the task and are all passed to the agent on every resubmission. Requesting changes on the same step more than ${max} time${max === 1 ? "" : "s"} escalates the task.`,
  },
};

export const review = { ja, en };
