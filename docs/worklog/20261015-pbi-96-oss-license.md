# sacty を MIT の OSS として公開するために、LICENSE・コントリビュート・セキュリティの文書を足し、公開して困るものを調べる

- 日付: 2026-10-15（UTC）
- タスク: PBI-96
- PR: なし
- ブランチ: feat/issue-96-oss-license
- 関係する ADR: [sacty を MIT ライセンスの OSS として公開し、コントリビュートと脆弱性の報告の窓口を文書にする](../adr/20261015-0015-oss-license-mit.md)

## 目的

公開しているリポジトリに、ライセンス（MIT。ステークホルダーが決めた）と、外から参加・報告するための最低限の文書を足す。
あわせて、依存と同梱物のライセンスが MIT と両立するか、今のファイルと git の履歴に公開して困るものが無いかを調べる。

## したこと

- ライセンス：ルートに `LICENSE`（MIT。`Copyright (c) 2026 sert-xx`）を置いた。ルート・`apps/daemon`・`apps/web`・`packages/core`・
  `packages/cli` の package.json に `"license": "MIT"` を足し、`package-lock.json` の各ワークスペースの欄にも反映した
  （`npm install --package-lock-only --offline`。ほかの差分は無い）。`"private": true` は変えていない（理由は ADR）。
- 文書：ルートに `CONTRIBUTING.md`（開発の環境・変更の流れ・PR を出す前に確かめること・docs の方針の要点）と `SECURITY.md`
  （対象のバージョン・GitHub の非公開の報告での報告の仕方）を足し、`README.md` にこれらと LICENSE へのリンクを足した。
  行動規範は置かなかった（理由は ADR）。
- docs のテスト（`tests/docs/docs.test.ts`）：リンク切れを確かめる対象に `CONTRIBUTING.md`・`SECURITY.md` を足した。LICENSE が MIT で
  README からライセンス・コントリビュート・セキュリティへリンクしていること、各 package.json の `license` が MIT であることを確かめる
  テストを足した。
- 公開して困るもの：今のファイルで見つかったものを直した（下の「公開して困るものの調査」）。

### 依存のライセンスの調査

`package-lock.json` の各パッケージの `license` と、`node_modules` の各 package.json の `license` の欄で調べた（ネットワークは使っていない）。
対象は 571 個（ワークスペースへのリンクを除く。開発用・任意のものを含む）。`license` の欄が無いものは無かった。

| ライセンス | 数 | 扱い |
| --- | --- | --- |
| MIT | 458 | 両立する |
| ISC | 25 | 両立する |
| MPL-2.0 | 24 | 開発用だけ（`lightningcss` と各 OS 用の版。Tailwind CSS のビルドで使う）。ファイル単位のコピーレフトで、改変して配るときだけ義務がある。sacty のソースには入らない |
| Apache-2.0 | 21 | 両立する |
| MIT OR Apache-2.0 | 9 | 開発用（Biome） |
| BSD-3-Clause・BSD-2-Clause・0BSD | 14 | 両立する |
| LGPL-3.0-or-later（`Apache-2.0 AND` を含む） | 14 | 任意の依存（`next` → `sharp` の libvips の各 OS 用の版）。ビルド済みの共有ライブラリで、インストールしたときに利用者の環境に入る。sacty は改変も同梱もしない。画面は `next/image` を使っていない |
| OFL-1.1 | 2 | `@fontsource/ibm-plex-mono`・`@fontsource/ibm-plex-sans-jp`。フォントをソフトウェアと一緒に使うのは許されている（フォントだけを売ることは禁止） |
| BlueOak-1.0.0 | 2 | `isexe`・`minimatch`。寛容なライセンス |
| CC-BY-4.0 | 1 | `caniuse-lite`（ブラウザの対応のデータ。ビルドで使う）。表示の義務はパッケージの中の表示で足りる |
| MIT OR CC0-1.0 | 1 | `type-fest` |

- GPL・AGPL などの強いコピーレフトのものは無かった。
- npm の依存のほかに、`sacty image build` が利用者の環境で、元のイメージ（既定は `node:22-bookworm-slim`）に OS のパッケージと
  エージェントの CLI（`@anthropic-ai/claude-code`・`@openai/codex`）を入れる。これらは利用者の環境でダウンロードして作り、sacty の
  リポジトリには含めず配らない。それぞれの利用条件は、それぞれの提供元のものに従う。

