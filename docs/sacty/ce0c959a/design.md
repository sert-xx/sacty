<!-- sacty task ce0c959a-7273-46a8-a749-e78d454096be の設計。sacty が作成しました。 -->

# 設計：sacty mcp に成果物とログの取得を足す（PBI-395）

## スコープ

`sacty mcp` に、読み取りだけのツールを4つ足す。
デーモンには、ツールが使う読み取りの API を4つ足す。
大きな本文も、デーモンが返す分だけを切り出すので、MCP サーバーが全体を受け取ることは無い。

- 対象
  - ツール：`list_deliverables`・`get_deliverable`・`list_runs`・`get_run_log`（`apps/daemon/src/task-mcp.ts`・`packages/cli/src/mcp.ts`）
  - デーモンの API の追加（`server.ts`・`service.ts`・`session-logs.ts`）。実行を拾う規則（`RUN_EVENTS`・`runLogId`）を `@sacty/core` に移し、画面と共有する
  - 仕様書 `docs/spec/mcp-server.md`・`docs/spec/architecture.md`（API の表）・`docs/spec/event-log.md`（`meta.json` の項目）・`docs/spec/README.md`（MCP の項目の説明）、`docs/user/mcp.md`・`docs/user/cli.md`・`docs/user/README.md`（MCP の項目の説明）（いずれも日英）、CLI の使い方の表示、`CONTRIBUTING.md` のテストの表、作業履歴、ADR 1件
- 対象外
  - 画面の表示と、いまの API・いまの5つのツールの変更
  - 差し戻し前の回の成果物、agent-files、ログの JSONL の読み分け（生の文のまま返す）

## 確認したいこと

### must

なし

### should

- 1回に返す量の上限を、UTF-8 で 32,000 バイト（日本語でおよそ 1 万字）にしてよいか。推奨：はい。`get_task` のレビューの本文（12,000 文字）と同じくらいの量で、位置もログのファイルと同じバイトで数えられるため。
  懸念：手元の AI の文脈が小さいと、1回の結果で文脈を使いすぎ、依頼した人は既定の量を小さく指定し直す手間が増える。
- 実行中のログで、先頭の上限（events は 15MB）を超えた後の末尾の位置が読むたびにずれ、実行が終わるとファイルの位置に変わってよいか。推奨：はい。末尾はメモリーに 3MB だけ持って古い分から捨て、閉じるときに省いた印を挟んで書くため。
  懸念：その間に続きから順に読むと、AI が末尾の一部を読み飛ばすか二度読む。説明文に、`running` が変わったか `omittedMiddle` が真なら `from_end` で読み直すよう書く。
- 終わりが記録されていない実行（デーモンが止まった実行など）のログは、デーモンがその実行の秘密情報を持っていなければ、中身を返さない（409）でよいか。推奨：はい。`redactPending` の書き込みが失敗した後にデーモンが止まると、値が平文で残った実行を `meta.json` から見分けられないため。
  懸念：デーモンが落ちた実行の原因を、依頼した人の AI が MCP で読めず、画面で開く手間が増える。

## 既定で決めたこと

- 成果物の種類は `output`（本文）・`test_viewpoints`（設計の工程のテスト観点の JSON）・`sacty_version`（人が直した版があるときの sacty の版）・`review_comments`（行へのコメントを `path:line` と本文で並べた文）の4つ
- 状態の判定は「処理の流れ」の表のとおり。差し戻しの後は `changes_requested`、提出していない出力は `not_submitted`（`submission` は null）
- ログは、実行中・終了後を問わず、呼び出しの時点の秘密情報（その実行の秘密情報をデーモンが持っていればその値と、プロジェクトの設定・GitHub のトークンの値〔`auditSecretValues`〕）で伏せ直してから切る
- 実行の一覧は新しい順にし、`offset`・`limit`（既定 20）で区切る。`limit` が 100 を超えたら 100 に収める（`list_tasks` と違い断らない。R-26）
- 前の版のデーモンへの理由の文は、「sacty を更新し、実行中のタスクが無いときに `sacty up` で起動し直してください」とする

## 構成

