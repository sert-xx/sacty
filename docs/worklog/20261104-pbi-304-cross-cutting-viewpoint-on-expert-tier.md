# 横断の観点 X-1 を expert にし、ultimate を既定で使わない

- 日付: 2026-11-04（UTC）
- タスク: PBI-304
- PR: なし
- ブランチ: feat/issue-304-x1-expert-tier
- 関係する ADR: [横断の観点 X-1 を expert で動かし、ultimate は既定で使わない](../adr/20261104-2323-cross-cutting-viewpoint-on-expert-tier.md)

## 概要

- 既定の review スキルの観点カタログと起動表の例で、X-1 の段階を `ultimate` から `expert` に変えた。
- ユーザードキュメント（日英）の段階の表の「想定する使い方」を合わせた。
- 既定で `ultimate` を指すものが残っていないことを確かめた（`step_agents` の既定は無く、工程のエージェントの候補は人が選ぶ画面だけ）。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run --maxWorkers=2`：204 ファイル、4151 件通過・3 件スキップ。既定の並行数で流したときは、メモリの不足でプロセスが強制終了されたので、並行数を絞った。
- `git grep ultimate` で、観点の表・起動表の例に `ultimate` が残っていないことを確かめた。

## セルフレビュー（DA）

- 受け入れ条件 1〜5 を満たす。工程の既定（`step_agents`）に `ultimate` を指すものは無く、自動で段階を選ぶ処理も無い。
- 残るもの：`codex_ultimate`・`claude_ultimate` は、タスクの工程のエージェントの候補に出る。人が選ぶ画面なので、決定（人が選べば使える）どおり。
