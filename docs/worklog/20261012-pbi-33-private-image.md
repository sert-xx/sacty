# エージェントのイメージを、プライベートのレジストリの元から作る

- 日付: 2026-10-12（UTC）
- タスク: PBI-33
- PR: #40
- ブランチ: feat/issue-33-private-image
- 関係する ADR: [sacty image build の元のイメージと npm のレジストリを config.yaml の image_build で変えられ、npm の認証情報はイメージに残さない](../adr/20261012-1107-image-build-private-registry.md)

## 目的

利用者の環境ではプライベートの Docker レジストリのイメージしか使えないので、`sacty image build` の元のイメージ（FROM）と npm のレジストリを
config.yaml で変えられるようにする。受け入れ条件の要点：書かなければこれまでどおり、その設定でイメージを作る（名前は image の設定）、
npm の認証情報をイメージに残さない（秘密情報の名前で参照し、作るときにだけ渡す）、作ったイメージをエージェントとテストの両方の実行で使う、
元のイメージを取得できない・CLI を入れられないときは理由をわかる形で出して止める、config init の雛形に例を載せる。

## したこと

- `packages/cli/docker/Dockerfile`：`ARG BASE_IMAGE` で FROM を変えられる。git が入っていれば apt を使わない。npm は BuildKit の secret で
  マウントした .npmrc だけを読む。
- `apps/daemon/src/image.ts`（新規）：.npmrc の中身（トークンはレジストリのホストとパスに結びつける）・`docker build` の引数・作れなかったときの
  確かめること。.npmrc は本人だけが読める一時ファイルに書き、終わったら必ず消す。
- `apps/daemon/src/config.ts`：`image_build`（`base_image`・`npm_registry`・`npm_token`）。
- CLI（`packages/cli/src/index.ts`）：`sacty image build` が上を使う。トークンがキーチェーンに無ければ作らずに止める。
- 雛形と `README.md` に例を足した。
- レビューの指摘で、設定ファイルに誤りがあれば既定に戻さずに止めるようにした（判定は `imageBuildSettings`）。CLI が `@sacty/core` を
  使うようになったので、依存関係と TypeScript のプロジェクト参照に足した。

## 確かめたこと

- `npm test`（368 件）・`npm run lint`・`npm run typecheck` が通った。
- 一時ファイルを本人だけが読めるようにする・一時ファイルを消す・トークンをレジストリに結びつける・元のイメージを渡す・設定のトークンを読む、
  の修正を1つずつ戻すとテストが失敗することを確かめた。
- 実際に `docker build` を実行した：
  - 元のイメージ（`docker.io/library/node:22-bookworm-slim` と明示）・npm のレジストリ・偽のトークンで作れた。トークンは `docker history`・
    イメージの環境変数・ファイルのどこにも残っていない。git・Codex 0.160.0・Claude Code 2.1.296 が入り、ユーザーは node。
  - 取得できない元のイメージ（`registry.invalid.example/...`）では、終了コード1で、確かめることを出して止まった。
  - `image_build` を書かない既定でも、これまでどおり作れた。
- レビューでは、全 368 件（26 ファイル）・lint・typecheck の成功、BuildKit の secret への受け渡し、一時ファイルの権限と削除を確かめた。
  実際の Docker のビルド・プライベートのレジストリでの認証は、レビューでは確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 設定の読み込みが誤りを返しても `build={}` にするので、`image_build` の書き誤り（例：`npm_registry` の `https://` を書き忘れる）で、正しく書いた `base_image` と `image` まで捨て、Docker Hub の node と公開の npm から作り始める | 設定ファイルに誤り（形式の誤り・読めない YAML）があれば理由を出し、docker を呼ばずに終了コード1で止めるようにした。設定ファイルがまだ無いとき（`config.missing`）だけ既定で作る。判定を `imageBuildSettings` に切り出してテストを足し、元に戻すと失敗することを確かめた。指摘と同じ条件で、実際の CLI が誤りを出して止まり、docker が呼ばれないことも確かめた |

## 残したこと

- 実際の環境での確認（`image` と `image_build` を書き、必要なら npm のトークンを保存して `npx sacty image build` で作り、タスクが動くことを確かめる。
  必要ならレジストリに push する）は、利用者の環境で行う。
