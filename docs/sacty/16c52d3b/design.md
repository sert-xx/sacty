<!-- sacty task 16c52d3b-ecc1-40bc-ab0f-485304d499e9 の設計。sacty が作成しました。 -->

# 設計：人がドラフトを外した PR を、sacty がドラフトへ戻さない

## スコープ

sacty は、PR をドラフトへ戻す前に、GitHub の最後のドラフトの切り替えを読む。
その切り替えが、sacty が台帳に記録した「外し」のイベント ID と合わなければ、PR を戻さずに作業履歴に残す。

- 対象
  - 戻す経路の前に置く判定（直しの提出、`settleDraft`、`redraftAwaiting`、`markReady` と `undraftMarkedReady` の外す間の変化、`redraftAfterRetarget`）
  - sacty の外しのイベント ID の記録と、戻さなかった記録（イベント2種類と、その表示）
  - GitHub の切り替えの履歴の読み取り（`github.ts`）と、フェイクの GitHub
  - 仕様書・ユーザー文書（日英）・ADR・作業履歴・テスト
- 対象外
  - 一時停止に伴う戻し（`settlePausedDraft`。判定を通さない）
  - 人がドラフトにした PR を外し直す振る舞い（`undraftMarkedReady` の外し直し）

## 確認したいこと

### must

なし

### should

なし

## 既定で決めたこと

- sacty の外しは、`markPullRequestReadyForReview` の答えで、その PR の最後の `ReadyForReviewEvent` の ID を受け取って記録する（actor は人と同じアカウントになるので使わない）。
- 答えの ID が、要求の前に読んだ最後の外しの ID か、その PR に記録済みの ID と同じなら、1回だけ読み直す。それでも同じなら ID なしとして記録する（タイムラインへの反映の遅れで、前の外しの ID を受け取るため）。
- 前の版が外した PR（sacty の外しの記録が無く、`PullRequestMarkedReady` か `PullRequestRetargeted` の `ready` がある）の、記録の無い外しは「決められない」とする。
- sacty がドラフトにした切り替えは記録しない。判定に要るのは、最後の外しが誰のものかだけのため。
- sacty の外しの記録も、作業履歴に1行出す（表示の `switch` が全種類を扱うため）。

## 構成

| 場所 | 変更 |
| --- | --- |
| `apps/daemon/src/github.ts` | `draftHistory` を足す（GraphQL の `isDraft` と、`timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT])` の id・種類・時刻）。`setDraft` の外しで、要求の前に最後の `ReadyForReviewEvent` の ID を読み、答えに最後の `ReadyForReviewEvent` の ID を足す |
| `apps/daemon/src/service.ts` | 判定を足し、スコープの戻す経路から呼ぶ。外しの4か所（`markReady`・`undraftMarkedReady`・付け替え・検証の後の外し）で記録する |
| `packages/core`（`events.ts`・`projection.ts`） | イベント2種類と、PR ごとの投影 |
| `apps/web`（`labels.ts`・`i18n/messages/labels.ts`） | 表示の文言（日英） |
| `apps/daemon/src/testing/daemon.ts` | 切り替えの履歴（`setDraft` が ID を振って積む、人の外しを足す、読み取りの失敗、外しの答えに前の外しの ID を返す） |

## データ

- `PullRequestUndraftNoted { number, eventId? }`：sacty が外した。`eventId` が無いのは、答えを受け取れなかった・答えに ID が無かった・読み直しても前の外しと同じ ID だったとき
- `PullRequestRedraftSkipped { number, reason: "person" | "unreadable" | "undetermined", eventId? }`：戻さなかった。`person` は外しの `eventId` を持つ
- 投影：PR ごとに、sacty の外しの ID・最後の `PullRequestUndraftNoted` に ID があるか・前の版の外しの記録があるか・最後の `PullRequestRedraftSkipped`

## 処理の流れ（外しの ID の記録）

1. `markPullRequestReadyForReview` の前に、最後の `ReadyForReviewEvent` の ID を読む（読めなければ「前の ID」を空とする）
2. 答えの ID が、前の ID とも記録済みの ID とも違えば、その ID を記録する
3. 同じなら、`draftHistory` で1回読み直し、違う外しの ID になっていれば記録する。同じか読めなければ、ID なしで記録する

- 答えを受け取れなかった（時間切れ・失敗）後の記録の無い外しも、ID なしの記録として、判定で「決められない」とする

## 処理の流れ（判定）

戻す経路が、PR をドラフトへ戻そうとするときに呼ぶ。

1. `draftHistory` を読む。失敗・時間切れなら `unreadable` で戻さない（次の確認で読み直す）
2. ドラフトなら、今の処理のまま進む（記録しない）
3. 切り替えが1件も無い、または最後の外しの ID が sacty の記録にある → 今と同じく戻す
4. 最後の外しが記録に無く、最後の `PullRequestUndraftNoted` に ID が無いか、前の版の外しの記録だけがある。または、最後が `convert_to_draft` なのにドラフトでない → `undetermined` で戻さない
5. それ以外で最後の外しが記録に無い → `person` で戻さない

