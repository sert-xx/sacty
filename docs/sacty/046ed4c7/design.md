<!-- sacty task 046ed4c7-807e-4c2d-bbe4-f0b651064dc9 の設計。sacty が作成しました。 -->

# PBI-480 工程のブランチの片付けの知らせ・完了で残ったブランチ・stale info の扱い

## スコープ

工程のブランチの片付けで出す知らせを、画面の言語で出す。
完了で消せなかったブランチは、記録して画面に出す。
`stale info` で断られた削除は、取得し直して扱う。

- 対象
  - `settleStepBranch`・`settleStepBranches` の知らせの持ち方と、中止の cleanup への渡し方
  - 完了の片付け（`retireWorkspace`）で消せなかったブランチの記録（新しいイベント）と、タスクの詳細・作業履歴の表示
  - `deleteBranch` の `stale info` の見分けと、断られた後の取得し直し
  - 仕様書・ユーザー文書（日英）、ADR の追加、作業履歴
- 対象外
  - 完了で消せなかったブランチを、後で自動でやり直すこと（記録して人に任せる）
  - 実装を含む進め方のタスクブランチの片付け、英語版の文書の用語の統一

## 確認したいこと

- must
  - Q-1：完了で消せなかったブランチは、やり直さずに、ブランチと理由を記録して画面に出すだけでよいか。
    推奨：はい。完了の片付けは作業領域を用意し直せず（`prepare: false`）、最後の push の記録が無いブランチはやり直しても消せないため。
    懸念：やり直しを望んでいた場合、残ったブランチは人が GitHub で消すまでリモートに残り、イベントと画面の作業が無駄になる。
- should
  - Q-2：新しいイベント `StepBranchesLeft` を足し、記録した後は前の版のデーモンへ戻せなくなることを許すか。
    推奨：許す（ADR 20261121-2215 の `StepBranchKept` と同じ扱い）。
    懸念：許さない場合、記録先を既存のイベントの欄に移す作り直しが要る。

確認しないと決めたこと

- `stale info` の扱い：取得し直し、先頭が違えば `StepBranchKept` を記録して残す。
  比べて違えば残すという既存の規則に合い、受け入れ条件 3 の「確かめずに消さない」も満たすため。
- 引数の `z.string()` を `TextParam` に変えるときの互換：`TextParam`（`DaemonText`）は文も受けるので、既存の台帳はそのまま読める。
  前の版は、引数の形が合わなければコードを出す決まり（`messages.ts` の冒頭）なので、人に確かめることは無い。

## 既定で決めたこと

