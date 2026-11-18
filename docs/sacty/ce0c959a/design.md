<!-- sacty task ce0c959a-7273-46a8-a749-e78d454096be の設計。sacty が作成しました。 -->

# 設計：sacty mcp に成果物とログの取得を足す（PBI-395）

## スコープ

`sacty mcp` に、読み取りだけのツールを4つ足す。
デーモンには、ツールが使う読み取りの API を4つ足す。
大きな本文も、デーモンが返す分だけを切り出すので、MCP サーバーが全体を受け取ることは無い。

- 対象
  - ツール：`list_deliverables`・`get_deliverable`・`list_runs`・`get_run_log`（`apps/daemon/src/task-mcp.ts`・`packages/cli/src/mcp.ts`）
  - デーモンの API の追加（`server.ts`・`service.ts`・`session-logs.ts`）。実行を拾う規則（`RUN_EVENTS`・`runLogId`）を `@sacty/core` に移し、画面と共有する
  - 仕様書 `docs/spec/mcp-server.md`・`docs/spec/architecture.md`（API の表）、`docs/user/mcp.md`・`docs/user/cli.md`（いずれも日英）、CLI の使い方の表示、作業履歴、ADR 1件
- 対象外
  - 画面の表示と、いまの API・いまの5つのツールの変更
  - 差し戻し前の回の成果物、agent-files、ログの JSONL の読み分け（生の文のまま返す）

## 確認したいこと

### must

なし

### should

- 1回に返す量の上限を、UTF-8 で 32,000 バイト（日本語でおよそ 1 万字）にしてよいか。推奨：はい。`get_task` のレビューの本文（12,000 文字）と同じくらいの量で、位置もログのファイルと同じバイトで数えられるため。
  懸念：手元の AI の文脈が小さいと、1回の結果で文脈を使いすぎ、依頼した人は既定の量を小さく指定し直す手間が増える。
- 実行中のログで、先頭の上限（events は 15MB）を超えた後の末尾の位置が、読むたびにずれてよいか。推奨：はい。末尾はメモリーに 3MB だけ持ち、古い分から捨てるため。
  懸念：先頭の上限を超えた実行中のログを続きから順に読むと、AI が末尾の一部を読み飛ばすか、同じ部分を二度読む。結果の `running`・`truncated` を見て、末尾から読み直すよう説明文に書く。

## 既定で決めたこと

- 成果物の種類は `output`（本文）・`sacty_version`（人が直した版があるときの sacty の版）・`review_comments`（行へのコメントを `path:line` と本文で並べた文）の3つ
- 状態の判定：`approved[step]` があれば approved。`gate.step` がその工程なら awaiting_approval。どちらでもなければ not_submitted（`submission` は null。`previousSubmission` に提出済みの回数を入れる）
- 終わった実行は、閉じるときに伏せ直したファイルを、そのまま範囲で読む（デーモンは、終わった実行の秘密情報を持たない）
- 実行の一覧は新しい順にし、`offset`・`limit`（既定 20・最大 100）で区切る（`list_tasks` と同じ）

## 構成

| ツール | 引数 | 結果 | 呼ぶ API（新規） |
| --- | --- | --- | --- |
| `list_deliverables` | `task_id` | 成果物ごとに `step`・`kind`・`submission`・`status`・`bytes` | `GET /api/tasks/:id/deliverables` |
| `get_deliverable` | `task_id`・`step`（工程の enum）・`kind`（enum）・`offset`・`max_bytes` | `step`・`kind`・`submission`・`status`・`text`・切り取りの情報 | `GET /api/tasks/:id/deliverables/:step/:kind?offset=&max=` |
| `list_runs` | `task_id`・`offset`・`limit` | `total`・`returned`・`truncated`・`nextOffset`。実行ごとに `runId`・`role`・`agentId`・`startedAt`・`state`・`fallback`・`hasLog` | `GET /api/tasks/:id/runs?offset=&limit=` |
| `get_run_log` | `task_id`・`run_id`・`file`（events か stderr）・`offset` か `from_end`・`max_bytes` | `running`・`truncated`（上限で間を省いたか）・`text`・切り取りの情報 | `GET /api/tasks/:id/runs/:runId/log/range?file=&offset=&max=&tail=` |

