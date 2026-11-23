<!-- sacty task df1b5ebb-8597-4ecf-be22-d339b91e747a の設計。sacty が作成しました。 -->

# PBI-498 設計：共通のネットワークとボリュームの持ち主の印と、起動時の回収

## スコープ

sacty が作るネットワーク・ボリュームに、持ち主のラベル `io.sacty.owner` と、プロセスの一覧を共有する環境を示すラベル `io.sacty.owner-env` を付けます。
デーモンの起動時の片付け（`cleanupAll`）で、環境の印が自分と同じで、持ち主のデーモンが終わっているものだけを消します。コンテナのプロジェクトの `down` も同じ判断にします。

- 対象
  - 複数の compose の共通のネットワーク（`docker network create`）へのラベル
  - compose のトップレベルの名前付きボリュームと、compose が作るネットワーク（`<プロジェクト>_sacty` など）へのラベル（Q-1）
  - 匿名のボリューム（compose に書いた `source` の無い `type: volume` と、イメージの `VOLUME`）を、実行ごとの名前付きボリュームに書き換えてラベルを付けること
  - 持ち主か環境の印を確かめられないときに、ネットワーク・ボリュームを作らずに起動を失敗にすること（Q-5）
  - `cleanupAll` の、ネットワーク・ボリュームの回収と、プロジェクトの `down` の判断への環境の印の追加（Q-6）と、docker の呼び出しの期限（Q-2）
  - テスト（`apps/daemon/src/services.test.ts`）、仕様（`docs/spec/services.md`・`services.en.md`）、ADR、作業履歴（実際の docker での確かめの結果を含む）
- 対象外
  - ラベルの無い、いまより前のネットワーク・ボリュームの回収（確認しないと決めたこと）
  - イメージの回収（`--rmi local`）と、実行の終わりの `stop`・`stopGroup` の期限

## 確認したいこと

- must
  - Q-6：プロジェクトの `down` も、環境の印が自分と同じものだけにし、環境の印の無い古いプロジェクト（ラベルの無いものを含む）は残しますか。
    推奨は「そうする」です。`down -v` はボリュームも消すので、ここを変えないと、別の環境で動く sacty のボリュームが消え、受け入れ条件 2 を満たしません。PBI-78 の ADR の「ラベルの無いものは止める」を新しい ADR で置き換えます。
    範囲の外の「コンテナの回収の変更」に触れるため、依頼者の意図と違えば、`down` の判断と仕様・ADR の直しが無駄になります。古いプロジェクトは手で消すまで残ります（手元に残りは無いと依頼にあります）。
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
  - Q-4（削除：イメージの `VOLUME` も名前付きに書き換えて対象に入れたため）
  - Q-5：持ち主（`ps` の自分の行）か環境の印を確かめられないとき、サービスの起動を失敗にしますか（いまは印を付けずに起動します）。
    推奨は「失敗にする」です。印の無いネットワーク・ボリュームは、異常終了の後に回収できません。
    失敗にすると、`ps` が使えないホストでは、サービスを使う工程が毎回失敗し、依頼者は工程を進められません。

確認しないと決めたこと
- ラベルの無い古いネットワーク・ボリュームは残す。名前だけでは sacty のものとほかのものを見分けられず、受け入れ条件 3 に反するためです。依頼に、手元に残りが無いとあります。ADR に理由を書きます。
- ラベルは既存の `io.sacty.owner` を使う。意味（起動したデーモンの PID と開始時刻）が同じで、`parseOwner`・`isRunning` をそのまま使えるためです。
- 共通のネットワークの作成が期限切れになった後に遅れて作られたものは、ラベルが付くので、次の起動の回収で消える。新しい仕組みは足しません。
- `DOCKER_HOST` で docker を共有するとき、ホスト名が同じ別のマシン、PID 名前空間の違うコンテナの sacty のものは、環境の印が違うので、`down` でも直接の削除でも消さない。`ps` で持ち主を確かめられないためです。

## 既定で決めたこと

