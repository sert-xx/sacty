# GitHub へのアクセスは、ホストの gh にログイン済みのアカウントからプロジェクトごとに必ず選んだもので行い、config.yaml のトークンの設定は削除する

- 日時: 2026-10-10 23:14 UTC
- ステータス: 置き換え済み（superseded）
- 関係する PR・タスク: #18、PBI-13
- 置き換え元: [最終レビューに通ったら sacty が sacty のブランチにプッシュして PR を作り、成果物チェックのゲートで止める](20261010-0858-superseded-pull-request-and-deliverable-gate.md)（PR を token_secret の設定で作る部分）、[プロジェクトに GitHub Issue の取り込み元を Org 単位かリポジトリ単位でラベルを条件に登録し、ポーリングで取り込んでタスクにする](20261010-0931-superseded-projects-and-github-issue-intake.md)（github.token_secret で取り込む部分）、[コンテキストリポジトリを中立形式で書き、extends の継承を合成して、実行ごとに空の設定のディレクトリへ Claude Code・Codex の形式で置く](20261010-1203-superseded-context-repository-composition.md)（継承先の clone にホストの git の認証を使う部分）
- 置き換え先: [取り込みの間隔を、取り込みの種類ごとに sacty の設定に持つ](20261015-0310-intake-intervals-per-kind.md)（config.yaml の `github:` があれば取り込む部分）

## 背景

GitHub のトークンは config.yaml（`github.token_secret`・`repository.pull_request.token_secret`）に1つしか持てなかった。
複数の GitHub のアカウントを切り替えて使っていると使いづらい、という動作確認のフィードバックがあった。

## 決定

- GitHub へのアクセス（PR の作成・更新・閉じる、Issue の検索、ブランチのプッシュ・削除、clone、コンテキストリポジトリと継承先の取得）は、
  ホストの gh コマンドにログイン済みのアカウントで行う。
- 使うアカウントは、プロジェクトごとに必ず選ぶ。gh のアクティブなアカウントでは代わりにアクセスしない。選んでいないプロジェクトは、
  理由（`github.accountRequired`）を記録して止める。設定画面の最初の選択は、アクティブなアカウントにする。
- トークンは使うたびに `gh auth token --hostname github.com --user <アカウント>` で取り出し、保存しない。gh には `GH_TOKEN`・`GITHUB_TOKEN` を渡さない。
- 設定画面の選択肢は、ログイン済みのアカウントだけ（デーモンの `GET /api/github/accounts`、`gh auth status --json hosts` を使い、トークンは返さない）。
- アカウントはエクスポートに含めない。
- Issue の取り込みは、取り込み元のプロジェクトのアカウントで検索する。アカウントを選んでいない・取り出せない取り込み元だけを失敗にし、レート制限はアカウントごとに扱う。
- HTTPS の GitHub の URL は、gh のトークンで clone・プッシュ・ブランチの削除をする。トークンは子プロセスの環境変数（`GIT_CONFIG_*` の
  `http.https://github.com/.extraheader`）でだけ渡し、コマンドラインには出さない。SSH の URL やローカルのパスは、ホストの認証を使う。
- 取り出したトークンと git に渡す認証の値は、台帳・ログ・画面・コンテナに出さない。
- config.yaml のトークンの設定（`github.token_secret`・`repository.pull_request.token_secret`）と、関係する文言のコード（`run.prTokenRequired`・`cleanup.noToken`）を削除する。
  旧設定は残さない。Issue の取り込みは、config.yaml に `github:`（`poll_interval_sec`）があれば行う。

## 理由

- ホストの gh のアカウントを使うこと、プロジェクトごとに必ず選ぶこと、旧設定を残さないことは、ステークホルダーと決めた（PR の本文）。
- アクティブなアカウントを使わないのは、gh のアクティブなアカウントが切り替わるため（PR の本文）。
- 旧設定を残さないのは、まだ誰も使っていないため（PR の本文）。
- `GH_TOKEN`・`GITHUB_TOKEN` を渡さないのは、渡すと選んだアカウントではなくそのトークンが使われるため（PR の本文）。
- アカウントをエクスポートに含めないのは、個人の設定のため（PR の本文）。
- コンテキストリポジトリの取得にも選んだアカウントを使うのは、ホストの git の認証のままだと、別のアカウントで認証されるか取得に失敗することが、レビューで見つかったため（レビュー）。

## 影響

- sacty を使うには、ホストに gh を入れ、使うアカウントでログインしておく必要がある。
- インポートしたプロジェクトや既定のプロジェクトは、アカウントを選ぶまで GitHub にアクセスできない。
- config.yaml の `token_secret` を書いていた設定は使えなくなる。
