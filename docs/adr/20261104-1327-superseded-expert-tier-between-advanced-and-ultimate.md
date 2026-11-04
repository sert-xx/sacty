# 段階に expert を足して 6 つにし、ultimate を各ツールの最上位のモデルにする

- 日時: 2026-11-04 13:27 UTC
- ステータス: 置き換え済み（superseded）
- 関係する PR・タスク: PBI-303
- 置き換え元: なし
- 置き換え先: [横断の観点 X-1 を expert で動かし、ultimate は既定で使わない](20261104-2323-cross-cutting-viewpoint-on-expert-tier.md)（観点ごとの段階を変えないとした部分）

## 背景

段階は `lite`・`entry`・`standard`・`advanced`・`ultimate` の 5 つで（[段階の ADR](20261016-1455-superseded-agent-tiers-for-subagents.md)）、
既定のモデルはリポジトリの `config/agents.yaml` に持つ（[既定の ADR](20261018-1105-agent-defaults-in-repo.md)）。
Codex に `gpt-6.1-terra`（`gpt-6.1-sol` より安い）と最上位の `gpt-6-astra` が出た。Claude には最上位の `claude-fable-5-1` がある。
最上位のモデルを段階に入れたいが、今の `ultimate`（sol・opus の `high`）も、ほかの用途で選べるように残したい。

## 決定

- `advanced` と `ultimate` の間に `expert` を足し、段階を 6 つにする（`AGENT_TIERS`）。既定のエージェントは 12 になる。
- 今の `ultimate` の組み合わせ（`gpt-6.1-sol`・`claude-opus-5-5` の `high`）を `expert` に移し、`ultimate` を最上位のモデルの `low`
  （`gpt-6-astra`・`claude-fable-5-1`）にする。
- Codex の `entry` を `gpt-6.1-terra` の `low`、`standard` を `gpt-6.1-terra` の `medium` にする。
- 既定の review スキルの観点ごとの段階は変えない（`expert` はどの観点にも割り当てない。X-1 は `ultimate` のまま）。
- 段階の位置はステークホルダーの案（advanced と ultimate の間）に従い、名前は開発側で `expert` とした。

## 検討した案

- **ultimate の上に段階を足す**：今の `ultimate` の名前と意味は残るが、「最上位」の段階が `ultimate` でなくなり、名前と食い違う。
- **ultimate を最上位のモデルに替えるだけ**：段階は増えないが、sol・opus の `high` を段階の名前で選べなくなる。

## 結果

- `codex_expert`・`claude_expert` が段階のエージェントとして置かれ、サブエージェント `expert` として使える。
- X-1 の横断の欠陥探索は、最上位のモデル（astra・fable）の `low` で動く。
- `codex_entry`・`codex_standard`・`codex_ultimate`・`claude_ultimate` を使うには、`providers` の `available_models` に新しいモデルの単価が要る。
  単価が無ければ、今までどおり使えない扱いになり、画面に警告が出る（既定の工程の AI の `codex_standard` が使えなければ `claude_standard` になる）。
