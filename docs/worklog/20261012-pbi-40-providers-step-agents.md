# AI gateway への接続・工程ごとのモデル、GitHub Enterprise Server 対応

- 日付: 2026-10-12（UTC）
- タスク: PBI-40
- PR: #46
- ブランチ: feat/issue-40-providers-step-agents
- 関係する ADR: [OpenAI 互換の接続先を providers に書き、エージェントごとのモデル・リーズニングエフォートを工程ごとに選べるようにする](../adr/20261013-0003-providers-and-step-agents.md)、[GitHub のホストを固定せず、リポジトリ・Org をホストを含めた URL で表し、アカウントをホストごとに選ぶ](../adr/20261013-0003-github-host-in-repository-url.md)、[Codex のサンドボックスは使わず、隔離は sacty のコンテナに任せる](../adr/20261013-0003-codex-sandbox-delegated-to-container.md)、[オーケストレーターが工程を選べなかったときは、標準の工程で代わりに進めず、理由を記録して止める](../adr/20261013-0003-stop-when-orchestrator-fails.md)、[調査・要求要件・設計などの工程には、書き込める使い捨ての写しを渡し、コードの変更だけをさせない](../adr/20261013-0003-writable-disposable-workspace-for-read-steps.md)

## 目的

利用する環境で sacty を動かせるようにする。主な受け入れ条件は次のとおり。

- AI gateway（OpenAI 互換の接続先）を `providers` に書き、Codex のエージェントから使える。`via_gateway` ならゲートウェイが API キーを付けて中継し、キーをコンテナに渡さない。
- エージェントごとにモデル・リーズニングエフォート・単価を書け、`step_agents` で工程とオーケストレーターごとに選べる。作業履歴・費用は実際に使ったエージェントで記録する。
- GitHub Enterprise Server（GHE）と github.com を同時に使える。対象をホストを含めた URL で書き、アカウントをホストごとに選び、GitHub の操作をそのホストで行う。
- Rancher Desktop など仮想マシンの中の Docker でも、コンテナからゲートウェイに届く（`gateway.host_address`）。
- Codex がコンテナの中でコマンドを実行できる。オーケストレーターが工程を選べなかったときは、理由を記録して止める。
- 調査・要求要件・設計などの工程でも、対象リポジトリの手順を実行できる。
- `image_build` で、イメージに入れる npm の版と、コンテナの中の npm 全体の設定を書ける（認証の項目は書けない）。

## したこと

- 接続先と工程ごとのエージェント：`apps/daemon/src/config.ts` に `providers`・エージェントの `provider`・`reasoning_effort`・`step_agents`・`agentFor` を足した。
  `apps/daemon/src/agents/invocation.ts` で接続先を Codex の自前のプロバイダー（`model_providers.sacty-provider`・`wire_api = "responses"`・`env_key`）として渡し、
  リーズニングエフォートを渡す。`apps/daemon/src/gateway.ts` の転送先を `base_url` にし、API キーが無い接続先には認証を付けない。
  `apps/daemon/src/service.ts` で、オーケストレーター・各工程・統合レビューに `agentFor` を使う。雛形と README に例を足した。
- GHE：`packages/core/src/github-url.ts`（新規）でリポジトリ・Org の URL の検査・読み取り・比較と API の URL を扱う。`packages/core/src/projects.ts` で対象を URL にし、
  アカウントを `githubAccounts`（ホスト → アカウント）にした（エクスポートの版を 3 に上げた）。`apps/daemon/src/gh.ts`・`github.ts`・`intake.ts`・`service.ts` で、
  トークン・git の認証・検索・clone をリポジトリのホストで選ぶ。画面（`apps/web/src/components/project-editor.tsx` など）の対象の入力を URL にし、
  アカウントをホストごとに選ぶ（選び方は `apps/web/src/lib/github-accounts.ts`）。プロジェクトの設定の並びを、対象・コンテキストリポジトリ・GitHub アカウントの順にした。
- `gateway.host_address`：コンテナから見たホストのアドレスを書けるようにした（既定は `host-gateway`）。Rancher Desktop では `host-gateway` が仮想マシンを指し、
  利用者の環境で `Reconnecting... error sending request` のまま進まなかった。`192.168.5.2` を書けば届くことを、利用者の環境で確かめてもらった。
- Codex のサンドボックス：CODEX_HOME を `/.codex` にし、`--sandbox danger-full-access` の引数で起動する。コンテキストの `sandbox_mode`・`sandbox_workspace_write` は使わず警告を残す。
  既定のコンテキストに `apps/daemon/default-context/agents/codex/config.toml`（`approvals_reviewer = "auto_review"`）を足した。
