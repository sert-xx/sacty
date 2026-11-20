# 実装が後に続く要求要件・設計の PR のレビューを、方針と抜けだけにする

- 日付: 2026-11-20（UTC）
- タスク: PBI-419
- PR: なし
- ブランチ: sacty/task-（タスク ID の先頭 8 文字）
- 関係する ADR: [実装が後に続く要求要件・設計の PR のレビューは、方針と抜けだけを見る](../adr/20261120-2000-review-only-direction-and-gaps-before-implementation.md)

## 目的

PBI-395 で、要求要件・設計の PR のレビューが、実装の PR と同じ重さで走り、3件で約 23.7 ドルかかった。実装が後に続く文書の PR は、方針と抜けだけを見て、費用と時間を下げる。

## したこと

- `apps/daemon/src/prompts.ts`：`reviewDocBeforeImplementLines` を足し、PR のレビューの指示に付けた。要求要件・設計の PR で、PR を作ったタスクの `implement` が残っている（`skip` でない）ときだけ、範囲と観点を絞る明示を入れる。
- 既定のスキル `review-dispatch`：`SKILL.md` の規則 9、`pr-review.md` の「実装の前の文書の PR」、`viewpoints.md` の冒頭、起動表の例を足した。汎用の文で、明示があるときだけ当てはまる。
- テスト：`prompts.test.ts` に、明示が入る場合（要求要件・設計・実装を飛ばす前の短い進め方）と、入らない場合（実装の PR・設計だけ・分割・実装を飛ばした・文書作成・取り込んだ PR）を確かめるテストを足した。
- 仕様書（`approval`・`tasks-and-steps`・`context`。日英）、ユーザードキュメント（`intake`。日英）を直した。

## 決めたこと

- 残す観点は D-1・D-2・D-5・D-10・X-1（ADR）。
- 「実装が残る」は、レビューの指示を作る時点の親の `steps` で判定する。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npm run build`・`npx vitest run --no-file-parallelism`（`prompts.test.ts`・`default-skills.test.ts`・`tests/docs` を含む全件）を、レビューの指摘の直しを入れた後のコードで実行し、すべて通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 指示の観点の行が、条件付き観点・X-2・X-3・R の扱いと、D-3・D-4 の代わりの手当てを書かず、`notReviewed` に触れている | 指示の行をスキルと同じにし、手当ての行を足した。`notReviewed` は「見られなかった観点には数えない」にし、スキルの規則 9・テストも合わせた |
| ADR が D-3・D-4 を外す理由と割り当て、採らなかった案を書いていない | 割り当て（D-1・D-2・D-5）、採らなかった案、見直す基準を足した |
| 作業履歴に結果と節が無い | 結果と、2つの節を足した |
| `reviewDocBeforeImplementLines` の不要な export | 外した |
| `intake` の「今までどおりの範囲で」 | 範囲を直接書く形にした（日英） |

## 残したこと

なし
