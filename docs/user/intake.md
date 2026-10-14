<!-- 対応するコード: packages/core/src/projects.ts（SactySettings・TicketSourceConfig）、apps/daemon/src/intake.ts、apps/daemon/src/tickets.ts、apps/daemon/src/config.ts（github）、apps/web/src/i18n/messages/settings.ts -->

# Issue・PR・チケットの取り込み

GitHub の Issue・PR や JIRA のチケットを、定期的に取り込んでタスクにする。取り込みの設定は、すべてのプロジェクトに共通の設定として、
画面の「sacty の設定」（ユーザーメニュー）で決める。

## 取り込みを動かす

取り込みは、`config.yaml` に `github:` を書いたときだけ動く（書かなければ、Issue・PR・チケットのどれも取り込まない。
画面の「今すぐ取り込む」でも取り込まない）。

```yaml
github:
  poll_interval_sec: 300   # 取り込む間隔（秒。60 以上。既定 300）
```

間隔はデーモンを止めずに変えられる。プロジェクトの画面の「今すぐ取り込む」で、間隔を待たずに取り込める。

## Issue・PR

- 「sacty の設定」の「取り込むラベル」の付いた、プロジェクトの対象の開いている Issue と PR を、タスクとして取り込む。
  ラベルを設定していなければ取り込まない。
- 「Issue を取り込む」「PR を取り込む」で、ラベルを残したまま Off にできる。
- 使う GitHub のアカウントは、プロジェクトでそのホストに選んだもの（[プロジェクトの設定](project-settings.md#github-アカウント)）。

## PR のレビュー

PR のレビューだけを任せることもできる（「sacty の設定」の「PR のレビューの取り込み」）。

- 「自分にレビューが依頼された PR を取り込む」を On にすると、プロジェクトでそのホストに選んだ GitHub のアカウントへの、個人としての
  レビューの依頼の PR を取り込む（チームへの依頼は除く）。
- 「PR のレビュー用のラベル」（取り込むラベルとは別）の付いた PR も取り込む。「レビュー用のラベルの PR を取り込む」で Off にできる。
- 取り込んだ PR は、オーケストレーターを使わずにレビューだけを行い、PR にレビュー（コメント）として投稿する。実装や PR の作成はしない。
- PR がマージ・クローズされたら、終わっていないレビューのタスクは中止する。
- 新しいコミットが積まれたら、タスクの詳細の「再レビュー」で、最新のコミットをもう一度レビューして投稿する。

## JIRA のチケット

JIRA（Jira Cloud・Jira Server / Data Center）の接続先は、組織内 PF（`config.yaml` の `gateway.platforms`、またはコンテキストリポジトリの
`platforms.yaml`）として書く。JIRA 専用の設定は無い（PF の書き方は [ゲートウェイ](gateway.md#組織内-pf-の-api)）。

```yaml
gateway:
  platforms:
    jira:                                     # Jira Server / Data Center（個人用アクセストークン）
      upstream: https://jira.example.com
      description: JIRA
      auth:
        header: Authorization
        prefix: "Bearer "
        secret: op://Work/Jira/token
      allow:
        - GET /rest/api/2/search              # 取り込み（デーモンがチケットを探す）
        - GET /rest/api/2/issue/**            # オーケストレーターがチケット・親・サブタスクを読む
        - POST /rest/api/2/issue/*/comment    # 調査の結果と PR の URL をコメントする
    jira-cloud:                               # Jira Cloud（メールアドレス:API トークン を base64 にした値）
      upstream: https://acme.atlassian.net
      description: JIRA Cloud
      auth:
        header: Authorization
        prefix: "Basic "
        secret: op://Work/JiraCloud/basic     # echo -n 'me@example.com:<API トークン>' | base64
      allow:
        - GET /rest/api/3/search/jql
        - GET /rest/api/2/issue/**
        - GET /rest/api/3/issue/**
        - POST /rest/api/2/issue/*/comment
```

- プロジェクトの設定の「チケットの取り込み先」に、接続先（上の名前）・種類（Jira Cloud / Jira Server・Data Center）・JIRA のプロジェクトの
  キー（`PAY` など。英大文字で始まる英大文字・数字・`_`）を書く。1つのプロジェクトに複数書ける。
- `config.yaml` の PF の同じ接続先の同じキーは、1つのプロジェクトにだけ書ける。コンテキストリポジトリの `platforms.yaml` の PF は
  プロジェクトとあわせて識別するので、同じ名前・同じキーの取り込み先を、別のプロジェクト（別の接続先）に書ける。
- 「sacty の設定」の「チケットの取り込み」の取り込むラベル（すべての取り込み先で共通）が付いた、終わっていないチケットをタスクにする。
  「チケットを取り込む」で Off にできる。
- デーモンはチケットのキーと要約だけを探す。オーケストレーターがゲートウェイ経由でチケット（サブタスクなら親とほかのサブタスク）を
  読み、プロジェクトの対象から作業するリポジトリを選び、タスクの題と概要を書く。選べなければタスクは止まり、タスクの画面で
  リポジトリを選んで再開できる。
- 調査の結果と PR の URL は、チケットにコメントする（チケットの状態は変えない）。
- `allow` に無い API は、デーモンも呼ばない。JIRA ではない接続先を選んだときの動きは保証しない。

## タスクの並行実行

「sacty の設定」の「同時に実行するタスクの数」（1〜10。空なら 3）まで、実行待ちのタスクを古い順に同時に実行する。
増やすほど、マシンの負荷と AI の利用上限の消費が増える。

## 関係するページ

- [プロジェクトの設定](project-settings.md)
- [タスクを進める](tasks.md)
