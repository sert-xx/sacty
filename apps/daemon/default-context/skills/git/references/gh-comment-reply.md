# PR インラインコメントへの返信・スレッド解決

人間や他のエージェントが PR に付けたインラインコメント（レビュースレッド）に返信する、またはスレッドを解決（Resolve）するときの手順。新しくレビューを投稿する場合は [PR レビュー投稿](pr-review-posting.md) に従う。

## 基本方針

- 返信・解決はユーザーの依頼、または会話の文脈で許可された範囲だけ行う。閲覧だけの依頼なら投稿しない。
- 返信本文には、AI エージェントによる返信である旨を含める。対応した場合は、何をどう直したかとコミット SHA を書く。
- スレッドの解決は「指摘への対応が完了した」または「対応不要で合意済み」の場合に限る。議論中・未対応・判断保留のスレッドは解決しない。
- 他人が解決したスレッドを勝手に未解決に戻さない。
- 返信先を間違えないよう、必ずスレッド ID とコメント ID を一覧で特定してから操作する。

## 1. スレッドの一覧取得

インラインコメントのスレッド情報（解決状態・スレッド ID）は REST では取れないため、GraphQL を使う。

```bash
gh api graphql -f owner=OWNER -f repo=REPO -F number=NUMBER -f query='
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          resolvedBy { login }
          comments(first: 100) {
            nodes { id databaseId author { login } body createdAt url }
          }
        }
      }
    }
  }
}' --paginate --slurp
```

- `gh api graphql --paginate` は、変数名が `$endCursor` であることと `pageInfo { hasNextPage endCursor }` の取得を前提にしている。名前を変えない。
- ページングされるのはスレッドだけ。1 スレッドのコメントが 100 件を超える場合は、そのスレッドを個別に取得し直す。
- `--slurp` は各ページの結果を配列にまとめる。`jq '[.[].data.repository.pullRequest.reviewThreads.nodes[]]'` で全スレッドを平坦化できる。
- 未解決だけ見たいときは `jq '... | select(.isResolved == false)'` で絞る。
- 各値の意味:
  - `id`（`PRRT_...`）: スレッドの node ID。返信（GraphQL）と解決に使う。
  - `comments.nodes[0].databaseId`: スレッド先頭コメントの数値 ID。REST で返信するときに使う。
  - `isOutdated`: 後続のコミットで対象行が変わったスレッド。返信前に現在のコードを確認する。

## 2. 返信前の確認

1. コメント本文を最後まで読み、指摘・質問の意図を把握する。スレッド内の後続コメントも読む。
2. `path` と `line` が指すコードを、現在の PR 先頭コミットで確認する（`gh pr view NUMBER -R OWNER/REPO --json headRefOid`）。
3. 修正で対応する場合は、先にコミット・push を済ませ、そのコミット SHA を返信に書く。push 前に「修正しました」と返信しない。

## 3. 返信する

返信は GraphQL か REST のどちらかで行う。本文が複数行の場合はファイルから渡す。

### GraphQL（スレッド ID を使う）

```bash
gh api graphql -f threadId=PRRT_xxx -F body=@/path/to/reply.md -f query='
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { id databaseId url }
  }
}'
```

### REST（先頭コメントの数値 ID を使う）

```bash
gh api --method POST repos/OWNER/REPO/pulls/NUMBER/comments/COMMENT_ID/replies -F body=@/path/to/reply.md
```

- `COMMENT_ID` はスレッド**先頭**コメントの `databaseId`。返信への返信は API が受け付けないので、スレッド内の後続コメント ID を使わない。
- 通常の PR コメント（`gh pr comment`）で代用しない。スレッドから切り離され、誰への返信か分からなくなる。
- 同じ返信を二重投稿しないよう、API 呼び出しが失敗・応答不明になったときはスレッド一覧を再取得して投稿済みかを確かめてから再送する。

### 返信本文の例

```
AI エージェントによる返信です。
ご指摘のとおり境界値で例外が出るため、上限チェックを追加しました（abc1234）。
```

## 4. スレッドを解決する

```bash
gh api graphql -f threadId=PRRT_xxx -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}'
```

- 返信してから解決する場合は、返信の成功を確認してから解決する。
- 誤って解決したときだけ `unresolveReviewThread(input: {threadId: $threadId})` で戻す。
- 解決にはリポジトリへの書き込み権限、または PR 作成者であることが必要。権限エラーになったらユーザーへ報告する。

## 5. 結果の確認

- 返信: レスポンスの `url` を開ける形で記録し、本文と返信先スレッドが正しいことを確かめる。
- 解決: レスポンスの `isResolved` が `true` であることを確認する。
- 複数スレッドを処理した場合は、1 の一覧を再取得し、対象スレッドの返信件数と解決状態が意図どおりかを照合する。

## 仕様の根拠

- [GitHub REST API: Create a reply for a review comment](https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment)
- [GitHub GraphQL API: addPullRequestReviewThreadReply](https://docs.github.com/en/graphql/reference/mutations#addpullrequestreviewthreadreply)
- [GitHub GraphQL API: resolveReviewThread](https://docs.github.com/en/graphql/reference/mutations#resolvereviewthread)
- [GitHub GraphQL API: PullRequestReviewThread](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread)
- [GitHub CLI: gh api](https://cli.github.com/manual/gh_api)
