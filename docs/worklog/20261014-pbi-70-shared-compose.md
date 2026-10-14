# プロジェクト共用の docker compose を設定し、要るタスクだけで取得・起動する

- 日付: 2026-10-14（UTC）
- タスク: PBI-70
- PR: #78
- ブランチ: feat/issue-70-shared-compose
- 関係する ADR: [プロジェクト共用の docker compose を設定に書けるようにし、オーケストレーターが要ると判断したタスクだけで実行ごとに取得・起動する](../adr/20261014-0137-shared-compose.md)

## 目的

チームで共用する別のリポジトリの compose を、プロジェクトの設定に複数書けるようにする。設定しただけでは起動せず、オーケストレーターが名前で選んだ
タスクだけで、実行の前に取得してタスク専用のプロジェクト名で起動し、後で消す（並行でぶつからない）。安全の確かめと相対のマウント・サービス名と
localhost での接続・private のリポジトリの認証（値を出さない）・失敗の表示を備え、設定していないプロジェクトの動作は変えない。

## したこと

- 設定：`packages/core/src/projects.ts` に共用の compose（名前の重複・不正な形・URL の認証の値は保存できない）。画面 `apps/web/src/components/project-editor.tsx`
  と文言、エクスポート・インポート。
- 選択：`apps/daemon/src/prompts.ts` でオーケストレーターに名前・ファイル・説明を渡し、`extractStepPlan` が `services.compose` と `servicesReason` を読む。
  `packages/core/src/events.ts` の `StepsChosen` に名前・リポジトリ・ref・ファイルを記録し、`apps/web/src/lib/labels.ts` で作業履歴に出す。
- 取得：`apps/daemon/src/shared-compose.ts`（新規）でキャッシュの更新・実行ごとの書き出し・直列化。認証は `gitAuth`、失敗の出力は伏せてから切り詰める。
- 起動：`apps/daemon/src/services.ts`・`service.ts` で、既存の安全の確かめ・転送を使い、`container_name` を別名にする。失敗の文言（`services.sharedFetchFailed`・
  `sharedMissing`・`sharedUnsafe`・`sharedFailed`・`sharedUnknown`）を ja・en で出して工程を止める。
- レビューの対応：取得の後・起動の後に一時停止・中止を確かめ、起動の待ちを `ServiceRunner.abort` で打ち切る。テストの前の起動の待ちで止めたときは
  サービスの失敗として記録しない。output-relay の fallocate のテストと本物の git を使う取得のテストのタイムアウトを30秒にした。
- `README.md`：共用の compose の説明。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（775 件）・`npm run build`：通った。
- 修正を戻すとテストが落ちることを10通りで確かめた（取得の直列化・伏せる順番（2か所）・使わないのに起動・実行ごとのディレクトリの削除・ファイルが無いときの
  確かめ・設定に無い名前・別名・URL の認証の値・プロンプトへの記載）。
- 実際の Docker：redis だけを持つローカルの git リポジトリ（`container_name`・ホストのポート・`./conf` のマウント・healthcheck あり）で、2つの実行を並行して
  取得・起動した。2つとも healthy で起動し（約1.9秒）、固定の名前・同じホストのポートでもぶつからなかった。それぞれのネットワークから `redis` と別名の両方で
  接続でき、マウントした設定が効いていた。`/etc` のマウントは `services.sharedUnsafe`、無いファイルは `services.sharedMissing` で止まった。停止の後、コンテナ・
  ネットワーク・実行ごとのディレクトリは残らなかった。
- 一時的な SACTY_HOME の画面で、設定の追加（URL にトークンを書くと保存できない）・再読み込み・使うタスクと使わないタスクの作業履歴の表示を録画した（動画は PR に添付していない）。
- レビューの対応の後：lint（終了コード 0）・typecheck・vitest（825件）・build が通った。修正を戻すとテストが落ちることも確かめた。
- 確かめなかったこと：private のリポジトリの実際の認証（開発した環境からはアクセスできない）。レビューでは実際の Docker・ブラウザの操作も行っていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| [P2] 一時停止の要求を取得の前にしか確かめていないので、取得の待ちの間に止めても、取得の後にサービスを起動し、`up --wait` の待ち（最大300秒）まで停止が遅れる | 取得の後と起動の後にも一時停止・中止を確かめ、止めるときは取得したディレクトリを片付け、起動していれば止めて消し、人が止めたとして工程を終えるようにした。起動の待ちの間も止める対象にし、`ServiceRunner.abort(runId)` で docker compose を打ち切って `down -v` で消す。同じ種類の漏れとして、テストの前の起動の待ちで止めたときにサービスの失敗として記録していたのも直した。回帰テストを6件足し、修正を戻すと落ちることを確かめた |

再レビューで、指摘の解消が確かめられた（追加の指摘は無し）。

## 残したこと

- private の共用の compose のリポジトリでの確認は、アクセスできる別の PC で行う（手順は PR に書いた：設定・アカウントの選択・使う／使わないタスクの作業履歴・
  起動と healthy・並行・`container_name` の別名・取得の失敗とファイルの誤りの表示で、トークンが表示・作業履歴・ログに出ないこと）。
- 取得そのもの（git fetch）は打ち切らず、終わってから起動を見送る。