| ツール | 引数 | 結果 | 呼ぶ API（新規） |
| --- | --- | --- | --- |
| `list_deliverables` | `task_id` | 成果物ごとに `step`・`kind`・`submission`・`status`・`bytes` | `GET /api/tasks/:id/deliverables` |
| `get_deliverable` | `task_id`・`step`（工程の enum）・`kind`（enum）・`offset`・`max_bytes` | `step`・`kind`・`submission`・`status`・`text`・切り取りの情報 | `GET /api/tasks/:id/deliverables/:step/:kind?offset=&max=` |
| `list_runs` | `task_id`・`offset`・`limit` | `total`・`returned`・`clipped`・`clamped`・`nextOffset`。実行ごとに `runId`・`role`・`agentId`・`startedAt`・`state`・`fallback`・`hasLog` | `GET /api/tasks/:id/runs?offset=&limit=` |
| `get_run_log` | `task_id`・`run_id`・`file`（events か stderr）・`offset` か `from_end`（真偽）・`max_bytes` | `running`・`omittedMiddle`（上限で間を省いたか）・`text`・切り取りの情報 | `GET /api/tasks/:id/runs/:runId/log/range?file=&offset=&max=&tail=` |

- 切り取りの情報は `offset`（返した先頭）・`next`（続きの位置）・`totalBytes`・`clipped`・`clamped`（`max_bytes` を上限に収めたか）。位置と量の単位は、伏せ直す前の UTF-8 のバイト（ファイルとメモリーにあるバイト）
- `max_bytes` は省くと上限（32,000）。`offset` と `from_end` を両方渡すと理由を返し、どちらも無ければ `offset=0`
- 注釈は4つとも `readOnlyHint: true`・`openWorldHint: false`。説明文には `UNTRUSTED_NOTE` に成果物・ログを足した注意を入れ、`INSTRUCTIONS` にも足す
- `state` は running（デーモンが開いている）・succeeded・failed（`meta.json` の `outcome`。`meta.json` が無ければ作業履歴の `AgentRunCompleted`／`Failed`）・unknown（`meta.json` に `finishedAt` が無く開いていない、またはどちらの記録も無い）。`hasLog` は `meta.json` があるか
- `role`・`agentId`・`startedAt` は `meta.json`、無ければ作業履歴（その runId の最初の行の `step`・イベントの種類から決まる役割・`agentId`・時刻）から取り、どちらにも無ければ `null`
- `fallback` は `{ from, to }` か `null`。作業履歴の全件から、ページに切る前に決める。失敗した実行は `AgentFellBack` の `runId`、代わりに動いた実行は、その `AgentFellBack` の後に作業履歴に最初に現れた、作業履歴の役割が `AgentFellBack` の `role` と同じで `agentId` が `fallbackAgentId` の別の実行（`meta.json` は使わない）

## 処理の流れ

- 成果物：デーモンが、メモリーにあるタスクから本文を取り、UTF-8 にして範囲だけを返す。`step`・`kind` は許可リストと照合し、`Object.hasOwn` で引く
- 状態は、表の上の行から順に当て、最初に合った行にする

| 状態 | 条件 | `submission` |
| --- | --- | --- |
| approved | `approved[step]` がある | `approved.submission` |
| posted | review の工程で、`reviewPost` がある | `reviewRound`（無ければ 1） |
| not_submitted | review の工程で、`reviewPost` が無い | null（`previousSubmission` に `reviewRound`−1。1 以下なら null） |
| awaiting_approval | `gate.step` がその工程 | `gate.submission` |
| not_submitted | その工程の最後の `AgentRunCompleted` が最後の `StepSubmitted` より後 | null（`previousSubmission` に `submissions[step]`） |
| changes_requested | 上のどれでもなく `outputs[step]` がある | `submissions[step]` |
| none | 本文が無い（候補の工程で未出力、`sacty_version` の無い工程、review 以外の `review_comments` など） | null。`text` は空、`totalBytes` は 0 |

- 終わった実行のログ：ファイルの範囲だけを `readSync` で読む（全体は読まない）
- 実行中のログ：「先頭のファイルの範囲（`readSync`）＋省いた印＋メモリーの末尾の範囲」を組む。`snapshot()` は先頭のファイルを全部読むので使わない
  - メモリーの末尾には、`StreamRedactor` が伏せる前に持っている分（`peek()`）を含めない。伏せる値の先頭の一部でありうるため。`totalBytes` もこの分を数えない
  - 読める終わりが、呼び出しの時点の秘密情報の形（エスケープ後を含む）のどれかの先頭の一部で終わるときは、その一部を読める終わりから外す。途中で `addSecrets` が足した値は、知る前に出た先頭が `peek()` の外に出ているため。`totalBytes`・`next` もこの終わりで数える
