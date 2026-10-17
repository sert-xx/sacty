import {
  type ActivityEvent,
  AdoptAuditProposalInput,
  AUDIT_EVIDENCE_KINDS,
  type AuditCause,
  type AuditCauseStatus,
  type AuditDashboard,
  type AuditEvidence,
  type AuditEvidenceKind,
  type AuditFinding,
  type AuditProposal,
  type AuditProposalDecision,
  type AuditRow,
  type AuditTarget,
  auditRemarkCount,
  isAuditTarget,
  isPendingAuditProposal,
  type ListedAuditProposal,
  message,
  type Project,
  type ProjectAudits,
  RejectAuditProposalInput,
  ResumeAuditInput,
  type StepKey,
  sameAuditTarget,
  type Task,
  type TaskAudit,
} from "@sacty/core";
import { auditTargetCandidates } from "./audit-targets.js";
import { InvalidOperationError } from "./service.js";

/*
 * 完了したタスクの監査（PBI-124）。画面はデーモンの API から監査のデータを読む。PBI-124 では、裏側をモック
 * （MockAuditService）にして画面の挙動を一通り確かめ、PBI-125 で実際の監査の記録から作る実装に差し替える。
 * モックは明示的な切り替え（環境変数 SACTY_AUDIT_MOCK=1）でだけ使い、既定では監査の無い実装（NoAuditService）にする
 * （利用者の画面に偽の監査を出さないため）。
 */

/** 監査のデータと操作。server.ts はこの形だけを使う（PBI-125 で実装を差し替える）。 */
export interface AuditService {
  /** タスクの監査。監査が無ければ null。 */
  taskAudit(taskId: string): TaskAudit | null;
  /** プロジェクトの監査。プロジェクトが無ければ null。 */
  projectAudits(projectId: string): ProjectAudits | null;
  /** ダッシュボードの監査の指標（件数だけ）。 */
  dashboard(): AuditDashboard;
  /** 提案を採用し、改修のタスクを作る。 */
  adopt(proposalId: string, input: unknown): ListedAuditProposal;
  /** 提案を却下する（理由は必須。記録の前に秘密情報を伏せるので、待つことがある）。 */
  reject(proposalId: string, input: unknown): ListedAuditProposal | Promise<ListedAuditProposal>;
  /** 予算で一時停止した監査を、新しい上限（累計）で再開する。 */
  resume(taskId: string, input: unknown): TaskAudit;
}

export type AuditDeps = {
  tasks: () => Task[];
  activity: (taskId: string) => ActivityEvent[];
  projects: () => Project[];
  /** 1回の監査の、予算の既定の上限（config.yaml。読めなければ既定値）。 */
  defaultCapUsd: () => number;
};

/** 監査の無い実装（モックを切り替えていないとき。PBI-125 で実際の監査に差し替える）。 */
export class NoAuditService implements AuditService {
  constructor(private readonly deps: AuditDeps) {}

  taskAudit(): TaskAudit | null {
    return null;
  }

  projectAudits(projectId: string): ProjectAudits | null {
    if (!this.deps.projects().some((p) => p.id === projectId)) return null;
    return {
      projectId,
      mock: false,
      defaultCapUsd: this.deps.defaultCapUsd(),
      audits: [],
      causes: [],
      proposals: [],
    };
  }

  dashboard(): AuditDashboard {
    return { mock: false, projects: [], trend: [] };
  }

  adopt(proposalId: string, input: unknown): ListedAuditProposal {
    AdoptAuditProposalInput.parse(input);
    void proposalId;
    throw new InvalidOperationError(message("audit.proposalNotFound"));
  }

  reject(proposalId: string, input: unknown): ListedAuditProposal {
    RejectAuditProposalInput.parse(input);
    void proposalId;
    throw new InvalidOperationError(message("audit.proposalNotFound"));
  }

  resume(taskId: string, input: unknown): TaskAudit {
    ResumeAuditInput.parse(input);
    void taskId;
    throw new InvalidOperationError(message("audit.notFound"));
  }
}

export { auditTargetCandidates, isAuditTarget };

const ZERO_COUNTS: Record<AuditEvidenceKind, number> = Object.fromEntries(
  AUDIT_EVIDENCE_KINDS.map((k) => [k, 0]),
) as Record<AuditEvidenceKind, number>;

function counts(values: Partial<Record<AuditEvidenceKind, number>>) {
  return { ...ZERO_COUNTS, ...values };
}

