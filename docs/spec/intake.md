# チケットの取り込みと GitHub

GitHub の Issue・PR と JIRA のチケットを、定期的に探してタスクにする。取り込み元・使う GitHub のアカウントはプロジェクトに、取り込むラベルは
sacty の設定（すべてのプロジェクトに共通）に書く。GitHub へのアクセスは、ホストの `gh` にログイン済みのアカウントで行う。

関係する ADR: [取り込みの間隔を、取り込みの種類ごとに sacty の設定に持つ](../adr/20261015-0310-intake-intervals-per-kind.md)、[取り込みを「Issue の取り込み」と「PR のレビューの取り込み」に分け、sacty の PR にはレビュー用のラベルを付ける](../adr/20261015-0240-split-issue-and-pr-review-intake.md)、[sacty が作る PR に取り込むラベルを付け、別のタスクのレビューを元のタスクの PR の指摘として取り込む](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md)

## 間隔

- 取り込みの種類（`IntakeKind`）は3つ：`issues`（Issue の取り込み。`intakeLabel`）・`reviews`（PR のレビューの取り込み。`reviewLabel`・
  `reviewRequested`）・`tickets`（チケットの取り込み。`ticketLabel`）。種類ごとに、sacty の設定の間隔（`issueIntervalSec`・`reviewIntervalSec`・
  `ticketIntervalSec`。秒。60 以上の整数。設定していなければ 300）ごとに、別々に取り込む。
- 間隔が来たかは30秒ごとに確かめ、sacty の設定は毎回読み直す（変えた間隔は、デーモンを再起動せずに次の確認から効く。最後に取り込みを
  始めた時刻から測る）。デーモンを起動したときは、すべての種類をすぐに取り込む。取り込み元が無かった回（ラベルが無い・Off・対象が無い）は
  間隔の起点にせず、その種類の記録も消す（次の確認でまた確かめるので、On にすると次の確認ですぐに取り込む）。
  確認と確認の間に Off にして On に戻したときも同じにするため、sacty の設定を保存するたびに、止める設定（`intakeKindEnabled` が偽）に
  なった種類を数え（`intakeStopCount`。メモリーだけ）、数が変わった種類は間隔の起点を戻す。
- sacty の設定を読めなければ、その理由を取り込み中でない種類の失敗として記録し、間隔の起点にせずに次の確認でやり直す（定期実行は止めない）。
- 検索で何も見つからなければ、取り込みの処理（`importIssues`・`importTickets`。すべてのタスクを調べる）を呼ばない。
- 取り込みは、`config.yaml` を読めれば動く（`config.yaml` に取り込みの項目は無い。`github:` を書いても読まない）。読めなければ取り込まない。
- 種類ごとの取り込みは並行に動く。取り込み中の種類は、間隔が来ても二重に始めない（終わるのを待つ）。1つの種類の失敗・レート制限・遅れは、
  ほかの種類を止めない（レート制限で検索を飛ばすのは、その回のその種類の中だけ）。思わぬ失敗も、その種類の失敗として記録する。
- `POST /api/intake/run` は、すべての種類を間隔を待たずに取り込み、終わってから状況を返す（種類は選べない）。
- 状況（`GET /api/status` の `intake.runs`）は種類ごとに、直近の取り込みの時刻・作ったタスクの数・取り込めなかった取り込み元と理由を持つ
  （メモリーだけ。再起動で消える）。画面は、On で設定のある種類だけを出し、取り込めなかった対象には種類を添える。sacty の設定の保存先を
  読めないときも、状況は記録した取り込み（読めなかった理由を含む）を返し、`settingsUnreadable: true` を付ける（ラベルなどは無い。画面は
  すべての種類の記録を出す）。
- 取り込み元ごとに、どこまで読んだか（更新日時）を種類ごとにメモリーに持ち、続きから読む。プロジェクトの設定・ラベル・On/Off が変わったとき
  （間隔は含まない）とデーモンの再起動のときは先頭から読み直す（取り込み済みのものは二重に取り込まない）。1つの取り込み元の失敗は、ほかの
  取り込み元を止めない。

コード: `apps/daemon/src/intake.ts`（`IssueIntake`）、`packages/core/src/projects.ts`（`IntakeKind`・`intakeIntervalSec`・`intakeKindEnabled`・`SactySettings`）、`apps/daemon/src/service.ts`（`recordIntake`・`intakeStopCount`・`status`）

