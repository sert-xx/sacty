**日本語** | [English](secrets.en.md)

# 秘密情報

設定には秘密情報の値を書かず、参照（キーチェーンの名前か 1Password の参照）だけを書く。値はホストで使うときに取り出し、作業履歴・
ログ・画面・コンテナ（ゲートウェイ経由のとき）に出さない。

関係する ADR: [起動時と保存時に、プロジェクトのコンテキストの秘密情報もまとめて取り出す](../adr/20261015-1303-prefetch-context-secrets.md)

## 参照の形

- キーチェーンの名前：`^[A-Za-z0-9._-]+$`。macOS のキーチェーンの汎用パスワード（サービス名 `sacty`、アカウントが名前）。
  `sacty secret set <名前>` が `security add-generic-password -U -s sacty -a <名前> -w` を実行し、値は `security` がたずねる（sacty は値に触れない）。
  取り出すときは `security find-generic-password -s sacty -a <名前> -w`。キャッシュしない（使うたびに取り出す）。
- 1Password の参照：`op://<保管庫>/<アイテム>[/<セクション>]/<フィールド>[?<属性>=<値>…]`。`op read --no-newline [--account <アカウント>]` で
  取り出す（上限 120 秒）。アカウントは `onepassword.account`（取り出すたびに設定から読む）。
- 取り出した 1Password の値は、デーモンが動いている間だけ、アカウントと参照の組ごとにメモリーに持つ（ディスクに書かない。同時の問い合わせは
  1回にまとめる。まとめて取り出している最中の参照も、その結果を待つ。失敗したものは持たない）。
- 取り出せないとき：`op` が無い（`secret.opMissing`）、サインインしていない（`secret.opSignedOut`）、ほか（`secret.opFailed`）、キーチェーンに無い
  （`run.secretNotFound`）。実行のときに取り出せなければ、実行の失敗（`auth`）にしてタスクを一時停止する。再開すると取り出し直す。

コード: `apps/daemon/src/secrets.ts`（`SecretRef`・`isOnePasswordRef`・`KeychainSecretStore`・`OnePasswordSecretStore`・`ResolvingSecretStore`・`KEYCHAIN_SERVICE`）、`packages/cli/src/index.ts`（`secretSet`）

## 起動のときのまとめての取り出し

- デーモンが待ち受けを始めたら、使う秘密情報をまとめて取り出す（`prefetchSecrets`）。対象（`secretUses`）は、使うエージェント
  （既定・ゴールガーディアン・`step_agents`）の `auth.secret`、`providers.<名前>.secret`、`gateway.platforms` の `auth.secret`・`auth.token.secret`、
  `gateway.mcp_servers` の `env` の秘密情報、プロジェクトの通知先（Slack のトークン・Webhook の URL）と、登録済みのプロジェクトのコンテキストの
  秘密情報。npm のトークン（イメージの作成だけで使う）・gh のトークンは含めない（使うときに取り出す）。
- コンテキストの秘密情報（`contextSecretUses`）：コンテキストリポジトリを設定したプロジェクトごとに、コンテキストを取得して合成し（継承の鎖の
  上の層と既定のコンテキストを含む。`contextSecretSources`）、合成した `platforms.yaml` の `auth.secret`・`auth.token.secret` と、`mcp.yaml` の
  `env`・`headers` の秘密情報を集める。ホストの PF（`gateway.platforms`）と同じ名前の PF、ゲートウェイがあるときにホストの MCP サーバーと同じ名前の
  MCP サーバー（どちらも層のものは使わない）と、ゲートウェイの実行ごとのトークンは含めない。どの設定かは
  `プロジェクト「<名前>」のコンテキスト（<層>）の platforms.yaml の <PF>.auth.secret` のように示す。
- コンテキストは同時に `CONTEXT_SECRETS_CONCURRENCY`（4）件ずつ取得し、全体で `CONTEXT_SECRETS_TIMEOUT_MS`（30 秒）まで待つ。取得できなかった・
  時間内に取得できなかったプロジェクトは、その理由（`secret.contextUnavailable`。時間切れは `secret.contextTimedOut`）を警告に出し、そのプロジェクトの
  コンテキストの秘密情報は、使うときに取り出す。取得のエラー文は、gh のトークンを伏せてから出す。上限を過ぎたら、進んでいる取得を止める
  （git をプロセスグループごと止め（`git.aborted`）、取得したリポジトリの一時ディレクトリを消す）。
- コンテキストの秘密情報も、ほかの秘密情報と同じ1回の取り出しにまとめる（コンテキストを読み終えてから取り出す）。
- 1Password の参照は、1回の `op run --no-masking --env-file <参照だけを書いたファイル（0600）>` で子のプロセスに環境変数として渡し、JSON で
  受け取る（認証を1回にする）。まとめて取り出せなければ、参照ごとに取り出し直して、取り出せなかったものを集める。キーチェーンは、
  取り出せるかだけを確かめる。
- 取り出せなかったものは、どの設定か（`agents.<ID>.auth.secret` など）と理由を、端末と画面の警告に出す（起動は止めない）。
- `POST /api/secrets/prefetch`（画面の「秘密情報を取り出し直す」）は、持っている値を捨て、コンテキストを取得し直して、起動のときと同じ対象を
  取り出し直す。取り出せた数（`fetched`）・対象の数（`total`）・読めなかったコンテキストの数（`unreadContexts`。その中の秘密情報は `total` に
  入らない）・警告（`problems`）を返す。画面は、読めなかったコンテキストがあれば、確かめていない秘密情報があると出す。
- プロジェクトの保存（`POST /api/projects`・`PUT /api/projects/:id`・`POST /api/projects/import`）の後、応答を待たせずに、そのプロジェクトの
  秘密情報（通知先と、コンテキストの秘密情報）をまとめて取り出す（`prefetchProjectSecrets`）。持っている参照は取り出さない（1Password に
  問い合わせない）。取り出せなかったもの（`secret.savePrefetchFailed`）とコンテキストを取得できなかった理由は、画面の警告に出し、そのプロジェクトの
  前の警告と置き換える。
- 警告の置き換え：取り出しを始めるたびに世代を進め、全体（設定の秘密情報）とプロジェクトごとに、最後に始めた取り出しの世代を持つ。起動・取り出し直し・
  保存のどれも、終わったときに、自分より後に始まった取り出しがある範囲の警告は書き換えない（重なっても、古い結果で新しい結果を上書きしない）。
- 起動の後にコンテキストリポジトリに足された秘密情報（コンテキストは取得のたびに ref の先頭を取る）は、ほかの時点では前もって取り出さず、使うときに
  その場で取り出す（そのときに 1Password の認証を求めることがある）。前もって取り出すには、取り出し直すか、プロジェクトを保存し直す。
- ホストの MCP サーバーの起動と組織内 PF の認証の用意は、まとめての取り出しの後に始める。

コード: `apps/daemon/src/service.ts`（`prefetchSecrets`・`prefetchProjectSecrets`・`contextSecretUsesOf`・`CONTEXT_SECRETS_TIMEOUT_MS`・`CONTEXT_SECRETS_CONCURRENCY`）、`apps/daemon/src/secret-uses.ts`（`secretUses`・`projectSecretUses`・`contextSecretUses`）、`apps/daemon/src/context.ts`（`contextSecretSources`）、`apps/daemon/src/secrets.ts`（`OnePasswordSecretStore.prefetch`・`ResolvingSecretStore.prefetch`）、`apps/daemon/src/server.ts`、`apps/daemon/src/main.ts`

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
