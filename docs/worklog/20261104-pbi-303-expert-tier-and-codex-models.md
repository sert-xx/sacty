# 段階に expert を足し、Codex の entry・standard を terra、ultimate を astra・fable にする

- 日付: 2026-11-04（UTC）
- タスク: PBI-303
- PR: #305
- ブランチ: feat/issue-303-codex-tier-models
- 関係する ADR: [段階に expert を足して 6 つにし、ultimate を各ツールの最上位のモデルにする](../adr/20261104-1327-superseded-expert-tier-between-advanced-and-ultimate.md)

## 概要

- 段階を `lite`・`entry`・`standard`・`advanced`・`expert`・`ultimate` の 6 つにした（`AGENT_TIERS`）。
- 既定（`config/agents.yaml`）：`codex_entry` を `gpt-6.1-terra`・`low`、`codex_standard` を `gpt-6.1-terra`・`medium` にした。
  今の `ultimate` を `codex_expert`（`gpt-6.1-sol`・`high`）・`claude_expert`（`claude-opus-5-5`・`high`）に移し、`codex_ultimate` を
  `gpt-6-astra`・`low`、`claude_ultimate` を `claude-fable-5-1`・`low` にした。
- `sacty config init` の雛形と、ユーザードキュメントの単価の例に、`gpt-6.1-terra`・`gpt-6-astra`（と雛形のコメントに `claude-fable-5-1`）を足した。
  足さないと、雛形のままでは既定の工程の AI の `codex_standard` が使えないため。
- review スキル（`review-dispatch`）の段階の一覧に `expert` を足した。観点ごとの段階の割り当ては変えていない。
- 仕様書（`configuration`・`context`）とユーザードキュメント（`config`・`context`）の段階の一覧・既定の表を、日英で合わせた。

## 単価の出典

OpenAI の料金のページ（developers.openai.com の pricing。Standard、272K トークン以下）：
`gpt-6.1-terra` は input 1・cached input 0.05・output 5、`gpt-6-astra` は input 10・cached input 1・output 50（100 万トークンあたり USD）。
Anthropic の料金のページ：`claude-fable-5-1` は input 10・cache hits 0.25・5 分の cache writes 12.5・output 50。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run`：全件通過（既定の表・段階の数・単価の無いモデルの警告・雛形の読み込みのテストを、新しい既定に合わせて直した）。
- `AGENT_TIERS` から `expert` を外すと、`agent-defaults.test.ts`・`agents.test.ts` の 5 件が落ちることを確かめた。
- 手元の `~/.sacty/config.yaml`（terra・astra・fable の単価を足したもの）を、このブランチの `loadConfig` で読んだ：
  12 の段階がすべて使え、警告は無い。`step_agents` の `codex_entry` は terra・`low`、`codex_standard` は terra・`medium` になった。

## セルフレビュー（DA）

- 受け入れ条件 1〜6 を満たす。段階の一覧は `AGENT_TIERS` から回すので、サブエージェントの定義を置く処理・コンテキストの予約のパスは
  `expert` にもそのまま効く（`daemon.test.ts`・`context` のテストが通る）。
- リスク：既に使っている人の `config.yaml` に terra・astra・fable の単価が無いと、`codex_entry`・`codex_standard`・`codex_ultimate`・
  `claude_ultimate` が使えない扱いになる。`step_agents` などで名前を指していれば設定の誤りで止まる（足すべき単価を示す）。
  既定の ADR の方針どおりで、PR の本文に書いた。

## レビューの指摘と対応

- [要修正] `docs/user/gateway.md`・`docs/user/secrets.md`（と英語の版）の設定の例に `gpt-6.1-terra` の単価が無く、例のままでは
  `codex_standard` が使えず `config.noDefaultAgent` で読めない：認証の例とみなして見落としていた。gateway の例に terra・astra を足し、
  secrets の例（単価が 1 つだけの短い例）は sol を terra に替えた。同じ漏れを防ぐため、`docs/user/` の `available_models` を書いた
  yaml の例をすべて `loadConfig` で読むテストを `agent-defaults.test.ts` に足した。直す前の gateway の例で落ちることを確かめた。
- [提案] ADR の「段階の名前は…案に、名前は…」の文がつながらない：「段階の位置はステークホルダーの案に従い、名前は開発側で `expert` とした」に直した。
