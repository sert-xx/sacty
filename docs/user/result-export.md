<!-- 対応するコード: apps/daemon/src/service.ts、apps/daemon/src/prompts.ts、apps/daemon/src/platforms.ts、apps/daemon/src/host-mcp.ts -->

**日本語** | [English](result-export.en.md)

# 成果の書き出し（Confluence・Notion など）

人間が承認した調査の結果（調査だけのタスク）・要求要件・設計（テスト観点を含む）・文書原稿を、Confluence・Notion などに書き出せます。
文書作成で、タスクの本文の指示に従ってエージェントが外部の文書を直接書いたときは、その文書が成果物なので書き出しません（[タスクを進める](tasks.md#文書作成と単発の外部作業)）。

## 接続先を書く

sacty は書き出し先の種類ごとの設定を持ちません。
接続先は、次のどちらかとして書きます。
どちらにするかは自由です（[ゲートウェイ](gateway.md)・[コンテキストリポジトリ](context.md)）。

- 組織内 PF：`config.yaml` の `gateway.platforms`、またはコンテキストリポジトリの `platforms.yaml`
- MCP サーバー：コンテキストリポジトリの `mcp.yaml`、または `config.yaml` の `gateway.mcp_servers`

説明（`description`）に置き場所の決まりを書くと、オーケストレーターはそれを手がかりに判断します。

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

- 書き出すかどうか・どこに書き出すかは、オーケストレーターが工程を選ぶときに、工程ごとに決めます。
  - 使える接続先と説明・タスクの内容・取り込み元・プロジェクトのコンテキストの規約から判断します。
    書き出さないと決めることもあります。
  - 決めた書き出し先と理由は、作業履歴と、タスクの詳細の「工程の設定」タブに出ます。
  - 使える接続先が無ければ決めません。
- 工程の承認の後、その工程のエージェントが、決めた接続先だけを使って書き出します。
  - 認証はゲートウェイが付けます。
    コンテナには実行ごとのトークンだけを渡します。
  - 書き出した先の URL は、作業履歴とタスクの画面に出し、取り込み元（Issue・JIRA）へのコメントにも添えます。
- 差し戻しの後に承認し直すと、前に書き出したページを更新します（新しく作りません）。
  書き出しの後・記録の前に止まっても、本文の目印で同じページを探して更新します。
- 接続できない・書き出せないときは、理由を残し、成果を sacty の中に残して取り込み元へコメントして進めます。
  タスクは止まりません。
  タスクの画面の「書き出し直す」で書き出し直せます。
- 書き出しの費用はタスクの費用に入り、工程ごとの費用の表に「書き出し」として出ます。

## 関係するページ

- [タスクを進める](tasks.md)
- [ゲートウェイ](gateway.md)
