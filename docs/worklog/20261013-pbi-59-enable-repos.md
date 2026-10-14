# イメージの packages を入れるときに、無効にしてあるリポジトリを enable_repos で有効にする

- 日付: 2026-10-13（UTC）
- タスク: PBI-59
- PR: #66
- ブランチ: feat/issue-59-enable-repos
- 関係する ADR: [イメージの packages を入れるときに、enable_repos に書いた無効の repo を有効にする](../adr/20261013-1236-image-enable-repos.md)

## 目的

利用者の Rocky Linux のイメージでは、rpm リポジトリの repo が設定されていても無効になっていることがある。`images.<名前>.enable_repos`
に repo の ID を書くと、`packages` を入れるときにそのリポジトリを有効にする。受け入れ条件の要点は次のとおり。

- dnf・yum・microdnf で、書いたリポジトリを有効にして `packages` が入る（書かなければ、これまでどおり）。
- apt-get のイメージで書くと理由を示して止まる。ID の形が誤っていれば、設定の読み込みで理由を示す。
- `enable_repos` を変えると、`sacty image build` で作り直される。

## したこと

- 設定（`apps/daemon/src/config.ts`・`packages/core/src/messages.ts`）：`images.<名前>.enable_repos`（既定は空）。ID は
  `^[A-Za-z0-9][A-Za-z0-9._:-]*$` に限る。`packages` が無いのに書いたら止める。
- ビルド（`apps/daemon/src/image.ts`）：ID があるときだけ `--build-arg SACTY_ENABLE_REPOS` を渡し、ハッシュにも含める。
- `packages/cli/docker/Dockerfile`：dnf・microdnf・yum では `--enablerepo=<ID>` を付けて入れる。apt-get では止める。
- `README.md`：「言語ごとのイメージ」の節に、説明と例、repo の ID を確かめる `dnf repolist --all`。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npx vitest run`（611 件）・`npm run build` が通った。
- Docker で Dockerfile の RUN を確かめた。
  - rockylinux:9（dnf）：存在しない ID は dnf が `Unknown repo` で失敗する。`crb appstream` を書くと crb にしか無いパッケージが入る。
    書かなければ、これまでどおり見つからない。
  - yum（dnf を消したもの）・rockylinux:9-minimal（microdnf）：`crb` を書くと入る。
  - node:22-bookworm-slim（apt-get）：書くと理由を示して止まる。書かなければ、これまでどおり入る。
- 主要な処理を 6 か所わざと壊し、すべてテストが落ちることを確かめた。
- 画面の変更は無いので、動画は撮っていない。
- レビューでは、Dockerfile から取り出した RUN の処理を偽の dnf・microdnf・yum・apt-get で実行し、16 ケースで引数の受け渡し・
  失敗時の停止・apt-get での拒否を確かめた。実際の rpm リポジトリからのインストールとイメージ全体のビルドは、レビューでは
  再実行していない。

## レビューの指摘と対応

指摘は無かった（PASS のみ）。

## 残したこと

- 元のイメージに git が無いときに git を入れる手順と、`run` のコマンドには `enable_repos` を効かせない（範囲外。`run` で dnf を使う
  ときは、そこで `--enablerepo` を書く）。
