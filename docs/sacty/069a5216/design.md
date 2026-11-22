<!-- sacty task 069a5216-8812-48cc-992c-faf7a811cf30 の設計。sacty が作成しました。 -->

# PBI-488 共用の compose のリポジトリへのひもづけ 設計

## スコープ

共用の compose に、使うリポジトリをひもづけられるようにする。
ひもづいたリポジトリのタスクでは、オーケストレーターに原則それを使わせる。
あわせて、対象のリポジトリの compose と共用の compose を、1つの工程で一緒に起動できるようにする（Q-1 を推奨の答えで進める場合）。

- 対象
  - 設定の型と検査・保存・エクスポート・インポート・画面の「共用の compose」に、「使うリポジトリ」の欄を足す
  - オーケストレーターと情報収集への指示で、共用の compose の候補をタスクの対象のリポジトリで絞り、ひもづいたものに印を付ける
  - 1つの工程で、対象のリポジトリの compose 1つと共用の compose 複数を起動し、担当のコンテナをすべてのネットワークにつなぐ
  - 実機（docker）で選択・取得・起動・接続を確かめ、見つかった失敗を直す
  - 仕様書・ユーザー文書（日英）、ADR、作業履歴
- 対象外
  - 担当への案内の文言（PBI-486）
  - サービスを起動する工程を増やすこと（`investigate`・`reproduce`・`implement` のまま。PR のレビューなどでは起動しない）
  - ひもづいた共用の compose を自動で起動すること（選ぶのはオーケストレーターのまま。使わないときは理由を書かせる）

## 確認したいこと

- Q-1（must）：1つの工程で、対象のリポジトリの compose と共用の compose を両方使えるようにするか。
  - 推奨：使えるようにする。
    対象のリポジトリに自分の compose があると、「どちらか一方」という指示のために共用のものが選ばれない。
    これが報告された不具合の有力な原因で、ひもづけて「原則使う」と伝えても、この制約が残る限り選べない。
  - 懸念：推奨で進めた後に要らないと分かると、ネットワーク・転送・記録の型・答えの形を複数に広げた実装（この PBI の大半）が無駄になる。
- Q-2（should）：ひもづけ先を、プロジェクトの対象（リポジトリの対象と、Org の対象の下のリポジトリ）に限るか。
  - 推奨：限る。
    保存のときに、対象に無いリポジトリを誤りにする。
    打ち間違えたひもづけはどのタスクの候補にも出ず、報告と同じ「機能しない」状態を黙って作るため。
  - 懸念：対象から外したリポジトリがひもづけに残った定義は、ひもづけを直すまで保存もインポートもできない。
- Q-3（should）：実機の確認（受け入れ条件5）を、誰がどの環境でするか。
  - 推奨：sacty の実装の工程のコンテナには docker が無い。
    実装の工程が作業履歴に手順と期待する結果を書き、マージの前に人が docker のある環境で通す。
    画面の録画もそのときに撮る。
  - 懸念：実装の工程が実機で確かめる前提にすると、確認が済まないまま PR が出る。
    今の版の失敗（取得・起動・接続のどれか）を直し漏らす。

確認しないと決めたこと

- エクスポートの版：5 のまま上げない。
  PBI-52（`tickets`）と PBI-70（`sharedComposes`）も、任意の項目を版を上げずに足した前例があるため。
  ひもづけない定義の書き出しは今と同じなので、古い sacty も読める。
- ほかのリポジトリにだけひもづいた共用の compose：オーケストレーターにも情報収集にも出さない。
  ひもづけは「どのリポジトリで使うか」を決めるもので、ほかのリポジトリでも使うなら、ひもづけ先を足すかひもづけを外せばよいため。
- 情報収集（`gatherServiceLines`）：オーケストレーターと同じ規則で絞る。
  対象のリポジトリが決まっていない triage では全件を出し、ひもづけ先を添える。
  受け入れ条件3の候補の規則を、情報収集にもそのまま当てはめるだけなので聞かない。
- 「設定ファイル」：プロジェクトのエクスポート・インポートの JSON とする。
  プロジェクトの定義は sacty の設定ファイル（`docs/spec/configuration.md`）に書かないため。

