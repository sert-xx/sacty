# AGENTS.md

蔵書の貸出 API（Hono + TypeScript）です。概要とコマンドは README.md を見てください。

## 変更後に通すもの

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

- テストは `src/**/*.test.ts`（vitest）。API は `app.request`、クライアントは `src/client.test.ts` で確かめる
- Node.js 22 以上、ESM（`import` に `.js` の拡張子を付ける）
