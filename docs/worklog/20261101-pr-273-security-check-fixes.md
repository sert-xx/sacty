# セキュリティチェックの指摘（依存の脆弱性2件・既定のイメージの固定3件）と、全体の構成の古い記述を直す

- 日付: 2026-11-01（UTC）
- タスク: なし
- PR: #273
- ブランチ: feat/security-check-fixes
- 関係する ADR: [既定のイメージに入れるもの（元のイメージ・エージェントの CLI の依存・検査の道具）を、このリポジトリに固定した値で確かめる](../adr/20261101-2210-pin-agent-image-inputs.md)

## 目的

sacty のセキュリティチェックが出した5件の指摘（SF-1〜SF-5）を直す。あわせて、仕様書の全体の構成が「4つのパッケージ」のままで、デスクトップ版（`apps/desktop`）を含んでいないのを直す。

## したこと

- SF-1・SF-2（medium。glob の GHSA-3g3m-2fjr-6pw4、minimatch の GHSA-g3hv-75wg-m249）
  - 経路は `@electron/packager` → `@electron/asar@4.3.1` → `glob@13.0.6`・`minimatch@10.2.6`。`@electron/asar` の最新も `glob ^13`・`minimatch ^10` を指定しているので、ルートの `package.json` の `overrides` で、`@electron/asar` の下だけを `glob ^14.0.2`・`minimatch ^11.0.1` にした（ほかのワークスペースの依存には効かせない）。
  - 入ったのは `glob@14.0.3`・`minimatch@11.0.3`。`@electron/asar` が使うのは `glob(パターン, オプション)`（結果を配列で受ける）と `minimatch(パス, パターン, { matchBase })` だけで、どちらも新しい版にあり、変更履歴（glob の 14、minimatch の 11.0）の互換性の無い変更（`makeRe` の削除・`debug` の削除・`walk()` の戻り値など）には当たらない。
- SF-3（low）：`packages/cli/docker/Dockerfile` の `BASE_IMAGE`・`NODE_IMAGE` の既定を、`node:26-bookworm-slim@sha256:<マルチアーキのインデックスのダイジェスト>` にした。`image_build.base_image`・`node_image` で変える仕組みはそのまま（build-arg で上書きする）。
- SF-4（low）：エージェントの CLI を `packages/cli/docker/agent-cli` の `package.json`・`package-lock.json` から `npm ci --omit=dev` で `/opt/sacty/agent-cli` に入れ、`claude`・`codex` を `/opt/sacty/bin` からリンクした。
  - .npmrc を secret でビルドのときだけ読ませる仕組みと、`NPM_VERSION`（`npm install -g npm@<版>` を CLI の後に実行）は残した。
  - lockfile は `--omit-lockfile-registry-resolved` で作り、`resolved` を書かない（プライベートのレジストリで、置き換えの実装に頼らずに取るため。理由は ADR）。
- SF-5（low）：`packages/cli/docker/install-security-tools.sh` に、版・アーキテクチャごとの sha256 を固定し、リリースのハッシュのファイルは取らないようにした。値は GitHub がリリースの添付物に記録している sha256（`gh release view --json assets`）。取得できないときは警告して続け、合わないときは止める方針はそのまま。
- docs
  - 仕様書：全体の構成（日英）をパッケージ5つにし、表に `apps/desktop` を足した。エージェントの実行（日英）のイメージの節を、ダイジェスト・lockfile・固定したハッシュに合わせた。
  - ユーザードキュメント：イメージ（日英）のハッシュの確かめ方と、プライベートのレジストリの節（ダイジェストと lockfile の版）を直した。
  - CONTRIBUTING.md の版上げの手順に、ダイジェストの更新と CLI の lockfile の作り直しを足した。
  - ADR：検査の道具のハッシュを固定しないと決めた ADR の一部を置き換える ADR を足し、古い ADR を `superseded` にした（リンクを直した）。
- テスト
  - `apps/daemon/src/install-security-tools.test.ts`：固定したハッシュを差し替えた写しで実行する形にし、合わなければ止まる・取得できなければ続ける・ハッシュのファイルを取らない・4つのハッシュが固定されている、を足した。macOS では `sha256sum` が `/sbin` にあるので、PATH に足した。
  - `apps/daemon/src/image.test.ts`：既定の元のイメージがダイジェストで固定されていること、lockfile と package.json の版がそろい `resolved` が無く `integrity` があること、を足した。

## 確かめたこと

