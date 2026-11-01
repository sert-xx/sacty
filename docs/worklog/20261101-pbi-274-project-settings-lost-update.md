# プロジェクトの設定を同時に保存すると、先の変更が消える問題を直す

- 日付: 2026-11-01（UTC）
- タスク: PBI-274
- PR: #269
- ブランチ: feat/issue-274-settings-lost-update
- 関係する ADR: [プロジェクトの設定の保存は、読み込んだ版を照合し、変わっていれば上書きせずに知らせる](../adr/20261101-1347-project-save-version-check.md)

## 目的

実務での実証実験で、3人の担当が同じプロジェクトの対象リポジトリをほぼ同時に足したとき、先に保存した追加が、別の担当の保存で消えた。
設定の保存が、画面が読み込んだときの内容でまるごと上書きしていた（版の照合も差分の適用も無かった）。

受け入れ条件の要点：

- 読み込んだ後にほかの保存で設定が変わっていたら、黙って上書きせず、利用者に分かる形で知らせる（方法は任せる）。
- 同時に保存しても、どちらかの変更が黙って消えない。テストで確かめる。
- UI の変更なので、PR に動作確認の動画を付ける。仕様書・ユーザードキュメント（日英）・作業履歴を直す。

## したこと

- 版は既存の `updatedAt` を使う（新しい列は足さない）。保存先（`SqliteProjectStore.put`）で、保存のたびに前の値より後の時刻にする（同じミリ秒の2回の保存・時計の巻き戻りでも変わる）。
- `PUT /api/projects/:id` は、読み込んだ `updatedAt` を `If-Match` で必須にした。無ければ 428。合わなければ 409（`project.changedElsewhere`）で、設定も版も変えない。照合と保存は同じ同期の処理（`TaskService.saveProject`）。作成・インポートは変えない。
- 画面：保存に読み込んだ版（`baseUpdatedAt`）を添える。自分が保存したら、返った版に進める。画面の取り直しで届いた版には進めない。409 のときは、理由と「再読み込みして最新の設定を見る」ボタンを出す（編集中の入力は再読み込みするまで残る）。
- 項目ごとの併合はしない（別の項目だけを変えた古い画面の保存も、拒否する）。
- 仕様書（`docs/spec/architecture.md`・`.en.md`）、ユーザードキュメント（`docs/user/project-settings.md`・`.en.md`「同時に変更したとき」）、ADR を足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/project-conflict.test.ts`（新規 10 件）：保存先の版が同じミリ秒・時計の巻き戻りでも変わる。古い版の保存は拒否され設定も版も変わらない。`Promise.all` の同時の `PUT` は 200 と 409 が1件ずつで、保存されるのは勝った側だけ。負けた側が読み込み直せば、先の変更を残して保存できる（3人が対象を足す場面：s1・s4・s5 が全部残る）。入力の誤りの 400 では版が進まない。別の項目だけの古い版も 409。`If-Match` が無ければ 428 で保存しない。作成は版が要らない。`service.ts` の照合を外すと 4 件が落ちる。
- `npx vitest run apps/web/src/app/actions.test.ts apps/web/src/lib/daemon-save-project.test.ts apps/web/src/components/project-editor-conflict.test.ts`：版を渡す・返す、`If-Match` を付ける、409 のコードで衝突だけを見分ける、画面が自分の保存で版を進め、取り直しでは進めず、衝突のとき再読み込みのボタンを出し、ほかの失敗では出さない。
- 既存の `PUT /api/projects/:id` を呼ぶテスト（`daemon.test.ts`）に `If-Match` を足して通した。
- `npx biome check .`・`npm run typecheck`・`npx vitest run tests/docs`：通る。
- 実際のアプリ（`npm run build` の後に `sacty up`。一時的な `SACTY_HOME`、ポート 4750・4760）で、2つのタブ・Playwright の2つの文脈で確かめた：古い画面の保存は理由と再読み込みのボタンが出て保存されず、再読み込みで最新の名前になり、そこから変えると保存できる。動画を撮った。終わったらアプリを止めた。
- `npx vitest run` 全体を1回：落ちたのは環境・負荷によるもの。`question-form.browser.test.ts`（Playwright のブラウザー）、`install-security-tools.test.ts`（`/usr/local/bin` に書けない）、`tests/desktop/migration.test.ts`・`daemon.test.ts` のオーケストレーターのセッションの 2 件（単独で再実行すると通る）、時間を測る `ci.test.ts`・`prompts.test.ts` の 2 件（マシンの負荷が高く、単独でも 1 秒を超えて落ちた。この変更とは関係しない）。

## 残した制限

- sacty の設定（`PUT /api/settings`）とスケジュールタスク（`PUT /api/schedules/:id`）には、同じ仕組みを入れていない。同じ型の上書きは残る。
- 衝突したときの編集中の入力は、再読み込みで失われる。併合や差分の表示はしない。

## レビューの指摘と対応

- DA（自己レビュー）：2つのタブ・自分で続けて保存・保存の失敗・別の項目だけの変更・同じミリ秒の保存・時計の巻き戻りを確かめ、指摘なし。
