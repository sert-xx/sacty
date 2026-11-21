<!-- sacty task 6245471d-0be4-4a3d-9682-a75206a456a8 の設計。sacty が作成しました。 -->

# PBI-467 一時的な git push の失敗をやり直す：設計

## スコープ

PR を作る・直しを積む push が一時的な失敗で終わったら、デーモンは同じコミットの push だけを、間を置いて最大 3 回やり直す。
やり直しを作業履歴に記録する。
push の失敗で止めるときは、停止の理由の文の先頭に失敗の行を置く。

- 対象
  - `apps/daemon/src/repository.ts`：PR の push（`publish`・`pushCommit`・`commitFiles`）の言語の固定・失敗の分類・停止の理由の文の整形
  - `apps/daemon/src/service.ts`：`publish`・`publishContinued`・`publishStepPullRequest` の push のやり直し
  - `packages/core`（イベント 2 種）・`apps/web`（作業履歴の表示名の日英）
  - 仕様書（日英）・ユーザー文書（日英）・ADR・docs/worklog
- 対象外
  - `deleteBranch` の push（ブランチの削除）
  - 再開の流れ（R-11）：今のコードのままで、止まった push からやり直す。テストだけを足す
  - 前の版で記録した停止の理由の文の整形し直し（再開の後に push が通れば消える）

## 確認したいこと

### must

なし

### should

- やり直しの回数と間隔を、15 秒・1 分・3 分の 3 回（計 4 分余り）にしてよいか。
  推奨：はい。レビューの前例（15 秒〜5 分の 4 回、約 9 分）より短くし、待つ間にタスクの実行の枠を持ち続ける時間を抑えるため。
  懸念：GitHub の障害が 5 分を超えると今までどおり止まり、利用者が再開する手間が残る。

## 既定で決めたこと

- PR の push は `LC_ALL=C` で実行する（R-1）。
  停止の理由の文に出る git の文言は、`LANG` に依らず英語になる。
- 待つ間も、タスクの実行の枠を手放さない（レビューの `retryTransient` と同じ）。
- 除く案内の行は、次の 4 種に限り、ほかの `remote:` の行は残す。
  - 空の `remote:`
  - `remote: Create a pull request ...`
  - `remote: To create a merge request ...`
  - URL だけの `remote:` の行

## 構成

| 場所 | 変更 |
| --- | --- |
| `repository.ts` | `PushFailedError` を足す（`MessageError` を継ぎ、`transient`・`commit`・`branch` を持つ）。`classifyPushFailure(stderr)`・`formatPushFailure(stderr)` を export する |
| `service.ts` | `retryPush(taskId, usedSecrets, push)` を足す。待つ・やめるの判定は、`retryTransient` と共通の関数に切り出す。待ち時間は `deps.pushRetryDelaysMs`（既定 `[15_000, 60_000, 180_000]`。テストで差し替える） |
| `events.ts`・`projection.ts` | `PushRetried`・`PushRetryEnded`（記録だけ） |
| `labels.ts`（web の 2 ファイル） | 2 種の表示名（日英） |
| `testing/daemon.ts` | 偽の push に、回ごとの git の標準エラーと「push は通ったが応答が失われた」状態を返させる指定を足す。失敗は、本物の分類で作った `PushFailedError` にする |

## データ

- `PushRetried { branch, commit, attempt, maxAttempts, waitMs, message }`：`message` は伏せた失敗の文（R-4）
- `PushRetryEnded { branch, commit, outcome: "pushed" | "failed", retries }`（R-5・R-8）
- 新しい種類を記録した作業履歴は、前の版のデーモンが読めない（`activity.ts` の `toEvent` が `EventInput.parse` を通す）。
  このことを ADR と event-log の仕様書に書く。

## 処理の流れ