- 伏せ方（どちらも同じ）：範囲の前後に、秘密情報の形（エスケープ後を含む）の UTF-8 のバイト数の最大だけ余分に読み、呼び出しの時点の秘密情報で伏せる。伏せた値に掛かる境目は値の外側へ広げ、広げた位置を `offset`・`next` に返す（返す量は最大で `max_bytes`＋余分の2倍）
- 実行の秘密情報の持ち方（`SessionLogStore`）
  - 書き始めた後に `addSecrets` で値が増えたら、その実行の秘密情報をストアのメモリーに移し、`meta.json` に `redactPending: true` をすぐ書く。書き込みが失敗しても、値はメモリーに持ったままにする
  - 閉じるときの伏せ直しが全部のファイルで済み、`redactPending` を消した `meta.json` を書けたときだけ、メモリーの値を捨てる。伏せ直しか `meta.json` の書き込みが失敗したら、値をデーモンが動いている間だけ持つ（`onClose` では捨てない）
  - デーモンが開いておらず、その実行の値も持たない実行は、次のどちらかなら、ログの中身を返さずに理由を返す
    - `redactPending` が真（伏せ直しの前にデーモンが止まった・失敗の後に起動し直した）
    - `finishedAt` が無い（デーモンが止まった実行。前の版が書いた実行と、`redactPending` を書けないまま止まった実行を含む）
  - `finishedAt` があり `redactPending` が無い実行は、伏せ直しが済んだものとして返す。前の版で伏せ直しに失敗して終わった実行とは見分けられないため、これを ADR に書く
- 境目は、UTF-8 の文字の頭にそろえる（`completeUtf8Length` を使い、始めは次の文字の頭まで進める）
- ファイルは開く前に `lstat` と `realpath` で、`runs/<タスク>` もファイルもシンボリックリンクでなく、ファイルが通常のファイルで `runs/<タスク>` の下にあることを確かめる
- `from_end` は、末尾の `max_bytes` を返す。`offset` が全体以上なら、0 バイトと `totalBytes` を返す
- 実行の一覧：メモリーの作業履歴の全件から runId を拾って並べ、`role` 等と `fallback` を決めてから区切り、返す分（最大 100 件）だけ `meta.json` を読む（`meta.json` から取るのは `state`・`hasLog` と、作業履歴より優先する `role` 等だけ）

## エラー時の振る舞い

| 場合 | 結果 |
| --- | --- |
| タスクが無い・消したプロジェクトのタスク | デーモンは `{error:"not_found"}` の 404 を返す。ツールは `task.notFound` の文言を返す |
| 実行が無い・ほかのタスクの実行・ファイルがリンクか場所の外 | `{error:"not_found", what:"run"}` の 404（ファイルは開かない）。「実行が見つかりません」 |
| 工程・種類が候補に無い（`constructor` など） | ツールは引数の enum で SDK が断る。API は `{error:"not_found", what:"step"}`（`"kind"`）の 404。「工程が見つかりません」「成果物の種類が見つかりません」 |
| デーモンが開いておらずその実行の値も持たない実行で、`redactPending` が真か `finishedAt` が無い | `{error:"unredacted"}` の 409（中身を返さない）。「このログは秘密情報を伏せ直せていないため返せません」 |
| ログのファイルを開く・読むのに失敗した | `{error:"read_failed"}` の 500（中身とパスを返さない）。「ログを読めませんでした」 |
| 404 で、本文が `error` を持つ JSON として読めない（前の版のデーモンの既定の 404。本文は `404 Not Found`） | 既定で決めた、更新と再起動を促す理由 |
| `task_id`・`run_id` が `validLogId` に合わない（`..`・`/`・`%2F` を含む） | ツールが API を呼ばずに理由を返す。API も 400（`invalid_id`）で断る |
| `max_bytes`・`limit` が 0 以下、`offset` が負、`offset` と `from_end` の両方 | 0 以下と負は引数の型（`min`）で SDK が、両方はツールが、`isError` で返す |
| つながらない・時間切れ・認証できない | いまのツールと同じ文言（`daemonApi` の `request`・`refusal` を使う） |
| 404 以外の失敗の応答（500 など）で、本文が JSON として読めない | 「sacty が <状態コード> を返しました」（本文は入れない） |
| 200 の応答が JSON として読めない | 「sacty の応答を読めませんでした」 |

