---
name: git
description: ローカルでのコミット作成、GitHub Pull Request の情報・差分取得、PR へのレビュー投稿、PR インラインコメントへの返信やスレッド解決、gh アカウントの切り替えを git / gh で行うときに使う。コミットは Commitizen 形式のメッセージと Co-author トレーラーを付けて作成する。
---

# Git / GitHub PR 操作

作業内容に応じて、該当するリファレンスを**必ず読んでから**操作する。

| 作業 | リファレンス |
| --- | --- |
| ローカルでコミットする | [ローカルコミット](references/git-local-commit.md) |
| PR のメタデータ・差分を取得する | [PR 情報と差分の取得](references/gh-pr-info.md) |
| PR へレビューを投稿する | [PR レビュー投稿](references/pr-review-posting.md) |
| PR のインラインコメントに返信する／スレッドを解決する | [PR インラインコメントへの返信・スレッド解決](references/gh-comment-reply.md) |
| `gh` のアカウントを切り替える | [gh アカウントの切り替え](references/gh-account-switch.md) |

## 共通ルール

- コミットメッセージは Commitizen のプレフィックス（`feat:`・`fix:` など）で始め、末尾に必ず Co-author トレーラーを付ける。トレーラーの内容は自分がどのエージェント（Codex / Claude Code）かで決める。
- PR の内容は `gh` で取得する。パースする場合は JSON（`--json`・`gh api`）と unified diff を使い、取得時点の先頭コミット（`headRefOid`）を記録する。
- PR へレビューを投稿するときは、各指摘を対象箇所へのインラインコメントにし、短い総評とともに **1 件の `COMMENT` レビュー**として投稿する。総評本文には PR 作者の `@login` と、AI エージェントによる投稿である旨を必ず含める。
- PR への投稿・返信・スレッド解決・push は、ユーザーの依頼と会話の文脈で許可された範囲だけ行う。閲覧だけの依頼なら投稿しない。
- `gh` のアカウントは `gh auth status` に表示されるログイン済みアカウントの中から `gh auth switch` で切り替えてよい。作業後は元のアカウントへ戻し、戻ったことを確認する。
