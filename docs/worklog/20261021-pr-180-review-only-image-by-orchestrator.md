# PR のレビューだけのタスクで、レビューの工程のイメージをオーケストレーターに選ばせる

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: #180
- ブランチ: claude/pr-review-triage-orchestrator-spk66d
- 関係する ADR: [PR のレビューだけのタスクでも、images があり、イメージを決めていなければ、レビューの工程のイメージだけをオーケストレーターに選ばせる](../adr/20261021-0320-review-only-image-by-orchestrator.md)

## 目的

PR のレビューだけのタスクはオーケストレーターを通らないため、プロジェクトの対象でイメージを指定していないと、レビューが既定のイメージで
動き、対象のプロジェクトの検証コマンド（テストなど）を実行できなかった。`images` があるときは、レビューの工程に合うイメージを選ばせる。

## したこと

- `apps/daemon/src/service.ts`
  - オーケストレーターの実行（コンテキストの用意・実行・失敗の扱い・費用）を `runOrchestrator` に切り出し、`askOrchestrator` と共用にした。
  - `chooseReviewSteps` を足した。`images` があり、プロジェクトの対象・再実行でイメージを決めていなければ、オーケストレーターにレビューの
    工程のイメージだけを選ばせ、`withImages`（既定のイメージの理由の記録を含む）に通す。それ以外はこれまでどおり。
  - レビューだけのタスクの `StepsChosen` は、オーケストレーターがイメージを選んだときだけ、オーケストレーターの記録にした。
- `apps/daemon/src/prompts.ts`：`buildReviewImagePrompt`（指示）と `extractReviewImage`（答えの `sacty-review-image` を読む）を足した。
- `packages/core/src/messages.ts`：理由の文 `review.reviewOnlyImageChosen`（日本語・英語）を足した。
- テスト：`daemon.test.ts`（選んだイメージでレビューする・既定のイメージの理由の記録・読めない答えと無い名前で止まる）、`prompts.test.ts`
  （指示と答えの読み取り）。
- docs：ADR を足し、置き換えた2つの ADR の名前とステータスを変えた（切れたリンクを作業履歴で直した）。仕様（タスクと工程）・
  ユーザードキュメント（取り込み・コンテナイメージ）を日英で直した。

## 確かめたこと

- `npm run lint`：通った。
- `npm run typecheck`：通った。
- `npx vitest run`：2413 件が通り、8 件が落ちた（`agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts`）。
  この 8 件は、変更を外した状態（`git stash`）でも同じく落ちるので、この作業の環境（クラウドのコンテナ）によるもので、変更とは関係ない。
- `npx vitest run tests/docs`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| [要修正] `withImages` が images に無い名前を拒否するとき、失敗の結果に `runId` が引き継がれず、`runNext` が代わりのエージェントで選び直さずに止まる | `withImages` の失敗に `choice.runId` を引き継いだ。無い名前 → 代わりのエージェントが有効なイメージを選ぶ → レビューを始める回帰テストを足した（直す前の実装で落ちることを確かめた） |
| [提案] `reason`・`defaultReason` を UTF-16 のコード単位で切ると、境界の絵文字・補助漢字が壊れる | サロゲートペアの途中で切らない `headOf` で切るようにし、テストを足した |

## 残したこと

- 画面で、レビューだけのタスクのイメージの選択が、ほかのタスクと同じく作業履歴に出るかは、手で確かめていない。
