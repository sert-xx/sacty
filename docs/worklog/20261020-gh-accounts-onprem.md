# オンプレの GitHub Enterprise Server のアカウントがプロジェクトの設定に出ない問題を直す

- 日付: 2026-10-20（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-7e9d8578-id6e2p
- 関係する ADR: [gh がトークンを確かめられなかったアカウントも選べるようにし、プロキシ・CA の環境変数を gh に渡す](../adr/20261020-1059-gh-accounts-keep-unverified.md)

## 目的

`gh auth status` でログイン済みなのに、オンプレの GitHub Enterprise Server のリポジトリを対象にしても、プロジェクトの設定のアカウントの選択肢に
出ないという報告があった。原因を直し、Sacty が認識しているアカウントの一覧を画面で確かめられるようにする。

## 原因

- デーモンは `state` が `success` のアカウントだけを返していた。
- gh に渡す環境変数にプロキシ・CA が無く、プロキシの先の GHES の API に届かないため、デーモンからの `gh auth status` では `state` が `error` になる。
  届かない GHES のホストを書いた `hosts.yml` で `gh auth status --json hosts` を動かし、`state: "error"`（理由つき）・終了コード 0 になること、
  同じアカウントで `gh auth token --hostname <ホスト> --user <アカウント>` はトークンを返すことを確かめた（gh 2.89.0）。

## したこと

- `apps/daemon/src/gh.ts`：`ghEnv` にプロキシ・CA・キーリングの環境変数を足した。`accounts()` は `success` でないアカウントも `state`・`error` を添えて返す。
- `apps/web/src/components/project-editor.tsx`：確かめられなかったアカウントに「確認できず」と添え、「Sacty が認識している gh のアカウント」の一覧
  （ホスト・アカウント・状態・理由）を足した。文言は日英。
- 仕様書（`intake`）・ユーザードキュメント（`project-settings`）の日英を直し、ADR を足した。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run apps/daemon/src/gh.test.ts apps/web/src/lib/github-accounts.test.ts apps/web/src/components/project-editor.test.ts apps/web/src/i18n`：通過。
- `npx vitest run`：`agent-sessions`・`context-mcp`・`host-mcp-processes` の 8 件が失敗。変更前のコードでも同じ 8 件が失敗する（この環境に依る）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （なし） | |
