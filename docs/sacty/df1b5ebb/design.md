<!-- sacty task df1b5ebb-8597-4ecf-be22-d339b91e747a の設計。sacty が作成しました。 -->

# PBI-498 設計：共通のネットワークとボリュームの持ち主の印と、起動時の回収

## スコープ

sacty が作るネットワーク・ボリュームに、持ち主のラベル `io.sacty.owner` と、ホストのラベル `io.sacty.owner-host` を付けます。
デーモンの起動時の片付け（`cleanupAll`）で、持ち主のデーモンが同じホストで終わっているものを、ラベルで探して消します。

- 対象
  - 複数の compose の共通のネットワーク（`docker network create`）へのラベル
  - compose のトップレベルの名前付きボリュームと、compose が作るネットワーク（`<プロジェクト>_sacty` など）へのラベル（Q-1）
  - compose に書いた匿名のボリューム（`source` の無い `type: volume`）を、実行ごとの名前付きボリュームに書き換えてラベルを付けること
  - 持ち主を確かめられないときに、ネットワーク・ボリュームを作らずに起動を失敗にすること（Q-5）
  - `cleanupAll` の、ネットワーク・ボリュームの回収と、docker の呼び出しの期限（Q-2）
  - テスト（`apps/daemon/src/services.test.ts`）、仕様（`docs/spec/services.md`・`services.en.md`）、ADR、作業履歴（実際の docker での確かめの結果を含む）
- 対象外
  - イメージの `VOLUME` で docker が作る匿名のボリューム（Q-4）
  - ラベルの無い、いまより前のネットワーク・ボリュームの回収（確認しないと決めたこと）
  - コンテナ・イメージの回収の判断（どれを止めるか。ホストのラベルによる判定もしない）と、実行の終わりの `stop`・`stopGroup` の期限

## 確認したいこと

- must：なし
- should
  - Q-1：共通のネットワークに加え、compose が作るネットワーク（単一の `<プロジェクト>_sacty`、compose の中で定義したもの）にもラベルを付けて回収しますか。
    推奨は「付ける」です。同じラベルとトップレベルの `labels` で付けられ、回収の処理は同じです。
    付けないと、compose の down が途中で失敗して残ったネットワークは、`compose ls` に出ず、依頼者の手で消すまでたまり続けます。
  - Q-2：受け入れ条件 4 の期限を、`cleanupAll` の既存の `compose ls`（30秒）と、コンテナの `down`（120秒。`stopGroup` と同じ）にも付けますか。
    推奨は「付ける」です。`compose ls` か `down` が返らないと、その後のネットワーク・ボリュームの回収が始まりません。
    付けないと、docker が詰まったときに回収が止まったままになり、受け入れ条件 4 を満たしません。
  - Q-3：実際の docker での確かめ（受け入れ条件 5）は、sacty の工程のコンテナに docker が無いため、人がホストで行い、結果を作業履歴に足すまで PR を完了にしない、でよいですか。
    推奨は「よい」です。実装は手順（ラベル付きのネットワーク・ボリュームを作り、デーモンを SIGKILL で終わらせ、起動し直して `network ls`・`volume ls` で消えたことを見る）を作業履歴に書き、結果の欄を人が埋めます。
    人が行わないと、PR は受け入れ条件 5 を満たさないまま止まり、依頼者がマージできません。
  - Q-4：イメージの `VOLUME` で作られる匿名のボリュームは、対象外でよいですか。
    推奨は「よい」です。compose の設定からはラベルを付けられず、付けるにはイメージを調べてマウントを足す仕組みが要ります。コンテナが残っていれば、既存の `down -v` で消えます。
    対象外にすると、そのイメージ（例：公式の postgres）のコンテナが消えた後のボリュームは、依頼者が手で消すまで残ります。
  - Q-5：持ち主（`ps` の自分の行）を確かめられないとき、サービスの起動を失敗にしますか（いまは印を付けずに起動します）。
    推奨は「失敗にする」です。印の無いネットワーク・ボリュームは、異常終了の後に回収できません。
    失敗にすると、`ps` が使えないホストでは、サービスを使う工程が毎回失敗し、依頼者は工程を進められません。

確認しないと決めたこと
- ラベルの無い古いネットワーク・ボリュームは残す。名前だけでは sacty のものとほかのものを見分けられず、受け入れ条件 3 に反するためです。依頼に、手元に残りが無いとあります。ADR に理由を書きます。
- ラベルは既存の `io.sacty.owner` を使う。意味（起動したデーモンの PID と開始時刻）が同じで、`parseOwner`・`isRunning` をそのまま使えるためです。
- 共通のネットワークの作成が期限切れになった後に遅れて作られたものは、ラベルが付くので、次の起動の回収で消える。新しい仕組みは足しません。
- `DOCKER_HOST` で別のマシンと docker を共有するときは、`io.sacty.owner-host`（`os.hostname()`）が自分のホスト名と同じものだけを回収する。ほかのマシンの持ち主は `ps` で確かめられないので消しません。

## 既定で決めたこと

