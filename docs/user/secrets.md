<!-- 対応するコード: packages/cli/src/index.ts（secretSet）、apps/daemon/src/secrets.ts、apps/daemon/src/secret-uses.ts、apps/daemon/src/config.ts（onepassword） -->

**日本語** | [English](secrets.en.md)

# 秘密情報（キーチェーン・1Password）

トークンや API キーは、設定ファイルには名前（または 1Password の参照）だけを書き、値はキーチェーンか 1Password に置きます。
sacty は値をコマンドライン・作業履歴・ログ・画面に出しません。

## キーチェーンに保存する

```sh
npx sacty secret set claude-oauth-token
```

- 名前に使えるのは英数字と `.`・`_`・`-` だけです。
- 値は `security` コマンドがたずねます（入力は表示されず、確認のため2回たずねます）。同じ名前があれば上書きします。
- 設定ファイルには、その名前を書きます（例 `secret: claude-oauth-token`）。

## 1Password

1Password に保存した秘密情報は、名前の代わりに参照（`op://保管庫/アイテム/フィールド`）を書きます。エージェントの認証・
`providers`・`gateway.platforms`・`gateway.mcp_servers`・コンテキストリポジトリの `mcp.yaml`・`platforms.yaml`・プロジェクトの通知先・
npm のトークンなど、秘密情報を書くすべての所で使えます。

```yaml
agents:
  codex-bedrock:
    runtime: codex
    auth: { mode: bedrock, secret: "op://Work/Bedrock/credential", region: us-east-2 }
    price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }
# 複数の 1Password のアカウントにサインインしているときは、使うアカウントを書く
onepassword:
  account: acme.1password.com
```

- 1Password CLI（`op`）で取り出します。先に `op signin`（または 1Password のアプリとの連携）でサインインしておいてください。
- 取り出した値は、デーモンが動いている間だけメモリーに持ち、同じ参照で何度も問い合わせません（ディスクには書きません）。
- サインインしていない・参照先が無いときは、どの参照かと理由を記録してタスクを止めます。サインインしてから再開すると、取り出し直します。

## 起動のときに取り出すもの

- `sacty up` の起動のときに、使う秘密情報（使うエージェントの認証・`providers`・`gateway.platforms`・`gateway.mcp_servers` の
  環境変数・プロジェクトの通知先）をまとめて取り出します。1Password の参照は1回の `op run` で取り出すので、認証は起動のときの1回だけです。
  キーチェーンの秘密情報は、取り出せるかを確かめます（使うたびに取り出します）。
- 起動のときに取り出せなかったものは、画面の警告と端末に、どの設定かと理由を出します（起動は止めません）。用意してから、画面の
  「sacty の設定」の「秘密情報を取り出し直す」を押してください。
- イメージの作成だけで使う npm のトークンと、コンテキストリポジトリの `mcp.yaml`・`platforms.yaml` の秘密情報は、起動のときには
  取り出しません（使うときに取り出します）。GitHub のトークンは、使うたびに `gh` から取り出します。

## 関係するページ

- [config.yaml の設定](config.md)
- [困ったとき](troubleshooting.md)
