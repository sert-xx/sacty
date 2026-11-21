# 「設定」を呼び分け、「Sacty の設定」の入口を足し、保存していない変更に気づけるようにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-449
- PR: なし
- ブランチ: sacty/task-pbi-449
- 関係する ADR: [設定の画面は、保存していない変更を送る値の写しで見張り、離れるときに確かめる](../adr/20261121-1800-settings-unsaved-changes-guard.md)

## 目的

初めての人が、全体の設定（Sacty の設定）とプロジェクトの設定を取り違えないこと。変えた設定を、保存しないまま失わないこと。

## したこと

- サイドメニュー（`shell/rail.tsx`）：下の端に「Sacty の設定」（`/settings`）を足した。プロジェクトの画面の「設定」は「プロジェクトの設定」、「すべてのプロジェクト」の画面では「プロジェクト」（`/projects`）と出す。英語も呼び分ける。「Sacty の設定」は `/settings` のときだけ強調する。人のアイコンのメニューの項目は残した。
- 狭い幅（640px 未満）：5 項目が 320px でも収まるよう、項目の間の余白と左右の余白を詰めた。名称は幅の無い空白の所で折り返す。
- 見出し・タイトル：プロジェクトの設定の見出しを「プロジェクト「<名前>」の設定」（英語は `Project "<name>" settings`）にし、`generateMetadata` で同じ文言をタイトルにした。
- 保存していない変更：`lib/unsaved-changes.tsx`（登録・`beforeunload`・Link の確認）、`shell/guarded-link.tsx`、`save-bar.tsx`（画面の下に固定した「保存する」の帯）を足し、`SettingsForm` と `ProjectEditor`（`project` があるとき）に使った。
- 文書：`docs/user` の 3 つ（日英）と、`docs/spec/architecture.md`（日英）を直した。

## 確かめたこと

- `shell/links.test.ts`：項目・名称・強調（日英）と、人のアイコンのメニュー。
- `shell/rail.browser.test.ts`・`save-bar.browser.test.ts`：実際のブラウザーで、幅 320px・375px の 5 項目（44px 以上・重ならない・はみ出さない）と、「保存する」が下に見えてメニューに隠れないこと。
- `unsaved-changes.test.ts`：2 つの設定の画面で、表示・確認・元に戻す・保存の成功と失敗。対象にしないもの。
- `app/projects/[id]/settings/page.test.ts`：見出しとタイトル。

## 残したこと

- 実機でのスクリーンショット・ブラウザーの戻る・進む（確認しない）。
