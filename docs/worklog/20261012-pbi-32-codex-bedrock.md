# Codex で Amazon Bedrock の OpenAI のモデルを API キーで使う

- 日付: 2026-10-12（UTC）
- タスク: PBI-32
- PR: #38
- ブランチ: feat/issue-32-codex-bedrock
- 関係する ADR: [Codex のエージェントの認証に Amazon Bedrock（API キー）を足し、Codex の組み込みの Bedrock のプロバイダーで使う](../adr/20261012-0817-codex-bedrock-auth.md)、[オーケストレーターが認証の失敗・利用上限で実行できなければ、標準の工程で進めずにその理由で一時停止する](../adr/20261012-0817-superseded-orchestrator-failure-pauses-task.md)

## 目的

利用者の環境で使える AI が Bedrock の OpenAI のモデル（API キー）だけなので、Codex の認証の方式に Bedrock を足す。
受け入れ条件の要点：config.yaml で Codex のエージェントに Bedrock を選べてモデルとリージョンを書ける、API キーは秘密情報の名前で
参照し値は実行時にだけコンテナへ渡す、工程エージェント・オーケストレーター・ゴールガーディアンのどれにも使える、
config.yaml の単価で費用を計算する（実際の請求として扱う）、認証の失敗・利用上限はこれまでの Codex と同じく理由を記録して一時停止する、
config init の雛形に例を載せる。

## したこと

- `apps/daemon/src/config.ts`：Codex で `bedrock` を選べるようにした。接続先 `endpoint`（`runtime` | `mantle`。Codex だけ。Claude Code に書いたら設定の誤り）。
- `apps/daemon/src/agents/invocation.ts`：`AWS_BEARER_TOKEN_BEDROCK`・`AWS_REGION` を渡し、`-c model_provider=...` でプロバイダーを選ぶ。
  Runtime では Web 検索を無効にする。
- `apps/daemon/src/agents/parse.ts`：Bedrock の `ThrottlingException`・`Too Many Requests` を利用上限、`AccessDeniedException` を認証の失敗にした。
- `apps/daemon/src/service.ts`：オーケストレーターが認証の失敗・利用上限で実行できなければ、標準の工程で進めずにその理由で一時停止する
  （再開で工程の選択からやり直す）。レビューの指摘で、止めるときに `OrchestratorFailed` を記録し、費用を予算に入れるようにした
  （`packages/core/src/events.ts`・`packages/core/src/projection.ts`）。
- config init の雛形と `README.md` に Codex × Bedrock の例を足し、単価は契約の単価を書けばよいことを書いた。

## 確かめたこと

- `npm test`（347 件）・`npm run lint`（指摘なし）・`npm run typecheck` が通った。
- プロバイダーの選択・Web 検索の無効化・リージョン・エラーの分類・Codex で bedrock を許すこと、オーケストレーターの認証の失敗・利用上限で
  止めることについて、修正を戻すとテストが失敗することを確かめた。
- イメージの中の実際の Codex 0.160.0 を偽の API キーで実行し、Bedrock Runtime の `openai/v1/responses`（us-east-2）に問い合わせて 401 になることを
  確かめた（引数が正しく、Bedrock Runtime に届くこと）。
- 実際のキーでの動作は確かめていない（利用者の環境で、API キーを `npx sacty secret set` で保存し、例の設定を `default_agent` にしてタスクを動かし、
  費用が換算値ではなく記録されることを確かめる手順を PR に書いた）。レビューでも、実際のキーでの Bedrock への接続・実際の Codex のコンテナでの
  動作は確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| オーケストレーターが認証の失敗・利用上限で止まるとき、返された使用量・費用を落とし `TaskPaused` だけを記録するので、失敗した実行の費用が予算に入らない（Bedrock 以外のエージェントにも効く変更） | `OrchestratorFailed`（理由・文言・使用量・費用）を記録するようにした。費用は予算に入り、80% の通知も判定する。作業履歴にも費用を出す。工程は選ばないままなので、再開で工程の選択からやり直す。指摘と同じ条件（利用上限・出力 20,000 トークン・出力単価 $15）で `budget.usedUsd` が $0.30 になるテストを足し、修正を戻すと失敗することを確かめた。あわせて lint の情報レベルの指摘（useIndexOf）も直した |

## 残したこと

- 実際のキーでの動作の確認（利用者の環境で行う）。
