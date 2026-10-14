# ゲートウェイのトークンの取得で、キーをクエリのパラメーターで送る PF に対応する

- 日付: 2026-10-14（UTC）
- タスク: PBI-93
- PR: #101
- ブランチ: feat/issue-93-token-query
- 関係する ADR: なし

## 目的

`GET /auth/token?api_token=<キー>` のように、キーを URL のクエリで送ってトークン（JWT）を受け取る PF を、`gateway.platforms`
とコンテキストの `platforms.yaml` に書いて使えるようにする。これまでの `auth.token` は `{{secret}}` をヘッダー・JSON・フォームに
しか入れられなかった。キーの入った URL は、ログ・作業履歴・画面・エラーの文・エージェントへの応答のどこにも出さない。

## したこと

- `apps/daemon/src/platforms.ts`
  - `TokenRequest` に `query`（`名前: 値`。値の `{{secret}}` をキーにする）を足した。
  - 検査を足した：`query` の名前が空・値が文字列でない（`config.platformTokenQuery`）、`url` に `{{secret}}` を書いた
    （`config.platformTokenUrlSecret`。`query` に書くよう案内する）、`method` が `GET`・`HEAD` なのに `json`・`form` を書いた
    （`config.platformTokenBody`。送るたびに失敗する書き方なので、読み込みのときに弾く）。`url` が http・https の検査は保った。
    文言は `packages/core/src/messages.ts` に日本語・英語で足した。
  - `tokenUrl`：`query` を URL エンコードして、`url` に元からあるクエリの後ろに足す（元のクエリは書き換えない。`#` 以降は
    送らない）。エンコードは `encodeURIComponent` に加えて `!'()*` も変える（URL の組み立てで `'` が `%27` に変わるなど、
    送る形と伏せる形が食い違わないようにするため）。`query` が無い・空なら `url` をそのまま使う（今の設定の動作は変わらない）。
  - `hideSecret`：伏せる形に、URL エンコードした形（上のエンコード・`encodeURIComponent`・16進の小文字・フォームの形）を足した。
    トークンの取得の失敗の理由は、これまでどおり伏せてから切り詰める。`hideSecret` はほかの所（ホストの MCP・通知・
    チケット）でも使うので、URL エンコードできない値（対になっていないサロゲート。`encodeURIComponent` が例外を投げる）でも
    失敗しないようにした（DA の検証で見つけた）。
- 仕様書 `docs/spec/gateway.md`（検査・URL の組み立て・伏せる形）、ユーザードキュメント `docs/user/gateway.md`（例・項目の表・
  キーを出さないこと）を直した。

## 確かめたこと

- テストを足した。
  - `apps/daemon/src/platforms.test.ts`：設定の検査（日本語・英語の文。POST ならクエリと本文を一緒に書ける）、
    `config.yaml` の `gateway.platforms` で読めること・誤りの項目の場所、GET でエンコードしたクエリで送り本文と `content-type` を
    付けないこと（送った URL を読み直すと元のキーに戻る）、期限・取り直し・捨てて取り直し、元からあるクエリとの組み合わせ・`#`・
    `?` だけの URL・クエリが無いとき、送信の失敗の文に URL が入る場合・窓口のエラーの本文に URL を写す場合（大文字・小文字の16進・
    フォームの形）と切り詰めの境界（0・560・580・595 文字の前置き）でキーを出さないこと。
  - `apps/daemon/src/gateway.test.ts`：クエリで送る窓口の PF をゲートウェイ経由で呼び、401 で取り直して送り直す。PF への転送の
    URL にキーを付けない。取り直しの送信の失敗（文に URL が入る）でも、エージェントへの 502 の応答にキーを出さない。
  - `apps/daemon/src/context.test.ts`：コンテキストの `platforms.yaml` で `query` を読めること、3つの誤りを層と項目の場所付きで弾くこと。
- 修正を戻すと落ちること：送る URL を `spec.url` に戻す（3件落ちる）、厳しいエンコードを `encodeURIComponent` に戻す（3件）、
  `hideSecret` に足した4つの形を1つずつ外す（それぞれ1件）・まとめて外す（2件）、GET の本文の検査・`url` の `{{secret}}` の
  検査を外す（それぞれ2件）。
- 本物の Node の fetch（ビルドした `dist`）で、閉じたポートと引けないホストの窓口に送ると、理由は `fetch failed` だけで、URL・キーは
  出なかった（`cause` は伝えない）。
- `npm run lint`（終了コード0）・`npm run typecheck`・`npx vitest run`（53ファイル・1244件が通過）・`npm run build`・
  `npx vitest run tests/docs`（66件が通過）。
- 画面の変更は無い（設定と、画面に出す理由の文の中身だけ）ので、動作確認の動画は撮っていない。

## わからないこと・確かめていないこと

- 本物のクエリで送る PF の窓口には繋いでいない（偽の窓口で確かめた）。
- 窓口がリダイレクトを返したときに、リダイレクト先の URL にキーが入る場合（窓口が決めること）。トークンの取得のリダイレクトの扱いは、
  これまでと同じ（fetch の既定でたどる）。
