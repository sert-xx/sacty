**日本語** | [English](approval.en.md)

# 承認と差し戻し

承認ゲートのある工程は、人間が承認すると次の工程へ進む。承認は、sacty の画面で行うか、対象のリポジトリへの PR のマージで行う
（承認＝マージ）。差し戻すと、選んだ工程からやり直す。同じ工程への差し戻しが上限を超えると、エスカレーション（人間の判断待ち）になる。

関係する ADR: [「PR作成」の工程をなくし、実装の工程の中で PR を作って承認を待つ](../adr/20261015-1430-implement-step-opens-pull-request.md)、[取り込みを「Issue の取り込み」と「PR のレビューの取り込み」に分け、sacty の PR にはレビュー用のラベルを付ける](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md)、[sacty が作る PR に取り込むラベルを付け、別のタスクのレビューを元のタスクの PR の指摘として取り込む](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md)、[sacty が作る PR の本文を、リポジトリ・Org の PR テンプレートの見出しに沿って決まった規則で埋める](../adr/20261014-1517-pr-body-follows-repository-template.md)、[実装に変更が無ければ PR を作らず、人間が確かめて変更なしで完了にする](../adr/20261014-2216-superseded-complete-without-changes.md)

## 画面での承認

- 承認できるのは、状態が `awaiting_approval` か `escalated` で、工程が承認待ちの工程（`gate.step`）と同じで、画面が見ていた提出の回
  （`submission`）がいまの回と同じとき（違えば `gate.staleSubmission`）。
- 文書原稿と作業の成功結果は画面で承認する。作業には実行前の承認ゲートはなく、依頼に従って実行した後に結果の承認を待つ。実行開始後は差し戻せない。失敗や結果不明は承認して完了にせず、外部状態の確認が必要になる。
- 再現（`reproduce`）の承認待ち（再現できなかった）は承認できない。
- PR を作った工程（実装、PR のある要求要件・設計）は、画面からは承認できない（`gate.approveOnPullRequest`）。実装に変更が
  無く PR を作らなかった実装は、画面で承認する（下の「実装に変更が無いとき」）。
- 承認した成果は固定される（承認した工程の出力は、後から変わらない）。承認の後、次の工程が実行できる工程なら実行待ちに、
  そうでなければ `idle` にする。

コード: `apps/daemon/src/service.ts`（`approve`・`gateTask`・`nextAfterApproval`）、`packages/core/src/projection.ts`（`applyEvent` の `StepApproved`）

## PR での承認

