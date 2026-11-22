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
  - Q-1：完了で消せなかったブランチ（unresolved のすべて。通信の失敗・最後の push の記録が無い・リースの断りなど）は、やり直す仕組みを作らず、ブランチと理由を記録して画面に出すだけでよいか。
    推奨：はい。完了の片付けは作業領域を用意し直せず（`prepare: false`）、直後に作業領域と git のメタデータを消すので、後でやり直す元が残らない。git のメタデータを残してやり直す案は、残す期間と消す契機を新しく決める必要があり、記録の無いブランチはやり直しても消せない。
    起動時の片付けは、作業領域の削除が一部失敗して git のメタデータが残ったときだけ、結果的にもう一度走る（そのときの結果で記録を直す。処理の流れ）。
    懸念：やり直しを望んでいた場合、残ったブランチは人が GitHub で消すまでリモートに残り、イベントと画面の作業が無駄になる。
- should
  - Q-2：新しいイベント `StepBranchesLeft` を足し、記録した後は前の版のデーモンへ戻せなくなることを許すか。
    推奨：許す（ADR 20261121-2215 の `StepBranchKept` と同じ扱い）。
    実害：前の版は `StepBranchesLeft` を `EventInput` の検査で読めず、起動しない。書く契機は、完了の片付けと起動時の片付けで、直接の流れのタスクのブランチが消せなかったとき（`StepBranchKept` より狭い）。
    `TextParam` にした引数は、前の版では形が合わずコードだけが出る（起動は止まらない）。
    懸念：許さない場合、記録先を既存のイベントの欄に移す作り直しが要る。
  - Q-3：`stale info` の後に取得し直した先頭が最後の push と同じ（人が戻した・誤検知）ときに、消し直さず unresolved にしてよいか。
    推奨：消し直さない。削除と断りの繰り返しを避け、受け入れ条件 3 の「確かめずに消さない」を一番狭く満たすため。
    懸念：そのブランチはリモートに残り、中止では cleanup の失敗、完了では `StepBranchesLeft` として出るので、人が GitHub で消す手間が増える。

確認しないと決めたこと

- `stale info` の扱い：取得し直し、先頭が違えば `StepBranchKept` を記録して残す（同じときは Q-3）。
  比べて違えば残すという既存の規則に合い、受け入れ条件 3 の「確かめずに消さない」も満たすため。
- 引数の `z.string()` を `TextParam` に変えるときの互換：`TextParam`（`DaemonText`）は文も受けるので、既存の台帳はそのまま読める。
  前の版は、引数の形が合わなければコードを出す決まり（`messages.ts` の冒頭）なので、人に確かめることは無い。

## 既定で決めたこと

