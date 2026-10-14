# 外への通信が制限された環境でも画面をビルドできるようにする

- 日付: 2026-10-12（UTC）
- タスク: PBI-39
- PR: #45
- ブランチ: feat/issue-39-offline-fonts
- 関係する ADR: [画面のビルドで npm のレジストリ以外の外部に取りに行かず、フォントは npm のパッケージから読む](../adr/20261012-1406-build-without-external-fonts.md)

## 目的

利用者の環境で `npm install` の後の `npm run build` が、`Can't resolve '@vercel/turbopack-next/internal/font/google/font'` で失敗していた。
画面のフォントを `next/font/google` で読み込んでいて、ビルドのときに Google Fonts に取りに行くが、利用者の環境からは届かないため。
受け入れ条件の要点は、ビルドで npm 以外の外部に取りに行かないこと、フォント（IBM Plex Sans JP・IBM Plex Mono）の見た目を変えないこと、
npm のレジストリだけが使える前提で `npm install`・`npm run build` が通ること。

## したこと

- 画面のフォントを、npm のパッケージ `@fontsource/ibm-plex-sans-jp`・`@fontsource/ibm-plex-mono`（5.3.0。2週間以上前の版）から読むようにした
  （`apps/web/src/app/layout.tsx`・`apps/web/src/app/globals.css`・`apps/web/package.json`）。
- 実際の git を動かすコンテキストのテストが、まとめて実行して重いときに5秒で時間切れになっていたので、その上限を延ばした
  （`apps/daemon/src/context.test.ts`。#42 の `repository.test.ts` と同じ対応）。

## 確かめたこと

- まっさらな clone で `npm install` してから、macOS の sandbox-exec で外への通信を遮断して `npm run build` を実行した
  （遮断が効いていることは、同じ条件で fonts.googleapis.com への接続が EPERM になることで確かめた）。
  - 直す前の main：`Failed to fetch IBM Plex Mono from Google Fonts` でビルドが失敗した（利用者の環境と同じ原因）。
  - このブランチ：ビルドが通り、成果物に Google Fonts の参照も無かった。
- 画面で、IBM Plex Sans JP（400・600）と IBM Plex Mono が読み込まれ、外部へのリクエストが0件であることを確かめた。
- `npm test`（418件）・`npm run lint`・`npm run typecheck` が通った。
- レビューでは、npm ci で入れ直した上で外への通信を遮断して `npm run build` が通ること、生成した CSS に両フォントが含まれ
  Google Fonts の参照が無いこと、IBM Plex Sans JP の 400/500/600/700 と IBM Plex Mono の 400/500 が保たれていることを確かめた。
  ブラウザでの実際の描画の比較と、利用者の環境での実行は未実施。

## レビューの指摘と対応

指摘は無かった（承認のみ）。

## 残したこと

- 利用者の環境で、`npm install` の後に `npm run build` が通ること、画面のフォントがこれまでと同じに見えることを確かめる（PR で依頼した）。
