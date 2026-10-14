# タスクのテンプレート「Sacty セットアップ」で、リポジトリを選ぶだけでエージェントの設定を整えるタスクを作る

- 日付: 2026-10-14（UTC）
- タスク: PBI-90
- PR: #100
- ブランチ: feat/issue-90-setup-template
- 関係する ADR: [タスクのテンプレート「Sacty セットアップ」で、リポジトリを sacty で扱うためのエージェントの設定を整える](../adr/20261014-1530-task-template-sacty-setup.md)

## 目的

タスクの作成の画面でテンプレート「Sacty セットアップ」を選び、リポジトリを選ぶだけで、そのリポジトリを sacty で扱うための
エージェントの設定（エージェント向けの指示・テストの実行の仕方・テストに要るサービス・デプロイの確認のスキル `deployment-observer`）を
検査して整える PR を作るタスクができるようにする。題と説明は sacty が決め、作った後は通常のタスクと同じ流れで進む。整っていれば
PR を作らずに検査の結果を残して終えられる。テンプレートで作ったことは画面でわかり、API からも作れる。

## したこと

- core：`TaskTemplate`（`sacty-setup`）、テンプレートの入力 `CreateTemplateTaskInput`（`template`・`projectId`・`repo` だけ。
  ほかの項目は誤り）、`TaskCreated` と投影の `Task` の `template`、文言 `task.templateRepositoryRequired` を足した。
- デーモン：`createTask` は本文に `template` があれば `createTemplateTask` で作る。対象リポジトリは必須（対象がリポジトリ1つなら
  省略できる）で、対象の中かの確かめは通常のタスクと共通にした（`projectRepository`）。題と説明（ゴール）は
  `apps/daemon/src/task-templates.ts` の `templateTask` が決める。
- ゴールの文：特定の言語・ツール・sacty 自身に寄せない。スキルは `.agents/skills/` を原本、`.claude/skills/<名前>` を
  `../../.agents/skills/<名前>` への相対のシンボリックリンクにさせる。`deployment-observer` は、マージの後の監視（PBI-89・PR #97）が
  探す置き場所・名前、読む答えの形（見出し `sacty-deployment` の JSON、`healthy`・`unhealthy`・`unknown`）に合わせた。整っていれば
  調査だけ（`investigate`）で終えるよう書いた。リポジトリの URL は行の末尾に置いた（画面の Markdown で、後ろの全角の括弧までリンクに
  なったため）。
- 画面：タスクの作成のダイアログにテンプレートの選択（なし・Sacty セットアップ）を足し、選ぶと題・内容の欄を消して、説明と必須の
  対象リポジトリだけにした。詳細の先頭・一覧の開始地点・作業履歴の「タスクを作成」にテンプレートの名前を出す。
- CLI：今の CLI にはタスクを作るコマンドが無いので、足さなかった（入口は画面と API。ADR に理由を書いた）。
- docs：仕様書（`docs/spec/tasks-and-steps.md` の「タスクのテンプレート」）、ユーザードキュメント（`docs/user/tasks.md`）、ADR を足した。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`（0）・`npx vitest run`（53 ファイル・1246 件が通過）・`npm run build`（0）・
  `npx vitest run tests/docs`（66 件が通過）。
- 足したテスト：テンプレートでの作成（題・ゴール・記録・再起動の後の復元）、ゴールが特定の言語・ツールの語を含まない、入力の誤り
  （題・説明・`null`・空・知らないテンプレート・対象の外・Org の対象で省略）、オーケストレーターが調査だけを選んだら PR を作らずに完了、
  API（201・400・409）、画面のアクション（題・内容を渡さない・空欄のリポジトリ・「なし」は通常のタスク）、作業履歴の行。
- 修正を1つずつ戻すと、対応するテストが落ちることを確かめた（投影の `template`・入力の `strict`・リポジトリの必須・スキルの置き場所・
  画面のアクションの分岐・作業履歴の行）。
- 画面：一時的な SACTY_HOME・ポート 4795/4796、偽の gh・docker、名前の引けないホスト（`git.example.test`）のリポジトリで起動し、
  ダイアログでテンプレートを選んで作る → 詳細のテンプレートの名前とゴール → 一覧 → 本物の TaskService の流れ（偽のリポジトリ・
  エージェント）で調査だけで終えたタスク（PR なし、検査の結果）を動画に撮った。ダイアログで作ったタスクは、リポジトリが無いので
  clone で止まる（動作確認の環境のため）。
- 確かめていないこと：本物のエージェントがこのゴールで、実際のリポジトリに合った設定と `deployment-observer` を作れるか。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| PR #96（PBI-88）・#97（PBI-89）のマージで main とぶつかった | main をマージし、`TaskCreated` の `template` と `fix`、投影、テストの describe を両方残した |
| `DEPLOYMENT_ANSWER_HEADING` が #97 の `DEPLOYMENT_HEADING` と重複している | `deployment.ts` の `DEPLOYMENT_HEADING` を使い、スキルの名前・置き場所・リンク先も `DEPLOYMENT_SKILL_PATHS` から作るようにした（同じ値を2か所に持たない） |
| ゴールの置き場所・答えの形が #97 の実装と一致しているか | `task-templates.test.ts` を足した。ゴールのとおりに置いたスキルを `resolveInRepository` が原本に解決すること、ゴールの答えの例を `extractDeploymentCheck` が読めることを確かめる（リンク先・答えの形を壊すと落ちることも確かめた） |

マージの後に、`npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`・`npm run build`・`npx vitest run tests/docs` を
通した：lint 0、typecheck 0、56 ファイル・1316 件が通過、build 0、docs 66 件が通過。ユーザードキュメントの
`docs/user/deployment-watch.md` の「スキル」から、このテンプレートへ案内した。

### PR #100 のレビュー（変更が要らないとわかったときの完了の経路）

| 指摘 | 対応 |
| --- | --- |
| 「変更が要らなければ PR なしで終える」が最初の工程の選び方だけに頼っている。`standard`・`skip-design` を選んだ後に変更が要らないとわかると、`publish()` の `NothingToCommitError` で止まる | PR作成の工程で変更が無ければ、まだ実装の PR を作っていないタスクでは PR を作らずに `NoChangesFound` を記録し、成果物チェックで人間が確かめるようにした（承認で「完了（変更なし）」、差し戻しで実装をやり直す）。すべてのタスクで同じにし、ふつうのタスクで失敗が完了に見えないよう、人間の承認を挟み、画面に「変更なし」と出す。決めたことは ADR [実装に変更が無ければ PR を作らず、人間が確かめて変更なしで完了にする](../adr/20261014-2216-complete-without-changes.md) と仕様書（`docs/spec/approval.md`）に書いた |

- 実装の工程の指示と、セットアップのゴールに、変更が要らないとわかったらファイルを変えずに理由と根拠を書くよう足した。
- 結合テスト（設計まで進めた後に実装が何も変えない → 変更なしの成果物チェック → 承認で完了・PR なし・再起動の後も同じ／差し戻すと
  実装をやり直して PR を作る／PR を作った後の作り直しで変更が無くなったら今までどおり止める）と、画面の表示のテストを足した。
- 修正を戻すと落ちることを確かめた（変更なしの経路・PR を作った後の条件・実装の指示・提出回の照合）。
- PR #99（PBI-87）のマージで main とぶつかったので、main をマージし、両方のテストを残した。
- 画面：承認待ちの文言・承認の画面の案内・完了の表示が変わるので、動画を撮り直した。

## 残したこと

- なし