- 重ねた PR の直しの提出は、判定で戻さないときは `pr.stackDraftFailed` にせずに進める。戻そうとして戻せないときは、今と同じく止める。
- 記録の重複は、台帳から決める。
  - `person`：同じ `eventId` が記録済みなら記録しない
  - `unreadable`：その PR の最後の記録が `unreadable` で、この起動の後に読めたことが無ければ記録しない
  - `undetermined`：その PR に記録済みなら記録しない

## 影響範囲

- 新しいイベントを記録した後は、前の版のデーモンが作業履歴を読めず、起動できない（`activity.ts` の `toEvent` が全行を parse する）。互換の層は作らず、仕様と ADR に書く。
- 文書
  - 仕様：`tasks-and-steps`・`approval`・`event-log`（種類の数は実装の時点で数え直す。今は137）・`split-and-integrate` の日英
  - ユーザー文書：`docs/user/tasks.md` の1326・1335・1577行付近と `.en.md`。1339行の一時停止の案内は変えない
  - ADR 1件、作業履歴 `docs/worklog/<UTC日付>-pbi-468-<slug>.md`
- テスト：`daemon-step-pull-requests.test.ts`（3372・3478・3757行）と `daemon-split.test.ts`（1471行）を新しい決まりに合わせる。5624行（一時停止）は変えない。

## テスト観点

- [TV-1] PR の確認で、人が外した PR をドラフトへ戻さず、外し1回につき1件記録する
  - 入力：指摘なしを待つ（重ねていない）PR を、フェイクの GitHub で人が外し（sacty の記録に無い外しのイベント）、PR の確認を3回行う
  - 期待結果：PR はドラフトでないままで、作業履歴に reason が person でその外しの eventId を持つ PullRequestRedraftSkipped が1件だけある
- [TV-2] 再起動の後も、人が外した PR を戻さず、記録を重ねない
  - 入力：前の観点の後にデーモンを作り直し（同じ台帳）、起動の後の redraftAwaiting と PR の確認を走らせる
  - 期待結果：PR はドラフトでないままで、PullRequestRedraftSkipped は1件のまま
- [TV-3] 人が外した PR に直しを提出しても、ドラフトへ戻さない
  - 入力：人が外した、指摘なしを待つ PR に、PR の指摘で直した実装を提出する（先頭が変わる）
  - 期待結果：PR は更新されてドラフトでないままで、setDraft で draft: true が呼ばれず、タスクは承認待ちに進む
- [TV-4] 人が外した後に人がコミットを足しても、ドラフトへ戻さない
  - 入力：sacty の指摘なしで外した後に人が外し直した PR（最後の外しが人）で、人がコミットを足して先頭が変わり、PR の確認を行う
  - 期待結果：PR はドラフトでないままで、PullRequestRedraftSkipped（person）が1件記録される
- [TV-5] 指摘なしで外す間の変化で、人が外していた PR を戻さない
  - 入力：人が外した PR（sacty の外す要求は変化なしで答える）で、指摘なしの外しの途中に差し戻しを起こす
  - 期待結果：setDraft で draft: true が呼ばれず、PullRequestRedraftSkipped（person）が1件記録される
- [TV-6] 重ねた PR の付け替えの途中の変化で、人が外していた PR を戻さない
  - 入力：人が外した重ねた PR の依存先をマージし、付け替えで外す答えを待つ間（setDraftGate）にタスクを変える
  - 期待結果：redraftAfterRetarget でドラフトへ戻さず、PullRequestRedraftSkipped（person）が1件記録される
- [TV-7] 人が外した重ねた PR に直しを提出しても、止めずに進める
  - 入力：人が外した重ねた PR に、やり直しの実装を提出する
  - 期待結果：PR はドラフトでないままで、pr.stackDraftFailed で止まらずに承認待ちに進み、PullRequestRedraftSkipped（person）が1件記録される
- [TV-8] 履歴を読めない重ねた PR に直しを提出しても、止めずに進める
  - 入力：draftHistory が失敗するフェイクで、ドラフトでない重ねた PR にやり直しの実装を提出する
  - 期待結果：PR はドラフトでないままで、pr.stackDraftFailed で止まらずに承認待ちに進み、PullRequestRedraftSkipped（unreadable）が1件記録される
- [TV-9] sacty が外した PR は、今と同じくドラフトへ戻す（再起動の後も）
  - 入力：sacty が指摘なしで外した（ID が記録された）PR に人がコミットを足し、デーモンを作り直してから PR の確認を行う
  - 期待結果：PR はドラフトに戻り、PullRequestRedraftSkipped は記録されない
- [TV-10] 人が切り替えていない PR は、今と同じくドラフトへ戻す
  - 入力：切り替えのイベントが1件も無く、ドラフトでない指摘なしを待つ PR で、PR の確認を行う
  - 期待結果：PR はドラフトに戻り、PullRequestRedraftSkipped は記録されない
