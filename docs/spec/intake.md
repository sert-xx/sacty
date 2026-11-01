**日本語** | [English](intake.en.md)

# チケットの取り込みと GitHub

GitHub の Issue・PR と JIRA のチケットを、定期的に探してタスクにする。
取り込み元と使う GitHub のアカウントはプロジェクトに書き、取り込むラベルは sacty の設定（すべてのプロジェクトに共通）に書く。
GitHub には、ホストの `gh` にログイン済みのアカウントでアクセスする。

関係する ADR: [取り込むラベルとレビュー用のラベルに同じ名前を許す](../adr/20261015-0850-allow-same-intake-and-review-label.md)、[取り込みの間隔を、取り込みの種類ごとに sacty の設定に持つ](../adr/20261015-0310-intake-intervals-per-kind.md)、[取り込みを「Issue の取り込み」と「PR のレビューの取り込み」に分け、sacty の PR にはレビュー用のラベルを付ける](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md)、[sacty が作る PR に取り込むラベルを付け、別のタスクのレビューを元のタスクの PR の指摘として取り込む](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md)、[GitHub のレビュー再依頼は完了タスクを戻さず別タスクにする](../adr/20261019-0503-review-rerequest-new-task.md)、[PR を参照する sacty のタスクの投稿は、取り込みの経路に関わらず、指摘のある回を元のタスクの PR の指摘として取り込む](../adr/20261025-2245-import-sacty-reviews-from-any-intake.md)

## 間隔

取り込みの種類（`IntakeKind`）は3つある。
種類ごとに、sacty の設定の間隔ごとに、別々に取り込む。
間隔は秒で、60 以上の整数。
設定していなければ 300。

| 種類 | 取り込み | 設定 | 間隔 |
| --- | --- | --- | --- |
| `issues` | Issue の取り込み | `intakeLabel` | `issueIntervalSec` |
| `reviews` | PR のレビューの取り込み | `reviewLabel`・`reviewRequested` | `reviewIntervalSec` |
| `tickets` | チケットの取り込み | `ticketLabel` | `ticketIntervalSec` |

- 確認と起点
  - 間隔が来たかは30秒ごとに確かめ、sacty の設定は毎回読み直す。
    変えた間隔は、デーモンを再起動せずに次の確認から効く。
    間隔は、最後に取り込みを始めた時刻から測る。
  - デーモンを起動したときは、すべての種類をすぐに取り込む。
  - 取り込み元が無かった回（ラベルが無い・Off・対象が無い）は、間隔の起点にせず、その種類の記録も消す。
    次の確認でまた確かめるので、On にすると次の確認ですぐに取り込む。
- sacty の設定を保存したとき
  - 何を変えたかは見分けず、すべての種類の間隔の起点を戻し、次の確認ですぐに取り込む。
    取り込みは保存の回数 `settingsSaveCount` を見る（メモリーだけ）。
  - On にした・ラベルを変えた・確認と確認の間に Off にして On に戻した、のどれも、これで次の確認で取り込む。
  - その後は、保存した直後の取り込みから、新しい間隔で測る。
  - 保存したときに取り込み中の種類は、その取り込みが終わった後の確認で、新しい取り込みを始める（取り込み中は二重に始めない）。
- 失敗したとき
  - sacty の設定を読めなければ、その理由を、取り込み中でない種類の失敗として記録し、その種類の間隔の起点を戻す。
    直ったら次の確認ですぐに取り込む。
    定期実行は止めない。
  - 取り込みの途中の思わぬ失敗も、その種類の間隔の起点を戻す。
  - 取り込み元ごとの検索の失敗・レート制限は、間隔の起点を変えない（次の間隔で取り込む）。
