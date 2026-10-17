import { z } from "zod";
import { code, DaemonText } from "./message-code.js";

/**
 * 工程の種類。標準の工程は requirements → design → implement。実装の工程の中で、検証に通ったら sacty が PR を作り、
 * 人の承認（PR のマージ）を待つ（PBI-110。それまでの「PR作成」の工程 pr は無くした）。
 * investigate（調査）は、コードを調べて報告するだけの工程（PBI-18）。
 * review（レビュー）は、既存の PR をレビューして、PR に投稿するだけの工程（PBI-19）。
 * split（タスク分割）は、承認済みの設計から子タスクを作り、子タスクの完了を待つ工程（PBI-27）。
 * reproduce（再現）は、不具合を再現する失敗するテストを書き、sacty が失敗を確かめる工程（PBI-29）。
 * integrate（統合レビュー）は、子タスクの成果を組み合わせて親の要求要件を満たすかを、ゴールガーディアンが
 * 確かめる工程（PBI-31）。タスク分割の後に置く。
 * deployment（マージの後の監視）は、実装の PR のマージの後に、CI/CD とデプロイ後のアプリを見届ける工程（PBI-116）。人の
 * 承認は無い。対象のリポジトリにデプロイの確認のスキル（deployment-observer）があるときだけ行い、無ければ飛ばす（skip）。
 */
export const StepKey = z.enum([
  "investigate",
  "review",
  "requirements",
  "design",
  "split",
  "integrate",
  "reproduce",
  "implement",
  "deployment",
  "document",
  "operation",
]);
export type StepKey = z.infer<typeof StepKey>;

/** 標準の工程（requirements → design → implement）。 */
export const MVP_STEPS: readonly StepKey[] = ["requirements", "design", "implement"];

/**
 * オーケストレーターが選べる工程の組み合わせ（PBI-17）。候補に無い組み合わせは選ばせない。
 * 工程の種類を増やしたら（調査・レビューなど）、ここに組み合わせを足す。
 */
export const STEP_PLANS = {
  /** リポジトリを変えず、原稿を作って承認する。 */
  document: ["document"],
  /** 依頼された単発の外部操作を実行し、結果を承認する。 */
  operation: ["operation"],
  /**
   * 標準：調査 → 要求要件 → 設計（テスト観点）→ 実装。実装する組み合わせは、先頭に前段の調査を置き、
   * その結果を後の工程に渡す。前段の調査は人間が承認しない（PBI-29）。実装は、検証に通ったら PR を作り、そのマージで
   * 承認する（PBI-110）。マージの後は、マージの後の監視（PBI-116。スキルが無ければ飛ばす）
   */
  standard: ["investigate", "requirements", "design", "implement", "deployment"],
  /** 小さな変更：設計を省く（要求要件の受け入れ条件をテストで確かめる） */
  "skip-design": ["investigate", "requirements", "implement", "deployment"],
  /** 調査だけ：コードを調べて報告する。実装や PR は作らない（PBI-18） */
  investigate: ["investigate"],
  /**
   * 設計だけ：要求要件 → 設計。コードを変えない全体の設計（PBI-73）。対象リポジトリの無いタスクだけが選べる。
   * 成果は sacty の画面で承認し、書き出し先があれば書き出す
   */
  "design-only": ["requirements", "design"],
  /** レビューだけ：タスクにある PR をレビューして、PR に投稿する（PBI-19） */
  review: ["review"],
  /**
   * 大きなタスク：要求要件 → 設計 → タスク分割 → 統合レビュー。設計の承認の後に子タスクを作り、子タスクが
   * それぞれ実装と PR を行う（PBI-27）。子タスクは分割できない（1段だけ）。子がすべて片付いたら、
   * 統合レビューを通して人間が承認すると完了する（PBI-31）
   */
  split: ["investigate", "requirements", "design", "split", "integrate"],
  /**
   * 不具合の修正：再現 → 実装。不具合を再現する失敗するテストを書き、それを通すように直す（PBI-29）
   */
  bugfix: ["investigate", "reproduce", "implement", "deployment"],
} as const satisfies Record<string, readonly StepKey[]>;
export type StepPlan = keyof typeof STEP_PLANS;
export const StepPlan = z.enum(Object.keys(STEP_PLANS) as [StepPlan, ...StepPlan[]]);

/**
 * 調査の工程の性質（PBI-43）。オーケストレーターが工程を選ぶときに判断する。
 * content（内容の調査）は、コードや仕組みを読んで説明する調査で、開発のためのセットアップをしない。
 * bug（不具合の調査）は、再現や原因の特定のために動かして確かめる調査で、リポジトリの指示どおりセットアップする。
 */
export const InvestigationKind = z.enum(["content", "bug"]);
export type InvestigationKind = z.infer<typeof InvestigationKind>;

/**
 * 成果を外（Confluence・Notion など）に書き出せる工程（PBI-56）。人間が承認した版だけを書き出すので、調査は、
 * 調査そのものが目的のタスク（調査だけの組み合わせ）のときだけ（前段の調査は人間が承認しない）。
 */
export const EXPORT_STEPS: readonly StepKey[] = [
  "investigate",
  "requirements",
  "design",
  "document",
];

/** 工程の組み合わせのうち、書き出せる工程（PBI-56）。 */
export function exportSteps(steps: readonly StepKey[]): StepKey[] {
  return steps.filter(
    (step) => EXPORT_STEPS.includes(step) && (step !== "investigate" || steps.at(-1) === step),
  );
}

/**
 * 書き出しの接続先の種類（PBI-56）。platform：ゲートウェイの接続先（gateway.platforms）、mcp：MCP サーバー
 * （コンテキストの MCP・ホストの MCP）。sacty は、書き出し先の種類（Confluence・Notion など）ごとの設定を持たない。
 */
export const ExportVia = z.enum(["platform", "mcp"]);
export type ExportVia = z.infer<typeof ExportVia>;

/**
 * オーケストレーターが決めた、工程の書き出し先と理由（PBI-56）。to が無ければ書き出さない。location は置き場所の
 * 手がかり（例：Confluence のスペース・親のページ）。
 */
export const ExportPlan = z.object({
  to: z
    .object({
      via: ExportVia,
      name: z.string().min(1).max(100),
      location: z.string().max(1000).default(""),
    })
    .optional(),
  reason: DaemonText,
});
export type ExportPlan = z.infer<typeof ExportPlan>;

/**
 * 人間の承認ゲートがある工程。実装は、検証に通って sacty が PR を作った後に承認待ちになる（PBI-110）。統合レビューは、
 * 親タスクの最後の確認（PBI-31）。
 */
export const GATED_STEPS: readonly StepKey[] = [
  "document",
  "operation",
  "investigate",
  "requirements",
  "design",
  "integrate",
  "implement",
];

/** 差し戻しでやり直せる（工程エージェントが作る）工程。 */
export const REWORK_STEPS: readonly StepKey[] = [
  "document",
  "investigate",
  "reproduce",
  "requirements",
  "design",
  "implement",
];

/**
 * 対象のリポジトリへの PR で人間が承認する工程（PBI-57）。成果をファイルでタスクブランチへの PR にし、PR のマージを
 * 承認とする。実装の PR（PBI-110）は、タスクブランチからベースブランチへの PR（StepPullRequestKey には含めない）。
 */
export const StepPullRequestKey = z.enum(["requirements", "design"]);
export type StepPullRequestKey = z.infer<typeof StepPullRequestKey>;

/** 工程の成果のファイルを置く、既定のディレクトリ（この下のタスクの短い ID のディレクトリに置く。PBI-57）。 */
export const DEFAULT_DOCUMENTS_DIR = "docs/sacty";

/**
 * 成果のファイルを置くディレクトリとして使えるか（PBI-57）。リポジトリの根からの相対パスで、. と .. の区切り・
 * .git・先頭や末尾の / を含まないもの。
 */
