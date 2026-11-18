# sacty コマンドの入口を mise に登録するのをやめ、いつも ~/.local/bin などに置く

- 日時: 2026-11-18 13:22 UTC
- ステータス: 採用
- 関係する PR・タスク: なし（PR を作る前に書いた）
- 置き換え元: [sacty コマンドを、Node.js の版に関係しない場所の起動の入口で入れ、入れたときの Node.js で動かす](20261111-0054-superseded-cli-install-launcher-with-fixed-node.md)（入口を mise に登録する決定と、mise で入れたときの確かめ・消し方を置き換える）
- 置き換え先: なし

## 背景

`npm run cli:install` は、`PATH` に `mise` があると、入口を版ごとのディレクトリ（`~/.local/share/sacty/mise/<版>/bin/sacty`）に置き、`mise link sacty@<版>` と `mise use --global sacty@<版>` で mise に登録していた。
リポジトリの持ち主から、mise を使う環境で、この入れ方がうまくない、と報告があった（どの症状かは聞いていない）。
コードと前の ADR から分かる、この入れ方の弱い所は次のとおり。
- 版を上げるたびに、mise の利用者全体の設定（`~/.config/mise/config.toml`）の `sacty` の行が変わる。前の版の登録とディレクトリは残り続ける。
- mise のレジストリに無い名前（`sacty`）を `mise link` で登録する使い方で、前の ADR を書いたときも、実際の mise では確かめていない。
- シムも `mise activate` も設定していないシェルでは、登録しても `sacty` を実行できない。

持ち主は、mise の設定の `_.path` に、リポジトリの `bin` を直接足す案も検討していた。

## 決定

- `npm run cli:install` は、mise があっても mise に登録せず、いつも `SACTY_BIN_DIR`、無ければ `~/.local/bin` に入口を置く（前は、mise が無いとき・登録に失敗したときの動き）。
- 入口の作り（`cli:install` を動かした Node.js の絶対パスで、このリポジトリの `packages/cli/bin/sacty.js` を動かすシェルのスクリプト）は変えない。
- 入口を置いた後に、前の版が mise に登録した sacty を外す。前の版の入口のディレクトリ（`~/.local/share/sacty/mise`）があるときだけ行う。
  `mise unuse --global sacty` で利用者全体の設定から外し、mise の登録のうち前の版の入口のディレクトリを指すリンクと、そのディレクトリを消す。
  `mise` が `PATH` に無い・`mise unuse` が失敗したら、何も消さずに、理由と手で消す手順を注意に出す。
- 置いた後の確かめは、mise の有無に関係なく、`PATH` で最初に見つかる `sacty` が置いた入口か、だけにする。

## 理由

- 置き場所を1つにすれば、mise の設定に触れず、版ごとの登録も溜まらない。`~/.local/bin` は Node.js の版に関係せず、mise も既定でここに入るので、mise を使う環境の多くで `PATH` に入っている。
- 前の登録を外すのは、mise が登録した道具の bin を `PATH` の前の方に載せるため、残すと、置いた入口より先に前の版の入口が見つかるため。
  設定から外せなかったときに何も消さないのは、設定が指す版の登録だけを消すと、mise が、入っていない道具として扱うため（どう知らせるかは、実際の mise では確かめていない）。
- 比べた案と採らなかった理由：
  - mise の設定の `_.path` に、リポジトリの `packages/cli/bin` を足す。`sacty.js` は `#!/usr/bin/env node` で始まるので、いるディレクトリの Node.js で動き、Node.js の版の問題（前の ADR の背景）が戻る。bin のファイルの名前も `sacty.js` で、`sacty` とは打てない。
  - 版に関係しない sacty 専用のディレクトリに入口を置き、`_.path` に足す。`_.path` を足す mise のコマンドを知らず、設定のファイルを直接書き換えるか、利用者に書いてもらうことになる。シムだけを使う環境で効くかも確かめていない。`~/.local/bin` を `PATH` に入れたくない人は、`SACTY_BIN_DIR` で置き場所を選べる。

## 影響

- mise で sacty の版を確かめる（`mise ls sacty`）ことは、できなくなる。版は `sacty --version` で確かめる。
- `~/.local/bin` が `PATH` に無い環境では、前は mise が `PATH` に載せていた `sacty` が、`PATH` に足すまで使えなくなる（`cli:install` が注意で知らせる）。
- 前の登録を外す処理は、この ADR を書いたときの環境に mise を入れられず、偽の `mise`（受けた引数を記録し、`where` をまねるもの）で確かめた。`mise unuse --global sacty` が、`mise link` で登録した道具を設定から外せるか、外した後に mise の登録（リンク）が残るかは、実際の mise では確かめていない。外せなかったときは、手で消す手順を知らせる。
- 入口を消すには、置き場所の `sacty` を消すだけになる。
- 仕様は [アーキテクチャ](../spec/architecture.md#パッケージ)、利用者向けは [はじめに](../user/getting-started.md#どのディレクトリでも-sacty-を使う) に書く。