1. repository の push は、失敗したら標準エラーを分類し、`PushFailedError` を投げる。`git.failed` の `detail` は整形した文にする。
   - 一時的でない（先に判定する）：`[rejected]`、理由が `(failed)` 以外の `[remote rejected]`、`GH\d{3}`・`protected branch`、`Authentication failed`・`Permission denied`、レート制限を含まない HTTP 401・403
   - 一時的：`[remote rejected] ... (failed)`、`Internal Server Error`、HTTP 5xx（`RPC failed; HTTP 5xx`・`returned error: 5xx`）、HTTP 429・`rate limit`、接続の失敗（`Could not resolve host`・`Failed to connect`・`Connection reset`・`timed out`・`the remote end hung up unexpectedly` など）
   - どちらにも当たらない失敗と、`git.unavailable`・`git.interrupted`：一時的でない（R-7）
2. `retryPush` は、一時的な `PushFailedError` のときだけ、次を上限まで繰り返す。
   それ以外の失敗は、そのまま投げる。
   1. 決めた時間を、1 秒ごとに区切って待つ。一時停止・中止・デーモンの停止に気づいたら `RetryAbandoned` を投げる（R-9）
   2. `PushRetried` を記録し、`repos.pushCommit(gitDir, commit, branch)` で同じコミットを push する
   3. 通ったら `PushRetryEnded(pushed, retries)` を記録して返す。ブランチの先頭がすでに同じコミットなら git の push は通るので、同じく扱う（R-13）
3. 上限まで通らなければ、`PushRetryEnded(failed, retries)` を記録して、最後の失敗を投げる。
   呼び出し側は今までどおり、`pr.failed` などで止める（R-8）。
4. 呼び出し側
   - `publish`：`RetryAbandoned` なら `"stopped"` を返す
   - `publishStepPullRequest`：タスクブランチの作成・同じ PR の更新・新しいブランチの push の 3 か所を包む。`RetryAbandoned` なら、何も記録せずに終える
   - `publishContinued`：一時的な失敗が上限まで続いたら、先頭を読み直す再 push をせずに `pr.failed` で止める（R-12）。再 push は、一時的でない失敗のときだけ残す
5. 停止の理由の文の整形（R-10）：案内の行を除き、`!`・`error:`・`fatal:` で始まる行を元の順のまま先頭に移し、残りの行を後ろに置く。
   秘密の値は今までどおり記録の直前（`redactText`）で伏せ、切り詰めは通知の側でするので、伏せてから切り詰める順は変わらない。

## 影響範囲

- 仕様書（日英）
  - tasks-and-steps（実装の PR の作成・既存の PR の引き継ぎ）と approval（要求要件・設計の PR）に、やり直す失敗の種類・回数・間隔・作業履歴に出ることを書く
  - event-log に、2 種のイベントと、前の版に戻せないことを書く
- ユーザー文書（日英）：tasks に、上の内容と、一時的でない失敗はすぐ止まること、停止の理由の文から案内の行が除かれて失敗の行が先頭に来ることを書く
- ADR（日本語）：回数・間隔・分類・`LC_ALL=C`・前の版に戻せないことを書く
- docs/worklog：この PR の分を足す

## テスト観点

- [TV-1] 実装の PR の push が `[remote rejected] ... (failed)` で 1 回失敗した後、止まらずに同じコミットを同じブランチへ push し直して PR を作ること（R-3〜R-5）
  - 入力：偽の push が 1 回目に `! [remote rejected] <sha> -> <branch> (failed)` と `error: failed to push some refs` の標準エラーで失敗し、2 回目に通る。`pushRetryDelaysMs` は 0 の 3 つ
  - 期待結果：`TaskPaused` が無く、`PushRetried`（attempt 1・maxAttempts 3・waitMs 0・失敗の文）、`PushRetryEnded`（outcome pushed・retries 1）、`PullRequestPublished` の順に記録され、2 回目の push のコミットとブランチが 1 回目と同じである