- 環境の印は、Linux は `/proc/sys/kernel/random/boot_id` と `/proc/self/ns/pid` の組、macOS は `sysctl kern.bootsessionuuid` にする。起動ごとに変わるので、再起動の前の残りは消えません（再起動で docker のプロセスの表も変わり、持ち主は確かめられないため）。
- ラベルの値が読めない（`parseOwner` が失敗する）ネットワーク・ボリュームは消さない。
- 回収は、コンテナ（プロジェクトの down）、ネットワーク、ボリュームの順にする。使われているものの削除は docker が断るためです。
- 前の段の失敗（`compose ls` が読めない、期限切れ）があっても、ネットワーク・ボリュームの回収は行う。
- 匿名のボリュームの名前は `sacty-anon-<サービス>-<番号>` にし、compose の名前と重なれば番号をずらす。

## 構成

| 場所 | 変更 |
| --- | --- |
| `services.ts` `sanitizeCompose` | `source` の無い `type: volume` に `sacty-anon-…` の `source` を入れ、トップレベルの `volumes` に足す |
| `services.ts` `startOnce`・`startGroup`（`up` の前） | `compose build` と `compose pull --ignore-buildable` でイメージをそろえ、`docker image inspect` の `Config.Volumes` のうちマウントの無いパスに `sacty-anon-…` のボリュームを足す。読めなければ起動を失敗にする |
| `services.ts` `labelOwner` | サービスと、トップレベルの `volumes`・`external` でない `networks` の `labels` に `io.sacty.owner` と `io.sacty.owner-env` を付ける（compose の値は上書き） |
| `services.ts` `startGroup`・`startOnce` | 持ち主と環境の印を、ネットワークの作成・`up` より前に読む。読めなければ何も作らず `services.failed` で失敗にする |
| `services.ts` `startGroup` | `docker network create --label io.sacty.owner=<pid> <started> --label io.sacty.owner-env=<環境の印> <名前>` で作る |
| `services.ts` `cleanupAll` | `down` は、全コンテナの環境の印が自分と同じで持ち主が動いていないプロジェクトだけにする（Q-6）。`compose ls` に 30 秒、`down` に 120 秒の期限。その後にネットワーク、ボリュームの順に回収する。例外で reject しない |
| `docs/spec/services.md`・`.en.md` | 「起動と停止」の 4（ラベルの対象、匿名のボリュームの書き換え、印を読めないときの失敗）と、起動時の片付けの箇条（環境の印による判断、ネットワーク・ボリューム、印の無いもの・ほかの環境のものは残す、期限、失敗のログ） |
| `docs/adr/<UTC>-shared-network-volume-owner.md` | 持ち主と環境の印を付け、印の無いもの・ほかの環境のものは `down` でも消さない決定と理由。PBI-78 の ADR の「ラベルの無いものは止める」を置き換える |
| `docs/worklog/<UTC>-pbi-498-<スラッグ>.md` | コマンドと結果、実際の docker での確かめの手順と結果（Q-3） |

## 処理の流れ（ネットワーク・ボリュームの回収）

1. `docker network ls --filter label=io.sacty.owner --format '{{.Name}}\t{{.Label "io.sacty.owner"}}\t{{.Label "io.sacty.owner-env"}}'` で一覧を読む（ボリュームは `docker volume ls`）。
2. `compose ls` とこの 2 つの一覧を読み終えた後に、`psTable` を 1 回読む。一覧にあるものの持ち主は、一覧より前に起動しているので、動いていれば表に載ります。
3. `psTable` が空、自分の環境の印が読めない、または一覧の呼び出しが失敗・期限切れなら、その種類は何も消さない。
4. 環境の印が自分と違うか無いもの、持ち主が `isRunning` のものは残し、残りを `docker network rm`・`docker volume rm` で消す（各 30 秒）。

## エラー時の振る舞い

- 一覧を読めないとき、消せなかったとき（exit・timeout・spawn）は、`console.warn` に次の形で出し、残りの回収を続ける。
  - `[services] ネットワークの回収に失敗しました: <名前> (<timeout|spawn|exit>, code=…)`（ボリュームも同じ形）
- `compose ls`・`down` の期限切れも同じ形で出す。デーモンの起動は待たない（`main.ts` の `void` のまま）。
- 起動のときに持ち主か環境の印を読めなければ、`services.failed`（詳細「起動したデーモンを確かめられません」）で工程を失敗にする。
- イメージの `VOLUME` を読めない（build・pull・inspect の失敗）ときは、`services.failed` にその出力を入れて工程を失敗にする。