- オーケストレーターの失敗：標準の工程で代わりに進めず、理由を記録して止め、再開で選び直すようにした。
- 使い捨ての写し：調査・要求要件・設計・オーケストレーター・ゴールガーディアンの写しを書き込める形で渡し、指示を「セットアップやテストは実行してよいが、コードの変更はしない」にした。
- npm の設定（`apps/daemon/src/image.ts`・`packages/cli/docker/Dockerfile`）：
  - `image_build.npm_version`（イメージに入れる npm の版）と `image_build.npm_config`（イメージの global の npmrc に書く項目。認証の項目は拒否）を足した。
    利用者の環境で、対象リポジトリの package-lock.json に残っていた昔のプライベートのレジストリの URL に npm が取りに行き、EIDLETIMEOUT で止まったため。
    `replace-registry-host: always` を入れれば、いまの registry に置き換えて取る。元のイメージの条件を Node.js 18 以上にゆるめた。
  - npm の設定は、`--build-context` ではなく secret の仕組みで渡す（`--build-context` が Docker の構成によっては使えず、Rancher Desktop で失敗したため）。
    設定のファイルが渡されていなければ、理由を示して止める。
  - `image_build.npm_registry` をコンテナの中の npm の registry にもする（`npm_config` の `registry` が優先。トークンはイメージに残さない）。
    secret の中身はビルドのキャッシュの判定に入らないので、設定の中身のハッシュをビルドの引数で渡し、変わったら作り直す。
  - 元のイメージの global の npmrc の最後の行が改行で終わっていないと、書き足した `registry=` が前の行につながっていたので、改行してから書き足す。
- 設定の画面の説明を短くし、文ごとに改行して、すべての欄でタイトルのすぐ下にそろえた。Slack のトークンの欄のプレースホルダーを短くした。
- 公開リポジトリの文言を一般的な言い方にそろえた。

## 確かめたこと

- `npm test`（431件）・`npm run lint`・`npm run typecheck` が通った。
- 次の修正を1つずつ戻すと、テストが失敗することを確かめた：step_agents を使う・工程で使う・オーケストレーターで使う・Codex と Claude Code にリーズニングエフォートを渡す・
  ゲートウェイ経由で向き先をゲートウェイにする・base_url の下に送る・API キーが無ければ認証を付けない。
- GHE について、次の修正を1つずつ戻すと、テストが失敗することを確かめた：API の URL をホストで分ける・検索したホストの結果だけを受け付ける・git の認証の extraheader のホスト・
  トークンを取り出すホスト・URL の比較でホストを見る・取り込みのアカウントをホストで選ぶ。
- 実際の Codex（イメージの 0.160.0）をコンテナで動かし、sacty のゲートウェイ経由で、パス付きの base_url の gateway の偽物につないだ。`/llm/v1/responses` に、
  本物の API キー（Bearer）・モデル・リーズニングエフォート（high）が届き、429 はゲートウェイがリトライし、コンテナの環境変数には API キーが無いことを確かめた。
- 実際の Codex 0.160.0 を権限を落としたコンテナで動かし、偽の AI（Responses API）からコマンドの実行（承認を求めるものも）を指示して、設定ファイルに workspace-write・read-only が
  書かれていても `npm run setup` が実行できることを確かめた。
- 実際にイメージを作り、npm 11.21.0 で `npm_config` の3つの設定が効くこと、古い URL の lock ファイルが置き換わって入ること、設定を続けて変えて作り直すと毎回反映されること、
  最後の行が改行で終わっていない npmrc の元のイメージで、直す前に壊れ、直した後に正しく読めることを確かめた。
- 再レビューでは、全435テスト・`npm run lint`・`npm run typecheck` が通った。実際の AI gateway・GHE・Rancher Desktop・エージェントのコンテナとの接続と、ブラウザの操作は、レビューでは未実施。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| リポジトリ名に Org 名と同じ先頭英数字の制約をかけていたので、`.github`・`_tools` のような GitHub で有効な名前を拒否していた | リポジトリ名の検査を Org 名と分け、先頭がドット・アンダースコアの名前も受け付けた（`.` と `..` は除く）。github.com と GHE の両方の回帰テスト（`projects.test.ts`）と、GHE の検索の結果の `.github` の Issue を取り込むテスト（`github.test.ts`）を足し、検査を戻すと失敗することを確かめた |
| アカウントの候補と保存の対象を対象のホストだけに絞っていたので、対象が GHE・コンテキストが github.com の構成で github.com のアカウントを選べず、保存すると既存の設定が落ちた | 対象のホストに加えて、コンテキストリポジトリ（HTTPS）のホストと保存済みのホストもアカウントを選べるようにし、既存の設定を消さないようにした。対象ではないホストは「選ばない」も選べる。選び方を `apps/web/src/lib/github-accounts.ts` に切り出して回帰テストを足し、戻すと失敗することを確かめた |

## 残したこと

- `owner/name` で登録したプロジェクト・作業履歴との互換は持たせていない（エラーになる場合は `~/.sacty` のデータを消して作り直す）。
- 利用者の環境で、次を確かめる（PR で依頼した）：AI gateway の `base_url` と API キーを `providers` に書き、工程ごとのエージェントで要求要件の工程が完了し、
  作業履歴に工程ごとのエージェントが出ること。GHE にもログインし、GHE のリポジトリでタスクを作って clone・PR の作成ができ、取り込むラベルを付けた GHE の Issue が取り込まれること。
