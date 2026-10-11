/** 画面の文言：タスクの詳細（app/tasks/[id]/page.tsx）。英語の用語は labels.ts の用語集に合わせる。 */
const ja = {
  breadcrumb: "パンくず",
  tasks: "タスク",
  loading: "読み込み中…",
  start: "開始地点：",
  project: " ・ プロジェクト：",
  sourceOpen: "（",
  sourceClose: "）",
  gate: {
    undecidable: "ゴールガーディアンが変更の申し出を判定できませんでした（エスカレーション）",
    tooMany: "差し戻しが上限に達しました（エスカレーション）",
    undecidableHelp: "申し出の理由と根拠を確認し、変更を認めるかどうかを判断してください。",
    tooManyHelp: "このまま承認するか、上限を超えて差し戻すかを判断してください。",
    reviewHelp: "成果物を確認し、承認するか差し戻してください。",
    prHelp:
      "GitHub で PR をレビューしてください。マージすると承認になり、タスクが完了します。レビューやコメントで指摘すると、差し戻しとして取り込みます。",
    rework: "PR の指摘の戻し先を確かめてください（エスカレーション）",
    reworkHelp: (step: string, note: string) =>
      `ゴールガーディアンは、PR の指摘を${step}からやり直すことを提案しています（${note}）。承認済みの成果物を変えることになるので、戻し先を確かめて差し戻してください。`,
    prClosedHelp:
      "PR がマージされずに閉じられました。GitHub で開き直すか、不要なら中止してください。",
    prMergedOutdatedHelp:
      "PR は、最新の提出より前の内容でマージされました。最新の提出はまだマージされていません。差し戻すと、作り直した内容を新しい PR で出します。不要なら中止してください。",
  },
  ticket: "チケット",
  ticketEmpty: "チケットに内容はありません。",
  steps: "工程",
  stepsNote: "オーケストレーターが選択",
  stepsReason: (reason: string) => `選んだ理由：${reason}`,
  stepsFallback: "オーケストレーターが選べなかったため、標準の工程で進めています。",
  ledger: "台帳",
  ledgerNote: "追記専用",
  deliverable: {
    approved: (n: number) => `人間が承認済み（${n}回目の提出・凍結）`,
    fromProposal: (id: string) => `${id}で申し出られた変更案（人間の再承認待ち）`,
    stale: "前回の下書き（前の工程が承認されたあと、作り直します）",
    draft: "工程エージェントの下書き",
    running: "工程エージェントが作成しています…",
    notYet: "まだ作成されていません。",
    viewpoints: "テスト観点",
    viewpointsNote: (n: number) => `${n}件・最終レビューの基準`,
  },
};

export type TaskMessages = typeof ja;

const en: TaskMessages = {
  breadcrumb: "Breadcrumb",
  tasks: "Tasks",
  loading: "Loading…",
  start: "Started from: ",
  project: " · Project: ",
  sourceOpen: " (",
  sourceClose: ")",
  gate: {
    undecidable: "The Goal Guardian could not decide on a change request (escalated)",
    tooMany: "Changes requested reached the limit (escalated)",
    undecidableHelp:
      "Check the reason and supporting facts of the request, then decide whether to accept the change.",
    tooManyHelp: "Decide whether to approve as is or request changes beyond the limit.",
    reviewHelp: "Check the deliverable, then approve it or request changes.",
    prHelp:
      "Review the PR on GitHub. Merging it approves the deliverable and completes the task. Comments in reviews or on the PR are imported as change requests.",
    rework: "Confirm the step to redo for the PR comments (escalated)",
    reworkHelp: (step, note) =>
      `The Goal Guardian suggests redoing from ${step} for the PR comments (${note}). This changes approved deliverables, so confirm the step to redo and request changes.`,
    prClosedHelp: "The PR was closed without merging. Reopen it on GitHub, or cancel the task.",
    prMergedOutdatedHelp:
      "The PR was merged with content older than the latest submission, so the latest submission is not merged. Request changes to open the reworked content as a new PR, or cancel the task.",
  },
  ticket: "Ticket",
  ticketEmpty: "The ticket has no content.",
  steps: "Steps",
  stepsNote: "Chosen by the Orchestrator",
  stepsReason: (reason) => `Why: ${reason}`,
  stepsFallback: "The Orchestrator could not choose, so the standard steps are used.",
  ledger: "Ledger",
  ledgerNote: "Append-only",
  deliverable: {
    approved: (n) => `Approved by a person (submission ${n}, frozen)`,
    fromProposal: (id) => `Change proposed in ${id} (awaiting your re-approval)`,
    stale: "Previous draft (redone after the earlier step is approved)",
    draft: "Step agent's draft",
    running: "The step agent is writing it…",
    notYet: "Not written yet.",
    viewpoints: "Test viewpoints",
    viewpointsNote: (n) => `${n} viewpoint${n === 1 ? "" : "s"} · basis of the final review`,
  },
};

export const task = { ja, en };
