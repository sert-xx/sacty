# 言語ごとのイメージに、OS のパッケージと追加のコマンドを入れられるようにする

- 日付: 2026-10-13（UTC）
- タスク: PBI-50
- PR: #60
- ブランチ: feat/issue-50-image-packages
- 関係する ADR: [言語ごとのイメージに、作るときに root で入れる OS のパッケージ（packages）と実行するコマンド（run）を書けるようにする](../adr/20261013-0621-image-packages-and-setup-commands.md)

## 目的

Playwright のテスト（OS のライブラリが無くて失敗する）や、外部の PF（プラットフォーム）の CLI を使うテスト（CLI がイメージに無い）を
動かせるよう、言語ごとのイメージに OS のパッケージと、イメージを作るときに root で実行するコマンドを書けるようにする。
エージェントは root ではないので、タスクの中では OS のパッケージを入れられない。

## したこと

- 設定（`apps/daemon/src/config.ts`・`packages/core/src/messages.ts`）：`images.<名前>.packages`（パッケージの名前は英数字と
  `. _ + : @ ~ = -` だけ）と `images.<名前>.run`（1 行ずつのコマンド）を足した。
- イメージの作成（`apps/daemon/src/image.ts`）：コマンドをファイルに書いて BuildKit の secret の仕組みで渡し、パッケージとコマンドの
  中身のハッシュを引数で渡して、変えたら作り直させる。
- `packages/cli/docker/Dockerfile`：エージェントの CLI を入れた後・`node` ユーザーに切り替える前に、パッケージ → コマンドの順に
  root で行う。dnf・microdnf・yum・apt-get のうち元のイメージにあるものを使う。`run` は、bash があれば `bash -ex -o pipefail`、
  無ければ `sh -ex` で実行する。
- `README.md`：説明と Playwright の例、秘密情報を書かないこと、取得と実行を別の項目に分けた CLI の導入の例。

## 確かめたこと

- build・typecheck・lint・全テスト（526 件）が通った。
- 足したテスト：設定（パッケージの名前とコマンドの検証）、イメージの作成の引数（パッケージ・コマンドのファイル・ハッシュが変わると
  作り直す・書かなければ空）。
- 実際にイメージを作り、`node` ユーザーで Playwright（1.56.0）の Chromium を起動してページを開けることを確かめた。
  1. Rocky Linux 9 ＋ `packages`（nss・nspr・atk など Chromium の OS のライブラリ）＋ `run`（root で実行されたことの確認）
  2. `node:22-bookworm-slim` ＋ `run: [npx -y playwright@1.56.0 install-deps chromium]`
  - ブラウザ本体は、タスクと同じく `npx playwright install chromium` で取得した。
- レビューの対応の後：`false | cat` を書いたイメージはその行で止まり後続の行を実行しないこと、`echo ok | cat` は通ることを、
  実際にイメージを作って確かめた。
- 未確認：利用者の Rocky Linux のイメージでの動作、外部の PF の CLI・Playwright を使う実際のテスト（レビューでも未検証）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| README の CLI の導入の例（取得をパイプで `sh` に渡す形）では、取得に失敗しても `sh -ex` がパイプの途中の失敗を検知せず、CLI が入らないままビルドが成功する | README の例を、取得（`curl -fsSL … -o /tmp/pf-install.sh`）と実行（`sh /tmp/pf-install.sh`）の別の項目に分け、run は終了コードで止まること・bash の無いイメージではパイプでつながないことを書いた。Dockerfile で、bash があれば `run` を `bash -ex -o pipefail` で実行するようにした |

## 残したこと

- 利用者の Rocky Linux のイメージに `packages`（Playwright の OS のライブラリ）と `run`（外部の PF の CLI の導入）を書いて
  `npx sacty image build <名前>` を実行し、テストが通ることを、利用者の環境で確かめてもらう。
- CLI の秘密鍵の扱いは PBI-51 に回した。
