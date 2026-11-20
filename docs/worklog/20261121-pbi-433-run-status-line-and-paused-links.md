# 実行している間と止まったときの様子と次の一手を、タスクの概要で分かるようにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-433
- PR: なし
- ブランチ: なし
- 関係する ADR: なし

## 目的

タスクを待っている人が、概要を見るだけで、動いているか・いま何の段階か・何分たったか・どこを見ればよいかを分かるようにする。止まったときは、一時停止のカードから原因を調べに行けるようにする。

## したこと

- `apps/web/src/components/run-status.tsx`・`apps/web/src/lib/run-status.ts`：概要の成果物のすぐ上に、実行中の工程の名前・経過・「ログを見る」の 1 行を出す。最初の工程の前は、していることの名前だけ。経過は 60 秒ごとの画面の時計で進め、`aria-live` に入れない。
- `apps/web/src/components/resume-form.tsx`・`error-report.tsx`：一時停止のカードに「エラーレポートを見る」（`#error-report`。固定の見出しに隠れない余白を付けた）と「止まった実行のログを見る」を足した。
- `apps/web/src/components/run-log.tsx`・`lib/run-log-data.ts`・live のルート：ログの画面の「終了」に、タスクがその実行を今も実行中なら「実行中」を出す（`running` を、画面のデータ・取り直しの応答・版に足した）。
- `apps/web/src/components/implementation.tsx`：一時停止中の実装の欄の見出しの横を「一時停止中」にした。
- 文言は日英（`task.ts`・`parts.ts`・`run-log.ts`）。`docs/spec/tasks-and-steps`・`docs/user/tasks`（日英）を直した。

## 決めたこと

- 経過の書式は、ダッシュボードの `durationText`（単位が 1 つ）とは別の関数にした（「1時間5分」を出すため。ダッシュボードの表示は変えない）。
- 止まった実行は、最後の `TaskPaused` の直前の `AgentRunFailed` だけをつなぐ。人が手で止めたとき（`manual`）は、止めた実行へもつながない。
- 最初の工程の前は、開始の時刻・実行の ID が画面に無いので、名前だけにした（デーモンの API は変えていない）。

## 確かめたこと

- `apps/web/src/components/run-status.test.ts`・`live-other-screens.test.ts`：実行中（経過あり・開始の時刻なし）・最初の工程の前・実行待ち・承認待ち・一時停止・完了などの行の出し分け、経過の書式の境界、一時停止のリンクの出し分け、ログの画面の「終了」の 3 通り。
- スクリーンショット（`docs/user/images/`）は、この環境にブラウザが無く、撮り直していない。配色・375px の幅での見え方は、実画面で確かめていない（行は折り返す flex で、枠の中に収めている）。
