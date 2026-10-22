# エージェントのイメージに作業用の CLI と draw.io の CLI を入れ、draw.io の公式のスキルを既定のスキルにする

- 日時: 2026-10-22 01:15 UTC
- ステータス: 採用
- 関係する PR・タスク: なし
- 置き換え元: なし
- 置き換え先: なし

## 背景

既定のイメージは、Claude Code・Codex を動かす Node.js と git だけの最低限のものだった（元の `node:22-bookworm-slim` には `jq` も `rg` も無い）。
既定のスキル（`git`・`plan-steps` など）は `jq` を使う手順を書いており、イメージの `gh` の `--jq` も `jq` があるときだけ使える。エージェントは無い
ツールを別の方法で代えるので、そのたびに手順が長くなり、失敗もしやすい。エージェントは root ではないので、タスクの中で OS のパッケージを入れられない。

また、設計・調査の工程で図を描けるように、draw.io の図を作れるようにしたい。draw.io の公式（jgraph）は、エージェント向けのスキル
（`jgraph/drawio-mcp` の `plugins/<ホスト>/skills/drawio/SKILL.md`）を公開しており、Mermaid の変換・レイアウト・PNG・SVG・PDF への書き出しに
draw.io Desktop の CLI を使う。

制約：

- 元のイメージは、既定の Debian（`node:22-bookworm-slim`）のほか、言語ごとのイメージでは Ubuntu・RHEL 系（Rocky Linux など）がある。
  組織のミラーしか使えない環境や、パッケージのミラーに届かない環境（元のイメージに git が入っていれば作れる）でも作れる必要がある。
- コンテナは `--security-opt no-new-privileges --cap-drop ALL` で、権限を落とした `node` ユーザーで動き、画面（X）も D-Bus も無い。
- draw.io Desktop は Electron のアプリで、Linux 向けには deb・rpm・AppImage・snap がある。どの OS のパッケージのリポジトリにも無い。

## 決定

- 作業用の CLI（`jq`・`rg`・`fd`・`tree`・`file`・`less`・`curl`・`zip`・`unzip`・`xz`・`bzip2`・`patch`・`diff`・`find`・`make`・`ps`・`sqlite3`・
  `python3`・`shellcheck`）を、元のイメージに無いものだけ、元のイメージにあるパッケージの管理のコマンドで、OS の配布元から入れる。
  入れられないものは警告して続ける（`packages/cli/docker/install-tools.sh`）。
- draw.io Desktop の公式のリリースの deb・rpm を、版（`32.4.1`）と SHA-256 を固定して GitHub から取り、Xvfb と一緒に入れる。CJK のフォントも入れる。
  取得できない・入れられないときは警告して続け、ハッシュが合わないときだけ止める。`image_build.drawio: false` で入れないようにできる。
  GitHub に届かない環境のために、`image_build.drawio_mirror` で取得先を組織のミラー（`<URL>/v<版>/<ファイル名>`）に変えられる
  （`packages/cli/docker/install-drawio.sh`）。draw.io の Docker イメージは使わない。
- `drawio` は、画面の無いコンテナで動かすための包むスクリプト（`packages/cli/docker/drawio-shim.cjs`）にする。Xvfb を空いている番号で起動し、
  `--no-sandbox --disable-gpu` で draw.io を動かし、D-Bus が無いことのログを除く。使わない `chrome-sandbox` の setuid は外す。
- draw.io の公式のスキルを、手を加えずにライセンスとともに既定のコンテキストに置く（`apps/daemon/default-context/skills/drawio/`）。SKILL.md の
  SHA-256 をテストで確かめ、上げるときは公式のものをそのまま写す。

## 理由

