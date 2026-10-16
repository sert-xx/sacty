**日本語** | [English](export.en.md)

# 書き出し

人間が承認した調査の結果（調査だけのタスク）・要求要件・設計・文書原稿を、Confluence・Notion などに書き出す。sacty は書き出し先の種類ごとの設定を
持たず、組織内 PF か MCP サーバーとして書いた接続先を使って、エージェントに書き出させる。プロジェクトの設定のエクスポート・インポートも
この文書に書く。

関係する ADR: [Slack の通知先を、プロジェクトの設定から sacty の設定に移し、すべてのプロジェクトの通知を1つの送り先に送る](../adr/20261016-0421-slack-notification-in-sacty-settings.md)

## 何を・どこに書き出すか

- 書き出せる工程は `investigate`（最後の工程のときだけ）・`requirements`・`design`・`document`（`EXPORT_STEPS`）。
- 書き出すか・どこに書き出すかは、工程を選ぶときにオーケストレーターが工程ごとに決める（`exports`：`to`・`via`（`platform`｜`mcp`）・
  `location`・`reason`）。使える接続先は、ホストの PF・プロジェクトのコンテキストの PF・ホストの MCP・コンテキストの MCP。接続先か書き出せる
  工程が無ければ決めない。決めなかった・知らない接続先を選んだ工程は書き出さない。
- 書き出すのは承認した版（設計はテスト観点を含む）に、提出の回と目印の行 `目印：sacty-export:<タスク ID>:<工程>` を足したもの。

コード: `packages/core/src/events.ts`（`EXPORT_STEPS`・`exportSteps`）、`apps/daemon/src/service.ts`（`withExports`・`exportDestinations`）、`apps/daemon/src/prompts.ts`（`buildExportDocument`・`exportMarker`）

## 書き出しの実行

- 工程の承認の後、次の工程と取り込み元へのコメントより先に行う（コメントに URL を添えるため）。一時停止中・実行中のタスクでは行わない。
- その工程の AI で、決めた接続先だけを渡して実行する（役割 `export`）。作業領域 `workspaces/_export/<実行 ID>` の `sacty-export.md` に
  書き出す内容を置き、終わったら消す。答えは見出し `sacty-export` の JSON（`url` か `error`）。
- 前に書き出した URL があれば、そのページを更新させる（新しく作らない）。前の書き出しが記録の前に止まった（`ExportStarted` だけがある）
  ときは、目印で同じページを探して更新させる。
- 書き出せなかった（予算の上限・接続先が無い・答えが読めない・エージェントの失敗）ときは、理由を `OutputExported` に記録して、タスクは
  止めずに進める。人が止めた・中止したときは費用だけを記録する。
- 書き出し直し：`POST /api/tasks/:id/exports/:step/retry`（最後の書き出しが失敗で、いまの承認の版のときだけ）。承認し直すと、書き出し直す。
- 書き出しの費用はタスクの費用に入る（工程ごとの費用の表では「書き出し」）。

コード: `apps/daemon/src/service.ts`（`awaitingExport`・`exportOutput`・`retryExport`）、`apps/daemon/src/prompts.ts`（`buildExportPrompt`・`extractExport`・`EXPORT_FILE`）、`packages/core/src/projection.ts`（`exportDue`・`canRetryExport`）

## プロジェクトのエクスポート・インポート

- `GET /api/projects/:id/export` は `{ sacty: "project", version: 5, project: { … } }`（`PROJECT_EXPORT_VERSION`）を返す。`project` には
  `name`・`targets`・`context`・`tickets`・`sharedComposes` を入れる。ID・日時・
  `githubAccounts`（個人の設定）は入れない。画面からは `sacty-project-<名前>.json` としてダウンロードする。
- Slack の通知先は sacty の設定にあり（[通知](notifications.md)）、プロジェクトの定義に無いので、エクスポートに入れない。
- `POST /api/projects/import` は、同じ形を厳密に確かめ（知らない項目・`sacty` の違い・版の違いは誤り）、新しい ID のプロジェクトとして保存する
  （保存の前にほかのプロジェクトとの重複を確かめる）。画面からは 1,000,000 バイトまでのファイルを読む。
  - `project` の `notification` は、知らない項目として誤りにする（`input.unknownKeys`）。
  - 版 3・4（通知先を含んでいた版）のファイルは、通知先の有無によらず、エクスポートし直すように示して断る（`input.exportVersionWithNotification`）。
    ほかの版の違いは `input.unsupportedVersion`。どちらも、版の誤りを最初の誤りとして返す（画面は最初の誤りを出す）。

コード: `packages/core/src/projects.ts`（`ProjectExport`・`exportProject`・`PROJECT_EXPORT_VERSION`）、`apps/daemon/src/service.ts`（`exportProject`・`importProject`・`saveProject`）、`apps/web/src/app/projects/[id]/export/route.ts`、`apps/web/src/app/actions.ts`（`importProjectAction`）