function shift(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** モックの監査の開始（タスクの完了の1分後）と完了（開始の6分後）。 */
function mockAuditStartedAt(task: Task): string {
  return shift(task.updatedAt, 1);
}

function mockAuditFinishedAt(task: Task): string {
  return shift(mockAuditStartedAt(task), 6);
}

/** モックの原因の型。宛先の種類（実際の宛先はタスクの候補から選ぶ）と、提案の文。 */
type MockCause = {
  id: string;
  title: string;
  detail: string;
  step?: StepKey;
  proposals: { title: string; body: string; target: AuditTarget["kind"]; depth?: "top" }[];
};

/** モックの原因（プロジェクトの中で、タスクをまたいで使う）。文はエージェントの成果物と同じく、訳さない。 */
const CAUSES: Record<string, MockCause> = {
  lint: {
    id: "lint",
    title: "リンターの設定が無く、書式の指摘が PR で繰り返された",
    detail:
      "対象リポジトリにフォーマッターとリンターの設定が無く、実装のエージェントは書式を確かめられなかった。PR のレビューで、インデントと import の並びの指摘が 3 回続いた。",
    step: "implement",
    proposals: [
      {
        title: "リポジトリにフォーマッターの設定と、確かめるコマンドを足す",
        body: "- フォーマッターの設定ファイルを置く\n- `AGENTS.md` に、提出の前に実行するコマンドを書く",
        target: "repository",
      },
    ],
  },
  testCommand: {
    id: "testCommand",
    title: "テストのコマンドがリポジトリに書かれていない",
    detail:
      "実装のエージェントは、テストの実行の仕方を探して 4 回失敗した（存在しないスクリプトの呼び出し）。最終的にテストは通ったが、やり直しに費用の 3 割を使った。",
    step: "implement",
    proposals: [
      {
        title: "AGENTS.md に、テストの実行の仕方を書く",
        body: "```\nnpm test -- --run\n```\n\nを、実装の前に確かめるコマンドとして書く。",
        target: "repository",
      },
    ],
  },
  missingPath: {
    id: "missingPath",
    title: "ツールの呼び出しで、存在しないパスを何度も読もうとした",
    detail:
      "設計のエージェントが、古いディレクトリの構成を前提に `src/lib` を 6 回読もうとして失敗した。コンテキストの規約に、ディレクトリの構成が書かれていない。",
    step: "design",
    proposals: [
      {
        title: "コンテキストの規約に、ディレクトリの構成を書く",
        body: "主要なディレクトリと役割を、規約の冒頭に箇条書きで書く。",
        target: "context",
      },
      {
        title: "上位のコンテキストに、ファイルを探す手順のスキルを足す",
        body: "読む前に一覧を取るように、探し方のスキルを足す。",
        target: "context",
        depth: "top",
      },
    ],
  },
  boundary: {
    id: "boundary",
    title: "設計のテスト観点に、境界値の観点が抜けていた",
    detail:
      "人の差し戻しの指摘 2 件は、どちらも空のリストと上限の件数の扱いだった。設計のスキルに、境界値の観点を挙げる手順が無い。",
    step: "design",
    proposals: [
      {
        title: "設計のスキルに、境界値の観点を挙げる手順を足す",
        body: "テスト観点を書くときに、空・1件・上限・上限超えを必ず検討する。",
        target: "context",
      },
    ],
  },
  docsLocation: {
    id: "docsLocation",
    title: "設計書の置き場所が決まっておらず、PR で移動の指摘を受けた",
    detail:
      "設計のエージェントは設計書をリポジトリの直下に置いた。PR のレビューで `docs/design` へ移すよう指摘された。置き場所の決まりが、どこにも書かれていない。",
    step: "design",
    proposals: [
      {
        title: "コンテキストの規約に、設計書の置き場所を書く",
        body: "設計書は `docs/design/<タスクの名前>.md` に置く、と規約に書く。",
        target: "context",
      },
    ],
  },
  guardian: {
    id: "guardian",
    title: "最終レビューが、観点に無い理由で不合格にした",
    detail:
      "ゴールガーディアンの最終レビューが、承認済みの観点に無い性能の懸念で 2 回不合格にした。人はそのまま承認した。",
    step: "implement",
    proposals: [
      {
        title: "最終レビューのプロンプトで、観点に無い指摘を不合格の理由にしない",
        body: "観点に無い懸念は、不合格ではなく補足として書くように指示する。",
        target: "sacty",
      },
    ],
  },
};

/** モックの監査の場面。完了したタスクに、古い順に割り当てる。 */
type Scenario =
  | { status: "completed"; causes: string[]; counts: Partial<Record<AuditEvidenceKind, number>> }
  | { status: Exclude<TaskAudit["status"], "completed"> };

const SCENARIOS: Scenario[] = [
  {
    status: "completed",
    causes: ["lint", "docsLocation"],
    counts: { pullRequestRemark: 4, retry: 1 },
  },
  {
    status: "completed",
    causes: ["testCommand", "missingPath"],
    counts: { changesRequested: 1, toolFailure: 10, retry: 2 },
  },
  {
    status: "completed",
    causes: ["lint", "boundary"],
    counts: { changesRequested: 2, pullRequestRemark: 2 },
  },
  { status: "deepDiving" },
  { status: "budgetPaused" },
  { status: "failed" },
  { status: "surveying" },
  { status: "waiting" },
];

/** 9 件目からの場面（ゴールガーディアンが原因のものと、指摘の無いものを交互に）。 */
const LATER: Scenario[] = [
  { status: "completed", causes: ["guardian"], counts: { retry: 2, escalation: 1 } },
  { status: "completed", causes: [], counts: {} },
];

function scenarioAt(index: number): Scenario {
  return SCENARIOS[index] ?? (LATER[(index - SCENARIOS.length) % LATER.length] as Scenario);
}

/** 根拠の種類ごとに、作業履歴から結び付ける出来事（あれば、その行と実行のログへたどれる）。 */
const EVIDENCE_EVENTS: Record<AuditEvidenceKind, ActivityEvent["type"][]> = {
  changesRequested: ["ChangesRequested"],
  pullRequestRemark: ["PullRequestReviewImported", "ChangesRequested"],
  pause: ["TaskPaused"],
  retry: ["AgentRunFailed", "TestsRun", "FinalReviewed"],
  toolFailure: ["AgentRunCompleted", "AgentRunFailed", "AgentRunStarted"],
  escalation: ["TaskEscalated"],
};

const EVIDENCE_TEXT: Record<AuditEvidenceKind, string> = {
  changesRequested: "空のリストのときの表示が無い",
  pullRequestRemark: "import の並びが規約と違う",
  pause: "検証が 3 回通らず、一時停止した",
  retry: "テストが通らず、実装をやり直した",
  toolFailure: "存在しないファイルの読み込みに 4 回失敗した",
  escalation: "最終レビューの不合格が続き、人に上げた",
};

function evidenceFor(
  kinds: AuditEvidenceKind[],
  activity: ActivityEvent[],
  at: string,
  step: StepKey | undefined,
): AuditEvidence[] {
  return kinds.map((kind) => {
    const event = activity.find((e) => EVIDENCE_EVENTS[kind].includes(e.type));
    const runId = activity
      .map((e) => (e.payload as { runId?: unknown }).runId)
      .find((id): id is string => typeof id === "string" && id.length > 0);
    return {
      kind,
      at: event?.at ?? at,
      text: EVIDENCE_TEXT[kind],
      ...(step ? { step } : {}),
      ...(event ? { eventId: event.id } : {}),
      ...(kind === "toolFailure" && runId ? { runId } : {}),
    };
  });
}

/**
 * モックの監査（PBI-124）。プロジェクトの完了したタスクに、古い順に場面を割り当て、すべての状態・宛先・原因の状態を
 * 画面で確かめられるようにする。採用・却下・再開はメモリに持つだけで、デーモンを起動し直すと戻る。
 */
export class MockAuditService implements AuditService {
  private readonly decisions = new Map<string, AuditProposalDecision>();
  private readonly resumed = new Map<string, number>();

  constructor(private readonly deps: AuditDeps) {}

  /** プロジェクトの完了したタスク（完了した順）。 */
  private completed(projectId: string): Task[] {
    return this.deps
      .tasks()
      .filter((t) => t.projectId === projectId && isAuditTarget(t))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  }

  private project(id: string): Project | undefined {
    return this.deps.projects().find((p) => p.id === id);
  }

  /** プロジェクトのすべての監査（完了した順）。 */
  private build(projectId: string): TaskAudit[] {
    const tasks = this.completed(projectId);
    const project = this.project(projectId);
    const cap = this.deps.defaultCapUsd();
    return tasks.map((task, index) => this.auditFor(task, index, project, cap));
  }

  /** 1つのタスクの、場面に合わせたモックの監査。 */
  private auditFor(
    task: Task,
    index: number,
    project: Project | undefined,
    cap: number,
  ): TaskAudit {
    const projectId = task.projectId;
    const scenario = scenarioAt(index);
    const startedAt = mockAuditStartedAt(task);
    const candidates = auditTargetCandidates(task, project);
    const base = {
      taskId: task.id,
      projectId,
      startedAt,
      mock: true as const,
    };
    const resumedCap = this.resumed.get(task.id);
    if (scenario.status === "budgetPaused" && resumedCap !== undefined) {
      return {
        ...base,
        status: "deepDiving",
        budget: { usedUsd: cap, capUsd: resumedCap },
        survey: this.survey(counts({ toolFailure: 6, retry: 3 })),
        deepDives: [
          { step: "implement", status: "running", reason: "ツールの呼び出しの失敗が多い" },
        ],
        findings: [],
      } satisfies TaskAudit;
    }
    switch (scenario.status) {
      case "waiting":
        return {
          ...base,
          status: "waiting",
          budget: { usedUsd: 0, capUsd: cap },
          deepDives: [],
          findings: [],
        };
      case "surveying":
        return {
          ...base,
          status: "surveying",
          budget: { usedUsd: cap * 0.1, capUsd: cap },
          deepDives: [],
          findings: [],
        };
      case "failed":
        return {
          ...base,
          status: "failed",
          finishedAt: shift(startedAt, 2),
          budget: { usedUsd: cap * 0.05, capUsd: cap },
          failure: message("audit.runFailed", {
            detail: "エージェントの出力を読めませんでした（モック）。",
          }),
          deepDives: [],
          findings: [],
        };
      case "budgetPaused":
        return {
          ...base,
          status: "budgetPaused",
          budget: { usedUsd: cap, capUsd: cap },
          survey: this.survey(counts({ toolFailure: 6, retry: 3 })),
          deepDives: [
            {
              step: "implement",
              status: "running",
              reason: "ツールの呼び出しの失敗が多い",
            },
          ],
          findings: [],
        };
      case "deepDiving":
        return {
          ...base,
          status: "deepDiving",
          budget: { usedUsd: cap * 0.45, capUsd: cap },
          survey: this.survey(counts({ changesRequested: 1, pullRequestRemark: 1, retry: 1 })),
          deepDives: [
            {
              step: "requirements",
              status: "completed",
              reason: "人の差し戻しがあった",
              summary:
                "差し戻しは、受け入れ条件の書き方の揺れが原因。重大な不足は見つからなかった。",
            },
            { step: "implement", status: "running", reason: "PR のレビューの指摘があった" },
            { step: "design", status: "waiting", reason: "テスト観点の数が少ない" },
          ],
          findings: [],
        };
      case "completed": {
        const activity = this.deps.activity(task.id);
        const findings = scenario.causes.map((causeId) =>
          this.finding(causeId, task, activity, candidates, startedAt),
        );
        return {
          ...base,
          status: "completed",
          finishedAt: mockAuditFinishedAt(task),
          budget: { usedUsd: cap * (0.3 + 0.1 * (index % 3)), capUsd: cap },
          survey: this.survey(counts(scenario.counts)),
          deepDives: [...new Set(findings.flatMap((f) => (f.step ? [f.step] : [])))].map(
            (step) => ({
              step,
              status: "completed" as const,
              reason: "差し戻しや試行錯誤が多かった",
              summary: "原因を特定した。下の原因と提案を参照。",
            }),
          ),
          findings,
        };
      }
    }
  }

  private survey(c: Record<AuditEvidenceKind, number>): NonNullable<TaskAudit["survey"]> {
    const found = Object.values(c).some((n) => n > 0);
    return {
      summary: found
        ? "完了までに **差し戻しや指摘** と、エージェントの **試行錯誤** があった。根拠の多い工程を深掘りする。"
        : "完了までに、差し戻し・指摘・試行錯誤は見つからなかった。深掘りは要らない。",
      counts: c,
    };
  }

  private finding(
    causeId: string,
    task: Task,
    activity: ActivityEvent[],
    candidates: AuditTarget[],
    at: string,
  ): AuditFinding {
    const cause = CAUSES[causeId] as MockCause;
    const kinds: AuditEvidenceKind[] =
      causeId === "lint" || causeId === "docsLocation"
        ? ["pullRequestRemark"]
        : causeId === "testCommand" || causeId === "missingPath"
          ? ["toolFailure", "retry"]
          : causeId === "guardian"
            ? ["retry", "escalation"]
            : ["changesRequested"];
    return {
      causeId,
      title: cause.title,
      detail: cause.detail,
      ...(cause.step ? { step: cause.step } : {}),
      evidence: evidenceFor(kinds, activity, at, cause.step),
      proposals: cause.proposals.map((p, i) => {
        const id = `${task.id}:${causeId}:${i}`;
        const target = pickTarget(candidates, p.target, p.depth);
        const proposal: AuditProposal = {
          id,
          causeId,
          taskId: task.id,
          title: p.title,
          body: p.body,
          target,
          targetCandidates: candidates,
        };
        const decision = this.decisions.get(id) ?? this.seededDecision(proposal, task, at);
        return decision ? { ...proposal, decision } : proposal;
      }),
    };
  }

  /**
   * 最初から判断してある提案（原因の状態「採用」「改修済み」「再発」「却下」を最初から確かめるため）：最初のタスクの
   * リンターと設計書の置き場所の提案、2つ目のタスクのテストのコマンドの提案は採用済み。2つ目のタスクのパスの提案は
   * 2つとも却下済み。
   */
  private seededDecision(
    proposal: AuditProposal,
    task: Task,
    at: string,
  ): AuditProposalDecision | undefined {
    const index = this.completed(task.projectId).findIndex((t) => t.id === task.id);
    const adopted =
      (index === 0 && (proposal.causeId === "lint" || proposal.causeId === "docsLocation")) ||
      (index === 1 && proposal.causeId === "testCommand");
    if (adopted) {
      return {
        kind: "adopted",
        // 監査の完了と同時に採用したことにする（改修のマージ（fixedAt）より前になる）
        at: shift(at, 6),
        target: proposal.target,
        task: { taskId: `mock-${proposal.id}`, title: `改修：${proposal.title}`, mock: true },
      };
    }
    if (index === 1 && proposal.causeId === "missingPath") {
      return {
        kind: "rejected",
        at: shift(at, 12),
        reason: proposal.id.endsWith(":1")
          ? "上位のコンテキストは、ほかのチームと共有しているため変えない。"
          : "ディレクトリの構成は近く変えるので、いまは書かない。",
      };
    }
    return undefined;
  }

  /**
   * 改修をマージした時刻。リンターは最初と3つ目のタスクの間（3つ目で再発する）、テストのコマンドは2つ目のタスクの
   * 2時間後（その後は見つかっていないので改修済み）。ほかは、まだマージしていない。
   */
  private fixedAt(projectId: string, causeId: string): string | undefined {
    const tasks = this.completed(projectId);
    if (causeId === "testCommand") {
      const second = tasks[1];
      return second
        ? new Date(Date.parse(second.updatedAt) + 2 * 3_600_000).toISOString()
        : undefined;
    }
    if (causeId !== "lint") return undefined;
    const first = tasks[0];
    if (!first) return undefined;
    const third = tasks[2];
    // 最初の監査の完了と、3つ目の監査の完了の間にする（最初の原因に再発を付けない。PR #134 レビュー指摘）。少なくとも
    // 最初の監査の完了より後にし、同じ時刻に完了したなら再発にしない。3つ目のタスクが無ければ、最初の監査の後に
    // マージしたことにする（改修済みのまま）
    const start = Date.parse(mockAuditFinishedAt(first));
    const end = third ? Date.parse(mockAuditFinishedAt(third)) : start + 3_600_000;
    return new Date(Math.max(start + 1, Math.floor((start + end) / 2))).toISOString();
  }

  taskAudit(taskId: string): TaskAudit | null {
    const task = this.deps.tasks().find((t) => t.id === taskId);
    if (!task || !isAuditTarget(task)) return null;
    const audit = this.build(task.projectId).find((a) => a.taskId === taskId);
    if (!audit) return null;
    const causes = this.causes(task.projectId);
    return {
      ...audit,
      findings: audit.findings.map((f) => {
        const cause = causes.find((c) => c.id === f.causeId);
        const recurred =
          cause?.recurredAt !== undefined &&
          audit.finishedAt !== undefined &&
          cause.fixedAt !== undefined &&
          audit.finishedAt > cause.fixedAt;
        return recurred ? { ...f, recurred: true as const } : f;
      }),
    };
  }

  private causes(projectId: string): AuditCause[] {
    const audits = this.build(projectId);
    const titles = new Map(this.completed(projectId).map((t) => [t.id, t.title]));
    const byCause = new Map<string, { finding: AuditFinding; audit: TaskAudit }[]>();
    for (const audit of audits) {
      for (const finding of audit.findings) {
        const list = byCause.get(finding.causeId) ?? [];
        list.push({ finding, audit });
        byCause.set(finding.causeId, list);
      }
    }
    return [...byCause.entries()].map(([id, list]) => {
      const proposals = list.flatMap((x) => x.finding.proposals);
      const occurrences = list
        .map(({ audit }) => ({
          taskId: audit.taskId,
          taskTitle: titles.get(audit.taskId) ?? audit.taskId,
          at: audit.finishedAt ?? audit.startedAt ?? "",
        }))
        .sort((a, b) => b.at.localeCompare(a.at));
      const fixedAt = proposals.some((p) => p.decision?.kind === "adopted")
        ? this.fixedAt(projectId, id)
        : undefined;
      const recurredAt = fixedAt
        ? occurrences
            .map((o) => o.at)
            .filter((at) => at > fixedAt)
            .sort()[0]
        : undefined;
      return {
        id,
        projectId,
        title: list[0]?.finding.title ?? id,
        status: causeStatus(proposals, fixedAt, recurredAt),
        occurrences,
        ...(fixedAt ? { fixedAt } : {}),
        ...(recurredAt ? { recurredAt } : {}),
      };
    });
  }

  projectAudits(projectId: string): ProjectAudits | null {
    if (!this.project(projectId)) return null;
    const titles = new Map(this.completed(projectId).map((t) => [t.id, t.title]));
    const audits = this.build(projectId);
    const rows: AuditRow[] = audits
      .map((a) => ({
        taskId: a.taskId,
        taskTitle: titles.get(a.taskId) ?? a.taskId,
        status: a.status,
        ...(a.finishedAt ? { finishedAt: a.finishedAt } : {}),
        usedUsd: a.budget.usedUsd,
        ...(a.survey ? { counts: a.survey.counts } : {}),
      }))
      .reverse();
    const proposals: ListedAuditProposal[] = audits
      .flatMap((a) =>
        a.findings.flatMap((f) =>
          f.proposals.map((p) => ({ ...p, taskTitle: titles.get(a.taskId) ?? a.taskId })),
        ),
      )
      .reverse()
      .sort((a, b) => Number(isPendingAuditProposal(b)) - Number(isPendingAuditProposal(a)));
    return {
      projectId,
      mock: true,
      defaultCapUsd: this.deps.defaultCapUsd(),
      audits: rows,
      causes: sortCauses(this.causes(projectId)),
      proposals,
    };
  }

  dashboard(): AuditDashboard {
    const projects = this.deps.projects().map((p) => {
      const causes = this.causes(p.id);
      const proposals = this.build(p.id).flatMap((a) => a.findings.flatMap((f) => f.proposals));
      return {
        projectId: p.id,
        causes: causes.length,
        recurred: causes.filter((c) => c.status === "recurred").length,
        pending: proposals.filter(isPendingAuditProposal).length,
        adopted: proposals.filter((x) => x.decision?.kind === "adopted").length,
        rejected: proposals.filter((x) => x.decision?.kind === "rejected").length,
      };
    });
    const weeks = new Map<string, { tasks: number; remarks: number }>();
    for (const p of this.deps.projects()) {
      for (const audit of this.build(p.id)) {
        if (audit.status !== "completed" || !audit.finishedAt || !audit.survey) continue;
        const week = weekStart(audit.finishedAt);
        const sum = weeks.get(week) ?? { tasks: 0, remarks: 0 };
        sum.tasks += 1;
        sum.remarks += auditRemarkCount(audit.survey.counts);
        weeks.set(week, sum);
      }
    }
    return {
      mock: true,
      projects: projects.filter((p) => p.causes > 0 || p.pending > 0),
      trend: [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-8)
        .map(([weekStart, sum]) => ({ weekStart, ...sum })),
    };
  }

  /** 提案を探す（プロジェクトをまたいで ID で探す。ID はタスクの ID を含むので重ならない）。 */
  private findProposal(proposalId: string): ListedAuditProposal {
    for (const project of this.deps.projects()) {
      const found = this.projectAudits(project.id)?.proposals.find((p) => p.id === proposalId);
      if (found) return found;
    }
    throw new InvalidOperationError(message("audit.proposalNotFound"));
  }

  adopt(proposalId: string, input: unknown): ListedAuditProposal {
    const { target } = AdoptAuditProposalInput.parse(input);
    const proposal = this.findProposal(proposalId);
    if (proposal.decision) throw new InvalidOperationError(message("audit.alreadyDecided"));
    if (!proposal.targetCandidates.some((c) => sameAuditTarget(c, target))) {
      throw new InvalidOperationError(message("audit.targetNotCandidate"));
    }
    this.decisions.set(proposalId, {
      kind: "adopted",
      at: new Date().toISOString(),
      target,
      task: { taskId: `mock-${proposalId}`, title: `改修：${proposal.title}`, mock: true },
    });
    return this.findProposal(proposalId);
  }

  reject(proposalId: string, input: unknown): ListedAuditProposal {
    const { reason } = RejectAuditProposalInput.parse(input);
    const proposal = this.findProposal(proposalId);
    if (proposal.decision) throw new InvalidOperationError(message("audit.alreadyDecided"));
    this.decisions.set(proposalId, { kind: "rejected", at: new Date().toISOString(), reason });
    return this.findProposal(proposalId);
  }

  resume(taskId: string, input: unknown): TaskAudit {
    const { capUsd } = ResumeAuditInput.parse(input);
    const audit = this.taskAudit(taskId);
    if (!audit) throw new InvalidOperationError(message("audit.notFound"));
    if (audit.status !== "budgetPaused")
      throw new InvalidOperationError(message("audit.notPaused"));
    if (capUsd === undefined) throw new InvalidOperationError(message("resume.capRequired"));
    if (capUsd <= audit.budget.usedUsd) {
      throw new InvalidOperationError(
        message("resume.capTooLow", { usedUsd: audit.budget.usedUsd }),
      );
    }
    this.resumed.set(taskId, capUsd);
    return this.taskAudit(taskId) as TaskAudit;
  }
}

/** 宛先の種類から、タスクの候補の宛先を選ぶ（top なら最も上のコンテキスト）。無ければ sacty。 */
function pickTarget(
  candidates: AuditTarget[],
  kind: AuditTarget["kind"],
  depth?: "top",
): AuditTarget {
  const matches = candidates.filter((c) => c.kind === kind);
  const chosen =
    depth === "top"
      ? [...matches].sort(
          (a, b) => (b.kind === "context" ? b.depth : 0) - (a.kind === "context" ? a.depth : 0),
        )[0]
      : (matches.find((c) => c.kind !== "context" || c.depth === 0) ?? matches[0]);
  return chosen ?? { kind: "sacty" };
}

/**
 * 原因の状態。改修をマージした後にまた見つかれば再発、見つかっていなければ改修済み。採用した提案があれば採用、
 * 判断待ちがあれば提案あり、すべて却下なら却下。
 */
export function causeStatus(
  proposals: readonly Pick<AuditProposal, "decision">[],
  fixedAt: string | undefined,
  recurredAt: string | undefined,
): AuditCauseStatus {
  if (fixedAt && recurredAt) return "recurred";
  if (fixedAt) return "fixed";
  if (proposals.some((p) => p.decision?.kind === "adopted")) return "adopted";
  if (proposals.some((p) => p.decision === undefined)) return "proposed";
  return "rejected";
}

const CAUSE_ORDER: AuditCauseStatus[] = ["recurred", "proposed", "adopted", "fixed", "rejected"];

/** 原因の並び：再発・提案あり・採用・改修済み・却下の順、同じ状態なら件数の多い順。 */
export function sortCauses(causes: AuditCause[]): AuditCause[] {
  return [...causes].sort(
    (a, b) =>
      CAUSE_ORDER.indexOf(a.status) - CAUSE_ORDER.indexOf(b.status) ||
      b.occurrences.length - a.occurrences.length ||
      a.id.localeCompare(b.id),
  );
}

/** その時刻の週の始め（月曜、UTC の日付）。 */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
