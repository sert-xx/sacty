# 最近のロジック・画面の変更に遅れた仕様書・ユーザードキュメント・図・スクリーンショットを直す

- 日付: 2026-10-29（UTC）
- タスク: なし
- PR: #253
- ブランチ: claude/wonderful-curie-kvgkn6
- 関係する ADR: なし（方針は変えず、実装に合わせて直しただけ）

## 目的

ここ2週間ほどの変更（#206 情報収集・#221 スケジュールタスク・#232 セキュリティ・#239 ドラフトの PR・#241 作成時の工程の設定・
#243 再開の補足と工程の設定・#248 差し戻しと一緒の工程の設定・#250 タスクの詳細）のあと、`docs/spec/`・`docs/user/`（日英）・図・
スクリーンショットが今の実装と食い違っていないかを確かめ、食い違いを直す。実装の振る舞いは変えない。

## したこと

- 確かめ方：
  - 本文：仕様書とユーザードキュメントを4つに分け、書かれた振る舞い・既定値・画面の文言・「コード:」の参照をコードと1つずつ照らした。
  - 図：`tests/docs` で SVG が定義と一致することを確かめたうえで、定義の中身（状態・経路・ラベル）を実装と照らした。
  - スクリーンショット：`docs:screenshots` で全部を一時のディレクトリに撮り直し、今の画像と画素で比べ、差のある所を目で見た。
- スクリーンショット：画面が変わっていた `task-list`・`audit`（サイドメニューの「スケジュール」）、`project-settings`（同じく、対象ごとの
  「イメージ」）、`context-preview`（既定のスキル `classify-provenance`）を日英で差し替えた。ほかは日時と「今日」の費用だけの差なので差し替えていない。
- 図：
  - `tasks-flow`：タスクの作られ方、承認ゲートの無い工程の例
  - `overview`：情報収集のエージェント、JIRA の取り込み
  - `deployment-state`：`no_commit` で飛ばす経路
- 本文（矛盾していた所）：
  - プロジェクトの削除でスケジュールタスクも消える（project-settings・architecture）
  - スケジュールタスクでは工程ごとのイメージ・エージェントを指定できない（scheduled-tasks）
  - イベントの種類は 93、費用の表の行の順の先頭に情報収集（event-log）
  - プロジェクトの対象のイメージは、作成時に人が指定した工程を除く（images）
  - マージの後の監視を使う進め方に直接実装・セキュリティ対応（user/deployment-watch）
  - タスクの詳細のプロパティ・「テスト」の補足・イメージの選んだ元（tasks・tasks-and-steps）
  - テストを実行するエージェントに PR のレビュー（agent-execution）
  - 起動のときに取り出す秘密情報に `audit_agent` と代わりのエージェント（secrets）
- 本文（書かれていなかったこと）：
  - 再開・差し戻しでの工程の設定と、人の指定が `step_agents` より優先すること（tasks-and-steps・configuration・config・deployment-watch）
  - approval（`#proposals` への案内、PR の確認の対象と後に呼ぶ処理）
  - architecture（API と画面のデータの取り直しの表）
  - dashboard（PR の承認待ちは GitHub を開く、Slack の通知の警告）
  - memory・intake・ui-wording（情報収集にメモリーを渡さない、JIRA の PR の URL のコメント、補足つきの再開の詳細）
  - tasks-and-steps の作られ方の表に `audit`（監査の改修の提案）
- コードのコメント：`CONFIG_TEMPLATE`（`update_check` は最新のリリースと比べる、`run_timeout.roles` の例に `gather`）、
  `checkDeployment`（作成時・再開・差し戻しでの指定）。

## 確かめたこと

- `npx vitest run tests/docs`：93 件すべて通過
- `node scripts/docs-diagrams/build.mjs --check`：古い SVG は 0 件。幅の警告が2件（`memory-promotion.en`・`audit-flow.en`）出るが、この PR の前から出ていたもの
- `npx vitest run apps/daemon/src/agents/agents.test.ts`：通過
- `npx biome check`（変えたコードと図の定義）：指摘なし
- スクリーンショットは、この環境の Chromium（`/opt/pw-browsers/chromium`）を使うように一時的に変えた写しの撮影スクリプトで撮った（写しは消した）

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

- 図の幅の警告2件（上の確かめたこと）は、この PR の範囲の外なので直していない。
