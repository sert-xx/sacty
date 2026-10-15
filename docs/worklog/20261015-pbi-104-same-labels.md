# 取り込むラベルとレビュー用のラベルに同じ名前を保存できるようにする

- 日付: 2026-10-15（UTC）
- タスク: PBI-104
- PR: なし
- ブランチ: feat/issue-104-same-labels
- 関係する ADR: [取り込むラベルとレビュー用のラベルに同じ名前を許す](../adr/20261015-0850-allow-same-intake-and-review-label.md)

## 目的

「sacty の設定」の、Issue の取り込みの「取り込むラベル」と、PR のレビューの取り込みの「PR のレビュー用のラベル」に、同じ名前
（大文字・小文字だけの違いも）を保存できるようにする。PBI-99 で保存のときに拒否していた。同じ名前のときも、Issue は通常のタスク、PR は
レビューだけのタスクになり、sacty が作った PR はレビューだけのタスクとして1回だけ取り込まれ、指摘は元のタスクに届くことを確かめる。

## したこと

- 設定（`packages/core/src/projects.ts`）：保存のときの型 `SactySettingsUpdate`（同じ名前を拒否する検査）を消した。保存は
  `apps/daemon/src/service.ts` の `saveSettings` で、読み込みと同じ `SactySettings` で検査する。
- 文言（`packages/core/src/messages.ts`）：`input.sameIntakeAndReviewLabel` を日本語・英語ともに消した。
- 取り込みの振る舞いは変えていない（検索は `is:issue`・`is:pr` で分かれ、取り込みの判定でも PR を取り込むラベルで通常のタスクにせず、
  Issue をレビュー用のラベルでレビューのタスクにしないため）。
- 画面（`apps/web/src/i18n/messages/settings.ts`）：「PR のレビューの取り込み」の説明に、取り込むラベルと同じ名前にもできることと、
  Issue と PR がそれぞれどちらで取り込まれるかを足した（日本語・英語）。
- テスト：
  - `apps/daemon/src/daemon.test.ts`：同じ名前・大文字・小文字だけ違う名前を保存でき、Issue は通常のタスク、PR はレビューだけのタスクになり、
    どちらの検索で見つかっても入れ替わらず、二度取り込まないこと。API でも保存できること。以前の版で同じ名前を保存した設定を、そのまま
    保存し直せること（拒否を確かめていた PBI-99 のテストを置き換えた）。sacty の PR にレビュー用のラベル（取り込むラベルと同じ名前）が
    1回だけ付き、両方の検索で見つかってもレビューだけのタスク（`sacty`）1つになり、実装のタスクにならず、レビューが元のタスクに PR の
    指摘として届くこと。
  - `apps/daemon/src/intake.test.ts`：定期の取り込みで、同じ名前のとき2つの検索を行い、Issue は通常のタスク、PR はレビューだけのタスクに
    し、次の回に二度取り込まないこと（偽の検索は `is:issue`・`is:pr` で絞らないので、どちらの検索にも Issue と PR の両方が返る）。
  - `apps/web/src/app/actions.test.ts`：拒否の理由を返すテストの例を、同じ名前のラベルから使えない文字のラベルに変えた。
- docs：仕様書（intake）、ユーザードキュメント（intake）を日本語・英語で直した。ADR を足し、PBI-99 の ADR（同じ名前を拒否する部分）を
  superseded にし、リンクを直した。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（1489 件）・`npm run build`・`npx vitest run tests/docs`（89 件）が通る。
- 修正を戻すと落ちること：`packages/core/src/projects.ts`・`packages/core/src/messages.ts`・`apps/daemon/src/service.ts` を修正の前に戻すと、
  足した・直したテスト5件（daemon 4件・intake 1件）が落ちる。
- 動作確認の動画（一時的な SACTY_HOME・別のポート）：設定の画面で2つのラベルに同じ名前・大文字・小文字だけ違う名前を保存でき、
  読み込み直しても残ること、説明の文（日本語・英語）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （自己レビュー）拒否の理由を返す web のテストが、もう起きない「同じ名前のラベル」を例にしている | 使えない文字のラベルの例に変えた |
| （自己レビュー）仕様書の「コード:」に、消した `SactySettingsUpdate` が残っている（`tests/docs` が落ちた） | 参照から消した |

## 残したこと

- 本物の GitHub での取り込み（テストの偽物でだけ確かめた）。
