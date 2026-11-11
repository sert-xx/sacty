# mise などで Node.js の版がディレクトリごとに違っても sacty を使えるように、cli:install を起動の入口を置くやり方にする

- 日付: 2026-11-11（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-805f354d-tec1x2
- 関係する ADR: [sacty コマンドを、Node.js の版に関係しない場所の起動の入口で入れ、入れたときの Node.js で動かす](../adr/20261111-0054-cli-install-launcher-with-fixed-node.md)

## 目的

依頼者から、mise で Node.js を管理していると、`npm run cli:install`（`npm link`）で入れた `sacty` を、Node.js の版が違うディレクトリで使えないと報告があった。
原因は、npm のグローバルの場所が Node.js の版ごとに分かれ、入れた `sacty` がその版の bin にしか無いこと、見つかってもそのディレクトリの Node.js で動くこと。
どのディレクトリでも、sacty が求める Node.js で動くようにする。版を上げたときに切り替わることも保つ。

## したこと

- `scripts/cli-install.mjs`：`npm link` をやめ、`SACTY_BIN_DIR`（無ければ `~/.local/bin`）に、`cli:install` を動かした Node.js の絶対パスで `packages/cli/bin/sacty.js` を動かす入口を置くようにした（`launcherScript`・`launcherDir`・`checkPath`）。入口の Node.js・`sacty.js` が無いときのやり直しの案内、sacty のものでないファイルを上書きしない確かめ、前のやり方のリンク（いまの Node.js のもの）を外す処理を足した。`globalPrefix`・`findOnPath` は残した。
- `tests/scripts/cli-install.test.ts`：入口を実際に `sh` で動かし、`PATH` の先頭の別の `node` を使わずに、書いた Node.js へ引数をそのまま渡すこと（パスの空白・引用符・`$` を含めて）、Node.js が無いときに知らせて失敗することを確かめるテストに書き直した。
- ドキュメント：仕様書（`docs/spec/architecture.md` のパッケージ）とユーザードキュメント（`docs/user/getting-started.md`・`docs/user/cli.md`）を日英で直した。`cli.md` には、PR #334 のレビューの提案（`--help`・`--version` はどのコマンドの後ろでも効き、`sacty launch` の `--` の後ろのものは AI の CLI に渡る）を、次にコードを直すときに入れると返していたので、あわせて書いた。
- ADR：前の ADR（`npm link`）を置き換える ADR を足し、前の ADR の名前を `superseded` に変えて、切れたリンク（作業履歴の 2 つ）を直した。

## 確かめたこと

- 作業用の場所（`SACTY_BIN_DIR`・`npm_config_global_prefix` を作業用のディレクトリに向けて。この環境のグローバルの設定は変えずに）で、`node scripts/cli-install.mjs` を動かした。
  - 前のやり方の `npm link` が残っている状態から実行すると、そのリンクを外し、入口を置いて終了コード 0。
  - `PATH` の先頭に、呼ばれたら失敗する偽の `node`（古い版の代わり）を置いたディレクトリで `sacty --version` を実行すると、偽の `node` は使われず、`1.22.1` を出した。
  - 入口の Node.js を無いパスにすると、やり直しを知らせて終了コード 1。
  - もう一度実行すると、入口を書き直して終了コード 0。
  - 置き場所に sacty のものでない `sacty` があると、上書きせずに終了コード 1（ファイルは変わらない）。
  - リポジトリのパスに空白・二重引用符・`$HOME` を含む clone で実行しても、入口が動き、`1.22.1` を出した。
- 足したテストは、入口を `PATH` の `node` で動かすように戻すと失敗することを確かめた。
- `npm run lint`・`npm run typecheck`：成功。`npx vitest run tests/scripts tests/docs packages/cli`：121 件すべて成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- mise を使う macOS での確認（この環境は Linux で、mise は入っていない。版の違う Node.js は、偽の `node` で代わりにした）。
