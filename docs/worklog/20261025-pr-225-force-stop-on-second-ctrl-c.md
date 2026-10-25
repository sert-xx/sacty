# sacty up を止めている途中の表示と、2回目の Ctrl+C で待たずに止める

- 日付: 2026-10-25（UTC）
- タスク: なし
- PR: #225
- ブランチ: claude/sharp-davinci-cqr8tu
- 関係する ADR: [sacty up は、止めている途中でもう一度 Ctrl+C を押されたら、後片付けを待たずに止める](../adr/20261025-2351-force-stop-on-second-ctrl-c.md)

## 目的

`sacty up` を Ctrl+C で止めるとき、何度押しても反応が無く、止まっているのかわからないという報告を直す。

## したこと

- CLI（`packages/cli/src/index.ts` の `up`）
  - 1回目の SIGINT・SIGTERM で、止めていることと、もう一度 Ctrl+C を押せば待たずに止めることを表示する。
  - 止めている途中の SIGINT・SIGTERM で、デーモンに `FORCE_STOP_SIGNAL`（SIGUSR2）を、画面に SIGKILL を送り、5秒たっても残る子に SIGKILL を送る（`forceStop`）。
- デーモン（`apps/daemon/src/main.ts`）
  - 後片付けが3秒（`DRAIN_REPORT_MS`）たっても終わらなければ、まだ終わっていないものを表示する（`waitNamed`）。ホストの MCP サーバーの停止も同じ。
  - `FORCE_STOP_SIGNAL` で、後片付けを待たずに終了コード 1 で終わる（`exit` の後処理は走る）。
  - `FORCE_STOP_SIGNAL` は CLI からも読む `apps/daemon/src/exit-codes.ts` に置いた。
- 仕様書（`daemon-lifecycle`）・ユーザードキュメント（`cli`）を、日本語と英語の両方で直した。

## 確かめたこと

- 手元（Docker なし・設定ファイルなし）で `sacty up` をプロセスグループごと起動し、SIGINT を送って止まるまでを測った。
  - 直す前：約2秒で止まった（この環境では報告の遅さは再現しなかった）。
  - ビルドした `main.js` に、PR の確認の停止が15秒かかる遅延を一時的に入れて試した（試した後に作り直した）。
    - 端末から1回：止めている表示と、3秒後に「後片付けを待っています：PR の確認」が出て、15秒で止まった。
    - 端末から2回（4秒あけて）：両方の「後片付けを待たずに止めます。」が出て、約4秒で止まった。
    - CLI のプロセスだけに2回：同じく約5秒で止まった。
- `npm run typecheck`：通った。
- `npx biome check .`：指摘なし。
- `npx vitest run packages/cli apps/daemon/src/instance-lock.test.ts`：通った。
- `npx vitest run tests/docs`：通った。
- `npx vitest run`：通らなかったのは、変更の前のブランチでも同じく通らない、この作業の環境によるものだけ（root で動かしているので読めないファイルが読めてしまう・プロセスの後始末のテスト 8 件と、Playwright のブラウザの版が環境と合わないブラウザのテスト 1 ファイル）。

## 残したこと

- 報告の環境で、どの後片付けが長引いていたかは確かめていない。今回の表示で、次に起きたときにわかる。
