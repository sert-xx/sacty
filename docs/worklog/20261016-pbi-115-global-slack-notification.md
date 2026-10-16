# Slack の通知の設定を、プロジェクトの設定から sacty の設定に移す

- 日付: 2026-10-16（UTC）
- タスク: PBI-115
- PR: #125
- ブランチ: feat/issue-115-global-slack-notification
- 関係する ADR: [Slack の通知先を、プロジェクトの設定から sacty の設定に移し、すべてのプロジェクトの通知を1つの送り先に送る](../adr/20261016-0421-slack-notification-in-sacty-settings.md)

## 目的

Slack の通知を、プロジェクトごとではなく、すべてのプロジェクトに共通の「sacty の設定」で1か所に設定する。破壊的な変更で、
既存のデータの移行と互換の層は作らない（ステークホルダーの了承済み）。作業の途中で、通知の本文に工程の名前を入れることが
受け入れ条件に足された。

## したこと

- core
  - `ProjectNotification` を `SlackNotification` に名前を変え、`SactySettings` の `notification` に移した。`ProjectDefinition` から外した
    （古いデータの `notification` は、zod の検査で捨てる）。
  - エクスポートの版を 5 に上げ、`ExportNotification`・`withoutMention` を消した。版 3・4 は `input.exportVersionWithNotification` で断る
    （`input.exportVersionWithMentions` は消した）。
  - `notify.failed` の引数から `project` を外した。`notify.notConfigured` の文を sacty の設定に合わせた。
    `secret.settingsSavePrefetchFailed` を足した。
- デーモン
  - `SlackNotifier` は、通知先を sacty の設定から（通知のたびに）読む。本文の題名の前に `[プロジェクトの名前]` を付ける。送れなかった理由は
    1つだけ持つ。設定を読めないときは、送らずに理由を持つ。通知先を外したら、前の理由を出さない。
  - 本文に工程の名前を入れた。承認待ちは `gate.step`、エスカレーションは `escalation.step`、一時停止は `activeStep`。工程が無い一時停止は
    「工程を決める前に」、完了には入れない。
  - テストの通知を `POST /api/settings/notification-test` にした（プロジェクトの API は消した）。
  - `secretUses` は sacty の設定から通知先の参照を取る（`settingsSecretUses`）。`projectSecretUses` は消した。
    `PUT /api/settings` の後に `prefetchSettingsSecrets` で取り出し、警告の世代を sacty の設定の範囲で分けた。
- 画面
  - 通知の区画を `NotificationSettings` に切り出し、sacty の設定のフォームに置いた（入力は JSON の hidden で渡す）。プロジェクトの設定から外した。
  - 文言を projects から settings に移した。エクスポート・インポート・秘密情報の説明を直した。
