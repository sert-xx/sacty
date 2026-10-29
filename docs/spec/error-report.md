**日本語** | [English](error-report.en.md)

# エラーレポート

タスクでエラーが起きたときに、何が起きたかを1つの Markdown ファイルにまとめる。
sacty の処理（作業履歴）・各実行のエージェントの動き（セッションログ）・エラーの記録を入れ、エラーの箇所は詳しく、ほかは短くする。
サーバーに送らず、画面からファイルとしてダウンロードする（通信できない環境でも渡せる）。
オーケストレーターに分析させると、原因の推定と次にすることをレポートに足す。

関係する ADR: [エラーレポートを Markdown のダウンロードにし、オーケストレーターの分析を任意で足す](../adr/20261029-0609-error-report-markdown-download.md)

## エラーとして扱う記録

作業履歴の1件を、次の3種類に分ける（`failureKind`）。
どれにも当たらない記録はエラーにしない。

| 種類 | 記録 |
| --- | --- |
| `error`（失敗） | 種類の名前が `Failed` で終わる記録（`AgentRunFailed`・`OrchestratorFailed`・`FinalReviewFailed`・`IssueCommentFailed`・`PullRequestLabelFailed`・`AuditFailed`）と、`failed` を持つか `runResult` が `failed` の記録（書き出し・質問への答えなど） |
| `stop`（停止） | `TaskPaused`（理由が `manual` のものを除く）・`TaskEscalated` |
| `check`（確認の不合格） | 通らなかった `TestsRun`・`failed` か `timed_out` の `PullRequestCiFinished`・`unhealthy` の `DeploymentChecked` |

エラーの分析の記録（`ErrorAnalysisRequested`・`ErrorAnalyzed`）は、分析が失敗してもエラーに数えない。

コード: `packages/core/src/error-report.ts`（`failureKind`・`hasFailures`）

## レポートの中身

`GET /api/tasks/:id/error-report` は、タスクのレポートを `text/markdown` で返す（無いタスクと、消したプロジェクトのタスクは 404）。
`?lang=en` なら英語の見出し、それ以外は日本語の見出しにする。
作業履歴の文言のコードは、その言語の文にする。
中止したタスクでも作れる。

節は次の順に並べる。

1. 基本の情報：題・タスクの ID・プロジェクト・状態・一時停止の理由と詳細・工程と状態・リポジトリ・PR・費用・作成と最終更新・レポートを作った時刻。
   共有する先に注意する旨の1行を、題の下に入れる。
2. エラーの概要：エラーの記録の件数と、すべての記録の表（時刻・種類・記録の種類・工程か役割・主な項目）。
3. オーケストレーターの分析：最後に分析できた分析の本文と時刻。
   分析中・最後の分析が失敗したときは、そのことを書く。
   分析していなければ、画面から分析させられることを書く。
4. エラーの詳細：新しいエラーから `detailedFailures`（5）件を、1件ずつ詳しく書く。
   - 直前の sacty の記録（`contextEvents`（8）件）
   - 記録の JSON（文言のコードは文にし、長い文字列は切り詰める）
   - 記録が実行を指していれば、その実行の役割・エージェント・モデル・結果、標準エラー出力の末尾、エージェントの最後の出来事（考えたことを除いて `tailEntries`（30）件まで）
   - ほかの古いエラーは、件数だけを書く（概要の表に載っている）
5. 実行の一覧：作業履歴に出てくる実行と、セッションログのある実行を、始めた順に表にする（役割・エージェントとモデル・開始・時間・結果・費用）。
   続けて、ログのある実行ごとに、エージェントの動きの要約（メッセージ・ツールの呼び出しと失敗・エラーの数、よく使ったツール、最後のメッセージ）を書く。
6. 作業履歴：1件1行（番号・時刻・actor・種類・主な項目）。
   エラーの記録には印 `⚠` を付ける。
7. このレポートについて：詳しく書く件数・要約であること・大きさの上限。

