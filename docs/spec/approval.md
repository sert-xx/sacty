**日本語** | [English](approval.en.md)

# 承認と差し戻し

承認ゲートのある工程は、人間が承認すると次の工程へ進む。
人間は、sacty の画面か、対象のリポジトリへの PR のマージで承認する（承認＝マージ）。
差し戻すと、選んだ工程からやり直す。
同じ工程への差し戻しが上限を超えると、エスカレーション（人間の判断待ち）になる。

関係する ADR: [「PR作成」の工程をなくし、実装の工程の中で PR を作って承認を待つ](../adr/20261015-1430-superseded-implement-step-opens-pull-request.md)、[取り込みを「Issue の取り込み」と「PR のレビューの取り込み」に分け、sacty の PR にはレビュー用のラベルを付ける](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md)、[sacty が作る PR に取り込むラベルを付け、別のタスクのレビューを元のタスクの PR の指摘として取り込む](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md)、[sacty が作る PR の本文を、リポジトリ・Org の PR テンプレートの見出しに沿って決まった規則で埋める](../adr/20261014-1517-pr-body-follows-repository-template.md)、[実装に変更が無ければ PR を作らず、人間が確かめて変更なしで完了にする](../adr/20261014-2216-superseded-complete-without-changes.md)、[PR を参照する sacty のタスクの投稿は、取り込みの経路に関わらず、指摘のある回を元のタスクの PR の指摘として取り込む](../adr/20261025-2245-import-sacty-reviews-from-any-intake.md)、[実装の PR を最終レビューの前にドラフトで作り、CI を待ってからゴールガーディアンが判定し、合格したらドラフトを外してレビューへ進める](../adr/20261027-2330-draft-pull-request-before-final-review.md)

## 画面での承認

- 承認できるのは、次のすべてを満たすとき。
  - 状態が `awaiting_approval` か `escalated`
  - 工程が承認待ちの工程（`gate.step`）と同じ
  - 画面が見ていた提出の回（`submission`）がいまの回と同じ（違えば `gate.staleSubmission`）
- 文書原稿と作業の成功結果は画面で承認する。
  - 作業には実行前の承認ゲートはなく、依頼に従って実行した後に結果の承認を待つ。
  - 実行開始後は差し戻せない。
  - 失敗や結果不明は承認して完了にせず、外部状態の確認が必要になる。
- 再現（`reproduce`）の承認待ち（再現できなかった）は承認できない。
- PR を作った工程（実装、PR のある要求要件・設計）は、画面からは承認できない（`gate.approveOnPullRequest`）。
  実装に変更が無く PR を作らなかった実装は、画面で承認する（下の「実装に変更が無いとき」）。
- 承認した成果は固定される（承認した工程の出力は、後から変わらない）。
  承認の後、次の工程が実行できる工程なら実行待ちに、そうでなければ `idle` にする。

コード: `apps/daemon/src/service.ts`（`approve`・`gateTask`・`nextAfterApproval`）、`packages/core/src/projection.ts`（`applyEvent` の `StepApproved`）

## PR での承認

