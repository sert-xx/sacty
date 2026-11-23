<!-- sacty task df1b5ebb-8597-4ecf-be22-d339b91e747a の設計。sacty が作成しました。 -->

# PBI-498 設計：共通のネットワークとボリュームの持ち主の印と、起動時の回収

## スコープ

sacty が作るネットワーク・ボリュームに、持ち主のラベル `io.sacty.owner` を付けます。
デーモンの起動時の片付け（`cleanupAll`）で、持ち主のデーモンが終わっているものを、ラベルで探して消します。

- 対象
  - 複数の compose の共通のネットワーク（`docker network create`）へのラベル
  - compose のトップレベルの名前付きボリュームと、compose が作るネットワーク（`<プロジェクト>_sacty` など）へのラベル（Q-1）
  - `cleanupAll` の、ネットワーク・ボリュームの回収と、docker の呼び出しの期限（Q-2）
  - テスト（`apps/daemon/src/services.test.ts`）、仕様（`docs/spec/services.md`・`services.en.md`）、ADR、作業履歴
- 対象外
  - 匿名のボリューム。compose はラベルを付けられないので印を付けない。コンテナが残っていれば、既存の `down -v` で消える
  - ラベルの無い、いまより前のネットワーク・ボリュームの回収（確認しないと決めたこと）
  - コンテナ・イメージの回収の判断（どれを止めるか）と、実行の終わりの `stop`・`stopGroup` の期限

## 確認したいこと

- must：なし
- should
  - Q-1：共通のネットワークに加え、compose が作るネットワーク（単一の `<プロジェクト>_sacty`、compose の中で定義したもの）にもラベルを付けて回収しますか。
    推奨は「付ける」です。同じラベルとトップレベルの `labels` で付けられ、回収の処理は同じです。
    付けないと、compose の down が途中で失敗して残ったネットワークは、`compose ls` に出ず、依頼者の手で消すまでたまり続けます。
  - Q-2：受け入れ条件 4 の期限を、`cleanupAll` の既存の `compose ls`（30秒）と、コンテナの `down`（120秒。`stopGroup` と同じ）にも付けますか。
    推奨は「付ける」です。`compose ls` か `down` が返らないと、その後のネットワーク・ボリュームの回収が始まりません。
    付けないと、docker が詰まったときに回収が止まったままになり、受け入れ条件 4 を満たしません。
  - Q-3：実際の docker での確かめ（受け入れ条件 5）を、実装の工程の環境で docker が使えないときに、人が行いますか。
    推奨は「人が行う」です。sacty の工程のコンテナには docker がありません（この工程でも使えませんでした）。
    確かめないままにすると、docker の振る舞い（ラベルの付き方、使われているものの削除の失敗）が偽物のテストの前提と違っても、マージまで分かりません。
    実装は、手順（ラベル付きのネットワーク・ボリュームを作り、デーモンを SIGKILL で終わらせ、起動し直して `network ls`・`volume ls` で消えたことを見る）を作業履歴に書きます。

確認しないと決めたこと
- ラベルの無い古いネットワーク・ボリュームは残す。名前だけでは sacty のものとほかのものを見分けられず、受け入れ条件 3 に反するためです。依頼に、手元に残りが無いとあります。ADR に理由を書きます。
- ラベルは既存の `io.sacty.owner` を使う。意味（起動したデーモンの PID と開始時刻）が同じで、`parseOwner`・`isRunning` をそのまま使えるためです。
- 共通のネットワークの作成が期限切れになった後に遅れて作られたものは、ラベルが付くので、次の起動の回収で消える。新しい仕組みは足しません。
- `DOCKER_HOST` が別のマシンを指すときの誤判定は扱わない。コンテナの回収と同じ前提（ホストの `ps`）で、今回の変更で新しく起こらないためです。

## 既定で決めたこと

- ラベルの値が読めない（`parseOwner` が失敗する）ネットワーク・ボリュームは消さない。コンテナ（読めなければ止める）と扱いが違います。
- 回収は、コンテナ（プロジェクトの down）、ネットワーク、ボリュームの順にする。使われているものの削除は docker が断るためです。
- 前の段の失敗（`compose ls` が読めない、期限切れ）があっても、ネットワーク・ボリュームの回収は行う。
- ADR を新しく足し、PBI-78 の ADR（`docs/adr/20261014-0739-host-mcp-process-cleanup.md`）は置き換えない。コンテナの決定を変えないためです。

## 構成

| 場所 | 変更 |
| --- | --- |
| `services.ts` `labelOwner` | トップレベルの `volumes` と、`external` でない `networks` の `labels` に `io.sacty.owner` を付ける（compose の値は上書き） |
| `services.ts` `startGroup` | `docker network create --label io.sacty.owner=<pid> <started> <名前>` で作る |
| `services.ts` `cleanupAll` | `compose ls` に 30 秒、`down` に 120 秒の期限。その後にネットワーク、ボリュームの順に回収する。例外で reject しない |
| `docs/spec/services.md`・`.en.md` | 「起動と停止」の 4（ラベルの対象）と、起動時の片付けの箇条（ネットワーク・ボリューム、ラベルの無いものは残す、期限、失敗のログ） |
| `docs/adr/<UTC>-shared-network-volume-owner.md` | ネットワーク・ボリュームにも持ち主のラベルを付け、ラベルの無いものは残す決定と理由 |
| `docs/worklog/<UTC>-pbi-498-<スラッグ>.md` | コマンドと結果、実際の docker での確かめ（または手順と未実施） |

## 処理の流れ（ネットワーク・ボリュームの回収）