- [TV-2] HTTP 5xx・レート制限・接続の失敗を一時的とみなしてやり直すこと（R-3）
  - 入力：1 回目の push の標準エラーを、`error: RPC failed; HTTP 500`・`The requested URL returned error: 429`・レート制限の文を含む HTTP 403・`Could not resolve host: github.com` のそれぞれにし、2 回目は通る
  - 期待結果：どの場合も `PushRetried` が 1 件・`PushRetryEnded`（pushed・retries 1）が記録され、タスクは止まらずに PR が作られる
- [TV-3] 一時的でない push の失敗は、やり直さずにすぐ止めること（R-7）
  - 入力：push の標準エラーを、保護での拒否（`remote: error: GH006: Protected branch update failed`）・ルールでの拒否（`GH013`）・`[remote rejected] ... (pre-receive hook declined)`・`[remote rejected] ... (refusing to allow an OAuth App to create or update workflow ... without workflow scope)`・`! [rejected] ... (non-fast-forward)`・`Authentication failed`・どの分類にも当たらない文のそれぞれにする
  - 期待結果：どの場合も push は 1 回だけで、`PushRetried`・`PushRetryEnded` が無く、`TaskPaused`（reason error・`pr.failed`）が記録される
- [TV-4] 上限の回数までやり直しても通らなければ、回数を記録して今までと同じ種類で止まること（R-8）
  - 入力：実装の PR の push が、4 回とも `[remote rejected] ... (failed)` で失敗する。`pushRetryDelaysMs` は 0 の 3 つ
  - 期待結果：push が 4 回、`PushRetried` が attempt 1〜3 の 3 件、`PushRetryEnded`（outcome failed・retries 3）が記録された後に `TaskPaused`（reason error・`pr.failed`）が記録される
- [TV-5] やり直しを待つ間に一時停止したら、push も記録もせずにやめ、一時停止の理由を上書きしないこと（R-9）
  - 入力：1 回目の push が一時的な失敗で終わり、`pushRetryDelaysMs` が 60 秒。待つ間に人がタスクを一時停止する
  - 期待結果：push は 1 回だけで、`PushRetried`・`PushRetryEnded` が無く、最後の `TaskPaused` の reason が manual のままである
- [TV-6] 停止の理由の文から案内の行を除き、失敗の行を先頭に置き、秘密の値を伏せること（R-10）
  - 入力：一時的でない失敗の標準エラーが、`remote:`・`remote: Create a pull request for 'x' on GitHub by visiting:`・`remote:      https://github.com/o/r/pull/new/x`・`remote: error: GH006: Protected branch update failed`・`To https://github.com/o/r.git`・`! [remote rejected] ...`・`error: failed to push some refs`（秘密の値を含む）の順に並ぶ
  - 期待結果：`TaskPaused` の文の `detail` は `! [remote rejected]` の行で始まり、`Create a pull request` の行・URL だけの行・空の `remote:` の行を含まず、`remote: error: GH006 ...` の行を含み、秘密の値が伏せ字になっている
- [TV-7] 前の回で push が通って応答だけが失われたとき、やり直しの push を通ったとして扱い、回数に数えること（R-13）
  - 入力：偽の push が 1 回目にブランチの先頭を今回のコミットに進めたうえで `[remote rejected] ... (failed)` を返し、2 回目は先頭がすでに同じコミットである
  - 期待結果：`TaskPaused` が無く、`PushRetried` が 1 件・`PushRetryEnded`（outcome pushed・retries 1）が記録され、PR が作られる
- [TV-8] 引き継いだ PR の push が一時的な失敗のまま上限に達したら、ブランチが進んだとせずに push の失敗で止まること（R-12）
  - 入力：既存の PR を引き継ぐタスクで、PR のブランチへの push が 4 回とも `[remote rejected] ... (failed)` で失敗し、ブランチの先頭は起点とも前に push したコミットとも違う
  - 期待結果：`PushRetryEnded`（failed・retries 3）の後に `TaskPaused`（reason error）が記録され、その文が `pr.failed` で `pr.continuedBranchMoved` ではない
