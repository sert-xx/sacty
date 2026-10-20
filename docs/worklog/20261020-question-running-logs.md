# オーケストレーターへの質問で、実行中の工程のセッションログも調べられるようにする

- 日付: 2026-10-20（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-7d0e9c8f-axjgnn
- 関係する ADR: [質問の答えで実行中の実行のログの写しも読ませる](../adr/20261020-1108-question-reads-running-logs.md)

## 目的

処理が長引いているときに「オーケストレーターに質問」で様子を確かめたいが、実行中の工程のログは答えの材料に入らず（終わった実行だけを
並べていた）、いまの様子を答えられなかった。実行中の工程のログも、秘密の値を出さずに読ませる。

## したこと

- `apps/daemon/src/session-logs.ts`：`SessionLogStore` が、開いていてまだ閉じていない実行のログを覚え（閉じたら外す）、`snapshot` で
  いまの写しを返す。`SessionLog.snapshot` は、ファイルに書いた分とメモリーに持つ分（`HeadTailFile.snapshot`・`StreamRedactor.peek`）を
  つなげ、いまの秘密情報で伏せ直し、最後の改行で切る。目印の作り方は `close` と共通にした（`markers`）。
- `apps/daemon/src/question-logs.ts`：`stageQuestionLogs` に `includeRunning` を足し、実行中の実行は写しを書いて並べる（状態 `running`・
  `snapshotAt`）。監査は変えない（`includeRunning` を渡さない）。
- `apps/daemon/src/service.ts`：質問への答えでだけ `includeRunning` にする。
- `apps/daemon/src/prompts.ts`：一覧に実行中の行（いつの時点の写しか）を出し、実行中の実行があるときだけ、末尾から読むこと・いつの時点の
  様子かを書くことを指示に足す。
- 仕様書（`docs/spec/tasks-and-steps.md`・`docs/spec/event-log.md`）とユーザードキュメント（`docs/user/tasks.md`）を、英語の版も合わせて直し、
  ADR を足して前の ADR を一部置き換えにした。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npx vitest run tests/docs`（成功）。
- `npx vitest run`：足したテストを含めて成功。ただし `agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts` の
  8件は、この環境（root で動かすため権限の失敗が起きない・プロセスの扱い）で失敗する。変更を戻した状態でも同じ8件が失敗することを確かめた。
- 足したテスト：
  - `apps/daemon/src/question-logs.test.ts`：実行中の実行の写しを並べ、後から分かった秘密情報も伏せる（元のファイルは変えない）。書きかけの行は
    入れない。閉じた後は終わった実行として並べる。上限で省いたら目印を入れて末尾を残す（どの行も壊れていない JSON）。このデーモンで開いていない
    実行・`includeRunning` でないときは並べない。
  - `apps/daemon/src/daemon.test.ts`：工程の実行中に質問すると、その工程のログの写しを読み取り専用で渡して、いまの様子を答えられる。秘密の値は
    伏せる。質問しても実行は止めない。
  - `apps/daemon/src/prompts.test.ts`：実行中の行の形と読み方。実行中の実行が無ければ読み方を入れない。
- 修正を戻したときにテストが落ちることを確かめた：写しを伏せ直さない（1件）・実行中の実行を並べない（3件）。
- 確かめていないこと：実際の Claude Code・Codex が実行中の写しを読んで答えること（認証のある実際の AI では動かしていない）。画面の変更は無い。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 実行中の実行のエージェントの元のファイル（PBI-66）は、終わるまで読めない。
- 写しは質問を受けた時点のもので、答えの実行の間に進んだ分は入らない。