- 読んだ位置
  - 取り込み元ごとの読んだ位置（GitHub の更新日時・チケットの続きの位置）は、取り込み（タスクの保存）に成功してから進める。
    取り込みで失敗したら、次の回は前の位置から読み直す。
    失敗した回の項目を飛ばさず、取り込み済みのものは二重に取り込まない。
  - 取り込みを始めたときと終わったときで、sacty の設定の保存の回数（`settingsSaveCount`）かプロジェクトの設定の版（`projectsRevision`）が変わっていたら、位置を進めない。
    途中で Off にして On に戻したなどで、取り込まれなかった項目を読み飛ばさないため。
    何が変わったかは見分けない。
  - 取り込み元ごとに、どこまで読んだか（更新日時）を種類ごとにメモリーに持ち、続きから読む。
    プロジェクトの設定・ラベル・On/Off が変わったとき（間隔は含まない）と、デーモンを再起動したときは、先頭から読み直す（取り込み済みのものは二重に取り込まない）。
  - GitHub の検索の位置は、その検索を始めた時刻より先には進めない。先なら、始めた時刻（秒未満は切り捨て）に戻す。
    GitHub の更新日時はこの機械の時計とずれることがあり、先に進んだ更新日時をそのまま持つと、時刻が戻った後に更新されたもの（ラベルを付けた PR など）が、持った位置より古い更新日時になって、次の更新まで検索に当たらないため。
    戻すと余分に読み直すだけで、取り込み済みのものは二重に取り込まない。
  - 1つの取り込み元の失敗は、ほかの取り込み元を止めない。
- 検索で何も見つからなければ、取り込みの処理（`importIssues`・`importTickets`。すべてのタスクを調べる）を呼ばない。
- 取り込みは、`config.yaml` を読めれば動く。
  `config.yaml` に取り込みの項目は無く、`github:` を書いても読まない。
  読めなければ取り込まない。
- 種類ごとの取り込みは並行に動く。
  - 取り込み中の種類は、間隔が来ても二重に始めない（終わるのを待つ）。
  - 1つの種類の失敗・レート制限・遅れは、ほかの種類を止めない。
    レート制限で検索を飛ばすのは、その回のその種類の中だけ。
  - 思わぬ失敗も、その種類の失敗として記録する。
- `POST /api/intake/run` は、すべての種類を間隔を待たずに取り込み、終わってから状況を返す（種類は選べない）。
- 状況（`GET /api/status` の `intake.runs`）
  - 種類ごとに、直近の取り込みの時刻・作ったタスクの数・取り込めなかった取り込み元と理由を持つ。
    メモリーだけに持ち、再起動で消える。
  - 画面は、On で設定のある種類だけを出し、取り込めなかった対象には種類を添える。
  - sacty の設定の保存先を読めないときも、状況は記録した取り込みを返し、`settingsUnreadable: true` と、いま読めなかった理由（`settingsError`）を付ける。
    ラベルなどは付けない。
    定期の確認の前でも理由がわかる。
    画面は、理由と、すべての種類の記録を出す。

コード: `apps/daemon/src/intake.ts`（`IssueIntake`・`clampCursor`）、`packages/core/src/projects.ts`（`IntakeKind`・`intakeIntervalSec`・`SactySettings`）、`apps/daemon/src/service.ts`（`recordIntake`・`settingsSaveCount`・`status`）

## GitHub の Issue・PR

sacty の設定の項目ごとに、プロジェクトの対象（Org かリポジトリ）を検索する（`/search/issues`、100件ずつ、更新の古い順）。
取り込みは「Issue の取り込み」（`intakeLabel`）と「PR のレビューの取り込み」（`reviewLabel`・`reviewRequested`）の2つ。
PR を取り込むのは、PR のレビューの取り込みだけ。

- 検索のまとめ方
  - ドメイン（ホスト）・アカウント・検索の種類（取り込むラベルの Issue／レビュー用のラベルの PR／自分へのレビューの依頼）ごとに、すべてのプロジェクトの対象を1つの検索にまとめる。
    `repo:a/b repo:c/d org:e` のように並べると、GitHub はどれかに当たるものを探す。
    プロジェクト・対象の数によらず、GitHub への検索の数を最小にするため。
  - 1つの検索に入れる対象は `INTAKE_SCOPES_PER_QUERY`（30）個までで、超えたら分ける。
  - 担当のプロジェクトの判定・二重の取り込みの判定・依頼の本人の照合は、見つかったものごとに `importIssues` で行う。
  - アカウントを選んでいないプロジェクトの対象は、まとめずにプロジェクトごとにし、検索せずに理由を示す。
  - まとめた検索は、存在しない・見る権限の無いリポジトリが混じっていても、ほかの対象の結果を返す（その対象だけを理由に失敗しない）。
    すべての対象がそうなら、その検索の失敗として記録する。

| 設定 | 検索の条件 | タスク |
| --- | --- | --- |
| `intakeLabel` | `is:open is:issue label:"<ラベル>"` | 通常のタスク（Issue だけ） |
| `reviewLabel` | `is:open is:pr label:"<ラベル>"` | PR のレビューだけ（`source.review: label`。sacty が作った PR は `sacty`） |
| `reviewRequested` | `is:open is:pr user-review-requested:<アカウント>` | PR のレビューだけ（`source.review: requested`） |

