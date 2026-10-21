# 工程のエージェントが GitHub をゲートウェイ経由で読み、PR・Issue へのコメントを承認の後に sacty が投稿する

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: #183
- ブランチ: claude/gracious-sagan-0c80hj
- 関係する ADR: [工程のエージェントに GitHub の読み取りの中継をいつも渡し、PR・Issue へのコメントはエージェントが出力で頼んで承認の後に sacty が投稿する](../adr/20261021-1130-github-read-relay-and-comment-requests.md)

## 目的

利用者が自分で作った PR のレビューの指摘への対応を依頼したタスクで、「作業」の工程のエージェントが `gh` で PR を読もうとして失敗した。
コンテナには `gh` もトークンも無いため。次をできるようにする。

- 読み取りの `gh` の操作を、ゲートウェイ経由でできるようにする（既定で有効、設定で変えられない）。
- 「作業」などの工程でも PR の情報を読み、対応の結果を PR に投稿できるようにする（エージェントが決まった形で頼み、sacty が投稿する）。

## したこと

- ゲートウェイに GitHub の読み取りの中継を足した（`apps/daemon/src/gateway.ts` の `handleGitHub`、判定は `apps/daemon/src/github-relay.ts`）。
  REST の GET・HEAD と GraphQL の query だけを、プロジェクトの gh のアカウントのトークンを付けて送る。`link`・`location` は中継の URL に書き換える。
- 文書作成を除くタスクのすべての実行に、中継を結びつけ、`SACTY_GITHUB_URL`・`SACTY_GITHUB_HOSTS`・`GH_HOST` と読み方の指示を渡した
  （`apps/daemon/src/service.ts` の `executeLogged`）。
- イメージに、`gh api` だけを中継に送る `gh` を入れた（`packages/cli/docker/gh-shim.cjs`・`Dockerfile`）。
- 工程の出力の `sacty-github-comments` を、承認の後に sacty が投稿するようにした（`apps/daemon/src/github-comments.ts`、
  `service.ts` の `postGitHubComments`・`awaitingGitHubComments`、イベント `GitHubCommentsPosted`、画面の作業履歴の文言）。
- 単発作業の接続先に `github` を足した（`OperationVia`、オーケストレーターの指示、作業の工程の指示）。
- 仕様書（ゲートウェイ・タスクと工程・エージェントの実行）とユーザードキュメント（ゲートウェイ・タスクを進める・コンテナイメージ）を、
  日本語と英語で直した。単発作業の ADR の一部を置き換えた。

## 確かめたこと

- `npm run typecheck`：通った。
- `npm run lint`（`biome check .`）：通った。
- `npx vitest run`：2444 件のうち 2436 件が通った。失敗した 8 件（`host-mcp-processes.test.ts` の 6 件・`agent-sessions.test.ts` の 1 件・
  `context-mcp.test.ts` の 1 件）は、変更を外した状態（`git stash`）でも同じく失敗した。この環境で root で動いていること・プロセスの扱いによる
  ものと見られる（未確認）。
- 足したテスト：`github-relay.test.ts`（GraphQL の読み取りの判定・URL の書き換え・指示）、`gateway.test.ts`（中継の転送・トークン・
  書き込みや知らないホストを断る）、`gh-shim.test.ts`（イメージの `gh` を実際のゲートウェイに向けて実行）、`github-comments.test.ts`、
  `daemon.test.ts`（承認の後に1回だけ投稿する・読めない頼み・GitHub を接続先にした作業）。
- `npx vitest run tests/docs`：通った。
- イメージの作り直し（`npx sacty image build`）と、実際の GitHub への読み取り・投稿は、この環境（Docker・gh のログインが無い）では
  確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| CodeQL：Server-side request forgery（`gateway.ts` の GitHub の中継。上流の URL が要求の値に依る） | 転送先のホストを、要求の値ではなく、実行に結びつけたホストの一覧から取るようにした（パスは前から検査している） |
| CodeQL：Incomplete URL substring sanitization（`service.ts` の `githubDefaultHost`） | 配列の照合で、部分一致ではない（誤検知）。紛れないよう `Set` の照合に書き換えた |
| [要修正] トークンの取り出し・既存のコメントの検索を待つ間に止められても、投稿が続く | 各コメントの前と投稿の直前に、一時停止・中止の要求と承認の日時を確かめ、変わっていれば投稿も記録もしないようにした。検索を待たせて一時停止するテストを足した（確かめを外すと失敗することを確かめた） |
| [要修正] `gh api --paginate` で 0 件だと何も出さない | 配列を受け取ったかを別に持ち、0 件でも `[]` を出すようにした。テストを足した |
| [提案] GraphQL の 256 KiB の上限を、受け取り終えた後に判定している | `readBody` にこの経路の上限を渡し、超えたら受け取り終える前に 413 で断るようにした（`Content-Length` と chunked のテストを足した） |
| [提案] 作業履歴の見出しが、失敗でも「投稿した」と読める | 日英とも「投稿の結果」の中立な見出しにした |
| [提案] GraphQL の `errors` を成功として扱う | `errors` があれば、標準エラーに理由を出して終了コード 1 で終わるようにした（`data` と共存するテストを足した） |
| [提案] 投稿の後・記録の前に止まったときの復旧を、新しい経路でも確かめる | 記録だけを一度失敗させ、外部のコメントが残った状態から再開して、2 件のコメントがそれぞれ再利用され、新しく投稿されないテストを足した |
| [提案] 単発作業にも GitHub の読み取りの中継が渡ることを書く | 仕様書（タスクと工程）とユーザードキュメント（タスクを進める）に、日英で書いた |

## 残したこと

- 既存の PR（sacty が作っていないもの）に、修正をプッシュして積むこと。コードを直すタスクは、これまでどおり新しい PR になる。
- `gh pr view` などの `gh api` 以外のコマンド。
