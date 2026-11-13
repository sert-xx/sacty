# 既定のイメージで draw.io の CLI が動かないのを直す

- 日付: 2026-11-13（UTC）
- タスク: PBI-338
- PR: #360
- ブランチ: feat/issue-338-drawio-libgbm
- 関係する ADR: なし

## 目的

1.24.0 のリリースの確認で、既定のイメージの `drawio --version` が `libgbm.so.1: cannot open shared object file` で失敗した。既定のスキル `drawio` の変換・書き出しが使えない。v1.23.1 の `Dockerfile` で作ったイメージでも同じだった。

## 原因

draw.io 32.4.1 の deb の `Depends` に `libgbm1` が無い。`--no-install-recommends` で入れているので、ほかの依存から入ることもない。`ldd /opt/drawio/drawio` で足りないのは `libgbm.so.1` だけだった。

## したこと

- `packages/cli/docker/install-drawio.sh`：apt-get では `libgbm1`、dnf・yum では `mesa-libgbm` を、draw.io と一緒に入れる。
- 入れた後に `ldd` で `/opt/drawio/drawio` が読めない共有ライブラリがあれば、名前を示して警告し、続ける（パッケージの依存の書き漏れに、ビルドのログで気づけるように）。
- テスト（`apps/daemon/src/image.test.ts`）：入れるパッケージに GBM のライブラリがあること、`ldd` の出力を差し替えて、足りないときだけ警告し終了コード 0 で続くこと。
- 仕様書（`agent-execution`）とユーザードキュメント（`images`）の日英を直した。

## 確かめたこと

- 既定のイメージ（Debian bookworm、arm64）を `docker build` で作り、`libgbm1` が入ること、`drawio --version` が `32.4.1` を返すこと、日本語のラベルの `.drawio` を PNG に書き出せることを確かめた。`ldd` で足りないライブラリは 0 件。
- 同じイメージで `libgbm1` を外し、警告の部分を動かすと `libgbm.so.1` の名前を示して警告し、終了コード 0 で続くことを確かめた（外す前は何も出ない）。
- パッケージの名前：`rockylinux:9`・`fedora:41` で `libgbm.so.1` を提供するのが `mesa-libgbm` であること、`ubuntu:24.04` に `libgbm1` があることを確かめた。RHEL 系・Ubuntu を元にしたイメージは作っていない。
- 足したテストは、修正を戻すと落ちる（GBM のライブラリを外す・警告を消す）。
- `npm run lint`・`npm run typecheck`・`npx vitest run`：結果は PR の本文に書く。

## レビューの指摘と対応

- なし。