- ラベル
  - ラベルは 50 文字まで（`"`・`\` は使えない）。
    比べるときは大文字・小文字を区別しない。
    設定していなければ取り込まない。
  - 取り込むラベルとレビュー用のラベルは、同じ名前（大文字・小文字だけが違う名前も）にできる。
    同じ名前でも、Issue は取り込むラベルで通常のタスクに、PR はレビュー用のラベルでレビューだけのタスクにする。
    検索の条件が `is:issue`・`is:pr` で分かれ、取り込みの判定でも Issue をレビューのタスクに、PR を通常のタスクにしない。
    sacty が作った PR も、`sacty` のレビューのタスクとして1回だけ取り込む。
  - 取り込むラベルの付いた PR は取り込まない（検索の後に見つかっても、通常のタスクにしない）。
    それより前に取り込んだ PR のタスク（`start: github_pull_request` で `source.review` の無いもの）は、そのまま進む（工程はオーケストレーターが選ぶ）。
  - `triageOff`（Off にした種類。`issues`・`reviewLabel`・`tickets`）に書いた種類は、ラベルを残したまま、検索も取り込みもしない。
    知らない種類は、保存で拒否する。
- レビューの依頼
  - 取り込むのは個人としての依頼だけで、チームへの依頼は含まない。
    担当のプロジェクトでそのホストに選んだアカウントへの依頼だけを取り込む。
  - レビュー用のラベルと依頼の両方に当たっても、レビューのタスクは1つ。
- レビューの再依頼
  - 依頼の検索で、依頼で取り込んだ（`source.review: requested`）タスクのうち「再レビュー」できるもの（`canRereview`）の PR が見つかったら、sacty は次の2つを読む。
    - PR の今の依頼先（`requested_reviewers`）
    - そのタスクのアカウントへの最後の依頼の日時（PR のできごとの `review_requested`）
  - 今も依頼されていて、最後の依頼が前回の投稿より後なら、同じプロジェクトに新しい ID のレビュー専用タスクを作る（`TaskCreated` の `reviewRerequest`。`restartRerequestedReviews`）。
    - 元タスクの完了状態・投稿・履歴・費用・実行セッションは変えない。
      新タスクは元のセッションを再開しない。
    - 前回レビューのスナップショットを、新タスクの `previousReview` に引き継ぐ。
    - `reviewRound` は前回の回数に 1 を足し、レビューの回数を続ける。
  - 依頼された人がレビューを投稿すると GitHub が依頼を外すので、ふつうは投稿で依頼が無くなる。
    検索の結果は反映が遅れる（投稿の直後に、外れた依頼が残る）ので、それだけでは再レビューしない。
    投稿で依頼が外れなかった（取り込みの後にアカウントを変えたなど）ときも、最後の依頼が投稿より前なので、投稿のたびに繰り返さない。
  - 同じ PR の最後に作ったタスクが投稿済みで完了している場合だけ、それを引き継ぎ元にする。
    古い完了タスクには戻らない。
    依頼の日時・アカウントと元タスクをイベントに保存し、同じ依頼の連続ポーリング・並行処理・デーモン再起動でも重複を作らない。
    新タスクの投稿完了後に届いた次の依頼は、さらに別のタスクにする。
  - 作業中・投稿の前・中止したタスク、ラベルで取り込んだタスク、sacty が作った PR のタスクは対象外。
    `reviewRequested` が Off なら確かめない。
  - 今の依頼先か依頼の日時を読めなければ、再レビューせずに `intake.rerequestUnchecked` を記録し、その検索の読んだ位置を進めない。
    次の取り込みで、同じ PR がまた見つかる。
    同じ PR は、1回の取り込みで1回だけ確かめる。
  - 同じ PR が複数アカウントの検索で見つかっても、タスクのアカウントと一致してから重複を除く。
  - PR のできごとは50ページまで読む。
    次のページが残っていれば取得不能として記録し、部分結果で再依頼を判定しない。
  - API を読んだ後に、取り込みが On で、担当アカウント・レビューの回・投稿の時刻が読む前と変わっていないことを確かめてから、新タスクを作る。
- sacty が作った PR（台帳にある、タスクの実装の PR・要求要件・設計の PR・ラベルを付けた PR。[PR のレビュー用のラベル](approval.md#pr-のレビュー用のラベル)）
  - レビュー用のラベルが付いていれば、作ったタスクとは別の、PR のレビューだけのタスクにする（`source.review: sacty`。オーケストレーターに工程を選ばせない）。
  - レビューの依頼にも当たっても `sacty` にする（そのレビューを作ったタスクに届けるため）。
  - レビュー用のラベルのトリアージを Off にしていれば、ラベルでは取り込まない（`sacty` にもしない）。
  - レビューの依頼からの取り込みは、別に動く。
    `reviewRequested` が On で、担当のプロジェクトで選んだアカウント本人への依頼があれば、sacty の PR でも `requested` として取り込む（その指摘のある回も、元のタスクに届く）。
  - 作ったタスクの取り込み元（Issue など）とは番号が違うので、作ったタスクがあることで取り込まれずに終わることはない。
    同じ PR は二度取り込まないので、1つの PR のレビューのタスクは1つ（PR を更新しても、新しいレビューのタスクは作らない）。
  - レビューのタスクが PR に投稿したレビューのうち、指摘のある回（修正が必要・提案あり。判定を読めなかった回も）のものは、作ったタスクの PR の指摘として取り込む（[PR の指摘の取り込み](approval.md#pr-の指摘の取り込み)）。
    依頼で取り込んだタスクや、本文に PR の URL を書いて手動で作ったレビューのタスクの投稿も同じ。
    指摘の無い回は取り込まない。
    レビューのタスクは PR を作らないので、それ自体はラベルの付く PR を増やさない。
- 担当のプロジェクトは、リポジトリの指定が Org の指定より優先（`responsibleProject`）。
  同じ Issue・PR（`<リポジトリ>#<番号>`）は二度取り込まない（上記のレビュー再依頼による新タスクを除く）。