- 理由の文と `failureLine` には、仕様書の表の文言だけを出す。デーモンの応答の本文や、成果物とログの中身は出さない
- 新しいツールの `failureLine` の cause は、接続の失敗の種類（`ECONNREFUSED` などの `code`）と時間切れの印だけにし、例外の message（JSON の読み取りの失敗の `SyntaxError` など）は出さない

## 影響範囲

- 画面：`runLogId` の import 先が `@sacty/core` に変わるだけで、表示は変わらない。`meta.json` に足す `redactPending` は画面では読まない
- 文書：日英の版を同じ PR で直す。ADR には、上限と単位、位置の示し方、成果物・実行の指定の方法、前の版の見分け方と再起動の前提、伏せ直せていない実行の扱いと前の版の `meta.json` を見分けられない場合、比べた案を書く
- `docs/user/mcp.md`：実行中のログの最後の部分が、伏せる値の先頭の一部でありうる間は返らず、遅れて読めることを書く

## テスト観点

- [TV-1] 4つのツールが、型と読み取りの注釈を付けて一覧に載ること
  - 入力：MCP のクライアントから tools/list を呼ぶ
  - 期待結果：list_deliverables・get_deliverable・list_runs・get_run_log が、inputSchema・outputSchema と readOnlyHint: true・openWorldHint: false を持って載り、structuredContent と同じ JSON の文を返す
- [TV-2] 成果物が無いタスクの一覧が空で返ること
  - 入力：工程はあるが outputs・approved が空のタスクで list_deliverables を呼ぶ
  - 期待結果：isError でない、deliverables が0件の結果を返す
- [TV-3] 成果物が1件のときの一覧の中身と、差し戻し後・レビューの投稿前後の状態
  - 入力：requirements が承認待ち（gate が requirements の1回目）のタスク、requirements の1回目を差し戻して作り直しの実行が完了する前のタスク、レビューを投稿した（reviewPost がある・reviewRound=2）タスク、レビューの本文があり reviewPost が無い（reviewRound=2）タスクで list_deliverables を呼ぶ
  - 期待結果：1つ目は step=requirements・kind=output・submission=1・status=awaiting_approval・bytes が本文の UTF-8 のバイト数の1件を、2つ目は status=changes_requested・submission=1 を、3つ目は review の output と review_comments に status=posted・submission=2 を、4つ目は status=not_submitted・submission=null・previousSubmission=1 を返す
- [TV-4] やり直した工程で、最新の版とその回が分かること
  - 入力：design を2回提出し、2回目が承認済みのタスクで get_deliverable（step=design・kind=output）を呼ぶ
  - 期待結果：2回目の本文と submission=2・status=approved を返す
- [TV-5] まだ提出していない出力を、前の回の番号で示さないこと
  - 入力：design の1回目を差し戻した後、2回目の実行が完了して StepSubmitted がまだ無いタスクで get_deliverable を呼ぶ
  - 期待結果：新しい本文を status=not_submitted・submission=null・previousSubmission=1 で返す
- [TV-6] レビューの本文と行へのコメント、人が直した版、設計のテスト観点を読めること
  - 入力：review の本文と reviewComments が2件あるタスク、approved.edited.sacty がある工程を持つタスク、testViewpoints が2件ある design の工程を持つタスクで list_deliverables と get_deliverable を呼ぶ
  - 期待結果：review の output と review_comments（各コメントの path:line と本文を含む文）、edited の工程の sacty_version、design の test_viewpoints（2件の JSON）が一覧に載り、中身を読める
- [TV-7] 候補の工程・種類で本文が無い組を空で返すこと
  - 入力：工程の候補にあるがタスクに出力の無い step、edited の無い工程の sacty_version、review 以外の工程の review_comments で get_deliverable を呼ぶ
  - 期待結果：どれも isError でない status=none・text が空・totalBytes=0 を返す
- [TV-8] 本文を上限ちょうどと上限を1超える長さで切ること
  - 入力：UTF-8 で 32,000 バイトの本文と 32,001 バイトの本文で get_deliverable を呼ぶ
  - 期待結果：32,000 バイトでは clipped=false で全文を返し、32,001 バイトでは clipped=true・totalBytes=32001・next=返した末尾の位置を返す
