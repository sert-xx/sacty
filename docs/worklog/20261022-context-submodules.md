# コンテキストのリポジトリのサブモジュールを取得する

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/serene-johnson-9niqeh
- 関係する ADR: [コンテキストのリポジトリのサブモジュールを取得し、組織で別に管理するスキルなどを写さずに使えるようにする](../adr/20261022-1503-context-submodules.md)

## 目的

組織で別のリポジトリに管理しているスキルを、コンテキストリポジトリに写さず（二重に管理せず）、git のサブモジュールで置いて使えるようにする。

## したこと

- `apps/daemon/src/context.ts`
  - `ContextFetcher` に、任意の `submodules` を足した。`resolveContext` は、git で取得した層ごとに、層のディレクトリに関わるサブモジュールを取得する（同じ取得の同じディレクトリは1回だけ）。
  - `GitContextFetcher.submodules`：`git ls-files --stage` のサブモジュール（`160000`）から層に関わるもの（`submoduleInLayer`）を選び、`git -c protocol.file.allow=never submodule update --init --recursive --depth 1 -- <パス>` で取得する。
    テストのため、ローカルのパスのサブモジュールを許すオプション `allowLocalSubmodules` を足した。
  - `copyLocalLayer`：写す前に、層のディレクトリの下のサブモジュールが取り込まれているかを確かめる（`assertSubmodulesCheckedOut`。入れ子も）。
  - `filesUnder`・`layerAgentFiles`：サブモジュールの `.git` を置かない。
- `packages/core/src/messages.ts`：`context.submoduleNotCheckedOut` を日英で足した。
- docs：仕様書 `docs/spec/context.md`、ユーザードキュメント `docs/user/context.md`（と英語の版）、ADR を足した。

## 確かめたこと

- `npm run build`・`npm run typecheck`：通った。
- `npx biome check`（変えたファイル）：指摘なし。
- `npx vitest run apps/daemon/src/context.test.ts`：足したテスト（git で取得した層のサブモジュールのスキル・層に関わらないサブモジュールを取得しないこと・`.git` を置かないこと・既定でローカルのパスのサブモジュールを取得しないこと・今の中身を読む層で取り込んでいないサブモジュールで止まること）が通った。
- `npx vitest run`：変更の前から落ちる 9 件（`context.test.ts` の MCP の時間切れの1件と、この環境を root で動かしているための `context-mcp.test.ts`・`agent-sessions.test.ts`・`host-mcp-processes.test.ts` の 8 件）を除いて通った。変更を外しても同じく落ちることを確かめた。
- GitHub などの実際のリモートのサブモジュールの取得（認証を含む）は、この環境で確かめていない（ローカルの git のリポジトリでテストした）。

## レビューの指摘と対応

なし

## 残したこと

なし
