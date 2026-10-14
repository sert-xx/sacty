# sacty のアイコンを作り、Slack の通知の送り手（名前 Sacty・icon_url）と画面のアイコンにする

- 日付: 2026-10-13（UTC）
- タスク: PBI-68
- PR: #74
- ブランチ: feat/issue-68-slack-sender
- 関係する ADR: [sacty のアイコンを作り、Slack の通知の送り手（名前 Sacty・icon_url）と画面のアイコンに使う](../adr/20261014-0029-slack-sender-icon.md)

## 目的

sacty のアイコンを作り、Slack の通知の送り手（名前とアイコン）と、画面のファビコン・ヘッダーのマークに使う。

## したこと

- アイコン：`assets/sacty-icon.svg`・`assets/sacty-icon.png`（512×512）。SVG に title を付けた。
- Slack：`apps/daemon/src/notifier.ts` で、chat.postMessage の本文に `username: "Sacty"` と `icon_url`（main の `assets/sacty-icon.png`）を付けた。
  最初は絵文字のアイコン（`:factory:`）にしたが、作ったアイコンの `icon_url` に変え、`icon_emoji` は使わない。Incoming Webhook は変えていない。
- 画面：`apps/web/src/app/favicon.ico`（16・32・48px）・`icon.svg`・`apple-icon.png`（180px）を差し替え、`apps/web/src/components/shell/sacty-mark.tsx`（新規）の
  マークを `header.tsx` の「sacty」の左に置いた。
- `README.md`：送り手の名前とアイコン、`chat:write.customize` の権限が無いと指定が無視されること。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npx vitest run`（735件）・`npm run build`：通った。
- 通知のテストで、本文に username と icon_url が入り、icon_emoji が入らないことを確かめた（外すと落ちる）。
- 画面（明るい・暗い表示）で、ヘッダーのマークとファビコン・ホーム画面用のアイコンが登録されていることを確かめた。
- レビューの検証：通知のテスト7件・lint・typecheck・diff --check が通り、PNG を目視して 512×512・180×180・ICO の 16/32/48px を確かめた。
- 確かめなかったこと：実際の Slack への送信。`icon_url` の画像は main にマージされてから表示される。レビューでは全体のテスト・ブラウザの表示も行っていない。

## レビューの指摘と対応

指摘は無かった（PASS）。

## 残したこと

- 実際の Slack への送信での表示の確認。
- アイコンの商標の調査はしていない。
