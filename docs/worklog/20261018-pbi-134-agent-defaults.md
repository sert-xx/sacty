# エージェントの既定をリポジトリに持ち、config.yaml は接続先と単価だけで動くようにする

- 日付: 2026-10-18（UTC）
- タスク: PBI-134
- PR: なし
- ブランチ: feat/issue-134-agent-defaults
- 関係する ADR: [エージェントの既定をリポジトリに持ち、config.yaml は接続先と単価だけにする](../adr/20261018-1105-agent-defaults-in-repo.md)

## 目的

設定を見直さない利用者が古いモデルを使い続けないよう、sacty が推奨する段階のエージェントをリポジトリで持ち、sacty の更新で届ける
（ステークホルダーの要望。今の形式の config.yaml を誤りにする破壊的変更は了承済み）。

## したこと

- 既定：`config/agents.yaml` に、codex・claude の 5 段階ずつと、既定の工程の AI（codex_standard、使えなければ claude_standard）を書いた。
- 設定：`providers` を `providers.codex`・`providers.claude` にし、認証・ゲートウェイ・`available_models`（モデルごとの単価）を書く形にした。
  `agents` は任意で、既定を項目ごとに上書きする。単価・接続先の無いエージェントは使えない扱いにして、画面で警告する。
- 今の形式（エージェントの `auth`・`provider`・`via_gateway`・`price_per_mtok_usd`、名前を付けた接続先）は、直し方を示す誤りにした。
- 雛形・秘密情報の書き場所の表示（`providers.<runtime>.auth.secret`）・文言（日英）を直した。
- docs：仕様書・ユーザードキュメント（日英）・ADR。

## 確かめたこと

- `npx biome check`・`npm run typecheck`・`npx vitest run`・`npm run build` が通った。
- 次の修正を戻すと、テストが落ちることを確かめた：警告を画面の状態に出すこと、単価の無いモデルを使えない扱いにすること、今までの項目を
  誤りにすること、既定の工程の AI の次の候補を探すこと、単価の一覧を自身のプロパティだけで引くこと、名前を付けた接続先を誤りにすること、
  接続先の無い既定には警告しないこと、上書きで既定の項目を引き継ぐこと、中身をコメントにした項目（null）を書いていないのと同じにすること。
- デモ用のポートで、接続先と単価だけの config.yaml で起動し、工程の実行に既定の 5 段階が置かれること、単価の無いモデルの警告、
  今の形式の誤りを確かめた（本物の AI は呼んでいない）。