## 既定で決めたこと

- 項目の名前は `forRepos`（GitHub のリポジトリの URL の配列。1〜50件、省略可）にする。既存の `repo`（取得元）と区別するため。
- 画面の欄は「使うリポジトリ」のテキストエリア（1行に1つの URL）にする。空なら項目を書かない。
- 担当のコンテナは、`docker run` に `--network` を compose の数だけ並べてつなぐ（Docker Engine 25 以降の書き方）。
- 選んだ compose の間でサービス名がぶつかったら、起動せずに `services.nameConflict` で工程を止める。どちらに名前解決されるか決まらないため。

## 構成

| 所 | 変えること |
| --- | --- |
| `packages/core/src/projects.ts` | `SharedCompose.forRepos`（`RepoUrl` の配列）を足す。検査で、重複（`project.sharedComposeForRepoDuplicated`）と対象に無いリポジトリ（`project.sharedComposeForRepoNotTarget`。照合は `sameGitHubUrl`）を誤りにする。エクスポートと併合に含める |
| `apps/web/src/components/project-editor.tsx`・`apps/web/src/i18n/messages/projects.ts` | 行ごとの「使うリポジトリ」の欄と文言（`docs/spec/ui-wording.md` に従う） |
| `apps/daemon/src/prompts.ts`（`buildOrchestratorPrompt`） | 候補を「ひもづけていないもの」と「このリポジトリにひもづいたもの」に絞る。ひもづいたものには「このリポジトリのテスト・動作確認には原則これを使う。使わないなら servicesReason に理由を書く」と添える。「どちらか一方」の文を外し、答えの形を `services: {file?, compose: [名前…], names, steps}` にする（`compose` が文字列の答えも読む） |
| 同（`gatherServiceLines`） | 同じ規則で絞る。triage では全件を出し、ひもづけ先を添える |
| `apps/daemon/src/service.ts`・`services.ts` | `withSharedCompose`・`startServices`・`stopServices`・`serviceConnection` を compose の一覧に対応させる。`ExecuteRun.network` を配列にする。転送のぶつかりは、全 compose のサービスを合わせて判定する |
| `apps/daemon/src/agents/docker.ts` | ネットワークの配列を `--network` に並べる |
| `packages/core/src/events.ts` | `StepsChosen.services` に、2つ目からの compose を `more`（任意）として足す。1つだけのときの記録は今と同じ形。`ServicesStarted` は compose ごとに1件記録する |
| `packages/core/src/projection.ts`・`apps/web/src/lib/labels.ts` | 同じ実行の `ServicesStarted` をまとめて読み、表示する |
| `docs/spec/services.md`・`export.md`・`docs/user/compose.md`・`project-settings.md`（各日英） | ひもづけの項目・候補の規則・両方の起動・ネットワーク |
| ADR・作業履歴 | 新しい ADR を足す（既存の ADR は「どちらか一方」を決めていないので置き換えない）。作業履歴に実機の確認の結果を書く |

## エラー時の振る舞い

- 保存・インポート：`forRepos` の形の誤り（`input.sharedComposeForRepo`）・重複・対象に無いリポジトリは誤りにし、保存しない。
- 工程：選んだ compose のどれかの取得・起動に失敗したら、起動済みのものも止めてから、今の失敗のコードで工程を止める。

## 影響範囲

- `more` を記録した作業履歴を前の版のデーモンで読むと、2つ目からの compose は無いものとして読まれる（`z.object` が知らない項目を捨てる）。
  デーモンは起動できる。
- `forRepos` を書いた定義のエクスポートは、前の版の sacty ではインポートできない（`input.unknownKeys`）。
- 画面を変えるので、マージの前に実機で確かめて録画を残し、`npm run docs:screenshots` でスクリーンショットを撮り直す。

## テスト観点

- [TV-1] ひもづけの保存と書き出し
  - 入力：対象に repo A があるプロジェクトで、共用の compose に forRepos [A] を付けて API で保存し、エクスポートする
  - 期待結果：保存が通り、取得した定義とエクスポートの JSON の sharedComposes に forRepos [A] が入り、それをインポートすると同じ定義になる。
