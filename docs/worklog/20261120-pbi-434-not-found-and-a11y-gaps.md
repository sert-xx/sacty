# 無いページを Sacty の画面で案内し、キーボードと読み上げの小さな穴を直す

- 日付: 2026-11-20（UTC）
- タスク: PBI-434
- PR: なし
- ブランチ: sacty が作る PR のブランチ
- 関係する ADR: なし

## 目的

無いページに来た人が次に行く所が分かり、キーボードと読み上げで遠回りしないようにする。
無いページ・描画の例外の画面、「本文へ移動」、補足の印の大きさと名前、ダイアログの閉じるの名前を直す。

## したこと

- `app/not-found.tsx`：ヘッダーつきの「ページが見つかりません」と `/dashboard` へのリンク。タイトルも画面の言語（`generateMetadata`）。
- `app/error.tsx`・`app/global-error.tsx`：「表示できませんでした」と読み直す操作（`retry`）。例外の文・パス・スタックは出さない。
  `global-error` は言語を決められないので日本語に固定。
- `components/shell/skip-link.tsx` と `app/layout.tsx`：「本文へ移動」。`<main>` に `id` と `tabIndex=-1`。
- `ui/hint.tsx`：印を `size-6` にし、`-m-0.5` で行の高さ・並びを 20px のときと同じにする。`label` を渡すと名前が「<ラベル>の補足」。
  `WithHint` と `CardSection` は、ラベルが文字列のときだけ `label` を渡す。
- `ui/dialog.tsx`：× と `DialogFooter` の閉じるを、辞書の `common.close` に。
- `common.ts`：上の文言と、`live.stale` に `sacty up` の確認を添えた文。
- `sacty --help` の `sacty mcp` を 3 行に。できることは `docs/user/mcp.md` を指す。
- `docs/spec/ui-wording*.md`・`docs/user/tasks*.md`。

## 確かめたこと

- `npm run build` 後に `next start`（認証を切って）で確かめた。無い URL は HTTP 404、タイトルは「ページが見つかりません - Sacty」／"Page not found - Sacty"。
  デーモンが無い環境なので、`notFound()` を呼ぶ各ページ（`<Suspense>` の中のものは 200 のまま）の応答は変えていない（実機では未確認）。
- 画面のテスト（ja・en）と、実ブラウザーのテスト（押せる大きさ・行の高さ・Tab と Enter）を足した。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- `CardSection` の見出しの印の名前が区画の名前（`aria-labelledby`）にも入り、題が重なって読まれる。
- `DashboardCard` の見出しの印は、じかに置いた印のまま「補足」。
