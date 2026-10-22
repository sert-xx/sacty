# Node.js の下限（engines）を、脆弱性を直した版の 22.23.4 に上げる

- 日時: 2026-10-22 03:51 UTC
- ステータス: 採用
- 関係する PR・タスク: #193
- 置き換え元: なし
- 置き換え先: なし

## 背景

2026-10-21 に Node.js のセキュリティリリース（[October 2026 Security Releases](https://nodejs.org/ja/blog/vulnerability/october-2026-security-releases)）が出た。
22.x にも重大度 High の脆弱性があり（Brotli のデコーダーの境界外書き込み、TLS の証明書のホスト名の検証の回避など）、22.x で直した版は v22.23.4。
sacty の `engines` は `>=22.13` で、直していない 22.x の版（22.13〜22.23.3）も条件を満たしていた。sacty のデーモンは GitHub や AI の API に TLS で接続するので、
TLS の証明書の検証の脆弱性が sacty にも関わる。

## 決定

- ルートの `package.json` の `engines.node` を `>=22.23.4` にする（`package-lock.json` の同じ項目も合わせる）。
- 利用者向けの「必要なもの」（README・はじめに・CONTRIBUTING）の Node.js の版も 22.23.4 以上にする。
- エージェント実行用のイメージ（`packages/cli/docker/Dockerfile` の `node:22-bookworm-slim`）と、元のイメージの条件（Node.js 18 以上）は、この決定では変えない。

## 理由

- 直していない版で動かしていることを、`engines` と「必要なもの」で利用者にわかるようにするため。
- 下限を 22.x の修正版にし、24.x の LTS に上げなかったのは、22.x がまだサポート中で、今の下限の系列のまま直せるため。
- イメージの既定のタグは版を固定していないので、作り直せば修正版になる（2026-10-22 の時点で `node:22-bookworm-slim` は `22.23.4-bookworm-slim` と同じイメージ）。
  版を固定すると、次の修正版のたびに手で直すことになるので、今は固定しない。

## 影響

- 22.23.4 より古い Node.js では、`engines` の条件を満たさなくなる。利用者は Node.js を 22.23.4 以上（24.x・26.x の修正版を含む）に上げる。
- `@types/node`（`^22.13.0`）は型の定義なので変えない。
- 型の取り除きが既定で切れている版（22.17 以前）のための、テストの `--experimental-strip-types` の付け足しは、`engines` より古い Node.js で動かされたときのために残す。
- 次に Node.js の脆弱性の修正版が出たときに、下限を上げるかは、その都度決める（決まりは作っていない）。
