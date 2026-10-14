# Codex のサンドボックスは使わず、隔離は sacty のコンテナに任せる

- 日時: 2026-10-13 00:03 UTC
- ステータス: 採用
- 関係する PR・タスク: #46、PBI-40
- 置き換え元: なし
- 置き換え先: なし

## 背景

sacty のコンテナは権限を落としてある。その中では、Codex の Linux のサンドボックス（bubblewrap）が namespace を作れず、
コマンドの実行が失敗していた。さらに CODEX_HOME が /tmp の下にあると、Codex はサンドボックスの補助のプログラムを用意せず、
`--sandbox-policy-cwd` を認識できずに終了していた（利用者の環境で発生した）。

## 決定

- Codex は `--sandbox danger-full-access` の引数で起動する。サンドボックスは使わず、隔離は sacty のコンテナが受け持つ。
- CODEX_HOME を `/.codex` にする（/tmp の外に置く）。
- コンテキストの `sandbox_mode`・`sandbox_workspace_write` は sacty が決める項目として使わず、書かれていれば警告を残す。
- 既定のコンテキストの `agents/codex/config.toml` で、承認が要る操作は `approvals_reviewer = "auto_review"` で判断させる。

## 理由

- 権限を落とした sacty のコンテナの中では、bubblewrap のサンドボックスを作れないため（コミット）。
- 設定ではなく引数にしたのは、引数がどの設定ファイル（既定・コンテキスト・対象リポジトリの `.codex/config.toml`）よりも優先されるため（PR の本文・コミット）。
- CODEX_HOME を移したのは、/tmp の下にあると上の終了が起きることがあるため（コミット）。

## 影響

- 対象リポジトリやコンテキストの設定に workspace-write・read-only が書かれていても、Codex はコンテナの中でコマンド（`npm run setup` など）を実行できる。
- Codex のコマンドの実行を隔離するのは、sacty のコンテナの権限の制限だけになる。
