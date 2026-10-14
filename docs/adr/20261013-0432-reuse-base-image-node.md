# 言語ごとのイメージでは、元のイメージに Node.js と npm があればそれを使い、無いときだけ写す

- 日時: 2026-10-13 04:32 UTC
- ステータス: 採用
- 関係する PR・タスク: #58、PBI-41
- 置き換え元: [言語ごとの実行イメージを config.yaml の images に定義し、オーケストレーターが工程ごとに選ぶ](20261013-0138-superseded-language-images-per-step.md)（Node.js を必ず写す部分）
- 置き換え先: なし

## 背景

#53 で決めた言語ごとのイメージでは、元のイメージに Node.js が入っていても、必ず写す元のイメージ（`node_image`、無ければ `image_build.base_image` か `node:22-bookworm-slim`）から
Node.js を写していた。写すときに npm が `/usr/local/lib/node_modules/npm` にあると決め打ちしていたため、Node.js 用のイメージを `images` に足すと、
`sacty image build` が `failed to compute cache key` で失敗していた。

## 決定

- 元のイメージに Node.js 18 以上と npm があれば、それを使う（写さない）。
- 無ければ、写す元のイメージの中で node（`command -v node` の実体）と npm（`npm root -g`・`/usr/local/lib/node_modules`・`/usr/lib/node_modules` の順に探す）を探して写す。
- どちらにも無ければ、何が足りないか（`node_image` に node と npm の入ったイメージを書くこと）を示して、イメージの作成を止める。

## 理由

- 元のイメージの Node.js を無視して必ず写し、npm の場所を決め打ちしていたことが、失敗の原因だったため（PR の本文）。

## 影響

- Node.js の入った元のイメージ（Node.js 用のイメージなど）では、写す元のイメージに npm が無くても作れる。
- 写す元のイメージの npm が別の場所にあっても写せる。どちらにも無いときは、理由がわかる失敗になる。