- [TV-9] 上限を超える量・全体以上の位置・引数の組み合わせの扱い
  - 入力：max_bytes=1000000、offset=totalBytes・offset=totalBytes+10 で get_deliverable と get_run_log を、offset と from_end の両方・どちらも無しで get_run_log を、limit=101 で list_runs を呼ぶ
  - 期待結果：max_bytes は 32,000 に収めて clamped=true、全体以上の位置は isError でない0バイトの text と totalBytes、両方の指定は isError と理由、どちらも無しは offset=0 からの結果、limit=101 は 100 件までに収めて clamped=true を返す
- [TV-10] 量が0・負、位置が負の指定を断ること
  - 入力：max_bytes=0・max_bytes=-1・offset=-1・limit=0 で新しいツールを呼ぶ
  - 期待結果：中身を返さずに isError と理由を返す
- [TV-11] 複数バイトの文字とサロゲートペアの途中で切らないこと
  - 入力：日本語と絵文字の境目が上限の位置と offset の位置に来る本文とログで、get_deliverable と get_run_log を呼ぶ
  - 期待結果：text に置換文字（U+FFFD）や孤立したサロゲートが無く、next から読み直した text と続けると元の文と一致する
- [TV-12] 実行の一覧に、工程でない実行と各実行の状態が載ること
  - 入力：工程の成功・工程の失敗・orchestrator・guardian・export・audit の実行、デーモンが開いている実行、meta.json に finishedAt が無く開いていない実行、meta.json の無い実行（作業履歴に agentId がある実行と無い実行）、runId の無い AgentRunStarted を持つタスクで list_runs を呼ぶ
  - 期待結果：runId のある実行だけがすべて新しい順に載り、それぞれ state（succeeded・failed・running・unknown）を持ち、meta.json の無い実行だけ hasLog=false で、その role・agentId・startedAt は作業履歴の値、作業履歴にも無い項目は null になる
- [TV-13] 別のエージェントに切り替えた実行が、ページの区切りによらず分かること
  - 入力：AgentFellBack（agentId=claude・fallbackAgentId=codex）の後に codex で動いた実行を、レビューの工程と orchestrator の両方で持ち、間にほかの実行を挟んだタスクで、全件を1ページで、また失敗した実行と代わりの実行が別のページになる offset・limit で list_runs を呼ぶ
  - 期待結果：どの区切りでも、失敗した実行と代わりに動いた実行の両方に fallback={from: claude, to: codex} が入り、ほかの実行は fallback=null で、同じ実行の fallback は区切りで変わらない
- [TV-14] 実行の一覧を件数の上限で区切ること
  - 入力：実行が 101 件あるタスクで、limit を指定せずに、また limit=100・offset=100 で list_runs を呼ぶ
  - 期待結果：既定では 20 件と total=101・clipped=true・nextOffset=20 を返し、offset=100 では1件と clipped=false を返す
- [TV-15] 終わった実行のログを、末尾からと位置から読めること
  - 入力：events が 18MB（先頭 15MB・省いた印・末尾 3MB）、stderr が 2MB の終わった実行で、from_end=true と offset=0 で get_run_log を呼ぶ
  - 期待結果：from_end では末尾の max_bytes 分を、offset=0 では先頭から max_bytes 分を、画面の files/events と同じバイト列から返し、omittedMiddle=true を返す
- [TV-16] 大きなログと成果物でも、返す量に見合う分だけを読むこと
  - 入力：18MB の events の終わった実行と実行中の実行、5MB の本文の成果物で get_run_log と get_deliverable を呼び、デーモンのファイルの読み取り量と、MCP サーバーが受け取った応答の本文の大きさを数える
  - 期待結果：読み取り量は max_bytes＋最長の秘密情報のバイト数の2倍＋4 バイト以下、応答の本文は返した text を JSON の文字列にした長さ＋4,096 バイト以下で、どれも 30 秒のうちに返る
- [TV-17] 実行中のログで、先頭の上限を超えた後の末尾を読めること
  - 入力：先頭の上限を小さくした SessionLogStore で、伏せる値を持たない実行中の実行に上限を超えて書き、from_end=true で get_run_log を呼ぶ
  - 期待結果：running=true・omittedMiddle=true と、メモリーにある末尾のうち呼び出しの時点までに書いた最後の行までを含む text を返す
