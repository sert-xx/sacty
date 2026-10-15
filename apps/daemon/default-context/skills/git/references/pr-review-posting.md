# PR レビュー投稿

PR の査読結果を GitHub に投稿するときの形式。レビュー自体の観点や重要度判定は、依頼と適用中のレビュースキルに従う。

## 先に確かめること

この手順は、自分で投稿するように頼まれたときだけ使う。
依頼した側（呼び出したツールやプロンプト）が、出力の形と投稿のしかたを決めているときは、それに従う。

- 自分では投稿しない（`gh pr review`・`gh api` などで、レビュー・コメント・返信を書かない）。
  依頼した側も投稿するので、同じレビューが二重になる
- 決められた形で結果を返す。
  この手順の形（総評だけの本文、JSON を貼らないなど）と食い違うときは、依頼した側の形を優先する
- `@login` のメンションや、AI エージェントによる投稿である旨を依頼した側が付けるなら、自分では書かない

## 投稿する形

- レビューの種類は常に `COMMENT`。`APPROVE` や `REQUEST_CHANGES` にしない。
- レビュー本文には、PR 作者の GitHub login への `@` メンションと、AI エージェントによる投稿である旨を必ず含める。短い総評の例：「@PR_AUTHOR AI エージェントによるレビュー投稿です。判定は「修正が必要」です。3 点コメントしています。」`PR_AUTHOR` は実際の login に置き換える。必要なら検証の制約を一文だけ添える。総評には判定（修正が必要・提案あり（マージは可）・指摘なし）を入れる。指摘の全文を本文に並べない（位置を付けられない指摘は除く。「投稿前の確認」の 4）。
- 採用した指摘は、**1 指摘につき対象箇所のインラインコメント 1 件**にする。重複した指摘は統合する。コメント本文は `[要修正]` または `[提案]` で始め、条件・影響・直し方をその箇所で理解できるように書く。
- 指摘が 0 件なら、指摘なしの総評だけを 1 件の `COMMENT` レビューで投稿してよい。
- 複数のインラインコメントを個別に投稿しない。通常の PR コメントで代用しない。インラインコメントを本文の JSON ブロックとして貼り付けない。

総評とインラインコメントの文章は、スキル `writing` に従って書く。

## 投稿前の確認

1. `gh pr view <番号> -R <owner>/<repo> --json author,headRefOid,files,reviews` と `gh pr diff <番号> -R <owner>/<repo>` で、PR 作者の `author.login`、現在の先頭コミット、差分を確認する。表示名ではなく `author.login` を本文のメンションに使う。
2. 各指摘の `path`・`line`・`side` が、その先頭コミットの PR 差分に存在することを確かめる。追加行または文脈行は `RIGHT`、削除行は `LEFT`。通常は 1 行に付け、必要なときだけ `start_line`・`start_side` で範囲を示す。
3. 本文に `author.login` の値に `@` を付けたメンションと、AI エージェントによる投稿の明記があることを確認する。投稿直前に先頭コミットを再確認する。変わっていたら差分位置と指摘を見直す（見直せないときは、レビューしたコミットを `commit_id` にして投稿し、どのコミットのレビューかを総評に書く）。
4. 差分中の対象箇所へ正確に付けられない指摘は、関連する変更行に付けられるか検討する。適切な位置が無ければ、次のように扱う。
    - 対話で依頼した人がいれば、勝手に総評へ移さず、投稿前に状況を伝えて扱いを確認する
    - 確かめる相手がいない（自動で実行していて、人が途中で答えない）ときは、止まらずに、`[要修正]`・`[提案]` の頭を付けて総評に書き、位置を付けられなかったことを添える

## 一括投稿

指摘がある場合は GitHub の「Create a review」API を `gh api` から **1 回**呼ぶ。JSON を一時ファイルに作り、投稿前に内容と構文を確認する。`comments` に全インラインコメントを入れる。

```json
{
  "commit_id": "現在のPR先頭コミットSHA",
  "body": "@PR_AUTHOR AI エージェントによるレビュー投稿です。判定は「修正が必要」です。2 点コメントしています。",
  "event": "COMMENT",
  "comments": [
    { "path": "src/example.ts", "line": 42, "side": "RIGHT", "body": "[要修正] この入力では...。...してください。" },
    { "path": "src/other.ts", "line": 18, "side": "RIGHT", "body": "[提案] この場合は...。...するとよいです。" }
  ]
}
```

```bash
jq empty /tmp/pr-review.json
gh api --method POST repos/OWNER/REPO/pulls/NUMBER/reviews --input /tmp/pr-review.json
```

指摘がない場合も `event: "COMMENT"` のレビューを投稿する。`gh pr review <番号> -R <owner>/<repo> --comment --body-file <総評ファイル>` を使ってよい。

投稿結果の `id`・`state`・`html_url`・`body` を確認し、`state` が `COMMENTED` であり、本文に作者へのメンションと AI エージェントによる投稿の明記があることを確かめる。続けて `gh api repos/OWNER/REPO/pulls/NUMBER/reviews/REVIEW_ID/comments` を読み、件数・`path`・本文・対象位置を投稿予定と照合する。レスポンスの `line`・`side` が `null` でも、`position`・`original_position` と `diff_hunk` が対象行を示し、個別の `html_url` が差分上の discussion を指していればインライン投稿を確認できる。`line` の有無だけで判定しない。API 呼び出しが失敗した、または応答が不明なときは、レビュー一覧で既存投稿を確認するまで再送しない。

アカウント切替が必要な場合は、[gh アカウントの切り替え](gh-account-switch.md) に従い、元のアカウントを記録し、失敗時も復帰する手順で実行する。トークンや秘密鍵の中身を読まない。

## 仕様の根拠

- [GitHub REST API: Create a review for a pull request](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
- [GitHub REST API: List comments for a pull request review](https://docs.github.com/en/rest/pulls/reviews#list-comments-for-a-pull-request-review)
- [GitHub CLI: gh api](https://cli.github.com/manual/gh_api)
