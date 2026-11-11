# npm のグローバルの場所に UUID があっても、npm run cli:install が誤って失敗しないようにする

- 日付: 2026-11-10（UTC）
- タスク: PBI-324
- PR: #336
- ブランチ: feat/issue-324-cli-install-uuid-prefix
- 関係する ADR: [sacty コマンドを npm link で入れる npm run cli:install を足し、入れた後にリンクの向き先と版を確かめる](../adr/20261110-0908-superseded-cli-install-with-npm-link.md)

## 目的

1.22.0 の版上げ（PR #335）で macOS の `npm run cli:install` を試したとき、npm のグローバルの場所を UUID を含む一時ディレクトリに向けると、リンクは正しくできているのに「このリポジトリを指していません（ありません）」で失敗した。これを直す。

## 原因

`scripts/cli-install.mjs` は、`npm prefix -g` の出力からグローバルの bin を求めていた。npm 11 は自分の出力の中の UUID の形の文字列を `***` に伏せるので、パスに UUID があると、実在しないパスを調べていた。
npm 11.19.1 で、`npm prefix -g`・`npm root -g`・`npm prefix -g --json` のどれも伏せられ、`npm run` がスクリプトに渡す環境変数 `npm_config_global_prefix` は伏せられないことを確かめた（`npm config get prefix` は「protected」で取れない）。

## したこと

- `globalPrefix` を足し、`npm_config_global_prefix` を先に使うようにした。環境変数が無い・空のとき（スクリプトを直接実行したとき）だけ、今までどおり `npm prefix -g` を使う。
- 回帰テストを `tests/scripts/cli-install.test.ts` に足した。
- 仕様書（`architecture` の日英）に、グローバルの場所の求め方を書いた。利用者の手順は変わらないので、ユーザードキュメントは直していない。

## 確かめたこと

- `npx vitest run tests/scripts/cli-install.test.ts`：6 件が通過。`globalPrefix` を `npm prefix -g` を先にする形に戻すと 1 件落ちることを確かめた。
- macOS（npm 11.19.1）で、npm のグローバルの場所（`npm_config_prefix`）を UUID を含む一時ディレクトリに向けて `npm run cli:install` を実行した（結果は PR の本文に書く。この Mac のグローバルの設定は変えていない）。
- `npm run lint`・`npm run typecheck`・`npx vitest run tests/docs`：通過。

## レビューの指摘と対応

- なし。

## 残したこと

- なし。
