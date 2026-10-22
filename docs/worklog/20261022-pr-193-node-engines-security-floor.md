# Node.js の下限（engines）を、2026 年 10 月のセキュリティリリースの修正版 22.23.4 に上げる

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #193
- ブランチ: claude/nodejs-vulnerability-check-s4ya8n
- 関係する ADR: [Node.js の下限（engines）を、脆弱性を直した版の 22.23.4 に上げる](../adr/20261022-0351-node-engines-security-floor.md)

## 目的

2026-10-21 の Node.js のセキュリティリリースで 22.x の修正版が v22.23.4 になったので、直していない版を `engines` の条件から外し、利用者向けの「必要なもの」も合わせる。

## したこと

- `package.json` と `package-lock.json`（ルートのパッケージ）の `engines.node` を `>=22.13` から `>=22.23.4` にした。
- `README.md`・`README.en.md`・`CONTRIBUTING.md`・`docs/user/getting-started.md`・`docs/user/getting-started.en.md` の Node.js の版を 22.23.4 以上にした。
- `apps/daemon/src/context-fetch-exit.test.ts` の、型の取り除きのフラグを付ける理由のコメントを、新しい `engines` に合わせた（コードは変えていない）。
- ADR を足した。

イメージの既定（`node:22-bookworm-slim`）は変えていない。Docker Hub の API で、2026-10-22 の時点で `node:22-bookworm-slim` と `node:22.23.4-bookworm-slim` の
digest が同じであることを確かめた。ただし `sacty image build` は `docker build` に `--pull` を付けず、前もって取り直しもしない（`apps/daemon/src/image.ts` の `imageBuildArgs`）ので、
手元に古い `node:22-bookworm-slim` があると、作り直しただけでは修正版にならない。`docker pull node:22-bookworm-slim`（`image_build.base_image`・`node_image` を書いていればそのイメージ）で取り直してから作り直す。

## 確かめたこと

- `npx vitest run tests/docs`：2 ファイル・89 件が通った。
- `npx vitest run apps/daemon/src/context-fetch-exit.test.ts`：4 件が通った（Node v22.22.0）。
- `npx biome check package.json apps/daemon/src/context-fetch-exit.test.ts`：指摘なし。
- レビューの対応の後に `npx vitest run tests/docs`：89 件が通った。
- Node v22.22.0 で `npm ci` を実行すると、`npm warn EBADENGINE`（`required: { node: '>=22.23.4' }`）が出て、インストールは止まらずに終わった。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA・提案）可変のタグが修正版を指すことと、手元の元のイメージが新しくなることは別。`imageBuildArgs` は `--pull` を付けないので、取り直してから作り直す条件を ADR と作業履歴に書く | `imageBuildArgs` に `--pull` が無く、前もって取り直さないことをコードで確かめ、ADR の理由と作業履歴の「したこと」に、`docker pull` で取り直してから作り直すことを書いた |

## 残したこと

- 元のイメージの条件が「Node.js 18 以上」のままで、サポートが終わった 18・20 の Node.js のイメージも使える。条件を上げるかは決めていない。
- この作業用の環境の Node.js が v22.22.0（新しい下限より古い）で、22.23.4 以上で動かして確かめてはいない。
