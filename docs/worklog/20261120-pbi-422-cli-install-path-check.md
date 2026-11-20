# npm run cli:install の終わりの、PATH の確かめの誤った注意をなくす

- 日付: 2026-11-20（UTC）
- タスク: PBI-422
- PR: なし
- ブランチ: なし
- 関係する ADR: [sacty コマンドの入口を mise に登録するのをやめ、いつも ~/.local/bin などに置く](../adr/20261118-1322-cli-install-without-mise-registration.md)

## 目的

`npm run` が PATH の先頭に足す `node_modules/.bin/sacty` を「PATH で先に見つかる sacty」と判定し、誤った注意がいつも出ていた。

## したこと

- `scripts/cli-install.mjs`：`withoutNpmRunPath` を足し、`npm_lifecycle_event` があるときだけ、PATH の先頭の、リポジトリとその祖先の `node_modules/.bin`・`node-gyp-bin` を外した PATH で、`findOnPath`・`dirOnPath` を呼ぶ。
- `tests/scripts/cli-install.test.ts`：`npm run` の形の PATH で、注意が出ない・本当の重なりは注意が出る・置き場所が PATH に無いときの注意が出る、直接実行では外さない、を確かめる。
- 仕様書（`architecture`。日英）。利用者向けの文書の説明は、直しの後も正しいので変えない。

## 決めたこと

- 外すのは PATH の先頭から続く分だけにした（利用者が自分で PATH の途中に入れたものは残す）。
- リンクを含む `--prefix` で `npm run` すると、npm はリンクを解かない形で PATH に足す。外すディレクトリの集合は、repo の実パス由来のものも持ち、PATH の要素も実パスで比べる。
- 整形だけの変更は入れない（変えた箇所は、この直しに関係する行だけ）。

## 確かめたこと

- `npx vitest run tests/scripts/cli-install.test.ts tests/docs`：通った（結果は下の「検証」の記録のとおり、今回の実行で得たもの）。
- `npm run lint`・`npm run typecheck`・`npm test`（全件）：今回の最後の変更の後に実行した結果を、PR の説明に書いた。
- 実行していない：本物の `npm run cli:install`（`~/.local/bin` に入口を置く）。偽のリポジトリでの `main` の実行と、`withoutNpmRunPath` の単体テストで確かめた。

## 残したこと

- なし
