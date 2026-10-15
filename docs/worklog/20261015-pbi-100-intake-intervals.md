# 取り込みの間隔を、取り込みの種類ごとに sacty の設定の画面で決められるようにする

- 日付: 2026-10-15（UTC）
- タスク: PBI-100
- PR: #109
- ブランチ: feat/issue-100-intake-intervals
- 関係する ADR: [取り込みの間隔を、取り込みの種類ごとに sacty の設定に持つ](../adr/20261015-0310-intake-intervals-per-kind.md)

## 目的

取り込みの間隔は `config.yaml` の `github.poll_interval_sec` だけで、すべての取り込みに共通だった。`github:` が無いと JIRA のチケットも
取り込まれず、画面からは変えられなかった。Issue の取り込み・PR のレビューの取り込み・チケットの取り込みの種類ごとに、画面で間隔を決め、
種類ごとに独立して取り込むようにする。互換の処理は作らない（ステークホルダーと合意）。

## したこと

- 設定（`packages/core/src/projects.ts`）：`IntakeKind`・`DEFAULT_INTAKE_INTERVAL_SEC`（300）・`MIN_INTAKE_INTERVAL_SEC`（60）・
  `intakeIntervalSec` を足し、`SactySettings` に `issueIntervalSec`・`reviewIntervalSec`・`ticketIntervalSec` を足した。画面の文字列と空も
  受け付ける。誤りは、画面の3つの欄が同じ名前なので、どの種類かがわかる文言のコード（`input.issueIntervalInvalid` など）にした。
- 取り込み（`apps/daemon/src/intake.ts`）：種類ごとの状態（最後に始めた時刻・実行中の取り込み・読んだ位置・プロジェクトの版）を持ち、
  `tick` で間隔が来た種類を並行に取り込む。`runOnce` を `runGitHub`（Issue と PR のレビューを、取り込み元の `review` の有無で分ける）と
  `runTickets` に分けた。思わぬ失敗は、その種類の失敗として記録する。
- 状況（`apps/daemon/src/service.ts`）：`IntakeStatus` の直近の取り込みを種類ごとの `runs` にし、`recordIntake(kind, run)` にした。
  `config.yaml` を読めれば `intake` を返す。
- `config.yaml`（`apps/daemon/src/config.ts`）：`github` の項目・型・雛形を消した。書いてあっても読まない（知らない項目の扱いのまま）。
- 画面（`apps/web`）：設定の画面の3つの区画に間隔の欄、フォームを `noValidate`（誤りは画面の言語の文で出す）。プロジェクトの画面に
  種類ごとの最後の取り込み（`apps/web/src/lib/intake.ts` の `intakeRuns`。On で設定のある種類だけ）。文言は日本語・英語。
- docs：仕様書（intake・configuration・architecture）、ユーザードキュメント（intake・config・troubleshooting）を直した。ADR を足し、
  gh のアカウントの ADR を一部置き換え（`superseded`）にしてリンクを直した。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（63 ファイル・1447 件）・`npm run build`・
  `npx vitest run tests/docs`（69 件）。main（PR #105）を取り込んだ後にも通した。
- 修正を戻すと落ちること：
  - `intake.ts` を PBI-99 の版に戻すと、`github:` が無いので取り込みのテスト 19 件が落ちる。`github:` の条件だけ外した旧実装でも、
    種類ごとの間隔・設定の反映・種類をまたぐレート制限・失敗と遅れの独立のテスト 4 件が落ちる。
  - `noValidate`・間隔の送信・Off の種類を出さない処理を戻すと、web のテストが 3 件落ちる。
- 動作確認の動画：一時的な SACTY_HOME（`github: poll_interval_sec: 120` を書いた `config.yaml`）・偽の gh / docker・別のポートで起動し、
  30 秒・90.5 秒の誤り（日本語）、正しい値の保存と再読み込み、プロジェクトの画面の種類ごとの最後の取り込みと「今すぐ取り込む」、
  59 秒の誤り（英語）を録画した。
- 確かめていないこと：本物の GitHub・JIRA での取り込み。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （自己レビュー）ブラウザの `min` の検査で止まり、画面の言語の文に届かない | フォームを `noValidate` にし、デーモンの文言で出す |
| （自己レビュー）3つの欄が同じ名前なので、下限の文言ではどの欄の誤りかわからない | 種類ごとの文言のコードにした |
| （自己レビュー）プロジェクトの版の取得が失敗すると、その種類の記録が残らない | 取り込みの `try` の中に移した |

## 残したこと

- なし
