# エージェントの段階を固定し、同じスキルでどちらのツールでも同じ段階のサブエージェントを起動できるようにする

- 日付: 2026-10-16（UTC）
- タスク: PBI-119
- PR: なし
- ブランチ: feat/issue-119-agent-tiers
- 関係する ADR: [エージェントを段階で固定し、sacty が接頭辞を外した名前でサブエージェントの定義を置き、スキルは段階の名前で担当を起動する](../adr/20261016-1455-agent-tiers-for-subagents.md)

## 目的

`config.yaml` に `claude_<段階>`・`codex_<段階>`（段階は lite・entry・standard・advanced・ultimate）でエージェントを書くと、sacty が
工程を動かすツールに合わせて、接頭辞を外した名前のサブエージェントの定義を置く。review スキルは観点ごとに段階の名前で担当を起動する。
これで、同じスキルの定義でどちらのツールでも同じ段階の担当が動き、利用者は段階のモデルを直すだけで最新モデルに追従できる。

## したこと

- core
  - 文言のコード `config.tierRuntime`（接頭辞と runtime の不一致）・`agents.tierConnectionDiffers`（親と接続先が違う段階を置かない）・
    `context.reservedTierFile`（層の同じパスを写さない）を足した。
  - `ContextResolved` に `tiers`（置いた段階・エージェントの名前・モデル・リーズニングエフォート）を足した。
- daemon
  - `config.ts`：`AGENT_TIERS`・`TIER_PREFIX`・`parseTierId`・`tierAgentsFor`。検査で接頭辞と `runtime` を合わせ、`SactyConfig.tierAgents` に
    runtime ごと・段階ごとに集める。雛形に段階の例（コメント）を足した。
  - `agents/tiers.ts`：`selectTiers`（親と認証・接続先が同じ段階だけ。stub には置かない）、`tierFiles`（Claude Code は `agents/<段階>.md` の
    frontmatter `name`・`description`・`model`・`effort`、Codex は `agents/<段階>.toml` の `name`・`description`・`developer_instructions`・
    `model`・`model_reasoning_effort`）。
  - `context.ts`：`planContext`・`buildContext`・`prepareContext`・`previewContext` に `extraFiles` を足し、層の同じパスより優先して警告する。
  - `service.ts`：`runContext` で段階を選んで置き、警告を注意に足し、`ContextResolved` に `tiers` を記録する。コンテキストが無くても段階が
    あれば設定の場所を作る。プレビューにも同じ段階を置く（親はその runtime の `default_agent`、無ければ `step_agents`・`guardian_agent`）。
- web：作業履歴の「コンテキストを用意」の詳細に、置いた段階を出す（日英）。
- 既定の review スキル：観点カタログに「観点ごとの段階」の表、SKILL.md の起動の規則と担当への依頼に段階の指定、起動表に「段階」の列、
  集約の記録に `tier`。
- docs：ユーザードキュメント（config の「エージェントの段階」、context の写さないファイル）、仕様書（configuration の検査、context の
  置くファイル・合成の規則・既定のレビュー用スキル）、ADR。英語の版も同じ PR で直した。

## 確かめたこと

- `npx tsc -b packages/core apps/daemon packages/cli`・`npm run typecheck -w @sacty/web`：通った。
- 回帰テスト：`apps/daemon/src/agents/tiers.test.ts`（選択・接続先の比較・両ツールのファイルの形）、`agents.test.ts`（設定の読み取り・
  接頭辞と runtime の不一致・雛形の例）、`context.test.ts`（層の同じパスより優先し警告）、`daemon.test.ts`（工程の実行で置く・作業履歴の
  `tiers` と注意・Codex の `.toml`・プレビュー）。
- サブエージェントの定義の形は、Claude Code（`agents/*.md` の frontmatter `model`・`effort`）と Codex（`$CODEX_HOME/agents/<名前>.toml` の
  `name`・`description`・`developer_instructions`・`model`・`model_reasoning_effort`）の公式の資料（code.claude.com/docs/en/sub-agents、
  learn.chatgpt.com/docs/agent-configuration/subagents）で確かめた。Codex の資料には `features.multi_agent` と `[agents]` の
  `max_concurrent_threads_per_session`（`max_threads` は旧名）があり、既定の `config.toml` の `max_depth`・`job_max_runtime_seconds` は
  記載が無かった（この PBI では触っていない）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

- 実機（Docker の worker）で、親が段階の名前でサブエージェントを起動する様子は確かめていない（この環境に AI の設定と GitHub の接続が無い）。
  確かめ方：段階を書いた `config.yaml` でレビューの工程を 1 回動かし、実行のセッションログに Agent（Claude Code）・spawn（Codex）の
  呼び出しが段階の名前で残ることと、`ContextResolved` の `tiers` を見る。
- 段階ごとの担当の費用は、親の結果の使用量 × 親の単価の概算のまま。
- Claude Code の `-p` の権限（`permissions`）が無いままだと、担当の検証コマンドが拒否される可能性がある（実機確認で見つかったら直す）。
