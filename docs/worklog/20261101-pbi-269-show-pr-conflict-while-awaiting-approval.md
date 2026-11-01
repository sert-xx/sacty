# 承認待ちの間に実装の PR がベースブランチと競合したら、画面に出す

- 日付: 2026-11-01（UTC）
- タスク: PBI-269
- PR: なし
- ブランチ: feat/issue-269-conflict-indicator
- 関係する ADR: [承認待ちの間に実装の PR がベースブランチと競合したら、画面に出すだけにして、自動では取り込まない](../adr/20261101-1400-show-pull-request-conflict-while-awaiting-approval.md)

## 目的

実務での実証実験（S13）で、承認待ちの間に先の PR がマージされて実装の PR が競合しても、タスクの画面には何も出なかった。
人が GitHub で気づき、PR に「解消して」と書く必要があった。
人が決めた方針は「画面に出すだけ」で、自動では取り込まない。

受け入れ条件の要点：

- 承認待ちの PR が GitHub の `mergeable` で競合を示したら、タスクの画面と「あなたの出番」に、競合していることと取り込む操作（差し戻す・指摘を書く）を出す。
- 競合が解消されたら消す。
- 自動で取り込まない。費用のかかる処理を走らせない。
- UI の変更なので、動作確認の動画を付ける。仕様書・ユーザードキュメント（日英）・作業履歴を直し、テストで確かめる。

## したこと

- `GitHubPullRequests.status`（`apps/daemon/src/github.ts`）：開いている PR の答えに、GitHub の `mergeable` を `true`・`false` のときだけ含める。既存の PR の状態の確認が読む 1 回の問い合わせに含まれるので、問い合わせは増えない。
- `checkPullRequests`（`apps/daemon/src/service.ts`）：開いたままの承認待ちの実装の PR について、競合が変わったときだけ `PullRequestConflicted`・`PullRequestConflictResolved` を記録する（`recordPullRequestConflict`）。`mergeable` が分からないときは前のまま。実行も取り込みも始めない。要求要件・設計の PR とエスカレーション中は記録しない。
- 状態の復元（`packages/core/src/projection.ts`）：`Task.pullRequestConflict` と、画面に出すかを決める `pullRequestConflict`。PR の更新・マージ・クローズ・開き直しで記録を消し、ゴールガーディアンが PR の指摘を判断している間は出さない。
- 画面（`apps/web`）：状態の表示に競合と取り込む操作を出し（「あなたの出番」・ヘッダーのお知らせ・一覧は状態の表示を共有）、タスクの詳細の案内と承認の画面の PR の欄に説明を出す。作業履歴の文言を足した。
- 仕様書（`docs/spec/approval.md`・`tasks-and-steps.md` と `.en.md`）、ユーザードキュメント（`docs/user/tasks.md`・`dashboard.md` と `.en.md`）、ADR を足した。

## 確かめたこと

- テスト（関係する範囲）：
  - `npx vitest run apps/daemon/src/daemon.test.ts apps/daemon/src/github.test.ts packages/core apps/web tests/docs` の範囲を通した。
  - 競合の記録（一度だけ・解消・計算中は前のまま・状態を読めない・閉じて開き直し・マージ・差し戻して PR を更新・要求要件の PR は記録しない）と、競合しても実行・取り込みが始まらないこと（`daemon.test.ts`）。
  - `mergeable` の読み分けと、問い合わせが 1 回のままであること（`github.test.ts`）。
  - 状態の復元と、作業履歴の誤り（PR が無い・別の番号・閉じた PR）の拒否（`projection.test.ts`）。
  - 表示：状態の文言（日英・n 回目）、あなたの出番の行の案内、タスクの詳細・承認の画面（`labels.test.ts`・`review-pull-request.test.ts`・`dashboard.test.ts`・`live-screens.test.ts`・`gate-form-submit.test.ts`）。
- 修正を戻すと落ちること：PR の更新で競合の記録を消さない・`mergeable` が分からないときを競合なしとして扱う、のそれぞれで、対応するテストが落ちた。
- `npx biome check .`・`npm run typecheck` が通った。`npx vitest run tests/docs` が通った。
- `npx vitest run`（全体を 1 回）：3233 件中 7 件が落ちた。
  - 画面の文言の規則（`wording-policy.test.ts`）の 4 件は、足した案内が長かったため。文言を短くし、補足（Hint）に分けて直した。直した後に通った。
  - 並行実行のテスト（`daemon.test.ts`「実行待ちのタスクを、古い順に」）の 1 件は、負荷（ロードアベレージ 40 前後）による時間の判定の失敗。単独で再実行すると通った。
  - `install-security-tools.test.ts` の 2 件は、環境による既知の失敗（`/usr/local/bin` に書き込めない）。この PR と関係しない。
  - Playwright 未導入によるブラウザーのテスト（`question-form.browser.test.ts`）は、この環境では動かせていない（`tests/docs`・画面のテストへの影響は無い）。
- 動作確認（動画）：一時の `SACTY_HOME`（リポジトリの外）で `sacty up` を起動し（ポートは 4851・4852。4700・4800・4810 は使っていない）、`scripts/docs-screenshots` の架空のデータを入れた。GitHub の API だけ、デーモンの `fetch` を差し替えて、`mergeable` を手元のファイルで切り替えた（PR の確認の間隔は、動画のために 60 秒から 3 秒に縮めた）。
  1. 競合なし：「あなたの出番」はいつもの表示。
  2. `mergeable: false` にすると、数秒でダッシュボードの「あなたの出番」の状態が「実装の PR がベースブランチと競合」になり、行に取り込む操作の案内が出る。
  3. タスクの詳細と承認の画面に、競合と取り込む操作が出る。作業履歴には「競合している」だけが増え、実行や取り込みは始まっていない。
  4. `mergeable: true` に戻すと、表示が消えて、いつもの表示に戻る。
- 動画で気づいて直したこと：最初の文言は状態の表示が長く、ダッシュボードの行で題が「決済 …」まで切り詰められた。状態は短くし、取り込む操作は行の案内に分けた。

## レビューの指摘と対応と対応

| 指摘 | 対応 |
| --- | --- |
| 状態の表示が長く、「あなたの出番」の行で題が切り詰められる（動画で発見） | 状態を「実装の PR がベースブランチと競合」に短くし、操作の案内は行に別の行として添えた |
| 足した案内が、画面の文言の規則の長さの上限を超える（全体のテストで発見） | 本文を短くし、補足は Hint に分けた |
| 記録済みかを、画面に出す条件（`pullRequestConflict`）で見ると、ゴールガーディアンの判断中に毎回記録し直す（DA の指摘） | 記録済みかは `Task.pullRequestConflict` の番号とコミットで見るようにした |
| 閉じられた PR にも競合を記録できてしまう（DA の指摘） | 見守っている開いた PR だけを受け付けるようにした（作業履歴の誤りとして拒否） |

## 残したこと

- 要求要件・設計の PR（タスクブランチへの PR）の競合は出さない。
- 競合を Slack などへ通知することはしていない。
