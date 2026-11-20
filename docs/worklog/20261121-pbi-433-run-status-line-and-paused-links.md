# 実行している間と止まったときの様子と次の一手を、タスクの概要で分かるようにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-433
- PR: なし
- ブランチ: なし
- 関係する ADR: なし

## 目的

タスクを待っている人が、概要を見るだけで、動いているか・いま何の段階か・何分たったか・どこを見ればよいかを分かるようにする。止まったときは、一時停止のカードから原因を調べに行けるようにする。

## したこと

- `apps/web/src/components/run-status.tsx`・`apps/web/src/lib/run-status.ts`：概要の成果物のすぐ上に、実行中の工程の名前・経過・「ログを見る」の 1 行を出す。最初の工程の前は、していることの名前だけ。経過は、実行の開始から数えた分の境目で進む画面の時計（`lib/use-clock.ts`。ダッシュボードの時計と共通）で進め、`aria-live` に入れない。
- `apps/web/src/components/resume-form.tsx`・`error-report.tsx`：一時停止のカードに「エラーレポートを見る」（`#error-report`。固定の見出しに隠れない余白は、移動先の見出し（`id="error-report"`）に付けた）と「止まった実行のログを見る」を足した。
- `apps/web/src/components/run-log.tsx`・`lib/run-log-data.ts`・live のルート：ログの画面の「終了」に、タスクがその実行を今も実行中なら「実行中」を出す（`running` を、画面のデータ・取り直しの応答・版に足した）。
- `apps/web/src/components/implementation.tsx`：一時停止中の実装の欄の見出しの横を「一時停止中」にした。
- 文言は日英（`task.ts`・`parts.ts`・`run-log.ts`）。`docs/spec/tasks-and-steps`・`docs/user/tasks`（日英）を直した。

## 決めたこと

- 経過の書式は、ダッシュボードの `durationText`（単位が 1 つ）とは別の関数にした（「1時間5分」を出すため。ダッシュボードの表示は変えない）。
- 止まった実行は、最後の `TaskPaused` からさかのぼって、ログを開ける実行のエラーの失敗（`AgentRunFailed`・`OrchestratorFailed` など）だけをつなぐ。別の実行の行・再開・手での一時停止に当たったら止める。人が手で止めたとき（`manual`）は、止めた実行へもつながない。
- 最初の工程の前は、開始の時刻・実行の ID が画面に無いので、名前だけにした（デーモンの API は変えていない）。

## 確かめたこと

- `apps/web/src/components/run-status.test.ts`・`live-other-screens.test.ts`：実行中（経過あり・開始の時刻なし）・最初の工程の前・実行待ち・承認待ち・一時停止・完了などの行の出し分け、経過の書式の境界、一時停止のリンクの出し分け、ログの画面の「終了」の 3 通り。
- `npm run lint`：727 ファイルで指摘なし。`npm run typecheck`：通った。`npm run build`：通った。
- `npx vitest run`：全件が通った（下の結果は最後の変更の後のもの）。
- 足したテストを 1 つずつ外して（`continue`・`status` の条件・`queued` の条件・`errorReport &&`・起点の受け渡し・`clearInterval`・`.reverse()`）、落ちることを確かめた。
- スクリーンショット（`task-detail`・`task-paused`・`task-budget-paused` と英語版）は、`npm run docs:screenshots` の手順で撮り直した。一時停止のカードにリンクの行が写ることを、`task-paused.png` で見た。配色・375px の幅での見え方は、実画面で確かめていない（行は折り返す flex で、枠の中に収めている）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| エラーレポートへの移動先の余白が、`id` を持たない `section` に付いていた | 余白を `id="error-report"` の見出しに移し、テストもその要素を確かめる形にした |
| ログの画面のテストが、実行環境のタイムゾーンに依存する | 時刻を正午 UTC にして、日付が変わらないようにした |
| 止まった実行の探し方が `AgentRunFailed` だけ | `runLogId` と `failureKind` で探す形にし、`OrchestratorFailed` も拾う。続く一時停止の記録は越える |
| 打ち切りの分岐・`loadRunLog` の `running`・時計のテストが無い | 分岐ごとの履歴・`runningThis`/`loadRunLog`・`useClock`（進む・分の境目・止まる）のテストを足した |
| 時計がダッシュボードと重なり、分の境目と揃わない | `useClock` を共通にし、起点を渡すと分の境目で進める |
| 区切りと「経過：」が直書き | 日英の辞書に持たせた |
| 文書の「これまでの文」 | 実際に出る文を書いた |
| 仕様書の止まった実行の説明が `AgentRunFailed` だけ | 採る失敗・止める条件・続く一時停止を越えることの 3 点に書き直した（日英） |
| 1 つ外しても落ちない分岐が残る | `runningNow`・`preparingNow` の条件、実行を持たない記録の読み飛ばし、カード単体のリンクの出し分け、`RunStatusLine` の起点の受け渡し、時計の後始末のテストを足した |
| 利用者向け文書で、足した文が「そのため」を引き離す | 足した文を「そのため…」の後ろへ移した（日英） |
| 作業の記録に実行したコマンドと結果が無い | 「確かめたこと」に書いた |
| 画像が撮り直されていない | `task-detail`・`task-paused`・`task-budget-paused`（日英）を撮り直した |

## 人間の指摘への対応（実画面の確認の後）

- 移動先の見出しが、狭い幅で固定の見出しに隠れた：固定の見出しの実際の高さを測って CSS の変数（`--sticky-offset`）に入れ（`lib/use-sticky-offset.ts`）、`#error-report` の見出しの `scroll-margin-top` をその値にした。高さの追従と後始末のテストを足した。
- `incomplete`・`unchanged` で「止まった実行のログを見る」が出ない：この 2 つの理由のときだけ、直前に完了した実行（`AgentRunCompleted`）もつなぐ。ほかの理由・再開・手での一時停止をまたぐ場合はつながない。テストと日英の文書を直した。
- 画像の撮り直しは、指摘のとおり別の環境で行う。

## 残したこと

- 明暗の配色・375px の幅での実画面の確認（カードのリンクの折り返し・固定の見出しとの位置）：撮影の手順は広い幅・明るい配色だけを撮るため、確かめていない。