- 切り取りの情報は `offset`（返した先頭）・`next`（続きの位置）・`totalBytes`・`clipped`・`clamped`（`max_bytes` を上限に収めたか）。位置と量の単位は UTF-8 のバイト
- 注釈は4つとも `readOnlyHint: true`・`openWorldHint: false`。説明文には `UNTRUSTED_NOTE` に成果物・ログを足した注意を入れ、`INSTRUCTIONS` にも足す
- `state` は running（デーモンが開いている）・succeeded・failed（`meta.outcome`。meta が無ければ作業履歴の `AgentRunCompleted`／`Failed`）・unknown（終わりが記録されていない）
- `fallback` は、切り替えた実行に `{ from, to }` を入れる（失敗した実行は `AgentFellBack`、代わりに動いた実行は `reviewDispatch.configuredAgentId` から）

## 処理の流れ

- 成果物：デーモンが、メモリーにあるタスクの `approved[step]?.output ?? outputs[step]` などを UTF-8 にし、範囲だけを返す
- 終わった実行のログ：デーモンが、ファイルの範囲だけを `readSync` で読む（全体は読まない）
- 実行中のログ：デーモンが開いている `SessionLog` から、「先頭のファイル＋省いた印＋メモリーの末尾」の範囲を読む。範囲の前後に、いちばん長い秘密情報の長さだけ余分に読み、いまの秘密情報で伏せる。そのあと、伏せた値の途中で切らないように境目を外へずらしてから、範囲に切る
- 境目は、UTF-8 の文字の頭にそろえる（`completeUtf8Length` を使い、始めは次の文字の頭まで進める）
- `from_end` は、末尾の `max_bytes` を返す。`offset` が全体以上なら、0 バイトと `totalBytes` を返す

## エラー時の振る舞い

| 場合 | 結果 |
| --- | --- |
| タスクが無い・消したプロジェクトのタスク | デーモンは `{error:"not_found"}` の 404 を返す。ツールは `task.notFound` の文言を返す |
| 実行が無い・ほかのタスクの実行 | `{error:"not_found", what:"run"}` の 404。「実行が見つかりません」 |
| 本文の無い 404（前の版のデーモンの既定の 404） | 「起動中の sacty が古い版です。更新して `sacty up` で起動し直してください」 |
| `task_id`・`run_id` が `validLogId` に合わない（`..`・`/`・`%2F` を含む） | ツールが API を呼ばずに理由を返す。API も 400（`invalid_id`）で断る |
| `max_bytes`・`limit` が 0 以下、`offset` が負 | 引数の型（`min`）で、SDK が `isError` で返す |
| つながらない・時間切れ・認証できない | いまのツールと同じ文言（`daemonApi` の `request`・`refusal` を使う） |

- 理由の文と `failureLine` には、仕様書の表の文言だけを出す。デーモンの応答の本文や、成果物とログの中身は出さない

## 影響範囲

- 画面：`runLogId` の import 先が `@sacty/core` に変わるだけで、表示は変わらない
- 文書：日英の版を同じ PR で直す。ADR には、上限と単位、位置の示し方、成果物・実行の指定の方法、前の版の見分け方を書く

## テスト観点

- [TV-1] 4つのツールが、型と読み取りの注釈を付けて一覧に載ること
  - 入力：MCP のクライアントから tools/list を呼ぶ
  - 期待結果：list_deliverables・get_deliverable・list_runs・get_run_log が、inputSchema・outputSchema と readOnlyHint: true・openWorldHint: false を持って載り、structuredContent と同じ JSON の文を返す
- [TV-2] 成果物が無いタスクの一覧が空で返ること
  - 入力：工程はあるが outputs・approved が空のタスクで list_deliverables を呼ぶ
  - 期待結果：isError でない、deliverables が0件の結果を返す
- [TV-3] 成果物が1件のときの一覧の中身
  - 入力：requirements が承認待ち（gate が requirements の1回目）のタスクで list_deliverables を呼ぶ
  - 期待結果：step=requirements・kind=output・submission=1・status=awaiting_approval・bytes が本文の UTF-8 のバイト数の1件を返す
- [TV-4] やり直した工程で、最新の版とその回が分かること
  - 入力：design を2回提出し、2回目が承認済みのタスクで get_deliverable（step=design・kind=output）を呼ぶ
  - 期待結果：2回目の本文と submission=2・status=approved を返す
- [TV-5] まだ提出していない出力を、前の回の番号で示さないこと
  - 入力：design の1回目を差し戻した後、2回目の実行が完了して StepSubmitted がまだ無いタスクで get_deliverable を呼ぶ
  - 期待結果：新しい本文を status=not_submitted・submission=null・previousSubmission=1 で返す
