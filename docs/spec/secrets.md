**日本語** | [English](secrets.en.md)

# 秘密情報

設定には秘密情報の値を書かず、参照（キーチェーンの名前か 1Password の参照）だけを書く。値はホストで使うときに取り出し、作業履歴・
ログ・画面・コンテナ（ゲートウェイ経由のとき）に出さない。

関係する ADR: なし

## 参照の形

- キーチェーンの名前：`^[A-Za-z0-9._-]+$`。macOS のキーチェーンの汎用パスワード（サービス名 `sacty`、アカウントが名前）。
  `sacty secret set <名前>` が `security add-generic-password -U -s sacty -a <名前> -w` を実行し、値は `security` がたずねる（sacty は値に触れない）。
  取り出すときは `security find-generic-password -s sacty -a <名前> -w`。キャッシュしない（使うたびに取り出す）。
- 1Password の参照：`op://<保管庫>/<アイテム>[/<セクション>]/<フィールド>[?<属性>=<値>…]`。`op read --no-newline [--account <アカウント>]` で
  取り出す（上限 120 秒）。アカウントは `onepassword.account`（取り出すたびに設定から読む）。
- 取り出した 1Password の値は、デーモンが動いている間だけ、アカウントと参照の組ごとにメモリーに持つ（ディスクに書かない。同時の問い合わせは
  1回にまとめる。失敗したものは持たない）。
- 取り出せないとき：`op` が無い（`secret.opMissing`）、サインインしていない（`secret.opSignedOut`）、ほか（`secret.opFailed`）、キーチェーンに無い
  （`run.secretNotFound`）。実行のときに取り出せなければ、実行の失敗（`auth`）にしてタスクを一時停止する。再開すると取り出し直す。

コード: `apps/daemon/src/secrets.ts`（`SecretRef`・`isOnePasswordRef`・`KeychainSecretStore`・`OnePasswordSecretStore`・`ResolvingSecretStore`・`KEYCHAIN_SERVICE`）、`packages/cli/src/index.ts`（`secretSet`）

## 起動のときのまとめての取り出し

- デーモンが待ち受けを始めたら、使う秘密情報をまとめて取り出す（`prefetchSecrets`）。対象（`secretUses`）は、使うエージェント
  （既定・ゴールガーディアン・`step_agents`）の `auth.secret`、`providers.<名前>.secret`、`gateway.platforms` の `auth.secret`・`auth.token.secret`、
  `gateway.mcp_servers` の `env` の秘密情報、プロジェクトの通知先（Slack のトークン・Webhook の URL）。npm のトークン（イメージの作成だけで
  使う）・gh のトークン・コンテキストリポジトリの `mcp.yaml`・`platforms.yaml` の秘密情報は含めない（使うときに取り出す）。
- 1Password の参照は、1回の `op run --no-masking --env-file <参照だけを書いたファイル（0600）>` で子のプロセスに環境変数として渡し、JSON で
  受け取る（認証を1回にする）。まとめて取り出せなければ、参照ごとに取り出し直して、取り出せなかったものを集める。キーチェーンは、
  取り出せるかだけを確かめる。
- 取り出せなかったものは、どの設定か（`agents.<ID>.auth.secret` など）と理由を、端末と画面の警告に出す（起動は止めない）。
- `POST /api/secrets/prefetch`（画面の「秘密情報を取り出し直す」）は、持っている値を捨てて取り出し直す。
- ホストの MCP サーバーの起動と組織内 PF の認証の用意は、まとめての取り出しの後に始める。

コード: `apps/daemon/src/service.ts`（`prefetchSecrets`）、`apps/daemon/src/secret-uses.ts`（`secretUses`）、`apps/daemon/src/secrets.ts`（`OnePasswordSecretStore.prefetch`・`ResolvingSecretStore.prefetch`）、`apps/daemon/src/main.ts`

## 値を出さないための扱い

- エージェントの結果の文と出力から、その実行で使った値（取り出した秘密情報・ゲートウェイのトークン・MCP のヘッダーの値・gh のトークン・
  認証ファイルの中の 16 文字以上の文字列）を `[REDACTED]` に置き換えてから作業履歴に記録する（長い値から順に、長さにかかわらず）。
  文言のコードと決まった値の引数は変えず、自由な文だけを置き換える。
- セッションログは、値そのものと JSON の文字列にした形を伏せてから書く（[作業履歴](event-log.md)）。
- PF のトークンの取得・ホストの MCP サーバーの起動・通知の失敗の理由は、値（と JSON にした形・各行）を伏せてから切り詰める。
- ゲートウェイ経由の AI・PF・コンテキストの MCP（ホストで起動するコマンド型の `env` を含む）では、値をコンテナに渡さない。コンテナから
  直接使う設定（ゲートウェイ経由でない AI の認証、`via_gateway: false` の MCP）では、値を環境変数でコンテナに渡す。
- イメージの作成の npm のトークンは BuildKit の secret だけで渡す。`images.<名前>.env`・`image_build.npm_config` には認証の値を書けない
  （[設定](configuration.md)）。
- gh のトークンは使うたびに `gh auth token --hostname <ホスト> --user <アカウント>` で取り出し、保存しない。

コード: `apps/daemon/src/agents/redact.ts`（`redact`・`redactText`・`secretStringsInJson`・`REDACTED`）、`apps/daemon/src/session-logs.ts`（`secretForms`）、`apps/daemon/src/platforms.ts`（`hideSecret`）、`apps/daemon/src/gh.ts`（`GhCliAuth`）
