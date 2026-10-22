# エージェントのイメージに作業用の CLI と draw.io の CLI を入れ、draw.io の公式のスキルを既定のスキルにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/relaxed-lamport-g4xx12
- 関係する ADR: [エージェントのイメージに作業用の CLI と draw.io の CLI を入れ、draw.io の公式のスキルを既定のスキルにする](../adr/20261022-0115-agent-image-tools-and-drawio.md)

## 目的

エージェントがどの工程でも使える CLI（`jq`・`rg` など）をイメージに入れる。ライセンス・脆弱性・メンテナンスの手間を考えて選ぶ。
あわせて、draw.io の図を作れるように、draw.io の CLI と公式のスキルを用意する。

## したこと

- `packages/cli/docker/install-tools.sh`：`jq`・`rg`・`fd`・`tree`・`file`・`less`・`curl`・`zip`・`unzip`・`xz`・`bzip2`・`patch`・`diff`・`find`・`make`・
  `ps`・`sqlite3`・`python3`・`shellcheck` のうち、元のイメージに無いものだけを OS のパッケージで入れる。入れられないものは警告して続ける。
- `packages/cli/docker/install-drawio.sh`：draw.io Desktop 32.4.1 の deb・rpm を GitHub のリリースから取り、SHA-256 を確かめて、Xvfb・libasound・
  CJK のフォントと一緒に入れる。`chrome-sandbox` の setuid を外す。取得できなければ警告して続け、ハッシュが合わなければ止める。
- `packages/cli/docker/drawio-shim.cjs`：`/opt/sacty/bin/drawio`。Xvfb を `-displayfd` で起動し、`--no-sandbox --disable-gpu` で draw.io を動かし、
  D-Bus のログを除く。終わったら Xvfb を止めて待つ。
- `Dockerfile` に上の2つの手順を足した。draw.io の Docker イメージは使わない（元のイメージの上にパッケージを入れる）。
- 設定 `image_build.drawio`（`false` で入れない。`SACTY_DRAWIO=0`）を足した（`apps/daemon/src/config.ts`・`apps/daemon/src/image.ts`）。
- draw.io の公式のスキル（`jgraph/drawio-mcp` 307725c の `plugins/claude-code/skills/drawio/SKILL.md`）を、手を加えずに `LICENSE` とともに
  `apps/daemon/default-context/skills/drawio/` に置いた。
- テスト：設定の読み込み・build-arg・スキルのハッシュ・包むスクリプト（`apps/daemon/src/drawio-shim.test.ts`）・既定のスキルの一覧。
- 仕様書（エージェントの実行・設定・コンテキスト）とユーザードキュメント（コンテナイメージ・コンテキスト）を日英で直し、ADR を足した。

## 確かめたこと

- `docker build`（元のイメージを Ubuntu 24.04 にした言語ごとのイメージの形。このセッションからは Debian のミラーに届かないため）：成功。
  全コマンドが入り、`--security-opt no-new-privileges --cap-drop ALL`・node ユーザーで、Mermaid → `.drawio`、`--layout verticalFlow`、PNG・SVG・PDF の
  `-e` 付きの書き出し、2つの並行の書き出しが通った。日本語のラベルが PNG に描かれることを目で確かめた（フォントが無いと豆腐になった）。
- Electron の `--ozone-platform=headless` は Segmentation fault で落ちたので、Xvfb にした。
- ネットワークを切ったコンテナ（Ubuntu・Rocky Linux 9）で2つのスクリプトを実行し、警告して終了コード 0 になること、ハッシュを変えると終了コード 1 で
  止まること、`SACTY_DRAWIO=0` で入れないことを確かめた。
- Rocky Linux 9 で rpm の依存（gtk3・nss・libXScrnSaver など）を `rpm -qpR` で確かめた。RHEL 系のミラーに届かないため、実際の導入は確かめていない。
- `npm run lint`・`npm run typecheck`・`npm run build`：通った。
- `npx vitest run`：`agent-sessions`・`context-mcp`・`host-mcp-processes` の 8 件が落ちる。変更を退避しても同じく落ちるので、この環境（root で動かして
  いるなど）によるもので、この変更とは関係しない。ほかは通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 社内のレジストリのイメージしか使えないので、draw.io の公式の Docker イメージを使わないでほしい | draw.io の Docker イメージは使っておらず、元のイメージの上に公式のリリースのパッケージを入れていることを確かめた（変更なし） |

## 残したこと

- GitHub のリリースに届かない環境向けに、draw.io のパッケージの取得先を社内のミラーに向ける設定（利用者の判断を待っている）。
- 既定の `node:22-bookworm-slim` と RHEL 系の元のイメージでの実際のビルド。
