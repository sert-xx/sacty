import { z } from "zod";
import { code, DaemonText } from "./message-code.js";

/**
 * 工程の種類。標準の工程は requirements → design → implement → pr。
 * investigate（調査）は、コードを調べて報告するだけの工程（PBI-18）。
 * review（レビュー）は、既存の PR をレビューして、PR に投稿するだけの工程（PBI-19）。
 * split（タスク分割）は、承認済みの設計から子タスクを作り、子タスクの完了を待つ工程（PBI-27）。
 * reproduce（再現）は、不具合を再現する失敗するテストを書き、sacty が失敗を確かめる工程（PBI-29）。
 * integrate（統合レビュー）は、子タスクの成果を組み合わせて親の要求要件を満たすかを、ゴールガーディアンが
 * 確かめる工程（PBI-31）。タスク分割の後に置く。
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
  "pr",
]);
export type StepKey = z.infer<typeof StepKey>;

/** 標準の工程（オーケストレーターが判断できないときも、これで進める）。 */
export const MVP_STEPS: readonly StepKey[] = ["requirements", "design", "implement", "pr"];

/**
 * オーケストレーターが選べる工程の組み合わせ（PBI-17）。候補に無い組み合わせは選ばせない。
 * 工程の種類を増やしたら（調査・レビューなど）、ここに組み合わせを足す。
 */
export const STEP_PLANS = {
  /**
   * 標準：調査 → 要求要件 → 設計（テスト観点）→ 実装 → PR作成。実装する組み合わせは、先頭に前段の調査を置き、
   * その結果を後の工程に渡す。前段の調査は人間が承認しない（PBI-29）
   */
  standard: ["investigate", "requirements", "design", "implement", "pr"],
  /** 小さな変更：設計を省く（要求要件の受け入れ条件をテストで確かめる） */
  "skip-design": ["investigate", "requirements", "implement", "pr"],
  /** 調査だけ：コードを調べて報告する。実装や PR は作らない（PBI-18） */
  investigate: ["investigate"],
  /** レビューだけ：タスクにある PR をレビューして、PR に投稿する（PBI-19） */
  review: ["review"],
  /**
   * 大きなタスク：要求要件 → 設計 → タスク分割 → 統合レビュー。設計の承認の後に子タスクを作り、子タスクが
   * それぞれ実装と PR を行う（PBI-27）。子タスクは分割できない（1段だけ）。子がすべて片付いたら、
   * 統合レビューを通して人間が承認すると完了する（PBI-31）
   */
  split: ["investigate", "requirements", "design", "split", "integrate"],
  /**
   * 不具合の修正：再現 → 実装 → PR作成。不具合を再現する失敗するテストを書き、それを通すように直す（PBI-29）
   */
  bugfix: ["investigate", "reproduce", "implement", "pr"],
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
export const EXPORT_STEPS: readonly StepKey[] = ["investigate", "requirements", "design"];

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

/** 人間の承認ゲートがある工程。PR作成は、成果物チェックのゲート。統合レビューは、親タスクの最後の確認（PBI-31）。 */
export const GATED_STEPS: readonly StepKey[] = [
  "investigate",
  "requirements",
  "design",
  "integrate",
  "pr",
];

/** 差し戻しでやり直せる（工程エージェントが作る）工程。 */
export const REWORK_STEPS: readonly StepKey[] = [
  "investigate",
  "reproduce",
  "requirements",
  "design",
  "implement",
];

/**
 * 対象のリポジトリへの PR で人間が承認する工程（PBI-57）。成果をファイルでタスクブランチへの PR にし、PR のマージを
 * 承認とする。実装の成果物チェック（pr）は、タスクブランチからベースブランチへの PR。
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

/** 人間の指摘。id は作業履歴の中で一意（例：requirements-2-1 は要求要件の2回目の差し戻しの1件目）。 */
export const Remark = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type Remark = z.infer<typeof Remark>;

/** 工程エージェントの、指摘への対応。 */
export const RemarkResponse = z.object({ remarkId: z.string(), text: z.string() });
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
   */
  review: z.enum(["requested", "label"]).optional(),
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
      .enum(["sacty", "github_issue", "github_pull_request", "split", "ticket", "jira"])
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
     * 分割で作った子タスクの親と、先に完了している必要がある子タスク（PBI-27）。
     * 依存がある子タスクは、依存先がすべて完了するまで待つ（blocked）。
     */
    parent: z.object({ taskId: z.string(), dependsOn: z.array(z.string()) }).optional(),
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

/**
 * タスクの工程を決めた。PBI-17 からは、オーケストレーター（AI）がタスクの内容と対象リポジトリを読んで、
 * 候補（STEP_PLANS）から選び、理由とともに記録する（人間の承認は無い）。判断できなければ標準の工程にする。
 * それより前の作業履歴は、固定の工程（steps だけ）。
 */
const StepsChosen = z.object({
  type: z.literal("StepsChosen"),
  payload: z.object({
    steps: z.array(StepKey).min(1),
    plan: StepPlan.optional(),
    /** オーケストレーターが書いた理由。判断できなかったときは sacty の文言。 */
    reason: DaemonText.optional(),
    /** 判断できず、標準の工程にした。 */
    fallback: z.boolean().default(false),
    /**
     * オーケストレーターが対象リポジトリを読んで決めた、テストのコマンド（PBI-25）。sh -c で実行し、
     * 終了コード0で合格。分からなければ持たない（実装の工程を含むタスクは止める）。
     */
    testCommand: z.string().trim().min(1).max(1000).optional(),
    /** 調査の工程の性質（PBI-43）。無ければ内容の調査として扱う（セットアップをしない側）。 */
    investigation: InvestigationKind.optional(),
    /**
     * 工程ごとに使うイメージの名前（config.yaml の images の名前か default。PBI-41）。書いていない工程は
     * 既定のイメージ。テストの実行は、確かめる工程（実装・再現）のイメージで行う。
     */
    images: z.partialRecord(StepKey, z.string().min(1)).optional(),
    /** イメージを決めたのが、プロジェクトの対象の指定か、オーケストレーターか。 */
    imageSource: z.enum(["project", "orchestrator"]).optional(),
    /** オーケストレーターがイメージを選んだ理由。 */
    imageReason: z.string().max(1000).optional(),
    /**
     * 工程・テストの実行の前に起動する docker compose のサービス（DB・モック API など。PBI-47）。file は作業領域からの
     * 相対パス、names は起動するサービス（空ならすべて）、steps はサービスを使う工程。
     */
    services: z
      .object({
        file: z.string().min(1).max(300),
        names: z.array(z.string().min(1).max(100)).max(20),
        steps: z.array(StepKey).min(1),
      })
      .optional(),
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
    agentId: z.string().optional(),
    ...AgentSetting,
    usage: TokenUsage.optional(),
    costUsd: z.number().nonnegative().default(0),
    estimated: z.boolean().default(false),
  }),
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
    /** 再現の工程が申告した、不具合を再現するテスト（PBI-29）。 */
    reproductionTests: z.array(z.string()).default([]),
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
    viewpoints: z.array(ViewpointReview),
    remarks: z.array(RemarkReview),
    /** 足りないこと（修正の子タスクで直すこと）。 */
    findings: z.array(z.string()),
    /** 全体への所見（形式を読めなかった場合の理由など）。 */
    summary: DaemonText,
  }),
});