export function isDocumentsDir(value: string): boolean {
  if (value.length === 0 || value.length > 300 || !/^[\w./-]+$/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
}

/** 同じ工程への差し戻しがこの回数を超えると、エスカレーションになる。 */
export const MAX_CHANGE_REQUESTS = 3;

/** 予算の既定値（1タスクあたり、米ドル）。 */
export const DEFAULT_BUDGET_USD = 1;

/** タスク分割で作る子タスクの数の範囲（PBI-27）。 */
export const MIN_SPLIT_CHILDREN = 2;
export const MAX_SPLIT_CHILDREN = 10;

/**
 * 統合レビューが続けてこの回数通らなければ、修正の子タスクを追加せずに、不合格のまま人間の承認待ちにする（PBI-31）。
 */
export const MAX_INTEGRATION_ATTEMPTS = 3;

/** 予算のこの割合に達したら通知する。 */
export const BUDGET_WARN_RATIO = 0.8;

/** 誰がその記録を残したか。 */
export const Actor = z.enum(["person", "sacty", "orchestrator", "guardian", "agent"]);
export type Actor = z.infer<typeof Actor>;

/** エージェントの認証方式。 */
/** provider：config.yaml の providers の OpenAI 互換の接続先（組織の AI gateway など。PBI-40）。 */
export const AuthMode = z.enum(["subscription", "api-key", "bedrock", "provider", "stub"]);
export type AuthMode = z.infer<typeof AuthMode>;

/** 1回の実行で使ったトークン数。キャッシュ読み込みは入力とは別枠にそろえて記録する。 */
export const TokenUsage = z.object({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * 実行に使った AI の設定（接続先・モデル・リーズニングエフォート。PBI-46）。タスクの詳細の、工程ごとの費用の表に出す。
 * PBI-46 より前の作業履歴には無い。モデル・エフォートは、設定に書いてなければ（エージェントの既定なら）持たない。
 */
const AgentSetting = {
  authMode: AuthMode.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
};

/**
 * 工程の実行（AgentRun…）のほかのエージェントの実行（オーケストレーター・ゴールガーディアンなど）の ID。
 * 実行のセッションログを辿るのに使う（PBI-62）。PBI-62 より前の作業履歴には無い。
 */
const RunRef = { runId: z.string().optional() };

/** 人間の指摘。id は作業履歴の中で一意（例：requirements-2-1 は要求要件の2回目の差し戻しの1件目）。 */
export const Remark = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type Remark = z.infer<typeof Remark>;

/** 工程エージェントの、指摘への対応。 */
export const RemarkResponse = z.object({ remarkId: z.string(), text: z.string() });

/**
 * 工程エージェントが提出の前に行ったセルフレビュー（既定のスキル review-dispatch の self-review。PBI-120）の報告。
 * rounds は回数（初回を含む）、passed は must の指摘が残らなかったか、remaining は残った must の要約、notReviewed は
 * 見られなかった観点、summary は短い総評。回数はスキルの規則どおり 1〜5 回で、パスは must が残らないときだけ。合わない報告
 * （回数が範囲の外・パスなのに残った指摘がある）は受け付けない（読む側で「記録なし」にする。PR #130 レビュー指摘）。
 */
export const SELF_REVIEW_MAX_ROUNDS = 5;
export const SelfReview = z
  .object({
    rounds: z.number().int().min(1).max(SELF_REVIEW_MAX_ROUNDS),
    passed: z.boolean(),
    remaining: z.array(z.string()).default([]),
    notReviewed: z.array(z.string()).default([]),
    summary: z.string().default(""),
  })
  .refine((r) => !r.passed || r.remaining.length === 0, {
    message: "a passed self-review must not have remaining must findings",
    path: ["remaining"],
  });
export type SelfReview = z.infer<typeof SelfReview>;
/** セルフレビューをさせる工程（PBI-120）。 */
export const SELF_REVIEW_STEPS = [
  "requirements",
  "design",
  "implement",
] as const satisfies readonly StepKey[];
export type RemarkResponse = z.infer<typeof RemarkResponse>;

/**
 * テスト観点。設計の工程で作り、設計の承認で凍結する。最終レビュー（PBI-10）の基準になる。
 * id は sacty が提出ごとに振る（TV-1, TV-2, …）。
 */
export const TestViewpoint = z.object({
  id: z.string().min(1),
  /** 何を確かめるか。 */
  title: z.string().min(1),
  /** 入力・前提。 */
  input: z.string().min(1),
  /** 期待する結果。 */
  expected: z.string().min(1),
});
export type TestViewpoint = z.infer<typeof TestViewpoint>;

/** タスクの取り込み元。GitHub の Issue か PR（PBI-26）。 */
export const TaskSource = z.object({
  kind: z.enum(["github_issue", "github_pull_request"]),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  /**
   * PR のレビューだけを行う取り込み（PBI-44）。requested：自分にレビューが依頼された、label：PR のレビュー用の
   * ラベルが付いていた。この取り込みのタスクは、工程をレビューだけにする（オーケストレーターに選ばせない）。
   * sacty：sacty がほかのタスクで作り、取り込むラベルを付けた PR（実装の PR と、要求要件・設計の PR。PBI-88）。
   */
  review: z.enum(["requested", "label", "sacty"]).optional(),
});
export type TaskSource = z.infer<typeof TaskSource>;

/**
 * レビューの工程の、PR の行へのコメント（PBI-19）。line は PR の先頭のファイルの行番号で、
 * PR の差分に含まれる行だけ（差分の外の指摘は、レビューの本文に入れる）。
 */
export const ReviewComment = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  body: z.string().min(1),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/**
 * PR のレビューの判定（PBI-111）。changes_required：修正が必要（`[要修正]` の指摘がある）、suggestions：提案あり（マージは可。
 * `[提案]` の指摘だけ）、no_findings：指摘なし。差し戻しとして元のタスクに届けるのは changes_required だけ。
 */
export const ReviewVerdict = z.enum(["changes_required", "suggestions", "no_findings"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** 変更の申し出に対する、ゴールガーディアンの判定。 */
export const Verdict = z.enum(["approved", "rejected", "undecidable"]);
export type Verdict = z.infer<typeof Verdict>;

/** 実装の検証（テストと最終レビュー）が、続けて通らなかったときに止める回数。 */
export const MAX_VERIFY_ATTEMPTS = 3;

/** 観点ごとの、テストの対応。工程エージェントが申告する。 */
export const TestMapping = z.object({
  viewpointId: z.string().min(1),
  /** テストの場所と名前（例：src/pay.test.ts › 同じキーの再送）。 */
  tests: z.array(z.string().min(1)),
});
export type TestMapping = z.infer<typeof TestMapping>;

/** タスクが止まった理由。verification：実装の検証が続けて通らない。manual：人間が止めた。 */
export const PauseReason = z.enum([
  "budget",
  "usage_limit",
  "auth",
  "error",
  "verification",
  "manual",
  // 子タスクが中止された（親は人間の判断を待つ。PBI-27）
  "child_cancelled",
]);
export type PauseReason = z.infer<typeof PauseReason>;

/**
 * タスクのテンプレート（PBI-90）。sacty-setup：対象のリポジトリを sacty で扱うためのエージェントの設定を検査し、
 * 足りないものを整える（題と説明は sacty が決める）。
 */
export const TaskTemplate = z.enum(["sacty-setup"]);
export type TaskTemplate = z.infer<typeof TaskTemplate>;

/**
 * マージの後の監視（PBI-89）。修正のタスクの元。kind は ci（CI/CD の失敗）か deployment（デプロイ後のアプリの確認の失敗）。
 * fingerprint は、同じ失敗の修正のタスクを二重に作らないための目印。depth は、元のタスクを 0 として何段目の修正のタスクか。
 */
const DeploymentFixKind = z.enum(["ci", "deployment"]);

/** 修正のタスクを作るときに付ける、元のタスクとのつながり（PBI-89）。 */
const DeploymentFix = z.object({
  taskId: z.string().min(1),
  kind: DeploymentFixKind,
  fingerprint: z.string().min(1),
  depth: z.number().int().positive(),
});

const TaskCreated = z.object({
  type: z.literal("TaskCreated"),
  payload: z.object({
    title: z.string(),
    body: z.string(),
    /**
     * sacty：sacty の画面で作った、github_issue：GitHub Issue から取り込んだ、
     * github_pull_request：GitHub の PR から取り込んだ（PBI-26）、split：親タスクの分割で作った（PBI-27）。
     * PBI-20 より前の作業履歴は、画面で作ったタスクを ticket と記録しているので、sacty として読む。
     */
    start: z
      .enum([
        "sacty",
        "github_issue",
        "github_pull_request",
        "split",
        "ticket",
        "jira",
        "deployment",
      ])
      .transform((start) => (start === "ticket" ? "sacty" : start)),
    /**
     * 取り込んだチケット（JIRA など。PBI-52）。接続先（gateway.platforms の名前）・種類・キー・チケットの URL。
     * 作業するリポジトリは、オーケストレーターがチケットを読んで決める（TicketTriaged）。
     */
    ticket: z
      .object({
        platform: z.string(),
        service: z.enum(["jira-cloud", "jira-server"]),
        key: z.string(),
        url: z.string(),
        /**
         * プロジェクトのコンテキストの PF（platforms.yaml）から取り込んだなら "project"（PBI-74）。同じ名前の PF が
         * プロジェクトごとに別の接続先なので、チケットはプロジェクトとあわせて識別する。無ければホストの PF
         * （プロジェクトをまたいで、名前とキーで識別する。PBI-74 より前の作業履歴も）。
         */
        scope: z.literal("project").optional(),
      })
      .optional(),
    // PBI-1の作業履歴には無いので既定値で補う
    budgetCapUsd: z.number().positive().default(DEFAULT_BUDGET_USD),
    /** 取り込み元（GitHub の Issue・PR のリポジトリと番号）。 */
    source: TaskSource.optional(),
    /**
     * 画面で作ったタスクの対象リポジトリ（リポジトリの URL。プロジェクトのリポジトリの設定から選んだもの。PBI-21）。
     * Issue から取り込んだタスクは、その Issue のリポジトリが対象なので持たない。PBI-21 より前の作業履歴にも無い。
     */
    repo: z.string().optional(),
    /**
     * 対象リポジトリを指定せずに作った（PBI-73）。オーケストレーターが、プロジェクトのコンテキストと対象から進め方を
     * 決める（リポジトリ無しで進める・分割して子タスクにリポジトリを付ける・リポジトリを選ぶ）。対象リポジトリを
     * 選ぶ前の版（PBI-21 より前）のタスクと区別するため、明示して持つ。
     */
    noRepo: z.literal(true).optional(),
    /** 分割で作った子タスクに、オーケストレーター（分割のエージェント）がリポジトリを付けた理由（PBI-73）。 */
    repoReason: z.string().max(2000).optional(),
    /**
     * 分割で作った子タスクの親と、先に完了している必要がある子タスク（PBI-27）。
     * 依存がある子タスクは、依存先がすべて完了するまで待つ（blocked）。
     */
    parent: z.object({ taskId: z.string(), dependsOn: z.array(z.string()) }).optional(),
    /** テンプレートで作った（PBI-90）。題と説明は、テンプレートから sacty が決めたもの。 */
    template: TaskTemplate.optional(),
    /**
     * マージの後の監視で見つけた失敗の、修正のタスク（start: deployment。PBI-89）。元のタスク・失敗の種類・二重に作らない
     * ための目印・何段目の修正のタスクか（元のタスクが 0。MAX_FIX_CHAIN まで）。
     */
    fix: DeploymentFix.optional(),
  }),
});

/**
 * タスク分割の工程が、子タスクを決めた（PBI-27）。子タスクの ID はここで決め、続けて（デーモンが
 * 止まって途中になっても、再起動の後に）その ID で子タスクを作る。親は子タスクの完了を待つ。
 */
const TaskSplit = z.object({
  type: z.literal("TaskSplit"),
  payload: z.object({
    children: z
      .array(
        z.object({
          taskId: z.string().min(1),
          title: z.string().min(1),
          body: z.string(),
          dependsOn: z.array(z.string()),
          /**
           * 子タスクの対象リポジトリと、選んだ理由（PBI-73）。リポジトリの無い親を分けたときだけ、分割のエージェントが
           * プロジェクトの対象から選ぶ。無ければ親のリポジトリ。
           */
          repo: z.string().min(1).optional(),
          repoReason: z.string().max(2000).optional(),
        }),
      )
      .min(1),
    /** 分割のエージェントが書いた、分け方の理由。 */
    reason: z.string(),
  }),
});

/**
 * 再現の工程の後に、sacty がテストを実行して再現を確かめた（PBI-29）。テストが失敗したら再現できたとして
 * 実装へ進む（人間の承認なし）。通った・再現のテストが無いなら、再現できなかったとして人間の判断を待つ。
 */
const ReproductionChecked = z.object({
  type: z.literal("ReproductionChecked"),
  payload: z.object({
    reproduced: z.boolean(),
    tests: z.array(z.string()),
    /** 実行したテストのコマンド（再現のテストが無く、実行しなかったときは無い）。 */
    command: z.string().optional(),
    exitCode: z.number().int().optional(),
    /** 出力の末尾。 */
    output: z.string().default(""),
    note: DaemonText.optional(),
    durationMs: z.number().int().nonnegative().default(0),
  }),
});

/** 依存先の子タスクがすべて完了したので、子タスクを実行待ちにする（PBI-27）。 */
const TaskUnblocked = z.object({
  type: z.literal("TaskUnblocked"),
  payload: z.object({}),
});

/**
 * 子タスクがすべて完了（中止を認めたものを含む）したので、タスク分割の工程を完了にする（PBI-27）。
 * 次の工程（統合レビュー。PBI-31）があれば実行待ちにする。
 */
const SplitCompleted = z.object({
  type: z.literal("SplitCompleted"),
  payload: z.object({}),
});

/** 単発作業の実行設定。工程選択時に依頼から決める（独立した成果物や承認は作らない）。 */
export const OperationSettings = z.object({
  via: ExportVia,
  name: z.string().trim().min(1).max(100),
  target: z.string().trim().min(1).max(2000),
  change: z.string().trim().min(1).max(8000),
  verification: z.string().trim().min(1).max(4000),
});
export type OperationSettings = z.infer<typeof OperationSettings>;

/**
 * タスクの工程を決めた。PBI-17 からは、オーケストレーター（AI）がタスクの内容と対象リポジトリを読んで、
 * 候補（STEP_PLANS）から選び、理由とともに記録する（人間の承認は無い）。判断できなければ、この記録の代わりに
 * OrchestratorFailed を記録して一時停止する（PBI-40）。PBI-17 より前の作業履歴は、固定の工程（steps だけ）。
 */
const StepsChosen = z.object({
  type: z.literal("StepsChosen"),
  payload: z.object({
    steps: z.array(StepKey).min(1),
    plan: StepPlan.optional(),
    operation: OperationSettings.optional(),
    /** オーケストレーターが書いた理由。判断できなかったときは sacty の文言。 */
    reason: DaemonText.optional(),
    /** 判断できず、標準の工程にした（PBI-40 より前の作業履歴。いまは判断できなければ OrchestratorFailed で止める）。 */
    fallback: z.boolean().default(false),
    /**
     * オーケストレーターが対象リポジトリを読んで決めた、テストのコマンド（PBI-25）。sh -c で実行し、
     * 終了コード0で合格。分からなければ持たない（実装の工程を含むタスクは止める）。
     */
    testCommand: z.string().trim().min(1).max(1000).optional(),
    /**
     * オーケストレーターが、対象リポジトリにテストの仕組みが無いと判断した根拠（PBI-94）。testCommand が無いときだけ持つ。
     * これがあるタスクは、実装の検証でテストを飛ばし（TestsSkipped）、ゴールガーディアンがタスクの目的から判定する。
     * sacty がテストのファイルを見つけた・不具合の修正を選んだときは、持たせずに止める。
     */
    noTestsReason: z.string().trim().min(1).max(2000).optional(),
    /** 調査の工程の性質（PBI-43）。無ければ内容の調査として扱う（セットアップをしない側）。 */
    investigation: InvestigationKind.optional(),
    /**
     * 工程ごとに使うイメージの名前（config.yaml の images の名前か default。PBI-41）。書いていない工程は
     * 既定のイメージ（images の候補を見せたときは、理由か理由が無いことを defaultImageReasons・imagesUnexplained に残す。PBI-105）。
     * テストの実行は、確かめる工程（実装・再現）のイメージで行う。
     */
    images: z.partialRecord(StepKey, z.string().min(1)).optional(),
    /** イメージを決めたのが、プロジェクトの対象の指定か、オーケストレーターか。 */
    imageSource: z.enum(["project", "orchestrator"]).optional(),
    /** オーケストレーターがイメージを選んだ理由。 */
    imageReason: z.string().max(1000).optional(),
    /**
     * 既定のイメージ（default）で動かす工程と、images のどれも合わない理由（PBI-105）。images の候補をオーケストレーターに
     * 見せたときだけ持つ。理由が書かれなかった工程（イメージを書かなかった・default と書いて理由が無い）は、imagesUnexplained に入る。
     */
    defaultImageReasons: z.partialRecord(StepKey, z.string().min(1).max(1000)).optional(),
    /**
     * images の候補を見せたのに、理由が無いまま既定のイメージで動かす工程（PBI-105）。オーケストレーターが工程のイメージを
     * 書かなかった・default と書いて理由を書かなかった。作業履歴とタスクの画面に、理由が無いことを出す。
     */
    imagesUnexplained: z.array(StepKey).optional(),
    /**
     * 工程・テストの実行の前に起動する docker compose のサービス（DB・モック API など。PBI-47）。file は作業領域からの
     * 相対パス、names は起動するサービス（空ならすべて）、steps はサービスを使う工程。
     */
    services: z
      .object({
        file: z.string().min(1).max(300),
        names: z.array(z.string().min(1).max(100)).max(20),
        steps: z.array(StepKey).min(1),
        /**
         * 共用の compose（プロジェクトの設定の sharedComposes。PBI-70）を使うとき、その名前・リポジトリ・ref。file は
         * そのリポジトリの中の compose ファイル。無ければ、file は対象リポジトリの compose ファイル。
         */
        compose: z
          .object({
            name: z.string().min(1).max(40),
            repo: z.string().min(1).max(500),
            ref: z.string().max(200).optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * サービスを使う・使わないと判断した理由（オーケストレーター。PBI-70）。共用の compose を使わないと判断した理由も
     * ここに残す。
     */
    servicesReason: z.string().max(1000).optional(),
    /** オーケストレーターに選ばせた共用の compose の名前（PBI-70。設定していなければ無い）。 */
    sharedComposes: z.array(z.string().min(1).max(40)).max(20).optional(),
    /**
     * 工程ごとの書き出し先（書き出さないことも含む）と理由（PBI-56）。書き出せる工程（exportSteps）だけ。使える
     * 接続先が1つも無いときは持たない（オーケストレーターに決めさせない）。
     */
    exports: z.partialRecord(StepKey, ExportPlan).optional(),
    /**
     * 要求要件・設計を PR でレビューするときに、成果のファイルを置くディレクトリ（リポジトリの根からの相対パス。
     * PBI-57）。リポジトリのコンテキストの規約に置き場所があるときだけ、オーケストレーターが書く。無ければ既定
     * （DEFAULT_DOCUMENTS_DIR）。ファイルは、この下のタスクの短い ID のディレクトリに置く。
     */
    documentsDir: z.string().min(1).max(300).optional(),
    /**
     * マージの後の監視の工程（deployment）をするか（PBI-116）。工程を選んだときに、sacty が起点のコミットでデプロイの確認の
     * スキル（deployment-observer）を探して決める。skill はそのパス（リポジトリの根から）、skipped は飛ばした理由
     * （この工程は skip になる）。工程に deployment があるときだけ持つ。
     */
    deployment: z
      .union([z.object({ skill: z.string().min(1) }), z.object({ skipped: DaemonText })])
      .optional(),
    agentId: z.string().optional(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * 人が、タスクの詳細で工程のイメージを変えた（PBI-106）。from は変える前の名前（指定が無ければ default）、to は
 * config.yaml の images の名前か default。その工程の次の実行から使う（テストのイメージも）。終わった工程・実行中の
 * 工程は変えない。actor は person。
 */
const StepImageChanged = z.object({
  type: z.literal("StepImageChanged"),
  payload: z.object({ step: StepKey, from: z.string().min(1), to: z.string().min(1) }),
});

const AgentRunStarted = z.object({
  type: z.literal("AgentRunStarted"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    agentId: z.string(),
    authMode: AuthMode,
    /** モデル・リーズニングエフォート（PBI-46）。 */
    model: AgentSetting.model,
    reasoningEffort: AgentSetting.reasoningEffort,
  }),
});

const AgentRunCompleted = z.object({
  type: z.literal("AgentRunCompleted"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    agentId: z.string(),
    authMode: AuthMode,
    usage: TokenUsage,
    costUsd: z.number().nonnegative(),
    /** サブスクリプションなど、実際の請求ではなく換算した値か。 */
    estimated: z.boolean(),
    output: z.string(),
    /** 指摘への対応（再提出のとき）。PBI-2の作業履歴には無い。 */
    responses: z.array(RemarkResponse).default([]),
    /** 設計の工程で作ったテスト観点。PBI-7までの作業履歴には無い。 */
    testViewpoints: z.array(TestViewpoint).default([]),
    /** 実装の工程が申告した、観点とテストの対応。 */
    testMap: z.array(TestMapping).default([]),
    /** レビューの工程の、PR の行へのコメント（PBI-19）。 */
    reviewComments: z.array(ReviewComment).default([]),
    /**
     * レビューの工程の判定（PBI-88・PBI-111）。エージェントの判定と、行についての指摘の重さ（`[要修正]` があれば修正が必要）から
     * 決める。判定を読めず、`[要修正]` の指摘も無ければ無い。
     */
    reviewVerdict: ReviewVerdict.optional(),
    /** 再現の工程が申告した、不具合を再現するテスト（PBI-29）。 */
    reproductionTests: z.array(z.string()).default([]),
    /**
     * テストの仕組みが無いタスク（PBI-94）で、実装の工程がテストの仕組みを用意したときに申告した、テストのコマンド。
     * 実装の検証で、sacty がこのコマンドでテストを実行する。
     */
    testCommand: z.string().trim().min(1).max(1000).optional(),
    /**
     * 提出の前のセルフレビューの報告（要求要件・設計・実装の工程。PBI-120）。null は、セルフレビューをさせたが報告が無い・
     * 読めなかった。セルフレビューをさせない工程と、それより前の記録には無い。
     */
    selfReview: SelfReview.nullable().optional(),
  }),
});

const AgentRunFailed = z.object({
  type: z.literal("AgentRunFailed"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    agentId: z.string(),
    reason: z.enum(["usage_limit", "auth", "error"]),
    /** sacty の文言はコードと引数、エージェントや外から来た文はそのまま（PBI-11）。 */
    message: DaemonText,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

const BudgetWarned = z.object({
  type: z.literal("BudgetWarned"),
  payload: z.object({ usedUsd: z.number(), capUsd: z.number() }),
});

const TaskPaused = z.object({
  type: z.literal("TaskPaused"),
  payload: z.object({
    reason: PauseReason,
    /** 止まった理由の詳しい説明（実行の失敗の記録が無い場合）。 */
    message: DaemonText.optional(),
    /**
     * 止めたが、無くなったことを確かめられなかったコンテナ（の実行）。中止や再開の前に確かめ直す
     * （デーモンを再起動しても追えるよう、作業履歴に記録する）。
     */
    unstoppedRuns: z.array(z.string()).optional(),
    /** 中止された子タスク（reason が child_cancelled のとき）。再開すると、中止を認めたことになる。 */
    cancelledChildren: z.array(z.string()).optional(),
  }),
});

const BudgetCapRaised = z.object({
  type: z.literal("BudgetCapRaised"),
  payload: z.object({ capUsd: z.number().positive() }),
});

const TaskResumed = z.object({
  type: z.literal("TaskResumed"),
  payload: z.object({
    /** 実行待ちに戻して実行するか（失敗した実行のやり直しなど）、待機に戻すか。 */
    retry: z.boolean(),
  }),
});

const StepSubmitted = z.object({
  type: z.literal("StepSubmitted"),
  payload: z.object({ step: StepKey, submission: z.number().int().positive() }),
});

const StepApproved = z.object({
  type: z.literal("StepApproved"),
  payload: z.object({
    step: StepKey,
    /** 承認後の状態。次の工程を実行できるなら実行待ち、まだ実装されていなければ待機。 */
    next: z.enum(["queued", "idle"]),
  }),
});

/**
 * 人間の承認なしに工程を完了にし、次の工程へ進める（前段の調査。PBI-29）。成果物は承認済みと同じく凍結する。
 */
const StepCompleted = z.object({
  type: z.literal("StepCompleted"),
  payload: z.object({
    step: StepKey,
    /** 次の工程を実行できるなら実行待ち、まだ実装されていなければ待機。 */
    next: z.enum(["queued", "idle"]),
  }),
});

/**
 * 待機していた工程を実行待ちにする。工程が後から実行できるようになったとき
 * （例：PBI-7で承認され、設計の工程が無かったため待機していたタスク）に使う。
 */
const StepQueued = z.object({
  type: z.literal("StepQueued"),
  payload: z.object({ step: StepKey }),
});

/**
 * 工程エージェントの、承認済みの成果物（要求要件・設計）への変更の申し出。
 * id はタスクの中で一意（CP-1, CP-2, …）。
 */
const ChangeProposed = z.object({
  type: z.literal("ChangeProposed"),
  payload: z.object({
    proposalId: z.string().min(1),
    /** 申し出た工程。 */
    fromStep: StepKey,
    /** 変更したい、承認済みの工程。 */
    target: StepKey,
    /** 変更したい理由。 */
    reason: z.string().min(1),
    /** 理由の根拠となる事実（コード、仕様、実行結果など）。 */
    facts: z.array(z.string().min(1)),
    /** 変更後の成果物の全文。 */
    proposed: z.string().min(1),
    /** 設計の変更で、テスト観点も変える場合の変更後の全件。 */
    testViewpoints: z.array(TestViewpoint).optional(),
  }),
});

/** ゴールガーディアンの判定。判定ごとに新しいセッションで実行する。 */
/**
 * ゴールガーディアンの実行の結果（PBI-46）。completed：実行できた（判断できなかった場合も含む）、failed：実行に
 * 失敗した、interrupted：デーモンの停止で中断した。以前の作業履歴には無い（理由の文言から判別する）。
 */
export const GuardianRunResult = z.enum(["completed", "failed", "interrupted"]);
export type GuardianRunResult = z.infer<typeof GuardianRunResult>;

const ChangeJudged = z.object({
  type: z.literal("ChangeJudged"),
  payload: z.object({
    proposalId: z.string(),
    verdict: Verdict,
    /** ゴールガーディアンが書いた理由。実行に失敗したときは sacty の文言（PBI-11）。 */
    reason: DaemonText,
    agentId: z.string(),
    runResult: GuardianRunResult.optional(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/** ゴールガーディアンが判定できなかった申し出への、人間の判断。 */
const ChangeDecided = z.object({
  type: z.literal("ChangeDecided"),
  payload: z.object({ proposalId: z.string(), accept: z.boolean() }),
});

/**
 * 認められた変更を反映する。設計は承認済みの版を置き換える。
 * 要求要件は承認を取り消し、変更後の要求要件を人間の再承認に回す（続く StepSubmitted）。
 */
const ChangeApplied = z.object({
  type: z.literal("ChangeApplied"),
  payload: z.object({ proposalId: z.string() }),
});

/** 実装の対象リポジトリを、タスクの作業領域に用意した。 */
const RepositoryPrepared = z.object({
  type: z.literal("RepositoryPrepared"),
  payload: z.object({
    url: z.string(),
    baseBranch: z.string(),
    /** 作業の起点にしたコミット。 */
    baseCommit: z.string(),
  }),
});

/**
 * sacty がテストを実行した結果。終了コードが0で、すべての観点にテストが対応していれば合格。
 * 不合格なら実装をやり直す（続けて通らなければ一時停止）。
 */
const TestsRun = z.object({
  type: z.literal("TestsRun"),
  payload: z.object({
    command: z.string(),
    exitCode: z.number().int(),
    /** テストが対応していない観点。 */
    unmappedViewpoints: z.array(z.string()),
    passed: z.boolean(),
    /** 出力の末尾。 */
    output: z.string(),
    /** sacty の注記（テストを止めた理由など）。テストの出力とは分けて、コードと引数で持つ（PBI-11）。 */
    note: DaemonText.optional(),
    durationMs: z.number().int().nonnegative(),
  }),
});

/**
 * テストの仕組みが無いタスク（StepsChosen の noTestsReason。PBI-94）で、テストのコマンドが無いので、テストを実行せずに
 * 最終レビューへ進めた。ゴールガーディアンが、タスクの目的から受け入れを判定する。
 */
const TestsSkipped = z.object({
  type: z.literal("TestsSkipped"),
  payload: z.object({}),
});

const ViewpointReview = z.object({
  viewpointId: z.string(),
  /** テストが、その観点を本当に検証しているか。 */
  verified: z.boolean(),
  /** ゴールガーディアンが書いた理由。判定が無いときは sacty の文言（PBI-11）。 */
  reason: DaemonText,
});

const RemarkReview = z.object({
  remarkId: z.string(),
  /** 指摘された問題が、今回の成果物で再発していないか。 */
  notRecurred: z.boolean(),
  reason: DaemonText,
});

/** ゴールガーディアンの最終レビュー。観点ごと・人間の指摘ごとに判定する。 */
const FinalReviewed = z.object({
  type: z.literal("FinalReviewed"),
  payload: z.object({
    passed: z.boolean(),
    viewpoints: z.array(ViewpointReview),
    remarks: z.array(RemarkReview),
    /** 全体への所見（形式を読めなかった場合の理由など）。 */
    summary: DaemonText,
    agentId: z.string(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * ゴールガーディアンの最終レビューを実行できなかった（利用上限など）。実装の問題ではないので
 * やり直さずに止め、再開すると最終レビューからやり直す。使った分の費用は予算に入れる。
 */
/**
 * ホストのゲートウェイが、エージェントの AI の呼び出しをリトライした（PBI-37）。実行の終わりに、リトライが
 * あった実行だけ記録する。gaveUp は、上限に達してあきらめたか。
 */
const AiRequestsRetried = z.object({
  type: z.literal("AiRequestsRetried"),
  payload: z.object({
    runId: z.string(),
    agentId: z.string(),
    retries: z.number().int().nonnegative(),
    waitedMs: z.number().nonnegative(),
    /** リトライの原因になった上流の状態（上流に届かなかったときは 0）。 */
    statuses: z.array(z.number().int()),
    gaveUp: z.boolean(),
  }),
});

/** 写したエージェントの元のファイル1つ（PBI-66）。path は、実行の agent/ の場所からの相対パス（区切りは /）。 */
export const ArchivedAgentFile = z.object({
  path: z.string().min(1),
  /** 写した（伏せた・間を省いた後の）大きさと SHA-256（16進）。いまのファイルと比べて、書き換えを見つける。 */
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** 元の（コンテナが書いた）大きさ。 */
  sourceBytes: z.number().int().nonnegative(),
  /** 上限で、先頭と末尾を残して間を省いた大きさ・行数。 */
  truncated: z
    .object({
      droppedBytes: z.number().int().nonnegative(),
      droppedLines: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ArchivedAgentFile = z.infer<typeof ArchivedAgentFile>;

/**
 * エージェント（Claude Code・Codex）が自分で書いた元のセッションのファイルを、実行の後に写した（PBI-66）。
 * 監査のため、写した各ファイルの大きさと SHA-256 を残す（追記専用の作業履歴に置き、ファイルの書き換えを見つける）。
 * 失敗・止めた・中止した実行でも、コンテナが残したところまでを写す（中止の後にも記録する）。
 */
const AgentSessionArchived = z.object({
  type: z.literal("AgentSessionArchived"),
  payload: z.object({
    runId: z.string().min(1),
    /** 何として実行したか（工程・orchestrator・guardian・chat など）。 */
    role: z.string(),
    agentId: z.string(),
    runtime: z.enum(["claude-code", "codex"]),
    /** エージェントのセッションの ID（Claude Code の session_id・Codex の thread_id。再開に使う）。 */
    sessionId: z.string().optional(),
    files: z.array(ArchivedAgentFile),
    /** 1実行あたりの上限（バイト）。超えた分は、ファイルごとに先頭と末尾を残して間を省く。 */
    limitBytes: z.number().int().positive(),
    /** 読めずに写せなかったファイル（相対パス）。 */
    skipped: z.array(z.string()).default([]),
    /**
     * 写さなかった理由（files は空）。container_not_confirmed：コンテナが止まったことを確かめられなかった
     * （動いたままのコンテナが写す途中のファイルを差し替えられるため、写さない）。
     */
    notArchived: z.enum(["container_not_confirmed"]).optional(),
  }),
});

/**
 * オーケストレーターのセッションを新しく始めた理由（PBI-67）。first：このタスクで初めて、agent_changed：エージェント
 * （AI の種類か ID）を変えた、truncated：保存したセッションのファイルが上限で間を省かれている、files_broken：保存した
 * ファイルが無い・壊れた（記録したハッシュと違う・セッションの本体が無い）、resume_failed：AI が再開を受け付けなかった。
 */
export const OrchestratorSessionReason = z.enum([
  "first",
  "agent_changed",
  "truncated",
  "files_broken",
  "resume_failed",
]);
export type OrchestratorSessionReason = z.infer<typeof OrchestratorSessionReason>;

/**
 * オーケストレーターのセッションを使った（PBI-67）。オーケストレーターの実行（role は orchestrator）は、同じタスク・同じ
 * エージェントのセッションを再開し（resumed）、無ければ・再開できなければ新しく始める（new。理由を残す）。終わったら
 * セッションを保存する（saved。保存できなかった理由は notSaved）。質問への答え（role は chat）は、保存したセッションを
 * 複製して答え（forked）、元のセッションには書き戻さない。
 */
const OrchestratorSessionUsed = z.object({
  type: z.literal("OrchestratorSessionUsed"),
  payload: z.object({
    runId: z.string().min(1),
    role: z.enum(["orchestrator", "chat"]),
    agentId: z.string(),
    runtime: z.enum(["claude-code", "codex"]),
    mode: z.enum(["resumed", "new", "forked"]),
    /** 実行が使ったセッションの ID（出力から読んだもの。複製なら、複製したセッション）。 */
    sessionId: z.string().optional(),
    /** 再開・複製した、保存してあったセッションの ID。 */
    resumedFrom: z.string().optional(),
    /** 新しく始めた理由（mode が new のとき）。 */
    reason: OrchestratorSessionReason.optional(),
    /** 再開を受け付けられなかった実行（reason が resume_failed のとき）。 */
    failedRunId: z.string().optional(),
    /** セッションを保存したか（role が orchestrator のとき）。 */
    saved: z.boolean().optional(),
    /**
     * 保存できなかった理由。not_archived：元のファイルを写せなかった、no_session：セッションの ID が分からない、
     * session_missing：セッションの本体のファイルが無い、copy_failed：保存の場所に書けなかった。
     */
    notSaved: z.enum(["not_archived", "no_session", "session_missing", "copy_failed"]).optional(),
  }),
});

/**
 * オーケストレーターが、認証の失敗・利用上限で工程を選べなかった（PBI-32）。標準の工程では進めず、続く
 * TaskPaused で止める（再開すると工程の選択からやり直す）。使った分の費用は予算に入れる。
 */
/** 工程・テストの実行のために、docker compose のサービスを起動した（PBI-47）。実行が終わると消す。 */
/**
 * チケットから取り込んだタスクの、作業するリポジトリ・題・概要を決めた（PBI-52）。オーケストレーターがチケットを読んで
 * 決める（actor は orchestrator。費用を含む）。決められなかったときは、人がリポジトリを選ぶ（actor は person）。
 */
const TicketTriaged = z.object({
  type: z.literal("TicketTriaged"),
  payload: z.object({
    repo: z.string(),
    /** タスクの題と概要（人が選んだときは無い。いまの題・本文のまま）。 */
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(20_000).optional(),
    reason: DaemonText,
    agentId: z.string().optional(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * リポジトリを指定せずに作ったタスク（PBI-73）の、作業するリポジトリを決めた。コードの変更が要り、分割しないタスクで、
 * オーケストレーターがプロジェクトの対象から選ぶ（actor は orchestrator。費用を含む）。選べなかったときは、人が選ぶ
 * （actor は person）。工程を選ぶ前だけ。決めた後は、そのリポジトリを用意して、いつもどおり工程を選ぶ。
 */
const RepositoryChosen = z.object({
  type: z.literal("RepositoryChosen"),
  payload: z.object({
    repo: z.string().min(1),
    reason: DaemonText,
    agentId: z.string().optional(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/** チケットに PR の URL をコメントした・できなかった（PBI-52）。PR を作ったら1回だけ。 */
const TicketPullRequestCommented = z.object({
  type: z.literal("TicketPullRequestCommented"),
  payload: z.object({ url: z.string().optional(), failed: DaemonText.optional() }),
});

/** 質問・答えの文字数の上限（PBI-54）。 */
export const QUESTION_MAX = 2_000;
export const ANSWER_MAX = 20_000;

/**
 * 人間が、タスクの詳細でオーケストレーターに質問した（PBI-54）。id はタスクの中で一意（Q-1, Q-2, …）。
 * 質問はタスクの状態・工程・承認済みの内容を変えない。答えを待つ質問は、1タスクに1件まで。
 */
const QuestionAsked = z.object({
  type: z.literal("QuestionAsked"),
  payload: z.object({
    questionId: z.string().min(1),
    text: z.string().min(1).max(QUESTION_MAX),
  }),
});

/**
 * オーケストレーターが、タスクの台帳を読んで質問に答えた（PBI-54）。答えられなければ answer の代わりに failed
 * （理由）を持つ。費用はタスクの予算に入れる（タスクの状態は変えない）。
 */
const QuestionAnswered = z.object({
  type: z.literal("QuestionAnswered"),
  payload: z.object({
    questionId: z.string().min(1),
    answer: z.string().min(1).max(ANSWER_MAX).optional(),
    failed: DaemonText.optional(),
    runResult: GuardianRunResult,
    agentId: z.string(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * 承認した成果の書き出しを始めた（PBI-56）。結果（OutputExported）の前にデーモンが止まったら、次の書き出しで、
 * 書き出し先に目印のあるページを探して更新させる（同じ成果を二重に書き出さない）。approvedAt は書き出す承認済みの版。
 */
const ExportStarted = z.object({
  type: z.literal("ExportStarted"),
  payload: z.object({ step: StepKey, runId: z.string(), approvedAt: z.string() }),
});

/**
 * 承認した成果を、決めた書き出し先に書き出した・書き出せなかった（PBI-56）。書き出せなければ failed（理由）を持ち、
 * いまの仕様（sacty の中に残す・取り込み元へのコメント）のまま進める（タスクは止めない）。interrupted は、人間が
 * 止めた・中止したので結果が分からない（費用だけを記録し、再開すると目印で探して続ける）。費用はタスクの予算に入れる。
 */
const OutputExported = z.object({
  type: z.literal("OutputExported"),
  payload: z.object({
    step: StepKey,
    runId: z.string(),
    approvedAt: z.string(),
    /** 書き出した承認済みの版（何回目の提出か）。 */
    submission: z.number().int().positive(),
    via: ExportVia,
    name: z.string(),
    url: z.string().max(2000).optional(),
    failed: DaemonText.optional(),
    runResult: GuardianRunResult,
    agentId: z.string(),
    ...AgentSetting,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/** 人間が、書き出せなかった成果の書き出し直しを求めた（PBI-56）。 */
const ExportRequested = z.object({
  type: z.literal("ExportRequested"),
  payload: z.object({ step: StepKey }),
});

const ServicesStarted = z.object({
  type: z.literal("ServicesStarted"),
  payload: z.object({
    runId: z.string(),
    step: StepKey,
    file: z.string(),
    services: z.array(
      z.object({
        name: z.string(),
        ports: z.array(z.number().int()),
        /** ホストに出すポートがコンテナのポートと違うもの（localhost の転送に使う。PBI-60）。 */
        hostPorts: z
          .array(z.object({ port: z.number().int(), target: z.number().int() }))
          .optional(),
        /** TCP 以外（UDP など）のポート。localhost には転送しない（PBI-60）。 */
        otherPorts: z.array(z.object({ port: z.number().int(), protocol: z.string() })).optional(),
      }),
    ),
    /** 共用の compose（PBI-70）から起動したとき、その名前と、取得したコミット。 */
    compose: z.object({ name: z.string(), commit: z.string() }).optional(),
    /** テストの実行のための起動か（無ければ工程のエージェントの実行）。 */
    forTests: z.boolean().optional(),
    /** 複数のサービスが使うため、localhost に転送しなかった番号（ホスト・コンテナのポート。PBI-60）。 */
    sharedPorts: z.array(z.number().int()).optional(),
  }),
});

const OrchestratorFailed = z.object({
  type: z.literal("OrchestratorFailed"),
  payload: z.object({
    // error：実行に失敗した・出力から工程を読み取れなかった（PBI-40）
    reason: z.enum(["usage_limit", "auth", "error"]),
    message: DaemonText,
    agentId: z.string(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

const FinalReviewFailed = z.object({
  type: z.literal("FinalReviewFailed"),
  payload: z.object({
    reason: z.enum(["usage_limit", "auth", "error"]),
    message: DaemonText,
    agentId: z.string(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * ゴールガーディアンの統合レビュー（PBI-31）。子タスクの PR がマージされた後のベースブランチのコードで、
 * 親の要求要件・テスト観点を満たすかを判定する。合格、または続けて通らない上限に達したら、統合レビューの
 * 承認待ちにする（続く StepSubmitted）。上限の前に不合格なら、タスク分割の工程をやり直して修正の子タスクを
 * 追加する。費用は、続く前の AgentRunCompleted に記録する。
 */
const IntegrationReviewed = z.object({
  type: z.literal("IntegrationReviewed"),
  payload: z.object({
    passed: z.boolean(),
    /** 読んだベースブランチと、そのコミット。 */
    baseBranch: z.string(),
    commit: z.string(),
    /**
     * リポジトリの無い親（PBI-73）で、子タスクのリポジトリごとに読んだベースブランチとコミット。親のリポジトリが無いので、
     * baseBranch・commit は空になる。
     */
    repositories: z
      .array(z.object({ repo: z.string(), baseBranch: z.string(), commit: z.string() }))
      .optional(),
    viewpoints: z.array(ViewpointReview),
    remarks: z.array(RemarkReview),
    /** 足りないこと（修正の子タスクで直すこと）。 */
    findings: z.array(z.string()),
    /** 全体への所見（形式を読めなかった場合の理由など）。 */
    summary: DaemonText,
  }),
});

/** sacty が作業をコミットしてブランチにプッシュし、PRを作った（または更新した）。 */
/**
 * PR の本文に使った PR テンプレート（PBI-87）。repo・path は使ったテンプレート（repo はテンプレートのあった
 * リポジトリの URL。対象のリポジトリか、Org の .github リポジトリ）。fallback は、テンプレートを使わずに sacty の
 * 決まった形の本文にした理由（none：無かった、unusable：読めなかった・使えなかった）。message はその補足
 * （秘密の値は伏せる）。truncated は、本文が長さの上限を超えたので後ろを省いた。
 */
export const PullRequestTemplateUse = z.object({
  repo: z.string().optional(),
  path: z.string().optional(),
  fallback: z.enum(["none", "unusable"]).optional(),
  message: DaemonText.optional(),
  truncated: z.boolean().optional(),
});
export type PullRequestTemplateUse = z.infer<typeof PullRequestTemplateUse>;

const PullRequestPublished = z.object({
  type: z.literal("PullRequestPublished"),
  payload: z.object({
    branch: z.string().min(1),
    commit: z.string().min(1),
    /** 本文に使った PR テンプレート（PBI-87。それより前の記録には無い）。 */
    template: PullRequestTemplateUse.optional(),
    /** PRを作らない設定（ブランチのプッシュまで）なら無い。 */
    url: z.string().optional(),
    number: z.number().int().positive().optional(),
    /** PRを作ったリポジトリ（リポジトリの URL）。PRの番号はリポジトリの中でしか一意でないため記録する。 */
    repo: z.string().optional(),
    /**
     * PR にレビュー用のラベル（sacty の設定 reviewLabel）を付ける予定と、そのときのラベル（PBI-88・PBI-99）。付けた・
     * 付けられなかった記録が無ければ、再開で付ける（付けるのは、そのときの設定のラベル）。
     */
    label: z.string().min(1).optional(),
  }),
});

/**
 * 実装が検証に通った後、PR を作ろうとしたら、実装が起点から何も変えていなかった（PBI-90）。PR を作らず、実装の承認で
 * 人間が実装の説明（変更が要らない理由）を確かめる。承認すると、変更なしで完了する（差し戻せば実装をやり直す）。
 * submission は、この後に提出する実装の提出回（PBI-110）。まだ PR を作っていないタスクだけで記録する。
 */
const NoChangesFound = z.object({
  type: z.literal("NoChangesFound"),
  payload: z.object({ submission: z.number().int().positive() }),
});

/**
 * sacty が作った PR（実装の PR と、要求要件・設計の PR）に、取り込むラベル（sacty の設定）を付けた（PBI-88）。
 * 別のタスクとして取り込ませ、レビューだけを行わせるため。created は、リポジトリにラベルが無かったので作った。
 * 1つの PR につき1回だけ付ける（記録のある PR には、更新しても付け直さない）。
 */
const PullRequestLabeled = z.object({
  type: z.literal("PullRequestLabeled"),
  payload: z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    label: z.string().min(1),
    created: z.boolean().default(false),
  }),
});

/**
 * 取り込むラベルを、sacty が作った PR に付けられなかった（権限など。PBI-88）。PR の作成は失敗にしない。
 * 付け直しはしない（1つの PR につき1回）。
 */
const PullRequestLabelFailed = z.object({
  type: z.literal("PullRequestLabelFailed"),
  payload: z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    label: z.string().min(1),
    message: DaemonText,
  }),
});

/**
 * sacty が、ベースブランチの起点のコミットからタスクブランチを作った（PBI-57）。要求要件・設計の PR はタスクブランチ
 * に向けて作り、実装の PR はタスクブランチからベースブランチに向けて作る。これが記録されたタスクは、要求要件・設計を
 * PR のマージで承認する（それより前の作業履歴のタスクは、これまでどおり画面で承認する）。
 */
const TaskBranchCreated = z.object({
  type: z.literal("TaskBranchCreated"),
  payload: z.object({ branch: z.string().min(1), commit: z.string().min(1) }),
});

/**
 * 要求要件・設計の成果のファイルを、工程のブランチにコミットしてプッシュした（PR の作成の前に記録する。PR の作成に
 * 失敗しても、プッシュ済みのブランチを中止で片付けられるように。PBI-57）。
 */
const StepBranchPushed = z.object({
  type: z.literal("StepBranchPushed"),
  payload: z.object({
    step: StepPullRequestKey,
    branch: z.string().min(1),
    commit: z.string().min(1),
  }),
});

/**
 * 要求要件・設計の成果のファイルを、タスクブランチへの PR にした（作った・更新した。PBI-57）。続けてその工程の承認待ち
 * （StepSubmitted）にする。base は、工程のブランチを作ったときのタスクブランチの先頭（同じ PR を更新するときは変えない）。
 * supersedes は、作り直したので sacty が閉じた、その工程の前の PR（前の工程に戻した後など）。
 */
const StepPullRequestPublished = z.object({
  type: z.literal("StepPullRequestPublished"),
  payload: z.object({
    step: StepPullRequestKey,
    branch: z.string().min(1),
    commit: z.string().min(1),
    /** 本文に使った PR テンプレート（PBI-87。それより前の記録には無い）。 */
    template: PullRequestTemplateUse.optional(),
    base: z.string().min(1),
    /** 成果のファイル（リポジトリの根からの相対パス）。 */
    path: z.string().min(1),
    url: z.string(),
    number: z.number().int().positive(),
    repo: z.string(),
    supersedes: z.number().int().positive().optional(),
    /**
     * PR にレビュー用のラベル（sacty の設定 reviewLabel）を付ける予定と、そのときのラベル（PBI-88・PBI-99）。付けた・
     * 付けられなかった記録が無ければ、再開で付ける（付けるのは、そのときの設定のラベル）。
     */
    label: z.string().min(1).optional(),
  }),
});

/**
 * 実装の承認待ちの間に見守っている PR の状態の変化（PBI-14a・PBI-110）。PR のマージを承認とみなし、
 * マージされたら続けて実装の承認（StepApproved）を記録する。マージせずに閉じられたら
 * 記録して人間の判断を待ち、開き直されたら見守りを続ける。要求要件・設計の PR（PBI-57）も同じく見守り、マージされたら
 * その工程の承認（StepApproved）を記録する。
 */
const PullRequestMerged = z.object({
  type: z.literal("PullRequestMerged"),
  payload: z.object({
    number: z.number().int().positive(),
    /** マージした GitHub のアカウント。 */
    by: z.string().optional(),
    /** マージされた内容（PR の先頭のコミット。人が直したなら、人が直した最終のコミット）。 */
    commit: z.string().optional(),
    /**
     * 最新の提出より前の内容でマージされた（PBI-63 より前の版の記録）。このときは承認にせず、人間の判断を待った。
     * いまの版は、違う内容でのマージも edited として承認にする（この記録で止まっているタスクも、次の確認で進める）。
     */
    outdated: z.boolean().default(false),
    /** sacty が PR に出した最後のコミット（PBI-63。監査のため）。 */
    submitted: z.string().optional(),
    /** マージのコミット（GitHub から取れれば。PBI-63）。 */
    mergeCommit: z.string().optional(),
    /**
     * 人が PR の中で直してからマージした（PR の先頭のコミットが、sacty が出したコミットと違う。PBI-63）。人がマージした
     * ＝人が承認したので、承認として進める（最終レビューはやり直さない）。
     */
    edited: z.boolean().default(false),
    /**
     * 要求要件・設計の成果のファイル（人が直してマージしたときだけ。PBI-63）。マージ後のタスクブランチ（commit）から
     * 読む。sacty の版と違えば、sacty の版（sacty）と人が直した版（final）の両方の本文を残し、人が直した版を承認済みの
     * 成果にする。同じなら本文は残さない。消された・読めないなら、sacty の版を承認済みにし、そのことを残す（fallback）。
     */
    document: z
      .object({
        path: z.string().min(1),
        /** ファイルを読んだコミット（マージ後のタスクブランチの先頭）。 */
        commit: z.string().optional(),
        sacty: z.string().optional(),
        final: z.string().optional(),
        fallback: z.enum(["deleted", "unreadable"]).optional(),
        /** 読めなかった理由。 */
        reason: DaemonText.optional(),
      })
      .optional(),
  }),
});
const PullRequestClosed = z.object({
  type: z.literal("PullRequestClosed"),
  payload: z.object({ number: z.number().int().positive() }),
});
const PullRequestReopened = z.object({
  type: z.literal("PullRequestReopened"),
  payload: z.object({ number: z.number().int().positive() }),
});

/**
 * PR へのフィードバックを、実装の指摘として取り込んだ（PBI-14b・PBI-110）。レビュー（Request changes・
 * コメント）の本文、行ごとのコメント、PR への通常のコメントを、まだ取り込んでいないものだけ取り込む
 * （同じものは二重に取り込まない）。指摘は1件ずつ。要求要件・設計の PR（PBI-57）の指摘も、その工程の指摘として取り込む。
 */
const PullRequestReviewImported = z.object({
  type: z.literal("PullRequestReviewImported"),
  payload: z.object({
    number: z.number().int().positive(),
    items: z
      .array(
        z.object({
          /** 種類と ID（例：review:123、review_comment:456、comment:789）。 */
          key: z.string().min(1),
          author: z.string(),
          at: z.string(),
          url: z.string().optional(),
        }),
      )
      .min(1),
    remarks: z.array(z.string().min(1)).min(1),
  }),
});

/**
 * 取り込んだ PR の指摘で、どの工程まで戻すかのゴールガーディアンの判断（PBI-14b）。target が無ければ
 * 判断できなかった。判断した工程に、人間の確認を待たずに差し戻す。判断できなければ実装をやり直す（PBI-58）。
 * PBI-58 より前の作業履歴では、設計・要求要件まで戻す・判断できないときは人間が確かめた（rework_confirmation）。
 */
const ReworkJudged = z.object({
  type: z.literal("ReworkJudged"),
  payload: z.object({
    target: StepKey.optional(),
    /** ゴールガーディアンが書いた理由。実行に失敗したときは sacty の文言。 */
    reason: DaemonText,
    agentId: z.string(),
    runResult: GuardianRunResult.optional(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/**
 * レビューの工程の対象の PR（PBI-19）。最初の実行の前に一度だけ記録し、以後はこのコミットのコードを読む。
 * headCommit は PR の先頭、baseCommit は PR の向き先のブランチの先頭（差分の起点）。
 */
const ReviewTargetResolved = z.object({
  type: z.literal("ReviewTargetResolved"),
  payload: z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    /** PR の説明（変更の意図。レビューのエージェントに渡す）。 */
    body: z.string().default(""),
    headCommit: z.string(),
    baseCommit: z.string(),
    /** PR の作者の login（総評で @ を付けて知らせる。PBI-111）。読めなければ空。 */
    author: z.string().default(""),
  }),
});

/**
 * レビューの結果を、対象の PR にレビュー（COMMENT）として投稿した。これでタスクは完了する（PBI-19）。
 * latestCommit は、投稿の直前に確かめた PR の先頭が、レビューしたコミットと違ったときの、その先頭（PBI-111。レビューは、
 * レビューしたコミットに対して投稿し、その旨を本文に書く）。
 */
const PullRequestReviewPosted = z.object({
  type: z.literal("PullRequestReviewPosted"),
  payload: z.object({ url: z.string(), latestCommit: z.string().optional() }),
});

/**
 * 人間が「再レビュー」を求めた（PBI-44）。レビューを投稿して完了したタスクのレビューの工程をやり直し、PR の最新の
 * コミットに対してもう一度レビューして投稿する（対象の PR は、実行の前に確かめ直す）。
 */
const ReviewRestarted = z.object({
  type: z.literal("ReviewRestarted"),
  payload: z.object({}),
});

/**
 * 完了した調査のタスク（GitHub Issue から取り込んだもの）の結果を、Issue にコメントとして返した（PBI-18）。
 * 返せなければ、その理由を記録する（何度も返そうとしない）。
 */
const IssueCommented = z.object({
  type: z.literal("IssueCommented"),
  payload: z.object({ url: z.string() }),
});
const IssueCommentFailed = z.object({
  type: z.literal("IssueCommentFailed"),
  payload: z.object({ message: DaemonText }),
});

/**
 * sacty のブランチにプッシュした（PRの作成の前に記録する。PRの作成に失敗しても、
 * プッシュ済みのブランチを中止で片付けられるように）。
 */
const BranchPushed = z.object({
  type: z.literal("BranchPushed"),
  payload: z.object({ branch: z.string().min(1), commit: z.string().min(1) }),
});

/**
 * ゴールガーディアンが最終レビューで合格にした成果物を、人間が差し戻した（見逃し）。
 * ゴールガーディアンの精度を測るために記録する。
 */
const GuardianMissed = z.object({
  type: z.literal("GuardianMissed"),
  payload: z.object({
    /** 見逃した最終レビュー（FinalReviewed の記録時刻）。 */
    reviewAt: z.string(),
    /** 人間の指摘。 */
    remarkIds: z.array(z.string()),
  }),
});

/** 中止の後片付けの対象。 */
export const CleanupTarget = z.enum([
  "container",
  "workspace",
  "session",
  "branch",
  "pull_request",
]);
export type CleanupTarget = z.infer<typeof CleanupTarget>;

/**
 * 中止した。sacty が作ったもの（コンテナ、作業領域、sacty のブランチ、sacty が作ったPR）を
 * 片付けた結果を、対象ごとに記録する。作業履歴は残し、以降の操作は受け付けない。
 */
const TaskCancelled = z.object({
  type: z.literal("TaskCancelled"),
  payload: z.object({
    /**
     * sacty が中止した理由（PBI-44）。レビューの PR がマージされた・マージされずに閉じられたので、終わっていない
     * レビューのタスクを中止した。人間が中止したときは無い。
     */
    reason: z.enum(["pull_request_merged", "pull_request_closed"]).optional(),
    cleanup: z.array(
      z.object({
        target: CleanupTarget,
        /** done：片付けた、skipped：対象が無かった、failed：失敗した（理由は detail）。 */
        result: z.enum(["done", "skipped", "failed"]),
        detail: DaemonText.optional(),
      }),
    ),
  }),
});

/**
 * 工程エージェントに渡したコンテキスト（PBI-6）。継承の順（上位から）に、使ったリポジトリと
 * コミットを記録する。合成で上書き禁止に当たったものなどは warnings に残す。
 */
const ContextResolved = z.object({
  type: z.literal("ContextResolved"),
  payload: z.object({
    runId: z.string(),
    layers: z.array(z.object({ repo: z.string(), ref: z.string().optional(), commit: z.string() })),
    warnings: z.array(DaemonText).default([]),
    /**
     * 使えるようにした外部 PF（PBI-74）。ホストの config.yaml の gateway.platforms と、プロジェクトのコンテキストで
     * 合成したもの（from にどの層のものか。ホストのものは無い）。秘密情報の名前・値は含めない。
     */
    platforms: z
      .array(
        z.object({
          name: z.string(),
          from: z.string().optional(),
          description: z.string(),
          allow: z.array(z.string()),
        }),
      )
      .optional(),
    /**
     * 置いた段階のサブエージェントの定義（PBI-119）。段階の名前（lite など）と、config.yaml のエージェントの名前・モデル・
     * リーズニングエフォート。段階を書いていない・置かなかった実行には無い。
     */
    tiers: z
      .array(
        z.object({
          tier: z.string(),
          agentId: z.string(),
          model: z.string().optional(),
          reasoningEffort: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

const ChangesRequested = z.object({
  type: z.literal("ChangesRequested"),
  payload: z.object({
    /** 承認ゲートで止まっていた工程。 */
    step: StepKey,
    /**
     * やり直す工程（指摘はこの工程に付く）。承認ゲートの工程か、それより前の工程。
     * 前の工程に戻すと、その工程から先の承認は取り消され、人間の再承認が必要になる。
     * PBI-7までの作業履歴には無いので、step で補う。
     */
    target: StepKey.optional(),
    /** やり直す工程への、何回目の差し戻しか。 */
    round: z.number().int().positive(),
    remarks: z.array(Remark).min(1),
    /** エスカレーションの後、上限を超えて差し戻したか。 */
    overLimit: z.boolean().default(false),
  }),
});

const RemarkVoided = z.object({
  type: z.literal("RemarkVoided"),
  payload: z.object({ remarkId: z.string() }),
});

const TaskEscalated = z.object({
  type: z.literal("TaskEscalated"),
  payload: z.object({
    step: StepKey,
    /** 差し戻しが上限を超えた工程（やり直す工程）。PBI-7までの作業履歴には無いので、step で補う。 */
    target: StepKey.optional(),
    /**
     * too_many_changes：差し戻しが上限を超えた
     * change_undecidable：ゴールガーディアンが変更の申し出を判定できなかった
     * rework_confirmation：PR の指摘で、設計・要求要件まで戻す（または戻し先を判断できなかった）ので、
     *   人間が戻し先を確かめる（PBI-14b）。PBI-58 から記録しない（過去の作業履歴を読むために残す）
     */
    reason: z.enum(["too_many_changes", "change_undecidable", "rework_confirmation"]),
    /** ゴールガーディアンの判断の理由（rework_confirmation のとき）。 */
    note: DaemonText.optional(),
    /** 判定できなかった申し出（change_undecidable のとき）。 */
    proposalId: z.string().optional(),
    /** 上限に達したときに人間が書いていた指摘。差し戻しを続ける場合に使う。 */
    pendingRemarks: z.array(Remark).default([]),
  }),
});

/** 修正のタスクの連鎖の上限（元のタスクから何段まで作るか。PBI-89）。 */
export const MAX_FIX_CHAIN = 3;
/** CI/CD の実行・チェックが1つも現れないまま、これだけたったら CI/CD が無いとみなす（PBI-89）。 */
export const DEPLOYMENT_CI_GRACE_MS = 5 * 60_000;
/** CI/CD が終わるのを待つ上限（監視を始めた時刻から。PBI-89）。 */
export const DEPLOYMENT_CI_TIMEOUT_MS = 60 * 60_000;

/** CI/CD の実行・チェック・コミットの状態の1件（PBI-89）。conclusion は終わったものだけ。 */
export const CiCheck = z.object({
  kind: z.enum(["workflow", "check", "status"]),
  name: z.string(),
  status: z.enum(["pending", "completed"]),
  conclusion: z.string().optional(),
  url: z.string().optional(),
});
export type CiCheck = z.infer<typeof CiCheck>;

/** 失敗とみなす結論（PBI-89）。cancelled・skipped・neutral・stale は失敗とみなさない。 */
const FAILED_CI_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);
/** 失敗とみなすコミットの状態（PBI-89）。 */
const FAILED_CI_STATES = new Set(["failure", "error"]);

/** CI/CD の実行・チェック・コミットの状態が、終わっていて失敗か（PBI-89）。 */
export function isFailedCiCheck(check: CiCheck): boolean {
  if (check.status !== "completed" || !check.conclusion) return false;
  return check.kind === "status"
    ? FAILED_CI_STATES.has(check.conclusion)
    : FAILED_CI_CONCLUSIONS.has(check.conclusion);
}

/** CI/CD の失敗の1件（PBI-89）。excerpt はログの抜粋（秘密情報を伏せてから切り詰めたもの）。 */
export const CiFailure = z.object({
  workflow: z.string(),
  job: z.string().optional(),
  conclusion: z.string(),
  url: z.string().optional(),
  excerpt: z.string().optional(),
});
export type CiFailure = z.infer<typeof CiFailure>;

/**
 * 実装の PR のマージで、マージのコミットの監視を始めた（PBI-89。PullRequestMerged と同じ追記で記録する）。PBI-116 からは、
 * マージの後の監視の工程（deployment）を飛ばしていないタスクだけ。PBI-116 より前は、プロジェクトの deploymentWatch が true の
 * とき（工程の無い、完了したタスクの監視）。commit が無い（マージのコミットが取れなかった）なら、監視を飛ばす。
 */
const DeploymentWatchStarted = z.object({
  type: z.literal("DeploymentWatchStarted"),
  payload: z.object({
    number: z.number().int().positive(),
    repo: z.string(),
    branch: z.string(),
    commit: z.string().optional(),
  }),
});

/**
 * CI/CD の結果（PBI-89）。passed：すべて通った、failed：失敗があった、none：CI/CD が無い、timed_out：終わらない。
 * passed のとき、使うデプロイの確認のスキル（リポジトリの根からのパス）があれば skill に持ち、無ければ確かめない理由を
 * skipCheck に持つ。
 */
const DeploymentCiFinished = z.object({
  type: z.literal("DeploymentCiFinished"),
  payload: z.object({
    result: z.enum(["passed", "failed", "none", "timed_out"]),
    checks: z.array(CiCheck).default([]),
    failures: z.array(CiFailure).default([]),
    skill: z.string().optional(),
    skipCheck: DaemonText.optional(),
  }),
});

/** デプロイの確認の答えの、CI/CD・デプロイの確認それぞれの結果（PBI-116）。 */
function DeploymentCheckPart<const T extends readonly [string, ...string[]]>(results: T) {
  return z.object({
    result: z.enum(results),
    summary: z.string().max(2000).optional(),
    reason: z.string().max(2000).optional(),
  });
}

/** デプロイの確認のエージェントの実行を始めた（PBI-89）。 */
const DeploymentCheckStarted = z.object({
  type: z.literal("DeploymentCheckStarted"),
  payload: z.object({ runId: z.string(), skill: z.string() }),
});

/**
 * デプロイの確認の結果（PBI-89）。healthy：アプリは動いている、unhealthy：エラーになっている（修正のタスクを作る）、
 * unknown：確かめられなかった（理由は failed。デーモンが止まった・実行の失敗・答えを読めないなど）。費用は元のタスクの
 * 予算に入れる。
 */
const DeploymentChecked = z.object({
  type: z.literal("DeploymentChecked"),
  payload: z.object({
    result: z.enum(["healthy", "unhealthy", "unknown"]),
    /**
     * スキルに従った、CI/CD の確認とデプロイの確認それぞれの結果（PBI-116）。どこまで見るかはスキルが決めるので、飛ばした
     * もの（skipped）とその理由（reason）も持つ。result は、この2つから sacty が決めた全体の結果。PBI-116 より前の記録には無い。
     */
    ci: DeploymentCheckPart(["passed", "failed", "skipped", "unknown"]).optional(),
    deployment: DeploymentCheckPart(["healthy", "unhealthy", "skipped", "unknown"]).optional(),
    /**
     * 人が止めた・デーモンが止まったので、確認を結果にせず、確かめ直す（PBI-116。工程の再開で、もう一度実行する）。
     * result は unknown。費用は記録する。
     */
    retry: z.literal(true).optional(),
    summary: z.string().max(4000).optional(),
    evidence: z.array(z.string().max(2000)).max(20).default([]),
    failed: DaemonText.optional(),
    runResult: GuardianRunResult,
    agentId: z.string(),
    ...AgentSetting,
    ...RunRef,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
});

/** デプロイの確認を実行せずに飛ばした（PBI-89。予算の上限に達していた）。 */
const DeploymentWatchSkipped = z.object({
  type: z.literal("DeploymentWatchSkipped"),
  payload: z.object({ reason: z.enum(["budget"]), detail: DaemonText.optional() }),
});

/**
 * 監視で見つけた失敗の、修正のタスクを登録した（PBI-89）。続けて、この ID・題・本文で修正のタスクを作る（作る前に
 * デーモンが止まっても、次の確認で作り直す）。
 */
const DeploymentFixRegistered = z.object({
  type: z.literal("DeploymentFixRegistered"),
  payload: z.object({
    taskId: z.string().min(1),
    kind: DeploymentFixKind,
    fingerprint: z.string().min(1),
    depth: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string(),
  }),
});

/**
 * 修正のタスクを作らなかった（PBI-89）。duplicate：同じ失敗の修正のタスクが終わっていない（existing）、chain_limit：
 * 修正のタスクの連鎖が上限（MAX_FIX_CHAIN）に達した。
 */
const DeploymentFixSuppressed = z.object({
  type: z.literal("DeploymentFixSuppressed"),
  payload: z.object({
    kind: DeploymentFixKind,
    fingerprint: z.string().min(1),
    reason: z.enum(["duplicate", "chain_limit"]),
    existing: z.string().optional(),
  }),
});

/** 作業履歴に書けるイベント（追加する前の形）。 */
export const EventInput = z.discriminatedUnion("type", [
  TaskCreated,
  TaskSplit,
  TaskUnblocked,
  SplitCompleted,
  ReproductionChecked,
  StepCompleted,
  StepsChosen,
  StepImageChanged,
  ServicesStarted,
  TicketTriaged,
  RepositoryChosen,
  TicketPullRequestCommented,
  QuestionAsked,
  QuestionAnswered,
  ExportStarted,
  OutputExported,
  ExportRequested,
  AgentRunStarted,
  AgentRunCompleted,
  AgentRunFailed,
  BudgetWarned,
  TaskPaused,
  BudgetCapRaised,
  TaskResumed,
  StepSubmitted,
  StepApproved,
  StepQueued,
  ChangeProposed,
  ChangeJudged,
  ChangeDecided,
  ChangeApplied,
  RepositoryPrepared,
  TestsRun,
  TestsSkipped,
  FinalReviewed,
  FinalReviewFailed,
  OrchestratorFailed,
  AiRequestsRetried,
  AgentSessionArchived,
  OrchestratorSessionUsed,
  IntegrationReviewed,
  PullRequestPublished,
  NoChangesFound,
  PullRequestLabeled,
  PullRequestLabelFailed,
  TaskBranchCreated,
  StepBranchPushed,
  StepPullRequestPublished,
  PullRequestMerged,
  PullRequestClosed,
  PullRequestReopened,
  PullRequestReviewImported,
  ReworkJudged,
  IssueCommented,
  IssueCommentFailed,
  ReviewTargetResolved,
  PullRequestReviewPosted,
  ReviewRestarted,
  BranchPushed,
  GuardianMissed,
  TaskCancelled,
  ContextResolved,
  ChangesRequested,
  RemarkVoided,
  TaskEscalated,
  DeploymentWatchStarted,
  DeploymentCiFinished,
  DeploymentCheckStarted,
  DeploymentChecked,
  DeploymentWatchSkipped,
  DeploymentFixRegistered,
  DeploymentFixSuppressed,
]);
export type EventInput = z.input<typeof EventInput>;
export type ParsedEventInput = z.infer<typeof EventInput>;

/** 作業履歴に記録されたイベント。seq は作業履歴全体で単調増加する。 */
export type ActivityEvent = ParsedEventInput & {
  seq: number;
  id: string;
  taskId: string;
  projectId: string;
  at: string;
  actor: Actor;
};

export const TASK_TITLE_MAX = 200;
export const TASK_BODY_MAX = 10_000;

/** 画面から受け付けるタスク作成の入力。 */
export const CreateTaskInput = z.object({
  title: z
    .string()
    .trim()
    .min(1, code("input.titleRequired"))
    .max(TASK_TITLE_MAX, code("input.titleTooLong")),
  body: z.string().trim().max(TASK_BODY_MAX, code("input.bodyTooLong")).default(""),
  /** 作るプロジェクト（必須。既定のプロジェクトは無い。PBI-22）。 */
  projectId: z.string().min(1),
  /**
   * 対象リポジトリ（リポジトリの URL。プロジェクトのリポジトリの設定から選ぶ。PBI-21）。
   * 省略すると、プロジェクトの対象がリポジトリ1つだけならそれにし、そうでなければリポジトリを指定しない（PBI-73）。
   * null は、リポジトリを指定しない（対象がリポジトリ1つだけでも）。
   */
  repo: z.string().trim().min(1).nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/**
 * テンプレートからタスクを作る入力（PBI-90）。題と説明はテンプレートから sacty が決めるので受け付けない（書けば誤り）。
 * 対象リポジトリは必須（省略すると、プロジェクトの対象がリポジトリ1つだけならそれにする。null は受け付けない）。
 */
export const CreateTemplateTaskInput = z
  .object({
    template: TaskTemplate,
    projectId: z.string().min(1),
    repo: z.string().trim().min(1).optional(),
  })
  .strict();
export type CreateTemplateTaskInput = z.infer<typeof CreateTemplateTaskInput>;

/** 一時停止中のタスクを再開する入力。予算で止まった場合は新しい上限（累計）が必要。 */
export const ResumeTaskInput = z.object({
  capUsd: z.number().positive().max(10_000).optional(),
});
export type ResumeTaskInput = z.infer<typeof ResumeTaskInput>;

/** 承認ゲートで承認する入力。 */
/** 画面が表示していた提出回。現在のゲートと一致しなければ拒否する（古い成果物を見たまま判断させないため）。 */
const Submission = z.number().int().positive();

export const ApproveStepInput = z.object({ step: StepKey, submission: Submission });
export type ApproveStepInput = z.infer<typeof ApproveStepInput>;

/** 承認ゲートで差し戻す入力。指摘は1行に1件。 */
export const RequestChangesInput = z.object({
  step: StepKey,
  submission: Submission,
  /** やり直す工程。省略すると承認ゲートの工程。 */
  target: StepKey.optional(),
  comments: z
    .array(z.string().trim().max(2_000, code("input.remarkTooLong")))
    .max(50, code("input.tooManyRemarks"))
    .transform((list) => list.filter((c) => c.length > 0)),
  /** エスカレーションの後、上限を超えて差し戻しを続けるか。 */
  continueOverLimit: z.boolean().default(false),
});
export type RequestChangesInput = z.input<typeof RequestChangesInput>;

/** タスクの詳細で、オーケストレーターに質問する入力（PBI-54）。 */
export const AskQuestionInput = z.object({
  text: z
    .string()
    .trim()
    .min(1, code("input.questionRequired"))
    .max(QUESTION_MAX, code("input.questionTooLong")),
});
export type AskQuestionInput = z.infer<typeof AskQuestionInput>;

/** タスクの詳細で、工程のイメージを変える入力（PBI-106）。image は config.yaml の images の名前か default。 */
export const ChangeStepImageInput = z.object({
  step: StepKey,
  image: z.string().trim().min(1).max(100),
});
export type ChangeStepImageInput = z.infer<typeof ChangeStepImageInput>;

/** ゴールガーディアンが判定できなかった変更の申し出を、人間が判断する入力。 */
export const DecideChangeInput = z.object({ accept: z.boolean() });
export type DecideChangeInput = z.infer<typeof DecideChangeInput>;
