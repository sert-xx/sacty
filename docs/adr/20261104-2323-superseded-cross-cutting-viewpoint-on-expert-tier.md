# 横断の観点 X-1 を expert で動かし、ultimate は既定で使わない

- 日時: 2026-11-04 23:23 UTC
- ステータス: 置き換え済み（superseded）
- 関係する PR・タスク: PBI-304
- 置き換え元: [段階に expert を足して 6 つにし、ultimate を各ツールの最上位のモデルにする](20261104-1327-superseded-expert-tier-between-advanced-and-ultimate.md)（観点ごとの段階を変えないとした部分）
- 置き換え先: [既定のレビューの観点ごとの段階を下げ、expert も既定で使わない](20261114-1354-lower-review-viewpoint-tiers.md)（X-1 を expert で動かすとした部分）

## 背景

段階に `expert` を足したとき、観点ごとの段階は変えなかった。そのため X-1 は `ultimate` のままで、最上位のモデル（`gpt-6-astra`・`claude-fable-5-1`）で動くようになった。

## 決定

- 既定の review スキルの観点ごとの段階で、X-1 を `expert` にする。
- `ultimate` は、既定の観点・工程のどれにも割り当てない。ステークホルダーの決定（「ultimate は基本的に使わないようにしたい」）。
- 段階と既定のエージェントの `codex_ultimate`・`claude_ultimate` は残す。`step_agents` やタスクの工程のエージェントで人が選べば使える。

## 検討した案

- **`ultimate` の段階を消す**：使わないなら要らないが、ステークホルダーの指示は「基本的に」使わないことで、人が選ぶ余地は残す。

## 結果

- X-1 は `gpt-6.1-sol`・`claude-opus-5-5` の `high` で動く。
- 既定のままでは `ultimate` のサブエージェントの定義は置かれるが、どの観点からも起動されない。
