# 同じ SACTY_HOME でデーモンを二重に起動させない

- 日付: 2026-10-14（UTC）
- タスク: PBI-79
- PR: #87
- ブランチ: feat/issue-79-single-instance
- 関係する ADR: [同じ SACTY_HOME のデーモンは OS のファイルロックで1つに限り、2つ目はデータに触れる前に終わる](../adr/20261014-0813-daemon-single-instance-lock.md)

## 目的

同じ `SACTY_HOME` で2つ目のデーモンが起動すると、起動の処理（共用の compose の実行ごとの取得の削除、`recoverInterrupted` による中断の記録など）が
1つ目に影響し、別のポートなら同じ台帳・DB に2つが書いていた。2つ目は、データに触れる起動の処理に入る前に、接続先・PID を表示して終わり、
`sacty up` も失敗で終わるようにする。判定はロックで行い、残った印・PID の再利用では起動を妨げない。違う SACTY_HOME は並行できる。

## したこと

- `apps/daemon/src/instance-lock.ts`（新規）：`SACTY_HOME/daemon.lock` に SQLite の排他ロック（中身は fcntl のロック）を取る。`node:sqlite` は既に使っているので依存は増えない。
- `apps/daemon/src/main.ts`：ロックを `mkdirSync(home)` のすぐ後に取る。作業履歴・設定の DB を開く処理、compose の片付け、`cleanupSharedComposeRuns`、host-mcp の
  前回の残りの片付け、ゲートウェイの listen、`recoverInterrupted`、`serve` は、すべてこの後にした。
- 動いているデーモンの接続先・PID・起動時刻を `daemon-owner.json` に書く（表示のためだけで、判定には使わない）。止めるときは自分が書いたものだけを消す。
- 2つ目のデーモンは専用の終了コード（3。`apps/daemon/src/exit-codes.ts`、`@sacty/daemon/exit-codes`）で終わる。`sacty up`（`packages/cli/src/index.ts`）は、そのコードを見たら
  ほかの sacty が動いているため起動しなかった旨を表示して、終了コード1で終わる。画面は起動せず、`daemon.json` も書かない（#85 の扱いのまま）。
- README を直した。

## 確かめたこと

- 実際の `sacty up` で、同じホームを同じポート（4900/4910）と別のポート（4920/4930）で起動した。どちらも、ほかの sacty のデーモンが動いている旨と接続先・PID・起動時刻を
  表示して、終了コード1で終わった。1つ目の作業履歴に入れておいた答えを待つ質問は中断として記録されず（イベントは2件のまま）、`workspaces/_shared-compose/run-1` も残り、
  `daemon.json` と `daemon-owner.json` も変わらなかった。1つ目のデーモン（401）と画面（200）は応答し続け、2つ目は docker を一度も呼んでいない。
- 対照として、ロックの判定を外したビルドで同じ手順を行った。同じポートでは `EADDRINUSE` で落ちる前に `QuestionAnswered`（中断）が記録され、`_shared-compose` が消えた。
  別のポートでは2つ目がそのまま並行して動いた。
- 1つ目の CLI・デーモン・画面を SIGKILL した後（`daemon.lock`・`daemon-owner.json`・`daemon.json` が残っている）、同じホームで起動できた。
- 1つ目（4900/4910）が動いている間に、別のホームで 4920/4930 を起動でき、両方が応答した。
- `apps/daemon/src/instance-lock.test.ts`（ロックを取るデーモンの代わりに別のプロセスを使う）：二重の起動を拒む（別のポート・シンボリックリンク・同じプロセスの中でも）、
  SIGKILL で印が残っても・子のプロセスを残して落ちても起動できる、残った印の PID がほかのプロセスに再利用されていても起動できる、違うホームは並行できる、
  止めるときにロックを外しほかのデーモンが書いた表示用のファイルは消さない、ロックがデータを触るどの処理よりも先にあること。
- 修正を戻すと落ちる：ロックを取らなくすると二重の起動を拒むテストなど4件、PID と生存確認による素朴な判定に替えると PID の再利用のテストなど2件。
- `npm run lint`（終了コード0）・`npm run typecheck`・`npx vitest run`（1104件）・`npm run build` が通った。
- 実際の確認では、`SACTY_HOME` を一時ディレクトリにし、PATH の先頭に偽の `security`・`op`・`gh`・`docker` を置き、秘密情報は取り出していない。終わった後、4900〜4930 で
  待ち受けているものと、残ったプロセスが無いことを確かめた。
- レビューでも、テスト1104件・lint・typecheck・core・daemon・CLI のビルドが通った。Web の本番ビルドは、Web の変更が無いのでレビューでは実行していない。

## レビューの指摘と対応

指摘は無かった（レビューは修正の必要なしと判定した）。

## 残したこと

- 2つの起動がほぼ同時のとき、負けた側が、勝った側が `daemon-owner.json` を書く前の一瞬に読むと、前回の残りの PID を表示することがある。表示だけの問題で、起動の判定には影響しない（この PR では扱わない）。
