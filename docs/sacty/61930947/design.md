<!-- sacty task 61930947-c9d0-407c-86be-d257008f18be の設計。sacty が作成しました。 -->

# PBI-482 テストの待ちの期限の揺らぎをなくし、全件テストの手順を CI にそろえる

## スコープ

`vi.waitFor` の待ちを、テストの時間切れの手前まで待つ共通の補助に置き換え、直接の呼び出しを検査で禁じる。
2026-11-22 に落ちた 2 つのテストを直し、全件テストの手順を CI と同じ直列にそろえる。

- 対象
  - `vi.waitFor` を使うテストの 14 ファイル・65 か所の全部（期限があるものも含む）
  - 落ちた 2 つのテスト：`context-fetch-exit.test.ts` の 3 通り・`daemon-step-pull-requests.test.ts` の「答えの返らないドラフトの切り替え…」
  - `vi.waitFor` の直接の呼び出しを見つける検査のテスト
  - `CONTRIBUTING.md` の「PR を出す前に確かめること」・`package.json` の `test`（Q-1）・作業履歴
- 対象外
  - `testing/wait.ts` の `waitFor` を期限つきで呼ぶ所（`timeoutMs` を指定した所）の見直し
  - `draftTimeoutMs: 20` を使うほかのテスト（:4127 など。落ちていない）
  - `CONTRIBUTING.md` の部分の実行（`npx vitest run tests/docs`・評価のテスト）と、sacty-docs のスキルの案内

## 確認したいこと

### must

なし

### should

- Q-1：`package.json` の `"test": "vitest run"` も `--no-file-parallelism` にそろえるか。
  - 推奨：そろえる。`npm test` を手順どおりに使う人が、並列で流して時間切れで落ちるのを防げる。
  - 懸念：そろえると `npm test` の全件が約 6 分になる（コンテナでは並列の約 165 秒より長い）。速さのために `npm test` を使っている人の待ちが延びる。
- Q-2：テスト 1 の「残らない」の判定で、ゾンビ（終わったが親に回収されていないプロセス）を残らないものとして数えてよいか。
  - 推奨：数える。ゾンビは動いておらず、資源も持たない。SIGKILL の後に回収が遅れると、`process.kill(pid, 0)` が成功して落ちる（CI の落ち方に合う）。
  - 懸念：数えないと、遅い実行機で回収を待つ間に落ち続けうる。数えると、回収されないまま残る不具合（ゾンビの溜まり）は、このテストでは見つからない。
- Q-3：テスト 2 の 200ms の実時間を、本体（`service.ts`）に差し込み口を足さずに、テストで `setTimeout` を見張って止めるか。
  - 推奨：見張る（PBI-473 と同じく本体を変えない）。
  - 懸念：本体が上限の待ちを `setTimeout` 以外で作るように変わると、テストが見張れず、上限の待ちが見つからないとして落ちる（気づける）。

### 確認しないと決めたこと

- 対象の数え方：数え方に関わらず、`vi.waitFor` の直接の呼び出しを全部置き換えるので、14 ファイル・65 か所を対象にする。検査が残りを見つけるので、人に確かめない。

## 既定で決めたこと

- 補助は `apps/daemon/src/testing/wait.ts` に置き、web（`daemon-signal.test.ts`）と desktop（`tests/desktop/main.test.ts`）は相対パスで読む。
- 検査は Biome の規則ではなく、`tests/` の下の Vitest のテストにする（`no-changed-lines-cap.test.ts` と同じ形）。

## 構成

| 対象 | 変更 |
| --- | --- |
| `apps/daemon/src/testing/wait.ts` | `waitForAssertion(callback, { timeoutMs?, intervalMs? })` を足す。`vi.waitFor` に、期限＝`timeoutMs` とテストの残り（`testTimeLeftMs`）の短いほう（テストの外は `FALLBACK_TIMEOUT_MS`）、間隔＝既定の 50ms を渡し、callback の戻り値を返す |
| `apps/daemon/src/testing/wait.test.ts` | 補助の期限がテストの残りに合わせて決まること、`timeoutMs` が残りで切り詰められることを足す |
| `vi.waitFor` を使う 14 ファイル | `waitForAssertion` に置き換える。期限つきの `daemon-context.test.ts` の 2 か所は `timeoutMs` に移す |
| `tests/conventions/wait-for.test.ts`（新規） | `apps`・`packages`・`tests` の `*.ts`（`node_modules`・`wait.ts`・検査のテスト自身を除く）に `vi.waitFor` があれば、ファイルと行を挙げて落ちる |
| `context-fetch-exit.test.ts` | `alive` を「ある、かつゾンビでない」にする（`ps -o stat= -p <pid>` の状態が `Z` でない）。4 か所の待ちを、期限なしの `waitForAssertion` にする |
| `daemon-step-pull-requests.test.ts` の上記のテスト | `ignoresAbort = true` の回だけ、`globalThis.setTimeout` を見張り、`20 * DRAFT_SETTLE_FACTOR` ms の呼び出しの関数を預かる。ドラフトを外さないことを確かめた後に、預かった関数を呼び、`draftRequestsSettled` を待つ |
| `CONTRIBUTING.md` | 全件のテストを `npx vitest run --no-file-parallelism` にし、並列で流すとファイルどうしが CPU を取り合い、時間切れで落ちうることを書く。待ちは `waitForAssertion` を使い、`vi.waitFor` を直接呼ばないことを書く |
| `package.json` | `test` を `vitest run --no-file-parallelism` にする（Q-1） |
| `docs/worklog/<UTC の日付>-pbi-482-test-wait-deadlines.md`（新規） | 直し方・テスト 1 の原因の調べ・CI の全件の時間（直す前の 332〜339 秒との比べ。延びたら理由）を書く |

