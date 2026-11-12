# sacty コマンドをどのディレクトリでも使えるように、npm run cli:install を足す

- 日付: 2026-11-10（UTC）
- タスク: なし
- PR: #334
- ブランチ: ccr-805f354d-tec1x2
- 関係する ADR: [sacty コマンドを npm link で入れる npm run cli:install を足し、入れた後にリンクの向き先と版を確かめる](../adr/20261110-0908-superseded-cli-install-with-npm-link.md)

## 目的

`npx sacty` はリポジトリの中でしか使えないので、`npm run build && npm link` を1つのコマンドで実行できるようにし、どのディレクトリでも `sacty` を使えるようにする。
版を上げるたびに実行しても、確かに新しい版に切り替わるようにする。

## したこと

- `package.json`：`cli:install`（`npm run build && node scripts/cli-install.mjs`）。名前は、npm が `npm install`・`npm ci` のたびに自動で実行する `install` を避けた。
- `scripts/cli-install.mjs`：`packages/cli` で `npm link` を実行し、グローバルの bin の `sacty` の向き先・`sacty --version` の版・`PATH` で最初に見つかる `sacty` を確かめる（`checkLink`・`findOnPath`）。
- `packages/cli/src/index.ts`：`sacty --version`。
- テスト：`tests/scripts/cli-install.test.ts`。
- ドキュメント：仕様書（`docs/spec/architecture.md` のパッケージ）とユーザードキュメント（`docs/user/getting-started.md`・`docs/user/cli.md`）を日英で直した。ADR を足した。

## 確かめたこと

- npm のグローバルの場所を作業用のディレクトリに向けて（`npm_config_prefix`。この環境のグローバルの設定は変えずに）、`node scripts/cli-install.mjs` を次の場合で実行した。
  - `PATH` に無いとき：入れて、`PATH` に無いことを注意に出し、終了コード 0。
  - `PATH` にあるとき：入れて、注意なしで終了コード 0。
  - `PATH` で先に別の `sacty`（版 0.0.1 を出すもの）が見つかるとき：最初は、先に見つかったものの版を確かめて「npm run build を確かめて」で止まった。版の確かめを、今リンクしたグローバルの bin に対して行うように直し、別の `sacty` が先にあることを注意に出して、終了コード 0 になった。
  - 前の版（1.20.0）の別の場所の clone から `npm link` してあったとき：このリポジトリで実行すると、リンクの向き先がこのリポジトリに置き換わり、`sacty --version` が 1.21.0 を出した。
- `npm link` の後、作業ツリー（`git status`）に変更が無いことを確かめた。リポジトリの外のディレクトリから、リンクした `sacty --help` と `sacty launch` が動いた（`sacty launch` はデーモンを探すところまで進んだ）。
- `node packages/cli/bin/sacty.js --version`：`1.21.0`。
- `npm run lint`・`npm run typecheck`：成功。
- `npx vitest run tests/scripts`（4 件）・`npx vitest run tests/docs`（93 件）：成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- macOS（sacty の対象の OS）での `npm run cli:install` の確認（この環境は Linux）。
