# エージェントのイメージに作業用の CLI と draw.io の CLI を入れ、draw.io の公式のスキルを既定のスキルにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #191
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
| draw.io のパッケージの取得先を社内のミラーに変えるオプションが欲しい（その後、GitHub のリリースのミラーは無いので不要と取り下げ） | `image_build.drawio_mirror` を一度足したが、取り下げを受けて同じブランチの中で戻した（GitHub に届かない環境では、`image_build.drawio: false` にするか、警告のとおり draw.io なしで作る） |
| [要修正] RHEL 系で EPEL のパッケージを `packages` に書く案内は、`packages` が `run` より先に入るので成り立たない | `docs/user/images.md`・`.en.md` を直し、EPEL の有効化と導入を同じ `run` の中で順に行う例にした |
| [提案] `curl --retry 3` には時間の上限が無く、応答が止まるとビルドが止まり続ける | `install-drawio.sh` の curl に `--connect-timeout 30 --speed-limit 1024 --speed-time 60 --max-time 900 --retry-max-time 1200` を足した（大きなファイルなので、遅い回線でも通るよう、止まったことは転送の速さで見る） |
| [提案]（再レビュー）`--retry-max-time 1200` は再試行を始める期限で、始めた転送を止めないので、「再試行を含めて 20 分まで」の説明と合わない | 厳密な全体の上限は要らない（止まり続けることは無くなった）ので、`install-drawio.sh` のコメントと仕様書（日英）を、1 回 900 秒・再試行は最初から 1200 秒を過ぎたら始めない・全体は 1200 秒を超えうる、に直した |
| [提案] Xvfb の起動を待っている間に SIGTERM・SIGINT を受けると、Xvfb が残る | `drawio-shim.cjs` で、シグナルの処理を最初に置き、起動した Xvfb をすぐに覚えて、draw.io の起動前なら Xvfb を止めて終わるのを待ってから終わるようにした。回帰テストを足し、直す前の版で落ちることを確かめた |
| [提案] 標準エラー出力をチャンクごとに文字列にすると、UTF-8 の文字の途中で分かれたときに壊れる | draw.io と Xvfb の標準エラー出力と `-displayfd` の出力を `setEncoding("utf8")` で復号するようにした。回帰テストを足し、直す前の版で落ちることを確かめた |
| [提案] `npx sacty image build` だけでは、Docker のキャッシュに当たれば OS のセキュリティの更新は入らない | ユーザードキュメント（日英）を直し、入るのは作った時点の版で、更新には元のイメージの取り直しかビルドのキャッシュの消去が要ることを書いた。ADR と `install-tools.sh` のコメントも直した |

## 残したこと

- GitHub のリリースに届かない環境向けに、draw.io のパッケージの取得先を社内のミラーに向ける設定（利用者の判断を待っている）。
- 既定の `node:22-bookworm-slim` と RHEL 系の元のイメージでの実際のビルド。
