<!-- sacty task 6fc351ff-d6fa-4434-a901-e1babe9355cf の設計。sacty が作成しました。 -->

# 設計：MCP の create_task で対象のリポジトリを指定する

## スコープ

`create_task` に省略できる引数 `repo` を足します。
指定したときは、画面で対象リポジトリを入れて作ったときと同じ要求を送ります。
`list_projects` の説明で指定できる値を示し、タスクの要約に対象のリポジトリの項目を足します。

- 対象
  - `apps/daemon/src/task-mcp.ts`：`create_task` の引数・説明、`list_projects` の説明、要約の `repo`、`INSTRUCTIONS`
  - `packages/cli/src/mcp.ts`：送る本文の `repo`
  - 両方のテスト、日英の `docs/spec/mcp-server.md`・`docs/user/mcp.md`、ADR（一部の置き換え）、作業履歴
- 対象外
  - 複数のリポジトリの指定（`repos`）
  - Org の対象を、GitHub を読んで個々のリポジトリに広げること
  - デーモンの API・検査（`prepareTask`）と画面の変更
  - `packages/cli/src/index.ts` の使い方の表示（文書を案内するだけで、ツールの一覧が無い）

## 確認したいこと

### must

- Org の対象のプロジェクトで、`list_projects` が示す値を Org の URL だけにし、Org の下の URL を画面と同じく受け入れてよいか。
  - 推奨：はい。説明に「Org の対象なら、その Org の下のリポジトリの URL を指定できる」と書く。Org を対象に登録した時点で、その下のリポジトリを作業対象にすることを許しているため、MCP の層で候補と照らさない。
  - 存在しない URL を指定すると、作成は通り、タスクの開始時の clone で失敗して一時停止（エラー）になる。エージェントは実行しない（費用はかからない）。
  - 懸念：Org の対象のプロジェクトでは、AI が利用者からリポジトリ名を聞くか、推測することになる。候補と照らすなら `GET /api/projects/:id/repositories` を呼ぶ作りを足し、GitHub を読む時間と失敗の扱いが加わる。

### should

- 指定は1つ（`repo`）だけでよいか。
  - 推奨：はい。受け入れ条件は「対象のリポジトリの指定」で、1つで足りる。
  - 懸念：複数のリポジトリにまたがる仕事は、今までどおり画面で作ることになる。後で要れば `repos` を足す（引数・断り・要約を直す追加の作業）。
- 要約の `repo` で、「まだ決まっていない」と「リポジトリ無しで進む・進んだ」を分けなくてよいか。
  - 推奨：分けない。どちらも `null` にし、文書に「`null` は、決まっていない、またはリポジトリ無しで進む・進んだ」と書く。受け入れ条件5が求めるのは「決まっていないと分かる」ことだけ。
  - 懸念：AI は `null` だけでは、選ばれるのを待つべきか分からない（段階の項目と合わせて読む）。分けるなら、後で `awaitingRepository` に当たる真偽の項目を足す。

### 確認しないと決めたこと

- 形の誤り（`owner/repo` の短い形を含む）と対象に無い値：MCP では検査せず、デーモンの `task.repositoryUnknown`（409）の文をそのまま返す。受け入れ条件3が「画面と同じ理由」を求めるため。
- 新しい ADR：書く。`docs/adr/README.md` の手順で、`20261119-0100-...` を一部の置き換え（`superseded`）にする。既存の ADR の決定（対象リポジトリを引数に足さない）を変えるため。
- `packages/cli/src/index.ts`：直さない。`sacty mcp` の使い方の表示は `docs/user/mcp.md` を案内するだけのため。

## 既定で決めたこと

- 空・空白だけの `repo` は、API を呼ぶ前に `CreateTaskInput` で断る（省略と同じにしない）。指定したつもりの誤りを、黙って「指定しない」にしないため。
- 断りの文に、`rerun_task` のような案内（画面で選び直せる）を足さない。
- 要約の `repo` の値は、`rerunDefaults` と同じ `source.repo ?? repo ?? repository.url ?? null` にする（関数にまとめて共有する）。複数の指定（`repos`）だけのタスクは `null`。
- `wait_for_task` の比べる欄（`watchOfTask`）には `repo` を入れない（リポジトリが決まっても起こさない）。

## 構成と処理の流れ

| 箇所 | 変更 |
| --- | --- |
| `CreateTaskToolInput` | `repo`（文字列。省略できる）を足す。説明に、`list_projects` の `targets` の URL か、Org の対象の下のリポジトリの URL を渡すと書く |
| `create_task` の `run` | `CreateTaskInput.pick({ title, body, repo })` で検査し、`api.createTask({ projectId, title, body, repo })` を呼ぶ。`repo` を省いたら `null` |
| `SactyApi.createTask`・`daemonApi.createTask` | 入力に `repo: string \| null` を足し、そのまま送る（`{ ...input, repo: null }` の上書きをやめる） |
| `TaskSummarySchema`・`summarizeTask` | `repo: string \| null` を足す（いつも入る。`null` は、決まっていない、またはリポジトリ無しで進む・進んだ） |
| `list_projects` | 結果の形は変えない。`targets` の説明に、`create_task` の `repo` に渡せることを足す |
| 説明文・`INSTRUCTIONS` | `create_task` の「対象リポジトリ空欄と同じ」を、省いたときの振る舞いに直し、指定できることを書く |

