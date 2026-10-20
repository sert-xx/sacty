# sacty up の起動時にエージェントのイメージがあるかを確かめ、無ければビルドを促す

- 日付: 2026-10-20（UTC）
- タスク: PBI-148
- PR: #166
- ブランチ: feat/pbi-148-image-presence
- 関係する ADR: なし

## 目的

版を上げると既定のイメージの名前（`sacty-agent:<版>`）が変わるが、`sacty up` はイメージを確かめておらず、タスクを実行して `run.imageMissing` で
止まって初めて気づいていた。起動した時点で、足りないイメージと作るコマンドを、端末と画面で知らせる。

## したこと

- デーモン（`apps/daemon/src/image-presence.ts`）：`config.yaml` の `image` と `images.*` のイメージを `docker image inspect`（10 秒で打ち切り）で確かめる
  `ImagePresenceChecker` を足した。標準エラー出力の `No such image`・`No such object` で「無い」、それ以外の失敗・時間切れで「確かめられない」と分ける。
  無いイメージごとに作るコマンド（言語ごとのイメージは名前付き）を出し、レジストリのイメージには実行時の取得を添え、確かめられないときは1つにまとめる。
- 起動のときと1分ごとに確かめ（`startImagePresenceCheck`）、最初の結果を端末に出し、`GET /api/status` の `warnings` に載せる（`main.ts`・`service.ts`）。
  起動は止めず、自動では作らない。
- 文言（`packages/core/src/messages.ts`）：`image.missing`・`image.notLocal`・`image.dockerUnreachable` を日英で足した。
- テスト：`image-presence.test.ts`（あり・無し・Docker の版による文言・接続できない・docker が無い・起動できない・時間切れの境界・レジストリの見分け・
  作るコマンド・設定の有無と誤り・一部だけ無い・まとめる・重複・同時・作った後に消える・英語・間隔）、`daemon.test.ts`（状態の注意）。
- 仕様書（`daemon-lifecycle`）とユーザードキュメント（`getting-started`・`troubleshooting`）の日英を直した。方針の大きな変更ではないので ADR は足していない。

## 確かめたこと

- `npm run lint`：通過（356 ファイル）。`npm run typecheck`：通過。`npx vitest run`：120 ファイル・2347 件が通過。
- 実際の Docker（Docker Desktop 4.86）で、`docker image inspect` の標準エラー出力が判定に合うことを確かめた：無いイメージは
  `Error response from daemon: No such image: sacty-agent:1.1.0`（終了コード 1）、あるイメージは終了コード 0、接続できない（`DOCKER_HOST` を無いソケットに
  した）ときは `failed to connect to the docker API at …`（終了コード 1）。
- 一時的なテストで、実装した `inspectImage`・`ImagePresenceChecker` を実際の Docker に対して動かし、`sacty-agent:1.1.0` が missing、`sacty-agent:0.1.0` が
  present、レジストリのイメージに取得の案内、接続できないときに unreachable になることを確かめた（一時的なテストは消した）。
- 実際の `sacty up` を起動して端末と画面に出ることは確かめていない（起動中の sacty を止めずに済ませるため）。運用の環境で、イメージを作る前の
  `sacty up` の出力とタスクの一覧の注意に案内が出て、作ると1分ほどで消えることを確かめる。

## レビューの指摘と対応（PR #166、Codex の DA レビュー）

| 指摘 | 対応 |
| --- | --- |
| 【要修正】設定ファイルが無いと、既定のイメージは確かめるのに、`status()` が設定の誤りの分岐で `warnings: []` を返すので、画面に案内が出ない | 設定の誤りの分岐でも、イメージの注意を `warnings` に載せるようにした。テスト：設定ファイルが無いときに、無い・Docker に接続できない・無くなった、の注意が載る（修正を戻すと失敗することも確かめた） |
| 【提案】止める関数は間隔のタイマーしか消さず、応答しない `docker image inspect` が残りうる（`process.exit` で打ち切りのタイマーも失われる） | `ImagePresenceChecker.stop` を足し、止める関数から呼ぶ。`AbortSignal` で実行中の docker を `SIGKILL` で止め、打ち切った結果は残さず、それからは確かめない。`inspectImage` の引数を `{ spawnImpl, timeoutMs, signal }` にした。テスト：途中で打ち切る・打ち切った後は起動しない・止める関数が打ち切って結果を残さない |
