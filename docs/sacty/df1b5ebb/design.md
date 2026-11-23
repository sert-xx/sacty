<!-- sacty task df1b5ebb-8597-4ecf-be22-d339b91e747a の設計。sacty が作成しました。 -->

# PBI-498 設計：共通のネットワークとボリュームの持ち主の印と、起動時の回収

## スコープ

sacty が作る共通のネットワークと、`sacty-svc-` の compose プロジェクトの名前付きボリュームに、コンテナと同じ持ち主のラベル `io.sacty.owner`（デーモンの PID と開始時刻）を付けます。
デーモンの起動時の片付け（`cleanupAll`）で、コンテナと同じ判定（ホストのプロセスの表との照合）で持ち主が終わっているものを消します。

- 対象
  - 複数の compose の共通のネットワーク（`docker network create`）へのラベル
  - compose のトップレベルの名前付きボリュームへのラベル
  - `cleanupAll` での、ラベルの付いたネットワーク・ボリュームの回収と、docker の呼び出しの期限・失敗のログ
  - テスト（`apps/daemon/src/services.test.ts`）、仕様（`docs/spec/services.md`・`services.en.md`）、ADR、作業履歴
- 対象外
  - 匿名のボリューム（compose に書いたもの・イメージの `VOLUME` 由来）。コンテナが先に消えると残りうることを ADR に書く
  - compose が作るネットワーク（`<プロジェクト>_sacty` など）
  - ラベルの無い、いまより前のネットワーク・ボリュームの回収
  - 持ち主の判定の強化（別のマシンとの docker の共有、`/proc` の `hidepid`、旧版と新版の sacty の共存）。今のコンテナの片付けと同じ前提・制約として、ADR と仕様に書く
  - コンテナのプロジェクトの `down` の判定、`stop`・`stopGroup` の期限、イメージの回収
  - 持ち主を読めないときの、サービス（コンテナ）の `labels` に入力の compose が書いた `io.sacty.owner` の扱い（今のまま）

## 確認したいこと

- must：なし
- should
  - Q-1：sacty の外で、共通のネットワークと同じ名前の形とラベル `io.sacty.owner` を人が付けて作ったネットワーク・ボリュームは、sacty のものと区別できないので回収してよいか。推奨：回収してよい（ADR に制約として書く）。入力の compose 由来と compose が作るものは除けるので、残るのは人がわざと sacty の印をまねた場合だけです。
    - 懸念：sacty の印をまねて手で作り、コンテナにつないでいない資源を持つ利用者は、デーモンの起動でその資源を失います。

## 既定で決めたこと

- `cleanupAll` の既存の `compose ls` に 30 秒、コンテナの `down` に 120 秒（`stopGroup` と同じ）の期限を付ける。返らないと、その後のネットワーク・ボリュームの回収が始まらないためです。
- 回収の対象は、ラベル `io.sacty.owner` に加えて作り方で選ぶ。ネットワークは名前が `sacty-svc-<英小文字・数字>-network` の形で `com.docker.compose.project` のラベルが無いもの（`docker network create` で作ったもの）、ボリュームは `com.docker.compose.project` が `sacty-svc-` で始まるものに限る。
- ラベルの値が読めない（`parseOwner` が失敗する）ネットワーク・ボリュームは消さない。
- 回収は、コンテナ（プロジェクトの down）、ネットワーク、ボリュームの順にする。使われているものの削除は docker が断るためです。
- `compose ls` が読めない・`sacty-svc-` のプロジェクトが無いときも、ネットワーク・ボリュームの回収は行う（いまはここで戻る）。

## 構成

