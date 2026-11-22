<!-- sacty task 8da97908-e52f-4dc7-8d62-ac88f1a34093 の設計。sacty が作成しました。 -->

# 設計：実時間の経過に上限・下限を置くテストを、時間に頼らない検査に直す

## スコープ

承認済みの 31 件の検査を、偽の時計・止めた理由・回数・順序・入力の大きさで確かめる形に直し、作業履歴に一覧と実測を残す。
本体は変えない。

- 対象
  - テストのファイル 20 個の 29 件と、`daemon-implement.test.ts` の 2 件（`within` の 3 秒・PBI-430 の 800ms の前提）
  - 作業履歴 `docs/worklog/YYYYMMDD-pbi-473-tests-no-wall-clock.md`
- 対象外
  - 本体への時計・期限の差し込み口（要らないので足さない。R-5 は当てはまらない）
  - `vi.waitFor` の既定の 1 秒と、`apps/daemon/src/testing/wait.ts` の `waitFor` の `timeoutMs` など、条件を待つ期限（Q-1）
  - CI の `--no-file-parallelism` と、CI の設定のコメント

## 確認したいこと

要求要件の S-1〜S-4 とは別の問いなので、Q-n で示す。

### must

なし

### should

- **Q-1 条件を待つ期限（`vi.waitFor` の既定の 1 秒と、`testing/wait.ts` の `waitFor` の `timeoutMs`）を含めるか**：推奨は含めず、作業履歴に「検査に数えない一致」として理由（条件を待つ期限で、経過時間を測っていない）を書くこと。
  理由：承認済みの範囲は 31 件で、`vi.waitFor` は 14 ファイル・65 か所、`testing/wait.ts` の `waitFor` は 11 ファイルで使われ、直し方も別になる。
  懸念：遅い CI で待ちが切れて main が赤くなれば、利用者は別のタスクで直すことになる。
- **Q-2 `task-mcp-read.test.ts:384` の 30 秒を、線形の検査に数えず外すか**：推奨は外すこと。
  要求要件の S-4・R-11（線形の検査すべてで 2 乗の版を実測する）の対象から、この 1 件を除くことになる。
  理由：上限の 30 秒はテストの時間切れの 5 秒より長く、今も合否を決めていない。返す量は、既にある本文の長さの検査が確かめる。
  懸念：この 1 件も実測が要るなら、2 乗の版を作って測る手間が実装に足される。

## 既定で決めたこと

- 終わらない偽があり、期限が効かないと戻らない検査は、経過時間の検査を外し、固まりはテストの時間切れで捕まえる（下の表の「外す」）。
  CI のログには、理由の文ではなく `Test timed out` が出る。
- 負荷は、`nproc` 個の `node -e "for(;;){}"` を動かしたまま、`npx vitest run --no-file-parallelism` を 5 回続けて流してかける。
  終わったら（失敗・打ち切りでも）負荷のプロセスを止め、`pgrep -f 'for\(;;\)'` で残りが無いことを確かめる。
- `daemon-audit-bulk`・`audit-causes` の、かかった時間を出す `console.info` は残す（合否には使わない）。

## 直し方

表の「種類」は次のとおり。
「外す」は R-2 の一覧に、理由とともに載せる。

- 置き換え：経過時間の検査の代わりに、時間に頼らない検査（偽の時計・止めた理由・状態・エラーの文）で、期限を待たずに終わったことを見分ける
- 外す：経過時間の検査を外し、固まりはテストの時間切れだけで捕まえる

### 固まらない・待たない・期限で止まる検査（13 件）

