# gh アカウントの切り替え

`gh` で使う GitHub アカウントを一時的に切り替え、作業後に元へ戻すときの手順。PR の取得・投稿・返信などを、現在とは別のアカウントで行う必要がある場合に使う。

## 基本方針

- 切り替え先は `gh auth status` に表示される、ログイン済みのアカウントに限る。その中からなら `gh auth switch` で切り替えてよい。
- 一覧にないアカウントが必要な場合は、`gh auth login` やトークン設定を自分で行わずにユーザーへ伝える。
- 作業後は必ず元のアカウントへ戻し、戻ったことを確認する。途中で失敗したときも戻す。
- トークンの中身を表示・読み取りしない。`gh auth status --show-token`・`gh auth token` は使わない。

## 1. 現在の状態を確認する

```bash
gh auth status --json hosts \
  --jq '.hosts | to_entries[] | .key as $host | .value[] | {host: $host, login, active, state, tokenSource}'
```

- `active: true` のアカウントが現在のアカウント。この `login` を**元のアカウント**として記録する。
- 切り替え先の `login` が同じホストに存在し、`state` が `success` であることを確認する。`success` 以外ならログインが失効しているので、切り替えずにユーザーへ伝える。
- `tokenSource` が `GH_TOKEN`・`GITHUB_TOKEN` などの環境変数の場合、環境変数のトークンが優先され、`gh auth switch` しても実際に使われるアカウントは変わらない。この場合は切り替えずにユーザーへ伝える。
- GitHub Enterprise など `github.com` 以外のホストでは、以降のコマンドに `--hostname <host>` を付ける。

## 2. 切り替える

```bash
gh auth switch --hostname github.com --user <切り替え先の login>
```

- `--user` を必ず指定する。省略すると、アカウントが 3 つ以上ある場合に対話プロンプトになる。
- 切り替え後、実際に使われるアカウントを確認する。

  ```bash
  gh api user --jq .login
  ```

  出力が切り替え先の `login` と一致しなければ、作業せずに 4 の手順で元へ戻し、ユーザーへ報告する。

## 3. 作業する

- 切り替えたアカウントで必要な操作だけを行う。
- `gh auth switch` はマシン全体の `gh` 設定を変えるため、同時に動いている他の作業にも影響する。切り替えている時間をできるだけ短くする。
- `gh auth setup-git` を設定している環境では、`git push` などの HTTPS 認証も切り替え先のアカウントになる。意図しない push に注意する。
- コミットの作者（`git config user.name` / `user.email`）は `gh` のアカウントとは別物で、切り替えても変わらない。

## 4. 元のアカウントへ戻す

作業が成功しても失敗しても、必ず戻す。

```bash
gh auth switch --hostname github.com --user <元の login>
gh api user --jq .login
```

- 出力が元の `login` と一致することを確認する。
- 作業コマンドと復帰コマンドは別々に実行し、作業コマンドが失敗しても復帰コマンドを必ず実行する。`&&` でつなぐと、途中のエラーで復帰が飛ばされるので使わない。
- 戻せなかった場合は、その状況（現在のアクティブアカウントと元のアカウント）をユーザーへ必ず報告する。

## 仕様の根拠

- [GitHub CLI: gh auth switch](https://cli.github.com/manual/gh_auth_switch)
- [GitHub CLI: gh auth status](https://cli.github.com/manual/gh_auth_status)
- [GitHub CLI: Environment variables (GH_TOKEN)](https://cli.github.com/manual/gh_help_environment)