- ラベルの値が読めない（`parseOwner` が失敗する）ネットワーク・ボリュームは消さない。コンテナ（読めなければ止める）と扱いが違います。
- 回収は、コンテナ（プロジェクトの down）、ネットワーク、ボリュームの順にする。使われているものの削除は docker が断るためです。
- 前の段の失敗（`compose ls` が読めない、期限切れ）があっても、ネットワーク・ボリュームの回収は行う。
- ADR を新しく足し、PBI-78 の ADR（`docs/adr/20261014-0739-host-mcp-process-cleanup.md`）は置き換えない。コンテナの決定を変えないためです。
- 匿名のボリュームの名前は `sacty-anon-<サービス>-<番号>` にし、compose の名前と重なれば番号をずらす。

## 構成

| 場所 | 変更 |
| --- | --- |
| `services.ts` `sanitizeCompose` | `source` の無い `type: volume` に `sacty-anon-…` の `source` を入れ、トップレベルの `volumes` に足す |
| `services.ts` `labelOwner` | トップレベルの `volumes` と、`external` でない `networks` の `labels` に `io.sacty.owner` と `io.sacty.owner-host` を付ける（compose の値は上書き） |
| `services.ts` `startGroup`・`startOnce` | 持ち主を、ネットワークの作成・`up` より前に読む。読めなければ何も作らず `services.failed` で失敗にする |
| `services.ts` `startGroup` | `docker network create --label io.sacty.owner=<pid> <started> --label io.sacty.owner-host=<ホスト名> <名前>` で作る |
| `services.ts` `cleanupAll` | `compose ls` に 30 秒、`down` に 120 秒の期限。その後にネットワーク、ボリュームの順に回収する。例外で reject しない |
| `docs/spec/services.md`・`.en.md` | 「起動と停止」の 4（ラベルの対象、匿名のボリュームの書き換え、持ち主が読めないときの失敗）と、起動時の片付けの箇条（ネットワーク・ボリューム、ラベルの無いもの・ほかのホストのものは残す、期限、失敗のログ） |
| `docs/adr/<UTC>-shared-network-volume-owner.md` | ネットワーク・ボリュームに持ち主とホストのラベルを付け、ラベルの無いもの・ほかのホストのものは残す決定と理由 |
| `docs/worklog/<UTC>-pbi-498-<スラッグ>.md` | コマンドと結果、実際の docker での確かめの手順と結果（Q-3） |

## 処理の流れ（ネットワーク・ボリュームの回収）

1. `docker network ls --filter label=io.sacty.owner --format '{{.Name}}\t{{.Label "io.sacty.owner"}}\t{{.Label "io.sacty.owner-host"}}'` で一覧を読む（ボリュームは `docker volume ls`）。
2. `compose ls` とこの 2 つの一覧を読み終えた後に、`psTable` を 1 回読む。一覧にあるものの持ち主は、一覧より前に起動しているので、動いていれば表に載ります。
3. `psTable` が空、または一覧の呼び出しが失敗・期限切れなら、その種類は何も消さない。
4. ホストのラベルが自分と違うか無いもの、持ち主が `isRunning` のものは残し、残りを `docker network rm`・`docker volume rm` で消す（各 30 秒）。

## エラー時の振る舞い

- 一覧を読めないとき、消せなかったとき（exit・timeout・spawn）は、`console.warn` に次の形で出し、残りの回収を続ける。
  - `[services] ネットワークの回収に失敗しました: <名前> (<timeout|spawn|exit>, code=…)`（ボリュームも同じ形）
- `compose ls`・`down` の期限切れも同じ形で出す。デーモンの起動は待たない（`main.ts` の `void` のまま）。
- 起動のときに持ち主を読めなければ、`services.failed`（詳細「起動したデーモンを確かめられません」）で工程を失敗にする。

## テスト観点

- [TV-1] 共通のネットワークを持ち主とホストのラベル付きで作る
  - 入力：deps.owner を PID 50・開始時刻 T0、ホスト名を h1 にして、2つの compose で startGroup を呼ぶ
  - 期待結果：偽の docker が受けた network create の引数に `--label io.sacty.owner=50 T0`・`--label io.sacty.owner-host=h1` と `<composeProject(runId)>-network` が入っている
- [TV-2] compose のボリュームとネットワークにラベルを付け、external は変えず、匿名のボリュームを名前付きに書き換える
  - 入力：トップレベルの名前付きボリューム（compose 側で io.sacty.owner=1 T9 を書いたもの）・定義したネットワーク・sacty のネットワーク・external: true の共通のネットワークと、サービスの短い書き方の匿名ボリューム `/data` を持つ compose を、sanitizeCompose と labelOwner（PID 50・T0・h1）に通す
  - 期待結果：名前付きボリューム・external でないネットワーク・`/data` に割り当てた `sacty-anon-<サービス>-<番号>` のトップレベルのボリュームの labels が io.sacty.owner=`50 T0`・io.sacty.owner-host=`h1` になり、external のネットワークには labels が無く、`/data` のマウントの source がそのボリュームになる
