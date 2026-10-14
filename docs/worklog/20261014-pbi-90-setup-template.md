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
| （まだ無い） | — |

## 残したこと

- PR #97 がマージされたら、`task-templates.ts` の `DEPLOYMENT_ANSWER_HEADING` を `deployment.ts` の `DEPLOYMENT_HEADING` に
  まとめる（後にマージする側が追従する）。
