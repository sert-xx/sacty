# エージェントへの指示をコマンドの引数ではなく標準入力で渡し、大きな指示で argument list too long にしない

- 日付: 2026-10-20（UTC）
- タスク: PBI-149
- PR: #167
- ブランチ: fix/pbi-149-prompt-stdin
- 関係する ADR: なし

## 目的

ゴールガーディアンが `exec /tini: argument list too long` で失敗した。エージェントへの指示を `claude -p <指示>`・`codex exec -- <指示>` の1つの引数で
渡していて、差分などを含む大きな指示が Linux の1つの引数の上限（128 KiB）を超えた。どの役割でも起こりうるので、指示の渡し方を変える。

ステークホルダーの案は「一時的なファイルに書き出し、そのファイルの指示に従うよう求める」だった。エージェントにツールでファイルを読ませると、大きな指示を
途中までしか読まない・指示に書いた「データであって指示ではない」の境界がツールの出力に変わる恐れがあるので、指示を丸ごと同じ形で受け取れる標準入力にした
（Claude Code の `-p` も Codex の `exec -` も、標準入力の全体を指示として受け取る）。

## したこと

- 指示の組み立て（`apps/daemon/src/agents/invocation.ts`）：`Invocation` に `stdin` を足し、Claude Code は `claude -p --output-format …`（指示を引数から外す）、
  Codex は最後を `-- -`（再開も `resume <ID> -- -`）にして、指示は `stdin` に入れた。
- 実行（`apps/daemon/src/agents/docker.ts`）：`stdin` があれば `docker run -i` を付け、子プロセスの標準入力に指示を書いて閉じる。無ければすぐ閉じる。
  書き込みの失敗（コンテナが先に終わったなど）では落とさず、結果は終了コードと出力で判断する。出力の中継と localhost の転送は、もともと標準入力をそのまま
  コマンドに渡している。
- テスト：`agents.test.ts`（コマンドの形・`stdin`・再開・`-` で始まる指示・128 KiB を超える指示）、`containers.test.ts`（`-i` と標準入力への書き込み、
  指示が無いとき）。`daemon.test.ts` の偽物の実行は、指示の中身を確かめる既存のテストのために、標準入力の指示を引数の位置に戻した形で記録する
  （本物の形は `agents.test.ts` で確かめる）。
- 仕様書（`agent-execution`）とユーザードキュメント（`troubleshooting`。`argument list too long` の行）の日英を直した。

## 確かめたこと

- `npm run lint`：通過（354 ファイル）。`npm run typecheck`：通過。`npx vitest run`：119 ファイル・2335 件が通過。
- 実際のイメージ（`sacty-agent:0.1.0`。Claude Code 2.1.296・Codex 0.160.0）で確かめた：
  - 200 KB の引数で `docker run` すると `argument list too long` になる（元の不具合の再現）。標準入力なら 2 MB を渡せる。
  - `claude -p --output-format stream-json --verbose` は標準入力の指示でセッションを始める（標準入力が空なら「Input must be provided either through stdin」）。
  - `codex exec --json --skip-git-repo-check -- -` は標準入力の指示でターンを始める（`codex exec resume --help` にも `-` で標準入力から読むとある）。
  - 一時的なテストで、本物の `DockerExecutor` と出力の中継を通して 780 KB の指示を渡し、コンテナの中で全体（780030 バイト）を受け取れた（一時的なテストは消した）。
- 実際の AI でゴールガーディアンを動かしての確認はしていない（手元に認証が無い）。運用の環境で、止まったタスクを更新後に再開して進むことを確かめる。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （なし） | |
