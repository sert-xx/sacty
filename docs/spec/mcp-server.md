**日本語** | [English](mcp-server.en.md)

# MCP サーバー（sacty mcp）

`sacty mcp` は、起動中の sacty（`sacty up`）を、同じマシンの AI（Claude Code・Codex など）から操作するための MCP サーバー。
標準入出力（stdio）で動き、画面と同じデーモンの API を呼ぶ。
MCP の仕様は 2026-07-28 に合わせ、`initialize` で始める前の版（2025-11-25 まで）のクライアントも受ける。
ツールは、タスクの一覧・検索（`list_tasks`）、タスクの詳細（`get_task`）、PR のレビューのタスクの再レビュー（`rereview_task`）、プロジェクトの一覧（`list_projects`）、タスクの作成（`create_task`）、
成果物の一覧（`list_deliverables`）、成果物の中身（`get_deliverable`）、実行の一覧（`list_runs`）、実行のログ（`get_run_log`）の9つ。
最後の4つは、成果物とログを読むだけのツール。

関係する ADR: [起動中の sacty を操作する MCP サーバーは、CLI が stdio で動かす](../adr/20261118-0936-superseded-task-mcp-server-over-stdio.md)、[CLI は、sacty up が書く接続先のファイルを通して、動いているデーモンの API を呼ぶ](../adr/20261014-0701-cli-daemon-connection-file.md)、[sacty mcp のタスクの作成は、画面の既定（対象リポジトリ空欄・進め方「自動」）と同じ要求を送り、結果を受け取れなかったときは作られた可能性を返す](../adr/20261119-0100-mcp-create-task-like-screen-with-uncertain-result.md)、[sacty mcp の成果物とログの取得は、バイトで上限と位置を決め、デーモンに読み取りの API を足す](../adr/20261119-0200-mcp-read-deliverables-and-logs-by-byte-range.md)

## 起動と接続

- `sacty mcp` は、MCP のサーバー（名前 `sacty`、版は `packages/cli/package.json` の版）を作り、標準入出力につなぐ。
  標準出力は MCP のやりとりだけに使う（ほかのものを書かない。SDK の誤りの知らせは標準エラーに出す）。相手が標準入力を閉じると終わる。
- 公式の SDK の v2（`@modelcontextprotocol/server`）の `serveStdio` で動かす。どの版で話すかは、最初のやりとりで決まる。
  - 要求に版を付けて送るクライアント（2026-07-28。握手は無い）には、その版で答える。`server/discover` に、対応する版（`2026-07-28`）・機能（`tools`）・使い方の説明を返す。
  - `initialize` で始めるクライアントには、その接続の間、前の版（2025-11-25 まで）の決まりで答える。
  - デーモンのほかの MCP（ゲートウェイの中継。[ゲートウェイ](gateway.md)）は、SDK の v1（`@modelcontextprotocol/sdk`）のまま。
- 起動のときには、デーモンに問い合わせない。sacty が起動していなくても始められる。
- ツールを呼ぶたびに、`SACTY_HOME/daemon.json`（[デーモンの起動と終了](daemon-lifecycle.md)）から接続先とトークンを読み、デーモンの API を呼ぶ。
  `sacty up` を起動し直すとトークンが変わるが、次の呼び出しから新しい接続先とトークンを使う（MCP サーバーの起動し直しは要らない）。