- `stale info` の後に取得し直した先頭が最後の push と同じ（人が戻した）ときは、消し直さず unresolved にする（繰り返しを避ける）。
- 完了の記録は、消せなかったブランチの集合が前の `StepBranchesLeft` と同じなら重ねない（起動時の片付けで再び走るため）。
- ADR は新しく足し、ADR 20261121-2215 は置き換えない（規則を足すだけで、決定は変えないため）。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/messages.ts` | `cleanup.stepBranchPrepareFailed`・`cleanup.stepBranchFailed` の `detail` を `TextParam` にする。<br>日英の文言に `git.branchLeaseRejected`（`{branch}`）を足す |
| `apps/daemon/src/service.ts` `settleStepBranches`・`settleStepBranch` | 記録の無いときは `MessageError(cleanup.stepBranchUnrecorded)` を `unresolved` に渡す。<br>用意の失敗は `ready.message` をそのまま `detail` にする（`renderMessage(…, "ja")` を外す） |
| 同 中止の片付け | `cleanup.stepBranchFailed` の `detail` に `r.detail` をそのまま渡す |
| 同 `retireWorkspace` | `settleStepBranches` の unresolved が 1 件以上あれば、作業領域を消す前に `StepBranchesLeft` を記録する。<br>記録に失敗しても、完了の片付けは続ける |
| `apps/daemon/src/repository.ts` `deleteBranch` | 期待する先頭を渡した削除が `stale info` で断られたら、`MessageError(git.branchLeaseRejected)` を投げる |
| `apps/daemon/src/testing/daemon.ts` | `deleteLeaseCheck` の断りを `git.branchLeaseRejected` の `MessageError` にし、リモートに無いときも断る（実際の git と同じ） |
| `packages/core/src/events.ts`・`projection.ts` | `StepBranchesLeft`（`branches: {branch, detail: DaemonText}[]`）と、投影の `stepBranchesLeft` |
| `apps/web` の `task-detail.tsx`・`labels.ts`・i18n の辞書（日英） | 完了したタスクの詳細に、消せなかったブランチと理由（`labels.text`）を出す。<br>作業履歴の行の文言を足す |
| `docs/spec/approval(.en).md`「ブランチの削除」・「互換性」 | 完了で残したときの記録と、`stale info` の扱いを書く。<br>「警告だけにする」を「止めない。完了は `StepBranchesLeft` に記録する」に直す |
| `docs/user/tasks(.en).md`「実装の無い進め方の PR」 | 完了で消せなかったブランチは、タスクの詳細に理由とともに出るので、GitHub で消す、と書く |
| `docs/adr/`・`docs/worklog/` | ADR（完了の記録と `stale info` の扱い）と、PBI-480 の作業履歴を足す |

## 処理の流れ

- `settleStepBranch` の比べて消すときに `deleteBranch` が `git.branchLeaseRejected` を投げたら、`fetchBranch` で取得し直す（時間切れ 120 秒）。
  - リモートに無い：`deleted`
  - 最後の push と違う：`StepBranchKept` を記録して `kept`
  - 同じ・取得に失敗：unresolved（理由は `git.branchLeaseRejected` か取得のエラー）
- 無条件に消すとき（期待する先頭なし）は変えない。

## 影響範囲

- 片付けが成功するときの記録と削除の呼び出しは変えない。
  既存のテストで期待が変わるのは TV-15 だけで、断られた後に `StepBranchKept` が記録されるようになる。

## テスト観点

- [TV-1] 中止で記録の無いブランチの知らせが、画面の言語の文になる
  - 入力：直接の流れで、人がクローズした PR のブランチの stepBranchCommits が無い状態のタスクを中止する
  - 期待結果：TaskCancelled の cleanup の failed の detail を renderMessage で en にすると `Not deleting branch <ブランチ> because the commit sacty last pushed is not recorded.` を含み、`[object Object]` を含まない（ja でも同じく日本語の文になる）
- [TV-2] 用意に失敗した知らせに、英語の画面で日本語が混ざらない
  - 入力：作業領域はあるが git のメタデータが無く、prepareRepository が失敗する直接の流れのタスクを中止する
  - 期待結果：TaskCancelled の cleanup の failed の detail を renderMessage で en にした文に、日本語の文字（ひらがな・カタカナ・漢字）が無い
- [TV-3] 完了で消せなかったブランチを、理由とともに記録する
  - 入力：直接の流れのタスクが完了し、完了の片付けで残りのブランチの先頭の取得が通信の失敗で終わる
  - 期待結果：作業領域を消す前に StepBranchesLeft が、そのブランチと取得のエラーの detail を持って 1 件記録され、作業領域は消え、タスクは完了のまま一時停止も記録されない
- [TV-4] 完了で全部消せたときは、記録を足さない
  - 入力：直接の流れのタスクが完了し、完了の片付けで残りのブランチがすべて消せる
  - 期待結果：StepBranchesLeft は記録されず、削除の呼び出しと作業領域の削除は変更前のテスト（TV-16）と同じになる
- [TV-5] 同じ残りのブランチを、重ねて記録しない
  - 入力：完了の片付けで StepBranchesLeft を記録した後、作業領域の削除が残り、起動時の片付けで同じブランチがまた消せない
  - 期待結果：StepBranchesLeft は 1 件のまま増えない
- [TV-6] タスクの詳細に、消せなかったブランチと理由を画面の言語で出す
  - 入力：stepBranchesLeft にブランチと detail（コードと引数）がある完了したタスクを、en と ja の画面で開く
  - 期待結果：タスクの詳細に、ブランチの名前と、detail をその画面の言語にした理由が出る
- [TV-7] stale info で断られた後に、取得し直して先頭が違えば残して記録する
  - 入力：比べた後に人がブランチへ push し、期待する先頭を付けた削除が git.branchLeaseRejected で断られる
  - 期待結果：fetchBranch がもう一度呼ばれ、StepBranchKept（取得し直した head と pushed）が記録され、ブランチはリモートに残り、削除の呼び出しは 1 回だけ
- [TV-8] stale info で断られた後に、リモートに無ければ消せたものとする
  - 入力：比べた後にリモートのブランチが消え、期待する先頭を付けた削除が git.branchLeaseRejected で断られ、取得し直すと couldn't find remote ref で失敗する
  - 期待結果：結果は deleted で、StepBranchKept も StepBranchesLeft も記録されない
- [TV-9] stale info で断られた後に、先頭が最後の push と同じなら消し直さない
  - 入力：期待する先頭を付けた削除が git.branchLeaseRejected で断られ、取得し直した先頭が stepBranchCommits と同じ
  - 期待結果：削除はもう呼ばれず、結果は unresolved で detail は git.branchLeaseRejected、StepBranchKept は記録されない
- [TV-10] 実際の git で、リースの断りを見分ける
  - 入力：repository.test.ts で、期待する先頭を付けて、先頭が動いたブランチと、既に無いブランチを deleteBranch で消す
  - 期待結果：どちらも text のコードが git.branchLeaseRejected の MessageError を投げ、期待する先頭なしで既に無いブランチを消すときは変わらず成功する
- [TV-11] 仕様書に、完了の記録と stale info の扱いが書かれている
  - 入力：docs/spec/approval.md と approval.en.md の「ブランチの削除」と「互換性」
  - 期待結果：完了で消せなかったブランチを StepBranchesLeft に記録しタスクの詳細に出すこと、やり直さないこと、stale info で断られたら取得し直して 3 通りに扱うこと、前の版へ戻せないことが、日英で同じ意味で書かれている
- [TV-12] ユーザー文書に、完了で消せなかったブランチの見方と対処が書かれている
  - 入力：docs/user/tasks.md と tasks.en.md の「実装の無い進め方の PR」
  - 期待結果：完了で消せなかったブランチはタスクの詳細に理由とともに出ること、要らなければ GitHub で消すことが、日英で書かれている
