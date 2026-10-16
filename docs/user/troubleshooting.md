<!-- 対応するコード: packages/cli/src/index.ts、apps/daemon/src/config.ts（loadConfig）、apps/daemon/src/instance-lock.ts、apps/daemon/src/intake.ts、apps/daemon/src/secrets.ts、apps/daemon/src/host-mcp.ts、apps/daemon/src/services.ts、apps/daemon/src/notifier.ts -->

**日本語** | [English](troubleshooting.en.md)

# 困ったとき

よくある止まり方と、確かめることをまとめています。

## 起動・設定

| 症状 | 確かめること |
| --- | --- |
| `sacty up` が、ほかの sacty が動いていると言って終わる | 同じ `SACTY_HOME` で sacty が動いています。表示された接続先と PID の sacty を止めるか、別の `SACTY_HOME` とポートで起動してください（[はじめに](getting-started.md#データの置き場所)） |
| `--port and --daemon-port must be different` で終わる | `--port` と `--daemon-port` に違う番号を指定してください（[CLI](cli.md#sacty-up)） |
| 画面に設定ファイルの誤りが出る | 画面に出た項目（例 `agents.<名前>.auth.secret`）と理由を見て、`config.yaml` を直してください（[config.yaml の設定](config.md)）。ファイルが無ければ `npx sacty config init` で作ります |
| `sacty context preview` が、起動中の sacty が見つからないと言って終わる | 先に `npx sacty up` で起動してください（同じ `SACTY_HOME` で） |

## 秘密情報

| 症状 | 確かめること |
| --- | --- |
| 起動のときに、秘密情報を取り出せなかったと警告が出る | 警告に出た設定の秘密情報を用意してください（キーチェーンなら `npx sacty secret set <名前>`、1Password ならサインインと参照）。用意してから「sacty の設定」の「秘密情報を取り出し直す」を押します（[秘密情報](secrets.md)） |
| 1Password の参照でタスクが止まった | `op signin`（または 1Password のアプリとの連携）でサインインしてから、タスクを再開してください |
| `sacty image build` で npm のトークンが無いと言われる | `npx sacty secret set <名前>` で保存してください（1Password の参照なら、サインインと参照を確かめます） |

## タスクが止まる・進まない

| 症状 | 確かめること |
| --- | --- |
| Issue が取り込まれない | 「sacty の設定」の「Issue の取り込み」で取り込むラベルを設定して On にしているか、プロジェクトの対象と GitHub アカウントを選んでいるかを確かめてください。プロジェクトの画面の「取り込めなかった対象」に理由が出ていることがあります（[取り込み](intake.md)） |
| チケットが取り込まれない | 「sacty の設定」の「チケットの取り込み」でラベルを設定して On にしているか、チケットにそのラベルが付いていて終わっていない（完了の状態でない）か、プロジェクトの設定の「チケットの取り込み先」に接続先・種類・JIRA のプロジェクトのキーを書いているかを確かめてください。接続先の PF（`config.yaml` の `gateway.platforms` か、コンテキストリポジトリの `platforms.yaml`）の `upstream`・認証・`allow`（検索の API）も確かめてください。Issue の取り込むラベルと GitHub のアカウントは、チケットの取り込みには使いません。プロジェクトの画面の「取り込めなかった対象」に理由が出ていることがあります（[JIRA のチケット](intake.md#jira-のチケット)） |
| ラベルを付けた PR が取り込まれない | 「sacty の設定」で「PR のレビュー用のラベル」を保存して「レビュー用のラベルの PR を取り込む」を On にしているか、PR に付けたラベルがその名前か（取り込むラベルの付いた PR は取り込みません）、PR が開いているか、その PR のタスクがすでに無いか（同じ PR は、どのプロジェクトのタスクでも、中止したタスクでも、二度取り込みません）、プロジェクトの対象と GitHub アカウントを選んでいるかを確かめてください（[PR のレビュー](intake.md#pr-のレビュー)） |
| レビューを依頼された PR が取り込まれない | 「sacty の設定」で「自分にレビューが依頼された PR を取り込む」を On にしているか、レビューの依頼がプロジェクトでそのホストに選んだ GitHub のアカウント本人への依頼か（チームへの依頼は取り込みません）を確かめてください（[PR のレビュー](intake.md#pr-のレビュー)） |
| 予算の上限で一時停止した | 画面で累計の新しい上限を入力して再開してください（[config.yaml の設定](config.md#予算)） |
| AI の利用上限で一時停止した | サブスクリプションの上限やレート制限が戻ってから再開してください。ゲートウェイのリトライの上限に達したときも同じです（[ゲートウェイ](gateway.md#ai-の呼び出しを中継する)） |
| Codex × Bedrock などで `Reconnecting... error sending request` のまま進まない | 仮想マシンの中の Docker（Rancher Desktop など）では、`gateway.host_address` にホストに届くアドレスを書いてください（[ゲートウェイ](gateway.md#ホストのアドレス)） |
| ホストの MCP サーバーの準備ができないとタスクの一覧に出る | ホストでの認証ができるか、`command` と `env` を確かめてください。sacty は1分ごとに起動し直します（[ゲートウェイ](gateway.md#ホストで動かす-mcp-サーバー)） |
| `mcp.yaml` の MCP サーバーのコマンドがホストに見つからないと作業履歴に出る | `command` のサーバーは既定でホストで起動します。`npx`・`uvx` などをホストに入れるか、そのサーバーに `via_gateway: false` を書いてコンテナの中で起動してください（[コンテキストリポジトリ](context.md#コマンドの-mcp-サーバーホストで動かす)） |
| コンテキストの誤りで工程が止まった | プロジェクトの設定の「コンテキストのプレビュー」か `npx sacty context preview` で、どの層のどのファイルのどの項目かを確かめてください（[コンテキストリポジトリ](context.md#合成の結果を確かめる)） |
| `images` に無いイメージの名前で止まった | `config.yaml` の `images` に足すか、プロジェクトの対象のイメージの指定を直してください（[コンテナイメージ](images.md#どのイメージで動くか)） |
| docker compose のサービスを起動できずに止まった | 理由に出た設定（`privileged`・ホストのネットワーク・作業領域の外のマウントなど）を使っていないか確かめてください（[docker compose のサービス](compose.md#使えない設定)） |
| MySQL などに `localhost` でつなげない | `127.0.0.1` と書くか、サービス名で接続してください（[docker compose のサービス](compose.md#localhost-のままでも届く)） |

## 通知

| 症状 | 確かめること |
| --- | --- |
| Slack の通知が届かない | ダッシュボードか「sacty の設定」の「Slack の通知」に出た理由を見てください。「sacty の設定」の「テストの通知を送る」で確かめられます。以前の sacty でプロジェクトに設定した通知は使わないので、「sacty の設定」で設定し直してください（[通知](notifications.md)） |
| メンションが届かない | 相手を @表示名ではなく ID（`U…`・`W…`・`S…`）で書いてください |
| 送り手の名前とアイコンが `Sacty` にならない | Slack のアプリのボットのトークンに `chat:write.customize` の権限を付けてください |

## 関係するページ

- [ユーザードキュメントの目次](README.md#目次)