1. `docker network ls --filter label=io.sacty.owner --format '{{.Name}}\t{{.Label "io.sacty.owner"}}'` で一覧を読む（ボリュームは `docker volume ls`）。
2. `psTable` が空、または一覧の呼び出しが失敗・期限切れなら、その種類は何も消さない。
3. 持ち主が `isRunning` なら残し、終わっていれば `docker network rm`・`docker volume rm` で消す（各 30 秒）。

## エラー時の振る舞い

- 一覧を読めないとき、消せなかったとき（exit・timeout・spawn）は、`console.warn` に次の形で出し、残りの回収を続ける。
  - `[services] ネットワークの回収に失敗しました: <名前> (<timeout|spawn|exit>, code=…)`（ボリュームも同じ形）
- `compose ls`・`down` の期限切れも同じ形で出す。デーモンの起動は待たない（`main.ts` の `void` のまま）。

## テスト観点

- [TV-1] 共通のネットワークを持ち主のラベル付きで作る
  - 入力：deps.owner を PID 50・開始時刻 T0 にして、2つの compose で startGroup を呼ぶ
  - 期待結果：偽の docker が受けた network create の引数に `--label io.sacty.owner=50 T0` と `<composeProject(runId)>-network` が入っている
- [TV-2] compose のボリュームとネットワークにラベルを付け、external と匿名は変えない
  - 入力：トップレベルの名前付きボリューム（compose 側で io.sacty.owner=1 T9 を書いたもの）・定義したネットワーク・sacty のネットワーク・external: true の共通のネットワークを持つ正規化した設定に labelOwner を PID 50・T0 で呼ぶ
  - 期待結果：名前付きボリュームと external でないネットワークの labels の io.sacty.owner が `50 T0` になり、external のネットワークには labels が無く、サービスの短い書き方の匿名ボリュームは変わらない
- [TV-3] 持ち主の終わったネットワーク・ボリュームを消す
  - 入力：network ls・volume ls が、持ち主が終わった PID のもの・PID が再利用されたもの（開始時刻が違う）を1つずつ返し、table はどれも動いていない
  - 期待結果：その全部に network rm・volume rm が呼ばれ、cleanupAll のネットワーク・ボリュームの回収を外すとこのテストが落ちる
- [TV-4] 持ち主が動いているものは消さない
  - 入力：network ls・volume ls が、table で PID と開始時刻の両方が一致する持ち主のものを返す
  - 期待結果：network rm・volume rm が一度も呼ばれない
- [TV-5] 持ち主を確かめられないときは消さない
  - 入力：(a) table が空、(b) network ls・volume ls が exit 1 か期限切れ、(c) ラベルの値が `abc` のように読めない、をそれぞれ与える
  - 期待結果：どの場合も該当の種類の rm が呼ばれず、(b) では一覧を読めなかったことが console.warn に出る
- [TV-6] ラベルの無いものと名前だけ似たものは消さない
  - 入力：偽の docker が、`--filter label=io.sacty.owner` の無い一覧の呼び出しには `sacty-svc-x-network` とラベルの無いボリュームを返す
  - 期待結果：network ls・volume ls の引数に `--filter label=io.sacty.owner` があり、ラベルの無い `sacty-svc-x-network` とボリュームに rm が呼ばれない
- [TV-7] 消せなかったものをログに出して続ける
  - 入力：終わった持ち主のネットワーク2つとボリューム1つのうち、最初のネットワークの rm が exit 1、次が期限切れ（dockerTimeoutMs を小さくする）になる
  - 期待結果：console.warn に `ネットワークの回収に失敗しました: <名前> (exit, code=1)` と `(timeout, code=なし)` が出て、残りのボリュームの rm も呼ばれ、cleanupAll は reject せずに終わる
- [TV-8] compose ls・down が返らないときに期限で打ち切り、ネットワーク・ボリュームの回収に進む
  - 入力：compose ls が返らない場合と、compose ls が終わったプロジェクトを返して down が返らない場合を、期限を小さくして与える
  - 期待結果：どちらも期限で子プロセスが止まって console.warn に timeout が出て、その後に network ls・volume ls が呼ばれる
- [TV-9] 実際の docker で、止めずに終わらせたデーモンの残りが起動し直すと消える
  - 入力：docker のある環境で、複数の compose と名前付きボリュームを使う工程の実行中にデーモンを SIGKILL で終わらせ、sacty up で起動し直す
  - 期待結果：起動し直した後の docker network ls・docker volume ls に、その実行の共通のネットワークとボリュームが無く、その手順と結果（行えなければ未実施と手順）が作業履歴に書かれている
- [TV-10] 仕様（日英）に印と回収の振る舞いが書かれている
  - 入力：docs/spec/services.md と services.en.md の「起動と停止」
  - 期待結果：日英とも、io.sacty.owner をサービス・名前付きボリューム・sacty が作るネットワークに付けること、起動時に持ち主の終わったネットワーク・ボリュームを消すこと、ラベルの無いもの・持ち主が動いているもの・ps や一覧を読めないときは消さないこと、各呼び出しの期限と失敗のログが書かれ、英語の版のコードの参照が `Code:` で始まる
- [TV-11] ADR に、ラベルの無い古いものを残す決定と理由が書かれている
  - 入力：新しく足した docs/adr/ の ADR
  - 期待結果：ネットワーク・ボリュームに io.sacty.owner を付けて起動時に回収する決定と、ラベルの無いものは名前では sacty のものと見分けられないので残す理由が日本語で書かれ、PBI-78 の ADR を置き換えない
