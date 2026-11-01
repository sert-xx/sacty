# コントリビュートの仕方

sacty への Issue・Pull Request（PR）を歓迎します。
ドキュメント・コミット・PR は日本語で書いています。
README・仕様書・ユーザードキュメントには、英語の版 `*.en.md` もあります。

## 始める前に

- バグの報告・機能の提案は、まず [Issue](https://github.com/sert-xx/sacty/issues) で知らせてください。
  大きな変更は、PR を出す前に Issue で方向を相談すると、手戻りが少なくなります。
- 脆弱性は Issue に書かず、[セキュリティ](SECURITY.md) の手順で報告してください。
- 寄せていただいた変更は、このリポジトリの [ライセンス](LICENSE)（MIT）で公開されます。

## 開発の環境を用意する

macOS・Node.js 26.12.1 以上・Docker・GitHub CLI（`gh`）が要ります（[はじめに](docs/user/getting-started.md)）。
Node.js の版は、リポジトリのルートの `.node-version` と `mise.toml` に書いてあります。
mise・nodenv・fnm などの版の管理ツールで、ディレクトリに合わせて版を切り替える設定（mise の `mise activate`、fnm の `--use-on-cd` など）をしていれば、ルートに移るとその版が使われます。
その設定をしていなければ、`npm ci` の前に `fnm use` などで切り替えてください（版が入っていなければ、ツールの手順で入れてください）。
`node -v` で、使われている版を確かめられます。

このページのコマンドの例では、次の値を使っています。
貼り付ける前に、ご自身の値に置き換えてください。

| 例の値 | 置き換えるもの |
| --- | --- |
| `your-account` | GitHub のアカウント |
| `12` | Issue の番号 |
| `fix/issue-12-typo` | 作業用のブランチの名前 |

1. GitHub で [sert-xx/sacty](https://github.com/sert-xx/sacty) を fork します。
2. fork したリポジトリを clone し、そのルートに移ります。

   ```sh
   git clone https://github.com/your-account/sacty.git
   cd sacty
   git remote add upstream https://github.com/sert-xx/sacty.git   # 元のリポジトリの更新を取り込むため
   ```

3. 依存を入れて、ビルドします。

   ```sh
   npm ci
   npx playwright install chromium
   npm run build
   ```

質問フォームのブラウザーテストには Chromium を使います。
上のインストールコマンドでブラウザーを用意してください。
CI でテストを実行するときも、`npm ci` の後に `npx playwright install --with-deps chromium` を実行し、Chromium と OS の依存を用意してください。

### 初めてコミットする前に：作者の名前とメールアドレスを確かめる

コミットには Git の作者の名前とメールアドレスが入り、PR を通じて公開の履歴に残ります。
公開の履歴からは後から消せません。
初めてコミットする前に、clone したリポジトリのルートで、設定されている値を確かめてください。

```sh
git config user.name
git config user.email
```

次のときは、このリポジトリだけに値を設定してください。
`--global` を付けないので、ほかのリポジトリの設定は変わりません。

- 何も表示されないとき
  - 設定しないままだと、`git commit` が作者の情報が無いというエラー（`Author identity unknown`）で止まります。
  - または、Git がコンピューターのユーザー名やホスト名から推測した値が、そのまま公開の履歴に入ります。
- 表示された名前（本名など）を公開したくないとき：公開してよい名前（GitHub のアカウントなど）にします。
- 表示されたメールアドレスを公開したくないとき：GitHub の非公開用のアドレスにします。
  形は `<数字の ID>+<アカウント>@users.noreply.github.com` で、GitHub の Settings → Emails に表示されます。

```sh
git config user.name "your-account"
git config user.email "12345678+your-account@users.noreply.github.com"
```

例の `your-account` は、ご自身の公開してよい名前に置き換えてください。
`12345678+your-account@users.noreply.github.com` は、Settings → Emails に表示される非公開用のアドレスに置き換えてください。

## 変更の流れ

1. 元のリポジトリの `main` を取り込み、作業用のブランチを切ります（例 `feat/issue-<番号>-<内容>`・`fix/<内容>`）。
   `main` には直接コミットしないでください。
   例のブランチ名 `fix/issue-12-typo` は、ご自身の変更に合う名前に置き換えてください。

   ```sh
   git fetch upstream
   git switch -c fix/issue-12-typo upstream/main
   ```

2. 変更します。
   実装を変えたら、同じ PR で docs も直してください（下の「ドキュメント」）。
3. 下の「PR を出す前に確かめること」をすべて通します。
4. コミットして、fork したリポジトリに push します。
   例の `docs/user/cli.md` は変えたファイルに、メッセージとブランチ名はご自身のものに置き換えてください。

   ```sh
   git add docs/user/cli.md
   git commit -m "fix: コマンドの説明の誤字を直す"
   git push -u origin fix/issue-12-typo
   ```

5. PR を作ります。
   GitHub の fork したリポジトリの画面に出る「Compare & pull request」から作るか、`gh` で作ります。
   向き先は `sert-xx/sacty` の `main` です。

   ```sh
   gh pr create --repo sert-xx/sacty --base main
   ```

   PR の本文には、次のことを書いてください。

   - 何をなぜ変えたか
   - 確かめたこと（コマンドと結果）
   - 確かめていないこと
   - 関係する Issue があれば `Closes #<番号>`

コミットのメッセージは `feat:`・`fix:`・`docs:`・`chore:` などの種類で始め、内容を1行で書きます（例 `fix: 〜のときに〜する`）。

## PR を出す前に確かめること

```sh
npm run lint        # Biome（整形と lint）。整形は npm run format で直せる
npm run typecheck   # TypeScript の型検査
npx vitest run      # テスト（docs の規則のテストを含む）
npm run build       # すべてのパッケージのビルド
```

- 振る舞いを変えたら、テストを足すか直してください。
  直したテストが、変更を戻すと失敗することも確かめてください。
- 画面の文言を足す・変えるときは、[画面の文言と補足](docs/spec/ui-wording.md) の規則に従ってください。
  本文は短くし、仕組みは補足に書きます。
  辞書の文字列は `apps/web/src/i18n/wording-policy.test.ts` で確かめます。
- docs だけを変えたときも、`npx vitest run tests/docs` で docs の規則（ファイル名・リンク切れ・ADR の置き換えの関係）を確かめてください。

## リリース

版は [semver](https://semver.org/lang/ja/)（`MAJOR.MINOR.PATCH`）で付け、1.0.0 から GitHub Releases で公開しています。
利用者はリポジトリを clone して使うので、リリースはタグと変更の要約を示すためのものです。
npm には公開しません。

1. 版を上げる PR を作ります。
   次のものを、すべて同じ版にします。
   - `apps/*/package.json`・`packages/*/package.json` の `version` と、ワークスペースの依存（`@sacty/core` など）の版
   - `package-lock.json`（`npm install --package-lock-only` で作り直す）
   - 既定のイメージの名前（`apps/daemon/src/config.ts` の `DEFAULT_IMAGE`。`sacty-agent:<版>`）と、それを書いている仕様書・ユーザードキュメント（日英）・テスト
   - 既定の元のイメージのダイジェスト（`packages/cli/docker/Dockerfile` の `BASE_IMAGE`・`NODE_IMAGE`）を、`docker buildx imagetools inspect <タグ>` の `Digest`（マルチアーキのインデックス）に更新する
   - エージェントの CLI の版を上げるときは、`packages/cli/docker/agent-cli/package.json` の版を変え、そのディレクトリで `npm install --package-lock-only --omit-lockfile-registry-resolved` を実行して `package-lock.json` を作り直す（取得元の URL を書かない。仕様書の版も直す）

   どの桁を上げるかは、変更の種類で決めます。

   | 変更 | 上げる桁 |
   | --- | --- |
   | 互換性の無い変更（設定ファイルの形・台帳・コマンドの引数が変わるなど） | MAJOR |
   | 機能の追加 | MINOR |
   | 修正だけ | PATCH |

   既定のイメージの名前が変わるので、利用者は更新の後に `npx sacty image build` でイメージを作り直します。
   このことをリリースの説明に書きます。
2. PR をマージしたら、main のそのコミットにタグ `v<版>`（例 `v1.0.0`）を付けて push します。
3. そのタグで GitHub Release を作ります。
   説明には、前のリリースからの変更の要約（利用者に見える変更・互換性の無い変更・更新の後にすること）を日本語で書きます。
   PR の一覧は GitHub の自動生成に任せます。

```sh
git tag -a v1.0.0 -m "sacty 1.0.0" <マージコミット>
git push origin v1.0.0
gh release create v1.0.0 --title "sacty 1.0.0" --notes-file <説明のファイル> --generate-notes
```

## ドキュメント

docs は、仕様書・ユーザードキュメント・ADR・作業履歴の4種類に分けて `docs/` に置いています。
種類ごとにメンテナンスの方針が違います。
方針と書き方の規則は [docs の入口](docs/README.md) にあり、要点は次のとおりです。

- 実装の振る舞いを変えたら、同じ PR で [仕様書](docs/spec/README.md) を直します。
- 利用者に見える変更（設定・コマンド・画面・既定値・エラーの文言）なら、[ユーザードキュメント](docs/user/README.md) も直します。
- README・仕様書・ユーザードキュメントは、日本語の版と英語の版（同じディレクトリの `*.en.md`）の両方を直します（[英語の版](docs/README.md#英語の版)）。
- 方針や仕様を決めた・変えたら、[ADR](docs/adr/README.md) を足します。
  古い ADR の本文は書き換えません。
- タスク（PR）ごとに [作業履歴](docs/worklog/README.md) を足します。
- 公開リポジトリなので、次のものをコード・テスト・docs・コミット・PR に書かないでください。
  - 特定の組織や勤め先の内部を指す語・その組織の名前
  - 秘密の値（トークン・パスワード・鍵）
  - 個人の情報

  例の値は `example.com`・`acme` のような架空のものにします。

AI のエージェント（Claude Code・Codex）で作業するときのために、同じ方針をスキル（`.claude/skills/sacty-docs/`・`.agents/skills/sacty-docs/`）として置いています。
