# ブラウザのデスクトップ通知と、Slack の通知の On/Off を足す

- 日付: 2026-10-26（UTC）
- タスク: なし
- PR: #230
- ブランチ: ccr-6f352c3c-q0e1f4
- 関係する ADR: [ブラウザのデスクトップ通知を足し、Slack の通知は設定を残したまま止められるようにする](../adr/20261026-1315-desktop-notifications-and-notification-switches.md)

## 目的

- Slack の通知に加えて、ブラウザのデスクトップ通知でも人間の出番と完了を知らせる。
- Slack の通知とデスクトップ通知のそれぞれに On/Off を設ける。
  Slack の通知は、止めても送り先の設定を消さない。

## したこと

- Slack の On/Off
  - `packages/core/src/projects.ts`：`SlackNotification` に `off`（任意。`true` か無し）を足した。
  - `apps/daemon/src/notifier.ts`：`off` なら `notify` で送らず、`problems` も空にする。テストの通知は送る。
  - `apps/web/src/components/notification-settings.tsx`：送り方を選んでいるときに「Slack に通知する」のチェックボックスを出し、外したら `off: true` を付けて保存する。
- デスクトップ通知
  - `apps/daemon/src/notification-feed.ts`（新規）：最近の通知を番号つきでメモリーに持つ `NotificationFeed`。
  - `apps/daemon/src/service.ts`：通知するとき（`append`）に一覧にも足す。`notificationFeed` を足した。
  - `apps/daemon/src/server.ts`：`GET /api/notifications?after=<番号>`。
  - `apps/daemon/src/main.ts`：`NotificationFeed` を渡す。
  - `apps/web/src/app/live/notifications/route.ts`・`apps/web/src/lib/desktop-notifications-data.ts`（新規）：通知を、画面の言語の題名・本文・開く画面にして返す。
  - `apps/web/src/lib/desktop-notifications.ts`（新規）：ブラウザごとの On/Off、取り直しの状態の進め方（`advanceFeed`）、タブをまたいで1回だけ出す判断（`claimDesktopItem`）。
  - `apps/web/src/components/shell/desktop-notifications.tsx`（新規）：共通の外枠（`layout.tsx`）に置き、On で許可があるときだけ5秒ごとに取り直して通知を出す。押すとタスクを開く。
  - `apps/web/src/components/desktop-notification-settings.tsx`（新規）：sacty の設定の画面の「デスクトップ通知（このブラウザー）」。On にするときに許可を求める。テストの通知を出せる。
  - 文言：`apps/web/src/i18n/messages/settings.ts`・`shell.ts`（日英）。
- docs：仕様書（通知・アーキテクチャ・目次）、ユーザードキュメント（通知・目次・プロジェクトの設定のリンク）を日英で直し、ADR を足した。

## 確かめたこと

- `npm run lint`：問題なし。
- `npm run typecheck`：問題なし。
- `npm run build`：成功。
- `npx vitest run`：足したテスト（`notification-feed.test.ts`・`notifier.test.ts` の On/Off・`daemon.test.ts` の API・`desktop-notifications.test.ts`・`shell/desktop-notifications.test.ts`・`settings-form.test.ts`）は通った。
  - 失敗したのは `question-form.browser.test.ts`（Playwright のブラウザーの版がこの環境に無い）と、`agent-sessions`・`context-mcp`・`host-mcp-processes` の 8 件。
    変更の前の `main` でも同じ 8 件が失敗するので、作業した環境（コンテナ）によるもの。
- 画面で確かめた（`scripts/docs-screenshots` と同じ架空のデータで `sacty up` を起動し、Playwright の Chromium で操作。`Notification` は記録するだけの代わりに差し替え）。
  - 「Slack に通知する」を外して保存し、読み直しても Off のままで、Webhook の URL が残ること。
  - 「このブラウザーでデスクトップ通知を出す」を On にし、2つのタブで画面を開いたまま、一時停止していたタスクを再開すると、予算の上限でまた一時停止し、デスクトップ通知（題名がタスクの題名、本文が `[社内ポータル] 一時停止しました`）が1回だけ出ること。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 既読の確認と記録にタブの間の排他が無く、2つのタブが同じ通知を出せる | 確認・記録・通知を出すまでを Web Locks の中で行う（`withDesktopLock`）。2つのタブが同じ通知を受け取っても、排他の中で1回だけ出すテストを足した |
| 取り直しにブラウザー側の期限が無く、応答が来ないと止まる（Off → On でも再開しない） | 本文を読むまで10秒の期限で打ち切り、次の間隔で取り直す。On/Off の切り替えでは途中の取り直しを中断する。期限のテストを足した |
| 取り直しの途中で Off にすると、On に戻したときに Off の間の通知を出す | 世代の番号で、切り替える前に始めた取り直しの結果を捨て、切り替えたら最初の問い合わせからやり直す。遅れた応答のテストを足した |
| 拒否した後にサイトの設定で許可しても、画面を読み直すまで On にできない | 権限の変更（`navigator.permissions`）と、画面に戻ったとき（focus・visibilitychange）に読み直す。テストを足した |
| 通知ごとに `getTask` で作業履歴まで取る | 作業履歴を含まないタスクの一覧を一度だけ取る（`listTasks`）。テストを足した |

レビューの対応の後に、`npm run lint`・`npm run typecheck`・`npx vitest run apps/web …`（`question-form.browser.test.ts` を除いて通った）・`npx vitest run tests/docs` を実行した。
足したテストのうち、タブの排他・遅れた応答・期限の3件は、直す前のコンポーネントでは失敗することを確かめた。

## 残したこと

- 画面を閉じている間の通知（Web Push）はしていない（ADR の理由を参照）。
