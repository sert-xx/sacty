<!-- 対応するコード: apps/daemon/src/service.ts、apps/daemon/src/prompts.ts、apps/daemon/src/platforms.ts、apps/daemon/src/host-mcp.ts -->

**日本語** | [English](result-export.en.md)

# 成果の書き出し（Confluence・Notion など）

人間が承認した調査の結果（調査だけのタスク）・要求要件・設計（テスト観点を含む）・文書原稿を、Confluence・Notion などに書き出せます。

## 接続先を書く

sacty は書き出し先の種類ごとの設定を持ちません。接続先は、組織内 PF（`config.yaml` の `gateway.platforms`・コンテキストリポジトリの
`platforms.yaml`）か MCP サーバー（コンテキストリポジトリの `mcp.yaml`・`config.yaml` の `gateway.mcp_servers`）として書きます（どちらに
するかは自由です。[ゲートウェイ](gateway.md)・[コンテキストリポジトリ](context.md)）。説明（`description`）に置き場所の決まりを書くと、
オーケストレーターの判断の手がかりになります。

```yaml
gateway:
  platforms:
    confluence:
      upstream: https://wiki.example.com
      description: Confluence（設計書は DEV スペースの「設計」の下に置く）
      auth: { header: Authorization, prefix: "Bearer ", secret: op://Work/Confluence/token }
      allow:
        - GET /rest/api/content/**            # 置き場所と、前に書き出したページを探す
        - POST /rest/api/content              # ページを作る
        - PUT /rest/api/content/*             # 承認し直した版で、同じページを更新する
```

## 書き出しの流れ

- 書き出すかどうか・どこに書き出すかは、工程を選ぶときにオーケストレーターが工程ごとに決めます（使える接続先と説明・タスクの内容・
  取り込み元・プロジェクトのコンテキストの規約から判断します。書き出さない判断もあります）。決めた書き出し先と理由は、作業履歴とタスクの
  画面の工程の欄に出ます。使える接続先が無ければ決めません。
- 工程の承認の後、その工程のエージェントが、決めた接続先だけを使って書き出します。認証はゲートウェイが付け、コンテナには実行ごとの
  トークンだけを渡します。書き出した先の URL は、作業履歴とタスクの画面に出し、取り込み元（Issue・JIRA）へのコメントにも添えます。
- 差し戻しの後に承認し直すと、前に書き出したページを更新します（新しく作りません）。書き出しの後・記録の前に止まっても、本文の目印で
  同じページを探して更新します。
- 接続できない・書き出せないときは、理由を残して、sacty の中に残す・取り込み元へコメントする、で進めます。タスクは止まらず、タスクの
  画面の「書き出し直す」で書き出し直せます。
- 書き出しの費用はタスクの費用に入り、工程ごとの費用の表に「書き出し」として出ます。

## 関係するページ

- [タスクを進める](tasks.md)
- [ゲートウェイ](gateway.md)
