# チケットの取り込みと GitHub

GitHub の Issue・PR と JIRA のチケットを、定期的に探してタスクにする。取り込み元・使う GitHub のアカウントはプロジェクトに、取り込むラベルは
sacty の設定（すべてのプロジェクトに共通）に書く。GitHub へのアクセスは、ホストの `gh` にログイン済みのアカウントで行う。

関係する ADR: なし

## 間隔

- `config.yaml` の `github.poll_interval_sec`（60 以上、既定 300）ごとに取り込む。`github` を書かなければ取り込まない。間隔が来たかは30秒ごとに
  確かめ、設定は毎回読み直す。`POST /api/intake/run` は間隔を待たずに取り込む。
- 取り込み元ごとに、どこまで読んだか（更新日時）をメモリーに持ち、続きから読む。プロジェクトの設定が変わったときとデーモンの再起動のときは
  先頭から読み直す（取り込み済みのものは二重に取り込まない）。1つの取り込み元の失敗は、ほかの取り込み元を止めない。

コード: `apps/daemon/src/intake.ts`（`IssueIntake`）、`apps/daemon/src/config.ts`（`ConfigFile`）

## GitHub の Issue・PR

sacty の設定の項目ごとに、プロジェクトの対象（Org かリポジトリ）を検索する（`/search/issues`、100件ずつ、更新の古い順）。

| 設定 | 検索の条件 | タスク |
| --- | --- | --- |
| `intakeLabel` | `is:open label:"<ラベル>"`（`triageOff` で Issue か PR を外せる） | 通常のタスク |
| `reviewLabel` | `is:open is:pr label:"<ラベル>"` | PR のレビューだけ（`source.review: label`） |
| `reviewRequested` | `is:open is:pr user-review-requested:<アカウント>` | PR のレビューだけ（`source.review: requested`） |

- ラベルは 50 文字まで（`"`・`\` は使えない）。比べるときは大文字・小文字を区別しない。設定していなければ取り込まない。
- レビューの依頼は、個人としての依頼だけ（チームへの依頼は含まない）。担当のプロジェクトでそのホストに選んだアカウントへの依頼だけを取り込む。
  レビューに当たる PR は、取り込むラベルが付いていてもレビューだけのタスクにする。
- 担当のプロジェクトは、リポジトリの指定が Org の指定より優先（`responsibleProject`）。同じ Issue・PR（`<リポジトリ>#<番号>`）は二度取り込まない。
- レート制限（403・429 で残りが 0 か `retry-after`）に当たったら、そのアカウントのほかの検索を飛ばす。
- アカウントを選んでいない取り込み元は検索せず、`github.accountRequired` を記録する。

コード: `apps/daemon/src/service.ts`（`intakeSources`・`importIssues`）、`apps/daemon/src/github.ts`（`GitHubIssueSearch`）、`packages/core/src/projects.ts`（`SactySettings`・`responsibleProject`）

## JIRA のチケット

JIRA の接続先は組織内 PF（`gateway.platforms`、無ければプロジェクトのコンテキストの `platforms.yaml`）として書き、プロジェクトの `tickets` に
接続先（`platform`）・種類（`service`：`jira-cloud`｜`jira-server`）・プロジェクトのキー（`keys`、1〜50件）を書く。

- `ticketLabel` が付いた、終わっていないチケットを探す：
  `project in ("<キー>", …) AND labels = "<ラベル>" AND statusCategory != Done ORDER BY created ASC`。
  Cloud は `GET /rest/api/3/search/jql`（`nextPageToken` で続き）、Server / Data Center は `GET /rest/api/2/search`（`startAt`）。50件ずつ最大10ページ。
- デーモンが読むのはキーと要約（200 文字まで）だけ。PF の `allow` に無い API は、デーモンも呼ばない（`ticket.notAllowed`）。
- タスクの題は `<キー> <要約>`、`start: jira`。担当のプロジェクトはキーの接頭辞（`PAY-123` の `PAY`）で決める。オーケストレーターがゲートウェイ
  経由でチケットを読み、リポジトリ・題・概要を決める（[タスクと工程](tasks-and-steps.md)）。
- 同じ接続先の同じキーは、1つのプロジェクトにだけ書ける（プロジェクトのコンテキストの PF は、プロジェクトごとに別のものとして扱う）。

コード: `apps/daemon/src/tickets.ts`（`JiraTickets`・`ticketJql`）、`apps/daemon/src/service.ts`（`importTickets`・`triageTicket`）、`packages/core/src/projects.ts`（`projectConflicts`・`responsibleTicketProject`）

## 取り込み元へのコメント

- 調査が目的のタスクを承認したら、結果を取り込み元にコメントする。GitHub は目印 `<!-- sacty-investigation:<タスク ID> -->` を入れ、前に投稿した
  ものがあれば二重に投稿しない（本文は 60000 文字まで）。書き出した先の URL があれば添える。失敗は `IssueCommentFailed` に記録する。
- JIRA には、調査の結果と、PR を作ったら PR の URL（と書き出した先の URL）を1回コメントする（`POST /rest/api/2/issue/<キー>/comment`）。
  チケットの状態は変えない。

コード: `apps/daemon/src/service.ts`（`commentInvestigation`・`awaitingIssueComment`・`awaitingTicketPrComment`）、`apps/daemon/src/prompts.ts`（`investigationMarker`・`buildInvestigationComment`・`buildTicketPullRequestComment`）、`apps/daemon/src/tickets.ts`（`JiraTickets.comment`）

## GitHub のアカウントと API

- 使うアカウントは、プロジェクトの `githubAccounts`（ホストごと）で選ぶ。gh のアクティブなアカウントは使わない。選んでいなければ止める。
- 一覧は `gh auth status --json hosts`（ログインに成功しているものだけ）、トークンは使うたびに `gh auth token --hostname <ホスト> --user <アカウント>`。
  gh には `GH_PROMPT_DISABLED=1`・`NO_COLOR=1` と限られたホストの環境変数だけを渡す（`GH_TOKEN`・`GITHUB_TOKEN` は渡さない）。
- API は、github.com なら `https://api.github.com`、それ以外（GitHub Enterprise Server）は `https://<ホスト>/api/v3`。
- HTTPS のリポジトリの clone・プッシュは、そのホストのアカウントのトークンを `http.https://<ホスト>/.extraheader` で渡して行う。SSH・ローカルの
  パスはホストの認証を使う。

コード: `apps/daemon/src/gh.ts`（`GhCliAuth`・`ghEnv`・`gitAuthEnv`）、`packages/core/src/github-url.ts`（`githubApiBase`）、`apps/daemon/src/github.ts`
