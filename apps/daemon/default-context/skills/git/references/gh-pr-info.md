# PR 情報と差分の取得

PR の詳細なメタデータとコード差分を、パースしやすい形式で正確に取得するときの手順。表示用の整形出力（`gh pr view` の素の出力など）はパースに使わず、JSON と unified diff を使う。

## 基本方針

- 対象リポジトリは常に `-R OWNER/REPO`（`gh api` ではパス）で明示する。カレントディレクトリのリポジトリに依存しない。
- 取得した情報は「どの先頭コミット（`headRefOid`）時点のものか」を必ず記録する。メタデータと差分の取得の間に push されると食い違うため、最後に `headRefOid` を再確認する。
- 一覧系は件数上限やページングがある。取得件数と PR の総数（`changedFiles` など）を照合し、欠けていないか確認する。
- 出力が大きい場合はスクラッチ用の一時ディレクトリに保存してから `jq` などで読む。

## 1. メタデータ

```bash
gh pr view NUMBER -R OWNER/REPO --json \
  number,title,body,url,state,isDraft,author,createdAt,updatedAt,\
baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,\
mergeable,mergeStateStatus,reviewDecision,labels,assignees,reviewRequests,milestone,\
additions,deletions,changedFiles,closingIssuesReferences,statusCheckRollup
```

- 使えるフィールドは `gh pr view --json` を引数なしで実行すると一覧表示される。
- 特定の値だけ必要なら `--jq` で抽出する（例: `--jq '.headRefOid'`）。
- `author.login` はメンションや判定に使う ID。表示名（`name`）と取り違えない。
- `mergeable` は GitHub 側で計算中だと `UNKNOWN` になる。必要なら少し待って再取得する。

## 2. 変更ファイル一覧

完全な一覧は REST API をページングして取得する。

```bash
gh api --paginate repos/OWNER/REPO/pulls/NUMBER/files \
  --jq '.[] | {filename, status, additions, deletions, changes, previous_filename}'
```

- `status` は `added`・`modified`・`removed`・`renamed`・`copied`・`changed`・`unchanged`。リネームは `previous_filename` で旧パスが分かる。
- 件数が `changedFiles` と一致することを確認する。REST の上限（3,000 ファイル）を超える PR は 5 のローカル取得を使う。
- `patch` フィールドにファイル単位の差分が入るが、大きいファイルやバイナリでは省略される。全差分の取得には使わない。
- パスだけ必要なら `gh pr diff NUMBER -R OWNER/REPO --name-only` でもよい。

## 3. コード差分（diff）

```bash
gh pr diff NUMBER -R OWNER/REPO --color=never > pr.diff
```

- `--color=never` で ANSI エスケープを確実に除く。パイプやファイルへ出す場合でも明示する。
- 出力は base とのマージベースから head までの unified diff（GitHub の PR 画面の差分と同じ）。
- コミット単位のパッチ（メッセージ・作者付き）が必要なら `--patch` を付ける。
- 同じ内容は API でも取れる: `gh api repos/OWNER/REPO/pulls/NUMBER -H 'Accept: application/vnd.github.diff'`。
- 差分が大きすぎると API がエラー（`406` / too large など）を返す。その場合は 5 のローカル取得に切り替える。

### 差分の行番号を扱うとき

- unified diff のハンク見出し `@@ -a,b +c,d @@` から、`+` 行・文脈行は新ファイル側（`RIGHT`）の行番号、`-` 行は旧ファイル側（`LEFT`）の行番号として数える。
- インラインコメントの位置を決める場合は、取得した差分の `headRefOid` とレビュー投稿時の `commit_id` を一致させる（[PR レビュー投稿](pr-review-posting.md) 参照）。

## 4. コミット・レビュー・コメント

```bash
# コミット一覧（REST は最大 250 件）
gh api --paginate repos/OWNER/REPO/pulls/NUMBER/commits \
  --jq '.[] | {sha, message: .commit.message, author: .author.login}'

# レビュー（総評・状態）
gh api --paginate repos/OWNER/REPO/pulls/NUMBER/reviews \
  --jq '.[] | {id, user: .user.login, state, commit_id, body}'

# インラインコメント（差分上のコメント）
gh api --paginate repos/OWNER/REPO/pulls/NUMBER/comments \
  --jq '.[] | {id, in_reply_to_id, user: .user.login, path, line, side, commit_id, body}'

# 通常の会話コメント
gh api --paginate repos/OWNER/REPO/issues/NUMBER/comments \
  --jq '.[] | {id, user: .user.login, created_at, body}'
```

- `--paginate` と `--jq` を組み合わせると、ページごとの結果が連続して出力される。1 つの JSON 配列として扱いたい場合は `--jq` を外して `--slurp` を付け、`jq 'add'` で結合する。
- スレッドの解決状態は REST では取れない。必要なら [PR インラインコメントへの返信・スレッド解決](gh-comment-reply.md) の GraphQL クエリを使う。
- コミットが 250 件を超える PR は 5 のローカル取得で `git log` を使う。

## 5. ローカルでの取得（大きな PR・正確な比較が必要な場合）

API の上限を超える場合や、ファイル全体の内容が必要な場合はローカルの git で取得する。

```bash
gh pr view NUMBER -R OWNER/REPO --json baseRefName,baseRefOid,headRefOid
git fetch origin BASE_REF_NAME "pull/NUMBER/head"
git diff --no-color BASE_REF_OID...HEAD_REF_OID > pr.diff      # PR 画面と同じ（マージベースからの差分）
git diff --name-status BASE_REF_OID...HEAD_REF_OID             # 変更ファイル一覧
git log --format='%H %s' BASE_REF_OID..HEAD_REF_OID            # コミット一覧
git show HEAD_REF_OID:path/to/file                             # head 時点のファイル全体
```

- 三点リーダー（`...`）はマージベースとの比較、二点（`..`）は単純比較。PR の差分と揃えるなら `git diff` は `...` を使う。
- 対象リポジトリのクローン内で実行する。`origin` が対象リポジトリでない場合（フォークのクローンなど）は、`git remote -v` で対象を指すリモート名に置き換える。
- フォークからの PR でも `pull/NUMBER/head` で取得できる。
- fetch 後に `git rev-parse FETCH_HEAD` 等で `HEAD_REF_OID` が取得できていることを確認する。base 側が更新済みで `BASE_REF_OID` と一致しない場合も、SHA を直接指定して比較すれば PR 時点の差分になる。
- 作業ツリーを変えたくない場合は `gh pr checkout` を使わず、上記のように ref の取得だけにとどめる。

## 6. 取得後の確認

- 最後に `gh pr view NUMBER -R OWNER/REPO --json headRefOid --jq .headRefOid` を再実行し、取得開始時と一致することを確かめる。変わっていたら取り直す。
- 変更ファイル数・追加/削除行数が `changedFiles`・`additions`・`deletions` と整合しているかを確認する。

## 仕様の根拠

- [GitHub CLI: gh pr view](https://cli.github.com/manual/gh_pr_view)
- [GitHub CLI: gh pr diff](https://cli.github.com/manual/gh_pr_diff)
- [GitHub CLI: gh api](https://cli.github.com/manual/gh_api)
- [GitHub REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API: Media types for pull requests (diff/patch)](https://docs.github.com/en/rest/using-the-rest-api/media-types)