- ツールの選び方：
  - どの工程でも使え、エージェントがよく使う道具に絞った（JSON・検索・アーカイブ・差分・スクリプト）。言語のツールチェーン（コンパイラ・パッケージの
    管理）は言語ごとのイメージの役目なので入れない。
  - ライセンスは、どれもオープンソース（MIT・Apache-2.0・BSD・GPL・PSF・パブリックドメインなど）。GPL のものも、独立したコマンドとして使うだけで、
    sacty のコードとは結合しない。イメージは利用者が手元で作り、sacty はイメージを配布しない。
  - 脆弱性とメンテナンス：OS の配布元のパッケージにすると、配布元のセキュリティの更新がイメージの作り直しで入り、版を sacty で追わなくてよい。
    組織のミラーの設定もそのまま効く。GitHub から静的なバイナリを取る案は、どの OS でも同じ版にできるが、版とハッシュを sacty が追い続ける必要があり、
    GitHub に届かない環境では入らないので採らなかった。
  - 採らなかったもの：`yq` は、Debian のものが別の実装（Python の jq の包み）で書き方が違うので入れなかった。`ast-grep` などの OS の
    パッケージに無いものは、版とハッシュを追う手間に見合うかがまだわからないので入れなかった。
- 入れられないときに止めない理由：これまでパッケージのミラーに届かない環境でも作れていたので、ツールを足したことで作れなくならないようにする。
  無いツールは、エージェントが別の方法で代えられる（スキルも `jq` が無いときの手順を持つ）。draw.io の公式のスキルも、CLI が無ければ XML で図を作る。
  一方、ハッシュが合わないのは、取得したものが壊れているか、すり替わっているので止める。
- draw.io の取り方：OS のパッケージに無いので公式のリリースから取る。組織のレジストリにあるイメージしか使えない環境があるので、draw.io の Docker
  イメージ（から写す・それを元にする）は使わず、元のイメージの上にパッケージを入れる。GitHub に届かない環境では、組織のミラーから同じファイルを
  取れるようにし、ハッシュは版ごとに固定のものを確かめる（ミラーを信じなくてよい）。並びを GitHub の `releases/download` の下と同じにしたのは、
  GitHub のリリースを中継するリポジトリをそのまま指せるようにするため。AppImage は FUSE が要るので、依存を OS のパッケージで解決できる deb・rpm にした。
  版は、公開から2週間たったもの（`32.4.1`）にした。
- 画面の無いところでの動かし方：Electron の `--ozone-platform=headless` は、試したところ draw.io の書き出しで落ちた（Segmentation fault）ので、
  Xvfb を使う。`xvfb-run` は RHEL 系で別のパッケージになっていることがあり、`xauth` も要るので、包むスクリプトが `Xvfb -displayfd` で直接起動する。
  Chromium のサンドボックスは、no-new-privileges のコンテナでは setuid の補助が効かず、名前空間も使えないので `--no-sandbox` にする。図の元は
  エージェントが書いたものか対象のリポジトリのもので、コンテナ（権限を落とした node ユーザー）がその外側の隔離になる。
- スキルに手を加えない理由：公式のものを追えるように（上げるときに写すだけにする）。sacty に合わせた書き換えは、プロジェクトのコンテキストで
  同じ名前のスキルを置けば上書きできる。

## 影響

- 既定のイメージが大きくなる（試した Ubuntu 24.04 の元のイメージで、作業用の CLI が 85MB ほど、draw.io の CLI と依存・フォントが 800MB ほど。
  展開した大きさ）。小さくしたいときは `image_build.drawio: false` にする。
- 既定のイメージを作るときに、GitHub のリリース（`github.com`・`release-assets.githubusercontent.com`）か `drawio_mirror` に取りに行く。届かなければ警告して draw.io を入れない。
- draw.io の版を上げたら、`drawio_mirror` を使う利用者は、ミラーに新しい版のファイルを置く必要がある。
- draw.io の版を上げるときは、`install-drawio.sh` の版と4つのハッシュ（リリースの `Files-SHA256-Hashes.txt`）を変える。スキルを上げるときは、公式の
  SKILL.md を写し、`apps/daemon/src/default-skills.test.ts` のハッシュを変える。
- 公式のスキルは、Mermaid・XML の詳しい書き方を実行のときに `raw.githubusercontent.com` から取る。届かない環境では、SKILL.md の内容だけで書く。
- 仕様：[エージェントの実行](../spec/agent-execution.md#イメージ)、[コンテキストの合成](../spec/context.md#既定の図用スキル)、
  [設定](../spec/configuration.md#イメージの設定の検査)。