/** sacty が作業をコミットしてブランチにプッシュし、PRを作った（または更新した）。 */
const PullRequestPublished = z.object({
  type: z.literal("PullRequestPublished"),
  payload: z.object({
    branch: z.string().min(1),
    commit: z.string().min(1),
    /** PRを作らない設定（ブランチのプッシュまで）なら無い。 */
    url: z.string().optional(),
    number: z.number().int().positive().optional(),
    /** PRを作ったリポジトリ（リポジトリの URL）。PRの番号はリポジトリの中でしか一意でないため記録する。 */
    repo: z.string().optional(),
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
    base: z.string().min(1),
    /** 成果のファイル（リポジトリの根からの相対パス）。 */
    path: z.string().min(1),
    url: z.string(),
    number: z.number().int().positive(),
    repo: z.string(),
    supersedes: z.number().int().positive().optional(),
  }),
});

/**
 * 成果物チェックの間に見守っている PR の状態の変化（PBI-14a）。PR のマージを承認とみなし、
 * マージされたら続けて成果物チェックの承認（StepApproved）を記録する。マージせずに閉じられたら
 * 記録して人間の判断を待ち、開き直されたら見守りを続ける。要求要件・設計の PR（PBI-57）も同じく見守り、マージされたら
 * その工程の承認（StepApproved）を記録する。
 */
const PullRequestMerged = z.object({
  type: z.literal("PullRequestMerged"),
  payload: z.object({
    number: z.number().int().positive(),
    /** マージした GitHub のアカウント。 */
    by: z.string().optional(),
    /** マージされた内容（PR の先頭のコミット）。 */
    commit: z.string().optional(),
    /**
     * 最新の提出より前の内容でマージされた（差し戻しの間にマージされたなど）。このときは承認にせず、
     * 人間の判断を待つ（差し戻すと、作り直した内容は新しい PR で出す）。
     */
    outdated: z.boolean().default(false),
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
 * PR へのフィードバックを、成果物チェックの指摘として取り込んだ（PBI-14b）。レビュー（Request changes・
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
  }),
});

/** レビューの結果を、対象の PR にレビュー（COMMENT）として投稿した。これでタスクは完了する（PBI-19）。 */
const PullRequestReviewPosted = z.object({
  type: z.literal("PullRequestReviewPosted"),
  payload: z.object({ url: z.string() }),
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

/** 作業履歴に書けるイベント（追加する前の形）。 */
export const EventInput = z.discriminatedUnion("type", [
  TaskCreated,
  TaskSplit,
  TaskUnblocked,
  SplitCompleted,
  ReproductionChecked,
  StepCompleted,
  StepsChosen,
  ServicesStarted,
  TicketTriaged,
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
  FinalReviewed,
  FinalReviewFailed,
  OrchestratorFailed,
  AiRequestsRetried,
  IntegrationReviewed,
  PullRequestPublished,
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
   * 省略すると、プロジェクトのリポジトリの設定が1つだけならそれにする。
   */
  repo: z.string().trim().min(1).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

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

/** ゴールガーディアンが判定できなかった変更の申し出を、人間が判断する入力。 */
export const DecideChangeInput = z.object({ accept: z.boolean() });
export type DecideChangeInput = z.infer<typeof DecideChangeInput>;