| 検査 | 直し方 | 種類 |
| --- | --- | --- |
| `host-mcp.test.ts:648`・`:891` | 2 回目の `ready` の前に `setTimeout`・`Date` を偽の時計にし、時計を進めずに `advanceTimersByTimeAsync(0)` だけで終わることを確かめる | 置き換え |
| `host-mcp.test.ts:683`（下限） | 偽の時計で `readyWaitMs: 50` の 49ms 先ではまだ終わらず、50ms で `gateway.mcpReadyTimeout` を返すことを確かめる | 置き換え |
| `pr-body-links.test.ts:527` | 重い本文ごとに、`cannotLinkToWorkspace(body, "/workspace")` が `true`（解析しない）であることを確かめる | 置き換え |
| `daemon-context.test.ts:392` | `prefetchSecrets` が戻った時点で、取得がまだ解かれていない（`active > 0`）ことを確かめる | 置き換え |
| `session-logs.test.ts:657`・`wait.test.ts:27`・`:82` | 既にあるエラーの文の検査（終わった・テストの時間切れの前に止めた）で、期限を待たずに落ちたことを見分ける。経過時間の検査を外す | 置き換え |
| `daemon-implement.test.ts` の PBI-430 の 800ms | `vi.spyOn(AbortSignal, "timeout")` で期限の合図をテストが持ち、知らせ1の期限、解消の期限の順に手で切る。知らせ2の期限は切らない | 置き換え |
| `daemon-steps.test.ts:497` | 準備は終わらないので、止めたことだけが待ちを抜ける。経過時間の検査を外す | 外す |
| `daemon-implement.test.ts:4157` の `within`（3 秒） | 使っている 3 件から外し、`runNext` を直接待つ | 外す |
| `context.test.ts:2894` | `/dev/zero` を読み続ければ戻らないので、経過時間の検査を外す。既にある設定の中身の検査は残す | 外す |
| `task-mcp-read.test.ts:384` | 上限の 30 秒はテストの時間切れより長いので外す（Q-2）。既にある本文の長さの検査は残す | 外す |

### 線形の時間を見る検査（18 件）

- 対象：`agent-json.test.ts:342`・`:468`・`:477`、`redact.test.ts:73`・`:82`・`:87`、`ci.test.ts:328`、`imitated-notices.test.ts:123`、`memory.test.ts:407`、`platforms.test.ts:616`、`pr-body-links.test.ts:335`・`:517`、`pr-body-summary.test.ts:519`、`remark-line.test.ts:105`、`step-questions.test.ts:433`、`projects.test.ts:264`、`daemon-audit-bulk.test.ts:429`、`audit-causes.test.ts:614`
  - 経過時間の検査を外し、入力の繰り返しの数を、M-1 の条件（2 乗の版はそのテストの時間切れで落ち、通常の版は負荷下でその 5 分の 1 未満で終わる）を満たす大きさにする。
    時間切れは既定の 5 秒で、`daemon-audit-bulk` だけはテストが指定した 60 秒。
  - 2 乗の版は、テストが呼ぶ本体の関数（`redactEscaped`・`withoutRemarkIds` など）の線形にしている処理を、先頭から読み直す形に戻して作る。
    測るたびに戻し、最後に本体のファイルに差分が無いことを確かめる。
  - 条件を満たす大きさが無いもの（`PR_BODY_MAX` を超えるとテストの前提が崩れる、など）は、R-2 に理由を書き、余裕を広げる。
- `daemon-audit-bulk` の `rebuilds` が 1、`audit-causes` のボタンの数とページの大きさの検査は残す。
  `audit-causes` は、要求要件の S-2 のとおり、テスト名から「最初の原因が出るまで 2 秒以内」を除く。

## 作業履歴

`docs/worklog/README.md` の形で書き、「したこと」「確かめたこと」に次を載せる。

