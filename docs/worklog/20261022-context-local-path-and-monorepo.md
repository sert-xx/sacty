# コンテキストに、ローカルのディレクトリとモノレポの中のディレクトリを使えるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
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
