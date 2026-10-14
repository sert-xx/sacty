# ゲートウェイのログ・理由で、準備できていない MCP サーバーがどれかわかるようにする

- 日付: 2026-10-14（UTC）
- タスク: PBI-92
- PR: なし
- ブランチ: feat/issue-92-mcp-log-names
- 関係する ADR: なし

## 目的

ゲートウェイのログに MCP サーバーの not ready が出ても、コンテキストの command の MCP サーバー（PBI-84）はゲートウェイの中の名前
（`ctx-<ハッシュ>`）しか出ず、設定のどれかを探せなかった。MCP サーバーごとのログ・理由（作業履歴・画面・エージェントへの 503）に、
設定で探せる名前（`mcp.yaml` の名前・層・プロジェクト）を出し、同じ層・同じ名前のものが複数のプロジェクトにあっても区別できるようにする。
秘密情報（環境変数・標準エラー）は今どおり伏せる。

## したこと

- `apps/daemon/src/host-mcp.ts`：コンテキストの MCP サーバーの出どころ（`HostMcpContext`）に、プロジェクト（ID と名前）を足した。
  ログに出す名前を `mcpLogName` にまとめ、起動・起動し直し（理由つき）・準備できない、のログに使う。ホストの MCP サーバーは今までどおり
  `host MCP <名前>`、コンテキストのものは `context MCP "<mcp.yaml の名前>" (project "<名前>" [<ID>], context "<層>", internal ctx-…)`。
  プロセスの記録の名前にもこれを使う。準備できないときのエージェントへの 503 には、`mcp.yaml` の名前・層・プロジェクトの名前を出す
  （中の名前は出さない）。出どころは起動し直すかの判定（`processKey`）から外した（プロジェクトの名前を変えても起動し直さない）。
- `apps/daemon/src/context-mcp.ts`：`lease` にプロジェクトの名前を渡せるようにし（`service.ts` の `runContext` から渡す）、確保のたびに
  いまの名前にする。止めるログ・層の写しを消せなかったログに、どのプロジェクト・層のものかを出す。層（`from`）は、リポジトリの URL の
  認証情報を `***` に伏せてから使う（`shownLayer`）。
- `apps/daemon/src/host-mcp-processes.ts`：記録を書けなかったログと、前回の残りを止めたログに、記録の名前（どの MCP サーバーか）を出す。
- `apps/daemon/src/gateway.ts`：コンテキストの HTTP の MCP サーバーに届かなかったときの 502 に、`mcp.yaml` の名前を出す。
- `packages/core/src/messages.ts`：`context.mcpHostUnavailable`・`context.mcpHostReadyTimeout`・`context.mcpHostCommandMissing` に、任意の
  `project` を足した（前の記録には無いので任意。無ければプロジェクトを出さずに表示する）。
- 仕様書（`docs/spec/context.md`・`docs/spec/gateway.md`）と、ユーザードキュメント（`docs/user/context.md`）を直した。

直したログの例（同じ層・同じ名前の `jira` が2つのプロジェクトにあり、コマンドがホストに無い）：

```text
# 前
[gateway] host MCP ctx-9c9938754f0549758c46f89c: not ready: the command "jira-mcp-92" was not found on the host
# 後
[gateway] context MCP "jira" (project "Acme web" [p-web], context "https://github.com/acme/ctx.git@c0ffee1", internal ctx-9c9938754f0549758c46f89c): not ready: the command "jira-mcp-92" was not found on the host
[gateway] context MCP "jira" (project "Acme api" [p-api], context "https://github.com/acme/ctx.git@c0ffee1", internal ctx-8d1c041abde38e9820c4b83c): not ready: the command "jira-mcp-92" was not found on the host
```

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（すべて通過）・`npm run build`・`npx vitest run tests/docs`。
- 回帰テスト（`context-mcp.test.ts`）：not ready・起動・停止のログに名前・プロジェクト・層・中の名前が出て、2つのプロジェクトの行が
  区別できる。中の名前を出す行には必ず `mcp.yaml` の名前とプロジェクトがある。理由・503 にもプロジェクトが出る。env の秘密情報の値
  （失敗の文と標準エラーに出るもの）は、ログ・理由・503 に出ない。準備の時間切れの理由・層の写しを消せなかったログ・前回の残りを
  止めたログ（本物のプロセス）にも出る。URL の認証情報を伏せる。プロジェクトの名前を変えても起動し直さない。前の記録（`project` 無し）
  も表示できる。`gateway.test.ts` で 502 の名前、`daemon.test.ts` で作業履歴の警告のプロジェクトの名前を確かめた。
- 修正を戻すと落ちることを確かめた：not ready のログを前の形に戻す・`processKey` に出どころを戻す・`shownLayer` を外す・
  `runContext` からプロジェクトの名前を渡さない・502 の名前を外す、のそれぞれで、対応するテストが落ちた。
- 画面：一時的な `SACTY_HOME`・偽の `gh`/`docker` で、本物の `ContextMcpServers` が作った理由を台帳に入れ、タスクの作業履歴に
  「プロジェクト「Acme web」の … mcp.yaml の MCP サーバー「jira」…」と出ることを確かめた（動画を PR に添える）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA）プロジェクトの名前を変えると、出どころが起動し直す判定に入っていて起動し直してしまう | 出どころを判定から外し、テストを足した |
| （DA）層の URL に認証情報があると、ログ・理由に出る | `shownLayer` で伏せる（`@` を含むパスワード・認証情報の無い URL・SSH の形のテスト） |
| （DA）層の写しを消せなかったログ・前回の残りの片付けのログに、どの MCP サーバーかが出ない | 層の写しにはプロジェクトと層を、プロセスの記録にはログの名前を持たせて出す |

## 残したこと

- デーモンを止めている途中に準備を待っていた実行では、理由が `gateway.mcpUnavailable`（中の名前、`not configured`）になることがある
  （止めた後の実行は続かないので直していない）。
- `config.yaml` の `gateway.mcp_servers` のサーバーを設定から消したときは、今までどおり止めるログを出さない。
