# コンテキストリポジトリの images.yaml にイメージを定義でき、デーモンが起動の後に裏で作るようにする

- 日付: 2026-11-11（UTC）
- タスク: PBI-325
- PR: なし
- ブランチ: ccr-c948a1e8-xm8eih
- 関係する ADR: [コンテキストリポジトリにイメージを定義できるようにし、デーモンが起動の後に裏で作る](../adr/20261111-0038-context-images-built-by-daemon.md)

## 目的

機能やリポジトリごとに要るイメージ（Playwright のブラウザなど）を、各自の `config.yaml` ではなくプロジェクトのコンテキストリポジトリで定義できるようにする。

- 各自の `config.yaml` の `images` も、これまでどおり使える。
- `sacty image build` は `config.yaml` のイメージだけを作る。
- コンテキストのイメージは、sacty の起動の後にデーモンが裏で非同期に作る。
- 画面には、作成中であることを出す。
  失敗したときは、理由・ログ・作り直しを出す（利用者と決めた）。
- 作成中に、タスクがそのイメージを選ぼうとしたときは、作り終えるまで待つ（利用者と決めた）。

## したこと

- イメージの定義のスキーマを `apps/daemon/src/image-schema.ts` に分けた（`config.ts` → `host-mcp.ts` → `context.ts` → `config.ts` の循環の読み込みを避けるため）。
  `config.yaml` の `images` と `images.yaml` で同じものを使う。
- `context.ts`：層の `images.yaml` を読み（`image` と知らない項目は書けない）、`mergeNamed` で合成し、`locked`・`remove` に `images` を足した。
  デーモンが読むための `contextImages` を足した。
- `context-images.ts`：`ContextImageBuilder`。
  プロジェクトごとにコンテキストを読み、定義の中身のハッシュの名前で、無いものを1つずつ作る。
  状態・ログの末尾・作り直し・待ち・古いものの片付けを持つ。
- `service.ts`：`projectImagesConfig` で、タスクのプロジェクトのイメージを `config.yaml` の `images` に足して、工程の選択・実行・検証・作成時の指定などで使う。
  作成中・失敗のものは、選べるが実行のときに理由で止める（`resolveImage` の `unavailable`）。
  `awaitingContextImages` で、作成中は、イメージを使うかもしれないタスクの実行を始めない（上限60分）。
  状態に `contextImages` を載せ、読めなかった・同じ名前だったことを `warnings` に載せた。
- `server.ts`：作り直しの API と、プロジェクトの保存・削除での読み直し。
- `main.ts`・CLI：デーモンに `SACTY_DOCKER_DIR`（Dockerfile の場所）を渡し、起動の後に作り始める。
- 画面：どの画面にも「イメージの作成」（作成中・順番待ち・失敗・ログ・作り直す）を出し、5秒ごとに取り直す。
  イメージの選択肢に、そのプロジェクトのコンテキストのイメージを足した。
- 文書：ユーザードキュメント（`images.md`・`context.md`・`cli.md`）・仕様書（`daemon-lifecycle.md`・`context.md`・`configuration.md`）を日英で直し、ADR を足した。

## 確かめたこと

- `npx tsc -b packages/core apps/daemon packages/cli`・`npm run typecheck -w @sacty/web`：通った。
- `npx biome check .`：通った。
- `npx vitest run apps/daemon/src/context-images.test.ts`：15件通った（作る・作らない・待つ・順に作る・失敗と作り直し・定義の変更・同じ名前・Docker に接続できない・読めない・片付け）。
- `npx vitest run apps/daemon/src/context.test.ts`：`images.yaml` の合成・上書き禁止・取り除き・書けない項目を足し、通った。
- `npx vitest run apps/daemon/src/daemon.test.ts`：1149件通った（足した5件：作成中は待ち、作り終えたら候補に出してそのイメージで実行する・上限で一時停止・config.yaml のイメージなら待たない・失敗したイメージの工程は止まる・作成時の指定）。
- `npx vitest run tests/docs`：通った。
- 全体の `npx vitest run`：この環境では、変更前から次が失敗する（root で動かしている・git の版・Playwright のブラウザの版の違い）。
  `repository.test.ts`・`host-mcp-processes.test.ts`・`context-mcp.test.ts`・`agent-sessions.test.ts` の 17 件と、ブラウザのテスト 2 ファイル。
  変更前のコードでも同じ 17 件が失敗することを確かめた。
- 実際の Docker でコンテキストのイメージを作ることは、この環境に Docker が無いので確かめていない。
- Node.js は 22（`mise.toml` は 26.12.1）で確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |
