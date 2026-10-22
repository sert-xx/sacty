# コンテキストに、ローカルのディレクトリとモノレポの中のディレクトリを使えるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #195
- ブランチ: claude/local-path-monorepo-support-b13yn0
- 関係する ADR: [コンテキストに、ローカルのディレクトリの今の中身とモノレポの中のディレクトリを使えるようにし、extends に相対パスを足す](../adr/20261022-0626-context-local-path-and-monorepo.md)

## 目的

コンテキストリポジトリを、GitHub などの git のリポジトリだけでなく、手元のディレクトリ（git で管理していない・コミットしていないものを含む）と、モノレポの中のディレクトリに置けるようにする。
モノレポの中で共通のディレクトリを継承できるよう、`extends` も合わせて直す。

## したこと

- `packages/core/src/projects.ts`
  - `ContextPath` と `ContextSource.path` を足した。エクスポートにも `path` を入れる。
  - 層の表し方 `contextLabel`（`<repo>//<path>#<ref>`）を足し、デーモン・CLI・画面の層の表示で使うようにした。
- `packages/core/src/messages.ts`：`input.invalidContextPath`・`context.pathMissing`・`context.extendsOutside`・`context.localExtendsFromRemote` を日英で足した。
- `packages/core/src/events.ts`：`ContextResolved` の層に `path` を足した。
- `apps/daemon/src/context.ts`
  - `resolveContext` で、ref の無いローカルのパス（絶対パスか `~/`）は、層のディレクトリを `.git` を除いて写し、中身すべての SHA-256 を記録する（`copyLocalLayer`・`hashTree`）。
  - git で取得するものは、同じ `repo#ref` を1回だけ取得し、`path` の層はその中のディレクトリを使う（`layerDir`。途中のシンボリックリンクは止める）。
  - `sacty-context.yaml` の `extends` に、相対パスと `{ repo, ref, path }` を足した（`extendsRef`）。git で取得した層からローカルのパスを継承させない。
- `apps/daemon/src/context-template.ts`：雛形の `sacty-context.yaml` のコメントに、相対パスと `repo`・`ref`・`path` の書き方を足した。
- `apps/daemon/src/context-mcp.ts`：ホストの MCP サーバーの層の写しの識別に `path` を入れた（同じコミットの別のディレクトリが同じ写しを使わないように）。
- `apps/web/src/components/project-editor.tsx`・`apps/web/src/i18n/messages/projects.ts`：プロジェクトの設定に「ディレクトリ」の欄を足し、ヒントと例にローカルのパスを書いた。
- docs：仕様書 `docs/spec/context.md`、ユーザードキュメント `docs/user/context.md`・`docs/user/project-settings.md`（と英語の版）、ADR を足した。

## 確かめたこと

- `npm run lint`：指摘なし。
- `npm run typecheck`：エラーなし。
- `npm run build`：通った。
- `npx vitest run packages`：162 件が通った（`ContextSource.path` の検査・`contextLabel`・エクスポートの `path`）。
- `npx vitest run apps/daemon/src/context.test.ts`：足したテスト（ローカルのディレクトリの今の中身・`~/`・モノレポの相対パスの継承と1回だけの取得・中のディレクトリが無いとき・シンボリックリンク・`{ repo, ref, path }`・リポジトリの外を指す相対パス・git で取得した層からのローカルのパスの継承）が通った。
- `npx vitest run`：今回の変更の前から main でも落ちる 9 件を除いて通った。落ちる 9 件は次のとおりで、今回の変更を外しても同じく落ちる。
  - `context.test.ts` の「実行全体の上限（30分）以上の時間切れは、警告を残す」（`docs/user/context.md` の文言をテストが探している）。
  - `context-mcp.test.ts`・`agent-sessions.test.ts`・`host-mcp-processes.test.ts` の 8 件（この環境では root で動かしているため、権限で読めないことを前提にしたテストなどが通らない）。
- 実際の画面での入力と、実際のデーモンでのモノレポの取得は、この環境にデーモンを動かす準備が無いため確かめていない（取得は `GitContextFetcher` と実際の git でテストした）。

## レビューの指摘と対応

PR #195 のレビュー（AI エージェントによるもの）で、要修正1件・提案3件の指摘があった。すべて対応した。

- [要修正] `ref` を付けたローカルの git のリポジトリの層が、ローカルのパスを継承できていた（`apps/daemon/src/context.ts` の判定が、repo がローカルかだけを見ていた）。
  - 判定を、取得の仕方（今の中身を読む層か）にした（`extendsRef` の `workingTree`）。
  - 回帰テストを足した（`context.test.ts` の「ref を付けたローカルの git のリポジトリも git で取得した層なので、ローカルのパスを継承できない」）。直す前に落ちることを確かめた。
  - 文言（`context.localExtendsFromRemote`）・仕様書・ユーザードキュメント・ADR を合わせて直した。
- [提案] ローカルのディレクトリの写しとハッシュが同期で、大きなディレクトリでデーモンを止める。
  - `copyLocalLayer`・`hashTree` を非同期（`fs/promises` の `cp`・`lstat`・`readdir`・`readlink`）にし、ファイルは `createReadStream` で少しずつ読むようにした。中止（`AbortSignal`）されたら、写すのとハッシュを途中で止める。
  - 大きなローカルの層で API の応答や停止を妨げないことは、実際のデーモンでは確かめていない。
- [提案] MCP サーバーの写しの識別に `path` を入れたことを確かめるテストが無かった。
  - `context-mcp.test.ts` に、同じ repo・commit で path と目印だけ違う2層が別の写しで起動し、同じ path なら使い回すテストを足した。`path` を識別から外すと落ちることを確かめた。
- [提案] ユーザードキュメントから「git で管理して push」の手順が消えていた。
  - ローカルのディレクトリはそのまま指定、git の URL はコミット・push してから指定、と分けて日英で書いた。

### 対応の後に確かめたこと

- `npm run lint`：指摘なし。
- `npm run typecheck`：エラーなし。
- `npx vitest run apps/daemon/src/context.test.ts apps/daemon/src/context-mcp.test.ts tests/docs`：足したテストは通った。落ちるのは、main でも落ちる既存の2件だけ。

### 再レビューの指摘と対応

- [提案] ローカルのディレクトリを写す途中・ハッシュの途中の中止を確かめるテストが無かった。
  - 中止したときの理由を、git のもの（`git.aborted`。「git を止めました」）から、ローカルの写しのもの（`context.copyAborted`）にした。
  - `context.test.ts` に、中止済みのシグナルと、写しを始めた後（ディレクトリを確かめている間）の中止で、層を返さずに中止の理由で止まり、写し終えないことのテストを足した。
    `cp` の `filter` での中止の確認を外すと、このテストが落ちることを確かめた。
  - ハッシュの途中（1つのファイルを読んでいる途中）の中止は、時間に頼らずに起こす方法が無いため、テストしていない。ファイルごとの中止の確認と、`createReadStream` に渡したシグナルで止める。

