# 対応を求めていない PR のコメント（「承知しました」など）で、作り直さないようにする

- 日付: 2026-11-19（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/compassionate-hopper-ihcpso
- 関係する ADR: [対応を求めていない PR のコメントは、差し戻さない](../adr/20261119-1428-skip-rework-for-comments-that-ask-for-nothing.md)

## 目的

利用者からの報告への対応。sacty が指摘に返信した後、人が「承知しました。」と返すと、次のことが起きていた。

1. PR のコメントに、撤去済みの「ゴールガーディアン」の名前が出た。
2. 「承知しました」に、「対応していません。理由：…」の返信と、「人に確かめてほしいことがあります」のコメントが付いた。
3. 何も指摘していないのに、コードを直すコミットが入り、PR のレビューの子タスクがもう一度動いた。

## したこと

原因は、PR の人のコメントをすべて指摘として取り込み、戻し先の判断の答えに「差し戻さない」が無かったこと
（「判断できない」でも、その PR の工程をやり直す）。

- `apps/daemon/src/prompts.ts`
  - 戻し先の判断の指示（`buildReworkPrompt`）で、人の指摘に取り込んだ並びの番号を付け、対応を求めていない指摘の番号を
    `no_action` に答えさせる（`NO_ACTION_LINES`）。
  - `extractRework` が `no_action` を位置（0 始まり）にして読む。範囲の外・整数でない・AI のレビューの指摘の番号は読み捨てる。
    すべての指摘が当たれば、戻し先を読まずに `noRework` を返す。
- `packages/core/src/events.ts`・`packages/core/src/projection.ts`
  - `ReworkJudged` に `noAction`・`noRework` を足した。投影は、`noAction` の指摘を未反映の指摘（`pendingReview`）から除き、
    AI のレビューの指摘の位置を付け直す。1 件も残らなければ、未反映の指摘を片付ける。
- `apps/daemon/src/service.ts`
  - 承認待ちの取り込み（`importFeedback`）：判断の記録の後、指摘が残らなければ差し戻さない。
  - 一時停止の間に届いた指摘の反映（`reworkHeldReview`）：指摘が残らなければ、差し戻さず、止まった工程を走り直す。
- 文言
  - `apps/daemon/src/human-ask-notice.ts`：PR のコメントの「ゴールガーディアンが判断できませんでした」を、
    「戻し先の判断で、指摘（…）の意図を読み取れませんでした」に直した。
  - `apps/daemon/src/task-mcp.ts`：`get_task` の説明の「ゴールガーディアン」を直した。
  - 画面の作業履歴の戻し先の行（`apps/web/src/i18n/messages/labels.ts`）に、差し戻さなかったこと・除いた件数を出す。
- 仕様書（`docs/spec/approval.md`）・ユーザードキュメント（`docs/user/tasks.md`）と、それぞれの英語の版を直した。

## 確かめたこと

- `npm run lint`：問題なし。
- `npm run typecheck`：問題なし。
- `npm test`：5,383 件が合格、8 件が不合格（ほかに、ブラウザのテストの 2 ファイルが起動できず）。不合格は、この変更の前の
  状態でも同じ 8 件が落ちる（`host-mcp-processes.test.ts` の 6 件、`agent-sessions.test.ts`・`context-mcp.test.ts` の
  読めないファイルのテスト各 1 件。実行した環境が管理者権限で、ブラウザが入っていないため）。この変更に関わるテストは合格。
- `npx vitest run tests/docs`：93 件が合格。
- 足したテスト
  - `apps/daemon/src/daemon-implement.test.ts`：「承知しました。」だけなら差し戻さず承認待ちのまま・取り込み直さない、
    対応を求める指摘と一緒なら求める指摘だけを差し戻す、範囲の外の番号は読み捨てて差し戻す。
  - `apps/daemon/src/prompts.test.ts`：指示の番号と選び方、`extractRework` の読み方。
  - `packages/core/src/projection.test.ts`：除いた後の指摘と AI のレビューの指摘の位置。
  - `apps/web/src/lib/labels.test.ts`：作業履歴の表示。
- 確かめられなかったこと：実際のエージェントが「承知しました」を `no_action` と答えるか（指示の効き方）は、テストでは
  確かめられない。実際のタスクで確かめる必要がある。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 対応を求めていないコメントだけのときも、戻し先の判断の実行（1 回）の費用はかかる。
- 戻し先の判断には、コメントがどの投稿への返事か（sacty の返信の内容）を渡していない。
- コードのコメント・以前の版の記録の表示に残る「ゴールガーディアン」は、そのままにした（以前の版の記録の呼び名として使っている所がある）。
