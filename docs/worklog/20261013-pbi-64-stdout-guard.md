# エージェントとテストの出力を通常のファイルで受けて中継し、非ブロッキングの出力で落ちないようにする

- 日付: 2026-10-13（UTC）
- タスク: PBI-64
- PR: #73
- ブランチ: feat/issue-64-stdout-guard
- 関係する ADR: [エージェントとテストのコマンドの出力は、コンテナの中の通常のファイルで受け、小さな中継でコンテナの標準出力に流す](../adr/20261013-2256-output-relay-regular-file.md)

## 目的

コンテナの中の別のプロセスが標準出力を非ブロッキングにしても、エージェント・テストのコマンドが EAGAIN で落ちないようにする。
出力の読み取り・セッションログ・テストの結果・終了コード・止めたときの動きは変えず、大きな出力でもディスク・メモリを使いすぎない。
Claude Code・Codex・スタブ・テストのコマンド、PBI-60 の転送ありでも動き、実際の Docker で再現と修正を確かめる。

## したこと

- `apps/daemon/src/agents/output-relay.ts`（新規）：`withOutputRelay(command)` で `node -e 中継 -- コマンド` の形にくるむ。
  出力は `/tmp/sacty-output-*/1`・`/2` の通常のファイルに書かせ、中継が読みながら流す。EAGAIN・部分書き込みの再試行、終了時の流し切り、
  終了コード・シグナルの伝達、`fallocate --punch-hole` での捨て、一時ファイルを作れないときの直接渡し。
- `apps/daemon/src/agents/docker.ts`・`apps/daemon/src/agents/test-runner.ts`：一番外側に中継を置いた。
- テスト：`apps/daemon/src/agents/output-relay.test.ts`（新規）、`apps/daemon/src/agents/containers.test.ts` の更新。

## 確かめたこと

- 実際の Docker（sacty-agent:0.1.0）で再現：perl の fcntl で標準出力に O_NONBLOCK を付けて（fdinfo の flags が 04001）`dd bs=16M` で書くと、
  直す前は `Resource temporarily unavailable` で終了コード 42（届いたのは 65536 バイトだけ）。直した後は 16MB を書ききって 0、末尾まで届いた。
- 実際の DockerTestRunner・DockerExecutor で：終了コード 3 がそのまま返る、PBI-60 の転送と組み合わせても通る、Codex の JSONL の形で 8MB の1行でも
  最後の答え・使用量・セッションログが揃う、スタブはこれまでどおり、止めると約2秒で終わりコンテナが残らない。イメージの claude と codex も中継の下で起動した。
- 85MB の出力を1秒かからずに流せ、一時ファイルは約5MB、中継のメモリは約52MB のままだった。
- `npm run lint`・`npm run typecheck`・`npx vitest run`（735件）・`npm run build`：通った。
- 主要な処理を10か所わざと壊し、9か所でテストが落ちた（残りの1か所は macOS のテストでは確かめられず、Linux の Docker で落ちることを確かめた）。
- レビューの検証では、全735件のうち、大量出力の fallocate のテスト1件が既定の5秒の制限で時間切れになり、単独で再実行すると14件すべて通った。
  実際の Docker・実際の Claude Code・Codex での再検証は、レビューでは行っていない。

## レビューの指摘と対応

指摘は無かった（PASS。全体のテストで fallocate のテスト1件が時間切れになったという検証上の注意のみ）。

## 残したこと

- 受け入れた制限：テストのスクリプトが出力を開き直すと、まだ流していない直前の出力が欠けることがある。読み手が止まっている間は、流す前の出力が
  ディスクに溜まる。コマンドが見つからないときの文が変わり、標準出力と標準エラー出力の混ざり方が粗くなることがある。
