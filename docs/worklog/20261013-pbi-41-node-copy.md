# 言語ごとのイメージで、元のイメージの Node.js を使い、無ければ node と npm の場所を探して写す

- 日付: 2026-10-13（UTC）
- タスク: PBI-41
- PR: #58
- ブランチ: fix/issue-41-node-copy
- 関係する ADR: [言語ごとのイメージでは、元のイメージに Node.js と npm があればそれを使い、無いときだけ写す](../adr/20261013-0432-reuse-base-image-node.md)

## 目的

`images` に Node.js 用のイメージを足して `sacty image build` を実行すると、Dockerfile の19行目（`COPY --from=sacty-node /usr/local/lib/node_modules/npm …`）で
`failed to compute cache key` になって失敗する、という報告に対応する（PBI-41 の不具合）。

## したこと

- 原因：言語ごとのイメージでは、元のイメージに Node.js が入っていても、必ず写す元のイメージ（`node_image`、無ければ `image_build.base_image` か `node:22-bookworm-slim`）から
  Node.js を写していた。写すときに、npm が `/usr/local/lib/node_modules/npm` にあると決め打ちしていたため、npm が別の場所にある・入っていないイメージでは失敗していた。
  npm を消した `node_image` を指定して、同じ19行目の失敗を手元で再現した。
- `packages/cli/docker/Dockerfile`：
  - 元のイメージに Node.js 18 以上と npm があれば、それを使う（写さない）。
  - 無ければ、写す元のイメージの中で node（`command -v node` の実体）と npm（`npm root -g`・`/usr/local/lib/node_modules`・`/usr/lib/node_modules` の順に探す）を探して写す。
  - どちらにも無ければ、何が足りないか（`node_image` に node と npm の入ったイメージを書くこと）を示して止める。
- `apps/daemon/src/config.ts` の config.yaml の雛形と README の説明を直した。

## 確かめたこと

- 実際にイメージを作って確かめた。
  1. 元のイメージ `node:22-bookworm-slim`・写す元に npm が無い（報告と同じ条件）→ 元のイメージの Node.js を使って作れる（`/usr/local/bin/node`、`/opt/sacty-node` は無い）。
  2. 元のイメージ `rockylinux:9`（Node.js 無し）→ これまでどおり写して作れる。
  3. 元のイメージ `rockylinux:9`・写す元の npm が `/usr/lib/node_modules` → 場所を探して写して作れる。
  4. 元のイメージ `rockylinux:9`・写す元に npm が無い → 理由を示して止まる。
  - 1〜3 のイメージで、Claude Code・Codex が `node` ユーザーで動くこと。
- build・typecheck・lint・全テストが通った。
- レビューで、全525テスト・lint・型チェックが通り、変更した段（base-lang）までを実際にビルドして、上の再利用・写す・止まるの経路を確かめた。
  最終の段の CLI のインストールと、利用者のイメージでの確認は未実施。

## レビューの指摘と対応

指摘は無かった（レビューの結果は PASS）。

## 残したこと

- 利用者の環境で、失敗した `images` の設定で、もう一度 `npx sacty image build <名前>` を実行して作れることを確かめる（PR で依頼した）。
