# r5 の試行で見つかった作業領域・検証・画面・記録の問題を直す（PBI-302 の A・D 群）

- 日付: 2026-11-04（UTC）
- タスク: PBI-302
- PR: なし
- ブランチ: feat/issue-302-r5-followups-a
- 関係する ADR: [sacty とエージェントの作業用のファイルは作業領域の外に置き、リポジトリの検査と人の確認に影響させない](../adr/20261104-0355-keep-working-files-out-of-repository-checks.md)

## 目的

実験 r5 で見つかった問題のうち、作業領域・検証（A1・A2）と画面・記録（D1・D2）を直す。

- A1（F47）：作業用のファイル（`.sacty-tools/` の検証の記録）がリポジトリの検査を落とし、人の確認と PR の本文に入る。指示を足すだけでは効かなかった（PBI-301 A6）ので、仕組みで防ぐ。
- A2：テストの終了コードが 0 でないのに「合格」とだけ出る。理由を出す。
- D1：AI のレビューが付く前に、作り直した head が承認待ちに進む。今の head の AI のレビューの状況を出す。
- D2：Codex の実行の費用が「概算」のままで、報告か換算かが分からない。

## 調べたこと（r5 の証拠）

- S18：レビューの記録（ログ・`aggregation.json`・`dispatch.md`）が `.sacty-tools/review*/` に書かれ、`prettier --check .` が `.sacty-tools/review-fix/dispatch.md` で落ちた。最終レビュー 2 回目の終了コードが 1 で、環境による失敗だけとして合格にし、説明が人が確かめることの 2 件になった。
- S14：同じく `.sacty-tools/review/summary.json` が prettier を落とした。
- S16：検証のスクリプト（`test/capture-baseline.js`）が `.sacty-tools/baseline` を使い、リポジトリのコードに名前が入った。
- 原因：検証のスキルの「一時ディレクトリ」が場所を示さない。指示が「`.sacty-tools/` は PR・コミットに入れない」と書くので、作業用のファイルの置き場と読まれた。最終レビューの指示は、`.sacty-tools/` があるだけで「その環境だけの結果」を人の確認に入れさせていた。
- `RunCostRecorded` は、報告を使った実行とモデルごとに換算した実行だけを記録していた（PBI-301）。Codex は使用量だけを報告し、費用は報告しないので、記録が無かった。

## したこと

- A1
  - 置き場所：`WORKSPACE_SCRATCH_DIR`（`/tmp/agent-scratch`）を決め、既定のスキル（検証の実行・集約・リンク先の文書・画面の撮影）の「一時ディレクトリ」をこの場所にした。`.sacty-tools/` は道具だけと、既定の規則・実装の工程の指示・最終レビューの指示に書いた。
  - 差分の内部の名前：`internalNamesInDiff` で、追加された行の内部の名前を見つけ（依頼・要求要件・設計が挙げたものは除く）、最終レビューの指示にデータとして渡し、`extractFinalReview` で観点 `SCOPE`（範囲外の変更）の不合格にした。
  - 人が確かめることから外す：内部の名前を含む項目を外して `droppedHumanChecks` に残し（「この環境だけの結果」は入れたツールの注記なので残す）、環境による失敗の申告の内部の名前を含むものは 1 件の中立な文（`WORKSPACE_FILE_FAILURE`）にして、人が確かめることに出さない。`/tmp/sacty-…` のパスを `withoutInternalPaths` で除く。
  - 最終レビューの指示：`.sacty-tools/` の中の作業用のファイルが検査を落としたときは、写しから消して検査をやり直して判定させる。`.sacty-tools/` があるだけでは「その環境だけの結果」にしない（入れたツールがあるときだけ）。
- A2：PR の本文のテストの行に、終了コードが 0 でないのに合格にした理由を添えた（`environmentPassNote`）。画面の観点ごとの結果を「テスト合格（環境による失敗のみ）」にし、テストの欄に理由を足した。
- D1：`aiReviewFor`・`aiReviewOfHead`（`ai-review-head.ts`）で、同じ PR を指すほかのレビューのタスクから、今の head の状況（none・reviewing・attached）を計算する。`TaskService.view`（`GET /api/tasks/:id`）が `Task.aiReview` を足し、承認の画面とタスクの詳細（`AiReviewNotice`）に出す。PR の本文の結論に 1 行入れる（`aiReviewBodyLine`）。承認やマージは止めない。
- D2：使用量のある実行のすべてで `RunCostRecorded` を記録する。作業履歴の文を「CLI が費用を報告しなかったので、使用量を単価で換算した額」にした。
- 仕様書（`tasks-and-steps`・`approval`・`agent-execution`）・ユーザードキュメント（`tasks`・`intake`・`config`）を日英で直した。ADR を足した。

選んだこと：

- `.sacty-tools/` 自体は作業領域の外に移さなかった。実装の工程で入れたツールが、使い捨ての写しで検証するゴールガーディアンに渡らなくなる（PBI-278 の設計を変えることになる）ため。
- 内部の名前の持ち込みは、sacty 自身のリポジトリを直すタスクのように求められる場合があるので、依頼・要求要件・設計が挙げた名前は除いた。
- AI のレビューの状況は、承認の画面は最新、PR の本文は書いた時点のものとした。

## 確かめたこと

- 新しいテスト：`apps/daemon/src/r5-followups-a.test.ts`（スキルと指示の文面、`internalNamesInDiff` の 0・1・上限超え・削除したファイル・許可した名前・似た名前、最終レビューの結果（不合格・外す・言い換え・中立な文・PR の本文）、A2 の本文、D1 の判定と本文）、`apps/web/src/components/ai-review-notice.test.ts`、`implementation.test.ts`（A2 の画面）、`daemon.test.ts`（D2）。
- `npx biome check .`・`npm run typecheck`：エラーなし。
- `npx vitest run`（全体を1回）：202 ファイル・4051 テストが成功（3 件は元から skip。終了コード 0）。`tests/docs` も成功。
- 修正を戻すと落ちること：差分の内部の名前を範囲外にする処理・人が確かめることの除外・環境による失敗の中立な文・AI のレビューの「レビュー中」の判定・`RunCostRecorded` を全実行で記録する処理・`/tmp/…` のパスの除去を、それぞれ戻すと、対応する新しいテストが落ちた（戻して成功を確認）。サービスが `internalNames` を最終レビューの判定に渡さないようにすると、`daemon.test.ts` の統合のテストが落ちた。
- 既存のテストの更新：`RunCostRecorded` を全実行で記録するので、作業履歴のイベント列を確かめる `daemon.test.ts` の 6 件に `RunCostRecorded` を足した。PR の本文を比べる 2 件は、AI のレビューの行を含めて比べる。

## 残した制限

- `.sacty-tools/` の下に入れた道具に、フォーマッター・リンターが検査するファイル（`npm install` した `package.json` など）が含まれると、検査はそれで落ちうる。道具の置き場は変えていない（ADR 参照）。
- AI のレビューの状況は、同じデーモンのレビューのタスクだけを見る。PR の本文の行は、本文を書いた時点の状況で、その後は更新されない。
- 実際の Docker での、エージェントが `/tmp/agent-scratch/` に記録を書くことは確かめていない（指示と、差分・結果の機械的な検出で防ぐ）。
