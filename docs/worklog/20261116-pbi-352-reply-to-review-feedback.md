# 取り込んだ PR の指摘への対応を、指摘ごとに PR に返信する

- 日付: 2026-11-16（UTC）
- タスク: PBI-352
- PR: #385
- ブランチ: feat/issue-352-reply-to-review-feedback
- 関係する ADR: [取り込んだ PR の指摘への対応を、指摘ごとに PR に返信する](../adr/20261116-0045-reply-to-review-feedback-on-pull-request.md)

## 目的

分割の子タスクの実装の PR で、PR のレビューの子タスクの指摘を取り込んで実装をやり直したが、PR には、指摘への返信が 1 つも無かった。

- 指摘した人・AI は、指摘の場所で、対応されたか・断られたかを読めなかった。
- 再レビューには「作者が『対象外』『後続で対応』と返した論点は、もう一度指摘しない」という決まりがあるが、作者の返答が空で、効かなかった。

受け入れ条件の要点は次のとおり。

- PR のレビュー・コメントから取り込んだ指摘を受けて工程をやり直し、PR を更新したら、対応の付いた指摘ごとに返信する。
- 行へのコメントには、そのコメントへの返信として投稿する。返信できなければ、PR のコメントにする。
  レビューの本文・通常のコメントには、元へのリンクを付けた PR のコメントとして投稿する。
- 返信は、対応したのか、理由があって対応しなかったのかが分かる。申告が無ければ、対応の文だけを投稿する。
- 同じ指摘に二重に投稿しない（投稿と記録の間でデーモンが止まっても）。失敗してもタスクは止めず、作業履歴に残す。
- sacty の返信を、PR の指摘として取り込み直さない。再レビューには、作者の返答として渡す。
- 画面から書いた指摘・対応の無い指摘・セキュリティのタスク・GitHub のアカウントを選んでいないプロジェクトでは、返信しない。
- 画面の作業履歴に、返信したことが出る（ja・en）。
- 人が作った PR を引き継いで直すタスクでも、実装に渡した指摘ごとに、同じように返信する（実装の途中で、人の決定で足された）。
  一度返信した指摘には、後の提出で繰り返し返信しない。

## したこと

- `packages/core/src/events.ts`
  - `Remark.origin`（`RemarkOrigin`：取り込みのキーと PR の番号）。指摘の元の PR のコメント。
  - `RemarkResponse.status`（`addressed`・`declined`）。対応したか、理由があって対応しなかったか。
  - `RemarkRepliesPosted`（工程・提出回・PR の番号と、指摘ごとの結果）。
- `packages/core/src/projection.ts`
  - `Task.remarks[]` に、`origin`・`status`（対応と同じ提出回のものだけ）・`repliedIn`（返信した対応の提出回）を足した。
  - `RemarkRepliesPosted` は、元のコメントの無い指摘・知らない指摘・返信済みの指摘への記録を受け付けない。
- `apps/daemon/src/service.ts`
  - 取り込んだ PR の指摘（`pendingReview` の `keys` と `remarks` は同じ位置）から、指摘ごとの元のコメントを作る（`remarkOrigins`）。
    承認待ちの取り込み（`settleReview` → `requestChanges`）と、一時停止の間に届いた指摘（`settleHeldReview`）の両方で渡す。
    上限でエスカレーションした指摘（`pendingRemarks`）を、人が続けて差し戻しても失わない。
  - 返信を待つ提出の判定（`awaitingRemarkReplies`・`remarkRepliesDue`）と、投稿（`postRemarkReplies`）。
    実行の入口（`runNextInner`）と、実行待ちの判定（`queuedTaskIds`）に足した。
  - レビューの工程に渡す読み取り（`reviewFeedback`）だけ、sacty の返信を含める。
- `apps/daemon/src/remark-reply.ts`（新しいファイル）：返信の本文・目印・元のコメントの URL。
- `apps/daemon/src/github.ts`
  - 行へのコメントへの返信（`replyToReviewComment`）と、目印のある行へのコメントの検索（`findReviewComment`）。
  - `feedback` は、タスクのアカウントが投稿した、目印 `<!-- sacty-reply:` で始まる投稿を除く。含める指定（`includeSactyReplies`）があれば含める。
- `apps/daemon/src/prompts.ts`：指摘への対応の形に `status` を足し（`statusLines`）、`extractBlocks` で読む（知らない値は、無いものとして扱う）。
- `apps/web/src/lib/labels.ts`・`apps/web/src/i18n/messages/labels.ts`：作業履歴の行（ja・en）。
- 文書：`docs/spec/approval.md`（「指摘への対応の返信」の節）・`docs/spec/tasks-and-steps.md`・`docs/user/tasks.md`（「指摘への返信」の節）・`docs/user/intake.md`（どれも日本語と英語）、ADR。