| 場所 | 変更 |
| --- | --- |
| `services.ts` `sanitizeCompose` | トップレベルの `volumes` と `networks` の `labels`（配列・マップとも）から、入力の compose が書いた `io.sacty.owner` を除く。持ち主を読めないときも、ボリュームは印の無いまま起動し、回収されない |
| `services.ts` `labelOwner` | サービスに加え、トップレベルの `volumes` の `labels` に `io.sacty.owner` を付ける（compose の値は上書き） |
| `services.ts` `startGroup` | 持ち主を `network create` の前に読み、`docker network create --label io.sacty.owner=<pid> <started> <名前>` で作る。読めなければ、いまと同じくラベルを付けずに起動する |
| `services.ts` `cleanupAll` | `compose ls`・`down` に期限を付け、その後にネットワーク、ボリュームの順に回収する。プロセスの表は、プロジェクトの判定用と、ネットワーク・ボリュームの判定用に 1 回ずつ読む。例外で reject しない |
| `docs/spec/services.md`・`.en.md` | 「起動と停止」の 4（ラベルの対象に共通のネットワーク・名前付きボリューム、入力のボリューム・ネットワークの `io.sacty.owner` は使わない）と、起動時の片付けの箇条（ネットワーク・ボリュームの回収と対象の選び方、ラベルの無いものは残す、期限、失敗のログ、既存と同じ前提・制約） |
| `docs/adr/<UTC>-shared-network-volume-owner.md` | ラベルを付けて回収する決定、対象を作り方で選ぶこと、ラベルの無いものを残す理由（sacty が作ったか確かめられない）、匿名のボリュームが残りうること、既存と同じ前提・制約（別のマシン・`hidepid`・新旧の共存・sacty の印をまねた資源） |
| `docs/worklog/<UTC>-pbi-498-<スラッグ>.md` | コマンドと結果。実際の docker での確かめは、依頼者がマージの前にホストで行って足す |

## 処理の流れ（`cleanupAll`）

1. プロジェクトの回収は、いまの順（`compose ls` → `psTable` → 各プロジェクトの持ち主の判定 → `down`）のまま、期限だけを足す。表が空なら、プロジェクトは消さずに 2 へ進む。
2. 1 が終わった後に、`docker network ls --filter label=io.sacty.owner --format '{{.Name}}\t{{.Label "io.sacty.owner"}}\t{{.Label "com.docker.compose.project"}}'` で一覧を読み、既定で決めた名前の形とプロジェクトのラベルで絞る（ボリュームは `docker volume ls` で、プロジェクトのラベルで絞る）。各 30 秒。`down -v` で消えたボリュームは、ここで一覧に出ない。
3. 2 の 2 つの一覧を読み終えた後に、`psTable` をもう一度読む（1 の表は使わない）。一覧にあるものの持ち主は、一覧より前に起動しているので、動いていれば表に載ります。
4. 3 の表が空、または一覧の呼び出しが失敗・期限切れなら、その種類は何も消さない。
5. 持ち主が `isRunning` のものは残し、残りを `docker network rm`・`docker volume rm` で消す（各 30 秒）。ホストの再起動の前のものも、持ち主が動いていないので消える。

## エラー時の振る舞い

- 一覧を読めないとき、消せなかったとき（exit・timeout・spawn）は、`console.warn` に次の形で出し、残りの回収を続ける。
  - `[services] ネットワークの回収に失敗しました: <名前> (<timeout|spawn|exit>, code=…)`（ボリュームも同じ形）
- `compose ls`・`down` の期限切れも同じ形で出す。デーモンの起動は待たない（`main.ts` の `void` のまま）。

## テスト観点

- [TV-1] 共通のネットワークを持ち主のラベル付きで作る
  - 入力：deps.owner を PID 50・開始時刻 T0 にして、2つの compose で startGroup を呼ぶ
  - 期待結果：偽の docker が受けた network create の引数に `--label` と `io.sacty.owner=50 T0` と `<composeProject(runId)>-network` が入り、その呼び出しが各 compose の up より前にある