### 同梱しているものの出どころ

- `assets/sacty-icon.svg`・`assets/sacty-icon.png`、`apps/web/src/app/favicon.ico`・`icon.svg`・`apple-icon.png`：PBI-68 でこのリポジトリのために
  作ったもの（[作業履歴](20261013-pbi-68-slack-sender.md)）。それより前の `favicon.ico`（最初のコミットで足したもの）は、そのときに差し替えた。
- `apps/web/src/components/ui/`：shadcn/ui の CLI が生成したコンポーネント（`apps/web/components.json`）。shadcn/ui は MIT で、
  コピーして使う前提のもの。
- フォント：リポジトリには置かず、`@fontsource` の npm パッケージから読む（上の表の OFL-1.1）。
- 既定のコンテキスト（`apps/daemon/default-context/`）のレビューのスキルなどは、PBI-65 などでこのリポジトリのために書いたもの。
  ほかから写したという記録は見つからなかった。

### 公開して困るものの調査

今の追跡しているファイル（`git ls-files`）と、すべての参照の履歴（`git log -p --all` の追加・削除の行と、コミットのメッセージ）を、
次の形で調べた：トークン・鍵の形（GitHub・Slack・AWS・Anthropic・OpenAI・Google・npm・JWT・秘密鍵）、`password=` などの代入、
プライベートの IP アドレス、ホームのディレクトリのパス、メールアドレスのドメイン、URL とドメイン名、公開リポジトリで使わないと
決めた語、組織を指す語（「会社」などの一般的な語は、架空の例として使っているだけだった）。あわせて、PR の題と本文（`gh pr list --state all`）も調べた。

- 秘密の値：見つかったトークン・鍵の形のものは、すべてテスト（伏せる処理のテスト）の作り物で、今のファイルにも同じ値がある。
  履歴にだけある秘密らしい値は無かった。
- 内部の URL・組織の名前：URL・ドメインは `example.com` などの架空のもの、公開のサービス（GitHub・Slack・AWS・1Password など）、
  `127.0.0.1`・`host.docker.internal` だけだった。プライベートの IP アドレスは、Rancher Desktop のホストのアドレスの説明だけ。
- 個人の情報：コミットの作者のメールアドレス（コミットの情報）のほかに、テストの Slack のメンションの例に個人の名前が1つあった。
  今のファイルでは架空の名前（`@alice`）に直した。履歴にはそのまま残る。PR の本文（1件）に、別の GitHub のアカウント名が残る。
- 公開リポジトリで使わないと決めた語：今のファイルでは、テスト（`apps/daemon/src/daemon.test.ts`）のプラットフォームの説明の例の
  4か所にあったので、一般的な言い方に直した。履歴には、コミットのメッセージ（8件）とファイルの差分（8件のコミット）、PR の本文
  （2件）に残る。いずれもすでに `main` に入っている。場所は PR でステークホルダーに報告する。履歴は書き換えない。

## 確かめたこと

- `npm run lint`：終了コード 0（216 ファイル）。
- `npm run typecheck`：終了コード 0。
- `npx vitest run`：57 ファイル・1373 件が通った。
- `npm run build`：終了コード 0。
- `npx vitest run tests/docs`：68 件が通った。足したテストは、`apps/web/package.json` の `license` を消す・`CONTRIBUTING.md` のリンクを
  壊すと失敗することを確かめた。
- 確かめていないこと：GitHub の非公開の報告の窓口は、リポジトリの設定で無効になっている（`gh api` で確かめた）。有効にするのは
  リポジトリの設定の変更なので、このタスクではしていない。依存のライセンスは package.json の欄で調べ、各パッケージの LICENSE の
  本文までは読んでいない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | — |

## 残したこと

- LICENSE の著作権者の表記（`sert-xx`）は、PR でステークホルダーに確かめる。
- GitHub の非公開の報告を有効にする（リポジトリの設定）。
- 履歴と PR の本文に残る語・個人の名前・アカウント名は書き換えていない（ステークホルダーの判断）。
- npm に公開するか（`private` を外すか）は決めていない。
