# エージェントの段階を固定し、同じスキルでどちらのツールでも同じ段階のサブエージェントを起動できるようにする

- 日付: 2026-10-16（UTC）
- タスク: PBI-119
- PR: #129
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
| 接続先が違って置かなかった段階や、書いていない段階でも、層の `agents/<段階>.md`・`.toml` が残る（スキルが段階の名前で起動するとそれを使う） | 段階を置くかどうかによらず、固定の段階の名前のパスは層から写さずに警告する（`planContext`）。回帰テストを足し、日英の仕様書を直した |
| 層の `config.toml` の `[agents.<段階>]` は、自動で探す `agents/<段階>.toml` より先に登録され、sacty の定義が使われない | `withoutReserved` で `agents.<段階>` を sacty が決める項目として外し警告する（`agents` のほかの項目は残す）。宣言だけ・`config_file` 付きの回帰テストを足した |
| 段階の警告と `tiers` が、通常の工程以外（マージの後の監視・外部作業・書き出し）では作業履歴に残らない | コンテキストを渡す実行のたびに、その `runId` で `ContextResolved` を記録する（`contextResolved`）。書き出しの経路の回帰テストを足した |
| 担当が親と違うモデルで動いても費用が概算にならず、利用者向け文書にも制限が無い | 段階を置いた実行は `estimateCost` で推定（`estimated`）として記録する。仕様書（エージェントの実行・コンテキストの合成）と利用者向け文書（config）に、親の単価で計算する制限を日英で書いた |
| 段階が無いときの起動の指示（親と同じで起動し、起動表に「親と同じ」）の回帰テストが無い | `default-skills.test.ts` に、観点ごとの段階の表・起動の規則・担当への依頼・起動表の列・集約の記録を確かめるテストを足した（指示を消すと落ちる） |
| 再レビュー：MCP 経由の書き出しで、ContextResolved の記録に失敗すると用意したコンテキスト（一時ディレクトリ・ホストの MCP の確保）が消えない | 記録を `finally` で消す範囲の中（`ExportStarted` と同じ書き込み）に移した。記録に失敗しても層の置き場所が消える回帰テストを足した |
| 再レビュー：Codex はファイルの中の `name` をロールの名前にするので、別名のファイルや `config_file` が指す定義の `name` が段階だと sacty の定義が使われない | `agents/*.toml` の `name` が段階ならファイル名によらず写さず警告し、`config_file` の先の `name` が段階の `agents.<名前>` も使わず警告する（`codexRoleName`）。別名のファイル・`config_file` の両方の回帰テストを足し、日英の文書に書いた |
| 再レビュー（提案）：概算の分類（`estimateCost`）の回帰テストが無い | API キーの実行で、段階を置いたときは `estimated: true`、置かないときは `false` になる対のテストを足した |
| 再々レビュー：`config_file` を検証せずにホストで読み、層の外（`../`）やデバイス・FIFO を指すと外を読む・止まらない | 読むのは層のエージェントの設定のディレクトリの中の、途中も含めてリンクでない通常のファイル（256KB まで）だけにした。外・絶対パス・通常でないファイルは読まずに宣言を残す。層の外・`/dev/zero`・ディレクトリを指す回帰テストを足した |
| 再々レビュー：`name` の前後の空白で段階との一致を逃れる | Codex 0.160.0 と同じく trim して比べ、空なら名前とみなさない。自動で探す定義と `config_file` の参照の両方の回帰テストを足した |
| ステークホルダー：`sacty config init` などの雛形にも対応しているか | config.yaml の雛形に、両ツールの 5 段階すべての例（コメント）を入れ、例を外すと 10 段階すべてが読めるテストにした。コンテキストリポジトリの雛形の README に、段階の名前の定義は sacty が作るので置いても使わないことを書いた |
| 実機（Claude Code・Codex）で担当が段階のモデルで起動するログか動画を添える | この環境では確かめられない（AI の設定と GitHub の接続が無い）。確かめ方を「残したこと」に書き、PR のスレッドでステークホルダーの判断を仰いだ |

## 残したこと

- 実機（Docker の worker）で、親が段階の名前でサブエージェントを起動する様子は確かめていない（この環境に AI の設定と GitHub の接続が無い）。
  確かめ方：段階を書いた `config.yaml` でレビューの工程を 1 回動かし、実行のセッションログに Agent（Claude Code）・spawn（Codex）の
  呼び出しが段階の名前で残ることと、`ContextResolved` の `tiers` を見る。
- 段階ごとの担当の費用は、親の結果の使用量 × 親の単価のまま（段階を置いた実行は推定として記録する）。
- Claude Code の `-p` の権限（`permissions`）が無いままだと、担当の検証コマンドが拒否される可能性がある（実機確認で見つかったら直す）。