- [TV-2] compose の名前付きボリュームに持ち主のラベルを付け、external のネットワークは変えない
  - 入力：トップレベルの名前付きボリューム2つ（1つは compose 側で io.sacty.owner=1 T9 を書いたもの）と external: true の共通のネットワークを持つ compose を、labelOwner（PID 50・T0）に通す
  - 期待結果：2つのボリュームの labels の io.sacty.owner がどちらも `50 T0` になり、external のネットワークには labels が無い
- [TV-3] 持ち主を読めないときは、ラベルを付けず、入力の compose のボリュームの持ち主のラベルも除いて起動する
  - 入力：deps.owner を渡さず、table が自分の行を含まない状態で、トップレベルの名前付きボリューム2つ（labels をマップで io.sacty.owner=1 T9 と書いたもの、配列で `io.sacty.owner=1 T9` と `keep=1` を書いたもの）を持つ compose で startGroup を呼ぶ
  - 期待結果：network create の引数に `--label` が無く、compose の up に渡した設定のどちらのボリュームにも io.sacty.owner が無く `keep=1` は残り、起動は ok: true で返り、sanitizeCompose の除去を外すとこのテストが落ちる
- [TV-4] 入力の compose のネットワークに書いた持ち主のラベルを除く
  - 入力：サービスが使うトップレベルのネットワーク2つ（labels をマップで io.sacty.owner=1 T9 と書いたもの、配列で `io.sacty.owner=1 T9` と `keep=1` を書いたもの）を持つ compose を sanitizeCompose に通す
  - 期待結果：結果のどちらのネットワークの labels にも io.sacty.owner が無く `keep=1` は残り、ネットワークの除去を外すとこのテストが落ちる
- [TV-5] 持ち主の終わったネットワーク・ボリュームを消す
  - 入力：network ls が `sacty-svc-<runId>-network` の形でプロジェクトのラベルの無いものを、volume ls がプロジェクト sacty-svc-… のものを、持ち主が終わった PID のもの・PID が再利用されたもの（開始時刻が違う）の1つずつ返し、table はどれも動いていない
  - 期待結果：その全部に network rm・volume rm が呼ばれ、network rm がどの volume rm よりも前にあり、cleanupAll のネットワーク・ボリュームの回収を外すとこのテストが落ちる
- [TV-6] 持ち主が動いているものは消さない
  - 入力：network ls・volume ls が、table で PID と開始時刻の両方が一致する持ち主のものを返す
  - 期待結果：network rm・volume rm が一度も呼ばれない
- [TV-7] 持ち主を確かめられないときは、ネットワーク・ボリュームを消さない
  - 入力：持ち主の終わったものを返す前提で、(a) table が空、(b) network ls・volume ls が exit 1 か期限切れ、(c) ラベルの値が `abc` のように読めない、をそれぞれ与える
  - 期待結果：どの場合も該当の種類の rm が呼ばれず、(b) では一覧を読めなかったことが console.warn に出る
- [TV-8] sacty が作っていないネットワーク・ボリュームは、ラベルや名前が似ていても消さない
  - 入力：偽の docker が、ラベル付きの一覧の呼び出しに、持ち主の終わった io.sacty.owner を持つ次のものを返す：com.docker.compose.project が sacty-svc-… のネットワーク `sacty-svc-g0x_sacty`、プロジェクトのラベルの無い `other-network` と `sacty-svc-x-network-2`、com.docker.compose.project が `other` のボリューム。ラベルの無い一覧には `sacty-svc-x-network` とラベルの無いボリュームを返す
  - 期待結果：network ls・volume ls の引数に `--filter label=io.sacty.owner` があり、挙げたどのネットワーク・ボリュームにも rm が呼ばれず、名前の形かプロジェクトのラベルの確かめを外すとこのテストが落ちる
