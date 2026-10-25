# 要求要件の受け入れ条件を文型ごとの見出しと表で書き出させる

- 日付: 2026-10-25（UTC）
- タスク: なし
- PR: #222
- ブランチ: claude/peaceful-dirac-gtng7k
- 関係する ADR: [要求要件の受け入れ条件を文型ごとの見出しと表で書き出させる](../adr/20261025-0630-ears-tables-by-pattern.md)

## 目的

要求要件の受け入れ条件が EARS の文の箇条書きで、人が読むときに見比べにくい。
文型ごとに見出しを分け、文型の要素を列にした表で書き出させる。

## したこと

- 既定のスキル `ears-requirements`（`SKILL.md`）に「書き出す形」を足した。文型ごとの見出し・列・セルの書き方と例。書く手順と見直しにも足し、ID に文型の名前を添える書き方を消した。
- 指示（`apps/daemon/src/prompts.ts` の `earsLines`）に、見出しと文型ごとの列を足した。テスト（`prompts.test.ts`）で確かめる。
- docs：仕様書（コンテキスト）とユーザードキュメント（コンテキスト）を日英で直し、ADR を足した。
- 文型と列の名前は、依頼で示された分類（EARS の6つの文型）に合わせた。参照の記事は作業環境から開けなかったので、列の名前（状態・機能）はスキルの文型の名前に合わせた。

## 確かめたこと

- `npx vitest run apps/daemon/src/prompts.test.ts tests/docs`：通った
- `npm run lint`・`npm run typecheck`：通った
