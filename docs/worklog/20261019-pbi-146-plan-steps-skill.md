# オーケストレーターの工程の選択を既定のスキル plan-steps にし、答えの JSON を検査してから出させる

- 日付: 2026-10-19（UTC）
- タスク: PBI-146
- PR: #162
- ブランチ: feat/pbi-146-plan-steps-skill
- 関係する ADR: [オーケストレーターにもコンテキストを渡し、工程の選択を既定のスキル plan-steps にして答えの JSON を検査させる](../adr/20261019-1512-orchestrator-plan-steps-skill.md)

## 目的

オーケストレーターが工程を選べているのに、答えの JSON の末尾の `}` が欠けて「選んだ工程を読み取れませんでした」で止まった。
工程の選択の手順を既定のコンテキストのスキルにし、答えの JSON を `jq` などで検査して通るまで直してから出させる。

## したこと

- 既定のスキル `plan-steps`（`apps/daemon/default-context/skills/plan-steps/`）：SKILL.md に、従う順・手順（依頼を読む → タスクと対象を読む → 候補を比べる →
  項目を埋める → 検査する → 1 回だけ出す）と答えの JSON の決まりを書き、`references/json-check.md` に、ファイルに書いて `jq`・`python3`・`node` のどれかで
  構文と形を検査し、通るまで直す手順を書いた。sacty の名前は使うが、特定の言語のツールチェーンには寄せない（検査の道具を複数並べる）。
- 指示（`apps/daemon/src/prompts.ts`）：`PLAN_SKILL`・`planAnswerLines` を足し、対象リポジトリあり・なしの両方のオーケストレーターの指示で、答えの形の前に
  「スキルに従う」「道具で検査して通るまで直す」「最後に 1 回だけ出す」を書くようにした。
- デーモン（`apps/daemon/src/service.ts`）：オーケストレーターの実行（`askOrchestrator`）にコンテキストが渡っていなかったので、工程の実行と同じく
  `runContext` で用意して渡し、`ContextResolved` を記録し、終わったら消すようにした。用意できなければ実行せずに `OrchestratorFailed` で止める
  （秘密の値は伏せる）。`runGuardian` に `context`・`contextMcp`・`estimateCost` を渡せるようにした。
- テスト：`default-skills.test.ts`（スキルの文言と検査の手順）、`context-template.test.ts`（既定のスキルの一覧）、`prompts.test.ts`（両方の指示の文言と
  位置）、`daemon.test.ts`（オーケストレーターに規則とスキルが置かれ、工程の選択と同じ実行 ID で記録される。用意できなければ実行せずに止め、トークンを出さない）。
- 仕様書（`docs/spec/context.md`・`tasks-and-steps.md` と英語の版）・ユーザードキュメント（`docs/user/context.md` と英語の版）を直し、ADR を足した。

## 確かめたこと

- `npm run lint`：通過（354 ファイル）。`npm run typecheck`：通過。
- `npx vitest run apps/daemon packages/core tests/docs`：62 ファイル・1888 件が通過（新しいテスト：スキルの文言、既定のスキルの一覧、両方の指示の文言、
  オーケストレーターへのコンテキストの受け渡しと記録、用意できないときの停止と秘密の値の伏せ）。
- DA のセルフレビュー（受け入れ条件との照合）：スキルの置き場所と中身、両方の指示、オーケストレーターにスキルが届くこと、テスト、仕様書の日英・ADR。
- 実際のコンテナでの動作確認はしていない（手元に実行の環境が無い）。運用の環境では、タスクを 1 つ作り、オーケストレーターのセッションログに
  `plan-steps` の SKILL.md を読んだ記録と `jq`（または `python3`・`node`）での検査があること、工程の選択の記録に `ContextResolved` が同じ実行 ID で
  並ぶことを確かめる。
- 知っている限界：チケットを読んでリポジトリ・題・概要を決める実行（`TicketTriaged`）と、オーケストレーターへの質問には、今までどおりコンテキストを
  渡していない（この PBI の範囲外）。既定のイメージ（`node:22-bookworm-slim`）には `jq`・`python3` が無いので、スキルの検査は `node` で行われる。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （なし） | |