- [TV-9] 消せなかったものをログに出して続ける
  - 入力：終わった持ち主のネットワーク2つとボリューム1つのうち、最初のネットワークの rm が exit 1、次が期限切れ（dockerTimeoutMs を小さくする）になる
  - 期待結果：console.warn に `ネットワークの回収に失敗しました: <名前> (exit, code=1)` と `(timeout, code=なし)` が出て、残りのボリュームの rm も呼ばれ、cleanupAll は reject せずに終わる
- [TV-10] compose ls・down が返らない、または sacty-svc- のプロジェクトが無いときも、ネットワーク・ボリュームの回収に進む
  - 入力：持ち主の終わったネットワークを返す前提で、(a) compose ls が返らない、(b) compose ls が終わったプロジェクトを返して down が返らない（それぞれ期限を小さくする）、(c) compose ls が sacty-svc- のプロジェクトを返さない、を与える
  - 期待結果：(a)・(b) は期限で子プロセスが止まって console.warn に timeout が出て、(a)〜(c) のどれでも、その後に network ls・volume ls と network rm が呼ばれる
- [TV-11] プロセスの表を、プロジェクトの判定の前と、ネットワーク・ボリュームの一覧の後に1回ずつ読む
  - 入力：偽の docker と偽の table が呼ばれた順を記録し、compose ls は持ち主の終わったプロジェクトを、network ls・volume ls はデーモン D のものを返し、table は network ls・volume ls の両方が返る前の呼び出しでは D の無い（空でない）表を、後の呼び出しでは D のある表を返す
  - 期待結果：table が2回呼ばれ、1回目の後にプロジェクトの down が、2回目が network ls・volume ls の後にあり、D のネットワーク・ボリュームに rm が呼ばれず、2つ目の読み取りを外して1回目の表を使うとこのテストが落ちる
- [TV-12] 実際の docker で、止めずに終わらせたデーモンの残りが起動し直すと消える
  - 入力：依頼者がマージの前に docker のあるホストで、複数の compose と名前付きボリュームを使う工程の実行中にデーモンを SIGKILL で終わらせ、コンテナを docker rm -f で消してから sacty up で起動し直す
  - 期待結果：起動し直した後の docker network ls・docker volume ls に、その実行の共通のネットワークと名前付きボリュームが無く、その手順と実際の結果（コマンドの出力）が作業履歴に書かれている
- [TV-13] 仕様（日英）に印と回収の振る舞いと前提・制約が書かれている
  - 入力：docs/spec/services.md と services.en.md の「起動と停止」
  - 期待結果：日英とも、io.sacty.owner をサービス・共通のネットワーク・名前付きボリュームに付けること、入力の compose がボリューム・ネットワークに書いた io.sacty.owner は使わないこと、起動時に持ち主の終わったネットワーク・ボリュームを消し、対象を共通のネットワークの名前の形とプロジェクトのラベルの無いもの・sacty-svc- のプロジェクトのボリュームに限ること、ラベルの無いもの・持ち主が動いているもの・ps や一覧を読めないときは消さないこと、各呼び出しの期限と失敗のログ、別のマシンとの共有・hidepid・新旧の共存はコンテナの片付けと同じく守れないことが書かれ、英語の版のコードの参照が `Code:` で始まる
- [TV-14] ADR に、回収の決定と、残すものの理由と、既存と同じ前提・制約が書かれている
  - 入力：新しく足した docs/adr/ の ADR
  - 期待結果：共通のネットワークと名前付きボリュームに持ち主のラベルを付けて起動時に回収する決定、対象をラベルだけでなく作り方（共通のネットワークの名前の形とプロジェクトのラベルの無いこと・sacty-svc- のプロジェクトのボリューム）で選ぶこと、ラベルの無いものは sacty が作ったか確かめられないので残す理由、匿名のボリュームは対象外で残りうること、別のマシンとの共有・hidepid・新旧の共存・sacty の印をまねて作った資源は既存のコンテナの片付けと同じ前提・制約であることが日本語で書かれ、古い ADR の本文は変わっていない