- [TV-9] 要求要件・設計の PR の push も一時的な失敗でやり直し、ブランチの名前を増やさないこと（R-3）
  - 入力：設計の PR を作るとき、新しいブランチへの `pushCommit` が 1 回目に `[remote rejected] ... (failed)` で失敗し、2 回目に通る
  - 期待結果：`PushRetried` が 1 件・`PushRetryEnded`（pushed・retries 1）が記録され、`StepBranchPushed` と `StepPullRequestPublished` のブランチが 1 回目の push と同じ名前（`-design-1`）である
- [TV-10] push の失敗の分類が、デーモンの `LANG` に依らず同じになること（R-1）
  - 入力：本物の git で、受け取る側の pre-receive フックが `LC_ALL` の値を標準エラーに出して拒否するローカルの bare リポジトリへ、デーモンの `LANG` を `ja_JP.UTF-8` と `C` にして `pushCommit` する
  - 期待結果：どちらも `PushFailedError` の transient が false で、`detail` が同じ文であり、`remote: LC_ALL=C` の行を含む
- [TV-11] push の失敗で止まった実装の PR・引き継いだ PR・要求要件と設計の PR を再開すると、エージェントを実行せずに push からやり直すこと（R-11）
  - 入力：それぞれの PR の push が上限まで一時的な失敗で止まった後、PR に新しい指摘が無いまま人が再開し、偽の push は次に通る
  - 期待結果：再開の後にエージェントの実行の記録が無く、push が 1 回で通り、`PullRequestPublished`（要求要件・設計は `StepPullRequestPublished`）が記録される
- [TV-12] 前の版の形の停止の理由で止まったタスクと、やり直しを待つ間に一時停止したタスクを再開しても、push からやり直すこと（R-11）
  - 入力：(a) `TaskPaused` の文に `remote: Create a pull request ...` の案内の行が残る `pr.failed` で止まった実装のタスク、(b) やり直しを待つ間に一時停止した実装のタスクを、PR に新しい指摘が無いまま再開し、1 回目の push が一時的な失敗・2 回目が通る
  - 期待結果：どちらもエージェントの実行の記録が無く、`PushRetried` が 1 件・`PushRetryEnded`（pushed・retries 1）・`PullRequestPublished` が記録される
- [TV-13] 作業履歴の画面で、push のやり直しの 2 種のイベントを日英の表示名で出すこと（R-6）
  - 入力：`PushRetried`（attempt 2・maxAttempts 3・waitMs 60000・失敗の文）と `PushRetryEnded`（pushed・retries 2 と failed・retries 3）の表示名を、日本語と英語で作る
  - 期待結果：日英それぞれで、何回目か・上限・待った秒数（60）・失敗の文と、通ったか通らなかったかと回数を含む、ほかのイベントの表示名と重ならない文になる
- [TV-14] 仕様書（日英）に、push のやり直しと新しい記録が書かれていること（R-2）
  - 入力：この変更の PR の docs/spec の tasks-and-steps・approval・event-log（日英）の差分
  - 期待結果：PR の push（実装・引き継ぎ・要求要件と設計）で、一時的とみなす失敗の種類・一時的でない失敗はすぐ止まること・回数（3 回）・間隔（15 秒・1 分・3 分）・作業履歴に `PushRetried`・`PushRetryEnded` が出ることが書かれ、event-log の記録だけのイベントに 2 種と、一度記録したら前の版のデーモンに戻せないことが書かれている
- [TV-15] ユーザー文書（日英）・ADR・docs/worklog に、利用者に見える変更と方針が書かれていること（R-2）
  - 入力：この変更の PR の docs/user/tasks（日英）・新しい ADR（日本語）・docs/worklog の差分
  - 期待結果：ユーザー文書に、やり直す失敗の種類・回数・間隔・作業履歴に出ること・一時的でない失敗はすぐ止まること・停止の理由の文から `remote:` の案内の行が除かれ失敗の行が先頭に来ることが今の振る舞いとして書かれ、ADR に回数・間隔・分類・`LC_ALL=C`・前の版に戻せないことが、worklog にこの PR の変更が書かれている
