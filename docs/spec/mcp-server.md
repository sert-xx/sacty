**日本語** | [English](mcp-server.en.md)

# MCP サーバー（sacty mcp）

`sacty mcp` は、起動中の sacty（`sacty up`）を、同じマシンの AI（Claude Code・Codex など）から操作するための MCP サーバー。
標準入出力（stdio）で動き、画面と同じデーモンの API を呼ぶ。
MCP の仕様は 2026-07-28 に合わせ、`initialize` で始める前の版（2025-11-25 まで）のクライアントも受ける。
ツールは、タスクの一覧・検索（`list_tasks`）、タスクの詳細（`get_task`）、PR のレビューのタスクの再レビュー（`rereview_task`）の3つ。

関係する ADR: [起動中の sacty を操作する MCP サーバーは、CLI が stdio で動かす](../adr/20261118-0936-task-mcp-server-over-stdio.md)、[CLI は、sacty up が書く接続先のファイルを通して、動いているデーモンの API を呼ぶ](../adr/20261014-0701-cli-daemon-connection-file.md)

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
- 認証は足していない（MCP の認証の仕様は HTTP のためのもので、stdio では資格情報を環境から取る決まり）。使えるのは、`daemon.json`（権限 0600）を読める利用者だけ。
- 呼ぶ API は、画面と同じ次のもの（[全体の構成](architecture.md#プロセスと通信)）。デーモンに、MCP のための API は無い。

| ツール | デーモンの API |
| --- | --- |
| `list_tasks` | `GET /api/tasks`・`GET /api/projects` |
| `get_task` | `GET /api/tasks/:id` |
| `rereview_task` | `POST /api/tasks/:id/rereview` |

コード: `packages/cli/src/index.ts`（`mcpCommand`）、`packages/cli/src/mcp.ts`（`daemonApi`）、`apps/daemon/src/task-mcp.ts`（`serveTaskMcp`・`startTaskMcp`・`createTaskMcpServer`・`SactyApi`）、`packages/cli/src/context-preview.ts`（`readDaemonFile`・`daemonRequest`）

## ツール

ツールは `TOOLS` の表（名前・説明・引数の形・結果の形・処理）に持ち、サーバーを作るときにすべて登録する。
どのツールも、引数の形（`inputSchema`）と結果の形（`outputSchema`）を、ツールの一覧に出す。
結果は、構造のある結果（`structuredContent`）と、同じ内容の JSON を文字列にしたテキスト1つで返す。

### list_tasks

タスクを絞り込んで、新しい順（`createdAt` の降順）に、要約の一覧で返す。読み取りだけ（`readOnlyHint`）。
引数はどれも省ける。指定した条件のすべてに合うタスクを返す（条件が無ければ、すべて）。

| 引数 | 型 | 内容 |
| --- | --- | --- |
| `pull_request` | 文字列 | PR。番号（`123`・`#123`）、`owner/repo#123`、PR の URL（`https://<ホスト>/<owner>/<repo>/pull/123`。後ろにパスなどが付いてもよい）のどれか |
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
- ブランチの条件：次のどちらかに当たること。
  - タスクに[結び付いたブランチ](#タスクに結び付いた-pr-とブランチ)に、その名前がある。
  - タスクがレビューする PR が、ほかのタスクの、そのブランチの PR（レビューの対象としてではなく、そのタスクが作った・引き継いだ・取り込んだ PR）と同じ。
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
- できるのは、レビューを PR に投稿して完了したタスクだけ（要約の `canRereview` が `true`）。
  できないタスク・無いタスクでは、デーモンが断った理由の文を返し、何も記録しない。
- ツールの注釈は、読み取りだけでない（`readOnlyHint: false`）・sacty の外に書く（`openWorldHint: true`）。

### 失敗のときの扱い

ツールの中の失敗は、ツールの実行のエラー（MCP の結果の `isError: true` と、理由の文。`structuredContent` は無い）として返す。MCP サーバーは終わらない。

| 場合 | 理由の文 |
| --- | --- |
| `daemon.json` が無い・読めない | 起動中の sacty が見つからない（`sacty up` で起動する） |
| デーモンにつながらない | デーモンにつながらない |
| デーモンが 401 を返した | デーモンに認証できない |
| デーモンが `invalid_operation`（409）を返した | デーモンの文言（日本語にしたもの） |
| デーモンがほかの失敗を返した | 状態コード |

引数が型に合わないとき（決めた範囲の外の `limit`・無い `task_id` など）は、MCP の SDK が、ツールを呼ばずに、同じ形（`isError: true` と理由の文）で返す。
知らないツールの呼び出しなどは、JSON-RPC のエラーになる。

コード: `apps/daemon/src/task-mcp.ts`（`TOOLS`・`defineTool`・`filterTasks`・`parsePullRequestQuery`・`describeTask`・`ToolRefusal`）、`packages/cli/src/mcp.ts`（`daemonApi`）、`apps/daemon/src/server.ts`（`createApp`）、`apps/daemon/src/service.ts`（`rereview`）

## タスクの要約

`list_tasks`・`rereview_task` の結果と、`get_task` の結果の土台。

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
