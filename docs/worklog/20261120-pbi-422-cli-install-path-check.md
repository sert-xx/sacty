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
