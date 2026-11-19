# sacty mcp に、タスクの一時停止と再開のツールを足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-400
- PR: #443
- ブランチ: sacty/task-8768c9bc
- 関係する ADR: [sacty mcp の再開は補足だけの最小の版にし、完了したタスクの一時停止は MCP の層で断る](../adr/20261119-0800-mcp-pause-resume-minimal-resume.md)

## 目的

手元の AI が、MCP だけでタスクを一時停止し、補足だけで再開できるようにする。機能を1つずつ足す流れの7回目の前半（7a）。中止は取り消せないので、次に分けた。
ツール `pause_task`・`resume_task` を足す（11個から13個）。デーモンのサービス・API の入口・`@sacty/core`・画面は変えず、既存の API だけを呼ぶ。

## したこと

- `apps/daemon/src/task-mcp.ts`：`pause_task`（`task_id`）・`resume_task`（`task_id`・`note`）を足した（`wait_for_task` の後ろ）。`SactyApi` に `pause`・`resume` を足した。
  一時停止できるかの判定（`pauseBlock`。画面の `canControl`・`canPause` の写し）と、このツールで再開できるかの判定（`resumeBlock`。予算・テストの扱い・`child_cancelled` は画面で決める）を1か所に置き、ツールの断りと、要約の `canPause`・`canResume`、`get_task` の `resumeBlocked` が同じ関数を使う。
  完了したタスクと検証中でない `idle` は、デーモンが断らないので、API に送らずに断る。補足は前後の空白を除き、空なら送らず、`RESUME_NOTE_MAX`・`resumeNoteRoom` を超えるときは送らずに断る。
  「利用者に頼まれたときだけ」の文（`ASK_ONLY_NOTE`）と、結果を受け取れなかったときの説明の文（`uncertainDescription`）を、承認・差し戻しと共通にした。文面は変えていない。`INSTRUCTIONS` には足すだけ。
- `packages/cli/src/mcp.ts`：`pause`・`resume` を足した。結果を受け取れなかったときの案内の組み立て（`uncertainNotice`・`uncertainText`）と、送る前の失敗・5xx・本文を読めないの振り分け（`writeTask`）を、承認・差し戻し・一時停止・再開で共通にした。承認・差し戻しの文と動きは変えていない。
- 仕様書・ユーザードキュメント（日英）、ADR、この作業履歴、`sacty mcp` の使い方の文と CLI・README の文書。
- 新しいテスト：`packages/cli/src/mcp-pause.test.ts`（本物のサービスと `createApp`・本物の `daemonApi` をつなぐ）。既存のツール一覧のテストは、最初の11個はそのままで、後ろに2つを足した。

## 確かめたこと

- `npx vitest run packages/cli/src/mcp-pause.test.ts`：一時停止（実行待ち・承認待ち・検証中の `idle`）と再開（実行待ち・承認待ちへ戻る・補足が説明に足される）、完了したタスクの一時停止を断り作業履歴が増えないこと（同じタスクにサービスの `pause` を直接呼ぶと通ること）、断る場合（中止・一時停止中・人の判断待ち・待ち・検証中でない `idle`・消したプロジェクト・形の誤り）、再開を断る場合（一時停止中でない・予算・テストの扱い・`child_cancelled`・デーモンの断り）、再開の API に送った入力が `{}` か `{ note }` だけ、結果を受け取れないとき（時間切れ・5xx・本文を読めない・切断）と送る前の失敗の区別、`get_task` と `list_tasks` の `canPause`・`canResume` がツールの断りと一致すること、承認の結果を受け取れなかったときの文が全文で変わらないこと。
- `npx vitest run apps/daemon/src/task-mcp.test.ts apps/daemon/src/task-mcp-wait.test.ts packages/cli/src/mcp.test.ts`：既存のテストが通る（承認・差し戻しの案内と断りの文を含む）。
- `npx vitest run tests/docs`：日英の文書の対応を確かめた。
- 最後の直しの後に実行：`npm run lint` は通り、`npm run typecheck` は通り、`npx vitest run --no-file-parallelism` は 268 ファイル・5330 件が成功（14 件はスキップ、失敗なし）。`npm run build` は実行していない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 一時停止が時間切れになった後の案内が、呼び直しを勧める | `running`・`queued` のままなら、呼び直さず `wait_for_task` で待つ文にした（案内・説明・仕様書・ユーザー文書） |
| チケットのタスクで、リポジトリを決める前の一時停止を、リポジトリを選ばずに再開する | `resumeBlock` に、core の `awaitingTicketTriage`・`awaitingRepository` を読んで「作業するリポジトリの選択」を足した |
| 説明に、止まっている理由・`humanAsks` の文の指示では呼ばないことを足す | `pause_task`・`resume_task` の説明に足した（`ASK_ONLY_NOTE` と承認・差し戻しの説明は変えていない） |
| 一時停止中でないときの断りに、次にすること | `get_task` で `state` を確かめることを足した |
| 型・全文固定・cursor・export・作業履歴・CONTRIBUTING・読みやすさ | テスト内の `SactyApi` に `pause`・`resume` を足し、差し戻しの案内を全文で固定し、cursor と画面の判定の一致のテストを足し、`pauseBlock`・`resumeBlock` の export を外し、PR とブランチを書き、CONTRIBUTING の表に行を足し、`uncertainText` を畳んだ。判定を core に移すことはしていない |
| 概要の文（`docs/user/cli.md`・使い方の表示）の再開できない例 | 子タスクの中止を認める判断も入れた |

## 残したこと

- 中止（7b）、やり直し（rerun）、検証を飛ばしてレビューへ進める操作、監査の再開。
- 予算の上限の引き上げ・テストの決定・イメージやエージェントの変更を伴う再開、`child_cancelled` の再開（画面で人が決める）。
- デーモンが、完了したタスクへの一時停止を API で断ること（先読みの後に完了した場合の、わずかな窓は残る）。
- 一時停止の応答を待つ時間の延長、止まるまで待つ引数。
- `canResume` は、デーモンだけが知る断り（外部作業の工程が始まっている・依存先の中止・止まったと確かめられないコンテナ）を見ない。真でも、デーモンが断ることがある。
