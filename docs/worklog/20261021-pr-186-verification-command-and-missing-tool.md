# テストのコマンドを検証のコマンドに広げ、ツールがイメージに無ければイメージを直す案内で止める

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: #186
- ブランチ: claude/sweet-johnson-42au4y
- 関係する ADR: [20261021-1330-verification-command-and-missing-tool](../adr/20261021-1330-verification-command-and-missing-tool.md)

## 目的

Kubernetes のマニフェストのリポジトリで、実装のタスクが「テストのコマンドを決められませんでした」で止まった。テストのコードの無いリポジトリでも、
リポジトリが使っている検証（`kustomize build`・`kubeconform` など）で確かめて進められるようにし、そのツールがテストのイメージに無いときは、
実装をやり直さずに、イメージのパッケージを直す案内を出して止める。

## したこと

- オーケストレーターへの指示（`apps/daemon/src/prompts.ts` の `buildOrchestratorPrompt`）：`testCommand` を「テスト（検証）のコマンド」にし、
  検証のコマンド（マニフェスト・Terraform・YAML の検証）を書かせる。ツールがどのイメージにも無くても空にさせない。`noTests` はテストの仕組みも
  検証のコマンドも無いときだけにした。テストのイメージの選び方の例に検証のツールを足した。
- 見分け（`apps/daemon/src/agents/test-runner.ts` の `missingCommands`）：終了コード 127 で、sh の「見つからない」の行の名前が、テストのコマンドに
  語として書いてあるものを返す（パスで書いたものは返さない）。
- 一時停止（`apps/daemon/src/service.ts` の `verify`・`checkReproduction`・`commandMissingPause`）：ツールが無ければ、`TestsRun`・`ReproductionChecked` を
  記録せずに `verify.commandMissing` で止める。再開するとテストから実行し直す。
- 文言（`packages/core/src/messages.ts`）：`verify.commandMissing` を日英で足した（既定のイメージと `images` のイメージで案内を分ける）。
- テスト：`test-runner.test.ts`（dash・busybox・bash の文言、127 以外、コマンドに書いていない名前・パス・名前の一部）、`daemon.test.ts`（実装の検証で止まり、
  再開すると実装をやり直さずにテストから進む／コマンドに書いていないツールはふつうの失敗としてやり直す／再現の確かめで止まり、再開で再現を確かめる）、
  `prompts.test.ts`（指示の文）。
- 仕様書（`tasks-and-steps`）・ユーザードキュメント（`tasks`・`images`）の日英を直し、ADR を足した。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- 追加した `daemon.test.ts` の2件（実装の検証・再現の確かめでツールが無いとき）は、`service.ts` の見分けを外すと失敗することを確かめた。
- 実際の Docker のイメージでテストを実行して、案内が出ることは確かめていない。

## レビューの指摘と対応

なし（作成時点）。