- `npm audit`：直す前は glob・minimatch の moderate 5件（経路の `@electron/asar`・`@electron/packager`・`@electron/universal` を含む）。直した後は `found 0 vulnerabilities`。
- `npm ls glob minimatch --all`：`@electron/asar` の下だけが `glob@14.0.3`・`minimatch@11.0.3`。ルートの `package-lock.json` の差分も、この2つと依存（`path-scurry@3.0.0`・`@isaacs/nonrecursive-glob-match@1.0.3`）だけ。
- `@electron/asar` の `createPackageWithOptions`（`unpack`・`unpackDir`・ドットのファイル・シンボリックリンク）で ASAR を作り、`listPackage` と展開先の中身が期待どおり。
- `node apps/desktop/scripts/package.mjs`（Node.js 26.12.1、ASAR を有効にした経路、darwin arm64）：成功し、`app.asar` に21個のファイル。既定のイメージの名前は、共有の `sacty-agent:1.15.0` を作らないよう、`docker` を包むスクリプトで試しに作ったイメージに読み替えた。
- `docker buildx imagetools inspect node:26-bookworm-slim`：インデックスのダイジェストが `sha256:bc0a2afd…c1d9` で、`linux/amd64`・`linux/arm64/v8` を含む。
- `docker build`（Rancher Desktop）
  - arm64：成功。node ユーザーで `claude --version`（2.1.296）・`codex --version`（0.160.0）・`osv-scanner --version`（2.7.0）・`gitleaks version`（8.30.1）が動く。`claude`・`codex` は `/opt/sacty/bin` から。
  - amd64（`--platform linux/amd64`、エミュレーション）：成功。osv-scanner・gitleaks は固定したハッシュと合って入り、`node_modules` に `claude-code-linux-x64`・`codex-linux-x64` が入った。`codex --version`・`osv-scanner --version` は動いた。`claude`（Bun）と `gitleaks`（Go）はエミュレーターの中で落ちた（qemu の制約。実機の amd64 では確かめていない）。
  - gitleaks の arm64 のハッシュの1文字を変えた写しで作ると、`gitleaks_8.30.1_linux_arm64.tar.gz のハッシュが、固定したハッシュと合いません` で止まった。
  - 言語ごとのイメージ（`BASE_IMAGE=buildpack-deps:bookworm`・`BASE_KIND=lang`・`NPM_VERSION=11.6.2`）：成功。Node.js は `NODE_IMAGE`（ダイジェストで固定した既定）から `/opt/sacty-node` に写り、node ユーザーで `claude`・`codex`・`osv-scanner`・`gitleaks` が動き、`npm -v` が 11.6.2。
  - 先に `debian:bookworm-slim` で試すと、写した Node.js 26 が `libatomic.so.1` を見つけられずに止まった。CLI を入れる前の `node` の起動で止まるので、この変更の前からのもの（このタスクでは直していない）。
- プライベートのレジストリ：パス付き（`/npm/private/`）・認証が要るレジストリを真似た中継を手元に立て、その `.npmrc` で `agent-cli` の lockfile から `npm ci` すると、メタデータ・tarball のすべての取得が中継に認証付きで届き、ほかのホストへの取得は無かった。`node:18-bookworm-slim`（npm 10）でも、同じ lockfile で `npm ci` できた。
- npm の `replace-registry-host` の既定は `npmjs`（npm 11.19.1 の `@npmcli/config` の定義）。npm 10.8.2・11.19.1 の arborist は、公開レジストリの `resolved` を設定したレジストリ（パスを含む）に置き換える。
- `npx biome check .`・`npm run typecheck`・`npx vitest run tests/docs`・`npx vitest run`（全体を1回。181 ファイル・3381 件が成功）。
- 足したテストは、スクリプト・lockfile を戻すと失敗することを確かめた（スクリプトを戻すと4件、lockfile に `resolved` を足すと1件が失敗）。

## 確かめられなかったこと

- 公式のリリースのハッシュのファイル（`osv-scanner_SHA256SUMS`・`gitleaks_8.30.1_checksums.txt`）を手元に取って突き合わせることは、この環境では取得が許されずできなかった。固定した値は GitHub の添付物の記録から取り、両アーキテクチャのビルドで、取得した実物がその値と合うことを確かめた。
- 実機の amd64 での `claude`・`gitleaks` の実行。
- 本物のプライベートのレジストリ（Nexus・Artifactory など）での `sacty image build`。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （セルフレビュー）`overrides` がほかのワークスペースに波及しないか | `@electron/asar` の下だけに効く入れ子の指定にし、`npm ls` とルートの lockfile の差分で、ほかに変わったものが無いことを確かめた |
| （セルフレビュー）lockfile に公開レジストリの URL が残ると、プライベートのレジストリで置き換えの実装に頼る | `resolved` を書かない lockfile にし、テストで確かめるようにした |
| （セルフレビュー）CLI の版を上げるときに lockfile の作り直しが漏れる | package.json と lockfile の版がそろっていることをテストで確かめ、CONTRIBUTING.md に作り直しのコマンドを書いた |

## 残したこと

- ダイジェストで固定したので、元のイメージの OS の更新は、ダイジェストを更新するまで入らない（版上げの手順で更新する）。
- 言語ごとのイメージで、`libatomic1` の無い元のイメージ（`debian:bookworm-slim` など）に Node.js 26 を写すと動かない（前からのもの）。
- `NPM_CONFIG_HASH` などの build-arg を npm が設定とみなす警告（`Unknown env config "hash"`）は、前からのもので、このタスクでは直していない。