- デーモンの応答は、要求ごとに 30 秒（`MCP_REQUEST_TIMEOUT_MS`）まで待つ（本文の読み取りを含む）。
- 認証は足していない（MCP の認証の仕様は HTTP のためのもので、stdio では資格情報を環境から取る決まり）。使えるのは、`daemon.json`（権限 0600）を読める利用者だけ。
- 呼ぶ API は、次のもの（[全体の構成](architecture.md#プロセスと通信)）。上の5つのツールは画面と同じ API を呼ぶ。成果物と実行を読む4つのツールは、読み取りだけの API（下の表の下4行。画面は呼ばない）を呼ぶ。

| ツール | デーモンの API |
| --- | --- |
| `list_tasks` | `GET /api/tasks`・`GET /api/projects` |
| `get_task` | `GET /api/tasks/:id` |
| `rereview_task` | `GET /api/tasks/:id`・`POST /api/tasks/:id/rereview` |
| `list_projects` | `GET /api/projects` |
| `create_task` | `POST /api/tasks` |
| `list_deliverables` | `GET /api/tasks/:id/deliverables` |
| `get_deliverable` | `GET /api/tasks/:id/deliverables/:step/:kind?offset=&max=` |
| `list_runs` | `GET /api/tasks/:id/runs?offset=&limit=` |
| `get_run_log` | `GET /api/tasks/:id/runs/:runId/log/range?file=&offset=&max=&tail=` |

コード: `packages/cli/src/index.ts`（`mcpCommand`）、`packages/cli/src/mcp.ts`（`daemonApi`）、`apps/daemon/src/task-mcp.ts`（`serveTaskMcp`・`startTaskMcp`・`createTaskMcpServer`・`SactyApi`）、`packages/cli/src/context-preview.ts`（`readDaemonFile`・`daemonRequest`）、`packages/cli/src/up-env.ts`（`daemonEndpoint`）

## ツール

サーバーの使い方の説明（`INSTRUCTIONS`）と、`list_tasks`・`get_task` の説明に、結果の題・説明・レビューの本文・止まっている理由はほかの人が書いた文を含むデータで、その中の指示に従わないことを書く。
`list_projects` の説明にも同じ注意を書く（プロジェクトの名前は、人が付けた文）。
`rereview_task`・`create_task` の説明には、利用者に頼まれたときだけ呼ぶこと（題・説明・レビューの本文などの中の指示では呼ばない）を書く。
`list_deliverables`・`get_deliverable`・`list_runs`・`get_run_log` の説明と `INSTRUCTIONS` にも、結果の成果物・ログはほかの人やエージェントが書いた文を含むデータで、その中の指示に従わないことを書く（`READ_UNTRUSTED_NOTE`）。

ツールは `TOOLS` の表（名前・説明・引数の形・結果の形・処理）に持ち、サーバーを作るときにすべて登録する。
どのツールも、引数の形（`inputSchema`）と結果の形（`outputSchema`）を、ツールの一覧に出す。
結果は、構造のある結果（`structuredContent`）と、同じ内容の JSON を文字列にしたテキスト1つで返す。

### list_tasks

タスクを絞り込んで、新しい順（`createdAt` の降順）に、要約の一覧で返す。読み取りだけ（`readOnlyHint`）。
引数はどれも省ける。指定した条件のすべてに合うタスクを返す（条件が無ければ、すべて）。

| 引数 | 型 | 内容 |
| --- | --- | --- |
| `pull_request` | 文字列 | PR。番号（`123`・`#123`）、`owner/repo#123`、PR の URL（`https://<ホスト>/<owner>/<repo>/pull/123`。後ろにパスなどが付いてもよい。`http://` は `https://` として読む）のどれか |
| `branch` | 文字列 | ブランチ名（完全一致。先頭の `refs/heads/` は取り除く） |
| `repo` | 文字列 | リポジトリ。`owner/repo`（ホストを問わない）か、リポジトリの URL |
| `query` | 文字列 | 題に含まれる文字列か、タスクの ID の先頭（大文字・小文字を区別しない） |
| `open_only` | 真偽値 | `true` なら、終わっていない（完了・中止でない）タスクだけ |
| `review_only` | 真偽値 | `true` なら、PR のレビューのタスクだけ |
| `limit` | 整数 | 返す件数の上限。1〜100（`LIST_LIMIT_MAX`）。既定は 20（`LIST_LIMIT_DEFAULT`） |

- 消したプロジェクトのタスクは、一覧に出さない（`get_task` でも無いものとして扱う）。
- 結果は `{ total, returned, tasks }`。`total` は条件に合った件数、`returned` は返した件数、`tasks` は[タスクの要約](#タスクの要約)。
- `pull_request` を読めなければ、理由を返す（一覧は返さない）。
- PR の条件：タスクに[結び付いた PR](#タスクに結び付いた-pr-とブランチ)のどれかが、同じ番号であること。
  リポジトリを付けた指定（`owner/repo#123`・URL）では、リポジトリも同じであること。番号だけなら、リポジトリを問わない。
- ブランチの条件：次のどちらかに当たること。リポジトリは見ない（同じ名前のブランチがほかのリポジトリにあれば、そのタスクも合う。`repo` の条件と組み合わせて絞る）。
  - タスクに[結び付いたブランチ](#タスクに結び付いた-pr-とブランチ)に、その名前がある。
  - タスクがレビューする PR が、ほかのタスクの、そのブランチの PR（レビューの対象としてではなく、そのタスクが作った・引き継いだ PR。取り込み元の PR は、ブランチの記録が無いので含まない）と同じ。
    sacty が作った PR のレビューの子タスクが、親のブランチ名から見つかる。
- リポジトリの条件：タスクの対象リポジトリ（`repository.url`・`repo`・`repos`・`source.repo`）か、結び付いた PR のリポジトリのどれかが同じであること。

### get_task

タスクの詳細を返す。読み取りだけ。引数は `task_id`（タスクの ID の全体）。

- 結果は、[タスクの要約](#タスクの要約)に次を足したもの。
  - `body`：説明（4000 文字を超えた分は省く）。
  - `pausedMessage`：止まっている理由の文（日本語。あるときだけ）。
  - `reviewBody`：レビューの工程の成果（レビューの本文。12000 文字を超えた分は省く。あるときだけ）。
  - `previousReview`：前の回のレビュー（回・投稿の URL・時刻・レビューした先頭のコミット。あるときだけ）。
  - `reviewHeadCommit`：今の回でレビューする PR の先頭のコミット（対象を確かめた後だけ）。
  - `costUsd`：使った費用（`budget.usedUsd`）。
  - `recentActivity`：作業履歴の最後の 30 件の、時刻・actor・イベントの種類（中身は入れない）。`activityCount` は全体の件数。
- タスクが無ければ（消したプロジェクトのタスクを含む）、理由を返す。

### rereview_task

PR のレビューのタスクを、再レビューにする。引数は `task_id`。
画面の「再レビュー」と同じ API を呼ぶので、結果も同じ（`ReviewRestarted` を actor `person` で記録し、PR の最新のコミットをレビューし直して投稿する。[タスクと工程](tasks-and-steps.md#pr-のレビューだけのタスク)）。

- 始めたら、文と、始めた後の[タスクの要約](#タスクの要約)を返す（レビューが終わるのは待たない）。
- 先に `GET /api/tasks/:id` でタスクがあることを確かめる。無ければ（消したプロジェクトのタスクを含む）、タスクが見つからないと返し、再レビューの API を呼ばない。
- 再レビューの API を呼んだ後に結果を受け取れなかったとき（時間切れ・接続が切れた・本文を読めなかった）は、その理由に続けて、再レビューが始まっている可能性があること・`get_task` で確かめてから呼び直すことを返す（デーモンが記録した後に、応答が届かなかったのかもしれないため）。デーモンが応答で断ったとき（`DaemonRefusal`）は、断った理由だけを返す。
- できるのは、レビューを PR に投稿して完了したタスクだけ（要約の `canRereview` が `true`）。
  できないタスク・無いタスクでは、デーモンが断った理由の文を返し、何も記録しない。
- ツールの注釈は、読み取りだけでない（`readOnlyHint: false`）・sacty の外に書く（`openWorldHint: true`）。

### list_projects

消していないプロジェクトを、一覧で返す。読み取りだけ（`readOnlyHint`）。引数は無い。
`create_task` で、どのプロジェクトにタスクを作るかを指定するために使う。

- 結果は `{ projects }`。1件は `id`（`create_task` の `project_id` に渡す）・`name`・`targets`（対象。`scope` が `org`（Organization 全体）か `repo`（1つのリポジトリ）と、対象の URL `target`）。
  プロジェクトのそのほかの設定（コンテキスト・チケット・GitHub のアカウントなど）は出さない。
- 消したプロジェクトは、デーモンが定義ごと消すので、一覧に出ない。

### create_task

プロジェクトを指定して、題と説明でタスクを作る。

| 引数 | 型 | 内容 |
| --- | --- | --- |
| `project_id` | 文字列（必須） | タスクを作るプロジェクトの ID（`list_projects` の `id`） |
| `title` | 文字列（必須） | 題。前後の空白を除いて 1〜200 文字（`TASK_TITLE_MAX`） |
| `body` | 文字列 | 説明。前後の空白を除いて 10000 文字まで（`TASK_BODY_MAX`）。省けば空 |

- 画面の「タスクを作成」で、テンプレートなし・対象リポジトリ空欄・進め方「自動」のままにして作るのと同じ。
  `POST /api/tasks` に `{ projectId, title, body, repo: null }` を送る（`repo: null` は、対象がリポジトリ1つだけのプロジェクトでも、リポジトリを指定しない。画面の空欄と同じ）。進め方・テンプレート・工程ごとの設定は送らない。
  記録（`TaskCreated`。actor `person`・`start: "sacty"`）も、工程の始まり方（オーケストレーターが進め方を選ぶ）も、画面と同じ。
- 作ったら、文と、作ったタスクの[タスクの要約](#タスクの要約)（ID・画面の URL を含む）を返す。工程が終わるのは待たない。返った ID で `get_task` を呼べる。
- 作れないときは、理由を返し、何も作らない。
  - 前後の空白を除いた題が空・長すぎる題・長すぎる説明は、API を呼ぶ前に、画面と同じ検査（`CreateTaskInput`）で断る（長さは空白を除いた後に数える。引数の形で検査するのは、`title` と `project_id` が空でないことだけ。上限と、空白を除いた後の空は `CreateTaskInput` で検査する）。
  - 無い・消したプロジェクトは、デーモンが `project.notFound`（409）で断る。理由は「プロジェクトが見つかりません。」。
  - デーモンの `invalid_input`（400）は、`issues` の文言を日本語にして返す（前の版のデーモンが入力を断ったときも、同じ）。
- 作る API を呼んだ後に結果を受け取れなかったとき（時間切れ・接続が切れた・本文を読めなかった・デーモンが 5xx を返した）は、その理由に続けて、タスクが作られている可能性があること・`list_tasks`（`query` に題）で確かめてから呼び直すことを返す（デーモンが記録した後に、応答が届かなかったのかもしれないため。作成の API には、二重に作らせないための仕組みが無い）。デーモンが 5xx 以外の応答で断ったとき（`DaemonRefusal`）、認証できなかったとき（401）、接続を断られたとき、呼ぶ前の失敗（`daemon.json` が無い）は、処理されていないので、理由だけを返す。
- 前の版のデーモン：`POST /api/tasks`・`GET /api/projects` は、MCP のために足したものではないので、前の版のデーモンにもある。通らなければ、デーモンが断った理由（読めなければ状態コード）を返し、MCP サーバーは終わらない。
- ツールの注釈は、読み取りだけでない（`readOnlyHint: false`）・消さない（`destructiveHint: false`）・同じ呼び出しを重ねても同じにならない（`idempotentHint: false`）・sacty の外に書く（`openWorldHint: true`。始まった工程が、PR などに書く）。

### list_deliverables

タスクの工程ごとの成果物を一覧にする。読み取りだけ（`readOnlyHint: true`・`openWorldHint: false`。以下の3つも同じ）。引数は `task_id`。
読めるのは、画面のタスクの詳細で読める範囲：工程ごとに、承認済みならその版、まだなら最新の出力。レビューの工程は、本文と行へのコメント。
差し戻し前の過去の回の成果物と、エージェントの元のファイル（`agent-files`）は読めない。

- 結果は `{ deliverables }`。1件は `step`（工程）・`kind`・`submission`・`previousSubmission`・`status`・`bytes`（本文の UTF-8 のバイト数）。成果物がまだ無いタスクは、`isError` でない空の一覧。
- `kind` は4つ：`output`（本文。承認済みならその版、まだなら最新の出力）、`test_viewpoints`（設計の工程のテスト観点の JSON）、`sacty_version`（人が直した版があるときの sacty の版）、`review_comments`（レビューの行へのコメントを、`<ファイル>:<行>` と本文で並べた文）。
- 一覧に載るのは、本文が空でない組だけ。工程はタスクの工程の順、続けて、ほかの工程。
- `status` は、次の表の上の行から順に当て、最初に合ったものにする。

| `status` | 条件 | `submission` |
| --- | --- | --- |
| `approved` | その工程が承認済み（`approved[step]`） | 承認した提出の回 |
| `posted` | レビューの工程で、レビューを PR に投稿済み（`reviewPost`） | レビューの回（`reviewRound`。無ければ 1） |
| `not_submitted` | レビューの工程で、まだ投稿していない | null（`previousSubmission` は `reviewRound`−1。1 未満なら null） |
| `awaiting_approval` | 承認ゲートがその工程（`gate.step`） | ゲートの提出の回 |
| `not_submitted` | その工程の最後の実行の完了（`AgentRunCompleted`）が、最後の提出（`StepSubmitted`）より後 | null（`previousSubmission` は、それまでの提出の回数。無ければ null） |
| `changes_requested` | 上のどれでもなく、出力が残っている（差し戻しの後、作り直しの完了まで） | 提出の回数 |
| `none` | 本文が無い（候補の工程で未出力・人が直した版の無い工程の `sacty_version`・設計以外の `test_viewpoints`・レビュー以外の `review_comments`） | null |

- まだ提出していない出力（`not_submitted`）は、前の回の提出と読み違えないように、`submission` を null にし、前の回は `previousSubmission` で示す。

### get_deliverable

成果物の中身を、範囲で読む。

| 引数 | 型 | 内容 |
| --- | --- | --- |
| `task_id` | 文字列（必須） | タスクの ID |
| `step` | 列挙（必須） | 工程（`investigate`・`review`・`requirements`・`design`・`split`・`integrate`・`reproduce`・`implement`・`deployment`・`document`・`operation`） |
| `kind` | 列挙（必須） | 成果物の種類（上の4つ） |
| `offset` | 整数（0 以上） | 読み始める位置（バイト）。省けば 0 |
| `max_bytes` | 整数（1 以上） | 返す量の上限（バイト）。省けば 32,000（`RANGE_MAX_BYTES`）。上限を超える値は 32,000 に収める |

- 結果は、`step`・`kind`・`submission`・`previousSubmission`・`status`・`text`（本文の範囲）と、[範囲の情報](#範囲の指定と結果)。
- 候補にあって本文が無い組は、`isError` でない `status: none`・空の `text`・`totalBytes: 0`。
- 工程・種類が候補に無い値は、引数の列挙で SDK が断る。デーモンの API は、`{ error: "not_found", what: "step" }`・`"kind"` の 404 で断る（継承されたプロパティ（`constructor` など）は引かない）。
- 本文は、デーモンがメモリーにあるタスクから取り、UTF-8 の範囲だけを返す（作業履歴に書く前に、秘密情報を伏せてある）。

### list_runs

エージェントの実行を、新しい順に一覧にする。引数は `task_id`・`offset`（0 以上。既定 0）・`limit`（1 以上。既定 20。100 を超える値は 100 に収める）。

- 画面でログへのリンクがある実行のすべて：作業履歴のうち、画面と同じ規則（`RUN_EVENTS`・`runLogId`。`@sacty/core`）で `runId` が拾える行から集める。工程・オーケストレーター・ガーディアン・書き出し・監査などを含む。`runId` の無い行は載せない。
- 結果は、`total`（実行の件数）・`returned`・`clipped`（件数の上限で切ったか）・`clamped`（`limit` を上限に収めたか）・`nextOffset`（続きの `offset`。もう無ければ null）・`runs`。
- 1件は、`runId`・`role`・`agentId`・`startedAt`・`state`・`fallback`・`hasLog`。
  - `role`・`agentId`・`startedAt`：実行の記録（`meta.json`）にあればその値。無ければ、作業履歴のその `runId` の最初の行から取る（`step` かイベントの種類から決めた役割・`agentId`・時刻）。どちらにも無ければ null。
  - `state`：`running`（デーモンが開いている）、`succeeded`・`failed`（`meta.json` の `outcome`。`meta.json` が無ければ作業履歴の `AgentRunCompleted`・`AgentRunFailed`）、`unknown`（`meta.json` に終わりの時刻が無く開いていない、またはどちらの記録も無い）。
  - `hasLog`：`meta.json` があるか。
  - `fallback`：別のエージェントに切り替わった実行の `{ from, to }`（切り替えの前と後のエージェント）。無ければ null。作業履歴の全件から、ページに切る前に決める。失敗した実行は `AgentFellBack` の `runId`。代わりに動いた実行は、その後に最初に現れた、役割が `AgentFellBack` の `role` と同じで `agentId` が切り替え先の別の実行（`meta.json` は使わない）。どのページから読んでも同じ値になる。
- 返す分（最大 100 件）だけ `meta.json` を読む。

### get_run_log

実行のログを、範囲で読む。

| 引数 | 型 | 内容 |
| --- | --- | --- |
| `task_id` | 文字列（必須） | タスクの ID |
| `run_id` | 文字列（必須） | 実行の ID（`list_runs` の `runId`） |
| `file` | 列挙 | `events`（エージェントの出来事の JSONL。既定）か `stderr`（標準エラー出力） |
| `offset` | 整数（0 以上） | 読み始める位置（バイト）。`from_end` と同時に指定できない |
| `from_end` | 真偽値 | `true` なら、末尾から `max_bytes` を読む |
| `max_bytes` | 整数（1 以上） | 返す量の上限。省けば 32,000。超える値は 32,000 に収める |

- `offset` も `from_end` も無ければ、先頭（`offset` が 0）から読む。両方を渡すと、理由を返す。
- 結果は、`running`（実行中か）・`omittedMiddle`（上限で、先頭と末尾の間を省いているか）・`text`（ログの生の文。JSONL は読み分けない）と、[範囲の情報](#範囲の指定と結果)。
- 読む元は、画面と同じ記録（MCP のための別の記録は作らない）。
  - 終わった実行：画面の `files/:file` と同じログのファイル。範囲だけを `readSync` で読み、全体は読まない。
  - 実行中の実行：デーモンが持つその時点の記録。先頭のファイル（範囲だけを読む）＋省いた印＋メモリーにある末尾（先頭の上限を超えた後の末尾を含む）をつなげたもの。`SessionLog.snapshot()` は使わない（先頭のファイルを全部読むため）。
- 実行中は、先頭の上限（`events` は 15MB）を超えた後の末尾の位置が、読むたびにずれ、実行が終わるとファイルの位置に変わる。`running` が変わったか `omittedMiddle` が真のときは、続きの位置から読まず、`from_end` で読み直す。
- ログには、書き始めた後に分かった秘密情報が、閉じるまで残りうる。[秘密情報の伏せ方](#秘密情報の伏せ方)のとおり、呼び出しの時点で伏せ直してから切る。
- ログのファイルは、開く前に、`runs/<タスク>` もファイルもシンボリックリンクでなく、ファイルが通常のファイルで `runs/<タスク>` の下にあることを確かめる。満たさなければ、開かずに「実行が見つかりません」（API は `{ error: "not_found", what: "run" }` の 404）。ほかのタスクの実行は、タスクごとの場所にあるので読めない。

### 範囲の指定と結果

成果物の中身とログは、1回に最大 32,000 バイト（UTF-8。日本語でおよそ1万字）までを返す。位置と量の単位は、伏せ直す前の UTF-8 のバイト（ファイルとメモリーにあるバイト）。

| 結果の項目 | 内容 |
| --- | --- |
| `offset` | 返した先頭の位置 |
| `next` | 続きの位置（返した末尾）。続きを読むときは、これを `offset` に渡す |
| `totalBytes` | 全体の大きさ |
| `clipped` | 切り取ったか（`offset` で読むときは、続きがあるか。`from_end` のときは、手前に読んでいない分があるか） |
| `clamped` | `max_bytes` が上限を超えたので、上限に収めたか |

- 境目は UTF-8 の文字の頭にそろえる（複数バイトの文字・サロゲートペアの途中で切らない）。1文字も入らない小さな `max_bytes` でも、1文字は返し、続きが進む。
- `offset` が全体の大きさ以上なら、失敗にせず、空の `text` と `totalBytes` を返す（実行中のログを続きから読み直すとき、まだ増えていないことと区別するため）。
- `max_bytes`・`limit` が 0 以下、`offset` が負なら、引数の形（最小値）で SDK が断る。API は 400（`invalid_range`）で断る。

### 秘密情報の伏せ方

ログは、実行中・終了後を問わず、呼び出しの時点でデーモンが持つ秘密情報で伏せ直してから切る。
その実行の秘密情報（デーモンが持っていれば）と、プロジェクトの設定・GitHub のトークンの値（`auditSecretValues`）で伏せる。

- 範囲の前後に、秘密情報の形（エスケープ後を含む）の UTF-8 のバイト数の最大だけ余分に読み、見つけた値に掛かる境目は、値の外側へ広げてから切る。広げた位置を `offset`・`next` に返す。返す量は、最大で `max_bytes`＋余分の2倍＋4（文字の頭にそろえる分）。`max_bytes` が1文字より小さいときは、1文字（最大4バイト）を返して続きが進む。末尾から読むときも、末尾の1文字は返す。
- 実行中のログの読める終わりは、`StreamRedactor` が伏せる前に持っている分（`peek()`）を含めない。さらに、終わりが、呼び出しの時点の秘密情報の形（エスケープ後を含む）のどれかの先頭の一部（全体より短い）で終わるときは、その一部を終わりから外す。途中で `addSecrets` が足した値は、知る前に出た先頭が `peek()` の外に出ているため。`totalBytes`・`next` もこの終わりで数える。外した分は、続きが届いて値の全体が読めるようになってから返る（遅れて読める）。
- 間を省いたログには、値の続きが記録に無い継ぎ目が2つある（先頭のファイルの終わりと、末尾の始まり。省いた印がはさまる）。実行中の読める終わりも同じ継ぎ目として扱う。伏せる範囲は、値の全体の出現と、継ぎ目の前の値の先頭の一部・後の値の後ろの一部を、バイトの区間として1か所で決める（重なる・接する区間は1つにまとめ、区間ごとに `[REDACTED]` を1つ返す。値の全体に収まるだけの一致は、一部とみなさない）。境目はその外側へ広げる。実行中も終わった実行も同じで、位置は変わらない。終わった実行の継ぎ目の位置は `meta.json` の `truncated.<ファイル>.seams` に残し、閉じるときの伏せ直しも同じ決め方で伏せる。書き換えは、一時ファイルに書いて置き換える。
- 書き始めた後に `addSecrets` で値が増えた実行は、その実行の秘密情報をストアのメモリーに持ち、`meta.json` に `redactPending: true` をすぐ書く（書き込みに失敗しても、値はメモリーに持ち続ける）。閉じるときの伏せ直しが全部のファイルで済み、`redactPending` を消した `meta.json` を書けたときだけ、メモリーの値を捨てる。伏せ直しか `meta.json` の書き込みが失敗したら、値をデーモンが動いている間だけ持つ。
- デーモンが開いておらず、その実行の値も持たない実行は、次のどちらかなら、ログの中身を返さずに「このログは秘密情報を伏せ直せていないため返せません」を返す（API は `{ error: "unredacted" }` の 409）。
  - `redactPending` が真（伏せ直しの前にデーモンが止まった・失敗の後に起動し直した）
  - `finishedAt` が無い（デーモンが止まった実行。前の版が書いた実行と、`redactPending` を書けないまま止まった実行を含む）
- `finishedAt` があり `redactPending` が無い実行は、伏せ直しが済んだものとして返す。前の版で伏せ直しに失敗して終わった実行は、これと見分けられない。
- 成果物は、作業履歴に書く前に伏せてあるので、読むときには伏せ直さない。

### 成果物とログを読むツールの失敗

| 場合 | 理由の文 |
| --- | --- |
| タスクが無い・消したプロジェクトのタスク（API は `{ error: "not_found" }` の 404） | `task.notFound` の文言（タスクが見つかりません） |
| 実行が無い・ほかのタスクの実行・ファイルがリンクか場所の外 | 実行が見つかりません |
| 工程・種類が候補に無い（API） | 工程が見つかりません・成果物の種類が見つかりません |
| `task_id`・`run_id` が `[A-Za-z0-9_-]{1,128}` に合わない（`..`・`/`・`%2F` を含む） | `task_id` か `run_id` の形が正しくありません（ツールは API を呼ばない。API も 400（`invalid_id`）で断る） |
| `offset` と `from_end` の両方 | どちらか一方だけを指定するよう促す |
| 範囲の指定が正しくない（API の 400 `invalid_range`） | 範囲の指定が正しくありません |
| 伏せ直せていないログ・終わりが記録されていないログ（デーモンがその実行の値を持たない） | このログは秘密情報を伏せ直せていないため返せません |
| ログのファイルを開く・読むのに失敗した（API は `{ error: "read_failed" }` の 500。中身とパスは返さない） | ログを読めませんでした |
| 前の版のデーモン（新しい API が無く、本文が `error` を持つ JSON でない 404） | 起動中の sacty が対応していないので、sacty を更新し、実行中のタスクが無いときに `sacty up` で起動し直すよう促す |
| 200 の応答が JSON として読めない | sacty の応答を読めませんでした |
| 404 以外の失敗の応答（500 など）で、本文が JSON として読めない | sacty が <状態コード> を返しました（本文は入れない） |
| 本文は JSON だが、`error` が上のどの形にも当たらない（400 以外。例：409 の `error` が `unredacted` でない） | sacty が <状態コード> を返しました（`error` の値も本文も入れない） |
| つながらない・時間切れ・認証できない・起動していない | いまのツールと同じ文言 |

- 理由の文は、この表の文言だけにする。標準エラーの1行には、ツールの名前・`task_id`（あれば）・この理由・原因（下）を出す。どちらにも、デーモンの応答の本文や、成果物とログの中身、`daemon.json` のトークン・環境変数の値・デーモンの絶対パスは出さない。
- 標準エラーの1行（`failureLine`）の原因は、接続の失敗の種類（`ECONNREFUSED` などの `code`）と時間切れの印だけにする（例外の message は出さない。応答の本文の一部が入りうるため）。
- 前の版のデーモンは、新しい API の URL に、Hono の既定の 404（本文は `404 Not Found`）を返す。タスクが無いときの 404 は `error` を持つ JSON なので、区別できる。

コード: `apps/daemon/src/task-mcp.ts`（`READ_REASONS`・`readFailure`・`RunListSchema`）、`apps/daemon/src/task-reads.ts`（`stepState`・`readDeliverable`・`listDeliverables`・`runEntries`）、`apps/daemon/src/byte-range.ts`（`readByteRange`・`RANGE_MAX_BYTES`）、`apps/daemon/src/session-logs.ts`（`SessionLogStore.readRange`・`readMeta`・`redactPending`）、`apps/daemon/src/server.ts`、`apps/daemon/src/service.ts`（`deliverables`・`deliverable`・`runList`・`sessionLogRange`）、`packages/core/src/session-log.ts`（`RUN_EVENTS`・`runLogId`）、`packages/cli/src/mcp.ts`（`readApi`）

### 失敗のときの扱い

ツールの中の失敗は、ツールの実行のエラー（MCP の結果の `isError: true` と、理由の文。`structuredContent` は無い）として返す。MCP サーバーは終わらない。
失敗したツールの名前・対象のタスクの ID（`task_id` があれば。ほかの引数は出さない）・理由を、標準エラーに1行出す（`failureLine`）。つながらなかった原因（例外の `cause`）があれば、5 段までたどって続けて出す（`causeChain`）。

| 場合 | 理由の文 |
| --- | --- |
| `daemon.json` が無い・読めない | 起動中の sacty が見つからない（`sacty up` で起動する） |
| デーモンにつながらない | デーモンにつながらない |
| デーモンが 30 秒のうちに応答しない | デーモンが時間内に応答しなかった |
| デーモンが 401 を返した | デーモンに認証できない |
| デーモンが `invalid_operation`（409）を返した | デーモンの文言（日本語にしたもの） |
| デーモンが `invalid_input`（400）を返した | 誤りごとの文言（日本語にしたもの） |
| デーモンがほかの失敗を返した | 状態コード |

引数が型に合わないとき（決めた範囲の外の `limit`・無い `task_id` など）は、MCP の SDK が、ツールを呼ばずに、同じ形（`isError: true` と理由の文）で返す。
知らないツールの呼び出しなどは、JSON-RPC のエラーになる。

コード: `apps/daemon/src/task-mcp.ts`（`TOOLS`・`defineTool`・`INSTRUCTIONS`・`filterTasks`・`parsePullRequestQuery`・`describeTask`）、`packages/cli/src/mcp.ts`（`daemonApi`・`MCP_REQUEST_TIMEOUT_MS`・`REREVIEW_UNCERTAIN`・`CREATE_UNCERTAIN`）、`apps/daemon/src/server.ts`（`createApp`）、`apps/daemon/src/service.ts`（`rereview`・`createTask`）、`packages/core/src/events.ts`（`CreateTaskInput`）

## タスクの要約

`list_tasks`・`rereview_task`・`create_task` の結果と、`get_task` の結果の土台。

| 項目 | 内容 |
| --- | --- |
| `id`・`title`・`projectId` | タスクの ID・題・プロジェクトの ID |
| `state` | `cancelled`（中止）、`completed`（工程をすべて終えて止まっている）、ほかはタスクの状態（`status`）のまま |
| `steps` | 工程と状態（`<工程>:<状態>`。進める順） |
| `reviewTask` | PR のレビューのタスクか（PR のレビューの取り込み（`source.review` がある）か、レビューの工程がある） |
| `canRereview` | 再レビューできるか（`canRereview`） |
| `pullRequests` | [結び付いた PR](#タスクに結び付いた-pr-とブランチ) |
| `branches` | [結び付いたブランチ](#タスクに結び付いた-pr-とブランチ) |
| `review` | PR のレビューのタスクだけ。レビューの回（`round`）と、今の回の投稿の URL（`postedUrl`）・判定（`verdict`）。投稿・判定は、あるときだけ |
| `reviewOf` | PR のレビューの子タスクの、親のタスクの ID |
| `reviewTasks` | このタスクの PR をレビューする子タスク（タスクの ID と PR の番号） |
| `pausedReason` | 一時停止の理由（一時停止中だけ） |
| `createdAt`・`updatedAt` | 作った時刻・最後に記録した時刻 |
| `url` | 画面のタスクの詳細の URL（`daemon.json` に画面の URL があるときだけ） |

コード: `apps/daemon/src/task-mcp.ts`（`summarizeTask`・`isReviewTask`・`TaskSummarySchema`）、`packages/core/src/projection.ts`（`canRereview`・`isFinished`）

## タスクに結び付いた PR とブランチ

PR は、役割（`role`）ごとに次から集める。リポジトリ・番号・URL と、分かればブランチ（`branch`）・状態（`state`）を持つ。

| `role` | 元 | ブランチ |
| --- | --- | --- |
| `review` | PR のレビューのタスクがレビューする PR。対象を確かめた記録（`reviewTarget`）。無ければ（確かめる前・再レビューを始めた後）、取り込み元の PR（`source`）か、題・説明にある対象リポジトリの PR（`referencedPullRequest`） | `reviewBranch`（下） |
| `source` | 取り込み元の PR（PR のレビューのタスクでないとき） | なし |
| `implement` | このタスクが作った実装の PR（`pullRequest`。番号があるときだけ） | `pullRequest.branch` |
| `requirements`・`design` | このタスクが作った、工程の成果の PR（`stepPullRequests`） | その PR のブランチ |
| `continued` | このタスクが引き継いだ既存の PR（`continuedPullRequest`） | その PR の元のブランチ |

ブランチは、タスクブランチ（`taskBranch`）、工程のブランチ（`stepBranches`・`stepPullRequests`）、プッシュしたブランチ（`pushedBranch`）、実装の PR のブランチ、引き継いだ PR の元のブランチ、レビューの対象の PR の元のブランチ（`reviewBranch`）を、重なりを除いて集める。

レビューの対象の PR の元のブランチ（head）の名前は、レビューの対象を確かめたとき（`ReviewTargetResolved`）に、GitHub から読めれば `headBranch` に記録する。

- タスクは、最後に読めた名前を `reviewBranch` に持つ。再レビューを始めても消さない（`reviewTarget` は消える）。
- `headBranch` を記録する前の版で確かめたタスクには無い。次に対象を確かめる（再レビューする）まで、ブランチ名の条件には合わない（PR の条件には合う）。

コード: `apps/daemon/src/task-mcp.ts`（`taskPullRequests`・`taskBranches`）、`apps/daemon/src/prompts.ts`（`referencedPullRequest`）、`apps/daemon/src/service.ts`（`resolveReviewTarget`）、`packages/core/src/events.ts`（`ReviewTargetResolved`）、`packages/core/src/projection.ts`（`reviewBranch`）
