# sacty mcp に成果物と実行の一覧の取得を足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-395
- PR: #437
- ブランチ: sacty/task-ce0c959a
- 関係する ADR: [sacty mcp の成果物と実行の一覧の取得は、バイトで上限と位置を決め、デーモンに読み取りの API を足す](../adr/20261119-0200-mcp-read-deliverables-and-runs-by-byte-range.md)

## 目的

手元の AI が、タスクの工程ごとの成果物と、エージェントの実行の一覧を、画面を開かずに読めるようにする（読み取りだけ）。承認の前に中身を確かめる手段にする。
`sacty mcp` に機能を1つずつ足す流れの2回目。承認・差し戻しなどの操作は次の回。

実行のログの取得（`get_run_log`）は、いったん作ったが、利用者の決定で範囲から外した（後続）。実行中のログの秘密情報の伏せ直しと、記録の書き込み・閉じる処理への変更が絡み、すべての実行に効く変更になるため。

## したこと

- ツール3つ（`list_deliverables`・`get_deliverable`・`list_runs`）を `apps/daemon/src/task-mcp.ts` の `TOOLS` に足した。`SactyApi` に3つのメソッドを足し、`READ_REASONS`（定型の理由）と `readFailure`（失敗の応答を理由にする）を持つ。
  失敗の標準エラーの原因は、新しいツールだけ、接続の失敗の種類と時間切れの印に絞る。
- `packages/cli/src/mcp.ts`：新しい API を呼ぶ `readApi`。応答の本文は理由に入れない。本文が `error` を持つ JSON でない 404 は、前の版のデーモンとして、更新と再起動を促す理由にする。
- デーモン：読み取りの API を3つ足した（`server.ts`・`service.ts`）。成果物の状態と実行の一覧の元は `task-reads.ts`、バイトの範囲の読み取りは `byte-range.ts`。
  成果物の本文は、画面で読めるものと同じ元で、書く前に伏せてあるので、MCP のための伏せ直しはしない。
  `session-logs.ts` には、実行の記録（`meta.json`）を読むだけの `readMeta` と `isLive` を足しただけ（ログの書き込み・閉じる処理・伏せ直しは、変えていない）。
- 実行を拾う規則（`RUN_EVENTS`・`runLogId`）を `@sacty/core` に移し、画面は同じ関数を使う（表示は変わらない）。
- `list_runs` の結果から `hasLog` を外した（ログを読むツールが無いので、使えないものを使えるように見せない）。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に、成果物と実行の一覧の取得を足した。
- 仕様書（`docs/spec/mcp-server.md`・`architecture.md`・`README.md`）・ユーザードキュメント（`docs/user/mcp.md`・`cli.md`・`README.md`）の日英と ADR。`list_runs` で続きを取る間に実行が増えると重なりうることを、仕様書・ユーザードキュメントに書いた。

## 確かめたこと

- 新しいテスト：`apps/daemon/src/byte-range.test.ts`、`apps/daemon/src/task-reads.test.ts`、`apps/daemon/src/task-mcp-read.test.ts`（本物のサービスと API に対して：一覧・上限・5MB の本文・実行の状態と切り替え・件数の上限・無いものと場所の外）、`packages/cli/src/mcp.test.ts`（新しい API の呼び出し・前の版のデーモン・結果と標準エラーに秘密情報と中身を出さない・つながらない・本物の `daemonApi` と `createApp` をつないだ3つのツール）。
- 既存のテストで変えたのは、ツールの一覧の名前・注釈の期待に新しい3つを足したことと、`SactyApi` のスタブに新しい3つのメソッドを足したことだけ（5つのツールの型・注釈・`reviewBody` の期待は起点のまま）。
- 範囲を削った確かめ：`git diff HEAD -- apps/daemon/src/session-logs.ts` は、`lstatSync` の import と、読み取りだけの `readMeta`・`isLive` の追加だけ。`session-logs.test.ts` は起点のまま。
- 実行したコマンドと結果：
  - `npm run format`・`npm run lint`・`npm run typecheck`：どれも通った（最後の直しの後に実行）。
  - `npx vitest run --no-file-parallelism`：266 ファイル・5226 件のうち 5212 件が通り、14 件はスキップ（最後の直しの後に実行。失敗なし）。
  - `npm run build`：実行していない（CI に無く、Next のビルドを含み重いため）。
- Claude Code・Codex の実物から3つのツールを呼ぶ確認は、人が行う（していない）。

## レビューの指摘と対応

実行のログの取得と伏せ直しにかかわる指摘（design-3-2〜3-5・design-4-2〜4-6・implement-1-1〜1-3・implement-2-1〜2-6・implement-3-1〜3-3・implement-4-x と、人の指摘のうちログの伏せ方・継ぎ目・`close` の書き換えに関するもの）は、`get_run_log` と伏せ直しの変更を範囲から外したので、対応不要になった（利用者の決定）。残るものは次のとおり。

| 指摘 | 対応 |
| --- | --- |
| `CONTRIBUTING.md` のテストの表（人の指摘 4） | `task-mcp-read.test.ts` の行を、成果物と実行の一覧の読み取りに合わせた |
| `mcp-server.md` の失敗の表（人の指摘 4） | ログの行を外し、標準エラーの1行の内容と、`error` が既知の形でない失敗の理由を表に合わせた |
| 本物の `daemonApi` と `createApp` をつないだテスト・文書の作業履歴（design-3-6） | 3つのツールで残した。コマンドと結果・PR の番号を書いた |
| 前の ADR との関係（implement-2-6・人の指摘 5） | 前の ADR を、該当の部分だけ superseded にして相互にリンクした |
| 16桁以上の数が 400 になる（implement-4-33・4-34） | 後続に回す案（人に確認中） |
| `read_failed` のデーモンのログ・接続を断られた場合のテスト・`READ_TOOLS` などの整理（implement-1-4・implement-1-5・implement-2-3） | ログ関連は範囲から外れた。残りは後続に回す案（人に確認中） |

## 残したこと

- 実行のログの取得（`get_run_log`）と、それに要る実行中のログの伏せ直し・範囲の読み取りの API（後続）。
- 承認・差し戻し・中止などの操作、状態の変化を待つこと、対応待ちの一覧（次の回以降）。
- 差し戻し前の過去の回の成果物、エージェントの元のファイル（`agent-files`）、作業履歴の中身・エラーレポート・PR の差分の取得。
