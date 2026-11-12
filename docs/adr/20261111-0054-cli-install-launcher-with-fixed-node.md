# sacty コマンドを、Node.js の版に関係しない場所の起動の入口で入れ、入れたときの Node.js で動かす

- 日時: 2026-11-11 00:54 UTC
- ステータス: 採用
- 関係する PR・タスク: #338
- 置き換え元: [sacty コマンドを npm link で入れる npm run cli:install を足し、入れた後にリンクの向き先と版を確かめる](20261110-0908-superseded-cli-install-with-npm-link.md)
- 置き換え先: なし

## 背景

`npm run cli:install` は、`packages/cli` を `npm link` して、`sacty` コマンドを npm のグローバルの bin に入れていた。
mise などで Node.js を管理していると、npm のグローバルの場所は Node.js の版ごとに分かれる（例 `~/.local/share/mise/installs/node/26.12.1`）。
そのため、Node.js の版が違うディレクトリ（対象リポジトリで別の版を指定しているなど）では、次のことが起きると利用者から報告があった。
- その版の bin しか `PATH` に入らず、`sacty` が見つからない。
- 見つかっても、`sacty` の入口（`#!/usr/bin/env node`）が、そのディレクトリの Node.js（sacty が求める 26.12.1 より古いことがある）で動く。

## 決定

- `npm run cli:install` は、`npm link` をやめ、Node.js の版に関係しない場所（`SACTY_BIN_DIR`、無ければ `~/.local/bin`）に、`sacty` の起動の入口（シェルのスクリプト）を置く。
- 入口には、`cli:install` を動かした Node.js（`process.execPath`。sacty のリポジトリで mise などが選んだ版）の絶対パスと、このリポジトリの `packages/cli/bin/sacty.js` を書き、その Node.js で動かす。`PATH` の `node` は使わない。
- `PATH` に `mise` があり、`SACTY_BIN_DIR` を指定していなければ、入口を版ごとのディレクトリ（`~/.local/share/sacty/mise/<版>/bin/sacty`）に置き、`mise link sacty@<版>` と `mise use --global sacty@<版>` で mise に登録する（依頼者の求め）。
  同じ版が既に登録されていれば、登録先がそのディレクトリのときだけ `--force` で置き換え、ほかの場所の登録は上書きしない（PR #338 のレビュー）。
  登録に失敗したら、理由を知らせて `~/.local/bin` などに置く。mise で入れたら、前に `~/.local/bin` などに置いた入口を消す。
  mise で入れたときは、`mise which sacty` で mise が選ぶ sacty が入口かを、`PATH` で最初に見つかる sacty が入口か mise のシムかを確かめる（PR #338 のレビュー）。
- 入口の Node.js か `sacty.js` が無くなったら、入口は `npm run cli:install` のやり直しを知らせて止まる。
- 置き場所に、sacty の入口の目印の無いファイルがあれば上書きしない。
- 前のやり方で、いまの Node.js のグローバルに入れたこのリポジトリの `@sacty/cli` があれば外す。
- 置いた後に、入口の `sacty --version` がこのリポジトリの版を出すことを確かめる。`PATH` で先に別の `sacty` が見つかる・置き場所が `PATH` に無いときは、注意を出す（前と同じ）。

## 理由

- Node.js の絶対パスを書くのは、sacty が求める Node.js の版（`mise.toml`・`engines`）で必ず動かすため。sacty は、動いている Node.js（`process.execPath`）でデーモンと画面も起動するので、入口の Node.js がすべての子プロセスの版になる。
- 置き場所を `~/.local/bin` にしたのは、Node.js の版に関係せず、多くの環境で `PATH` に入っているため（mise も既定でここに入る）。変えたい人のために `SACTY_BIN_DIR` を設けた。
- 比べた案と採らなかった理由：
  - 入口で `mise exec` を使う。mise を使わない人で動かず、作業するディレクトリ（`sacty launch` の `--cwd` の既定）を変えずに、sacty のリポジトリの版を選ばせる方法が無い。
  - `npm link` のまま、使う Node.js の版ごとに入れる。版を足すたびに入れ直しが要り、古い Node.js で動く問題が残る。
- mise で入れるのは、mise を使う利用者が、ほかの道具と同じく mise で sacty を管理できるようにするため（依頼者の求め）。
  登録するものは同じ入口にして、Node.js の版の問題は入口が受け持つ。mise は、どのディレクトリでも `sacty` を `PATH` に載せることを受け持つ。
  mise が選ぶ Node.js で動かす（入口を使わない）と、ディレクトリごとの Node.js の版で動く問題が残るので採らなかった。
  版ごとのディレクトリにしたのは、`mise ls sacty` で版が分かり、版を上げたら新しい版を登録して切り替えられるため。
- 更新で Node.js の版が変わったときに `cli:install` のやり直しが要るのは、入口に版を固定して書くため。古い版を消した後は、入口がやり直しを知らせる。消していなければ古い版で動き続けるので、更新の手順（ユーザードキュメントと、画面の更新の知らせ）で `npm run build` の代わりに `npm run cli:install` を実行するよう案内する（画面の知らせは PR #338 のレビュー）。
- 前のやり方のリンクを外すのは、mise では Node.js の bin が `PATH` の前の方に入るため、残すと新しい入口より先に見つかり、前の問題が残るため。いまの Node.js の版のものしか外せないので、ほかの版のものは文書で案内する。

## 影響

- `npm run cli:install` で入れた `sacty` を消すには、置き場所の `sacty` を消す（`npm uninstall -g` ではなくなる）。
- Windows では使えない（シェルのスクリプトのため）。
- mise で入れる処理は、この ADR を書いたときの環境に mise を入れられず、偽の `mise`（受けた引数を記録し、`link`・`use`・`which` をまねるもの）で確かめた。レジストリに無い名前（`sacty`）で `mise link` できるか、そうして登録した道具が mise のシム・`mise activate` で `PATH` に載るかは、実際の mise では確かめていない。登録に失敗したときは `~/.local/bin` などに置くので、入れられないことは無い。
- 前の版の mise の登録（`sacty@<前の版>`）と、そのディレクトリは消さずに残る。
- 仕様は [アーキテクチャ](../spec/architecture.md#パッケージ)、利用者向けは [はじめに](../user/getting-started.md#どのディレクトリでも-sacty-を使う) に書く。