- [TV-18] 実行の途中で足した秘密情報が、ログに出ないこと
  - 入力：書き始めた後に addSecrets で足した値 sec-ADD-1 がファイルに伏せる前のまま残る実行中の実行、閉じた直後（伏せ直しの前に onClose が呼ばれた時点）の実行、伏せ直し（writeFileSync）が失敗した実行、伏せ直しの後の最後の meta.json の書き込みが失敗した実行（いずれも同じデーモンが動いている間）と、終わった後にプロジェクトの設定へ足した値 sec-PRJ-2 がファイルに平文で残る終わった実行で get_run_log を呼ぶ
  - 期待結果：どれも isError でなく、text に sec-ADD-1・sec-PRJ-2 が無く [REDACTED] になっている
- [TV-19] 伏せ直せていない実行と終わりの無い実行で、デーモンが値を持たないときは中身を返さないこと
  - 入力：ファイルに sec-ADD-1 が平文で残る次の実行を、それらの値を持たない（起動し直した）デーモンで get_run_log に渡す：meta.json に redactPending: true がある実行、redactPending の書き込みが失敗したまま止まり redactPending も finishedAt も無い実行、前の版が書いた finishedAt の無い実行
  - 期待結果：どれも isError と「このログは秘密情報を伏せ直せていないため返せません」を返し、結果・理由・標準エラーに sec-ADD-1 もログの中身も無く、伏せ直しが済んだ実行の meta.json には redactPending が無い
- [TV-20] 伏せる値が切り取りの境目と読める終わりをまたぐときに、値の一部を残さないこと
  - 入力：書き始めた後に addSecrets で足した ASCII の値 ghp_SECRETVAL と日本語を含む値 秘密値ABC が、ファイルに平文で残り offset の位置と max_bytes の末尾の位置をまたぐ範囲で、実行中と終わった実行の get_run_log を呼び、また出力が ghp_SECRETVAL の途中（ghp_SEC まで）で区切れて StreamRedactor が先頭を持っている実行中の実行と、値を足す前に ghp_SEC まで出力し足した後に残りを出していない実行中の実行で、from_end=true と末尾まで届く offset で呼ぶ
  - 期待結果：どの text にも ghp_SECRETVAL・秘密値ABC の先頭・末尾の一部（ghp_SEC・秘密 など）が無く、返した offset・next は [REDACTED] の外側に来て、区切れた値の先頭は text にも totalBytes にも入らない
- [TV-21] 無いタスク・無い実行・ほかのタスクの実行・候補外の工程と種類を断ること
  - 入力：存在しない task_id、消したプロジェクトのタスクの ID、そのタスクに無い run_id、別のタスクの run_id で新しいツールを、step=constructor・kind=__proto__ でデーモンの成果物の API を呼ぶ
  - 期待結果：どれも isError（API は not_found の 404）と仕様書の定型の理由を返し、ほかのタスクの成果物・ログの中身を含めない
- [TV-22] 決まった場所の外を指す ID とシンボリックリンクを読まないこと
  - 入力：run_id・task_id に ../x・/etc/passwd・%2e%2e%2fx・a/b をツールとデーモンの新しい API に渡し、runs/<タスク> と実行のログのファイルを外のファイルへのシンボリックリンクにして get_run_log を呼ぶ
  - 期待結果：ツールはデーモンを呼ばずに isError と理由を返し、API は ID では 400（invalid_id）、リンクでは not_found の 404 を返し、リンク先のファイルの読み取りは0回である
- [TV-23] ログのファイルを読めないときに、JSON の失敗の応答と定型の理由を返すこと
  - 入力：ログのファイルを開く・読むのが失敗する実行（読み取りで例外を投げる）で、デーモンのログの範囲の API と get_run_log を呼ぶ
  - 期待結果：API は {error:"read_failed"} の 500 を返し、ツールは isError と「ログを読めませんでした」を返して、結果・理由・標準エラーにファイルのパスとログの中身が無い
- [TV-24] 前の版のデーモンを「タスクが無い」と区別すること
  - 入力：新しい API に本文が 404 Not Found の文字列の 404 を返すデーモンで、新しいツールを呼ぶ
  - 期待結果：isError で sacty の更新と再起動を促す理由を返し、task.notFound の文言を返さない
