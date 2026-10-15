# ローカルコミット

ローカルリポジトリで変更をコミットするときの手順。コミットはユーザーが依頼した、または作業指示の流れで明示的に求められているときだけ行う。

## 1. コミット前の確認

1. `git status --short --branch` で現在のブランチと変更内容を確認する。
2. デフォルトブランチ（`main` など）上なら直接コミットしない。プロジェクトのブランチ規約（例: `feat/issue-N-xxx`）に従って作業ブランチを切る。
3. `git diff` と `git diff --staged` で差分を読み、コミット対象を決める。今回の作業と無関係な変更は含めない。
4. `.env`・秘密鍵・認証情報・巨大な生成物・一時ファイルが対象に混ざっていないことを確認する。中身は開かず、パス名で判断する。
5. プロジェクトにフォーマッター・リンター・テストがあれば、コミット前に通す。

## 2. ステージング

- `git add -A` や `git add .` は使わず、パスを明示して `git add <path>...` する。
- ステージ後に `git diff --staged --stat` で、意図したファイルだけが入っていることを確かめる。

## 3. コミットメッセージ

### Commitizen 形式

1 行目は Commitizen（Conventional Commits）のプレフィックスを付ける。

```
<type>(<scope>): <subject>
```

| type | 用途 |
| --- | --- |
| `feat` | 機能追加 |
| `fix` | バグ修正 |
| `docs` | ドキュメントのみの変更 |
| `style` | 動作に影響しない書式変更 |
| `refactor` | 機能追加・修正を伴わないコード改善 |
| `perf` | 性能改善 |
| `test` | テストの追加・修正 |
| `build` | ビルドシステム・依存関係の変更 |
| `ci` | CI 設定の変更 |
| `chore` | 上記以外の雑務 |
| `revert` | コミットの取り消し |

- `scope` は任意。変更対象のモジュールや機能名を短く書く。
- `subject` は変更内容を簡潔に書き、末尾に句点を付けない。言語はリポジトリの既存コミット（`git log --oneline -20`）に合わせる。
- 破壊的変更は `feat(api)!: ...` のように `!` を付け、本文末に `BREAKING CHANGE: <内容>` を書く。
- リポジトリに `.cz.toml`・`.cz.json`・`.czrc`・`pyproject.toml` の `[tool.commitizen]`・commitlint 設定があれば、その規約を優先する。
- `cz commit` は対話式なので使わず、メッセージを自分で組み立てる。

### Co-author トレーラー（必須）

コミットメッセージの末尾には必ず Co-author トレーラーを付ける。付ける内容は、**自分がどのエージェントとして動作しているか**で決める。

- **Codex** の場合: 次の 1 行を付ける。

  ```
  Co-authored-by: Codex <codex@openai.com>
  ```

- **Claude Code** の場合: Claude Code のデフォルト設定に従う。システムプロンプトやシステムリマインダーでコミットメッセージ末尾に付ける行（`Co-Authored-By: Claude ...` など）が指定されていれば、その行をそのまま付ける。独自の行を作らない。
- 自分がどのエージェントか判断できない場合は、推測で付けずユーザーに確認する。

トレーラーは本文から空行 1 行を空けた最終段落に置く。トレーラー段落の中に空行や他の文章を混ぜない。

### メッセージ例

```
feat(auth): ログイン失敗時にリトライ回数を表示する

連続失敗時にユーザーが残り回数を把握できるようにする。

Co-authored-by: Codex <codex@openai.com>
```

## 4. コミットの実行

複数行のメッセージは、一時ファイルに書いて `-F` で渡す。シェルのクォートやヒアドキュメントの差異（fish など）による崩れを避けられる。

```bash
git commit -F <一時ファイル>
```

- pre-commit フックが失敗したら、原因を直して再ステージし、**新しいコミットとして**やり直す。`--no-verify` でフックを飛ばさない。
- ユーザーの依頼がない限り `--amend`・`rebase`・`push --force` などで既存の履歴を書き換えない。
- `push` はユーザーの依頼があるときだけ行う。

## 5. コミット後の確認

```bash
git log -1 --format='%H%n%B'
git status --short
```

- 1 行目が Commitizen 形式であること、末尾に正しい Co-author トレーラーがあることを確認する。
- `git log -1 --format='%(trailers)'` でトレーラーとして認識されているかを確かめる（空なら書式が崩れている）。
- 意図しない未コミット変更やステージ漏れが残っていないかを確認する。

## 仕様の根拠

- [Commitizen](https://commitizen-tools.github.io/commitizen/)
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/)
- [GitHub Docs: Creating a commit with multiple authors](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)
- [git-interpret-trailers](https://git-scm.com/docs/git-interpret-trailers)
