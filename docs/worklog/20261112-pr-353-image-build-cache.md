# エージェントのイメージのビルドで、層のキャッシュが外れにくく・外れても取り直さないようにする

- 日付: 2026-11-12（UTC）
- タスク: なし
- PR: #353
- ブランチ: claude/friendly-edison-g3io2v
- 関係する ADR: [エージェントのイメージのビルドで、引数を使う直前で宣言し、取得物を BuildKit の cache マウントに置く](../adr/20261112-1526-image-build-cache.md)

## 目的

既定のイメージも、コンテキストの `images.yaml` のイメージも、ビルドに時間がかかっていた。層のキャッシュが無駄に外れるところを直し、外れたときも取得物を取り直さないようにする。

## したこと

- `packages/cli/docker/Dockerfile`
  - `NPM_VERSION`・`MAVEN_MIRROR` を、使う手順の直前で宣言するように移した。
  - セキュリティの検査の道具を draw.io より前に移した（`SACTY_DRAWIO` の後ろに重い手順を置かない）。
  - `drawio-shim.cjs` を、draw.io を入れる手順とは別に、`gh` の代わりの後で写すようにした。
  - git・作業用の CLI・セキュリティの道具・draw.io の手順で、cache マウント（`sacty-build-cache`）を使うようにした。エージェントの CLI の npm のキャッシュも cache マウント（`sacty-npm-cache`）に置くようにした。
- `packages/cli/docker/with-build-cache.sh` を足した。マウントがあれば、apt の `.deb` の置き場所（`APT_CONFIG`）と取得物の置き場所（`SACTY_DOWNLOAD_CACHE`）を設定してコマンドを実行する。
- `install-drawio.sh`・`install-security-tools.sh`：キャッシュに、固定したハッシュと合うものがあれば使う。無ければ取得して確かめてから置き、ほかの版を消す。
- 30 日を過ぎた `.deb` を消す判定は、最初 `-mtime` で書いていた。apt-get は `.deb` の mtime を配布元の日時にするので、置いたばかりのものまで消えていた。実際のビルドで取り直しているのを見つけ、`-ctime` に直した。
- テスト：`image.test.ts`（引数の位置・shim のコピー・cache マウントの指定）と `install-security-tools.test.ts`（キャッシュを使う・壊れていれば取り直す・取得物のハッシュが合わなければ置かずに止める・古い版を消す）。
- 仕様書 `docs/spec/agent-execution.md`・`agent-execution.en.md` に「ビルドのキャッシュ」を足し、ADR を足した。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run apps/daemon/src/image.test.ts apps/daemon/src/install-security-tools.test.ts apps/daemon/src/drawio-shim.test.ts tests/docs`：131 件通過。
- 全体の `npx vitest run`：18 件失敗。`repository`・`host-mcp-processes`・`agent-sessions`・`context-mcp`・ブラウザのテストで、変更を退避した状態でも同じように失敗する（作業の環境によるもの）。
- 実際の `docker build`（Docker 29.9.2）。作業の環境は Debian のミラーに届かないので、`BASE_KIND=lang`・`BASE_IMAGE=ubuntu:24.04` で作った。プロキシの CA を入れる層は、確かめるための写しにだけ足した。
  - 先頭の層を変えて層のキャッシュを外したとき：apt の取得は `0 B`。draw.io・osv-scanner・gitleaks は、キャッシュのものを使った。
  - `NPM_VERSION`・`MAVEN_MIRROR` を変え、`drawio-shim.cjs` を直したとき：重い手順はすべて `CACHED`。
  - できたイメージに、キャッシュの場所と `APT_CONFIG` は残らない。各 CLI の版と、Maven のミラーの設定を確かめた。
  - `docker build --no-cache` では cache マウントも新しくなる（確かめ方として使えない）。

## 素のイメージで、写した Node.js が動かないのを直す

- 確かめているときに見つけた。`ubuntu:24.04` のような素のイメージに `node:26-bookworm-slim` から Node.js を写すと、`node` が `libatomic.so.1` を見つけられず、エージェントの CLI の手順が終了コード 127 で止まっていた（この PR より前から）。`node` は `libatomic`・`libstdc++`・`libgcc_s` を使う（`ldd`）。
- 同じ PR に含めた（このセッションで push してよいのは、この PR のブランチだけのため）。
- `base-lang` で Node.js を写したら、`node --version` が動くかを確かめる。動かなければ、元のイメージのパッケージの管理のコマンドで `libatomic`・`libstdc++` を入れ、それでも動かなければ、理由と直し方を示して止める。
  - この手順の後の `packages`・`run` では間に合わないので、ここで入れる。
- 確かめたこと（実際の `docker build`）：
  - `ubuntu:24.04`：「共有ライブラリ（libatomic・libstdc++）を入れます」を出して入れ、`node v26.13.1`・`claude 2.1.318` が動いた。
  - `alpine:3.20`：パッケージの管理のコマンドが無いので入れられず、`not found` と「Alpine など musl のイメージには写せません」を示して止まった。
  - RHEL 系のミラーにはこの環境から届かないので、dnf・microdnf・yum の分岐は試していない。

## レビューの指摘と対応

- なし（レビューを待っている）。
