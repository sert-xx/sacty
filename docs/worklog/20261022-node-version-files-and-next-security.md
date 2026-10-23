# Node.js の版の管理ツール用のファイルを足し、Next.js（16.4.2）と ip-address（10.7.4）を脆弱性を直した版に上げる

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/charming-darwin-rkt2o7
- 関係する ADR: [Node.js の版を、版の管理ツール用の `.node-version` と `mise.toml` にも書く](../adr/20261022-2347-node-version-files.md)

## 目的

- Node.js の脆弱性の対応で `engines.node` を `>=22.23.4` にしたのに合わせ、版の管理ツールが読むファイルを置き、開発する人が直した版を使うようにする。
- Next.js 16.4.0 の脆弱性を直す。
- `npm audit` に残っていた `ip-address` の脆弱性を直す。

## したこと

- ルートに `.node-version`（`22.23.4`）と `mise.toml`（`[tools]` の `node = "22.23.4"`）を足した。
- `CONTRIBUTING.md`・`docs/user/getting-started.md`・`docs/user/getting-started.en.md` に、2つのファイルに版を書いていることを書いた。
- `apps/web/package.json` の `next` を `16.4.0` から `16.4.2` にし、`package-lock.json` を更新した（`@next/env`・`@next/swc-*` も 16.4.2 になり、`sharp` の範囲が `^0.35.5` になった）。
  `npm audit` が 16.0.0〜16.4.0 に出していた次の3件（まとめて重大度 critical）が、16.4.2 で直っている。
  - [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw)：SVG を使うときの Image Optimization API の、認証なしのリモートコード実行
  - [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr)：型付き配列を返す `use cache` の関数の、認証なしのリモートコード実行
  - [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)：Server Actions を使う App Router のサービス拒否
- `ip-address` を `npm audit fix` で 10.7.3 から 10.7.4 にした（`package-lock.json` だけの変更）。`@modelcontextprotocol/sdk` → `express-rate-limit` が使う間接の依存で、
  [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)（moderate。IPv6 のゾーン識別子の照合が長さの上限の前に二乗の時間がかかり、長い文字列1つで処理が止まる）を直している。
- lockfile は npm 11 で更新した。この環境の npm 10.9.4 で更新すると、lockfile の `libc` の項目が消えるため。

## 確かめたこと

- `npm audit`：`next` の指摘が消えた。`ip-address` を上げた後は `found 0 vulnerabilities`。
- `npm run build`：通った（`▲ Next.js 16.4.2 (Turbopack)`）。
- `npm run typecheck`：通った。
- `npx biome check .`：指摘なし。
- `npx vitest run`（`ip-address` を上げた後にも実行）：2550 件が通り、9 件が失敗した（`agent-sessions`・`context-mcp`・`context`・`host-mcp-processes` のテスト）。
  変更を外した状態でも同じ 9 件が失敗するので、この変更によるものではない。
- この環境の Node.js は v22.22.0 で、22.23.4 で動かして確かめてはいない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 上の 9 件のテストの失敗の原因は調べていない。