- 完了の記録は、今回の unresolved（ブランチと detail）が投影の `stepBranchesLeft` と同じなら足さない（起動時の片付けで再び走るため）。
- `cleanup.stepBranchNoGitDir` で終わった片付けは、判定できなかったものとして記録に使わない（前の記録を残す）。
- 投影は、最新の `StepBranchesLeft` で置き換え、空の `branches` なら欄を消す。`stepBranches` に無いブランチは整合性のエラーにする（`StepBranchKept` と同じ）。
- ADR は新しく足し、ADR 20261121-2215 は置き換えない（規則を足すだけで、決定は変えないため）。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/messages.ts` | `cleanup.stepBranchPrepareFailed`・`cleanup.stepBranchFailed` の `detail` を `TextParam` にする。<br>日英の文言に `git.branchLeaseRejected`（`{branch}`）を足す |
| `apps/daemon/src/service.ts` `settleStepBranches`・`settleStepBranch` | 記録の無いときは `MessageError(cleanup.stepBranchUnrecorded)` を `unresolved` に渡す。<br>用意の失敗は `ready.message` をそのまま `detail` にする（`renderMessage(…, "ja")` を外す） |
| 同 中止の片付け | `cleanup.stepBranchFailed` の `detail` に `r.detail` をそのまま渡す |
| 同 `retireWorkspace` | 作業領域を消す前に、処理の流れの「完了の記録」に従って `StepBranchesLeft` を記録する。<br>記録に失敗しても、完了の片付けは続ける |
| `apps/daemon/src/repository.ts` `deleteBranch` | 期待する先頭を渡した削除が `stale info` で断られたら、`MessageError(git.branchLeaseRejected)` を投げる |
| `apps/daemon/src/testing/daemon.ts` | `deleteLeaseCheck` の断りを `git.branchLeaseRejected` の `MessageError` にし、リモートに無いときも断る（実際の git と同じ） |
| `packages/core/src/events.ts`・`projection.ts` | `StepBranchesLeft`（`branches: {branch, detail: DaemonText}[]`。空を許す）と、投影の `stepBranchesLeft`（既定で決めたことの置き換え・検査） |
| `apps/web` の `task-detail.tsx`・`labels.ts`・i18n の辞書（日英） | 完了したタスクの詳細に、消せなかったブランチと理由（`labels.text`）を出す。<br>作業履歴の行の文言を足す |
| `docs/spec/approval(.en).md`「ブランチの削除」・「互換性」 | 完了で残したときの記録と、`stale info` の扱いを書く。<br>「警告だけにする」を「止めない。完了は `StepBranchesLeft` に記録する」に直す。<br>「互換性」に Q-2 の実害と書く契機を足し、「コード:」に `retireWorkspace`・`StepBranchesLeft` を足す |
| `docs/spec/event-log(.en).md` | 種類の数を 143 にし、git・PR の列挙に `StepBranchesLeft` を足す。前の版が読めないことを書く |
| `docs/spec/tasks-and-steps(.en).md`「終わったタスクの作業領域の片付け」 | 消せなかったブランチを `StepBranchesLeft` に記録し、起動時の片付けで結果が変われば記録し直すことを書く |
| `docs/user/tasks(.en).md`「実装の無い進め方の PR」 | 完了で消せなかったブランチは、タスクの詳細に理由とともに出るので、GitHub で消す、と書く |
| `docs/adr/`・`docs/worklog/` | ADR（完了の記録と `stale info` の扱い）と、PBI-480 の作業履歴を足す |

## 処理の流れ

- `settleStepBranch` の比べて消すときに `deleteBranch` が `git.branchLeaseRejected` を投げたら、`fetchBranch` で取得し直す（時間切れ 120 秒）。
  - リモートに無い：`deleted`
  - 最後の push と違う：`StepBranchKept` を記録して `kept`
  - 同じ・取得に失敗：unresolved（理由は `git.branchLeaseRejected` か取得のエラー）
- 無条件に消すとき（期待する先頭なし）は変えない。
- 完了の記録（`retireWorkspace`）：
  - 片付けが `cleanup.stepBranchNoGitDir` で終わった：記録しない。
  - 今回の unresolved が `stepBranchesLeft` と同じ：記録しない（どちらも無いときを含む）。
  - それ以外：今回の unresolved の全件で `StepBranchesLeft` を記録する（消せて減った・空になったときも記録し、表示を直す）。

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
- [TV-5] 同じ結果の再実行では、重ねて記録しない
  - 入力：完了の片付けで StepBranchesLeft を記録した後、作業領域の削除が失敗して git のメタデータが残り、起動時の片付けで同じブランチが同じ detail でまた消せない
  - 期待結果：StepBranchesLeft は 1 件のまま増えない
- [TV-6] 再実行で結果が変われば、最新の記録で置き換える
  - 入力：完了の片付けで 2 本のブランチを StepBranchesLeft に記録した後、git のメタデータが残り、起動時の片付けで 1 本は取得が couldn't find remote ref で消せたものになり、もう 1 本は別の理由で消せない
  - 期待結果：2 件目の StepBranchesLeft が残りの 1 本と新しい detail だけを持って記録され、投影の stepBranchesLeft はその 1 本だけになる
- [TV-7] 再実行で全部消せたら、記録を空にして表示を消す
  - 入力：StepBranchesLeft を記録した後、起動時の片付けで残りのブランチがすべて消せる
  - 期待結果：branches が空の StepBranchesLeft が記録され、投影の stepBranchesLeft は無くなり、タスクの詳細に消せなかったブランチが出ない
- [TV-8] git のメタデータが無い再実行の結果は、記録に使わない
  - 入力：StepBranchesLeft を記録した後、git のメタデータだけが消えて作業領域が残り、起動時の片付けの settleStepBranches が cleanup.stepBranchNoGitDir で終わる
  - 期待結果：StepBranchesLeft は新しく記録されず、投影の stepBranchesLeft は前の記録のまま
- [TV-9] 工程のブランチに無いブランチの記録を、投影が拒む
  - 入力：stepBranches に無いブランチを branches に持つ StepBranchesLeft を投影する
  - 期待結果：ActivityIntegrityError になる
- [TV-10] タスクの詳細に、消せなかったブランチと理由を画面の言語で出す
  - 入力：stepBranchesLeft にブランチと detail（コードと引数）がある完了したタスクを、en と ja の画面で開く
  - 期待結果：タスクの詳細に、ブランチの名前と、detail をその画面の言語にした理由が出る
- [TV-11] stale info で断られた後に、取得し直して先頭が違えば残して記録する
  - 入力：比べた後に人がブランチへ push し、期待する先頭を付けた削除が git.branchLeaseRejected で断られる
  - 期待結果：fetchBranch がもう一度呼ばれ、StepBranchKept（取得し直した head と pushed）が記録され、ブランチはリモートに残り、削除の呼び出しは 1 回だけ
- [TV-12] stale info で断られた後に、リモートに無ければ消せたものとする
  - 入力：比べた後にリモートのブランチが消え、期待する先頭を付けた削除が git.branchLeaseRejected で断られ、取得し直すと couldn't find remote ref で失敗する
  - 期待結果：結果は deleted で、StepBranchKept も StepBranchesLeft も記録されない
- [TV-13] stale info で断られた後に、先頭が最後の push と同じなら消し直さない
  - 入力：期待する先頭を付けた削除が git.branchLeaseRejected で断られ、取得し直した先頭が stepBranchCommits と同じ
  - 期待結果：削除はもう呼ばれず、結果は unresolved で detail は git.branchLeaseRejected、StepBranchKept は記録されない
- [TV-14] 実際の git で、リースの断りを見分ける
  - 入力：repository.test.ts で、期待する先頭を付けて、先頭が動いたブランチと、既に無いブランチを deleteBranch で消す
  - 期待結果：どちらも text のコードが git.branchLeaseRejected の MessageError を投げ、期待する先頭なしで既に無いブランチを消すときは変わらず成功する
- [TV-15] 承認の仕様書に、完了の記録と stale info の扱いと互換性が書かれている
  - 入力：docs/spec/approval.md と approval.en.md の「ブランチの削除」「互換性」と、その節の「コード:」
  - 期待結果：完了で消せなかったブランチを StepBranchesLeft に記録しタスクの詳細に出すこと、やり直さないこと、stale info で断られたら取得し直して 3 通りに扱うこと、前の版は StepBranchesLeft を読めず起動しないことと書く契機、コードの参照の retireWorkspace と StepBranchesLeft が、日英で同じ意味で書かれている
- [TV-16] 作業履歴と作業領域の片付けの仕様書が、新しい記録と合っている
  - 入力：docs/spec/event-log.md・event-log.en.md と、docs/spec/tasks-and-steps.md・tasks-and-steps.en.md の「終わったタスクの作業領域の片付け」
  - 期待結果：event-log は種類の数が 143 で git・PR の列挙に StepBranchesLeft があり、tasks-and-steps は消せなかったブランチを StepBranchesLeft に記録し、起動時の片付けで結果が変われば記録し直し、git のメタデータが無いときは記録しないことが、日英で書かれている
- [TV-17] ユーザー文書に、完了で消せなかったブランチの見方と対処が書かれている
  - 入力：docs/user/tasks.md と tasks.en.md の「実装の無い進め方の PR」
  - 期待結果：完了で消せなかったブランチはタスクの詳細に理由とともに出ること、要らなければ GitHub で消すことが、日英で書かれている
