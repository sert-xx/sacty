#!/usr/bin/env node
// npm は install の時点で bin のファイルが存在しないとコマンドのリンクを作らない。
// ビルド成果物（dist）は install の後にできるため、リポジトリに含めるこの小さな入口から読み込む。
import { existsSync } from "node:fs";

const entry = new URL("../dist/index.js", import.meta.url);

if (!existsSync(entry)) {
  console.error("[sacty] ビルドされていません。先に `npm run build` を実行してください。");
  process.exit(1);
}

await import(entry.href);
