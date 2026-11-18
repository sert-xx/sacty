# sacty mcp に成果物とログの取得を足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-395
- PR: なし
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
- 伏せ直し：書き始めた後に `addSecrets` で値が増えた実行は、値をストアのメモリーに持ち、`meta.json` に `redactPending` を書く。閉じるときの伏せ直しが済んだら捨てて消す。失敗したらデーモンが動いている間だけ持ち、持たない実行は中身を返さない（409）。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に、成果物とログの取得を足した。
- 仕様書（`docs/spec/mcp-server.md`・`architecture.md`）・ユーザードキュメント（`docs/user/mcp.md`・`cli.md`）の日英と ADR。

## 確かめたこと

- 新しいテスト：`apps/daemon/src/byte-range.test.ts`（上限ちょうどと1超え・全体以上の位置・複数バイトとサロゲートペアの境目・伏せる値が境目をまたぐ）、`apps/daemon/src/task-reads.test.ts`（成果物の状態・やり直した工程・まだ提出していない出力・レビューの行へのコメント・候補外の工程と種類・実行の一覧の元と切り替え）、
  `apps/daemon/src/task-mcp-read.test.ts`（本物のサービスと API・ストアに対して：一覧・上限・大きなログの読み取り量と応答の大きさ・実行中の末尾・秘密情報・伏せ直せていない実行・無いものと場所の外・シンボリックリンク）、`packages/cli/src/mcp.test.ts`（新しい API の呼び出し・前の版のデーモン・結果と標準エラーに秘密情報と中身を出さない・つながらない）。
- 既存のテストで変えたのは、ツールの一覧の名前・注釈の期待に新しい4つを足したことと、`SactyApi` のスタブに新しい4つのメソッドを足したことだけ（5つのツールの型・注釈・`reviewBody` の期待は起点のまま）。
- 実行したコマンドと結果は、提出の時点の記録に従う。Claude Code・Codex の実物から4つのツールを呼ぶ確認は、人が行う（していない）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし（実装の PR のレビューの前） | — |

## 残したこと

- 承認・差し戻し・中止などの操作、状態の変化を待つこと、対応待ちの一覧（次の回以降）。
- 差し戻し前の過去の回の成果物、エージェントの元のファイル（`agent-files`）、作業履歴の中身・エラーレポート・PR の差分の取得。
