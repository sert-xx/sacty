# mise などで Node.js の版がディレクトリごとに違っても sacty を使えるように、cli:install を起動の入口を置くやり方にする

- 日付: 2026-11-11（UTC）
- タスク: なし
- PR: #338
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
- 依頼者の求めで、mise があれば mise で入れるやり方を足した（`useMise`・`miseToolDir`・`installWithMise`・`checkMise`）。入口を版ごとのディレクトリに置き、`mise link --force sacty@<版>` と `mise use --global sacty@<版>` で登録する。登録に失敗したら `~/.local/bin` などに置き、mise で入れたら前に `~/.local/bin` などに置いた入口を消す。`mise use --global` で Node.js の版を固定する案も話に出たが、困っているのはプロジェクトの `mise.toml` で別の版を指定したディレクトリで、そこではグローバルの設定が効かないので採らなかった。
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
- mise のやり方は、この環境に mise を入れることが許可されず、mise の文書のサイト（mise.jdx.dev）もネットワークの設定で開けなかったので、偽の `mise`（引数を記録し、`link`・`use --global`・`which` をまねるもの）を `PATH` の先頭に置いて確かめた。
  - mise があるとき：`~/.local/share/sacty/mise/1.22.1/bin/sacty` に入口を置き、`mise link --force sacty@1.22.1 <ディレクトリ>`・`mise use --global sacty@1.22.1`・`mise which sacty` の順に呼び、前に `~/.local/bin` に置いた入口を消して、終了コード 0。
  - `mise link` が失敗するとき：理由を注意に出して、`~/.local/bin/sacty` に置き、終了コード 0。
  - `SACTY_BIN_DIR` を指定したとき：mise を呼ばずに、指定した場所に置いた。
- `npm run lint`・`npm run typecheck`：成功。`npx vitest run tests/scripts tests/docs packages/cli`：121 件すべて成功。
- レビューの対応の後、偽の `mise`（`where`・`link`（`--force` が無いと既存を拒む）・`use --global`・`which` とシムをまねるもの）で `node scripts/cli-install.mjs` を動かした。
  - 1回目：`where` → `link`（`--force` なし）→ `use --global` → `which` の順に呼び、終了コード 0。
  - 2回目（自分の登録の入れ直し）：`link --force` で置き換えた。
  - シェルの `PATH` に `sacty` が無いとき：`mise activate` かシムの設定を案内する注意を出した。
  - ほかの場所で同じ版が登録済みのとき：上書きせず（登録はほかの場所を指したまま）、`~/.local/bin/sacty` に置いた。
- 2回目のレビューの対応の後：npm のグローバルの場所を作業用の `~/.local` にして `npm link` し、`node scripts/cli-install.mjs` を動かすと、直す前は「sacty の入口でないファイル（またはリンク）があります」で終了コード 1。直した後は、前のリンクを外して `~/.local/bin/sacty` に入口を置き、終了コード 0。別のディレクトリから `sacty --version` が `1.22.1` を出した。ほかのリポジトリを指すリンクがあるときは、上書きせずに止まった。
- `npx vitest run tests/scripts`（14 件）・更新の知らせのテスト：成功。足したテストは、直す前のコードでは失敗することを確かめた。
- mise のやり方を足した後：`npx vitest run tests/scripts`（12 件）・`npx vitest run tests/docs`（93 件）：成功。`npm run lint`・`npm run typecheck`：成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| sacty のレビュー［要修正］：画面の更新の知らせの手順が `npm run build` のままで、`cli:install` で入れた人が更新しても入口の Node.js が古いまま | 知らせのコマンドの下に、`cli:install` で入れたなら `build` の代わりに `cli:install` を実行するよう1文を足した（`apps/web/src/components/shell/update-notice-view.tsx`・`apps/web/src/i18n/messages/shell.ts` の `cliInstall`。日本語は本文の上限の 60 文字に収めた）。テストを足し、仕様書（`daemon-lifecycle`）と ADR を直した |
| sacty のレビュー［要修正］：`mise link --force` が、同じ版がほかの方法で登録されていても、確かめずに置き換える | `mise where sacty@<版>` で登録を確かめ、登録先がこの入口のディレクトリのときだけ `--force` で置き換え、ほかの場所なら上書きせずに `~/.local/bin` に置くようにした（`installWithMise`）。登録が無ければ `--force` を付けない |
| sacty のレビュー［要修正］：mise で入れたとき、`mise which` だけを確かめ、シェルの `PATH` で実行できるかを確かめていない | `PATH` で最初に見つかる `sacty` が、入口か mise のシム（`mise` へのリンク）かも確かめ、見つからないときは `mise activate` かシムの設定を案内するようにした（`checkMise`） |
| sacty のレビュー［提案］：`XDG_DATA_HOME` を指定したときの消す場所が書かれていない | 日英の「はじめに」に `$XDG_DATA_HOME/sacty/mise` を書いた |
| sacty のレビュー［要修正］：npm のグローバルの場所が `~/.local` だと、前の `npm link` の `~/.local/bin/sacty` が入口の置き場所と重なり、「sacty のものでないリンク」として止まって移行できない | 再現した。前の `npm link` を外す処理を入口を書く前に移し、このリポジトリの `packages/cli/bin/sacty.js` を指すリンクは置き換えるようにした（`writeLauncher`）。ほかのリポジトリを指すリンク・sacty のものでないファイルは、これまでどおり上書きしない。あわせて、`npm rm -g` を確かめた npm のグローバルの場所に対して動かし、外れたことを確かめてから知らせるようにした（試す中で、`npm rm -g` が別の場所に対して動き、外れていないのに「外しました」と出ることがあると分かったため） |
| sacty のレビュー［提案］：画面の更新の知らせで、`cli:install` の1文がコマンドの後にあり、上から順に実行すると入口の Node.js を切り替えないまま起動まで進む | 1文をコマンドの前に動かし、順番をテストで確かめた |
| sacty のレビュー［提案］：仕様書（`daemon-lifecycle`）が、案内を「コマンドの下に」出すと書いたままで、画面（コマンドの前）と違う | 日英の仕様書を「コマンドの前に」に直した |

## 残したこと

- mise を使う macOS での確認（この環境は Linux で、mise は入っていない。版の違う Node.js は偽の `node`、mise は偽の `mise` で代わりにした）。実際の mise で、レジストリに無い名前で `mise link` できるか、登録した道具がシム・`mise activate` で `PATH` に載るか。
