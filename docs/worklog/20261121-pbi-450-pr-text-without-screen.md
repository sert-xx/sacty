# PR の本文・コメントを、Sacty の画面を開けないレビュアーにも読みやすくする

- 日付: 2026-11-21（UTC）
- タスク: PBI-450
- PR: なし
- ブランチ: なし
- 関係する ADR: [20261121-1800-pr-text-readable-without-screen.md](../adr/20261121-1800-pr-text-readable-without-screen.md)

## 目的

GitHub の側だけで PR を読む人は、依頼した人のマシンの Sacty の画面を開けない。
PR の本文・コメントから、画面に頼る案内を無くし、レビュアーが判断に要る中身を PR の中に置く。結論の行を絞り、人が読む文の製品名を「Sacty」にそろえる。

## したこと

- `task-link.ts`（新規）：画面の URL とループバックの判定（`localOnly`）。知らせ 4 種（人に確かめてほしいこと・設計に戻した・レビューが止まった・後続に回す決定）のリンクの文の直後に注釈を添える。
- `prompts.ts`：結論を変更・最後の直しと省けない行だけにし、「レビューの進め方」（5 項目・1 項目 1 文）を結論の外に置いた。テンプレートに沿わせる本文は footer に置く。AI のレビューの行から画面の案内を無くし、「この PR のレビューの欄」にした。マージで承認した PR が無いときの要求要件（再現）の全文を `<details>` に載せ、人が確かめること・所見・子タスクの内容の省いた続きを「省いた続き」の折りたたみに載せた。
- `service.ts`：全文を入れると本文が上限を超えるときは、全文を `<!-- sacty-basis:<タスク ID> -->` のコメントに分け、本文にリンクを置く（`implementBody`・`syncBasisComments`）。PR がまだ無いときは、PR を作った直後に投稿して、本文を作り直す。Issue を作れなかった理由を、知らせの中に 1 行で書く。
- `github.ts`：`isBasisComment`。要求要件の全文のコメントを Sacty の投稿として見分ける。
- `pr-template.ts`：省いた文を、省いた文字数と GitHub の上限を書く文（`truncatedNote`）にした。`pr-body-merge.ts`：まとめの指示に、削った量を書く 1 文を足した。
- 製品名：返信・工程のコメントの書き出しと署名、Sacty のレビューの本文、知らせ 4 種、実装・要求要件・設計の PR の本文を「Sacty」にした。コマンド・目印・`sacty task <ID>` は変えない。レビューの本文を読む側は、見出しの新旧の両方を読む。
- 仕様書・利用者向けの文書（日英）と ADR を直した。古い ADR を `superseded` にし、リンクを直した。

## 本文が空のレビューの原因

GitHub が、行へのコメントへの返信 1 件ごとに、本文の無いレビューを 1 件作る。
- 確かめた：REST の `POST /pulls/{n}/comments/{id}/replies`。PR #470・#480・#499・#501 の返信のすべてに、返信ごとに別の `pull_request_review_id` が付いている。
- 確かめていない：GraphQL の `addPullRequestReviewThreadReply`（`pullRequestReviewId` を省いたとき）。書き込みができないので試していない。
- 採らない：保留中のレビューにまとめる方式。同じ PR で 1 人に 1 件しか持てず、人と同じアカウントで投稿する Sacty の返信が、人が書きかけたレビューに混ざる。
- 結果：投稿のしかたは変えない。仕様書の「指摘への対応の返信」に書いた。

## 確かめたこと

- `npm run lint`：通った（警告なし）。
- `npm run typecheck`：通った。
- `npx vitest run`（全件）：323 ファイル・6,354 件が通り、14 件はスキップ。
- `npm run build`・`npx vitest run tests/docs`：最後の変更の後に実行し、結果は下の記録に書く。
- 画面へのリンクの注釈・本文の形・全文のコメント・取り込みの見分けは、新しいテスト（`task-link.test.ts`・`pr-body-public.test.ts`・`sacty-posts-wording.test.ts`・`daemon-implement.test.ts`・`daemon-step-pull-requests.test.ts`・`github.test.ts`）で確かめた。

## 変えなかったこと

- エージェントへの指示の中の「sacty」、Sacty の画面から書かれた指摘の「内容は、タスクの画面で読めます」、返信の投稿のしかた（REST の `/replies`）、`risk-assessment.ts`、既定のコンテキスト、画面（`apps/web`）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 小文字の「sacty」が 4 か所残っている | `pr-template.ts`・`step-questions.ts`・`prompts.ts` を「Sacty」にし、テストの期待も合わせた |
| 全文のコメントに `<details` と @ の無効化が無い | `approvedBasisFullText` で、本文の折りたたみと同じ文にした（大文字・空白入りの記号も）。仕様書も合わせた |
| `limitBody` の折りたたみの数え方が大文字・空白入りに効かない | 大文字小文字を区別しない数え方にした |
| 全文のコメントの同期の失敗で PR の作成・更新が止まる | 失敗したら、リンクなしの本文（省いた量を書く）で続ける。すでにある PR は 3 方向のマージを通してから更新する |
| 注釈・Issue の失敗の理由のテストが実際の経路を通っていない | サービスに画面の URL を渡して注釈の有無を確かめるテストと、知らせの本文の全体に伏せた値が無いことを確かめるテストを足した |
| 作業履歴にひな形の節が無い | この節と「残したこと」を足した |

## 残したこと

- GraphQL の `addPullRequestReviewThreadReply` で `pullRequestReviewId` を省いたときに、空のレビューができるかは確かめていない（書き込みができないため）。
