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
- `packages/cli/src/mcp.ts`：`derive`・`rename` を `writeTask`＋`uncertainOf` で足した（`uncertainDerive`・`RENAME_UNCERTAIN`・`deriveRepositoryForMcp`）。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に、続きの作成と題の変更を足した。
- 文書：仕様書（`mcp-server.md`・`.en.md`）・ユーザードキュメント（`mcp.md`・`.en.md`）・`cli.md`・`cli.en.md`・各 README の行・`CONTRIBUTING.md` のテストの表・ADR を足した。
- テスト：`packages/cli/src/mcp-derive.test.ts` を足した（本物のサービスと API と `daemonApi` をつなぐ）。ツールの数を 19 に、`task-mcp.test.ts` の名前・注釈・結果の形の配列を合わせ、`SactyApi` の偽物（`apiOver`・`apiOverStub`・`task-mcp-wait.test.ts`・`task-mcp-read.test.ts`）に2つのメソッドを足した。`mcp-rerun.test.ts` の完了したタスクの案内の期待を、`derive_task` を案内する文に合わせた。

既定で決めたこと：

- `deriveBlocked` は、完了したタスクで続きを作れないとき（セキュリティの組み合わせ）だけ出す（`rerunBlocked` の出し方に合わせた）。
- `rename_task` の中止したタスクの断りは、`getTask` の結果の状態で先に断る（デーモンも断る）。

## 確かめたこと

- `npm run lint`：通った（708 ファイル、警告なし。フォーマットの直しを入れた後）。
- `npm run typecheck`：通った。
- `npx vitest run tests/docs`：93 件が通った（仕様書の「コード:」の参照名を直した後）。
- `npx vitest run --no-file-parallelism`：273 ファイル・5459 件が通った（14 件は skip）。
- `@sacty/daemon/task-mcp` は dist を読むので、`apps/daemon` で `npm run build` をしてから `packages/cli` のテストを実行した。
- テストのファイルは typecheck の対象外のため、`SactyApi` の偽物の書き漏れは `rg` で一覧して手で足した。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 指摘1：結果を受け取れなかった `derive_task` の案内に、比べる基準が無い | `derive_task` が送る直前に読んだ元のタスクの `derivedTasks`（無ければ「無し」）と、送った題を、失敗の文に入れた（`mcp.ts` の `uncertainDerive`。`SactyApi.derive` の入力に `derivedBefore` を足し、API には送らない）。増えた ID のタスクの題・`derivedFrom` が今回の依頼と合うかを見る案内にした。時間切れ・切断・本文を読めないときは、少し待ってから確かめる案内を足した。説明・`INSTRUCTIONS`・仕様書・ユーザードキュメント（日英）を合わせ、テストで文に基準と題が入ること・待つ案内が入ること（5xx では入らない）を確かめた |
| 指摘2：題の PR のリンクの条件がコードと食い違う | 説明・`INSTRUCTIONS`・仕様書・ユーザードキュメント（日英）を、コードの条件（作業するリポジトリが決まっているタスクで、題と説明から決まる PR の番号が変わる題は断る。PR から取り込んだタスクは問わない）に合わせた |
| 指摘3：検査エラーの文の写し | 今回は切り出さない（既存の `create_task` を変えないため）。`deriveBlock` と `rerunBlock` が互いを呼ぶことと、止まる条件を、両方のコメントに書いた |
| 指摘4：`expect(t.count(id)).toBe(t.count(id))` | 呼ぶ前の件数を取り、断った後と比べる形にした（消したプロジェクトの側も。タスクの数も比べる） |
| 指摘5：実行中のタスク・消したプロジェクト・コメント | `rename_task` の通るケースに実行中（running）を足した。消したプロジェクトのタスクは、本物のサービスで `deleteProject` を通して確かめる形にした（完了したタスクは監査などの実行待ちに入るため、実行待ちの一覧だけ空にしている。テストの中に書いた）。「検査で断るものは、送らない」のコメントを、実際（空・長すぎる題は送らず、今と同じ題・PR の変更はデーモンの理由を返すために送る）に合わせた |

### 2回目のレビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 指摘1：結果を受け取れなかった `derive_task` の送った題が標準エラーに残る | AI に返す文には題を入れたまま、標準エラーの1行（`failureLine`）には題を出さないようにした（`ToolFailure` に標準エラー用の文を分けて持たせ、`mcp.ts` の `uncertainDerive` が作る）。他のツールの出方は変えていない。標準エラーに題・内容が出ないことを、`mcp-derive.test.ts` で、時間切れ・切断・5xx・本文を読めないの各場合に確かめた |
| 指摘2：`rename_task` の `message` に題が入る | `message` を固定の文にし、題は `rename.from`・`rename.to` で返す。テストで `message` に題が入らないことを確かめ、仕様書の結果の記述を合わせた |
| 指摘3：空・長すぎる題の断りのテストが「題」だけ | 空は「入力してください。」、長すぎるは「200文字以内で入力してください。」の、それぞれ固有の文で確かめるようにした |

## 残したこと

- 作業するリポジトリ・進め方を指定しての派生、セキュリティの組み合わせのタスクからの派生、タスクの説明（body）の変更（デーモンに API が無い）は、この版に入れない（利用者の判断待ち）。