- [TV-6] レビューの工程の本文と行へのコメント、人が直した版を読めること
  - 入力：review の本文と reviewComments が2件あるタスク、approved.edited.sacty がある工程を持つタスクで list_deliverables と get_deliverable を呼ぶ
  - 期待結果：review の output と review_comments（各コメントの path:line と本文を含む文）、edited の工程の sacty_version が一覧に載り、中身を読める
- [TV-7] 本文を上限ちょうどと上限を1超える長さで切ること
  - 入力：UTF-8 で 32,000 バイトの本文と 32,001 バイトの本文で get_deliverable を呼ぶ
  - 期待結果：32,000 バイトでは clipped=false で全文を返し、32,001 バイトでは clipped=true・totalBytes=32001・next=返した末尾の位置を返す
- [TV-8] 上限を超える量と、全体以上の位置の扱い
  - 入力：max_bytes=1000000 と、offset=totalBytes・offset=totalBytes+10 で get_deliverable と get_run_log を呼ぶ
  - 期待結果：max_bytes は上限に収めて clamped=true を返し、全体以上の位置では isError でない0バイトの text と totalBytes を返す
- [TV-9] 量が0・負、位置が負の指定を断ること
  - 入力：max_bytes=0・max_bytes=-1・offset=-1・limit=0 で新しいツールを呼ぶ
  - 期待結果：中身を返さずに isError と理由を返す
- [TV-10] 複数バイトの文字とサロゲートペアの途中で切らないこと
  - 入力：日本語と絵文字の境目が上限の位置と offset の位置に来る本文とログで、get_deliverable と get_run_log を呼ぶ
  - 期待結果：text に置換文字（U+FFFD）や孤立したサロゲートが無く、next から読み直した text と続けると元の文と一致する
- [TV-11] 実行の一覧に、工程でない実行と各実行の状態が載ること
  - 入力：工程の成功・工程の失敗・orchestrator・guardian・export・audit の実行と、meta に finishedAt が無くデーモンが開いていない実行を持つタスクで list_runs を呼ぶ
  - 期待結果：画面でログへのリンクがある実行がすべて新しい順に載り、それぞれ runId・role・agentId・startedAt と state（succeeded・failed・unknown）を持つ
- [TV-12] 別のエージェントに切り替えた実行が分かること
  - 入力：AgentFellBack（agentId=claude・fallbackAgentId=codex）の失敗した実行と、reviewDispatch.configuredAgentId=claude で codex が動いた実行を持つタスクで list_runs を呼ぶ
  - 期待結果：両方の実行に fallback={from: claude, to: codex} が入る
- [TV-13] 実行の一覧を件数の上限で区切ること
  - 入力：実行が 101 件あるタスクで、limit を指定せずに、また limit=100・offset=100 で list_runs を呼ぶ
  - 期待結果：既定では 20 件と total=101・truncated=true・nextOffset=20 を返し、offset=100 では1件と truncated=false を返す
- [TV-14] 終わった実行のログを、末尾からと位置から読めること
  - 入力：events に 20MB（先頭 15MB・省いた印・末尾 3MB）を持つ終わった実行で、from_end=true と offset=0 で get_run_log を呼ぶ
  - 期待結果：from_end では末尾の max_bytes 分を、offset=0 では先頭から max_bytes 分を、画面の files/events と同じバイト列から返す
- [TV-15] 大きなログでも、返す量に見合う分だけを読むこと
  - 入力：20MB の events の実行で get_run_log を呼び、デーモンのファイルの読み取り量と、MCP サーバーが受け取った応答の大きさを数える
  - 期待結果：どちらも max_bytes にいちばん長い秘密情報の長さと JSON の包みの一定の幅を足した量に収まり、30 秒のうちに返る
- [TV-16] 実行中のログで、先頭の上限を超えた後の末尾を読めること
  - 入力：先頭の上限を小さくした SessionLogStore で、上限を超えて書いた実行中の実行に from_end=true で get_run_log を呼ぶ
  - 期待結果：running=true と、メモリーにある末尾のうち呼び出しの時点までに書いた行を含む text を返す