実装の途中で決めたこと（理由は ADR）。

- 1件の指摘には、1回だけ返信する。
  工程のエージェントは、提出のたびに、有効な指摘すべてに対応を書くので、提出のたびに返信すると、古い指摘への返信が増え続ける。
- 前の工程に戻した指摘（実装の PR の指摘を、設計で直したなど）は、その工程の対応を、元の PR を更新した提出で返信する。
- 行への返信の答えを受け取れなかったときは、PR のコメントに回す前に、投稿済みの返信を探し直す。
- 引き継いだ PR の指摘の ID には、取り込みのキー（`review_comment:<ID>` など）を使う。対応は、`sacty-responses` に同じ形で書かせ、
  渡した指摘のキーを ID に持つものを、`ContinuedFeedbackPassed` の `responses` に残す（`Task.continuedResponses`）。
  差し戻しの指摘（`Task.remarks`）にはしない。
- 引き継いだ PR では、対応が要らないもの（作者の返答・済んだやり取りなど）に、対応を書かせない。
- 引き継いだ PR の作り直しの指示では、返信した指摘に `answered` の印を付ける。

範囲の変更：はじめは、引き継いだ PR の指摘への返信を含めていなかった（含めるかを人に尋ねて、答えを待っていた）。
実装の途中で「今回に含める」と決まったので、同じ PR に足した。

## 確かめたこと

- `./node_modules/.bin/biome check --write .`：直すものなし。
- `npm run lint`・`npm run typecheck`・`npm run build`：通過。
- `./node_modules/.bin/vitest run --no-file-parallelism`：221 ファイル・4429 件が通過（1 件はスキップ）。
- `./node_modules/.bin/vitest run tests/docs`：通過。
- 足したテスト
  - `apps/daemon/src/daemon.test.ts`「取り込んだ PR の指摘への対応を、PR に返信する（PBI-352）」（16 件）と、再レビューへの受け渡し（1 件）。
    指摘が 0 件（対応なし）・1 件・複数、行への返信が失敗して PR のコメントに回る、答えを受け取れなかった返信を見つける、投稿が失敗する、
    投稿と記録の間で止まった後の再実行、一時停止、次の差し戻し、エスカレーション、一時停止の間に届いた指摘、設計に戻した指摘、
    セキュリティのタスク、アカウントの無いプロジェクト、取り込み直さないこと。
  - 同じファイルの「引き継いだ PR の指摘への対応を、PR に返信する（PBI-352）」（4 件）。指示に渡す ID と対応の形、行への返信と PR のコメント、
    渡していない ID を読まないこと、後の提出で繰り返し返信しないこと、返信した指摘の印、投稿と記録の間で止まった後の再実行、
    投稿の失敗、対応が 0 件（前の形の出力）。
  - `apps/daemon/src/remark-reply.test.ts`：本文の形、秘密情報が上限の位置をまたぐときに前半を残さないこと。
  - `apps/daemon/src/github.test.ts`：返信の API、目印の検索、取り込みからの除外と、含める指定。
  - `apps/daemon/src/prompts.test.ts`：`status` の読み取り（知らない値・前の形の出力）。
  - `packages/core/src/projection.test.ts`：投影と、以前の作業履歴（どの項目も無い）。
  - `apps/web/src/lib/labels.test.ts`：作業履歴の行（ja・en）。
- 修正を戻すと落ちること：`service.ts`・`github.ts`・`prompts.ts`・`projection.ts` の 19 か所を 1 つずつ戻して、足したテストを実行した。
  18 か所でテストが落ちた（うち 1 か所は、はじめ落ちなかったので、確かめる行を足した）。残りの 1 か所（投稿の直前の、一時停止・中止を求められているかの確認）は、状態の確認と重なっていて、
  戻しても結果が変わらなかった（承認を待つ提出のコメントの投稿と同じ書き方として残した）。
- 一時の環境（架空のデータと、GitHub の API の代わり）でこのブランチを起動し、承認待ちに戻ったタスクの対応が返信され、
  作業履歴に行が出ることを、画面で確かめた（動画を撮った）。
- 確かめていないこと：本物の GitHub への投稿（行へのコメントへの返信の API）は、テストでは代わりの実装で確かめた。
  マージの後、動いている環境で、実物の PR で確かめる。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 行へのコメントへの返信（スレッドの中の投稿）から取り込んだ指摘への返信は、GitHub が返信への返信を受け付けないので、PR のコメントになる。
  スレッドの先頭のコメントへ返信する形にするかは、決めていない。