## GitHub の Issue・PR

sacty の設定の項目ごとに、プロジェクトの対象（Org かリポジトリ）を検索する（`/search/issues`、100件ずつ、更新の古い順）。
取り込みは「Issue の取り込み」（`intakeLabel`）と「PR のレビューの取り込み」（`reviewLabel`・`reviewRequested`）の2つ。PR を取り込むのは
PR のレビューの取り込みだけ。

| 設定 | 検索の条件 | タスク |
| --- | --- | --- |
| `intakeLabel` | `is:open is:issue label:"<ラベル>"` | 通常のタスク（Issue だけ） |
| `reviewLabel` | `is:open is:pr label:"<ラベル>"` | PR のレビューだけ（`source.review: label`。sacty が作った PR は `sacty`） |
| `reviewRequested` | `is:open is:pr user-review-requested:<アカウント>` | PR のレビューだけ（`source.review: requested`） |

- ラベルは 50 文字まで（`"`・`\` は使えない）。比べるときは大文字・小文字を区別しない。設定していなければ取り込まない。
- 取り込むラベルとレビュー用のラベルに同じ名前（大文字・小文字を区別しない）は、保存のときに拒否する（`input.sameIntakeAndReviewLabel`。
  `reviewLabel` の誤り）。読み込みでは拒否しない。同じ名前で保存されている設定でも、Issue は取り込むラベル、PR はレビュー用のラベルとして動く。
- 取り込むラベルの付いた PR は取り込まない（検索の後に見つかっても、通常のタスクにしない）。それより前に取り込んだ PR のタスク
  （`start: github_pull_request` で `source.review` の無いもの）は、そのまま進む（工程はオーケストレーターが選ぶ）。
- `triageOff`（Off にした種類。`issues`・`reviewLabel`・`tickets`）に書いた種類は、ラベルを残したまま検索も取り込みもしない。知らない種類は
  保存で拒否する。
- レビューの依頼は、個人としての依頼だけ（チームへの依頼は含まない）。担当のプロジェクトでそのホストに選んだアカウントへの依頼だけを取り込む。
  レビュー用のラベルと依頼の両方に当たっても、レビューのタスクは1つ。
- sacty が作った PR（台帳にある、タスクの実装の PR・要求要件・設計の PR・ラベルを付けた PR。[PR のレビュー用のラベル](approval.md#pr-のレビュー用のラベル)）に
  レビュー用のラベルが付いていれば、作ったタスクとは別の、PR のレビューだけのタスクにする（`source.review: sacty`。オーケストレーターに工程を
  選ばせない）。レビューの依頼にも当たっても `sacty` にする（そのレビューを作ったタスクに届けるため）。レビュー用のラベルのトリアージを
  Off にしていれば、ラベルでは取り込まない（`sacty` にもしない）。レビューの依頼からの取り込みは別に働き、`reviewRequested` が On で、
  担当のプロジェクトで選んだアカウント本人への依頼があれば、sacty の PR でも `requested` として取り込む（元のタスクには届かない）。
  - 作ったタスクの取り込み元（Issue など）とは番号が違うので、作ったタスクがあることで取り込まれずに終わることはない。同じ PR は二度
    取り込まないので、1つの PR のレビューのタスクは1つ（PR を更新しても、新しいレビューのタスクは作らない）。
  - レビューのタスクが PR に投稿したレビューは、作ったタスクの PR の指摘として取り込む（[PR の指摘の取り込み](approval.md#pr-の指摘の取り込み)）。
    レビューのタスクは PR を作らないので、それ自体はラベルの付く PR を増やさない。
- 担当のプロジェクトは、リポジトリの指定が Org の指定より優先（`responsibleProject`）。同じ Issue・PR（`<リポジトリ>#<番号>`）は二度取り込まない。
- レート制限（403・429 で残りが 0 か `retry-after`）に当たったら、そのアカウントのほかの検索を飛ばす。
- アカウントを選んでいない取り込み元は検索せず、`github.accountRequired` を記録する。

コード: `apps/daemon/src/service.ts`（`intakeSources`・`importIssues`・`sactyReviewsOf`・`saveSettings`）、`apps/daemon/src/github.ts`（`GitHubIssueSearch`）、`packages/core/src/projects.ts`（`SactySettings`・`SactySettingsUpdate`・`TriageKind`・`responsibleProject`）

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
