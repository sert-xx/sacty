# docs の構成と方針を決め、それに従うスキル（Claude Code 用・Codex 用）を置く

- 日付: 2026-10-14（UTC）
- タスク: PBI-80
- PR: #88
- ブランチ: feat/issue-80-docs-structure
- 関係する ADR: [docs を4種類に分け、実装の変更で直すのは仕様書とユーザードキュメントだけにする](../adr/20261014-0816-docs-structure-and-policy.md)

## 目的

ドキュメントを docs の下に、仕様書・ユーザードキュメント・ADR・作業履歴の4種類に分け、種類ごとの目的とメンテナンスの
方針を決める。エージェントが方針に従えるよう、Claude Code 用と Codex 用のスキルをリポジトリに置く。
README の移行・仕様書の本文・過去の ADR と作業履歴は、続くタスクで書く（このタスクでは、ひな形と方針だけ）。

## したこと

- `docs/README.md`：4種類の目的・書く内容・書かない内容・メンテナンスの方針、置かないもの（`docs/pbi`・`docs/sacty`）、共通の規則。
- `docs/spec/README.md`・`docs/user/README.md`：ファイルの分け方・書き方・コードとの対応の書き方・ひな形。
- `docs/adr/README.md`：ファイル名（`YYYYMMDD-HHMM[-<ステータス>]-<スラッグ>.md`、UTC）、ステータス（`superseded`・
  `deprecated`・`rejected`）、置き換えの手順と相互の参照、ひな形。この方針を決めた ADR を1件。
- `docs/worklog/README.md`：ファイル名（`YYYYMMDD-<スラッグ>.md`、UTC、PBI があれば `pbi-<番号>-` で始める）とひな形。
- スキル `sacty-docs`：`.claude/skills/sacty-docs/SKILL.md`（Claude Code）と `.agents/skills/sacty-docs/SKILL.md`（Codex）に同じ内容で置いた。
- `tests/docs/docs.test.ts`：ファイル名の規則・ADR の置き換えの関係・相対リンク・docs/pbi へのリンクの禁止・2つのスキルの一致を確かめる。
  `vitest.config.ts` に `tests/**/*.test.ts` を足した。

## 確かめたこと

- スキルの置き場所（API を使わずに確かめた）：
  - Codex 0.160.0：一時ディレクトリに `.agents/skills`・`.codex/skills`・`.claude/skills` の3か所へ試しのスキルを置き、
    `codex debug prompt-input` を実行すると、`.agents/skills` と `.codex/skills` のスキルが載り、`.claude/skills` は載らなかった。
    このリポジトリでは、ルートとサブディレクトリ（`apps/daemon/src`）のどちらで実行しても、`.agents/skills` の `sacty-docs` が載った。
  - Claude Code 2.1.299：本体に、プロジェクトの `.claude/skills/<名前>/SKILL.md` を読み込む処理がある。
    `claude plugin validate .claude/skills` が通った（front matter が無い・description が無い試しのスキルでは警告が出ることも確かめた）。
- `npx vitest run tests/docs`：通った。規則を破るファイル（日時の誤り・ステータスの綴り・切れたリンク・スキルの片方だけの変更）を
  置くと失敗することも確かめた。
- `npm run lint`・`npm run typecheck`・`npx vitest run`・`npm run build`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| Codex の置き場所の根拠に、確かめていない推測（取り込みの機能の移行先）が混ざっていた | ADR から外し、`codex debug prompt-input` で確かめた事実（`.agents/skills` と `.codex/skills` の両方が読まれる）だけにした |
| docs の入口で、ユーザードキュメント・ADR・作業履歴を「誰が」直すかが書かれていなかった | それぞれ「PR を出す人」「タスクを行う人」と明記した |
| テストでは ADR・作業履歴をサブディレクトリに分けると失敗するのに、規則に書かれていなかった | 各 README に「直下に置く」を書いた |
| 置き換え元のリンク先が無いときに、読み込みの例外で落ちてわかりにくい | 存在を先に確かめ、どのリンクかがわかる失敗にした |
| リンクの `<...>` 形式（空白を含むパス）を途中で切っていた | 正しく取り出すようにし、部品のテストを足した |

## 残したこと

- README の中身のユーザードキュメントへの移行、仕様書の本文、過去の ADR と作業履歴は、続くタスクで書く。
