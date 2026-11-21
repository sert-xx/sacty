# sacty mcp の create_task で、対象のリポジトリを指定できるようにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-474
- PR: なし
- ブランチ: なし
- 関係する ADR: [sacty mcp のタスクの作成は、対象のリポジトリを指定できるようにし、省いたときは指定しない（空欄）で作る](../adr/20261121-2310-mcp-create-task-with-target-repository.md)

## 目的

`create_task` で、対象のリポジトリを指定できるようにする。指定したタスクは、画面で対象リポジトリを入れて作ったときと同じに扱い、オーケストレーターに選ばせない。
指定できる値は `list_projects` から分かり、選ばれたリポジトリは要約（`get_task` など）から分かる。

## したこと

- `apps/daemon/src/task-mcp.ts`：`create_task` に省ける `repo` を足し、`CreateTaskInput.pick({ title, body, repo })` で検査して送る（省くと `null`）。
  `list_projects` と `create_task` の説明・`INSTRUCTIONS` に、渡せる値を書いた。要約（`TaskSummarySchema`・`summarizeTask`）に `repo` を足し、値の取り方を `repoOfTask` にまとめて `rerunDefaults` と共有した。
- `packages/cli/src/mcp.ts`：送る本文の `repo: null` の上書きをやめ、入力の `repo` をそのまま送る。
- 仕様書・ユーザー文書（日英）、ADR（`20261119-0100` を `superseded` にし、新しい ADR を足した）。
- 直さなかったもの：`packages/cli/src/index.ts` の使い方の表示（文書を案内するだけ）、デーモンの API・検査、画面。

## 確かめたこと

- `apps/daemon/src/task-mcp.test.ts`：指定したタスクが画面と同じ要求で作ったものと等しく `noRepo` が無いこと、Org の下の URL、省いたときの `repo: null`、対象に無い値・別プロジェクトが対象にする URL・形の誤り（`task.repositoryUnknown`）・空白だけの断り、`list_projects` と説明、要約の `repo`。
- `packages/cli/src/mcp.test.ts`：指定した `repo` が送る本文にそのまま入ること。
- 結果は、実装の説明に書く。

## 残したこと

- 複数のリポジトリの指定（`repos`）、進め方・テンプレート・イメージの指定。
- 要約の `repo` が `null` のとき、決まっていないのかリポジトリ無しで進むのかは分けていない。必要になったら真偽の項目を足す。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 設計の PR：`null` の意味の食い違い | 文書に「決まっていない、またはリポジトリ無しで進む・進んだ」と書いた |
| 設計の PR：版が揃わないときの振る舞い・互換の理由 | ADR の影響と仕様書に書いた（`repo` は既存の入力。元の項目が無ければ `null`。項目の追加は互換） |
| 設計の PR：Org の下の URL の信頼境界 | ADR の理由に、画面と同じ受け入れ・存在しない URL の結果・候補と照らさない理由を書いた |
