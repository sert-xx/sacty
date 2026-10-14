# タスク詳細を読みやすくする

- 日付: 2026-10-10（UTC）
- タスク: PBI-12
- PR: #17
- ブランチ: feat/issue-12-task-readability
- 関係する ADR: [エージェントの成果物とチケットの本文を、信頼しない前提で Markdown として描画する](../adr/20261010-2221-render-agent-markdown-safely.md)

## 目的

動作確認のフィードバックのうち、タスク詳細の画面の4点に対応する。

- エージェントが書いた Markdown を、見出し・箇条書き・表・コードなどとして出す。
- 承認済みの成果物は折りたたむ。
- 工程をチケットより上に出す。
- 完了したタスクには「一時停止」「中止」を出さない。
- 日本語・英語で崩れず、スマホの幅でもはみ出さない。

## したこと

- Markdown の描画：`apps/web/src/components/markdown.tsx`（`react-markdown` と `remark-gfm`、版を固定。依存は `apps/web/package.json`）。
  生の HTML・`javascript:` などの URL・画像を描画せず、リンクは別のタブで開いて参照元を渡さない。
- 折りたたみ：`apps/web/src/components/card-section.tsx`。承認済みの要求要件・設計と、完了したタスクの実装を折りたたむ。
- タスク詳細（`apps/web/src/app/tasks/[id]/page.tsx`）で工程をチケットより上に出し、成果物チェックの画面（`apps/web/src/app/tasks/[id]/review/page.tsx`）・
  実装の説明・変更の申し出も Markdown で出すようにした。
- 完了・中止したタスクに操作を出さない判定を `apps/web/src/lib/labels.ts` に足した。
- リンターの指摘を直すコミットを足した。

## 確かめたこと

- `npm test`：205件が通った（3件追加）。Markdown の描画（見出し・リスト・チェックリスト・表・行内とブロックのコード）、HTML・スクリプト・`javascript:` の URL・画像を
  描画しないこと、リンクの target と rel、完了・中止したタスクに操作を出さないことを確かめた。
- `npm audit` で、新しく加えた依存による脆弱性が増えていないことを確かめた。
- 画面で、実際に Claude Code で完了まで進めたタスク（テスト用のリポジトリ）を見た。工程が上に出ること、承認済みの成果物と実装が折りたたまれること、
  「中止」が出ないこと、設計を開くと見出し・表・行内のコードが読みやすく出ること、スマホの幅（375px）で横にはみ出さないことを確かめた。
- レビューでは `npm test`・`npm run lint`・`npm run typecheck`・`npm run build -w @sacty/web`・`git diff --check` が通ったことを確かめ、大文字と小文字が混ざった URL・
  文字参照を使った危険な URL・data の画像・iframe を描画しないことと、折りたたみのカードの最初の HTML を確かめた。ブラウザでの日本語・英語の見た目、
  375px の幅でのはみ出し、開閉の操作は、レビューでは確かめていない。

## レビューの指摘と対応

指摘は無かった（承認のみ）。

## 残したこと

なし
