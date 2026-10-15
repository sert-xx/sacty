# コントリビュートの仕方

sacty への Issue・Pull Request（PR）を歓迎します。ドキュメント・コミット・PR は日本語で書いています。

## 始める前に

- バグの報告・機能の提案は、まず [Issue](https://github.com/sert-xx/sacty/issues) で知らせてください。大きな変更は、PR の前に
  Issue で方向を相談すると、手戻りが少なくなります。
- 脆弱性は Issue に書かず、[セキュリティ](SECURITY.md) の手順で報告してください。
- 寄せていただいた変更は、このリポジトリの [ライセンス](LICENSE)（MIT）で公開されます。

## 開発の環境を用意する

macOS・Node.js 22.13 以上・Docker・GitHub CLI（`gh`）が要ります（[はじめに](docs/user/getting-started.md)）。

以下のコマンドの例では、GitHub のアカウントを `your-account`、Issue の番号を `12`、ブランチを `fix/issue-12-typo` としています。
貼り付ける前に、`your-account` などの例の値を、ご自身の値に置き換えてください。

1. GitHub で [sert-xx/sacty](https://github.com/sert-xx/sacty) を fork します。
2. fork したリポジトリを clone し、そのルートに移ります（`your-account` を、ご自身の GitHub のアカウントに置き換えます）。

   ```sh
   git clone https://github.com/your-account/sacty.git
   cd sacty
   git remote add upstream https://github.com/sert-xx/sacty.git   # 元のリポジトリの更新を取り込むため
   ```

3. 依存を入れて、ビルドします。

   ```sh
   npm ci
   npm run build
   ```

### 初めてコミットする前に：作者の名前とメールアドレスを確かめる

コミットには、Git の作者の名前とメールアドレスが入り、PR を通じて公開の履歴に残ります（後から消せません）。
初めてコミットする前に、clone したリポジトリのルートで、設定されている値を確かめてください。

```sh
git config user.name
git config user.email
```

次のときは、このリポジトリだけに値を設定してください（`--global` を付けないので、ほかのリポジトリの設定は変わりません）。

- 何も表示されないとき：設定されていないと、`git commit` が作者の情報が無いというエラー（`Author identity unknown`）で
  止まるか、コンピューターのユーザー名やホスト名から推測した値がそのまま公開の履歴に入ります。
- 表示された名前を公開したくないとき（本名など）：公開してよい名前（GitHub のアカウントなど）にします。
- 表示されたメールアドレスを公開したくないとき：GitHub の非公開用のアドレスにします。形は
  `<数字の ID>+<アカウント>@users.noreply.github.com` で、GitHub の Settings → Emails に表示されます。

```sh
git config user.name "your-account"
git config user.email "12345678+your-account@users.noreply.github.com"
```

例の `your-account` と `12345678+your-account@users.noreply.github.com` は、ご自身の公開してよい名前と、Settings → Emails に
表示される非公開用のアドレスに置き換えてください。

## 変更の流れ

1. 元のリポジトリの `main` を取り込み、作業用のブランチを切ります（例 `feat/issue-<番号>-<内容>`・`fix/<内容>`）。
   `main` には直接コミットしないでください。

   例のブランチ名 `fix/issue-12-typo` は、ご自身の変更に合う名前に置き換えてください。

   ```sh
   git fetch upstream
   git switch -c fix/issue-12-typo upstream/main
   ```

2. 変更します。実装を変えたら、同じ PR で docs も直してください（下の「ドキュメント」）。
3. 下の「PR を出す前に確かめること」をすべて通します。
4. コミットして、fork したリポジトリに push します。例の `docs/user/cli.md` は変えたファイルに、メッセージとブランチ名は
   ご自身のものに置き換えてください。

   ```sh
   git add docs/user/cli.md
   git commit -m "fix: コマンドの説明の誤字を直す"
   git push -u origin fix/issue-12-typo
   ```

5. PR を作ります。GitHub の fork したリポジトリの画面に出る「Compare & pull request」から作るか、`gh` で作ります。
   向き先は `sert-xx/sacty` の `main` です。

   ```sh
   gh pr create --repo sert-xx/sacty --base main
   ```

   PR の本文には、何をなぜ変えたか・確かめたこと（コマンドと結果）・確かめていないことを書いてください。関係する Issue が
   あれば `Closes #<番号>` で結びます。

コミットのメッセージは `feat:`・`fix:`・`docs:`・`chore:` などの種類で始め、内容を1行で書きます（例 `fix: 〜のときに〜する`）。

## PR を出す前に確かめること

```sh
npm run lint        # Biome（整形と lint）。整形は npm run format で直せる
npm run typecheck   # TypeScript の型検査
npx vitest run      # テスト（docs の規則のテストを含む）
npm run build       # すべてのパッケージのビルド
```

- 振る舞いを変えたら、テストを足すか直してください。直したテストは、変更を戻すと失敗することも確かめてください。
- docs だけを変えたときも、`npx vitest run tests/docs` で docs の規則（ファイル名・リンク切れ・ADR の置き換えの関係）を確かめてください。

## ドキュメント

docs は4種類（仕様書・ユーザードキュメント・ADR・作業履歴）に分けて `docs/` に置いており、種類ごとにメンテナンスの方針が違います。
方針と書き方の規則は [docs の入口](docs/README.md) にあります。要点は次のとおりです。

- 実装の振る舞いを変えたら、同じ PR で [仕様書](docs/spec/README.md) を直します。利用者に見える変更（設定・コマンド・画面・既定値・
  エラーの文言）なら、[ユーザードキュメント](docs/user/README.md) も直します。
- 方針や仕様を決めた・変えたら、[ADR](docs/adr/README.md) を足します。古い ADR の本文は書き換えません。
- タスク（PR）ごとに [作業履歴](docs/worklog/README.md) を足します。
- 公開リポジトリなので、特定の組織や勤め先の内部を指す語・その組織の名前・秘密の値（トークン・パスワード・鍵）・個人の情報を、
  コード・テスト・docs・コミット・PR に書かないでください。例の値は `example.com`・`acme` のような架空のものにします。

AI のエージェント（Claude Code・Codex）で作業するときのために、同じ方針をスキル（`.claude/skills/sacty-docs/`・
`.agents/skills/sacty-docs/`）として置いています。