## テスト観点

- [TV-1] 共通のネットワークを持ち主と環境の印のラベル付きで作る
  - 入力：deps.owner を PID 50・開始時刻 T0、環境の印を e1 にして、2つの compose で startGroup を呼ぶ
  - 期待結果：偽の docker が受けた network create の引数に `--label io.sacty.owner=50 T0`・`--label io.sacty.owner-env=e1` と `<composeProject(runId)>-network` が入っている
- [TV-2] compose のボリュームとネットワークにラベルを付け、external は変えず、匿名のボリュームを名前付きに書き換える
  - 入力：トップレベルの名前付きボリューム（compose 側で io.sacty.owner=1 T9 を書いたもの）・定義したネットワーク・sacty のネットワーク・external: true の共通のネットワークと、サービスの短い書き方の匿名ボリューム `/data` を持つ compose を、sanitizeCompose と labelOwner（PID 50・T0・e1）に通す
  - 期待結果：名前付きボリューム・external でないネットワーク・`/data` に割り当てた `sacty-anon-<サービス>-<番号>` のトップレベルのボリュームの labels が io.sacty.owner=`50 T0`・io.sacty.owner-env=`e1` になり、external のネットワークには labels が無く、`/data` のマウントの source がそのボリュームになる
- [TV-3] イメージの VOLUME を名前付きのラベル付きボリュームに書き換えて起動する
  - 入力：偽の docker の image inspect が、image のサービスに `/var/lib/data` と `/logs`、build のサービスに `/cache` の Config.Volumes を返し、compose 側で `/logs` だけにマウントを書いた状態で start と startGroup を呼ぶ
  - 期待結果：up に渡した設定で、`/var/lib/data` と `/cache` に `sacty-anon-…` のボリュームのマウントがあり、そのトップレベルのボリュームに io.sacty.owner と io.sacty.owner-env のラベルがあり、`/logs` のマウントは compose の書いたままで、image inspect は build の後に呼ばれ、書き換えを外すとこのテストが落ちる
- [TV-4] イメージの VOLUME を読めないときは起動を失敗にする
  - 入力：偽の docker の image inspect が exit 1 を返す状態で start を呼ぶ
  - 期待結果：compose up が一度も呼ばれず、ok: false で、inspect の出力を含む services.failed の文が返る
- [TV-5] 持ち主の終わったネットワーク・ボリュームを消す
  - 入力：network ls・volume ls が、環境の印が自分と同じで、持ち主が終わった PID のもの・PID が再利用されたもの（開始時刻が違う）を1つずつ返し、table はどれも動いていない
  - 期待結果：その全部に network rm・volume rm が呼ばれ、cleanupAll のネットワーク・ボリュームの回収を外すとこのテストが落ちる
- [TV-6] 持ち主が動いているものは消さない
  - 入力：network ls・volume ls が、環境の印が自分と同じで、table で PID と開始時刻の両方が一致する持ち主のものを返す
  - 期待結果：network rm・volume rm が一度も呼ばれない
- [TV-7] 持ち主を確かめられないときは、ネットワーク・ボリュームを消さない
  - 入力：(a) table が空、(b) network ls・volume ls が exit 1 か期限切れ、(c) ラベルの値が `abc` のように読めない、(d) 環境の印が別の値か無い（持ち主の PID は table に無い）、(e) 自分の環境の印が読めない、をそれぞれ与える
  - 期待結果：どの場合も該当の種類の rm が呼ばれず、(b) では一覧を読めなかったことが console.warn に出る
- [TV-8] 環境の印が自分と違うか無いプロジェクトは down しない
  - 入力：compose ls が3つの sacty-svc- のプロジェクトを返し、docker ps が、(1) 環境の印が自分と同じで持ち主が終わったもの、(2) 環境の印が別の値で持ち主の PID が table に無いもの、(3) io.sacty.owner だけで環境の印の無いもの、のラベルを返す
  - 期待結果：down は (1) にだけ呼ばれ、(2)・(3) には呼ばれず、down の判断から環境の印を外すとこのテストが落ちる
