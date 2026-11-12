/**
 * 実装の工程に、提出の前に確かめさせる基準（PBI-315）。もとは最終レビューの判定基準を先に渡すためのもの。最終レビューは
 * やめた（PBI-331）が、実装の指示はこの基準を使い続ける。特定の言語・ツールに寄せない。
 */

/** 求められていなければ範囲外になる変更。 */
export const UNREQUESTED_BEHAVIOR =
  "振る舞いの変更（画面・API・設定・既定値・文言の変更や、機能・操作の追加）";
/** 求められていなければ範囲外になる、テストの変更。 */
export const TEST_WEAKENING =
  "既存のテストの期待を弱める・逆にする変更（期待値の変更、検証の削除、テストのスキップ・削除）";
/** リファクタリングでも変えてはいけない、既存の振る舞い。 */
export const EXISTING_BEHAVIOR =
  "既存の振る舞い（エラーの種類・状態コード・メッセージ、検査の順番、応答の形・項目、既定値）";
/** 書かれていなくても範囲内になる変更。 */
export const CONVENTION_CHANGES =
  "リポジトリの決まりが、この種の変更に伴って求める変更（README・CHANGELOG・版・ドキュメント・生成物の更新、PR テンプレートの項目など）";
/** 異常の後の回復を確かめる仕組み。 */
export const SHARED_MECHANISM =
  "複数の処理から共有される仕組み（キュー・ロック・キャッシュ・フラグなどの共有の状態、共有のヘルパー）";
/** リポジトリのファイルに書かない名前。 */
export const INTERNAL_NAMES =
  "sacty の作業領域の内部の名前（.sacty-tools、/tmp/sacty-…、/sacty-input など）";
/** 観点を検証していないテスト。 */
export const HOLLOW_TEST = "観点を検証していない（形だけ・期待結果を確かめていない・対応が違う）";
/** 受け入れの確かめを縮めた形。 */
export const SHALLOW_ACCEPTANCE = "名前・項目・ファイル・リンクが存在することの確認";

/**
 * 基準の一覧（テストで、実装の工程の指示にあることを確かめる）。scope は範囲外の変更の判定（セキュリティ対応は
 * 観点 SEC-MIN が見るので、指示に入らない）、tests はテストの仕組みがあるタスクだけのもの。
 */
export const FINAL_REVIEW_CRITERIA = [
  { id: "unrequested-behavior", term: UNREQUESTED_BEHAVIOR, scope: true },
  { id: "test-weakening", term: TEST_WEAKENING, scope: true },
  { id: "existing-behavior", term: EXISTING_BEHAVIOR, scope: true },
  { id: "convention-changes", term: CONVENTION_CHANGES, scope: true },
  { id: "hollow-test", term: HOLLOW_TEST, tests: true },
  { id: "shallow-acceptance", term: SHALLOW_ACCEPTANCE },
  { id: "shared-mechanism", term: SHARED_MECHANISM },
  { id: "internal-names", term: INTERNAL_NAMES },
] as const satisfies readonly { id: string; term: string; scope?: true; tests?: true }[];

/**
 * 実装の工程の、提出の前に確かめる最終レビューの基準。scope：範囲外の変更を判定するタスクか。tests：テストの仕組みがあり、
 * テストを観点に対応させるタスクか。aiRemarks：AI のレビューの過去の指摘があるか（応え方は、不合格の基準とは分けて伝える）。
 */
export function implementReviewCriteriaLines(o: {
  /**
   * 範囲の判定の拠り所を、このタスクの実装の指示の言葉で書いたもの（要求要件・設計を省いたタスクに、承認済みの要求要件と書かない）。
   */
  sources: string;
  scope: boolean;
  tests: boolean;
  aiRemarks: boolean;
  acceptanceDepthLine: string;
}): string[] {
  return [
    "",
    "--- 提出の前に確かめる、最終レビューの基準 ---",
    "最終レビューは、次のどれかに当たると不合格にします（不合格になると、実装と検証をやり直します）。提出の前に、差分で1つずつ確かめてください。",
    ...(o.scope
      ? [
          `- 差分の変更ごとに、${o.sources}と人間の過去の指摘のどれかが求めている変更か、求めている変更を実現するのに要る変更（呼び出し元の追従・型の変更・求めた振る舞いのテストの追加や更新・競合の解消）かを確かめる。どれにも当たらない${UNREQUESTED_BEHAVIOR}は入れない。良い変更に見えても同じで、気づいたことは実装の説明に書くだけにする`,
          `- ${TEST_WEAKENING}は、${o.sources}が、そのテストの確かめている振る舞いを変えることを求めているときだけ行う。テストを通すために期待を弱めない`,
          `- 共通化・分割・移動・名前の付け替えのリファクタリングでも、${EXISTING_BEHAVIOR}を、${o.sources}に無い形で変えない。変更した関数ごとに変更前と後を読み比べ、検査が複数ある関数は、複数の異常が同時に当たる入力で、どの検査が先に働き、どのエラーを返すかが変わっていないかを確かめる`,
          `- ${CONVENTION_CHANGES}は、作業領域の AGENTS.md・CLAUDE.md・CONTRIBUTING・PR テンプレート・既存の変更の慣習を読んで確かめ、求められていれば行う`,
        ]
      : []),
    ...(o.tests
      ? [
          `- ${HOLLOW_TEST}テストを書かない。観点ごとに、入力を与えて期待結果を確かめ、テストのコマンドで実行されて通る（スキップ・除外されない）ことを確かめる`,
        ]
      : []),
    o.acceptanceDepthLine,
    `- 差分が${SHARED_MECHANISM}を新しく入れた・変えたときは、その仕組みに異常や失敗（例外・不正な入力・途中での中断）が起きた後も、後続の処理が続けられることを確かめる。失敗の後に残る状態（フラグ・ロック・キューの滞留など）が解放・回復されるかをコードで追い、実行できるなら、異常な入力の後に別の要求を処理する試しも行う`,
    `- リポジトリのファイル（スクリプト・テスト・設定・文書）に、${INTERNAL_NAMES}を書かない`,
    // AI の指摘に応えた、要求を超える変更は、最終レビューが不合格にせず人の確認に回していた（指示の文言は変えていない）。
    // 不合格の基準とは分けて伝える（PR #321 のレビュー）
    ...(o.scope && o.aiRemarks
      ? [
          `不合格の基準ではありませんが、AI のレビューの過去の指摘（人間の指摘ではなく、人間が承認したものでもない）に応えるときは、${o.sources}に対する欠陥の修正にとどめ、それを超えて振る舞いを変えないでください。超える変更は、最終レビューが不合格にはせず、人が確かめることに回します（既存のテストの期待を弱める変更は、AI の指摘に応えたものでも、上のとおり不合格になります）。`,
        ]
      : []),
  ];
}