- 洗い出し：検索の条件（`Date.now()`・`performance.now()`・`process.hrtime`、`elapsed` などの変数と `toBeLessThan`・`toBeGreaterThan` の組み合わせ、`Promise.race` と `setTimeout`、`waitFor`・`vi.waitFor` の期限）と、31 件の 1 行ずつの一覧（ファイル・テスト名・今の閾値・直し方・元の検査が確かめていたこと）
- 検査に数えない一致：`testTimeLeftMs`・`githubRetryAfterMs`・固定の待ち・`vi.waitFor` の期限・`testing/wait.ts` の `waitFor` の `timeoutMs` と、その理由
- 線形の 18 件の実測（2 乗の版と、負荷下の通常の版）
- S-3 の 5 件で壊した本体の箇所と、落ちたテスト名（壊すたびに戻し、最後に本体のファイルに差分が無いことを確かめる）
  - `host-mcp.ts` の `readyOne`：起動し直すのを待っているときも待つ（`:648`）、期限に `readyWaitMs` を使わない（`:683`）
  - `service.ts` の `contextSecretUsesOf`：期限の `Promise` を競争から外す（`daemon-context:392`）
  - `service.ts` の準備の待ち：人の停止と競わせない（`daemon-steps:497`）
  - `redact.ts` の `redactEscaped`：2 乗の版にする（`redact:82`）
- R-9 の 5 回の結果と、置き換えていない検査が落ちたときのテスト名と回数

## テスト観点

- [TV-1] 作業履歴に、洗い出しの検索の条件と 31 件の一覧がある
  - 入力：PR の作業履歴 docs/worklog/YYYYMMDD-pbi-473-tests-no-wall-clock.md を読む
  - 期待結果：検索の条件（時刻の差・elapsed などの変数を経由する差・Promise.race と setTimeout・waitFor の期限）と、31 件それぞれのファイル・テスト名・今の閾値・直し方・元の検査が確かめていたことが 1 行ずつ書かれている
- [TV-2] 置き換えなかった検査ごとに、理由と、余裕を広げたか外したかが書かれている
  - 入力：作業履歴の一覧で、直し方が「外す」「余裕を広げる」のもの（daemon-steps.test.ts:497・within の 3 秒・context.test.ts:2894・task-mcp-read.test.ts:384 など）を読む
  - 期待結果：それぞれに、時間に頼らない検査に置き換えられない理由と、外したか余裕を広げたか（広げたなら新しい閾値）が書かれている
- [TV-3] 検索し直すと、残った一致は R-2 の一覧と「検査に数えない一致」だけになる
  - 入力：変更後のリポジトリを、作業履歴に書いた検索の条件で検索する
  - 期待結果：見つかった一致は、R-2 で余裕を広げたものと、作業履歴の「検査に数えない一致」（testTimeLeftMs・githubRetryAfterMs・固定の待ち・vi.waitFor の期限・testing/wait.ts の waitFor の timeoutMs）のどちらかに載っている
- [TV-4] 本体のコードが変わっていない
  - 入力：PR の差分のうち、*.test.ts と docs/ 以外のファイルを見る
  - 期待結果：本体のファイル（apps/daemon/src・apps/web/src・packages/core/src のテストでないファイル）に変更が無い
- [TV-5] 準備を待つ上限の前後で、ready の結果が分かれる
  - 入力：host-mcp.test.ts:683 の置き換えた検査で、偽の時計にして readyWaitMs: 50 の ready を呼び、時計を 49ms、続けて 1ms 進める
  - 期待結果：49ms の時点では ready が終わっておらず、50ms の時点で gateway.mcpReadyTimeout（seconds: 0）を返して終わる
- [TV-6] 起動し直すのを待っている MCP サーバーと、時間切れの値だけ変えた MCP サーバーは、時計を進めずに ready が終わる
  - 入力：host-mcp.test.ts:648 と :891 の置き換えた検査で、2 回目の ready を偽の時計のまま呼び、advanceTimersByTimeAsync(0) だけを流す
  - 期待結果：どちらも 2 回目の ready が終わり、:648 は前と同じ理由を返して fake.envs が 1 件、:891 は空の配列を返して fake.calls() が 1 である