- [TV-2] ひもづけの省略
  - 入力：forRepos の無い共用の compose を保存し、エクスポートする。forRepos の無い版 5 のファイルをインポートする
  - 期待結果：どちらも通り、エクスポートの JSON に forRepos の項目が無い。
- [TV-3] ひもづけ先の書き方の検査
  - 入力：forRepos に GitHub のリポジトリの URL でない値・空の配列・51件を入れて保存する
  - 期待結果：どれも input.sharedComposeForRepo などの誤りで保存されない。
- [TV-4] ひもづけ先の重複と対象外の検査
  - 入力：forRepos に大文字小文字だけ違う同じ URL を2つ入れる場合と、プロジェクトの対象に無いリポジトリを入れる場合で、保存とインポートをする
  - 期待結果：それぞれ project.sharedComposeForRepoDuplicated・project.sharedComposeForRepoNotTarget で保存されず、Org の対象の下のリポジトリは通る。
- [TV-5] 画面のひもづけの欄
  - 入力：プロジェクトの編集の画面で、共用の compose の「使うリポジトリ」に2行の URL を入れて保存し、開き直す
  - 期待結果：2つの URL が保存され、開き直すと同じ2行が表示され、欄を空にして保存すると forRepos が無くなる。
- [TV-6] ひもづいた共用の compose の指示
  - 入力：対象のリポジトリ A のタスクで、A にひもづいた共用の compose X があるときのオーケストレーターへの指示を作る
  - 期待結果：X の行に、このリポジトリのテスト・動作確認には原則使うことと、使わないなら servicesReason に理由を書くことが書かれている。
- [TV-7] 候補の絞り込み
  - 入力：対象のリポジトリ A のタスクで、ひもづけていない Y と、B にだけひもづいた Z があるときの、オーケストレーターと情報収集への指示を作る
  - 期待結果：Y は今までどおり説明つきで候補に出て原則使う文が無く、Z はどちらの指示にも出ず、StepsChosen の sharedComposes にも入らない。
- [TV-8] triage の情報収集
  - 入力：対象のリポジトリが決まっていない triage のタスクで、B にひもづいた Z があるときの情報収集の指示を作る
  - 期待結果：Z が候補に出て、ひもづけ先 B が添えられている。
- [TV-9] 両方の compose の選択の読み取り
  - 入力：オーケストレーターの答えの services に file と compose [X, W] を書く。別に compose を文字列 X で書く
  - 期待結果：前者は対象のリポジトリの compose と X・W を選んだ記録になり、後者は X だけを選んだ記録（今と同じ形）になる。
- [TV-10] 両方の compose の起動と接続
  - 入力：対象のリポジトリの compose と共用の compose X を選んだ implement の工程を、偽の services と実行の仕組みで動かす
  - 期待結果：2つの compose が起動され、ServicesStarted が2件記録され、担当のコンテナの docker run に --network が2つ並び、工程の後に2つとも止まり X の取得のディレクトリが消える。
- [TV-11] サービス名のぶつかり
  - 入力：対象のリポジトリの compose と共用の compose X の両方に db というサービスがあり、両方を選んだ工程を動かす
  - 期待結果：どちらも起動せずに services.nameConflict で工程が止まる。
- [TV-12] 一部の起動の失敗
  - 入力：対象のリポジトリの compose は起動でき、共用の compose X の取得が失敗する工程を動かす
  - 期待結果：起動済みの compose が止められ、services.sharedFetchFailed で工程が止まる。
- [TV-13] 実機での一通りの確認
  - 入力：docker のある環境で、対象のリポジトリにひもづいた共用の compose（redis など）を設定したタスクを実行する
  - 期待結果：オーケストレーターが選び、取得・起動され、担当のコンテナからサービス名で接続でき、結果と見つかった失敗の修正が作業履歴に書かれている。
- [TV-14] 文書の記述
  - 入力：docs/spec/services.md・export.md・docs/user/compose.md・project-settings.md の日英と ADR の差分を読む
  - 期待結果：forRepos の書き方と検査、ひもづけと候補の規則、両方の compose の起動とネットワーク、前の版との互換が日英で同じ内容で書かれている。
