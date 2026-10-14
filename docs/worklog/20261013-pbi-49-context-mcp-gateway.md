# コンテキストリポジトリの HTTP の MCP サーバーを、ゲートウェイ経由で使わせる

- 日付: 2026-10-13（UTC）
- タスク: PBI-49
- PR: #57
- ブランチ: feat/issue-49-context-mcp-gateway
- 関係する ADR: [コンテキストリポジトリの HTTP の MCP サーバーは、既定でゲートウェイ経由にし、認証のヘッダーはホストで付ける](../adr/20261013-0411-superseded-context-http-mcp-via-gateway.md)

## 目的

コンテキストリポジトリの `mcp.yaml` に書いた HTTP の MCP サーバーを、既定で sacty のゲートウェイ経由で使わせる。認証のヘッダーの秘密情報は、ホストで付けてコンテナには渡さない。

## したこと

- `apps/daemon/src/context.ts`：`mcp.yaml` の HTTP のサーバーを、エージェントの設定（Claude Code の mcp.json・Codex の config.toml）でゲートウェイの URL
  （`http://host.docker.internal:<port>/ctx-mcp/<名前>`）にする。認証のヘッダーには、実行ごとのゲートウェイのトークンだけを入れる（ホストの MCP サーバー・PBI-36 と同じ仕組み）。
- `apps/daemon/src/service.ts`：元の URL と認証のヘッダー（秘密情報はホストで取り出す）は、実行の登録と一緒にゲートウェイだけに持たせる。実行が終わると、そのトークンでは使えない。
- `apps/daemon/src/gateway.ts`：MCP の Streamable HTTP に要るヘッダー（`content-type`・`accept`・`mcp-session-id`・`mcp-protocol-version`・`last-event-id`）だけを上流に送り、
  認証のヘッダーはホストに持った値を付ける。エージェントが付けた認証・クッキーなどは送らない。応答（SSE を含む）はそのまま返し、リダイレクトはたどらない。
- サーバーに `via_gateway: false` と書くと、これまでどおりコンテナから直接つなぐ。`command` のサーバーは、これまでどおりコンテナの中で起動する。
- README と、`sacty context init` の雛形の `mcp.yaml` の説明（`apps/daemon/src/context-template.ts`）を直した。

## 確かめたこと

- build・typecheck・lint・全テスト（525件）が通った。
- 追加したテスト：
  - ゲートウェイ（本物の HTTP の上流）：実行のトークンを確かめ、ホストに持った認証で中継する。SSE とセッションのヘッダーを返す。エージェントの認証・クッキー・ほかのヘッダーは送らない。
    GET・DELETE とクエリ。知らないトークン・終わった実行・登録していないサーバーは中継しない。リダイレクトはたどらない。
  - コンテキスト：HTTP のサーバーをゲートウェイの URL と実行ごとのトークンにし、元の URL と認証をゲートウェイに渡す（Claude Code・Codex）。`via_gateway: false` と stdio はこれまでどおり。
    ホストの MCP サーバーと同じ名前のものは中継しない。ゲートウェイが無ければ直接つなぐ。
  - daemon：ゲートウェイに中継先とホストで取り出した認証を渡し、コンテナには認証の値が渡らない。
- 主な判定を戻すと、テストが失敗することを確かめた（6通り）。
- MCP の SDK（`@modelcontextprotocol/sdk`）の本物のクライアントとサーバーで、ゲートウェイ経由の初期化・ツールの一覧・ツールの呼び出し（`add(2,40)` → 42）が動き、
  上流にはホストで付けた認証だけが届き、終わった実行のトークンは 401 になることを確かめた。
- 画面の変更は無いので、動画は撮っていない。
- レビューで、全525テスト・lint・型チェックが通った。利用者の実際の MCP サーバーと Rancher Desktop での接続は未確認。

## レビューの指摘と対応

指摘は無かった（レビューの結果は PASS）。

## 残したこと

- 利用者の環境で、利用者の HTTP の MCP サーバーを書いたコンテキストリポジトリで、工程のエージェントがその MCP のツールを使えることを確かめる
  （Rancher Desktop の場合は `gateway.host_address` の設定のまま。PR で依頼した）。