- [TV-7] 解析しても作業領域へのリンクがありえない重い本文は、解析の前に見分けられる
  - 入力：pr-body-links.test.ts:527 の置き換えた検査で、重い本文 4 つを cannotLinkToWorkspace(body, "/workspace") に渡す
  - 期待結果：4 つとも true を返し、withoutWorkspaceLinks の結果は元の本文と同じである
- [TV-8] コンテキストの取得が終わらなくても、prefetchSecrets は期限で戻る
  - 入力：daemon-context.test.ts:392 の置き換えた検査で、解かれるまで終わらない偽の取得と timeoutMs: 50 で prefetchSecrets を呼ぶ
  - 期待結果：prefetchSecrets が、取得がまだ解かれていない（active > 0）うちに 10 件の問題を返し、同時に動いた取得は 4 以下である
- [TV-9] 知らせ2は、自分の期限ではなく、解消の期限で止められる
  - 入力：daemon-implement.test.ts の PBI-430 のテストで、AbortSignal.timeout を差し替え、知らせ1の期限、解消の期限の順に手で切り、知らせ2の期限は切らない
  - 期待結果：知らせ2の合図の理由が AbortError、知らせ1の合図の理由が TimeoutError で、テストに timeoutMs（800ms）への前提が残っていない
- [TV-10] S-3 の 5 件で本体を壊すと、それぞれのテストが落ち、本体は元に戻っている
  - 入力：host-mcp.ts の readyOne（2 通り）、service.ts の contextSecretUsesOf の期限と準備の待ちの停止、redact.ts の redactEscaped を 1 つずつ壊して該当のテストを流し、壊すたびに戻す
  - 期待結果：壊すごとに、host-mcp.test.ts:648・:683、daemon-context.test.ts:392、daemon-steps.test.ts:497、redact.test.ts:82 の該当のテストが落ち、壊した箇所と落ちたテスト名が作業履歴にあり、最後に本体のファイルに差分が無い
- [TV-11] 線形の 18 件の入力が、2 乗への退行を捕まえる大きさになっている
  - 入力：作業履歴の、線形の時間を見る 18 件（daemon-audit-bulk.test.ts:429・audit-causes.test.ts:614 を含む）の実測の表を読む
  - 期待結果：18 件すべてで、2 乗の版がそのテストの時間切れ（既定 5 秒、daemon-audit-bulk は 60 秒）を超えて落ち、R-9 の負荷下の通常の版がその時間切れの 5 分の 1 未満で終わった時間が書かれている
- [TV-12] audit-causes・daemon-audit-bulk・task-mcp-read の検査から経過時間が外れ、量と回数の検査が残る
  - 入力：audit-causes.test.ts:614・daemon-audit-bulk.test.ts:429・task-mcp-read.test.ts:384 の直した検査を読む
  - 期待結果：3 件とも経過時間の検査が無く、audit-causes はボタンの数とページの大きさの比較が残ってテスト名に「2 秒以内」が無く、daemon-audit-bulk は rebuilds が 1、task-mcp-read は返した本文の長さの上限の検査が残っている
- [TV-13] 全件のテストが通る
  - 入力：変更後のリポジトリで npx vitest run --no-file-parallelism を実行する
  - 期待結果：失敗 0 件で終わる
- [TV-14] lint・型チェック・ビルドが通る
  - 入力：変更後のリポジトリで npm run lint・npm run typecheck・npm run build をそれぞれ実行する
  - 期待結果：3 つとも終了コード 0 で終わる
- [TV-15] CPU を使い切る負荷の下でも、置き換えた検査が落ちず、負荷のプロセスが残らない
  - 入力：nproc 個の node -e "for(;;){}" を動かしたまま npx vitest run --no-file-parallelism を 5 回続けて実行し、終わったら負荷のプロセスを止める
  - 期待結果：5 回のどれでも、作業履歴の一覧にある置き換えた検査が 1 件も落ちず、置き換えていない検査が落ちた場合はそのテスト名と落ちた回数が作業履歴に範囲外として書かれ、実行の後に pgrep で負荷のプロセスが見つからない