- 指定したタスクでは、デーモンが `payload.repo` を記録し、`noRepo` を付けない。そのため `awaitingRepository` が偽になり、オーケストレーターはリポジトリを選ばない。

## 影響範囲

- 要約に `repo` が入るので、`list_tasks`・`get_task`・書き込みのツールの結果が1項目増える。
  - 項目を足すだけで、既存の項目の名前・意味を変えないので、互換とみなす（既存のクライアントは知らない項目を読まないだけ）。仕様書の要約の表と、作業履歴に書く。
- 前の版のデーモン：`POST /api/tasks` の `repo` は画面が使う既存の入力なので、前の版でも効き、黙って無視されることは無い。要約の元の項目（`repo`・`source.repo`・`repository`）が無ければ `null` にする。
- 文書
  - 日英の `docs/spec/mcp-server.md`：`list_projects`・`create_task`・タスクの要約の表・関係する ADR のリンク
  - 日英の `docs/user/mcp.md`：「使う」の段落・ツールの表
  - ADR の新規と置き換え、`docs/worklog/` の新しい記録

## テスト観点

- [TV-1] リポジトリを指定して作ると、画面で同じリポジトリを入れて作ったタスクと同じになり、オーケストレーターに選ばせない
  - 入力：対象がリポジトリのプロジェクトで、create_task に project_id・title・body と repo（targets の URL を大文字・小文字を変えたもの）を渡し、同じ値で POST /api/tasks（repo 付き）でも作る
  - 期待結果：2つのタスクは id・時刻を除いて等しく、task.repo がプロジェクトに登録した URL、noRepo が無く、awaitingRepository が偽である
- [TV-2] Org の対象の下のリポジトリの URL を指定して作れる
  - 入力：対象が Org のプロジェクトで、その Org の下のリポジトリの URL（候補の一覧には無いもの）を repo に渡す
  - 期待結果：タスクが作られ、task.repo が RepoUrl で正規化した URL になる
- [TV-3] repo を省くと、今と同じ「指定しない」で作る
  - 入力：対象がリポジトリ1つだけのプロジェクトで、repo を省いて create_task を呼ぶ
  - 期待結果：デーモンに送る本文が { projectId, title, body, repo: null } で、作ったタスクの repo が無く noRepo が true である
- [TV-4] リポジトリを指定すると、デーモンに送る本文にそのまま入る
  - 入力：daemonApi.createTask に repo: "https://github.com/o/r" を渡す
  - 期待結果：送る本文が { projectId, title, body, repo: "https://github.com/o/r" } に等しい
- [TV-5] プロジェクトの対象に無いリポジトリは、画面と同じ理由で断り、タスクを作らない
  - 入力：プロジェクトの対象に無いリポジトリの URL と、別のプロジェクトがリポジトリとして対象にする Org の下の URL を、それぞれ repo に渡す
  - 期待結果：どちらも isError で、文が task.repositoryUnknown の文（対象リポジトリを、プロジェクト「X」の対象の中から選んでください）と等しく、タスクの件数が増えない
- [TV-6] 形の正しくない値は、画面と同じ理由で断り、タスクを作らない
  - 入力：repo に owner/repo の短い形と、http でない文字列（例：not a url）を渡す
  - 期待結果：どちらも isError で、文が task.repositoryUnknown の文と等しく、タスクの件数が増えない
- [TV-7] 空・空白だけの repo は、API を呼ぶ前に断る
  - 入力：repo に "   " を渡して create_task を呼ぶ
  - 期待結果：isError で、POST /api/tasks を呼ばず、タスクの件数が増えない
- [TV-8] list_projects の結果と説明から、create_task の repo に渡せる値が分かる
  - 入力：リポジトリの対象と Org の対象を持つプロジェクトで list_projects を呼び、ツールの一覧の list_projects・create_task の説明を読む
  - 期待結果：targets に各対象の URL が入り、説明に、repo の対象の URL と Org の対象の下のリポジトリの URL を create_task の repo に渡せることが書かれている
- [TV-9] get_task の要約で、対象のリポジトリと、決まっていないことが分かる
  - 入力：repo を指定して作ったタスク、指定しないで作ったタスク（RepositoryChosen の前と後）、Issue から取り込んだタスク、repo・source.repo・repository の欄が無いタスクで get_task を呼ぶ
  - 期待結果：repo がそれぞれ、指定した URL・null・選ばれた URL・source.repo・null になる
- [TV-10] 日英の仕様書・ユーザー文書・ツールの説明・INSTRUCTIONS が、repo の指定に合っている
  - 入力：docs/spec/mcp-server.md・.en.md、docs/user/mcp.md・.en.md、task-mcp.ts の差分
  - 期待結果：create_task の引数の表と送る要求に repo（省くと null・指定の値・断りの理由）が、list_projects に渡せる値（Org の対象ならその下の URL）が、要約の表に repo（null は、決まっていない、またはリポジトリ無しで進む・進んだ）と項目の追加が互換であることが書かれ、「対象リポジトリ空欄と同じ」は省いたときの記述だけに残る
- [TV-11] ADR の置き換えと作業履歴が、docs の規則に合っている
  - 入力：docs/adr と docs/worklog の差分
  - 期待結果：新しい ADR が対象リポジトリの指定を足す決定と置き換え元を書き、20261119-0100 の ADR が superseded の名前・ステータス・置き換え先を持ち、ほかの文書のリンクが新しい名前に直り、作業履歴に PBI-474 の記録がある