- [TV-9] プロセスの表は、ネットワーク・ボリュームの一覧を読んだ後に読む
  - 入力：偽の docker と偽の table が呼ばれた順を記録し、table は network ls・volume ls の両方が返る前に呼ばれると空を返すようにして、持ち主の終わったネットワーク・ボリュームで cleanupAll を呼ぶ
  - 期待結果：table の呼び出しが network ls・volume ls より後で、rm が呼ばれ、一覧より前に table を読む順に戻すとこのテストが落ちる
- [TV-10] 持ち主か環境の印を確かめられないときは、ネットワーク・ボリュームを作らずに起動を失敗にする
  - 入力：(a) deps.owner を渡さず table の自分の行が無い、(b) 環境の印が読めない、の状態で、startGroup と start をそれぞれ呼ぶ
  - 期待結果：network create と compose up が一度も呼ばれず、どれも ok: false で、詳細に「起動したデーモンを確かめられません」を含む services.failed の文が返る
- [TV-11] ラベルの無いものと名前だけ似たものは消さない
  - 入力：偽の docker が、`--filter label=io.sacty.owner` の無い一覧の呼び出しには `sacty-svc-x-network` とラベルの無いボリュームを返す
  - 期待結果：network ls・volume ls の引数に `--filter label=io.sacty.owner` があり、ラベルの無い `sacty-svc-x-network` とボリュームに rm が呼ばれない
- [TV-12] 消せなかったものをログに出して続ける
  - 入力：終わった持ち主のネットワーク2つとボリューム1つのうち、最初のネットワークの rm が exit 1、次が期限切れ（dockerTimeoutMs を小さくする）になる
  - 期待結果：console.warn に `ネットワークの回収に失敗しました: <名前> (exit, code=1)` と `(timeout, code=なし)` が出て、残りのボリュームの rm も呼ばれ、cleanupAll は reject せずに終わる
- [TV-13] compose ls・down が返らないときに期限で打ち切り、ネットワーク・ボリュームの回収に進む
  - 入力：compose ls が返らない場合と、compose ls が終わったプロジェクトを返して down が返らない場合を、期限を小さくして与える
  - 期待結果：どちらも期限で子プロセスが止まって console.warn に timeout が出て、その後に network ls・volume ls が呼ばれる
- [TV-14] 実際の docker で、止めずに終わらせたデーモンの残りが起動し直すと消える
  - 入力：docker のあるホストで、複数の compose と、名前付きボリューム・compose に書いた匿名ボリューム・イメージの VOLUME を持つイメージ（例：postgres）を使う工程の実行中にデーモンを SIGKILL で終わらせ、コンテナを docker rm -f で消してから sacty up で起動し直す
  - 期待結果：起動し直した後の docker network ls・docker volume ls に、その実行の共通のネットワークとすべてのボリュームが無く、その手順と実際の結果（コマンドの出力）が作業履歴に書かれている
- [TV-15] 仕様（日英）に印と回収の振る舞いが書かれている
  - 入力：docs/spec/services.md と services.en.md の「起動と停止」
  - 期待結果：日英とも、io.sacty.owner と io.sacty.owner-env をサービス・名前付きボリューム（書き換えた匿名のボリュームとイメージの VOLUME を含む）・sacty が作るネットワークに付けること、印を確かめられなければ起動を失敗にすること、起動時に環境の印が同じで持ち主の終わったプロジェクト・ネットワーク・ボリュームを消すこと、印の無いもの・ほかの環境のもの・持ち主が動いているもの・ps や一覧を読めないときは消さないこと、各呼び出しの期限と失敗のログが書かれ、英語の版のコードの参照が `Code:` で始まる
- [TV-16] ADR に、印の無い古いものとほかの環境のものを残す決定と理由が書かれている
  - 入力：新しく足した docs/adr/ の ADR
  - 期待結果：持ち主と環境の印をネットワーク・ボリューム・コンテナに付けて起動時に回収する決定、環境の印の作り方（Linux の boot_id と PID 名前空間、macOS の kern.bootsessionuuid）、印の無いものは名前では sacty のものと見分けられないので残し、ほかの環境のものは ps で持ち主を確かめられないので down でも消さない理由、PBI-78 の ADR の「ラベルの無いものは止める」を置き換えることが日本語で書かれ、PBI-78 の ADR の本文は変わっていない