- レート制限（403・429 で残りが 0 か `retry-after`）に当たったら、そのアカウントのほかの検索を飛ばす。
- アカウントを選んでいない取り込み元は検索せず、`github.accountRequired` を記録する。

コード: `apps/daemon/src/service.ts`（`intakeSources`・`importIssues`・`restartRerequestedReviews`・`sactyReviewsOf`・`saveSettings`）、`apps/daemon/src/github.ts`（`GitHubIssueSearch`）、`packages/core/src/projects.ts`（`SactySettings`・`TriageKind`・`responsibleProject`）、`packages/core/src/events.ts`（`TaskCreated`）、`packages/core/src/projection.ts`（`applyEvent`）

## JIRA のチケット

JIRA の接続先は、組織内 PF（`gateway.platforms`、無ければプロジェクトのコンテキストの `platforms.yaml`）として書く。
プロジェクトの `tickets` には、接続先（`platform`）・種類（`service`：`jira-cloud`｜`jira-server`）・プロジェクトのキー（`keys`、1〜50件）を書く。

- `ticketLabel` が付いた、終わっていないチケットを、次の JQL で探す。
  `project in ("<キー>", …) AND labels = "<ラベル>" AND statusCategory != Done ORDER BY created ASC`
  - Cloud は `GET /rest/api/3/search/jql`（`nextPageToken` で続き）を使う。
  - Server / Data Center は `GET /rest/api/2/search`（`startAt`）を使う。
  - 50件ずつ、最大10ページ読む。
- デーモンが読むのは、キーと要約（200 文字まで）だけ。
  PF の `allow` に無い API は、デーモンも呼ばない（`ticket.notAllowed`）。
