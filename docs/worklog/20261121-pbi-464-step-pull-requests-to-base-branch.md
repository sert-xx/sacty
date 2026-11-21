# 実装の無い進め方では、工程の PR をベースブランチへ直接出す

- 日付: 2026-11-21（UTC）
- タスク: PBI-464
- PR: なし
- ブランチ: sacty が作るタスクのブランチ（作業領域では main のまま。ブランチ名は sacty が決める）
- 関係する ADR: [実装の無い進め方では、タスクブランチを作らず、工程の PR をベースブランチへ直接出す](../adr/20261121-2215-step-pull-requests-to-base-branch-without-implementation.md)

## 目的

進め方に実装の工程が無い（`design-only`・分割の親など）タスクは、タスクブランチを作らず、要求要件・設計の PR をベースブランチへ直接出す。
文書がベースブランチに入り、続きのタスクが引き継げ、sacty のブランチをリモートに残さないようにする。

## したこと

- `directStepFlow`（タスクブランチが無く、`steps` に `implement` が無い）のタスクは、タスクブランチを作らず、工程のブランチをベースブランチの先頭から作り、PR をベースブランチへ出す。
  マージした文書もベースブランチを取得して読む。
- 開いている PR の作り直しは、前の工程の PR が後からマージされたときだけにした（ベースブランチの先頭とは比べない）。
- ブランチの削除の規則を `settleStepBranches` に 1 つ置き、PR の確認・作り直し・直しの間のマージ・完了・中止が通るようにした。
  マージした PR・sacty が閉じた PR は無条件に、人のクローズ・残りは先頭を比べて消す。人がコミットを足したブランチは、新しいイベント `StepBranchKept` で記録して残す。
  `deleteBranch` に期待する先頭を渡せるようにし、`--force-with-lease` で消す。
- 中止の確認（`cancelTargets`）に、残すブランチと理由を足した。派生の記録に、マージした PR の文書のパスを足した。
- 仕様書・ユーザー文書（日英）・図（`approval-branches-direct`）と ADR を足した。古い ADR（20261013-1318）の置き換え先に新しい ADR を足した。

## 確かめたこと

- `apps/daemon/src/daemon-step-pull-requests-direct.test.ts`（TV-1〜TV-22・TV-25・TV-26）、`packages/core/src/projection.test.ts`（TV-27）、`packages/cli/src/mcp-cancel.test.ts`（TV-20）、`apps/daemon/src/repository.test.ts`（期待する先頭での削除）。
- 既存の分割の子タスクのテストは、子タスクが実装の工程を持つ進め方にして、親がタスクブランチを作らないことも確かめるようにした。

- 実行した検証（レビューの指摘を直した後のコードで実行）：
  - `npm test`：339 ファイル・6867 件が通った（14 件はスキップ。ローカルの git が古く、`merge-tree --merge-base` を使う既存のテストが飛ぶ）。
  - `npm run lint`・`npm run typecheck`（web を含む）：通った。
  - `npm run docs:diagrams`：図を作り直した（警告 2 件は既存の図の幅）。
- 完了の片付けの中では作業領域を用意し直さない（自分の片付けを待って止まるため）。削除の `fetch`・`push` には 120 秒の時間切れを付けた。
  - 止まらないことのテスト：完了の片付けの中で git のメタデータが無い場合（`daemon-step-pull-requests-direct.test.ts`。`prepare: false` を外すと止まって落ちる）、先頭の取得が止まった場合（同。時間切れの信号を渡さないと落ちる）、`deleteBranch` の時間切れ（`repository.test.ts`）。

## 残したこと

- すでにリモートに残っている過去のタスクのブランチの片付けは、していない。
- 開いている PR にベースブランチの最新を取り込むことは、していない（マージする人が競合を解く）。