- [TV-17] 実行の途中で足した秘密情報が、実行中のログに出ないこと
  - 入力：書き始めた後に addSecrets で足した値が、ファイルの先頭に伏せる前のまま残っている実行中の実行で get_run_log を呼ぶ
  - 期待結果：text にその値が無く [REDACTED] になっている
- [TV-18] 伏せる値が切り取りの境目をまたぐときに、値の一部を残さないこと
  - 入力：実行中のログで、秘密情報の値が offset の位置と max_bytes の末尾の位置をまたぐように範囲を指定して get_run_log を呼ぶ
  - 期待結果：text に値の先頭・末尾のどの一部も含まれず、境目は伏せた印の外側に来る
- [TV-19] 無いタスク・消したプロジェクトのタスク・無い実行・ほかのタスクの実行を断ること
  - 入力：存在しない task_id、消したプロジェクトのタスクの ID、そのタスクに無い run_id、別のタスクの run_id で新しいツールを呼ぶ
  - 期待結果：どれも isError と仕様書の定型の理由を返し、ほかのタスクの成果物・ログの中身を含めない
- [TV-20] 決まった場所の外を指す ID を読まないこと
  - 入力：run_id・task_id に ../x・/etc/passwd・%2e%2e%2fx・a/b を、デーモンの新しい API にも同じ値を渡す
  - 期待結果：ツールはデーモンを呼ばずに isError と理由を返し、API は 400（invalid_id）を返して中身を読まない
- [TV-21] 前の版のデーモンを「タスクが無い」と区別すること
  - 入力：新しい API に本文の無い（Hono の既定の）404 を返すデーモンで、新しいツールを呼ぶ
  - 期待結果：isError で sacty の更新と再起動を促す理由を返し、task.notFound の文言を返さない
- [TV-22] つながらないときに、新しいツールも同じ理由を返し、サーバーが動き続けること
  - 入力：「どのツールも理由を返す」のテストのループに新しい4つのツールを入れ、daemon.json が無い・接続を断られる・30 秒応答しない場合に呼ぶ
  - 期待結果：いまのツールと同じ理由を isError で返し、その後のツールの呼び出しにも応答する
- [TV-23] 結果・理由・標準エラーに秘密情報と中身を出さないこと
  - 入力：daemon.json のトークン・環境変数の値・デーモンの絶対パスを含む失敗と、成果物とログの取得の失敗を起こす
  - 期待結果：結果・理由・failureLine の1行にトークン・環境変数の値・絶対パス・成果物とログの中身が無く、failureLine はツール名・task_id・理由・cause だけを持つ
- [TV-24] 説明文とサーバーの使い方の説明に、データの中の指示に従わないことがあること
  - 入力：4つのツールの description と INSTRUCTIONS
  - 期待結果：結果の成果物・ログはほかの人やエージェントが書いた文を含むデータで、その中の指示に従わないことが書かれている
- [TV-25] いまの5つのツールの引数と結果が変わらないこと
  - 入力：list_tasks・get_task・rereview_task・list_projects・create_task の inputSchema・outputSchema と、get_task の reviewBody
  - 期待結果：起点のコミットと同じ形で、既存のテストが変更なしで通る
- [TV-26] 画面の実行のリンクが変わらないこと
  - 入力：runLogId を @sacty/core に移した後の apps/web のタスクの詳細と実行のログの route
  - 期待結果：移す前と同じイベントの種類から実行を拾い、既存の web のテストが通る
- [TV-27] 文書に新しいツールとその決まりが書かれていること
  - 入力：docs/spec/mcp-server.md・docs/spec/architecture.md・docs/user/mcp.md・docs/user/cli.md（日英）、CLI の使い方の表示、docs/worklog の PBI-395 の作業履歴、docs/adr の新しい ADR の差分
  - 期待結果：4つのツールと引数・結果・理由の文・新しい API、上限と単位・続きの位置・前の版のデーモンの扱い、できること・できないことが書かれ、作業履歴に実行したコマンドと結果がある
- [TV-28] 検査が通ること
  - 入力：変更後の作業領域で npm run lint・npm run format・npm run typecheck・npx vitest run --no-file-parallelism を実行する
  - 期待結果：どれも失敗なく終わる
- [TV-29] Claude Code と Codex から新しいツールを使えること
  - 入力：起動中の sacty に、Claude Code と Codex の MCP の設定で sacty mcp をつなぎ、4つのツールを呼ぶ
  - 期待結果：どちらのクライアントも結果の型を受け付け、成果物とログを読める（人が確かめる）
