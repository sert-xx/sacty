# README の設定・コマンド・使い方をユーザードキュメントに移し、README は概要・最小の手順・リンクだけにする

- 日付: 2026-10-14（UTC）
- タスク: PBI-81
- PR: なし
- ブランチ: feat/issue-81-user-docs
- 関係する ADR: [docs を4種類に分け、実装の変更で直すのは仕様書とユーザードキュメントだけにする](../adr/20261014-0816-docs-structure-and-policy.md)

## 目的

README（約560行）にあった設定・コマンド・使い方を、PBI-80 で決めたユーザードキュメント（`docs/user/`）に、利用者が目的から引けるように
分けて移す。移すときに、設定の項目・既定値・コマンドのオプションをコードと照合し、食い違いを直す。README は、概要・すぐ始める最小の
手順・ユーザードキュメントへのリンクだけにする。

## したこと

- `docs/user/` に14ファイルを足し、`docs/user/README.md` の目次に読む順に並べた：`getting-started.md`・`config.md`・`secrets.md`・
  `project-settings.md`・`intake.md`・`tasks.md`・`context.md`・`gateway.md`・`images.md`・`compose.md`・`result-export.md`・
  `notifications.md`・`cli.md`・`troubleshooting.md`。各ファイルの先頭の HTML コメントに、照合したコードの場所を書いた。
- README の各節を、内容ごとに移した（1行ずつ移し先を確かめた）。README の「構成」「開発」は、仕様書（別のタスク）がまだ無いので、
  `getting-started.md` の「開発するとき」に移した。
- README は、概要・すぐ始める最小の手順（`npm install` から `sacty up` まで）・ユーザードキュメントと docs の入口へのリンクだけにした。
- 移すときに、コード（`apps/daemon/src/config.ts` の zod の定義・`packages/cli/src/index.ts`・`packages/core/src/projects.ts`・
  `apps/daemon/src/intake.ts` など）と照合し、次を直した・足した。
  - 取り込み（Issue・PR・レビュー・チケット）は、`config.yaml` に `github:` が無いと動かない（「今すぐ取り込む」でも）。README に書かれて
    いなかった。`github.poll_interval_sec`（既定 300、60 以上）も足した。
  - 共用の compose のリポジトリの「ローカルのパス」は、絶対パスだけ（相対パスは誤りになる）。
  - `gateway.mcp_servers` の `restart_every_min` は任意（書かなければ定期的には起動し直さない）。README の書き方では必須に見えた。
    `ready_timeout_sec` の既定（300）と範囲（5〜3600）、`description`・`env` の `prefix` も足した。
  - ゲートウェイがリトライする一時的な失敗は「5xx」ではなく 500・502・503・504 と接続の失敗。間隔は60秒で頭打ち。
    `gateway.retry` の既定（8回・600秒）と範囲、`gateway.host_address` の既定（`host-gateway`）を足した。
  - CLI：`sacty config init --force`・`--help`（`-h`）・`sacty context preview` の `--runtime` の既定（`claude-code`）と、誤りのときの
    終了コード、ポートの範囲と2つのポートを違う番号にすることを足した。
  - 「sacty の設定」の「同時に実行するタスクの数」（1〜10、既定 3）と、Issue・PR・レビュー用のラベルの PR の On/Off が README に無かった。
  - Codex のサブスクリプションの `auth_file`、Claude Code のサブスクリプションでは `secret` が必須なこと、`stub` は `runtime: stub` だけ、
    `price_per_mtok_usd.cache_write` の既定（0）、`step_agents` に書けるキー、`providers`・`gateway.platforms`・`images` の項目・名前の
    規則・既定値を、表にして足した。
- 公開リポジトリの規則に合わせ、例の値の `my-company`・`corp-` を `acme` に変えた。
- `tests/docs/docs.test.ts` に足した検査：Markdown へのリンクのアンカー（`#…`）が行き先の見出しにあること（GitHub と同じ規則で
  アンカーを作る）、すべてのユーザードキュメントが目次にあり先頭に対応するコードを書いていること、README からユーザードキュメントの目次へ
  リンクしていること。部品のテスト（アンカーの取り出し・見出しのアンカーの作り方）も足した。
- `apps/daemon/src/context.test.ts` は、実行全体の上限（30分）の文が README にあることを確かめていたので、`docs/user/context.md` を読むように
  変えた。

## 確かめたこと

- `npx vitest run tests/docs`：通った。見出しを変えてアンカーを切ると、どのファイルのどのリンクかを示して失敗することも確かめた。
- `npm run lint`（終了コード 0）・`npm run typecheck`・`npm run build`：通った。
- `npx vitest run`：README を読むテスト（`context.test.ts`）を直した後、`--maxWorkers=2` で、ほかのタスクと並行していてマシンの負荷が高く
  （load average 150 前後）、変更と関係の無い `output-relay.test.ts` の2件が時間切れになった。そのファイルだけを流し直すと通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （セルフレビュー）すぐ始める手順に、雛形の AI のトークンを保存する手順が無く、そのままでは工程が動かない | README の最小の手順に `npx sacty secret set claude-oauth-token` を足した |

## 残したこと

- 仕様書の本文は別のタスクで書く（ユーザードキュメントからは仕様書の目次へリンクするだけ）。