- [TV-3] 持ち主の終わったネットワーク・ボリュームを消す
  - 入力：network ls・volume ls が、ホストのラベルが自分のホスト名で、持ち主が終わった PID のもの・PID が再利用されたもの（開始時刻が違う）を1つずつ返し、table はどれも動いていない
  - 期待結果：その全部に network rm・volume rm が呼ばれ、cleanupAll のネットワーク・ボリュームの回収を外すとこのテストが落ちる
- [TV-4] 持ち主が動いているものは消さない
  - 入力：network ls・volume ls が、table で PID と開始時刻の両方が一致する持ち主のものを返す
  - 期待結果：network rm・volume rm が一度も呼ばれない
- [TV-5] 持ち主を確かめられないときは消さない
  - 入力：(a) table が空、(b) network ls・volume ls が exit 1 か期限切れ、(c) ラベルの値が `abc` のように読めない、(d) ホストのラベルが別のホスト名か無い（持ち主の PID は table に無い）、をそれぞれ与える
  - 期待結果：どの場合も該当の種類の rm が呼ばれず、(b) では一覧を読めなかったことが console.warn に出る
- [TV-6] プロセスの表は、ネットワーク・ボリュームの一覧を読んだ後に読む
  - 入力：偽の docker と偽の table が呼ばれた順を記録し、table は network ls・volume ls の両方が返る前に呼ばれると空を返すようにして、持ち主の終わったネットワーク・ボリュームで cleanupAll を呼ぶ
  - 期待結果：table の呼び出しが network ls・volume ls より後で、rm が呼ばれ、一覧より前に table を読む順に戻すとこのテストが落ちる
- [TV-7] 持ち主を確かめられないときは、ネットワーク・ボリュームを作らずに起動を失敗にする
  - 入力：deps.owner を渡さず、table の自分の行が無い（空の）状態で、startGroup と start をそれぞれ呼ぶ
  - 期待結果：network create と compose up が一度も呼ばれず、どちらも ok: false で、詳細に「起動したデーモンを確かめられません」を含む services.failed の文が返る
- [TV-8] ラベルの無いものと名前だけ似たものは消さない
  - 入力：偽の docker が、`--filter label=io.sacty.owner` の無い一覧の呼び出しには `sacty-svc-x-network` とラベルの無いボリュームを返す
  - 期待結果：network ls・volume ls の引数に `--filter label=io.sacty.owner` があり、ラベルの無い `sacty-svc-x-network` とボリュームに rm が呼ばれない
- [TV-9] 消せなかったものをログに出して続ける
  - 入力：終わった持ち主のネットワーク2つとボリューム1つのうち、最初のネットワークの rm が exit 1、次が期限切れ（dockerTimeoutMs を小さくする）になる
  - 期待結果：console.warn に `ネットワークの回収に失敗しました: <名前> (exit, code=1)` と `(timeout, code=なし)` が出て、残りのボリュームの rm も呼ばれ、cleanupAll は reject せずに終わる
- [TV-10] compose ls・down が返らないときに期限で打ち切り、ネットワーク・ボリュームの回収に進む
  - 入力：compose ls が返らない場合と、compose ls が終わったプロジェクトを返して down が返らない場合を、期限を小さくして与える
  - 期待結果：どちらも期限で子プロセスが止まって console.warn に timeout が出て、その後に network ls・volume ls が呼ばれる
- [TV-11] 実際の docker で、止めずに終わらせたデーモンの残りが起動し直すと消える
  - 入力：docker のあるホストで、複数の compose と名前付きボリューム・匿名ボリュームを使う工程の実行中にデーモンを SIGKILL で終わらせ、sacty up で起動し直す
  - 期待結果：起動し直した後の docker network ls・docker volume ls に、その実行の共通のネットワークとボリュームが無く、その手順と実際の結果（コマンドの出力）が作業履歴に書かれている
- [TV-12] 仕様（日英）に印と回収の振る舞いが書かれている
  - 入力：docs/spec/services.md と services.en.md の「起動と停止」
  - 期待結果：日英とも、io.sacty.owner と io.sacty.owner-host をサービス・名前付きボリューム（書き換えた匿名のボリュームを含む）・sacty が作るネットワークに付けること、持ち主を確かめられなければ起動を失敗にすること、起動時に同じホストの持ち主の終わったネットワーク・ボリュームを消すこと、ラベルの無いもの・ほかのホストのもの・持ち主が動いているもの・ps や一覧を読めないときは消さないこと、各呼び出しの期限と失敗のログが書かれ、英語の版のコードの参照が `Code:` で始まる
- [TV-13] ADR に、ラベルの無い古いものとほかのホストのものを残す決定と理由が書かれている
  - 入力：新しく足した docs/adr/ の ADR
  - 期待結果：ネットワーク・ボリュームに io.sacty.owner と io.sacty.owner-host を付けて起動時に回収する決定と、ラベルの無いものは名前では sacty のものと見分けられないので残し、ほかのホストのものは ps で持ち主を確かめられないので残す理由が日本語で書かれ、PBI-78 の ADR を置き換えない
