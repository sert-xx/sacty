# セットアップと更新の手順で、依存を npm ci で入れる

- 日付: 2026-10-28（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-1f7d6c7f-x1r6et
- 関係する ADR: なし

## 目的

新しい版の知らせ（画面の上の表示）と「sacty を更新する」の手順が、依存を `npm install` で入れ直していた。
`npm install` は `package-lock.json` を書き換えることがあり、npm のレジストリを設定で変えている環境では
作業ツリーに差分が残って、次の `git pull origin main` がぶつかる。ロックファイルのとおりに入れ、ロックファイルを書き換えない `npm ci` にする。
初めて入れるときの手順も、同じ理由で `npm ci` にそろえる。

## したこと

- `apps/web/src/components/shell/update-notice-view.tsx` の `UPDATE_COMMANDS` の `npm install` を `npm ci` にした。
- `apps/web/src/components/shell/update-notice.test.ts` の期待する手順を合わせた。
- `docs/user/getting-started.md`・`.en.md` の「sacty を更新する」の手順を `npm ci` にし、理由を足した。
- `docs/spec/daemon-lifecycle.md`・`.en.md` の更新のコマンドの節に `npm ci` を使うことと理由を足した。
- 初めて入れるときの手順（`README.md`・`README.en.md`・`docs/user/getting-started.md`・`.en.md` の「セットアップ」と、Node.js の版の切り替えの説明）も `npm ci` にした。
- `CONTRIBUTING.md` の `npm install --package-lock-only`（ロックファイルを作り直す手順）は、ロックファイルを書き換えるのが目的なのでそのままにした。

## 確かめたこと

- `npx vitest run apps/web/src/components/shell/update-notice.test.ts tests/docs`：4 ファイル・99 件が通過。
- `npm run lint`・`npm run typecheck`・`npm run build`：通過。
- `npx vitest run`：2,852 件が通過、8 件（4 ファイル）が失敗。失敗したのは `agent-sessions`・`context-mcp`・`host-mcp-processes`・`question-form.browser` のテストで、
  main（変更前）でも同じ 8 件が失敗した。作業した環境が root で動き、コンテナに init が無く、Playwright の版に合うブラウザーが無いためで、この変更とは関係しない。
- まっさらな複製で `npm ci`：終了コード0。`node_modules/.bin/sacty` が作られ、作業ツリーに差分は残らなかった。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

なし
