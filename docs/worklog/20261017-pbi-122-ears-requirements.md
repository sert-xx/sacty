# 要求要件を EARS 形式で整理する

- 日付: 2026-10-17（UTC）
- タスク: PBI-122
- PR: なし
- ブランチ: feat/issue-122-ears-requirements
- 関係する ADR: [要求要件の受け入れ条件を EARS 形式で書かせ、既定のスキル ears-requirements を同梱する](../adr/20261017-0130-ears-requirements.md)

## 目的

要求要件の受け入れ条件を、EARS（Easy Approach to Requirements Syntax）の決まった文型で書かせる。
書き方をそろえ、抜けと曖昧さに気づきやすくする。

## したこと

- 既定のコンテキスト：スキル `ears-requirements`（`SKILL.md`・`references/patterns.md`）を足した。文型（日英）、使い分け、ID、書き方の決まり、見直し、例と直す例を持つ。
- daemon（`apps/daemon/src/prompts.ts`）：要求要件の工程の指示で、受け入れ条件を EARS の形式で書かせ、スキルに従わせる（`earsLines`）。文型・ID・異常系の書き方は指示にも書いた。
- docs：仕様書（コンテキストの「既定の要求要件用スキル」）、ユーザードキュメント（コンテキスト）、ADR。英語の版も直した。

## 確かめたこと

- `npx biome check`・`npm run typecheck`・`npx vitest run`・`npm run build` が通った。
- 回帰テスト（`prompts.test.ts`）：要求要件の指示に EARS の行・文型・ID・異常系があり、古い文言が無い。タスク分割の子タスク・差し戻しのやり直しでも同じ。ほかの工程には出ない。
- 回帰テスト（`default-skills.test.ts`）：スキルの名前・文型（日英）・優先する指示・ID・見直しがあり、sacty に限った書き方が無い。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

- 実機の AI が EARS で書くかは、この環境では確かめていない（AI の設定が無い）。
