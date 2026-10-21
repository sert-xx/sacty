# テストを sacty のテストのコンテナで実行するのをやめ、ゴールガーディアンが最終レビューの中で実行するようにする

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: #188
- ブランチ: claude/awesome-shannon-mtth67
- 関係する ADR: [ゴールガーディアンが最終レビューの中でテストを実行し、sacty はテストのコンテナを使わない](../adr/20261021-1431-guardian-runs-tests.md)

## 目的

テストのコマンドが複数の種類のテスト（例えば Small と Medium）を実行するリポジトリで、テストはすべて通っていたのに、最終レビューが不合格に
なった。sacty がテストのコンテナで実行した結果を、ゴールガーディアンには出力の末尾 8,000 文字だけ渡し、「判断の根拠は、差分とテストの結果だけ」
と指示していたため、観点に対応するテストの結果がゴールガーディアンに見えなかった。利用者の方針に従い、テストはゴールガーディアンが自分で
実行し、sacty は別に実行しないようにする。

## したこと

- 実装の検証（`apps/daemon/src/service.ts` の `verify`）：テストのコンテナ（`apps/daemon/src/agents/test-runner.ts` の `DockerTestRunner`）と
  `runTests` を消し、`TestsRun`・`TestsSkipped` を記録しないようにした。ゴールガーディアンの最終レビュー（`runGuardian`）を、実装の工程のイメージ
  （と `env`）で、実装後の作業領域の写しで動かす。テスト（検証）のコマンドがあれば、指示（`apps/daemon/src/prompts.ts` の `buildFinalReviewPrompt`・
  `testRunLines`）で実行させ、`sacty-final-review` の `tests` で申告させる。
- sacty に残す歯止め（`extractFinalReview`）：終了コード 0 の申告が無ければ不合格、テストを対応させていない観点は不合格（`review.viewpointUnmapped`）。
  申告は `FinalReviewed` の `tests`（`packages/core/src/events.ts` の `GuardianTests`）に記録する。
- ツールがイメージに無いとき：ゴールガーディアンの `missingCommands` のうち、テストのコマンドに語として書いてあるものがあれば、`FinalReviewFailed`
  と `TaskPaused`（`verify.commandMissing`）を記録する。文言から「（終了コード 127）」を外し、再開の説明を「テストを実行し直します」にした。
- サービス：テストのコマンドがある最終レビューの前に、実装の工程のサービスを起動し（イメージを ID に確定させてから）、ゴールガーディアンの
  コンテナをつなぎ、終わったら消す。起動できなければ `verify.testsUnavailable` で止める。
- やり直しの指示・PR の本文・チャットの判定の説明に、ゴールガーディアンが実行したテストを出す。
- 時間の上限（`apps/daemon/src/run-timeouts.ts` の `agentTimeoutMs`）：`final-review`・`reproduce` は、役割の上書きが無ければ
  `agent_minutes + test_minutes`。`testTimeoutMs` は消した。
- 再現：再現のエージェントにテストを実行させ、`sacty-reproduction` に `reproduced`・`command`・`exitCode`・`output` を申告させる。sacty は
  工程の完了と同じ追記で `ReproductionChecked` を記録する（`reproductionChecked`。新しい文言 `reproduce.notChecked`）。前の版で確かめを待って
  いたタスクは、再開・再起動のときに再現できなかったと記録する（`checkReproduction`）。
- 作業履歴の互換（`packages/core/src/projection.ts`）：`FinalReviewed`・`FinalReviewFailed` を `verification` が `pending` でも受け付け、実装の
  `AgentRunCompleted` で `lastTests`・`testsSkippedAt` を消す。`TestsRun`・`TestsSkipped`・`tests_passed` は読むためだけに残す。
- 画面（`apps/web`）：実装の成果物に「ゴールガーディアンが実行したテスト」を出し（前の版の記録は「テストの実行」のまま）、再現の確かめの補足を、
  再現のエージェントが実行して申告した結果である、という説明にした。
- docs：
  - ADR を足した（[ゴールガーディアンが最終レビューの中でテストを実行し、sacty はテストのコンテナを使わない](../adr/20261021-1431-guardian-runs-tests.md)）。
  - `20261021-1330-verification-command-and-missing-tool.md` と `20261015-0000-verify-without-test-command.md` を `git mv` で `superseded` にし、
    すでに `superseded` の `20261010-0834-superseded-implement-test-final-review.md`・`20261012-0516-superseded-bugfix-reproduce-step.md`・
    `20261013-0226-superseded-compose-services-per-run.md` の `置き換え先` に、置き換えた部分を書き足した。名前を変えた ADR へのリンクを直した。
  - 仕様書（`docs/spec/` の `agent-execution`・`services`・`tasks-and-steps`・`architecture`・`configuration`・`daemon-lifecycle` と英語の版）と、
    ユーザードキュメント（`docs/user/` の `tasks`・`images`・`config`・`compose`・`troubleshooting` と英語の版）を、今の振る舞いに直した。

## 確かめたこと

- `npx tsc -b packages/core apps/daemon packages/cli`：通った。
- `npx tsc --noEmit -p apps/web`：通った。
- `npx vitest run`：次の8件のほかは通った。`apps/daemon/src/agent-sessions.test.ts`・`apps/daemon/src/context-mcp.test.ts`・
  `apps/daemon/src/host-mcp-processes.test.ts` の8件は、この環境ではベースのブランチでも同じく落ちる（`git stash` で変更を外して確かめた）。
- テスト：デーモンのテストのうち、テストのコンテナでの実行を前提にしていた48件を書き直す・置き換えた。投影（ゴールガーディアンが実行した
  テストを最終レビューと一緒に持つ・前の版の `TestsRun` を読める）、画面の表示（`apps/web/src/lib/labels.test.ts`）、ゴールガーディアンが申告した
  テスト、イメージに無いツールの申告、再現の申告、前の版で再現の確かめを待っていたタスクのテストを足した。
- `npx vitest run tests/docs`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 仕様書の「設定を読めなければ 30 分」は、最終レビュー・再現では 50 分になる（`agentTimeoutMs(undefined, role)` が `test_minutes` の既定を足す） | `agent-execution.md`・`.en.md` を、ふつうの役割は 30 分、最終レビュー・再現は 50 分と書き分けた |

## 残したこと

- テストの合否は、ゴールガーディアンの申告で決まる。申告が正しいかを sacty は確かめない（ADR の「影響」）。
- 文言 `run.testTimeout`・`reproduce.runFailed` と、`TestsRun`・`TestsSkipped` のイベントは、前の版の記録を読むために残した。