- docs：仕様書（notifications・export・secrets・architecture）、利用者向けの文書（notifications・project-settings・secrets・config・
  troubleshooting・目次）を日英で直した。ADR を足し、PBI-38 と PBI-103 の ADR を superseded にした（名前の変更で切れた作業履歴のリンクも直した）。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npm run build`・`npx vitest run`（86 ファイル・1754 テスト）・`npx vitest run tests/docs` が通った。
  - 1回だけ、PBI-107 の「上限の時間を過ぎたら、取得の git の子プロセスを止め…」が落ちた。単独で2回流すと通り、もう一度全体を流しても通った
    （時間に頼るテストで、この変更とは関係しない）。
- 回帰テスト：修正したソース（core の projects・messages、daemon の notifier・secret-uses・service・server、web の project-editor・
  settings-form・actions）を origin/main の版に戻すと、足した・直したテストが 38 件落ちた。戻した後に元に戻し、すべて通ることを確かめた。
- 動作確認の動画：自分のブランチを、ポート 4800/4810・一時的な SACTY_HOME で起動した。AI はスタブ（`design-only` の工程）、Slack は手元の
  偽のサーバー（4790）。2つのプロジェクトの対象は自分のリポジトリにし、タスクはリポジトリ無しで作った（対象には触れない）。
  - 届いた本文：テストの通知（メンションつき）、`[決済チーム] … 要求要件の承認を待っています`、`[検索チーム] … 要求要件の承認を待っています`、
    承認の後の `[決済チーム] … 設計の承認を待っています`。

## レビューの指摘と対応

- セルフレビュー（DA）
  - 取り残し：`git grep` で `ProjectNotification`・`exportVersionWithMentions`・`projectSecretUses`・`withoutMention`・
    `notification-test` を探し、コードと仕様書・利用者向けの文書に残っていないことを確かめた（過去の ADR・作業履歴は直さない）。
  - 古いデータ：通知先を持つプロジェクトの行を SQLite に置いて、読める・画面の API が 200・エクスポートに出ない・その通知先に送らないことを
    テストにした。壊れた `notification`（文字列・null・知らない種類）も捨てることを確かめた。
  - 秘密情報：送れなかった理由・ログ・状態の API・台帳にトークンが出ないことをテストにした。
  - 送れなかった警告：通知先を外しても前の理由が残る点を見つけ、`problems()` で通知先が無ければ出さないようにした。
    利用者向けの文書は「画面の警告」と書いていたが、出るのはタスクの一覧の画面だけなので、そう直した。
  - エクスポートの版：版 3・4・5・それ以外の扱いをテストにした。

- PO の DA（PR #125）：送れなかった警告がプロジェクトのタスクの一覧の画面にしか出ず、最初の画面のダッシュボードを見ていると見落とす（FAIL）。
  - ダッシュボード（欄の上。sacty の設定へのリンクつき。取り直しで出る・消える）と、sacty の設定の通知の区画にも出すようにした。
    タスクの一覧には出し続ける。デーモンの警告から `notify.failed` だけを選ぶ処理は `notificationProblems` にまとめた。
  - テストの通知の後に画面を描き直し（`refresh`）、sacty の設定の画面の警告を今の状態にする。
  - 回帰テスト：ダッシュボードのデータ・表示（取り直し）と、sacty の設定の表示。修正（dashboard・dashboard-data・notification-settings・
    settings-form）を戻すと4件落ち、元に戻すと通ることを確かめた。
  - 利用者向けの文書（通知・トラブルシューティング・はじめに）と仕様書（notifications・architecture）の「どこに出るか」を日英で直した。
  - ダッシュボードと sacty の設定に警告が出るところを、偽の送り先を落とした状態でスクリーンショットに撮った。

- PR #125 のレビュー（要修正1・提案3）
  - 要修正：`notify()` で、プロジェクトの名前を取る処理が例外処理の外にあり、DB の読み込みの誤りなどで同期的に例外を出し、書き終えた
    タスクの操作が API で失敗に見えた。名前の取得と本文の組み立ても例外処理の中に入れ、送れなかった理由として持つようにした。
    念のため、サービスの側でも通知の例外を捕まえる。
  - 提案：共通の `failure` で、並行した送信や送り先を変えた前後の結果の順が入れ替わる。送り始めた順の番号と送り先を記録し、後に始めた
    送信の結果を上書きしない・送り先が変わった後の古い結果を反映しない・今の送り先と違う理由は出さない、ようにした。
  - 提案：URL などの欄の `min-w-72` で、幅 320px の画面で設定の画面が横にはみ出す。狭い幅では `w-full min-w-0`、`sm` 以上だけ最小の幅を付けた。
    選ぶ欄にも `max-w-full` を付けた。
  - 提案：送り先が共通になると、見る人の範囲が違うプロジェクトの通知も同じチャンネルに流れる。設定の画面の説明と利用者向けの文書（日英）に、
    設定する前に見る人の範囲を確かめるよう書いた。
  - 回帰テスト：notify の例外・送り先の変更・並行の順（notifier）、サービスの操作が成功として返ること（daemon）、見る人の範囲の文言と
    狭い幅のクラス（settings-form）。修正（notifier・service・notification-settings・settings の文言）を戻すと6件落ち、元に戻すと通った。
  - 幅 320px と通常の幅の sacty の設定の画面を、スクリーンショットに撮った。

- PR #125 の再レビュー（提案2）
  - 送り先を A（失敗を記録）→ B → A と戻すと、送り先の比較がまた一致し、変える前の失敗が出る。sacty の設定の保存で通知先が変わったら
    `settingsChanged` で失敗を捨て、それまでに始めた送信の結果も反映しないようにした。回帰テスト：notifier（A → B → A・未設定を
    挟む・保留中の古い送信）と daemon（API で保存して戻す・通知先を変えない保存では捨てない）。修正を戻すと落ちることを確かめた。
  - 利用者向けの文書と設定の画面の注意で「工程が入る」と言い切っていたのを、「通知の種類によっては工程の名前も入る」に直した（日英）。

## 残したこと

- sacty の設定の画面の警告は、自動では取り直さない（設定の画面は自動で描き直さない方針。開き直すか、テストの通知を送ると今の状態になる）。
- プロジェクトの DB の行に残った古い `notification` は、読むときに捨てるだけで、行からは消していない（保存し直すと消える）。
