# タスクの一覧を、題の検索・開始時期・開始地点・リポジトリ・状態で絞り込めるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #196
- ブランチ: ccr-92be7732-i4krnq
- 関係する ADR: なし

## 目的

タスクが増えると、プロジェクトのタスクの一覧から目的のタスクを探しにくい。
少なくとも開始時期・リポジトリ・状態で絞り込めるようにし、あわせて題の検索と開始地点の絞り込みも足す。

## したこと

- `apps/web/src/lib/task-filter.ts`：絞り込みの条件（`TaskFilter`）と判定（`matchesFilter`）、選択肢（`filterOptions`）を足した。
  - 「開始時期」は、タスクを作った日時（`createdAt`）を画面のタイムゾーンの日にして比べる（両端を含む）。
    一覧の「開始地点」（どこから始めたか）と言葉が近いので、開始地点も別の条件として選べるようにした。
  - 状態は、状態の文言（工程ごとに多い）ではなく、色分けの種類（`statusTone`）で選ぶ。よく使う「終わっていない」（完了と中止のほか）も足した。
  - リポジトリは一覧に出している名前（`repoName`）で選び、決まっていないタスクは「未定・リポジトリ無し」でまとめる。
- `apps/web/src/lib/task-list-data.ts`：一覧の行に `createdAt` を足した。
- `apps/web/src/components/task-list.tsx`：「すべてのタスク」の上に絞り込みの欄（`TaskFilterBar`）・件数・「条件をクリア」を足した。
  条件はクライアントの状態だけで持つ（取り直しでは消えず、別のプロジェクトへ移ると消える）。
- 文言（`apps/web/src/i18n/messages/tasks.ts`）を日本語と英語で足した。
- 仕様書（`docs/spec/architecture.md`）とユーザードキュメント（`docs/user/tasks.md`）を、それぞれ英語の版も直した。
- `live-screens.test.ts` の「あなたの出番」が消えることの確かめを、本文の文字ではなく欄（`#needs-you`）で見るようにした
  （絞り込みの状態の選択肢に同じ語があるため）。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通った。
- `npx vitest run`：`apps/web`・`tests/docs` を含め、今回に関係するテストは通った（`apps/web/src/components/task-list-filter.test.ts` を足した）。
  `apps/daemon` の9件（`host-mcp-processes`・`context-mcp`・`context`・`agent-sessions`）は失敗したが、変更を外した状態でも
  同じ9件が失敗するので、作業した環境（コンテナ）によるもので、この変更とは関係しない。
- 画面：ダミーのデーモン（`/api/tasks`・`/api/projects`・`/api/status` を返す）と `next dev` で開き、Playwright で
  リポジトリ・状態・開始時期を選んで1件に絞り込めること、検索の条件が3秒ごとの取り直しの後も残ること、
  「条件をクリア」で戻ること、スマホの幅で欄が縦に並ぶことを確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |

## 残したこと

- 条件を URL に残して共有・再読み込みで保つことはしていない。
- 一覧の行に作った日は出していない（サーバーとブラウザのタイムゾーンの違いで、描いた日がずれるため）。
