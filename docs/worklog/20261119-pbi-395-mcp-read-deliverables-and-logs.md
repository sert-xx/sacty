# sacty mcp に成果物とログの取得を足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-395
- PR: #437
- ブランチ: sacty/task-ce0c959a
- 関係する ADR: [sacty mcp の成果物とログの取得は、バイトで上限と位置を決め、デーモンに読み取りの API を足す](../adr/20261119-0200-mcp-read-deliverables-and-logs-by-byte-range.md)

## 目的

手元の AI が、タスクの工程ごとの成果物と、エージェントの実行の一覧・ログを、画面を開かずに読めるようにする（読み取りだけ）。承認の前に中身を確かめる手段にする。
`sacty mcp` に機能を1つずつ足す流れの2回目。承認・差し戻しなどの操作は次の回。

## したこと

- ツール4つ（`list_deliverables`・`get_deliverable`・`list_runs`・`get_run_log`）を `apps/daemon/src/task-mcp.ts` の `TOOLS` に足した。`SactyApi` に4つのメソッドを足し、`READ_REASONS`（定型の理由）と `readFailure`（失敗の応答を理由にする）を持つ。
  失敗の標準エラーの原因は、新しいツールだけ、接続の失敗の種類と時間切れの印に絞る。
- `packages/cli/src/mcp.ts`：新しい API を呼ぶ `readApi`。応答の本文は理由に入れない。本文が `error` を持つ JSON でない 404 は、前の版のデーモンとして、更新と再起動を促す理由にする。
- デーモン：読み取りの API を4つ足した（`server.ts`・`service.ts`）。成果物の状態と実行の一覧の元は `task-reads.ts`、バイトの範囲の読み取りは `byte-range.ts`、ログの範囲の読み取りは `session-logs.ts`（`SessionLogStore.readRange`）。
  実行を拾う規則（`RUN_EVENTS`・`runLogId`）は `@sacty/core` に移し、画面は同じ関数を使う（表示は変わらない）。
- 伏せ直し：書き始めた後に `addSecrets` で値が増えた実行は、値をストアのメモリーに持ち、`meta.json` に `redactPending` を書く。伏せ直しが済み、`redactPending` を消した `meta.json` を書けたときだけ捨てる。失敗したらデーモンが動いている間だけ持ち、持たず、`redactPending` が真か `finishedAt` が無い実行は中身を返さない（409）。
- 実行中のログの末尾：`peek()` の分と、伏せる値の先頭の一部で終わる分を、読める終わりから外す（`withoutPartialSecretTail`）。
- ログのファイルを開く・読むのに失敗したら、API は `read_failed` の 500、ツールは「ログを読めませんでした」。JSON でない 5xx は「sacty が <状態コード> を返しました」。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に、成果物とログの取得を足した。
- 仕様書（`docs/spec/mcp-server.md`・`architecture.md`）・ユーザードキュメント（`docs/user/mcp.md`・`cli.md`）の日英と ADR。

## 確かめたこと

- 新しいテスト：`apps/daemon/src/byte-range.test.ts`、`apps/daemon/src/task-reads.test.ts`、`apps/daemon/src/task-mcp-read.test.ts`（本物のサービスと API・ストアに対して：一覧・上限・大きなログの読み取り量と応答の大きさ・実行中の末尾と、伏せる値の先頭の一部で終わる末尾・秘密情報・伏せ直せていない実行と終わりが記録されていない実行・`meta.json` を書けない場合・ログを読めない場合・伏せる値が境目をまたぐ場合・無いものと場所の外・シンボリックリンク）、`packages/cli/src/mcp.test.ts`（新しい API の呼び出し・前の版のデーモン・結果と標準エラーに秘密情報と中身を出さない・つながらない・本物の `daemonApi` と `createApp` をつないだ4つのツール）。
- 既存のテストで変えたのは、ツールの一覧の名前・注釈の期待に新しい4つを足したことと、`SactyApi` のスタブに新しい4つのメソッドを足したことだけ（5つのツールの型・注釈・`reviewBody` の期待は起点のまま）。
- 実行したコマンドと結果：
  - `npm run lint`・`npm run format`・`npm run typecheck`：どれも通った（今回の直しの後に実行）。
  - `npx vitest run --no-file-parallelism`：266 ファイル・5238 件（14 件はスキップ）。作業履歴の PR の書式を直した後の流し直しの後に、`tests/docs/docs.test.ts`（87 件）だけを流し直し、通った。
  - `npm run build`：実行していない（CI に無く、Next のビルドを含み重いため）。
- Claude Code・Codex の実物から4つのツールを呼ぶ確認は、人が行う（していない）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 実行中のログの末尾に、伏せる前の値の先頭が残る（design-3-2・design-4-2） | `peek()` を外し、先頭の一部で終わる末尾を読める終わりから外した。テストを足した |
| 前の版の `meta.json`（終わりが無い実行）を伏せ直し済みとして返す（design-3-3） | `finishedAt` が無く値を持たない実行は 409 にした。見分けられない場合を ADR に書いた |
| `close` で `meta.json` を書けないときも値を捨てる（design-3-4） | 書けたときだけ捨てる |
| ログの読み取り失敗と JSON でない 5xx の扱い（design-3-5） | `read_failed` の 500 と、状態コードの理由にした |
| テスト・文書（人の指摘 5・6） | TV-20 のテストを平文が残る形にし、一時ディレクトリ名を戻し、本物の `daemonApi` と `createApp` のテストを足した。`event-log.md`・`CONTRIBUTING.md` を直した |

## 残したこと

- 承認・差し戻し・中止などの操作、状態の変化を待つこと、対応待ちの一覧（次の回以降）。
- 差し戻し前の過去の回の成果物、エージェントの元のファイル（`agent-files`）、作業履歴の中身・エラーレポート・PR の差分の取得。