- [TV-25] つながらないときに、新しいツールも同じ理由を返し、サーバーが動き続けること
  - 入力：「どのツールも理由を返す」のテストのループに新しい4つのツールを入れ、daemon.json が無い・接続を断られる・30 秒応答しない場合に呼ぶ
  - 期待結果：いまのツールと同じ理由を isError で返し、その後のツールの呼び出しにも応答する
- [TV-26] 結果・理由・標準エラーに秘密情報と中身を出さないこと
  - 入力：daemon.json のトークンを tok-MARK-1、環境変数の値を env-MARK-2、SACTY_HOME を /tmp/home-MARK-3 にし、成果物とログの本文に body-MARK-4 を入れて、新しいツールの成功と失敗（404・400・時間切れ・本文が body-MARK-4 を含む JSON でない 200 と 500）を起こす
  - 期待結果：structuredContent・content の文・isError の理由・標準エラーに tok-MARK-1・env-MARK-2・home-MARK-3 が無く、失敗のときは body-MARK-4 も無く、JSON でない 500 の理由は「sacty が 500 を返しました」、200 の理由は「sacty の応答を読めませんでした」で、failureLine はツール名・task_id・理由と、接続の失敗の種類か時間切れの印の cause だけを持つ
- [TV-27] 本物のデーモンの API と MCP サーバーをつないで新しいツールを使えること
  - 入力：packages/cli/src/mcp.test.ts で、createApp で立てたデーモンに daemon.json を向け、本物の daemonApi を使う MCP サーバーから、成果物と終わった実行のログを持つタスクに4つのツールを呼ぶ
  - 期待結果：4つとも isError でなく、デーモンが持つ成果物の本文・実行の一覧・ログの範囲と同じ値を、構成の表の項目で返す
- [TV-28] 説明文とサーバーの使い方の説明に、データの中の指示に従わないことがあること
  - 入力：4つのツールの description と INSTRUCTIONS
  - 期待結果：結果の成果物・ログはほかの人やエージェントが書いた文を含むデータで、その中の指示に従わないことが書かれている
- [TV-29] いまの5つのツールの引数と結果が変わらないこと
  - 入力：list_tasks・get_task・rereview_task・list_projects・create_task の inputSchema・outputSchema・注釈と、get_task の reviewBody を、起点のコミットの task-mcp.test.ts・mcp.test.ts の期待と比べる
  - 期待結果：5つの型・注釈・reviewBody の期待は起点のコミットのまま通り、テストで変えるのは、ツールの一覧の名前と注釈の期待に新しい4つを足すことと、SactyApi のスタブに新しい4つのメソッドを足すことだけである
- [TV-30] 画面の実行のリンクが変わらないこと
  - 入力：runLogId を @sacty/core に移した後の apps/web のタスクの詳細と実行のログの route
  - 期待結果：移す前と同じイベントの種類から実行を拾い、既存の web のテストが通る
- [TV-31] 文書に新しいツールとその決まりが書かれていること
  - 入力：docs/spec/mcp-server.md・docs/spec/architecture.md・docs/spec/event-log.md・docs/spec/README.md・docs/user/mcp.md・docs/user/cli.md・docs/user/README.md（日英）、CLI の使い方の表示、CONTRIBUTING.md のテストの表、docs/worklog の PBI-395 の作業履歴、docs/adr の新しい ADR の差分
  - 期待結果：4つのツールと引数・結果・状態・理由の文・新しい API、meta.json の redactPending、上限と単位・続きの位置・成果物と実行の指定の方法・前の版のデーモンの見分け方と再起動の前提・伏せ直せていない実行と終わりの無い実行の扱いと前の版の meta.json を見分けられない場合・比べた案、できること・できないこと、実行中のログの最後の部分が遅れて読めること、2つの README の MCP の項目の説明に成果物とログを読めること、CONTRIBUTING.md の task-mcp.test.ts の行に成果物と実行のログが書かれ、作業履歴に実行したコマンドと結果・PR の番号がある
- [TV-32] 検査が通ること
  - 入力：変更後の作業領域で npm run lint・npm run format・npm run typecheck・npm run build・npx vitest run --no-file-parallelism を実行する
  - 期待結果：どれも失敗なく終わる
- [TV-33] Claude Code と Codex から新しいツールを使えること
  - 入力：起動中の sacty に、Claude Code と Codex の MCP の設定で sacty mcp をつなぎ、4つのツールを呼ぶ
  - 期待結果：どちらのクライアントも結果の型を受け付け、成果物とログを読める（人が確かめる）