セッションログは、画面の実行のログと同じ読み分け（Claude Code の stream-json と Codex の `exec --json`）で読む。
実行中の実行は、いまの写し（[作業履歴](event-log.md#セッションログ実行ごとのファイル)）を読む。

コード: `apps/daemon/src/error-report.ts`（`buildErrorReport`）、`packages/core/src/session-log.ts`（`parseSessionLog`）、`apps/daemon/src/service.ts`（`errorReport`）、`apps/daemon/src/server.ts`（`createApp`）

## 大きさの上限

テキストファイルとして重くしないよう、部分ごとと全体に上限を置く（`ERROR_REPORT_LIMITS`）。

| 項目 | 上限 |
| --- | --- |
| 全体 | 256,000 バイト。超えたら行の切れ目で切り、省いたことを書く |
| 記録の JSON | 4,000 字（中の1つの文字列は 1,200 字） |
| 標準エラー出力の末尾 | 6,000 字 |
| エージェントの最後の出来事 | 30 件・合わせて 10,000 字（1件 700 字） |
| 最後のメッセージ | 400 字 |
| 作業履歴の1行 | 260 字 |
| オーケストレーターの分析 | 20,000 字 |
| セッションログを読む大きさ | 1実行の末尾 2MB。大きいログは末尾だけを集計し、そのことを書く |

作業履歴は、ほかの節を入れた残りに入る分だけ入れる。
先頭の `timelineHead`（20）件と、新しいものから入るだけを入れ、間を省いたら件数を書く。

作業履歴とセッションログは、記録のときに秘密情報を伏せてある（[秘密情報](secrets.md)）ので、レポートでは伏せ直さない。

コード: `apps/daemon/src/error-report.ts`（`ERROR_REPORT_LIMITS`・`buildErrorReport`）

## オーケストレーターの分析

- `POST /api/tasks/:id/error-analysis` は、分析の求め（`ErrorAnalysisRequested`。ID は `A-1`, `A-2`, …）を記録し、分析を待たずに 201 を返す。
- 求められないとき（`errorAnalysisBlocked`）は 409 で理由を返す。
  - 中止したタスク（`task.cancelled`）
  - 分析を待っている求めがある（`errorReport.analyzing`。1タスクに1件まで）
  - 予算の上限に達した（`errorReport.budgetExceeded`）
  - 設定を読めない（`errorReport.unavailable`）
- 作業中のタスクでも求められる。
  タスクの状態・工程・承認済みの内容は変えない。
- オーケストレーターに使う AI（`step_agents.orchestrator` か `default_agent`。利用制限中なら代わりのエージェント）で、質問への答えと同じく、オーケストレーターのセッションの複製で実行する（役割は `chat`。[タスクと工程](tasks-and-steps.md#オーケストレーターに質問)）。
- 渡すもの
  - エラーレポート（分析の節を除いたもの）の先頭 40,000 バイト（`ERROR_ANALYSIS_REPORT_IN_PROMPT`）
  - 各実行のセッションログ（質問への答えと同じく、読み取り専用で `/sacty-logs` に置く）と、同じ場所のレポートの全体（`error-report.md`）
  - 用意済みのタスクは、対象リポジトリの起点のコードの使い捨ての写し
- 指示：何が起きたか・原因の推定・根拠・次にすることの見出しで、2,000 字程度にまとめさせる。
  推測と事実を分け、事実には根拠（記録・実行の ID・ログの行）を添えさせる。
  計画は変えさせず、秘密情報を書かせない。
- 結果は `ErrorAnalyzed` に記録する（actor は `orchestrator`）。
  分析の本文は秘密情報を取り除いてから 20,000 字（`ERROR_ANALYSIS_MAX`）までに切り詰める。
  分析できなかった（実行の失敗・空の答え・中止で止めた）ときは、理由（`failed`）と実行の結果（`runResult`）を記録する。
- 費用はタスクの予算に入る（工程ごとの費用の表では「エラーの分析」）。
- 中止すると、分析の実行を止め、止めたことと費用を記録してから中止する。

コード: `apps/daemon/src/service.ts`（`analyzeErrors`・`runErrorAnalysis`）、`apps/daemon/src/prompts.ts`（`buildErrorAnalysisPrompt`・`ERROR_REPORT_FILE`）、`packages/core/src/projection.ts`（`pendingErrorAnalysis`・`errorAnalysisBlocked`・`TaskErrorAnalysis`）、`packages/core/src/events.ts`（`ERROR_ANALYSIS_MAX`）

## 画面

- タスクの詳細の右の列に、エラーの記録があるか、前に分析させたタスクだけ「エラーレポート」の欄を出す（`showErrorReport`）。
  見出しの横にエラーの記録の件数を出す。
- 「レポートをダウンロード」は `/tasks/<ID>/error-report` を開き、画面の言語のレポートを `sacty-error-report-<タスクの短い ID>-<日時>.md` としてダウンロードさせる。
  デーモンに届かなければ 503、タスクが無ければ 404。
- 「オーケストレーターに分析させる」（分析した後は「分析し直す」）で分析を求める。
  分析中は押せず、「分析しています…」を出す。
  分析できたら時刻を、できなかったら理由を出す。
  求められない理由があれば、その理由を出す。
- 分析の結果は、次にダウンロードするレポートに入る（画面には本文を出さない）。

コード: `apps/web/src/components/error-report.tsx`（`ErrorReportCard`・`showErrorReport`）、`apps/web/src/app/tasks/[id]/error-report/route.ts`、`apps/web/src/lib/paths.ts`（`errorReportPath`・`errorReportFileName`）、`apps/web/src/app/actions.ts`（`analyzeErrorsAction`）
