# sacty mcp に、完了したタスクからの続きの作成（派生）と、タスクの題の変更のツールを足す

- 日付: 2026-11-20（UTC）
- タスク: PBI-412
- PR: なし
- ブランチ: 提出のときに決まる
- 関係する ADR: [sacty mcp の続きの作成（派生）は、画面の既定値のまま題と内容だけを送り、題の変更は題だけを送る](../adr/20261120-0900-mcp-derive-and-rename-minimal.md)

## 目的

`sacty mcp` に、ツールを2つ足す（17個から19個）。完了したタスクから続きのタスクを作る `derive_task`（画面の「続きのタスクを作る」を、リポジトリと進め方は既定値のまま、題と内容だけで押すのと同じ）と、題を変える `rename_task`（画面の「題を変える」と同じ）。
合わせて、`rerun_task` まわりの「完了したタスクの続きの作成は画面で行う」という文を直す。変えるのは MCP サーバーの層・テスト・文書だけで、デーモンのサービス・API・`@sacty/core`・画面は変えない。

## したこと

- `apps/daemon/src/task-mcp.ts`
  - `SactyApi` に `derive`・`rename` を足し、`derive_task`・`rename_task` を `TOOLS` の最後に足した（入力は `z.strictObject`。説明に `ASK_ONLY_NOTE`・`UNTRUSTED_NOTE`）。
  - 派生の断りを `deriveBlock`（`{ reason, decideOnScreen }`）にまとめ、ツールの断りと、要約の `canDerive`・`get_task` の `deriveBlocked` で共有した。中止したタスクの案内は、`rerunBlock` が無いときだけ再実行を案内する。セキュリティの組み合わせ（`isSecurityTask`）は、送らずに断って画面へ。
  - 題・内容の検査は core の `DeriveTaskInput`（`title`・`body`）、題の検査は `RenameTaskInput` に任せた。
  - 要約に `canDerive`・`derivedFrom`・`derivedTasks` を足した。`rerunBlock` の完了したタスクの案内・コメントと、`rerun_task`・`RerunToolInput`・`canRerun` の説明・`INSTRUCTIONS` の再実行の段落の「画面で行う」を直した。`INSTRUCTIONS` に2つの段落を足し、頼まれたときだけ呼ぶ列挙にも足した。
- `packages/cli/src/mcp.ts`：`derive`・`rename` を `writeTask`＋`uncertainOf` で足した（`DERIVE_UNCERTAIN`・`RENAME_UNCERTAIN`・`deriveRepositoryForMcp`）。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に、続きの作成と題の変更を足した。
- 文書：仕様書（`mcp-server.md`・`.en.md`）・ユーザードキュメント（`mcp.md`・`.en.md`）・`cli.md`・`cli.en.md`・各 README の行・`CONTRIBUTING.md` のテストの表・ADR を足した。
- テスト：`packages/cli/src/mcp-derive.test.ts` を足した（本物のサービスと API と `daemonApi` をつなぐ）。ツールの数を 19 に、`task-mcp.test.ts` の名前・注釈・結果の形の配列を合わせ、`SactyApi` の偽物（`apiOver`・`apiOverStub`・`task-mcp-wait.test.ts`・`task-mcp-read.test.ts`）に2つのメソッドを足した。`mcp-rerun.test.ts` の完了したタスクの案内の期待を、`derive_task` を案内する文に合わせた。

既定で決めたこと：

- `deriveBlocked` は、完了したタスクで続きを作れないとき（セキュリティの組み合わせ）だけ出す（`rerunBlocked` の出し方に合わせた）。
- `rename_task` の中止したタスクの断りは、`getTask` の結果の状態で先に断る（デーモンも断る）。

## 確かめたこと

- `npm run lint`：通った（708 ファイル、警告なし）。
- `npm run typecheck`：通った。
- `npx vitest run --no-file-parallelism`：273 ファイル・5445 件が通った（14 件は skip）。1回目の全件では、`task-mcp.test.ts` の2件（ツールの名前・結果の形の配列が17個のまま）が落ち、19個に直して通した。
- この作業履歴を書いた後に、docs の規則のテスト（`npx vitest run tests/docs`）を実行し直して通した。
- テストのファイルは typecheck の対象外のため、`SactyApi` の偽物の書き漏れは `rg` で一覧して手で足した。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | 提出の前なので、まだレビューを受けていない（受けたら、この表に書き足す） |

## 残したこと

- 作業するリポジトリ・進め方を指定しての派生、セキュリティの組み合わせのタスクからの派生、タスクの説明（body）の変更（デーモンに API が無い）は、この版に入れない（利用者の判断待ち）。
