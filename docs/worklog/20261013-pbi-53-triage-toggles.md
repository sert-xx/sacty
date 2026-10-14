# 自動のトリアージを、種類ごとに sacty の設定で On/Off する

- 日付: 2026-10-13（UTC）
- タスク: PBI-53
- PR: #61
- ブランチ: feat/issue-53-triage-toggles
- 関係する ADR: [自動のトリアージを種類ごとに sacty の設定で On/Off し、設定には Off にした種類だけを持つ](../adr/20261013-0710-triage-toggles-per-kind.md)

## 目的

自動のトリアージ（取り込み）を、ラベルなどの設定を残したまま、種類ごとに「sacty の設定」から On/Off できるようにする。

## したこと

- 設定（`packages/core/src/projects.ts`）：Off にした種類の一覧 `triageOff` を足した。項目の無い設定はすべて On。
- 取り込み（`apps/daemon/src/service.ts`）：Off の種類は GitHub に問い合わせない（Issue だけ Off なら `is:pr`、PR だけ Off なら
  `is:issue` を付けて探し、両方 Off なら探さない。レビュー用のラベルを Off にするとその検索をしない）。検索の後に設定を変えても
  Off の種類は取り込まない。設定を変えたら読んだ位置を忘れて読み直す。
- 画面（`apps/web/src/components/settings-form.tsx`・`apps/web/src/app/projects/page.tsx` ほか）：「sacty の設定」に種類ごとの
  チェックボックスを置き、プロジェクトの一覧の「取り込み」の欄に Off にした種類を出す。

## 確かめたこと

- build・typecheck・lint・全テスト（527 件）が通った。
- 足したテスト：これまでの設定はすべて On、Issue だけ・PR だけ・両方とレビュー用のラベルを Off にしたときの検索と取り込み、
  ラベルが残ること、すべて On に戻すと項目を持たないこと、知らない種類は拒否、設定の版が変わること。
- 主な判定を戻すと、テストが失敗することを確かめた（4 通り）。
- 画面は、一時的なデータの環境で動画で確かめた（「取り込めなかった対象」が出るのは、デモ環境で GitHub のアカウントを選んで
  いないため）。
- レビューでは、`triageOff` の全 8 通りを SQLite に保存・再読込し、On/Off の状態と既存のラベル・reviewRequested が保たれることも
  確かめた。実際の GitHub への検索・取り込みとブラウザの画面操作は、レビューでは未検証。

## レビューの指摘と対応

指摘は無かった（PASS のみ）。

## 残したこと

- JIRA のトリアージ（PBI-52）の On/Off は、同じ形で PBI-52 で足す。
