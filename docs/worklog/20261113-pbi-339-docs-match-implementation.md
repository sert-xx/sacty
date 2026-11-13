# 仕様書・ユーザードキュメント・図と、残っていた古いコードの文言を、今の実装に合わせる

- 日付: 2026-11-13（UTC）
- タスク: PBI-339
- PR: #362
- ブランチ: feat/issue-339-docs-match-implementation
- 関係する ADR: なし

## 目的

main（1.24.1）の docs と実装を突き合わせたところ、ゴールガーディアンの撤去・最終レビューの廃止・PR のレビューの子タスク（PBI-330〜336）の
後の直し漏れを中心に、約 25 件のズレがあった。振る舞いは変えずに、仕様書・ユーザードキュメント・図を実装に合わせる。
コードの側に残っていた、撤去の前の前提の雛形・画面の文言・コメントも直す。

## したこと

- 仕様書（日英）
  - tasks-and-steps：予算で止まる所から「検証の前」を外した。`resume.stepSettingsRechoose` の記述を消した（検査はもう無い）。
    実装の指示の見出しと文、検証の指示の文言を今のコードに合わせた。PR の作成の前の人のコミットの取り込みを足した。
    レビューの子タスクにはテストのコマンドの候補が渡らないことを足した。
  - event-log：種類を 117 にし、内訳を足した。状態を変えないイベントに `PullRequestBodyResolved` を足した。
  - architecture：`/api/tasks/:id/image`（と `title`）、画面の取り直しの `/live/context-images`、見逃しの記録の条件（統合レビューの合格）。
  - approval：PR の確認の手順、再レビューで比べる先頭、戻し先の判断が工程のエージェントに回る条件、`change_undecidable` の今の経路。
  - gateway（401・実行の範囲の 403 を含む判定の順）、daemon-lifecycle（起動と終了の手順）、error-report（`BaseConflictsRemained`）、
    notifications（変更の申し出の本文）、deployment-watch（画面の状態の名前）、context（書式）、agent-execution（roles の例）。
- ユーザードキュメント（日英）
  - tasks：指摘なしを待つ PR は人がドラフトを外しても戻すこと、プロパティの一覧、「関連するタスク」の表記、「合格の見逃し」。
  - gateway（メソッドを上書きするクエリの 400）、secrets（`gateway.platforms` から取り出すもの）、dashboard（「合格の見逃し」）。
- 図：tasksFlow・budgetFlow・tasksUser・gateway-pf を直し、`npm run docs:diagrams` で作り直した。
- コード
  - `config init` の雛形の run_timeout の役割の例から `guardian`・`final-review` を外した。
  - 画面の状態：`verification` が残る idle（PR を作る前の確かめ、以前の版の最終レビューの途中）を「PR の提出・更新の前の確認中」にまとめた
    （以前は「テストを実行中」「最終レビュー中」で、今の版の状態に合っていなかった）。
  - ダッシュボードと作業履歴の `GuardianMissed` の表示を「合格の見逃し」にした（統合レビューの見逃しも数えるため）。
  - 画面の文の小文字の「sacty」を「Sacty」にした（識別子は除く）。
  - 古い前提のコメントと、セキュリティ対応の前段の指示の「不合格にする」を今の動きに合わせた。

## 確かめたこと

- 状態の分岐の順を変えたので、`verification` が PR の作成（`passVerification`）で消えることを projection で確かめた。
  マージの後の監視の表示とは重ならない。
- `change_undecidable` を記録するのは `resumeSettlement` の経路だけ（`decideChange` は真偽を必ず渡す）ことを確かめた。
- `npm run lint`：指摘なし。`npm run typecheck`：通過。
- `npx vitest run`：1回目は `question-form.browser.test.ts` の2件が落ちた（このブランチで触っていない部品。単体で流すと通る）。
  2回目は `tests/desktop/migration.test.ts` の1件が落ちた（同じく単体で流すと 22 件すべて通る）。落ちるテストが回ごとに違い、
  どれもこのブランチの変更と関係しない部品なので、全体を流したときの負荷による不安定さと判断した。
- スクリーンショット：変えた文言は既存の PNG に写っていないので、撮り直していない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA のセルフレビュー）画面の文言を「合格の見逃し」に変えたのに、ユーザードキュメント・仕様書に古い名前が残っていた | dashboard・tasks・architecture（日英）を直した |
| （sacty のレビュー）user/tasks：親のテストのコマンドが PR のレビューの子タスクに渡ると書いている | 渡らず、子タスクはリポジトリの手順や CI の設定から決めると直した（日英） |
| （sacty のレビュー）daemon-lifecycle：設定の誤りで止まるのは、消す古いタスクがあるときだけ | 条件を足した（日英。`purgeLegacyTasksAtStartup` で確かめた） |
| （sacty のレビュー）ダッシュボードの見逃しの補足の「人が差し戻した」は狭い | AI のレビューの指摘による差し戻しでも記録する（`requestChanges` の `aiReview`）ので、両方を数えると直した（日英） |
| （sacty のレビュー）approval：指摘なしの後でも、PR の先頭が変われば再レビューする | 判定そのものでは再レビューせず、先頭が変われば始めると書いた（日英） |
| （sacty のレビュー）service.ts の戻し先の判断のコメントが、子タスクの答えを使う条件を省いている | `reviewTaskRework` の条件（最後の回の投稿だけ・指摘ありの判定）と、それ以外は工程のエージェントと、3 か所に書いた |
| （sacty の再レビュー）戻し先の判断：回の記録はあるが判定を読めなかったときは、子タスクの答えの経路に進む | `reviewTaskRework` と `reviewVerdicts` の投影で確かめ、「判定の記録が無い」ときと「判定や戻し先を読めなかった」とき（その PR の工程をやり直す答え）を分けて、service.ts のコメント 3 か所と approval（日英）に書いた |
| （sacty の再レビュー 3 回目）「統合レビュー（以前の版では最終レビュー）」は、最終レビューが統合レビューの以前の名前だと読める | 別のレビューとして並べる書き方にした（ダッシュボードの補足の日英、user/tasks の日英） |
| （sacty の再レビュー 4 回目）approval.en：変更なしの判定を「検証済みの実装」の PR の作成と書いている | 日本語版に合わせて `verified` を外した |
| （sacty の再レビュー 4 回目）画面の状態「PR の作成の前の確認中」は、既存の PR を更新するときにも出る | 「PR の提出・更新の前の確認中」（英語は「Checking before submitting or updating the PR」）にした |
| （sacty の再レビュー 4 回目）ドラフトを外した後に人がコミットを足すと、今の先頭が指摘なしになるまでドラフトを保つ | `wantsDraft` で確かめ、user/tasks と approval の PR の確認の手順（日英）に書いた |

- 対応の後：`npm run lint`・`npm run typecheck` は通過。`npx vitest run tests/docs apps/web/src` は、ブラウザのテストが回によって 0〜3 件落ちた
  （`question-form`・`menus`。この PR で触っていない部品で、同じブランチでも全部通る回がある）。

## 残したこと

- service.ts・events.ts に、以前の版のデータの型を説明するゴールガーディアンの記述が残っている（以前の版の作業履歴を読むためのもの）。
- PR の欄の「最終レビューの見逃し n件」は、実装の PR では以前の版の最終レビューでしか記録されないので、名前を変えていない。
