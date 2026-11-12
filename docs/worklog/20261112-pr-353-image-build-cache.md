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

1回目（sacty のレビュー、判定：修正が必要）

- [要修正] `drawio-shim.cjs` の `COPY` が利用者の `images.run` より後なので、`run` の中の `drawio` が無いファイルを指し、`run` で drawio を使う設定のビルドが失敗する。
  - 対応：エージェントの CLI の後、`packages`・`run` の前に移した。直しても draw.io とエージェントの CLI は入れ直さない。`image.test.ts` で、`npm ci` より後・`/run/secrets/setup` より前にあることを確かめる。
- [要修正] `with-build-cache.sh` が元のイメージの `APT_CONFIG` を上書きするので、そこに書いたプロキシなどの設定が apt の実行のときに失われる。
  - 対応：元の `APT_CONFIG` のファイルがあれば、`#include` で読み込んでから `Dir::Cache::Archives` を足すようにした。テストのためだけに、キャッシュの場所を `SACTY_BUILD_CACHE_DIR` で変えられるようにした。`with-build-cache.test.ts` を足した（場所を渡す・引き継ぐ・ファイルが無ければ読み込まない・マウントが無ければ何もしない）。
  - `ubuntu:24.04` のコンテナで `apt-config dump` を実行し、`#include` した `Acquire::http::Proxy` と `Dir::Cache::archives` の両方が効くことを確かめた。
- [要修正] 写した Node.js が動かないときの説明が、`docs/user/images.md`・`images.en.md` に無い。
  - 対応：両方の言語に、共有ライブラリを入れること、それでも動かないときのメッセージ、`node_image` と元のイメージの選び方、`packages`・`run` では間に合わないことを書いた。
- [提案] 2回の `run` の間に秒が変わると、作り直した gitleaks の tar に入る更新日時でハッシュが変わり、キャッシュのテストが不安定になる。
  - 対応：同じ場所で続けて実行するときは、前に作った tar を使い回すようにした。
- 実際の `docker build`（`ubuntu:24.04`、`run` に `drawio --version`）：`run` の中で `drawio` が `32.4.1` を返した。apt・draw.io・セキュリティの道具は、キャッシュのものを使った。
- 確かめたこと：`npm run lint`・`npm run typecheck` が通過。`npx vitest run apps/daemon/src/with-build-cache.test.ts apps/daemon/src/image.test.ts apps/daemon/src/install-security-tools.test.ts tests/docs` がすべて通過。

2回目（sacty の再レビュー、判定：指摘なし）

- 前回の4件の指摘すべてについて、対応を確かめたとのこと。新しい指摘は無い。