- [TV-11] 元からドラフトの PR では、戻さなかった記録を残さない
  - 入力：人が外した後に人がドラフトにした（最後が convert_to_draft でドラフト）PR で、PR の確認と redraftAwaiting を走らせる
  - 期待結果：PullRequestRedraftSkipped は記録されない
- [TV-12] 一時停止中は、人が外した PR も今と同じ条件で戻す
  - 入力：人が外した PR のタスクを、理由が手動・unchanged・needs_decision の3通りで一時停止し、PR の確認を行う
  - 期待結果：手動の一時停止では PR がドラフトに戻り、unchanged・needs_decision では戻らない
- [TV-13] 履歴を読めない間は戻さず、1件だけ記録する（再起動の後も）
  - 入力：draftHistory が失敗するフェイクで、ドラフトでない指摘なしを待つ PR の確認を2回行い、デーモンを作り直してもう1回行う
  - 期待結果：PR はドラフトでないままで、PullRequestRedraftSkipped（unreadable）が1件だけある
- [TV-14] 読めない間に人が外した PR は、読めた後に person を1件足す
  - 入力：前の観点の後に、人の外しのイベントを返すように読み取りを直して、PR の確認を2回行う
  - 期待結果：PullRequestRedraftSkipped は unreadable 1件と、その外しの eventId を持つ person 1件で、PR はドラフトでないまま
- [TV-15] 前の版が外した PR は、決められないとして戻さず、1件だけ記録する
  - 入力：台帳に PullRequestMarkedReady があり PullRequestUndraftNoted が無い PR で、記録の無い外しを最後にし、人がコミットを足して PR の確認を2回とデーモンの作り直しの後に1回行う
  - 期待結果：PR はドラフトでないままで、PullRequestRedraftSkipped（undetermined）が1件だけある
- [TV-16] 外す要求の答えを受け取れなかった後の外しは、決められないとして戻さない
  - 入力：setDraftAnswerLost で、指摘なしの外しの答えを失わせた後に差し戻しを起こし、PR の確認を行う
  - 期待結果：ID なしの PullRequestUndraftNoted が記録され、PR はドラフトでないままで、PullRequestRedraftSkipped（undetermined）が1件記録される
- [TV-17] 外しの答えが前の外しの ID なら、sacty の外しの ID として記録しない
  - 入力：人が外して戻した後の PR を sacty が指摘なしで外し、フェイクの外しの答えと1回の読み直しがどちらも人の前の外しの ID を返し（タイムラインの反映の遅れ）、その後に sacty の外しのイベントが最後になってから差し戻しを起こして PR の確認を行う
  - 期待結果：PullRequestUndraftNoted は ID なしで記録され、前の外しの ID は sacty の外しとして記録されず、PullRequestRedraftSkipped は person ではなく undetermined が1件記録される
- [TV-18] GitHub の切り替えの履歴と外しの答えの ID を読む
  - 入力：GitHubPullRequests に、timelineItems の最後が ReadyForReviewEvent・ConvertToDraftEvent・空・エラーの答えと、外しの要求の前の読み取りと markPullRequestReadyForReview の答えに ReadyForReviewEvent の id がある・無い答えを返す fetch を渡す
  - 期待結果：draftHistory は isDraft と最後の切り替えの id・種類を返し、エラーでは例外を投げ、setDraft の外しは要求の前の最後の外しの id と答えの id があれば返し、無ければ返さない
- [TV-19] 新しい記録を作業履歴に表示する
  - 入力：PullRequestUndraftNoted と、reason が person・unreadable・undetermined の PullRequestRedraftSkipped を、日本語と英語で表示する
  - 期待結果：それぞれ PR の番号と、sacty が外したこと・戻さなかった理由（人が外した・読めなかった・決められなかった）の文言が出る
- [TV-20] 仕様書に新しい決まりを載せる
  - 入力：docs/spec の tasks-and-steps・approval・event-log・split-and-integrate の日英の差分
  - 期待結果：人が外した PR を一時停止のほかは戻さないこと、判定と3つの理由、重ねた PR の提出を止めないこと、2つのイベントと数え直した種類の数、記録の後は前の版へ切り戻せないこと（互換の層は作らない）が書かれている
- [TV-21] ユーザー文書に今の振る舞いを載せる
  - 入力：docs/user/tasks.md と .en.md の差分
  - 期待結果：「指摘なし」の前に人が外した PR と、直しの提出・重ねた PR の付け替えでも sacty がドラフトへ戻さないことが、です・ます調の今の振る舞いとして書かれ、一時停止の案内は残っている
- [TV-22] ADR と作業履歴を足す
  - 入力：docs/adr と docs/worklog の差分
  - 期待結果：ADR に人が外した PR を戻さない方針と、新しい記録の後は前の版へ切り戻せないこと（互換の層は作らない）が書かれ、作業履歴が docs/worklog/<UTC日付>-pbi-468-<slug>.md にひな形どおりにあり、tests/docs が通る
