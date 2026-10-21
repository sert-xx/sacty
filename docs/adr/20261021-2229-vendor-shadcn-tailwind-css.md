# shadcn の tailwind.css を写して置き、shadcn のパッケージに依存しない

- 日時: 2026-10-21 22:29 UTC
- ステータス: 採用
- 関係する PR・タスク: #189
- 置き換え元: なし
- 置き換え先: なし

## 背景

GitHub の Dependabot が、`braces`（3.0.3 以下）のスタックの枯渇によるサービス拒否の脆弱性（GHSA-vfj7-8cjw-p6xm、high）を知らせた。
`braces` は `apps/web` の依存の `shadcn`（4.21.4）から `fast-glob` → `micromatch` → `braces` と入っていた。`braces` の最新の版は 3.0.3 で、
直った版は無い。`shadcn` の最新の版でも `fast-glob` を使うので、`shadcn` を上げても直らない。

画面が `shadcn` から使っているのは、`globals.css` の `@import "shadcn/tailwind.css"`（アニメーションの keyframes と、`data-open` などの
Tailwind の variant）だけで、`fast-glob` などを使う CLI（コンポーネントを足す `shadcn add` など）は実行時にもビルドにも使っていない。

## 決定

- `shadcn` 4.21.4 の `dist/tailwind.css` を `apps/web/src/app/shadcn.css` に写し、`globals.css` からはそれを読む。写しの先頭に、
  写した版と、shadcn の MIT ライセンスの表示を書く。整形は Biome に合わせた（ビルドした CSS は写す前と同じ）。
- `apps/web` の依存から `shadcn` を消す。これで `braces`・`micromatch`・`fast-glob` などが `package-lock.json` から無くなる。
- コンポーネントを足すときは、版を指定した `npx shadcn@<版> add …` をその都度使う（依存には入れない）。`shadcn` の CSS を新しくしたい
  ときは、その版の `dist/tailwind.css` を写し直す。

## 理由

- 直った版が無いので、`npm` の `overrides` で版を上げることはできない。依存を残したまま開発用の依存に移しても、`package-lock.json` には
  残り、通知も消えない。
- 実際に使っているのは 16KB ほどの CSS だけなので、写して置く手間は小さい。CLI を依存に持たないことで、CLI の依存（161 個の
  パッケージが無くなった）の脆弱性の通知も今後受けない。
- sacty の中では、利用者の入力を `braces` のパターンに渡す経路は無く、実際に攻撃できる経路は見つけていない。それでも、通知を残すと
  ほかの本当の通知が見えにくくなるので、依存を消して直す。

## 影響

- `shadcn` の CSS は自動では更新されない。shadcn のコンポーネントを新しい版で足して、その CSS の新しい variant が要るときは、写しを直す。
- 依存のライセンスの調査（MIT と両立するか）は変わらない。写した CSS は MIT で、表示を写しの先頭に残している。
