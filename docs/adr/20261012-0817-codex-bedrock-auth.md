# Codex のエージェントの認証に Amazon Bedrock（API キー）を足し、Codex の組み込みの Bedrock のプロバイダーで使う

- 日時: 2026-10-12 08:17 UTC
- ステータス: 採用
- 関係する PR・タスク: #38、PBI-32
- 置き換え元: なし
- 置き換え先: なし

## 背景

利用者の環境で使える AI は、Bedrock の OpenAI のモデル（API キー）だけだった。Codex のエージェントには、Bedrock を使う
認証の方式が無かった。

## 決定

- config.yaml の Codex のエージェントで `auth.mode: bedrock` を選べる。API キーの秘密情報の名前（`secret`）・リージョン（`region`）・
  接続先 `endpoint`（`runtime`（既定）か `mantle`）を書く。モデルは `model` に書く。工程エージェント・オーケストレーター・
  ゴールガーディアンのどれにも使える。
- Codex（0.160.0）の組み込みの Bedrock のプロバイダー（`amazon-bedrock-runtime`・`amazon-bedrock`）を `-c model_provider=...` で選ぶ。
  API キーは `AWS_BEARER_TOKEN_BEDROCK`、リージョンは `AWS_REGION` で、実行のときにだけコンテナへ渡す。値は作業履歴・出力・エラー文に出さない。
- Bedrock Runtime では、Web 検索を無効にする。
- `endpoint` は Codex だけの項目で、Claude Code のエージェントに書いたら設定の誤りとして知らせる。
- トークン数を読み取り、config.yaml の単価で費用を計算し、実際の請求として記録する（換算値ではない）。単価は契約の単価を書く。
- Bedrock の `ThrottlingException`・`Too Many Requests` を利用上限、`AccessDeniedException` を認証の失敗として扱い、これまでの Codex と同じく
  理由を記録して一時停止する。
- config init の雛形と README に、Codex × Bedrock の例を載せる。

## 理由

- 利用者の環境で使える AI が、Bedrock の OpenAI のモデル（API キー）だけだったため（PR の本文）。
- Bedrock Runtime で Web 検索を無効にするのは、Runtime がホストされた Web 検索を使えないため（PR の本文）。
- 組み込みのプロバイダーを使うこと、`endpoint` を Codex だけにすることの理由と、比べたほかの案は記録に無い。

## 影響

- 実際のキーでの動作は、利用者の環境で確かめる必要がある（PR の時点では、偽の API キーで Bedrock Runtime に届くことだけを確かめた）。
- 単価を契約に合わせて書かないと、記録する費用と予算の判定が実際の請求とずれる。