## 影響範囲

- 成功するテストの時間は変わらない（期限が延びるのは、待つ対象が来ないときだけ）。テスト 2 は実時間の 200ms の待ちが無くなる。

## テスト観点

- [TV-1] waitForAssertion の期限が、テストの残りの時間に合わせて決まる
  - 入力：時間切れ 5 秒のテストで、ずっと失敗する callback を waitForAssertion に timeoutMs なしで渡す
  - 期待結果：1 秒（既定の vi.waitFor の期限）を過ぎても待ち続け、テストの時間切れより前に、callback の最後のアサーションのエラーで失敗する
- [TV-2] waitForAssertion の timeoutMs が、テストの残りの時間で切り詰められる
  - 入力：時間切れ 2 秒のテストで、ずっと失敗する callback に timeoutMs: 60_000 を渡す
  - 期待結果：テストの時間切れより前に、callback の最後のアサーションのエラーで失敗する
- [TV-3] waitForAssertion が、途中で成り立った条件を待って callback の戻り値を返す
  - 入力：300ms 後に成り立つアサーションを、値を返す callback で渡す
  - 期待結果：成り立った後に解決し、callback の戻り値を返す
- [TV-4] 検査が、vi.waitFor の直接の呼び出しを見つける
  - 入力：検査の対象に、vi.waitFor を 1 か所だけ呼ぶテストのファイルを置く（または置き換えた 1 か所を戻す）
  - 期待結果：検査のテストが、そのファイルと行を挙げて失敗し、置いたものを除くと通る
- [TV-5] リポジトリに vi.waitFor の直接の呼び出しが残らない
  - 入力：置き換えた後のリポジトリで、検査のテストを流す
  - 期待結果：検査のテストが通る（apps・packages・tests に、wait.ts のほか vi.waitFor の呼び出しが無い）
- [TV-6] テスト 1 が、ゾンビを残らないものとして扱い、遅れても切れない
  - 入力：context-fetch-exit.test.ts の 3 通りを、CPU を使い切るプロセスを 5 つ動かしたまま 30 回流す
  - 期待結果：全部の回で通る
- [TV-7] テスト 1 が、git のプロセスグループが残る不具合で落ちる
  - 入力：fetch-processes.ts の stopFetchProcessesSync でグループに SIGKILL を送る行を消して、context-fetch-exit.test.ts を流す
  - 期待結果：3 通りとも、生きている PID（sh と sleep）を挙げて失敗する
- [TV-8] テスト 2 が、実時間に頼らずに上限の前後を確かめる
  - 入力：答えの返らないドラフトの切り替えのテストを、CPU を使い切るプロセスを 5 つ動かしたまま 30 回流す
  - 期待結果：全部の回で通り、ignoresAbort = true の回で、預かった関数を呼ぶ前はドラフトを外さず、呼んだ後に外す
- [TV-9] テスト 2 が、終わっていない要求を数えない不具合で落ちる
  - 入力：service.ts の setDraftWithin で、中断に応じない要求を数えずにすぐ終わったものとして扱うよう壊して、テストを流す
  - 期待結果：ignoresAbort = true の回が、PullRequestMarkedReady を含むとして失敗する
- [TV-10] テスト 2 が、上限の待ちが終わらない不具合で落ちる
  - 入力：service.ts の DRAFT_SETTLE_FACTOR 倍の setTimeout を消して（終わらない要求をずっと数える）テストを流す
  - 期待結果：見張りが上限の待ちを見つけられないか、draftRequestsSettled が待つ対象が来なかったとして失敗する
- [TV-11] CONTRIBUTING.md の全件テストの手順が CI とそろう
  - 入力：CONTRIBUTING.md の「PR を出す前に確かめること」
  - 期待結果：全件のテストが npx vitest run --no-file-parallelism で、並列で流すと時間切れで落ちうること、待ちに waitForAssertion を使い vi.waitFor を直接呼ばないことが書かれている
- [TV-12] npm test が直列で流れる
  - 入力：package.json の scripts.test
  - 期待結果：vitest run --no-file-parallelism になっている
- [TV-13] CI の全件テストの時間が大きく延びない
  - 入力：実装の PR の CI の全件テスト（npx vitest run --no-file-parallelism）
  - 期待結果：Duration が 2026-11-22 の 332〜339 秒と同じほどで、延びたときは作業履歴に理由が書かれている