要求要件・設計（`StepPullRequestKey`）と実装は、PR で承認する。
実装の PR は、実装の工程の中で、最終レビューの前にドラフトで作り（[タスクと工程](tasks-and-steps.md#最終レビューの前の実装の-pr-と-ci)）、検証に通ったらドラフトを外す（[タスクと工程](tasks-and-steps.md#検証に通った実装の-pr)）。
承認・差し戻し・PR のマージでの承認・PR の指摘の取り込みの扱いは、3つの工程で同じ。

要求要件・設計・実装をすべて PR で承認するときのブランチは、次のようになる（タスク ID が 1a2b3c4d で始まる例）。

![PR で承認するときのブランチ](images/approval-branches.svg)

- PR で承認するタスクか（`stepPullRequestsOn`）
  - タスクブランチがあれば、常に PR で承認する。
  - 既存の PR を引き継ぐタスク（`Task.continuedPullRequest`）は、要求要件・設計を PR にしない（[既存の PR の引き継ぎ](tasks-and-steps.md#既存の-pr-の引き継ぎ)）。
  - タスクブランチが無ければ、次のすべてを満たすときに PR で承認する。
    - 対象リポジトリがある
    - 画面で要求要件・設計をまだ提出していない
    - プロジェクトにそのホストの GitHub のアカウントがある
- タスクブランチ `sacty/task-<タスク ID の先頭8文字>` を、ベースブランチの起点のコミットから作る（`TaskBranchCreated`）。
- 要求要件・設計の PR
  - sacty は成果をファイル `<documentsDir>/<タスク ID の先頭8文字>/<工程>.md` にし、工程のブランチ `<タスクブランチ>-<工程>-<回>` からタスクブランチへの PR にする。
  - `documentsDir` はオーケストレーターが決める。
    使えない形なら、既定の `docs/sacty`（`DEFAULT_DOCUMENTS_DIR`）を使う。
  - ファイルの先頭に sacty が作った旨の HTML のコメントを入れ、設計にはテスト観点を含める。
- 要求要件・設計の PR を作り直すか
  - その工程の PR が開いていて、タスクブランチの先頭が変わっていなければ、同じ PR を更新する（その工程のやり直し）。
  - 次のときは、タスクブランチの最新から新しいブランチと PR を作り、開いていた前の PR を閉じる。
    - PR がマージ済み・閉じられた
    - 前の工程の直しがマージされて、タスクブランチが進んだ
  - PR を作れなければ、理由を記録して止める。
- 実装の PR
  - タスクブランチがあれば、実装をタスクブランチの最新に積み、タスクブランチからベースブランチへの PR（実装の PR）にする。
  - タスクブランチが無ければ、sacty のブランチ（`sacty/task-<タスク ID の先頭8文字>`）からベースブランチへの PR にする。
  - タスクブランチに、要求要件・設計のファイル以外の変更が積まれていれば、公開を止める（`pr.taskBranchChanged`）。
  - 既存の PR を引き継ぐタスクは、PR を作らず、引き継いだ PR の元のブランチに積み、その PR を実装の PR にする。
- タスク分割の子タスクは、それぞれ自分のタスクブランチを持つ。
- 画面の「チェックする」の導線（`personAction`）
  - 導線は、タスクの詳細・タスクの一覧・ダッシュボードの「あなたの出番」・ヘッダーのお知らせにある。
  - 次のすべてを満たすとき、導線は PR を新しいタブで開く（`reviewPullRequestUrl`）。
    文言は「PR でチェックする」で、sacty の承認の画面を挟まない（PBI-136）。
    - 状態が `awaiting_approval`
    - 今の提出の PR（`gatePullRequest`）が `open`
    - PR の URL が `https://` で始まる
  - エスカレーションで、ゴールガーディアンが判定できなかった変更の申し出（`change_undecidable`。人がまだ決めていないもの。`openProposal`）があるときは、タスクの詳細の「変更の申し出と判定」（`/tasks/<ID>#proposals`）へ案内する。
  - 次のときは、sacty の承認の画面（`/tasks/<ID>/review`）へ案内する。
    - それ以外のエスカレーション（PR の指摘の戻し先の確認など）
    - 状態が `awaiting_approval` で、今の提出の PR が開いていない（閉じられた、またはマージの後で次の確認がまだ承認を記録していない）・無い
  - 外部へ開くリンクは、見た目の「↗」と読み上げの「新しいタブで開く」で示す（`ActionLink`）。
  - お知らせからは、プロジェクトを切り替えずに開く。
  - ダッシュボード・お知らせでは、導線はタスクの題のリンクなので、題だけを省略し、印は省略の外に置く。
    長い題でも印が残る（PR #148 レビュー提案）。

コード（画面の導線）: `apps/web/src/lib/labels.ts`（`personAction`・`personLink`・`reviewPullRequestUrl`）、`packages/core/src/projection.ts`（`openProposal`）、`apps/web/src/components/action-link.tsx`（`ActionLink`・`ExternalMark`）

コード: `apps/daemon/src/service.ts`（`stepPullRequestsOn`・`taskBranchName`・`publishStepPullRequest`・`publish`）、`packages/core/src/events.ts`（`StepPullRequestKey`・`DEFAULT_DOCUMENTS_DIR`・`isDocumentsDir`）、`packages/core/src/projection.ts`（`stepDocumentPath`）、`apps/daemon/src/prompts.ts`（`buildStepDocument`）

## 実装に変更が無いとき

検証に通った実装の PR を作るとき、実装の作業領域が起点のコミットから何も変わっていなければ（`NothingToCommitError`）、PR を作らない。

- まだ実装の PR を作っていなければ、`NoChangesFound`（この後に提出する実装の回）を記録し、実装を提出する（`StepSubmitted`）。
  PR が無いので、画面で承認できる。
  すべてのタスクで同じ（テンプレートのタスクに限らない）。
- 提出の前に、ふつうと同じくテストと最終レビュー（観点ごとの検証）を通っている。
  画面は、承認待ちを「変更なしの実装の承認待ち」とする。
  承認の画面には、実装は何も変えていないことと、実装の説明で変更が要らない理由を確かめることを出す。
- 承認すると、PR を作らずに完了する（「完了（変更なし）」）。
  差し戻すと、ふつうと同じく実装からやり直し、変更があれば PR を作る。
  変更なしの扱いは、その提出回だけ（`deliveredWithoutChanges`：`noChanges.submission` が実装のいまの回で、PR が無い）。
- タスクブランチ（要求要件・設計の PR をマージしたもの）があっても同じ。
  ベースブランチへの PR は作らず、タスクブランチは残る。
- すでに実装の PR を作ったタスクで、作り直した実装に変更が無くなったときは、今までどおり理由（`pr.failed`・`git.nothingToCommit`）を記録して止める。
  開いている PR をどうするかは人が決める。
- 実装の工程の指示には、変更が要らないとわかったらファイルを変えずに、理由と根拠を説明に書くよう入れている。

コード: `apps/daemon/src/service.ts`（`publish`）、`packages/core/src/events.ts`（`NoChangesFound`）、`packages/core/src/projection.ts`（`noChanges`・`deliveredWithoutChanges`）、`apps/daemon/src/prompts.ts`（`NO_CHANGE_LINE`）、`apps/web/src/lib/labels.ts`（`statusText`）

## PR のレビュー用のラベル

sacty は、作る PR すべて（実装の PR と、要求要件・設計の PR）に、レビュー用のラベル（sacty の設定 `reviewLabel`）を付ける。
要求要件・設計の PR は作った直後に、実装の PR はレビューへ進めるとき（ドラフトを外したとき）に付ける。
最終レビューの前のドラフトの間は付けない（記録の `label` も持たない）。
PR を別のタスク（PR のレビューだけのタスク）として取り込ませ、作ったタスクとは別のコンテキストでレビューさせるためである（[チケットの取り込みと GitHub](intake.md)）。
取り込むラベル（`intakeLabel`）は付けない。

- レビュー用のラベルを設定していなければ、付けない。
  何も記録しない。
- そのトリアージを Off にしていても（`triageOff` に `reviewLabel`）付ける。
  一時的に Off にした間に作った PR も、On に戻した時点で開いていれば取り込まれるようにするためである。
  Off の間は取り込まない。
  取り込みは `is:open is:pr` で探すので、Off の間にマージ・クローズした PR は取り込まれない。
- リポジトリにラベルが無ければ（`GET /repos/<owner>/<name>/labels/<ラベル>` が 404）、作ってから（`POST .../labels`、色 `0e8a16`）PR に付ける（`POST .../issues/<番号>/labels`）。
  作っている間にほかで作られた（422 の `already_exists`）ときは、そのまま付ける。
- 結果は次のとおり記録し、タスクの作業履歴の画面に出す。
  - 付けたら `PullRequestLabeled`（`created`：ラベルを作った）
  - 付けられなければ `PullRequestLabelFailed`。
    どの操作が失敗したか（`github.failed` の `getLabel`・`createLabel`・`addLabel`）と、GitHub の答えを持つ。
    使った秘密の値は伏せる。
  - 付けられなくても、PR の作成は失敗にしない（タスクはそのまま承認待ちに進む）。
- 付けるのは、1つの PR（リポジトリと番号）につき1回だけ。
  - 記録のある PR には、同じ PR を更新しても付けない。
    重ねて付けない・人が外したラベルを付け直さない・失敗しても付け直さない。
  - 記録の無い PR（設定する前に作った PR など）は、次に更新したときに付ける。
  - PR を作り直した（前の PR がマージ・クローズされて、新しい番号の PR を作った）ときは、新しい PR に付ける。
- 中止・一時停止を求められて、要求要件・設計の PR を記録しなかったときは付けない。
- 付ける予定を、PR の公開の記録（`PullRequestPublished`・`StepPullRequestPublished` の `label`）に残してから付ける。
  - 公開を記録した後、付ける前に止まった（停止・クラッシュ）PR には、PR の確認（60秒ごと。再起動の後も）で付ける。
    付けるのは、予定があり、付けた・付けられなかった記録が無く、開いている PR。
  - 付けるのは、そのときの設定のレビュー用のラベル。
  - 中止したタスクと、いまは付けない設定（レビュー用のラベルが無い）なら付けない。
  - 同じ PR を付けている途中なら、重ねて付けない。
- それより前の記録の `intakeLabel`（取り込むラベルを付ける予定）は、読み込めるが、付ける予定としては扱わない（台帳は書き換えない）。

コード: `apps/daemon/src/service.ts`（`labelPullRequest`・`labelDue`・`resumePullRequestLabels`・`publishStepPullRequest`・`publish`）、`apps/daemon/src/github.ts`（`GitHubPullRequests.addLabel`）、`packages/core/src/projection.ts`（`pullRequestLabels`）

## PR の確認

デーモンは60秒ごとに、今の提出の PR（`gatePullRequest`）があり、状態が承認待ち（`awaiting_approval`）かエスカレーション（`escalated`）のタスクの PR を確かめる（前の確認が終わるまで次を始めない）。

- マージされた：`PullRequestMerged` と `StepApproved`（どちらも actor `person`）を記録する。
  - sacty の提出と違う内容でマージされた（PR の先頭が sacty のコミットと違う）ときも承認にする（`edited`）。
  - 要求要件・設計は、マージしたコミットからファイルを読み、人が直した版を承認した成果にする。
    ファイルが消された・読めないときは sacty の版を承認する。
    取得できなければ記録せず、次の確認でやり直す。
- マージされずに閉じられた：`PullRequestClosed` を記録し、承認にせず人間の判断を待つ。
  画面から承認はできない（差し戻すか中止する）。
- 開き直された：`PullRequestReopened` を記録して見守りを続ける。
- 変わっていない：PR が開いたままで状態が `awaiting_approval` なら、レビュー・コメントを指摘として取り込む（[PR の指摘の取り込み](#pr-の指摘の取り込み)）。
- 確認の途中で状態・PR・コミットが変わったときは記録しない。
- 指摘の取り込みの間（ゴールガーディアンの判断の最中など）にマージされた・マージされずに閉じられたときは、差し戻さない。同じ確認の中で状態を読み直し、上のマージ・閉じられた場合として記録する（[PR の指摘の取り込み](#pr-の指摘の取り込み)）。
- 実装の PR のマージでは、マージの後の監視の工程を飛ばしていなければ、同じ追記でマージの後の監視を始める（[マージの後の監視](deployment-watch.md)）。
- 確認の終わりに、次を順に行う。
  1. コンテキストにする改修の PR がマージされたメモリーを消す（`cleanupPromotedMemories`。[メモリー](memory.md#コンテキストへの昇格)）。
  2. PR のレビューの取り込みのタスクのうち終わっていないものの PR を確かめ、マージされた・マージせずに閉じられたら中止する（`checkReviewPullRequests`）。
  3. 公開の後、ラベルを付ける前に止まった PR にラベルを付ける（`resumePullRequestLabels`。[PR のレビュー用のラベル](#pr-のレビュー用のラベル)）。
  4. 最終レビューの前に作った実装の PR の CI を待っているタスクの CI を確かめる（`checkVerificationCi`。[タスクと工程](tasks-and-steps.md#最終レビューの前の実装の-pr-と-ci)）。
  5. マージの後の監視を待っているタスクの CI/CD を確かめる（`checkDeployments`）。

コード: `apps/daemon/src/service.ts`（`checkPullRequests`・`readMergedDocument`・`cleanupPromotedMemories`・`checkReviewPullRequests`・`resumePullRequestLabels`・`checkVerificationCi`・`checkDeployments`）、`apps/daemon/src/pr-watcher.ts`（`PullRequestWatcher`）

## PR の本文と PR テンプレート

関係する ADR: [sacty が作る PR の本文を、リポジトリ・Org の PR テンプレートの見出しに沿って決まった規則で埋める](../adr/20261014-1517-pr-body-follows-repository-template.md)

sacty は PR を作る・更新するたびに、PR を作るリポジトリの PR テンプレートを探し、あればその見出し・項目の形で本文を書く。
対象は、実装の PR と、要求要件・設計の PR（マージの後の監視で作る修正のタスクの PR も同じ）。
テンプレートが無い・使えないときは、sacty の決まった形の本文（`buildPullRequestBody`・`buildStepPullRequestBody`）にする。
実装の PR の決まった形の本文（`buildPullRequestBodyText`）には、承認済みの要求要件・実装の工程の出力（見出し「変更」。出力が無ければ見出しも入れない）・書き出した成果・観点 → テスト → 実行結果・ゴールガーディアンの最終レビューを、この順に入れる。
テンプレートに沿わせるときと同じく、実装のエージェントが実装の説明に書いたこと（表・人に確かめることなど）が PR の本文に残る。
どちらでも PR の作成は止めない。

### テンプレートを探す

探すのは既定のブランチのもの。
ファイル名・ディレクトリ名の大文字・小文字は区別しない。
前の順番で見つかったら、その時点で読み、後の順番のディレクトリ（`docs/` など）の一覧は取りに行かない。

1. 対象のリポジトリの `.github/pull_request_template.md` → ルートの `pull_request_template.md` → `docs/pull_request_template.md`
2. 1つも無ければ、同じ順の `PULL_REQUEST_TEMPLATE/` ディレクトリ（`.github/`・ルート・`docs/`）の中の `.md` のうち、名前の順（大文字・小文字を区別しない）で最初のもの。
   GitHub はディレクトリの複数のテンプレートを既定には使わないが、sacty は1つを選ぶ。
3. 対象のリポジトリに無ければ、Org（またはユーザー）の `.github` リポジトリ（`https://<ホスト>/<owner>/.github`）の同じ場所。
   GitHub と同じく、公開（`private: false`）のものだけを使う。
   非公開なら使わず、その旨を残す。
   対象が `.github` リポジトリそのものなら探さない。

テンプレートが無い・使えないと判断する条件は次のとおり。

- 無いものとする：リポジトリ・ディレクトリの一覧が 404（空のリポジトリ・見えないリポジトリを含む）。
- 使えない（`unusable`）
  - 一覧・ファイルの取得が 404 以外の失敗・通信の失敗・時間切れ（探す処理全体で30秒）
  - 32 KiB（`TEMPLATE_MAX_BYTES`）より大きい（大きさは一覧の値で判断し、中身は読まない）
  - UTF-8 として読めない
  - 空白だけ
- 対象のリポジトリで使えないときは、Org の `.github` は探さない。

### テンプレートを埋める

埋めるのは `fillTemplate` で、エージェントは使わない。

- 見出しで分け、見出しの文から種類を決める。
  - 見出しは、`#`〜`######` の行と、行全体が太字の行 `**概要**`。
    コードブロック・HTML のコメントの中のものは除く。
  - 種類は `CATEGORY_RULES` を上から順に当てて決める。
    種類は、書けない見出し（チェックリスト・スクリーンショット・破壊的変更・その他など）、関係する Issue、テスト、変更、目的・概要。
  - 種類ごとに、最初に当たった見出しにだけ sacty の内容を入れる。
- 見出しの中の説明・例の文とコードブロックは消し、HTML のコメントとチェックボックスは残す。
  チェックボックスは、テンプレートでチェックされていても、すべて外す（sacty は確かめていないので）。
- 内容の無い見出し・当てはまらない見出しには「該当なし（sacty は記入していません）」（`NOT_APPLICABLE`）と書く。
  チェックボックスのある見出しには書かない（外したチェックボックスだけを残す）。
  最初の見出しより前は、コメントとチェックボックスだけを残す。
- 実装の PR の内容（`buildPullRequestBodyParts`）
  - 目的：承認済みの要求要件（再現のタスクは不具合の再現）
  - 変更：実装の工程の出力
  - テスト：観点 → テスト → 実行結果の表とテストの結果
  - 関係する Issue：`Closes #<番号>`（Issue から取り込んだタスク）
  - 書き出した成果・要求要件・設計の PR・ゴールガーディアンの最終レビューは「sacty の記録」にする。
- 要求要件・設計の PR の内容（`buildStepPullRequestBodyParts`）
  - 目的：何の工程の成果か（と承認済みの前の工程）
  - 変更：成果のファイルと指摘への対応
  - 関係する Issue：`#<番号>`（参照だけ。タスクブランチへのマージでは閉じない）
  - テストは無い。
- 見出しに入らなかった内容と「sacty の記録」は、本文の末尾に折りたたみ（`<details>`）で置く。
  どの見出しにも内容を入れられなかった（見出しの無いテンプレートなど）ときは、目的・変更・テストは折りたたまずに置く。
  関係する Issue が見出しに入らなければ、最後の部分の前に置く。
- 最後の部分（footer）には、次を必ず入れる。
  - sacty が作った旨とタスクの ID（`sacty task <ID>`）
  - マージがその工程の承認になることと、指摘の伝え方（実装の PR と、要求要件・設計の PR）

### 長さ・秘密の値・台帳

- 長さ（`limitBody`）
  - 本文は 65,000 文字（`PR_BODY_MAX`）までにする。
    GitHub の上限 65,536 文字より少し短く、JavaScript の長さで測る。
  - 超えるときは、最後の部分の前の後ろを省き、省いた旨（`TRUNCATED_NOTE`）を書く。
    省いたところで閉じられていない HTML のコメント・コードブロック・折りたたみは閉じる。
  - テンプレートを使わない本文（`buildPullRequestBodyText`・`buildStepPullRequestBodyText`）にも同じ上限を使う。
    最後の部分（sacty が作った旨と、マージが実装の承認になることの案内）は省かない。
  - 省けない部分（`keep`）は、タスクの ID の行、`Closes #<番号>`（テンプレートの見出しに入れたものも）、要求要件・設計の PR のマージが承認になることの案内。
    省いた後の本文に、これらが行として丸ごと（前後が行の境目）・HTML のコメントとコードブロックの外に残っていなければ、最後の部分の前に出し直す。
    `Closes #123` があっても `Closes #12` が残ったとは見なさない。
- 秘密の値：その PR の作成で使った秘密の値（GitHub のトークンなど）を、本文から伏せる（`[REDACTED]`）。
  台帳に残す理由の文も伏せる。
- 台帳：`PullRequestPublished`・`StepPullRequestPublished` の `template` に、次を残す。
  - 使ったテンプレート（`repo`：テンプレートのあったリポジトリの URL、`path`）
  - または、決まった形にした理由（`fallback`：`none`・`unusable`、`message`：`pr.templateFailed`・`pr.templateTooLarge`・`pr.templateInvalid`・`pr.templateEmpty`・`pr.templateOrgPrivate` など）
  - 省いたら `truncated`
  - タスクの画面の PR の欄に「本文」として出す。
    この版より前の記録には無い（画面には出さない）。

コード: `apps/daemon/src/pr-template.ts`（`GitHubPullRequestTemplates`・`fillTemplate`・`limitBody`・`CATEGORY_RULES`）、`apps/daemon/src/service.ts`（`pullRequestBody`・`publish`・`publishStepPullRequest`）、`apps/daemon/src/prompts.ts`（`buildPullRequestBodyParts`・`buildStepPullRequestBodyParts`・`buildPullRequestBodyText`・`buildStepPullRequestBodyText`）、`packages/core/src/events.ts`（`PullRequestTemplateUse`）、`apps/web/src/components/pull-request.tsx`（`TemplateUse`）

## PR の指摘の取り込み

- PR が開いていて承認待ちのとき、PR のレビュー・行へのコメント・通常のコメントを指摘として取り込む（`PullRequestReviewImported`、actor `person`）。
  - 最後のフィードバックから2分（`FEEDBACK_QUIET_MS`）待ってから取り込む。
  - 古い順に最大50件（`REMARKS_MAX`）、1件 2000 文字（`REMARK_MAX`）まで。
  - 同じものは二度取り込まない。
  - 引き継いだ既存の PR では、実装の工程の指示に渡した指摘を取り込まない（実装に対応させたため。[既存の PR の引き継ぎ](tasks-and-steps.md#既存の-pr-の引き継ぎ)）。
- この PR をレビューした sacty のタスク（PR を指すタスク。取り込んだ PR か、本文の PR の URL）の投稿は、2つで判定する。
  そのタスクのプロジェクトのアカウント（元のタスクのアカウントと違うことがある）と、目印（`<!-- sacty-review:<タスク ID>[:<回>] -->`）の回である。
  bot の判定より先に見るので、そのアカウントが bot（GitHub App など）でも同じ。
  - そのタスクの、指摘のある回は、指摘として取り込む。
    取り込みの経路（レビュー用のラベル（`source.review: sacty`）・レビューの依頼（`requested`）・手動で作ったタスク（`source` 無し）など）は問わない。
    どれも、人が求めたレビューにあたるためである。
    指摘のある回は、`reviewVerdicts` の `verdict` が `changes_required` か `suggestions` の回。
    判定を読めなかった回も、指摘を落とさないように含める。
    作ったタスクとは別のタスクのレビューを、元のタスクに届けて対応させるためである。
    提案だけの回も取り込み、繰り返しの費用は予算で止める。
    判定の決め方は [タスクと工程](tasks-and-steps.md#pr-のレビューだけのタスク)。
  - ほかの回（指摘の無い回と、判定の記録が無い回。まだ実行していない回や、PR を参照するだけでレビューの工程を持たないタスクの回）は、アカウントが元のタスクと違っても取り込まない。
    差し戻さず、ゴールガーディアンも動かさない。
  - 再レビューは回ごとに判定する。
    そのタスクのアカウントと違う人が目印を写したものは、人の指摘として扱う。
- それ以外では、次の投稿を取り込まない。
  - bot の投稿
  - 元のタスクのプロジェクトのアカウントが投稿した、sacty のレビューの目印で始まるレビュー・行へのコメント
- 取り込んだら、ゴールガーディアンが戻し先（その工程のやり直しか、前の工程への差し戻し）を判断し（`ReworkJudged`）、人の確認を挟まずに差し戻す。
  判断できなければ、戻せる工程の先頭（実装の PR なら実装、要求要件・設計ならその工程）をやり直す。
- 戻し先と一緒に、差し戻しの原因（`cause`）も判断させる（[差し戻し](#差し戻し)）。
  `guardian_missed`・`new_request`・`base_changed` のどれかで、判断できなければ（答えが無い・`undecidable`・知らない値）原因を決めない（原因が分からない差し戻しとして数える）。
  判断は `ReworkJudged` の `cause` に残し、差し戻し（`ChangesRequested`）に引き継ぐ。
- 差し戻す直前に、PR の状態をもう一度読む（判断の最中や、判断を記録した後の再開で、人がマージ・クローズしていることがあるため）。
  - 開いたままなら、差し戻す。
  - マージされた・マージされずに閉じられたなら、差し戻さない。取り込んだ指摘（`PullRequestReviewImported`）と判断（`ReworkJudged`）は作業履歴に残し、同じ確認の中で状態を確かめ直して、[PR の確認](#pr-の確認)の「マージされた」「マージされずに閉じられた」として記録する（マージなら `PullRequestMerged` と `StepApproved`。`StepApproved` が、反映の途中の指摘の状態を消す）。
  - マージされずに閉じられた後に開き直されたら、記録した判断のまま差し戻す（判断し直さない）。
  - 読み直しの間に、人が差し戻した・中止したなどで状態が変わっていれば、記録しない。読めなければ、次の確認でやり直す。
  - マージの後に届いた指摘を、続きのタスクにするなどはしない。

コード: `apps/daemon/src/service.ts`（`importFeedback`・`sactyReviewsOf`・`feedbackRemarks`・`FEEDBACK_QUIET_MS`・`settleReview`・`judgeRework`）、`apps/daemon/src/github.ts`（`GitHubPullRequests.feedback`）

## 差し戻し

- 戻せる工程（`reworkTargets`）は、承認待ちの工程と、それより前の `REWORK_STEPS` を、近い順に並べたもの。
  - `reproduce`・`investigate` は、それ自身が承認待ちのときだけ。
  - 統合レビューの承認待ちでは `split` だけ。
  - 戻し先を省くと先頭（実装の承認待ちなら `implement`）。
- 承認待ちでの差し戻しには、指摘が1件以上要る（`gate.remarksRequired`）。
  人は指摘を無効にでき、無効にした指摘はエージェントに渡さない。
- 前の工程に戻すと、その工程から後の承認を取り消し、検証の結果と失敗の回数を戻す。
  PR で承認したタスクでは、マージ済みの PR は戻さない。
- 差し戻しには、原因（`ReworkCause`。`ChangesRequested` の `cause`）を付けられる。省略すると、原因を決めない差し戻しとして記録し、集計では「原因が分からない」差し戻しに数える。
  - 人は、承認の画面の「差し戻しの原因」で選ぶ（初めは「選ばない」）。人が承認の画面（API の `request-changes`）で差し戻す流れは、戻し先を人が選ぶのでゴールガーディアンの判断（`judgeRework`）を通らない。選ばなければ原因を判断させず、原因が分からない差し戻しになる（判断のためだけに実行を増やさない）。
  - PR の指摘の差し戻しは、ゴールガーディアンが戻し先と一緒に判断した原因を使う（`settleReview`）。
  - 原因は、作業履歴の差し戻しの行と、PR の欄の戻し先（PR の指摘のとき。`prRework` の `cause`）に出す。
  - 上限でエスカレーションになる差し戻し（`TaskEscalated`）には、原因を残さない。上限を超えて差し戻すときに、あらためて選ぶ。
- 見逃し（`GuardianMissed`）を記録するのは、原因が `guardian_missed` で、差し戻した成果物が最終レビュー（実装の承認待ち）・統合レビュー（統合レビューの承認待ち）に合格していたときだけ。
  - 原因が `new_request`・`base_changed` のとき、原因を決めないときは記録しない（原因を決めない差し戻しは、見逃しかどうか分からないものとして、集計の「原因が分からない」に出す。見逃しの数の横で見られる）。
  - 同じレビューの見逃しは1回だけ記録する。
  - 原因を記録する前の作業履歴は、そのまま読める（原因を持たない差し戻しは、集計で、直前に見逃しの記録（`GuardianMissed`）があれば見逃し、無ければ「原因が分からない」として扱う。記録済みの見逃しは、見逃しのまま数える）。

| 原因（`ReworkCause`） | 意味 |
| --- | --- |
| `guardian_missed` | ゴールガーディアンが、確かめられたはずの不備を見逃した |
| `new_request` | 承認済みの要求要件・設計に無い、人が新しく足した要望や方針の変更 |
| `base_changed` | ベースブランチが進んだこと（先の PR のマージなど）による競合・衝突で、成果物そのものの不備ではない |

- 人は差し戻しと一緒に、工程のイメージ・エージェントを変えられる（`RequestChangesInput` の `images`・`agents`）。
  タスクの詳細で変えるとき（`changeStepImage`・`changeStepAgent`）と同じ確かめをして、`StepImageChanged`・`StepAgentChanged` を差し戻し（`ChangesRequested`）・上限でのエスカレーション（`TaskEscalated`）の前に同じ書き込みで記録する（今と同じ名前は記録しない）。
  1つでも誤っていれば、差し戻しも含めて何も記録せずに断る。
  画面は、やり直す工程とそれより後の工程（飛ばした工程を除く）を出し、折りたたみを開いたときに候補を読む（`/step-options`）。人が変えた工程だけを送る（`changedStepChoices`）。
- 差し戻しの指摘の本文は、承認待ちでなくても、タスクの詳細の作業履歴の差し戻しの行の「詳細」で読める（[画面の文言と補足](ui-wording.md)）。

コード: `apps/daemon/src/service.ts`（`requestChanges`・`stepSettingChanges`・`voidRemark`）、`packages/core/src/events.ts`（`ReworkCause`・`RequestChangesInput`）、`packages/core/src/projection.ts`（`reworkTargets`・`reopen`・`changeRounds`）、`apps/daemon/src/prompts.ts`（`buildReworkPrompt`・`extractRework`）、`apps/web/src/lib/labels.ts`（`describeEventParts`）、`apps/web/src/components/gate-form.tsx`（`GateStepSettings`）

## エスカレーション

| 理由 | いつ |
| --- | --- |
| `too_many_changes` | 同じ工程への差し戻しが `MAX_CHANGE_REQUESTS`（3）回に達した後の差し戻し。書きかけの指摘は残す。上限を超えて続けるには、明示して差し戻す（`overLimit`） |
| `change_undecidable` | ゴールガーディアンが変更の申し出を判定できなかった。人が判断する（`ChangeDecided`） |
| `rework_confirmation` | 以前の版の記録（いまは記録しない） |

コード: `apps/daemon/src/service.ts`（`requestChanges`・`decideChange`）、`packages/core/src/events.ts`（`TaskEscalated`・`MAX_CHANGE_REQUESTS`）
