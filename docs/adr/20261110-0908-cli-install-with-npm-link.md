# sacty コマンドを npm link で入れる npm run cli:install を足し、入れた後にリンクの向き先と版を確かめる

- 日時: 2026-11-10 09:08 UTC
- ステータス: 採用
- 関係する PR・タスク: #334
- 置き換え元: なし
- 置き換え先: なし

## 背景

`sacty` コマンドは `npx sacty` で使う決まりで、sacty のリポジトリの中（ワークスペースの `node_modules/.bin/sacty` が見える場所）でしか使えなかった。
リポジトリの外で `npx sacty` を実行すると、npm のレジストリにある別の「sacty」を探しに行く（sacty は `private: true` で公開していない）。
`sacty launch`（[ADR](20261110-0011-launch-local-agent-with-project-context.md)）を、対象リポジトリの手元の clone のディレクトリで呼びたいという要望があった。
あわせて、版を上げるたびに入れ直しても、確かに新しい版に切り替わるようにしたいという要望があった。

## 決定

- ルートの `package.json` に `cli:install`（`npm run build && node scripts/cli-install.mjs`）を足す。
  `scripts/cli-install.mjs` は `packages/cli` で `npm link` を実行し、`sacty` コマンドを npm のグローバルの bin に入れる。
- 入れた後に、次を確かめる。
  - npm のグローバルの bin の `sacty` が、このリポジトリの `packages/cli/bin/sacty.js` を指すこと（違えば失敗）。
  - その `sacty --version` が、このリポジトリの `packages/cli/package.json` の版を出すこと（違えば失敗）。
  - `PATH` で最初に見つかる `sacty` が、このリポジトリを指すこと（違う・`PATH` に無いときは注意だけ）。
- 版を確かめるために、CLI に `sacty --version` を足す。
- 画面の更新の知らせに出すコマンドは `npm run build` のまま変えない。

## 理由

- `npm link` にしたのは、グローバルに入れるのがリポジトリへのリンクだけで、版を上げてビルドし直せば、入れ直さなくても新しい版で動くため。
  `npm install -g` はワークスペースの依存（`@sacty/core` など）がレジストリに無いので使えない。
  `npm link` が作業ツリー（`package-lock.json`・ワークスペースの `node_modules`）を書き換えないこと、別の場所の clone で実行するとリンクの向き先が置き換わることを、実際に確かめた。
- スクリプトの名前を `install` にしなかったのは、`install` は npm の決まった名前で、`npm install`・`npm ci` のたびに自動で実行され、依存を入れるたびにビルドとリンクが走るため。
- 入れた後に向き先と版を確かめるのは、「切り替わった」ことを利用者が確かめられるようにするため。前の clone を指したまま・ビルドしていない・別のパッケージの `sacty` が先にある、を見分けられる。
  `PATH` の順は利用者の環境なので、止めずに注意にした。シェルの `alias` はスクリプトから見えないので、文書で知らせる。
- 更新の知らせのコマンドを変えないのは、リンクするかは利用者が選ぶことで、リンクしていても `npm run build` で新しい版になるため。

## 影響

- 動いている `sacty up` は、入れ直しても前の版のまま動く（止めて起動し直す）。
- 仕様は [アーキテクチャ](../spec/architecture.md#パッケージ)、利用者向けは [はじめに](../user/getting-started.md#どのディレクトリでも-sacty-を使う) と [CLI](../user/cli.md) に書く。