- タスクの題は `<キー> <要約>`、`start: jira`。
  担当のプロジェクトは、キーの接頭辞（`PAY-123` の `PAY`）で決める。
  情報収集のエージェントがゲートウェイ経由でチケットを読み、リポジトリ・題・概要を決める（[タスクと工程](tasks-and-steps.md#トリアージを兼ねる)）。
- 同じ接続先の同じキーは、1つのプロジェクトにだけ書ける（プロジェクトのコンテキストの PF は、プロジェクトごとに別のものとして扱う）。

コード: `apps/daemon/src/tickets.ts`（`JiraTickets`・`ticketJql`）、`apps/daemon/src/service.ts`（`importTickets`・`gatherInformation`・`triageTicket`）、`packages/core/src/projects.ts`（`projectConflicts`・`responsibleTicketProject`）

## 取り込み元へのコメント

- 調査が目的のタスクを承認したら、結果を取り込み元にコメントする（`awaitingIssueComment`）。
  セキュリティの組み合わせ（`security-check`・`security-fix`）のタスクは、この調査の結果をコメントしない（レポートは攻撃の手がかりになるため。`isSecurityTask`。[タスクと工程](tasks-and-steps.md#セキュリティチェックとセキュリティ対応)）。
  下の JIRA の PR の URL のコメントは、これとは別で、セキュリティの組み合わせのタスクでも送る。
- GitHub
  - 目印 `<!-- sacty-investigation:<タスク ID> -->` を入れ、前に投稿したものがあれば二重に投稿しない。
  - 本文は 60000 文字まで。
  - 書き出した先の URL があれば添える。
  - 失敗は `IssueCommentFailed` に記録する。
- JIRA
  - 調査が目的のタスクの結果を、上のとおり1回コメントする（`POST /rest/api/2/issue/<キー>/comment`。記録は `IssueCommented`・`IssueCommentFailed`）。
  - PR を作ったタスク（中止したものを除く）は、これとは別に、PR の URL（と書き出した先の URL）を1回コメントする（`awaitingTicketPrComment`。記録は `TicketPullRequestCommented`）。
    調査の結果を含まないので、`security-fix` のタスクでも送る。
  - チケットの状態は変えない。

コード: `apps/daemon/src/service.ts`（`commentInvestigation`・`awaitingIssueComment`・`awaitingTicketPrComment`）、`apps/daemon/src/prompts.ts`（`investigationMarker`・`buildInvestigationComment`・`buildTicketPullRequestComment`）、`apps/daemon/src/tickets.ts`（`JiraTickets.comment`）

## GitHub のアカウントと API

- 使うアカウントは、プロジェクトの `githubAccounts`（ホストごと）で選ぶ。
  gh のアクティブなアカウントは使わない。
  選んでいなければ止める。
- アカウントの一覧とトークン
  - 一覧は `gh auth status --json hosts` で読む。
    トークンは、使うたびに `gh auth token --hostname <ホスト> --user <アカウント>` で読む。
  - 一覧には、gh がトークンを確かめられなかったアカウント（`state` が `error`・`timeout`）も、`state` と `error`（gh の理由）を添えて含める。
  - プロジェクトの設定の画面は、そのアカウントに「確認できず」と添えて選ばせ、読めたアカウントの一覧（ホスト・アカウント・状態）も見せる。
  - プロジェクトの設定の画面の「アカウントを読み直す」は、`GET /api/github/accounts` をもう一度呼び（gh auth status を確かめ直す）、編集中の入力を残したまま、選べるアカウントと一覧を置き換える。
    デーモンに届かない・30 秒で答え終わらなければ（本文を読み終えるまでを含む）、問い合わせを止め、一覧の代わりに理由を出す。もう一度押せる。
  - gh には、`GH_PROMPT_DISABLED=1`・`NO_COLOR=1` と、限られたホストの環境変数（設定・キーリング・プロキシ・CA の場所）だけを渡す。
    `GH_TOKEN`・`GITHUB_TOKEN`・`GH_ENTERPRISE_TOKEN` は渡さない。
- 対象のホストは、対象の URL（`https://<ホスト>/<owner>[/<name>]`）から読む。
  - 読む前に、全角の文字を NFKC で半角にし、見えない文字（ゼロ幅の空白・BOM）・クエリ・フラグメント・末尾の `/`・`.git` を除き、ホストを小文字にする。
  - 読めない対象はホストにならず、アカウントの欄にも出ない。
  - 読めない理由（SSH・http・ユーザー名などを含む・ホストの文字・余分なパス・Org とリポジトリの取り違え）は、入力の下と保存のときに示す。
- API は、github.com なら `https://api.github.com`、それ以外（GitHub Enterprise Server）は `https://<ホスト>/api/v3`。
- HTTPS のリポジトリの clone・プッシュでは、そのホストのアカウントのトークンを `http.https://<ホスト>/.extraheader` で渡す。
  SSH・ローカルのパスは、ホストの認証を使う。

コード: `apps/daemon/src/gh.ts`（`GhCliAuth`・`ghEnv`・`gitAuthEnv`）、`apps/web/src/components/project-editor.tsx`、`apps/web/src/app/actions.ts`（`reloadGitHubAccountsAction`）、`packages/core/src/github-url.ts`（`githubApiBase`・`targetUrlProblem`）、`apps/daemon/src/github.ts`
