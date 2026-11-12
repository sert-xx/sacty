# エージェントのイメージのビルドで、引数を使う直前で宣言し、取得物を BuildKit の cache マウントに置く

- 日時: 2026-11-12 15:26 UTC
- ステータス: 採用
- 関係する PR・タスク: なし（PR は作業履歴に書く）
- 置き換え元: なし
- 置き換え先: なし

## 背景

エージェントのイメージ（`packages/cli/docker/Dockerfile`）のビルドに時間がかかっていた。既定のイメージも、コンテキストリポジトリの
`images.yaml` のイメージ（PBI-325）も同じ Dockerfile で作る。層のキャッシュが効かない、または効いても無駄に外れるところが3つあった。

- `NPM_VERSION`・`MAVEN_MIRROR` を最後のステージの先頭で宣言していた。Docker では、宣言より後の `RUN` はその値を環境変数として受け取るので、
  値を変えると使わない手順（git・作業用の CLI・draw.io・セキュリティの検査の道具）まで作り直される。`SACTY_DRAWIO` も、
  後ろのセキュリティの道具を作り直させていた。
- `install-drawio.sh` と `drawio-shim.cjs` を1つの `COPY` で写していたので、包むスクリプトを直すだけで draw.io（パッケージの取得・Xvfb・CJK のフォント）を入れ直していた。
- 層のキャッシュが外れたとき（元のイメージを上げた・7日使わずビルドキャッシュが消えた・元のイメージが違う言語ごとのイメージ）は、apt の `.deb`・draw.io・
  `osv-scanner`・`gitleaks`・npm のパッケージを毎回取り直していた。言語ごとのイメージは元のイメージが違うので層を共有できず、イメージの数だけ取り直していた。

## 決定

- build-arg は、使う手順の直前で宣言する。セキュリティの検査の道具を draw.io より前に動かし、`SACTY_DRAWIO` の後ろに重い手順を置かない
  （エージェントの CLI は版をよく上げるので、draw.io より後のまま）。
- `drawio-shim.cjs` は、draw.io を入れる手順と別に、エージェントの CLI の後・`packages`・`run` の前で写す（`run` から `drawio` を使えるように）。
- git・作業用の CLI・セキュリティの検査の道具・draw.io の手順は、BuildKit の cache マウント（`id=sacty-build-cache`、`sharing=locked`）を
  `with-build-cache.sh` を通して使う。
  - apt-get の `.deb` は `APT_CONFIG` の `Dir::Cache::Archives` でマウントの中に置く。元のイメージの `APT_CONFIG` は `#include` で引き継ぐ。Debian・Ubuntu の公式のイメージの `docker-clean` は
    `/var/cache/apt/archives` の `.deb` を消すので、場所を変える。パッケージの一覧は置かない（毎回 `apt-get update` で取る）。30 日を過ぎた `.deb` は消す。
  - draw.io・セキュリティの道具の取得物は、道具と版ごとの場所に置き、スクリプトに固定した SHA-256 と合うときだけ使う。
- エージェントの CLI の npm のキャッシュを、消す一時の場所から cache マウント（`id=sacty-npm-cache`）に移す。

## 検討した案

- **dnf・microdnf・yum の取得物も置く**：`keepcache` の指定とキャッシュの場所が dnf4・dnf5・yum・microdnf で違い、`clean all` を外すと
  古いメタデータで入れる心配がある。ここでは試せる環境が無いので、今回は置かない（これまでどおり `clean all`）。
- **apt のパッケージの一覧も置く**：取得を減らせるが、Debian と Ubuntu など一覧の違うイメージで共有すると、`apt-get update` が互いの一覧を消し合う。
  一覧は小さいので置かない。
- **`packages`・`run` の手順にもマウントを渡す**：利用者が書くコマンドが何をするかわからないので、渡さない。
- **元のイメージに依存しない道具を別のステージで作り、言語ごとのイメージで共有する**：効果は大きいが、ステージの組み替えになり、
  エージェントの CLI はネイティブのバイナリの選ばれ方を確かめる必要があるので、別に検討する。

## 結果

- `npm_version`・`maven_mirror`・`drawio` を変えても、`drawio-shim.cjs` を直しても、重い手順は作り直さない。
- 層のキャッシュが外れても、取得物がマウントにあれば取り直さない。マウントは元のイメージが違うイメージの間でも共有する。
- cache マウントの中身はイメージに残らない。ビルドキャッシュの一部なので、7日使わなければ `sacty image build` の片付け（`builder prune`）で消える。
- `sharing=locked` なので、同じ Docker で同時に動くビルドは、マウントを使う手順で順番を待つ。
- 最初のビルドでは、手順を並べ替えたので層のキャッシュが外れ、一度作り直す。
