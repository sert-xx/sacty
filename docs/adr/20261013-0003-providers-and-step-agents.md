# OpenAI 互換の接続先を providers に書き、エージェントごとのモデル・リーズニングエフォートを工程ごとに選べるようにする

- 日時: 2026-10-13 00:03 UTC
- ステータス: 採用
- 関係する PR・タスク: #46、PBI-40
- 置き換え元: なし
- 置き換え先: なし

## 背景

利用する環境では、Bedrock に直接つながず、AI gateway（OpenAI 互換の接続先）を経由する。Codex では `model_providers` に
gateway の `base_url` を指定し、`env_key` の API キーで認証する形でつなげるが、sacty には同じつなぎ方を書く場所が無く、
使うモデルも工程ごとに選べなかった。

## 決定

- `config.yaml` に `providers` を足す。名前ごとに、OpenAI 互換の接続先の `base_url`・API キー（`secret`）・`via_gateway` を書く。
- Codex のエージェントは `provider: <名前>` でそれを使う。sacty は、接続先を Codex の自前のプロバイダー（Responses API。
  `env_key` の API キーを Bearer で付ける）として渡す。
- `via_gateway` なら、sacty のゲートウェイが API キーを付けて `base_url` の下に中継する（429 のリトライも同じ）。API キーはコンテナに渡さない。
  `via_gateway` でなければ、Codex が直接 `base_url` に送る。ゲートウェイの転送先は、起点（origin）ではなく `base_url` にする（パス付きの URL に対応する）。
  API キーが無い接続先には認証を付けない。
- エージェントごとに、モデル・リーズニングエフォート（Codex は `model_reasoning_effort`、Claude Code は `--effort`）・単価を書ける。
  単価はエージェント（モデルの組）ごとにする。
- `step_agents` で、工程（investigate・review・requirements・design・split・reproduce・implement・integrate）とオーケストレーターごとに、
  使うエージェントを選べる。書かなければ `default_agent`（統合レビューは `guardian_agent`）を使う。
- 作業履歴・費用は、実際に使ったエージェント（モデル）で記録する。存在しない接続先・エージェントの名前は、理由を示して設定の誤りにする。

## 理由

- 利用する環境では AI gateway を経由するので、Codex の `model_providers` と同じつなぎ方を、sacty の設定として書けるようにした（PR の本文・コミット）。
- ゲートウェイを経由させると、429 のリトライができ、API キーをコンテナに渡さずに済む（PR の本文の設定の例の説明）。
- 転送先を `base_url` にしたのは、パス付きの URL の接続先に対応するため（コミット）。
- 工程ごとにエージェントを選べるようにした理由（どの工程にどのモデルを使いたいか）は、記録に無い。

## 影響

- 工程ごとに、違うモデル・リーズニングエフォート・単価のエージェントを使える。`step_agents` を書かない設定は、これまでどおり動く。
- `config init` の雛形と README に例を載せた。
- 接続先の API キーは、ゲートウェイ経由ならホストだけが持つ。