要求要件・設計（`StepPullRequestKey`）と実装は、PR で承認する。実装の PR は、検証に通った後に、実装の工程の中で作る
（[タスクと工程](tasks-and-steps.md#検証に通った実装の-pr)）。承認・差し戻し・PR のマージでの承認・PR の指摘の取り込みの扱いは、3つの工程で同じ。

- PR で承認するタスクか（`stepPullRequestsOn`）：タスクブランチがあれば常に。無ければ、対象リポジトリがあり、画面で要求要件・設計を
  まだ提出しておらず、プロジェクトにそのホストの GitHub のアカウントがあるとき。
- タスクブランチ `sacty/task-<タスク ID の先頭8文字>` を、ベースブランチの起点のコミットから作る（`TaskBranchCreated`）。
- 要求要件・設計は、ファイル `<documentsDir>/<タスク ID の先頭8文字>/<工程>.md` にして、工程のブランチ `<タスクブランチ>-<工程>-<回>` から
  タスクブランチへの PR にする。`documentsDir` はオーケストレーターが決め、使えない形なら既定の `docs/sacty`（`DEFAULT_DOCUMENTS_DIR`）。
  ファイルの先頭に sacty が作った旨の HTML のコメントを入れ、設計にはテスト観点を含める。
- その工程の PR が開いていて、タスクブランチの先頭が変わっていなければ、同じ PR を更新する（その工程のやり直し）。PR がマージ済み・
  閉じられた、または前の工程の直しがマージされてタスクブランチが進んだときは、タスクブランチの最新から新しいブランチと PR を作り、
  開いていた前の PR を閉じる。PR を作れなければ、理由を記録して止める。
- 実装は、タスクブランチがあればタスクブランチの最新に積み、タスクブランチからベースブランチへの PR（実装の PR）にする。
  タスクブランチが無ければ、sacty のブランチ（`sacty/task-<タスク ID の先頭8文字>`）からベースブランチへの PR にする。
  タスクブランチに、要求要件・設計のファイル以外の変更が積まれていれば、公開を止める（`pr.taskBranchChanged`）。
- タスク分割の子タスクは、それぞれ自分のタスクブランチを持つ。
- 画面の「チェックする」の導線（`personAction`。タスクの詳細・タスクの一覧・ダッシュボードの「あなたの出番」・ヘッダーのお知らせ）は、
  `awaiting_approval` で、今の提出の PR（`gatePullRequest`）が `open` で、URL が `https://` で始まるとき（`reviewPullRequestUrl`）、
  その PR を新しいタブで開く（文言は「PR でチェックする」。sacty の承認の画面を挟まない。PBI-136）。エスカレーション（PR の指摘の戻し先の
  確認など）・PR が閉じられた・提出と違う内容でマージされた・無いときは、sacty の承認の画面（`/tasks/<ID>/review`）へ案内する。
  外部へ開くリンクは、見た目の「↗」と読み上げの「新しいタブで開く」で示す（`ActionLink`）。お知らせからは、プロジェクトを切り替えずに開く。
  ダッシュボード・お知らせでは、導線はタスクの題のリンクなので、題だけを省略し、印は省略の外に置く（長い題でも印が残る。PR #148 レビュー提案）。

コード（画面の導線）: `apps/web/src/lib/labels.ts`（`personAction`・`personLink`・`reviewPullRequestUrl`）、`apps/web/src/components/action-link.tsx`（`ActionLink`・`ExternalMark`）

## 実装に変更が無いとき

検証に通った実装の PR を作るとき、実装の作業領域が起点のコミットから何も変わっていなければ（`NothingToCommitError`）、PR を作らない。

- まだ実装の PR を作っていなければ、`NoChangesFound`（この後に提出する実装の回）を記録し、実装を提出する
  （`StepSubmitted`）。PR が無いので、画面で承認できる。すべてのタスクで同じ（テンプレートのタスクに限らない）。
- 提出の前に、ふつうと同じくテストと最終レビュー（観点ごとの検証）を通っている。画面は、承認待ちを「変更なしの実装の承認
  待ち」とし、承認の画面に、実装は何も変えていないこと・実装の説明で変更が要らない理由を確かめることを出す。
- 承認すると、PR を作らずに完了する（「完了（変更なし）」）。差し戻すと、ふつうと同じく実装からやり直し、変更があれば PR を作る。
  変更なしの扱いは、その提出回だけ（`deliveredWithoutChanges`：`noChanges.submission` が実装のいまの回で、PR が無い）。
- タスクブランチ（要求要件・設計の PR をマージしたもの）があっても同じ。ベースブランチへの PR は作らず、タスクブランチは残る。
- すでに実装の PR を作ったタスクで、作り直した実装に変更が無くなったときは、今までどおり理由（`pr.failed`・`git.nothingToCommit`）を
  記録して止める（開いている PR をどうするかは人が決める）。
- 実装の工程の指示に、変更が要らないとわかったらファイルを変えずに、理由と根拠を説明に書くよう入れている。

コード: `apps/daemon/src/service.ts`（`publish`）、`packages/core/src/events.ts`（`NoChangesFound`）、`packages/core/src/projection.ts`（`noChanges`・`deliveredWithoutChanges`）、`apps/daemon/src/prompts.ts`（`NO_CHANGE_LINE`）、`apps/web/src/lib/labels.ts`（`statusText`）

コード: `apps/daemon/src/service.ts`（`stepPullRequestsOn`・`taskBranchName`・`publishStepPullRequest`・`publish`）、`packages/core/src/events.ts`（`StepPullRequestKey`・`DEFAULT_DOCUMENTS_DIR`・`isDocumentsDir`）、`packages/core/src/projection.ts`（`stepDocumentPath`）、`apps/daemon/src/prompts.ts`（`buildStepDocument`）

## PR のレビュー用のラベル

sacty が作る PR すべて（実装の PR と、要求要件・設計の PR）に、作った直後にレビュー用のラベル（sacty の設定 `reviewLabel`）を付ける。
別のタスク（PR のレビューだけのタスク）として取り込ませ、作ったタスクとは別のコンテキストでレビューさせるため
（[チケットの取り込みと GitHub](intake.md)）。取り込むラベル（`intakeLabel`）は付けない。

- レビュー用のラベルを設定していない、またはそのトリアージを Off にしている（`triageOff` に `reviewLabel`。付けても取り込まれない）なら、
  付けない。何も記録しない。
- リポジトリにラベルが無ければ（`GET /repos/<owner>/<name>/labels/<ラベル>` が 404）、作ってから（`POST .../labels`、色 `0e8a16`）
  PR に付ける（`POST .../issues/<番号>/labels`）。作っている間にほかで作られた（422 の `already_exists`）ときは、そのまま付ける。
- 付けたら `PullRequestLabeled`（`created`：ラベルを作った）、付けられなければ `PullRequestLabelFailed`（どの操作が失敗したか
  `github.failed` の `getLabel`・`createLabel`・`addLabel` と、GitHub の答え。使った秘密の値は伏せる）を記録する。タスクの作業履歴の画面に出る。
  付けられなくても、PR の作成は失敗にしない（タスクはそのまま承認待ちに進む）。
- 1つの PR（リポジトリと番号）につき1回だけ。記録のある PR には、同じ PR を更新しても付けない（重ねて付けない・人が外したラベルを
  付け直さない・失敗しても付け直さない）。記録の無い PR（設定する前に作った PR など）は、次に更新したときに付ける。
  PR を作り直した（前の PR がマージ・クローズされて、新しい番号の PR を作った）ときは、新しい PR に付ける。
- 中止・一時停止を求められて、要求要件・設計の PR を記録しなかったときは付けない。
- 付ける予定を、PR の公開の記録（`PullRequestPublished`・`StepPullRequestPublished` の `label`）に残してから付ける。公開を
  記録した後、付ける前に止まった（停止・クラッシュ）PR は、PR の確認（60秒ごと。再起動の後も）で、予定があり、付けた・付けられなかった
  記録が無く、開いている PR に付ける。付けるのは、そのときの設定のレビュー用のラベル。中止したタスク、いまは付けない設定（レビュー用の
  ラベルが無い・そのトリアージが Off）なら付けない。同じ PR を付けている途中なら、重ねて付けない。
- それより前の記録の `intakeLabel`（取り込むラベルを付ける予定）は、読み込めるが、付ける予定としては扱わない（台帳は書き換えない）。

コード: `apps/daemon/src/service.ts`（`labelPullRequest`・`labelDue`・`resumePullRequestLabels`・`publishStepPullRequest`・`publish`）、`apps/daemon/src/github.ts`（`GitHubPullRequests.addLabel`）、`packages/core/src/projection.ts`（`pullRequestLabels`）

## PR の確認

デーモンは60秒ごとに、承認待ちの PR を確かめる（前の確認が終わるまで次を始めない）。

- マージされた：`PullRequestMerged` と `StepApproved`（どちらも actor `person`）を記録する。
  - sacty の提出と違う内容でマージされた（PR の先頭が sacty のコミットと違う）ときも承認にする（`edited`）。要求要件・設計は、マージした
    コミットからファイルを読み、人が直した版を承認した成果にする。ファイルが消された・読めないときは sacty の版を承認する。
    取得できなければ記録せず、次の確認でやり直す。
- マージされずに閉じられた：`PullRequestClosed` を記録し、承認にせず人間の判断を待つ（画面から承認はできない。差し戻すか中止する）。
- 開き直された：`PullRequestReopened` を記録して見守りを続ける。
- 確認の途中で状態・PR・コミットが変わったときは記録しない。
- 実装の PR のマージでは、マージの後の監視の工程を飛ばしていなければ、同じ追記でマージの後の監視を始める
  （[マージの後の監視](deployment-watch.md)）。確認の終わりに、監視を待っているタスクの CI/CD を確かめる（`checkDeployments`）。

コード: `apps/daemon/src/service.ts`（`checkPullRequests`・`readMergedDocument`）、`apps/daemon/src/pr-watcher.ts`（`PullRequestWatcher`）

## PR の本文と PR テンプレート

関係する ADR: [sacty が作る PR の本文を、リポジトリ・Org の PR テンプレートの見出しに沿って決まった規則で埋める](../adr/20261014-1517-pr-body-follows-repository-template.md)

sacty が PR を作る・更新するとき（実装の PR と、要求要件・設計の PR。マージの後の監視で作る修正のタスクの PR も同じ）は、そのたびに PR を作るリポジトリの PR テンプレートを探し、
あればその見出し・項目の形で本文を書く。無い・使えないときは、sacty の決まった形の本文（`buildPullRequestBody`・
`buildStepPullRequestBody`）にする。どちらでも PR の作成は止めない。

- 探す場所と順番（既定のブランチのもの。ファイル名・ディレクトリ名の大文字・小文字は区別しない）。前の順番で見つかったら、その時点で
  読み、後の順番のディレクトリ（`docs/` など）の一覧は取りに行かない：
  1. 対象のリポジトリの `.github/pull_request_template.md` → ルートの `pull_request_template.md` → `docs/pull_request_template.md`
  2. 1つも無ければ、同じ順の `PULL_REQUEST_TEMPLATE/` ディレクトリ（`.github/`・ルート・`docs/`）の中の `.md` のうち、名前の順
     （大文字・小文字を区別しない）で最初のもの。GitHub はディレクトリの複数のテンプレートを既定には使わないが、sacty は1つを選ぶ。
  3. 対象のリポジトリに無ければ、Org（またはユーザー）の `.github` リポジトリ（`https://<ホスト>/<owner>/.github`）の同じ場所。
     GitHub と同じく、公開（`private: false`）のものだけを使う。非公開なら使わず、その旨を残す。対象が `.github` リポジトリそのものなら探さない。
- 無いものとする：リポジトリ・ディレクトリの一覧が 404（空のリポジトリ・見えないリポジトリを含む）。
- 使えない（`unusable`）：一覧・ファイルの取得が 404 以外の失敗・通信の失敗・時間切れ（探す処理全体で30秒）、32 KiB
  （`TEMPLATE_MAX_BYTES`）より大きい（大きさは一覧の値で判断し、中身は読まない）、UTF-8 として読めない、空白だけ。対象のリポジトリで
  使えないときは、Org の `.github` は探さない。
- 埋め方（`fillTemplate`。エージェントは使わない）：
  - 見出し（`#`〜`######` の行と、行全体が太字の行 `**概要**`。コードブロック・HTML のコメントの中のものは除く）で分け、見出しの文から
    種類を決める（`CATEGORY_RULES`、上から順に当てる）：書けない見出し（チェックリスト・スクリーンショット・破壊的変更・その他など）、
    関係する Issue、テスト、変更、目的・概要。種類ごとに、最初に当たった見出しにだけ sacty の内容を入れる。
  - 見出しの中の説明・例の文とコードブロックは消し、HTML のコメントとチェックボックスは残す。チェックボックスは、テンプレートで
    チェックされていても、すべて外す（sacty は確かめていないので）。
  - 内容の無い見出し・当てはまらない見出しには「該当なし（sacty は記入していません）」（`NOT_APPLICABLE`）と書く。チェックボックスの
    ある見出しには書かない（外したチェックボックスだけを残す）。最初の見出しより前は、コメントとチェックボックスだけを残す。
  - 実装の PR の内容（`buildPullRequestBodyParts`）：目的は承認済みの要求要件（再現のタスクは不具合の再現）、変更は実装の工程の出力、
    テストは観点 → テスト → 実行結果の表とテストの結果、関係する Issue は `Closes #<番号>`（Issue から取り込んだタスク）。
    書き出した成果・要求要件・設計の PR・ゴールガーディアンの最終レビューは「sacty の記録」にする。
  - 要求要件・設計の PR の内容（`buildStepPullRequestBodyParts`）：目的は何の工程の成果か（と承認済みの前の工程）、変更は成果の
    ファイルと指摘への対応、関係する Issue は `#<番号>`（参照だけ。タスクブランチへのマージでは閉じない）。テストは無い。
  - 見出しに入らなかった内容と「sacty の記録」は、本文の末尾に折りたたみ（`<details>`）で置く。どの見出しにも内容を入れられなかった
    （見出しの無いテンプレートなど）ときは、目的・変更・テストは折りたたまずに置く。関係する Issue が見出しに入らなければ、
    最後の部分の前に置く。
  - 最後の部分（footer）には、sacty が作った旨とタスクの ID（`sacty task <ID>`）、マージがその工程の承認に
    なることと指摘の伝え方（実装の PR と、要求要件・設計の PR）を必ず入れる。
- 長さ（`limitBody`）：本文は 65,000 文字（`PR_BODY_MAX`。GitHub の上限 65,536 文字より少し短い。JavaScript の長さで測る）までにする。
  超えるときは、最後の部分の前の後ろを省き、省いた旨（`TRUNCATED_NOTE`）を書く。省いたところで閉じられていない HTML のコメント・
  コードブロック・折りたたみは閉じる。テンプレートを使わない本文（`buildPullRequestBodyText`・`buildStepPullRequestBodyText`）にも
  同じ上限を使い、最後の部分（sacty が作った旨と、マージが実装の承認になることの案内）は省かない。
  省けない部分（`keep`）：タスクの ID の行、`Closes #<番号>`（テンプレートの見出しに入れたものも）、要求要件・設計の PR のマージが
  承認になることの案内。省いた後の本文に、行として丸ごと（前後が行の境目）・HTML のコメントとコードブロックの外に残っていなければ、
  最後の部分の前に出し直す（`Closes #123` があっても `Closes #12` が残ったとは見なさない）。
- 秘密の値：その PR の作成で使った秘密の値（GitHub のトークンなど）を、本文から伏せる（`[REDACTED]`）。台帳に残す理由の文も伏せる。
- 台帳：`PullRequestPublished`・`StepPullRequestPublished` の `template` に、使ったテンプレート（`repo`：テンプレートのあった
  リポジトリの URL、`path`）か、決まった形にした理由（`fallback`：`none`・`unusable`、`message`：`pr.templateFailed`・
  `pr.templateTooLarge`・`pr.templateInvalid`・`pr.templateEmpty`・`pr.templateOrgPrivate` など）を残し、省いたら `truncated` を残す。
  タスクの画面の PR の欄に「本文」として出す。この版より前の記録には無い（画面には出さない）。

コード: `apps/daemon/src/pr-template.ts`（`GitHubPullRequestTemplates`・`fillTemplate`・`limitBody`・`CATEGORY_RULES`）、`apps/daemon/src/service.ts`（`pullRequestBody`・`publish`・`publishStepPullRequest`）、`apps/daemon/src/prompts.ts`（`buildPullRequestBodyParts`・`buildStepPullRequestBodyParts`・`buildPullRequestBodyText`・`buildStepPullRequestBodyText`）、`packages/core/src/events.ts`（`PullRequestTemplateUse`）、`apps/web/src/components/pull-request.tsx`（`TemplateUse`）

## PR の指摘の取り込み

- PR が開いていて承認待ちのとき、PR のレビュー・行へのコメント・通常のコメントを指摘として取り込む。最後のフィードバックから2分
  （`FEEDBACK_QUIET_MS`）待ってから、古い順に最大50件（`REMARKS_MAX`）、1件 2000 文字（`REMARK_MAX`）で取り込む
  （`PullRequestReviewImported`、actor `person`）。同じものは二度取り込まない。
- この PR をレビューした sacty のタスク（PR を指すタスク。取り込んだ PR か、本文の PR の URL）の投稿は、そのタスクのプロジェクトのアカウント
  （元のタスクのアカウントと違うことがある）と、目印（`<!-- sacty-review:<タスク ID>[:<回>] -->`）の回で判定する。bot の判定より先に見るので、
  そのアカウントが bot（GitHub App など）でも同じ。
  - レビュー用のラベルで取り込んだ、sacty が作った PR のレビューだけのタスク（`source.review: sacty`）の、修正が必要な回（`reviewVerdicts` の `verdict`
    が `changes_required` の回。判定を読めなかった回も、指摘を落とさないように含める）は、指摘として取り込む（作ったタスクとは別のタスクのレビューを、
    元のタスクに届けるため）。判定の決め方は [タスクと工程](tasks-and-steps.md#pr-のレビューだけのタスク)。
  - ほかの回（提案だけの回・指摘の無い回・まだ実行していない回）と、ほかのレビューのタスクの投稿は、アカウントが元のタスクと違っても取り込まない
    （差し戻さない。ゴールガーディアンも動かさない）。
  - 再レビューは回ごとに判定する。そのタスクのアカウントと違う人が目印を写したものは、人の指摘として扱う。
- それ以外では、bot の投稿と、元のタスクのプロジェクトのアカウントが投稿した、sacty のレビューの目印で始まるレビュー・行へのコメントは
  取り込まない。
- 取り込んだら、ゴールガーディアンが戻し先（その工程のやり直しか、前の工程への差し戻し）を判断し（`ReworkJudged`）、人の確認を挟まずに
  差し戻す。判断できなければ、戻せる工程の先頭（実装の PR なら実装、要求要件・設計ならその工程）をやり直す。

コード: `apps/daemon/src/service.ts`（`importFeedback`・`sactyReviewsOf`・`feedbackRemarks`・`FEEDBACK_QUIET_MS`・`settleReview`・`judgeRework`）、`apps/daemon/src/github.ts`（`GitHubPullRequests.feedback`）

## 差し戻し

- 戻せる工程（`reworkTargets`）：承認待ちの工程と、それより前の `REWORK_STEPS` を、近い順に並べたもの。`reproduce`・`investigate` は、それ自身が
  承認待ちのときだけ。統合レビューの承認待ちでは `split` だけ。戻し先を省くと先頭（実装の承認待ちなら `implement`）。
- 承認待ちでの差し戻しには、指摘が1件以上要る（`gate.remarksRequired`）。人は指摘を無効にでき、無効にした指摘はエージェントに渡さない。
- 前の工程に戻すと、その工程から後の承認を取り消し、検証の結果と失敗の回数を戻す。PR で承認したタスクでは、マージ済みの PR は戻さない。
- 最終レビュー・統合レビューに通ったものを人が差し戻すと、見逃し（`GuardianMissed`）を記録する。

コード: `apps/daemon/src/service.ts`（`requestChanges`・`voidRemark`）、`packages/core/src/projection.ts`（`reworkTargets`・`reopen`・`changeRounds`）

## エスカレーション

| 理由 | いつ |
| --- | --- |
| `too_many_changes` | 同じ工程への差し戻しが `MAX_CHANGE_REQUESTS`（3）回に達した後の差し戻し。書きかけの指摘は残す。上限を超えて続けるには、明示して差し戻す（`overLimit`） |
| `change_undecidable` | ゴールガーディアンが変更の申し出を判定できなかった。人が判断する（`ChangeDecided`） |
| `rework_confirmation` | 以前の版の記録（いまは記録しない） |

コード: `apps/daemon/src/service.ts`（`requestChanges`・`decideChange`）、`packages/core/src/events.ts`（`TaskEscalated`・`MAX_CHANGE_REQUESTS`）
