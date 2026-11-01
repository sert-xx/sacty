**日本語** | [English](deployment-watch.en.md)

# マージの後の監視（CI/CD とデプロイ）

マージの後の監視は、実装の後に置く工程（`deployment`）。
sacty のタスクの実装の PR がマージされたら、sacty はマージのコミットに対する CI/CD（GitHub Actions のワークフローの実行・チェック）を待つ。
通ったら、対象のリポジトリのスキル `deployment-observer` に従ってエージェントに確かめさせる。
失敗していたら、修正のタスクを自動で登録する。
人の承認は無い。

するかどうかは、工程を選ぶときに、対象のリポジトリにスキルがあるかで sacty がタスクごとに決める。
どこまで見るかはスキルに任せる。

関係する ADR: [マージの後の監視を工程にし、するかどうかを対象のリポジトリのスキルの有無でタスクごとに決め、どこまで見るかはスキルに任せる](../adr/20261016-0633-deployment-watch-step.md)、[sacty のタスクの実装の PR がマージされたら、CI/CD とデプロイ後のアプリを見届け、失敗したら修正のタスクを登録する（置き換え済み）](../adr/20261014-1439-superseded-deployment-watch-after-merge.md)

## 工程に入れるか

- 実装を含む組み合わせ（`standard`・`skip-design`・`direct`・`bugfix`・`security-fix`）の最後（実装の後）に `deployment` がある（`STEP_PLANS`）。
  タスク分割の親には無い（子タスクが、それぞれの組み合わせで持つ）。
- 組み合わせを選んだ後、`StepsChosen` を記録する前に、sacty は起点のコミット（ベースブランチを選び直したら、そのコミット）でスキルを探す（下の「スキルの探し方」）。
  - あれば、`StepsChosen` の `deployment` に `skill`（パス）を持つ。
  - 無い・使えない・探せないなら、`skipped`（`deploy.stepSkipped`）を持って、この工程を `skip` にする。
    詳しい理由は `deploy.noSkill`・`deploy.skillOutside`・`deploy.skillUnreadable`・`deploy.skillLookupFailed`。
  - 飛ばしたら、CI/CD も見ない。
- 飛ばすときは、この工程の既定のイメージの理由・理由が無いこと（`defaultImageReasons`・`imagesUnexplained`）を記録しない。
- オーケストレーターへの指示では、組み合わせの説明に、スキルがあるときだけ sacty が決めることを書く（AI には決めさせない）。
- 決めた後にスキルが増減したときは、次のとおり。
  - 増えた（実装の PR がスキルを足した）：このタスクでは見ない（工程は飛ばしたまま）。
    次のタスクから見る。
  - 消えた（実装の PR がスキルを消した）：工程は続ける。
    CI/CD を見て、通ったらマージのコミットでスキルを探し直す。
    無ければ、スキルに従った確認を飛ばして `passed`（`no_skill`）で終える。
- 実装の PR をマージせずに実装を承認した（変更が無く PR を作らなかった）なら、見るマージが無いので、この工程を `skip` にする。
- 工程を進めるとき、`skip` の工程には進まない（`advance`）。
  前の工程に戻しても、`skip` の工程は `skip` のまま（`reopen`）。

コード: `packages/core/src/events.ts`（`STEP_PLANS`・`StepsChosen`）、`apps/daemon/src/service.ts`（`runNextInner`・`deploymentChoice`・`withDeploymentChoice`）、`apps/daemon/src/prompts.ts`（`planDescriptions`）、`packages/core/src/projection.ts`（`applyEvent`・`advance`・`reopen`）

## 工程の進み方

- 実行できる工程（`EXECUTABLE_STEPS`）ではないので、実装の承認（PR のマージ）の後は、待機（`idle`）でこの工程が active になる。
- PR の確認（[承認と差し戻し](approval.md) の「PR の確認」）で実装の PR のマージを記録するとき、この工程が `todo` なら、同じ追記で `DeploymentWatchStarted`（PR の番号・リポジトリ・ベースブランチ・マージのコミット）を記録する。
  マージのコミットは GitHub の `merge_commit_sha`。
  取れなければコミットを持たず、監視を飛ばす（理由 `no_commit`）。
- 1つのタスクの監視は1回だけ（二度目の開始は受け付けない）。
  修正のタスクも、そのマージで同じく見る。
- 監視が終わったら、この工程を `done` にし、タスクは完了する（`settleDeploymentStep`）。
  終わったとは、下の `state` が `waiting` でなくなり、`failed` なら修正のタスクを決めた後のこと。
  失敗しても、タスクは止めない。
- 監視の間は、タスクは完了でない（`isCompleted`・`isFinished` が偽）。
  ダッシュボードとタスクの一覧で、終わっていないタスクとして出る。
  画面の状態は「マージの後の監視中（CI/CD を待っている）」か「マージの後の監視中（スキルで確かめている）」。
  人の出番ではない。

コード: `apps/daemon/src/service.ts`（`checkPullRequests`・`deploymentWatchEvents`・`nextAfterApproval`）、`packages/core/src/projection.ts`（`settleDeploymentStep`・`isCompleted`・`isFinished`）、`packages/core/src/events.ts`（`DeploymentWatchStarted`）、`apps/web/src/lib/labels.ts`（`statusText`）

## 状態

タスクの `deployment`（`DeploymentWatch`）に持つ。

状態は次のように移る。

![マージの後の監視の状態](images/deployment-state.svg)

| `state` | 意味 |
| --- | --- |
| `waiting` | 待っている。`phase` が `ci` なら CI/CD の結果、`check` ならスキルに従った確認（`check` があれば確認の実行中） |
| `passed` | 通った（CI/CD が通り、確認の全体の結果が `healthy`。マージのコミットにスキルが無ければ CI/CD が通っただけで、`reason` が `no_skill`） |
| `failed` | 失敗した（CI/CD の失敗か、確認の全体の結果が `unhealthy`） |
| `skipped` | 飛ばした（理由は `reason`） |
| `timed_out` | CI/CD が時間内に終わらなかった |

`reason`（`DeploymentWatchReason`）は次のとおり。
詳しい理由は `detail`（文言のコード）に持つ。

- `no_commit`：マージのコミットが分からない
- `no_ci`：CI/CD が無い
- `no_skill`：マージのコミットにスキルが無い
- `budget`：予算の上限
- `check_unknown`：確認で確かめられなかった

コード: `packages/core/src/projection.ts`（`DeploymentWatch`・`DeploymentWatchState`・`DeploymentWatchReason`・`applyEvent`・`awaitingDeploymentCi`・`awaitingDeploymentCheck`・`deploymentCheckRunning`）

## CI/CD の監視

CI/CD を待つのは sacty で、エージェントには待たせない。
PR の確認（60秒ごと）の終わりに、sacty は CI/CD を待っているタスク（一時停止中のものを除く）について、プロジェクトのそのホストの GitHub のアカウントで次を読む。

| 種類（`kind`） | API | 扱い |
| --- | --- | --- |
| `workflow` | `/repos/<owner>/<name>/actions/runs?head_sha=<コミット>` | 同じワークフロー（`workflow_id`）は、いちばん新しい実行だけ（`newerRun`：別の実行は `run_number`・`created_at`・ID の順で比べ、同じ実行の中では `run_attempt` で比べる） |
| `check` | `/repos/<owner>/<name>/commits/<コミット>/check-runs` | GitHub Actions のもの（`app.slug` が `github-actions`）は除く（ワークフローの実行で見る） |
| `status` | `/repos/<owner>/<name>/commits/<コミット>/status` の `statuses` | `pending` 以外は終わったものとする |

判定は次の順。
時間は `DeploymentWatchStarted` の時刻から数える（デーモンを再起動しても、一時停止しても延びない）。

1. 読めない（認証・ネットワーク・CI/CD を読む口が無い）：記録しない（理由はデーモンのログ）。
   `DEPLOYMENT_CI_TIMEOUT_MS`（60分）を過ぎていれば `timed_out`。
2. 1つも無い：`DEPLOYMENT_CI_GRACE_MS`（5分）を過ぎていれば `none`（`skipped`、`no_ci`）。
   それまでは待つ。
3. 終わっていないものがある：60分を過ぎていれば `timed_out`。
   それまでは待つ。
   - すべて終わっていても、前の確認と同じ並び（種類・名前・URL・結論）になるまでは決めない。
     CI の後に `workflow_run` などで別のワークフローが現れるのを、1回の確認ぶん待つためである。
   - 前の確認の並びはメモリーにだけ持つので、再起動の後は1回ぶん余分に待つ。
     60分を過ぎていれば待たない。
4. 失敗がある：`failed`。
   - 失敗とするもの（`isFailedCiCheck`）は、結論が `failure`・`timed_out`・`action_required`・`startup_failure`、コミットの状態は `failure`・`error`。
     `cancelled`・`skipped`・`neutral`・`stale` は失敗ではない。
   - 失敗したワークフローの実行のジョブ（`/actions/runs/<ID>/jobs?filter=latest`）のうち失敗したものと、ジョブのログの末尾（`/actions/jobs/<ID>/logs`）を、合わせて `CI_FAILURES_MAX`（5）件まで読む。
     ジョブが読めなければ、ワークフローの実行だけを書く。
   - ワークフローの実行の外の失敗（ほかのアプリのチェック・コミットの状態）も、名前・結論・URL を書く。
   - エージェントは使わない。
5. すべて通った：マージのコミットに、デプロイの確認のスキルがあるかを見て（下の「スキルの探し方」）、`passed` を記録する。
   スキルがあれば `skill`、無ければ `skipCheck`（理由）を付ける。
   コミットを取得できなければ記録せず、次の確認でやり直す（60分を過ぎていれば、スキルが無いとして記録する）。

`DeploymentCiFinished` に記録する実行・チェックは、失敗・終わっていないものを先に 50 件まで。

ログの抜粋（`logExcerpt`）は、次の順で作る。

1. ログを読みながら、末尾の `CI_LOG_BYTES`（2,000,000 バイト）だけを持つ（`readTail`）。
   全体をメモリーに読み込まない。
   切ったときは、先頭の切れた行を捨てる。
2. 秘密情報を伏せる。
   伏せるのは、使った GitHub のトークンと、よくある秘密情報の形（`redactLog`：GitHub・Slack・AWS のトークン、JWT、秘密鍵、`Authorization` の値、`password`・`token`・`api_key` などの値）。
   伏せる範囲は JSON の文字列の外へ出さない（終わりの行が無い秘密鍵は `"` の前まで。`password` などの値は、`"` で始まれば同じ深さの閉じの引用符の前まで（JSON の文字列の中のエスケープした引用符 `\"` は値に含める）、`'` で始まれば `"` も含めて閉じの `'` の前まで（JSON の文字列の外へは出さない）、引用符が無ければ空白・引用符・`&`・`,`・`;` の前までで、どちらも括弧を含めて伏せ、引用符をエスケープしている `\` の並びは残す。JSON のキーの後の引用符の無い値は、区切りの括弧の前までを `"[REDACTED]"` にし、`null`・`true`・`false` は残す）。監査の結果など、伏せてから JSON として読む出力を壊さないため。
3. 行の先頭の時刻を除き、末尾の `CI_LOG_LINES`（80）行を取る。
4. `CI_EXCERPT_MAX`（3000）文字に切り詰める（長ければ末尾を残す）。

コード: `apps/daemon/src/service.ts`（`checkDeployments`・`pollDeploymentCi`・`deploymentSkill`）、`apps/daemon/src/ci.ts`（`GitHubCiStatus`・`newerRun`・`readTail`・`redactLog`・`logExcerpt`・`CI_FAILURES_MAX`・`CI_LOG_LINES`・`CI_EXCERPT_MAX`）、`packages/core/src/events.ts`（`DeploymentCiFinished`・`isFailedCiCheck`・`DEPLOYMENT_CI_GRACE_MS`・`DEPLOYMENT_CI_TIMEOUT_MS`）

## スキルの探し方

- 工程を選ぶとき（起点のコミット）と、CI/CD が通ったとき（マージのコミット）に探す。
- `.agents/skills/deployment-observer/SKILL.md`、`.claude/skills/deployment-observer/SKILL.md` の順に探す（`DEPLOYMENT_SKILL_PATHS`）。
  先に使えたものを使う。
- パスの途中（`SKILL.md` 自身を含む）のシンボリックリンクは、リンクの先がリポジトリの中なら、たどった先で探す。
  次のリンクは使わない（理由 `deploy.skillOutside`）。
  - 絶対パス・リポジトリの根より上・根そのものを指すリンク
  - 8回を超えてたどるリンク（循環など）
- 読めない（通常のファイルでない・大きすぎる・テキストでない）なら使わない（理由 `deploy.skillUnreadable`）。
  どれも無ければ `deploy.skillMissing`。
- 記録するのは、たどった先のパス（リポジトリの根から）。
- スキルが参照するファイル（CI/CD の確認の仕方の reference `references/ci.md` など）は、sacty は読まない。
  エージェントがスキルに従って読む。

コード: `apps/daemon/src/deployment.ts`（`findDeploymentSkill`・`resolveInRepository`・`DEPLOYMENT_SKILL_PATHS`・`CI_REFERENCE`）、`apps/daemon/src/repository.ts`（`readLink`・`readFile`）

## スキルに従った確認

- スキルがあり、確認を待っている（`awaitingDeploymentCheck`）タスクは、ワーカーが実行待ちとして拾う（一時停止中のタスクは拾わない）。
  同時に実行する数の上限は、ほかの実行と同じ。
- 予算の上限に達していれば実行せず、`DeploymentWatchSkipped`（`budget`）を記録する（タスクは止めない）。
- 実行の環境
  - AI は、人がこの工程に指定したエージェント（タスクの作成時の指定、またはタスクの詳細・一時停止したタスクの再開・差し戻しでの変更。[作成時に指定した工程のイメージ・エージェント](tasks-and-steps.md#作成時に指定した工程のイメージエージェント)・[工程のエージェントを人が変える](tasks-and-steps.md#工程のエージェントを人が変える)）。
    無ければ `step_agents.deployment`、それも無ければ `default_agent`。
  - イメージはこの工程のイメージ。
    ほかの工程と同じく、オーケストレーターが選び、人が変えられる。
    無ければ既定のイメージ。
  - 作業領域は、`workspaces/_deployment/<実行 ID>` に書き出したマージのコミットのコードの写し（終わったら消す）。
  - プロジェクトのコンテキスト（外部 PF・MCP サーバー）を、工程のエージェントと同じく渡す。
- 実行の前に `DeploymentCheckStarted`（実行の ID・スキル）を記録する。
- 指示（`buildDeploymentPrompt`）は、スキルを読んで従うことを求める。
  何を確かめるか（CI/CD の確認・デプロイの確認のどれをするか）と確かめ方は、スキルに従う。
  sacty が見た CI/CD の実行・チェック（50 件まで）を、指示ではない JSON のデータとして渡す。
  タスクの開始時に集めた情報があれば、背景として添える（[タスクと工程](tasks-and-steps.md#情報収集)）。
  ほかに次を求める。
  - 確かめるだけで何も変えない（CI/CD の再実行・デプロイのやり直し・ロールバックもしない）
  - 秘密情報を書かない
  - CI/CD やデプロイが終わるのを長く待たない（終わっていない・判断できなければ `unknown`）
  - スキルが確かめないとしているものは `skipped` と理由を書く
  - スキルに別の答えの形が書いてあっても、指示の形を優先する
- 答え（`extractDeploymentCheck`）：見出し `sacty-deployment` の JSON。

  ```json
  {"sacty-deployment": {"ci": {"result": "passed", "summary": "CI/CD の確認の要点", "reason": "飛ばした・判断できない理由"}, "deployment": {"result": "skipped", "summary": "デプロイの確認の要点", "reason": "デプロイしていない"}, "summary": "全体の要点", "evidence": ["根拠"]}}
  ```

  | 項目 | 値 |
  | --- | --- |
  | `ci.result` | `passed`（スキルに従って確かめ、通っている）・`failed`（失敗がある）・`skipped`（確かめない）・`unknown`（判断できない） |
  | `deployment.result` | `healthy`（デプロイ後のアプリが正しく動いている）・`unhealthy`（エラーになっている）・`skipped`（確かめない）・`unknown`（判断できない） |
  | `summary`・`reason`（それぞれ） | 2000 文字まで |
  | `summary`（全体） | 4000 文字まで |
  | `evidence` | 20 件、1件 2000 文字まで |

  `ci`・`deployment` の両方に、決めた値の `result` が要る。
  無い・知らない値・以前の形（`result` だけ）は読めない（`deploy.unreadable`）。
- 全体の結果（`overallDeploymentResult`）
  - どちらかが `failed`・`unhealthy` なら `unhealthy`
  - そうでなく `unknown` があれば `unknown`
  - ほかは（飛ばしたものだけでも）`healthy`
- 結果（`DeploymentChecked`）は、全体の結果と `ci`・`deployment` を持つ。
  - `healthy` は `passed`、`unhealthy` は `failed`、それ以外は `skipped`（`check_unknown`）にする。
  - 実行に失敗した（`deploy.checkFailed`）・答えを読めない（`deploy.unreadable`）・`unknown`（`deploy.undetermined`）も `check_unknown`。
  - 実行が上限を過ぎたら、ほかの実行と同じく止めて、実行の失敗にする。
    上限は `run_timeout.roles.deployment`、未指定なら `run_timeout.agent_minutes`（既定 30 分。[エージェントの実行](agent-execution.md)）。
  - 費用（失敗したときも）はタスクの予算に入れ、80% の通知を判定する。
- 人が止めた（一時停止・中止）ときは、結果にしない。
  `retry` を付けた `DeploymentChecked`（`unknown`、`interrupted`、`deploy.stopped`、費用）を記録して、確認を待つ状態に戻す（再開で確かめ直す）。

コード: `apps/daemon/src/service.ts`（`queuedTaskIds`・`runNextInner`・`checkDeployment`）、`apps/daemon/src/deployment.ts`（`buildDeploymentPrompt`・`extractDeploymentCheck`・`overallDeploymentResult`・`DEPLOYMENT_HEADING`）、`apps/daemon/src/config.ts`（`agentFor`）

## 修正のタスク

失敗（`failed`）で、修正のタスクをまだ決めていない（`fixDecisionPending`）とき、sacty は1つの監視で1つだけ決める。

- 種類
  - `ci`：sacty の判定で CI/CD が失敗した
  - `deployment`：スキルに従った確認で失敗を見つけた（`ci.result` が `failed` か `deployment.result` が `unhealthy`）
- 目印（`fingerprint`）
  - `ci`：`ci|<リポジトリ>|<失敗したワークフロー / ジョブの名前の並び>`（`ciFingerprint`）
  - `deployment`：`deployment|<リポジトリ>`（`deploymentFingerprint`）
  - リポジトリは小文字にし、末尾の `/`・`.git` を除く。
- 二重の登録：同じプロジェクトに次のタスクがあれば、作らずに `DeploymentFixSuppressed`（`duplicate`、そのタスクの ID）を記録する。
  監視しているタスク自身（修正のタスクのマージの監視）は除く。
  - 同じ目印の終わっていない修正のタスク（`fixTaskOpen`：中止しておらず、完了していないか、完了してもその監視が `waiting`）
  - 同じ目印で、登録して作る前のもの
- 連鎖の上限：段数（元のタスクの `fix.depth`、無ければ 0）+ 1 が `MAX_FIX_CHAIN`（3）を超えるなら、作らずに `DeploymentFixSuppressed`（`chain_limit`）を記録する。
- 作るときは、元のタスクに `DeploymentFixRegistered`（作るタスクの ID・種類・目印・段数・題・本文）を記録してから、その ID で `TaskCreated` を記録する。
  `TaskCreated` は `start: deployment` で、`repo` は監視したリポジトリ、`fix` に元のタスク・種類・目印・段数を持ち、予算は `budget.default_per_task_usd`。
  作る前にデーモンが止まったら、次の確認で作る（`createRegisteredFixTask`）。
- 本文（`buildCiFixTask`・`buildDeploymentFixTask`。`TASK_BODY_MAX` まで）
  - 共通：元のタスクの題と ID、マージした PR、リポジトリとベースブランチ、マージのコミットとそのリンク
  - `ci`：失敗したワークフロー・ジョブ・結論・実行へのリンクと、ログの抜粋。
    入りきらなければ、抜粋を等しく末尾から切り詰める。
  - `deployment`：スキル、CI/CD の確認とデプロイの確認それぞれの結果と理由、全体の要点、根拠
- 題（`TASK_TITLE_MAX` まで）
  - デプロイの確認が `unhealthy` なら「デプロイ後のアプリのエラーを直す」
  - CI/CD の確認だけが `failed` なら「マージの後の確認で見つけた CI/CD の失敗を直す」
- 修正のタスクは、ふつうのタスクとして実行待ちになる（オーケストレーターが進め方を選ぶ）。

コード: `apps/daemon/src/service.ts`（`registerFixTask`・`createRegisteredFixTask`）、`apps/daemon/src/deployment.ts`（`ciFingerprint`・`deploymentFingerprint`・`buildCiFixTask`・`buildDeploymentFixTask`）、`packages/core/src/projection.ts`（`fixDecisionPending`・`fixTaskOpen`）、`packages/core/src/events.ts`（`MAX_FIX_CHAIN`・`DeploymentFixRegistered`・`DeploymentFixSuppressed`）

## 確かめられなかったとき

次のときは、修正のタスクを作らずに監視を終え（失敗ではない）、工程を終えてタスクを完了にする。
自動のやり直しは無い。

| 場合 | `state`・`reason` | 気づく場所 |
| --- | --- | --- |
| CI/CD が60分で終わらない・GitHub の API を読めないまま60分を過ぎた | `timed_out` | 監視のカード、作業履歴（`DeploymentCiFinished` の `timed_out`）、読めなかった理由はデーモンのログ |
| 5分たっても CI/CD が1つも無い | `skipped`・`no_ci` | 監視のカード、作業履歴 |
| スキルに従った確認で判断できない・実行に失敗・答えを読めない | `skipped`・`check_unknown`（`detail`） | 監視のカード（答えを読めたときだけ、CI/CD の確認・デプロイの確認それぞれの結果と理由も）、作業履歴 |
| 予算の上限 | `skipped`・`budget` | 監視のカード、作業履歴 |

- Slack の完了の通知（[Slack の通知](notifications.md)）は、監視の結果によらず同じ文で、結果は書かない（タスクへのリンクから確かめる）。
- 確かめ直す仕組みは無い。
  人が次のことをする。
  - GitHub の API を読めなかったときだけ、プロジェクトの GitHub のアカウントの権限・接続を直す。
  - マージのコミット（カードのリンク）の CI/CD を GitHub で確かめる。
  - スキルの手順で確かめる（デプロイ後のアプリは、スキルが求めているときだけ）。
  - 直すことがあれば、新しいタスクを作る。

コード: `apps/daemon/src/service.ts`（`pollDeploymentCi`・`checkDeployment`）、`apps/web/src/components/deployment.tsx`（`DeploymentWatchCard`）、`apps/daemon/src/notifier.ts`（`notificationText`）

## 一時停止・中止・再起動

- 一時停止：監視の間（待機）は、ほかの工程と同じく止められる。
  - 止めている間は CI/CD を見ず、確認も実行しない（修正のタスクの登録も再開の後）。
  - CI/CD を読んでいる間に止めたら、すぐに再開していても、読んだ結果は記録せずに捨てる（再開の後に読み直す）。
    読み始めたときと記録する直前の、人が一時停止を求めた回数（`pauseCounts`。メモリーだけに持つ）で見分ける。
    読んでいる途中の処理は再起動で消えるので、再起動で数え直しても困らない。
  - 確認の準備・実行の間は、止め終わるまで再開できないので、古い準備の結果が再開の後に届くことは無い。
  - 再開すると待機に戻り、続ける。
  - 確認の準備・実行の途中なら、コンテナを止め、結果にせずに（`retry`）一時停止し、再開で確かめ直す。
    止めたことで準備が失敗しても同じ。
- 中止：監視は終わる（中止したタスクには記録しない）。
  - 確認の実行中なら、ほかの実行と同じく止める（`retry` を記録してから中止）。
  - マージした実装の PR は閉じない（片付けの PR は `skipped`）。
  - ブランチ・作業領域は、ほかの工程と同じく片付ける。
- 再起動：CI/CD を待っている監視は、再起動の後も続く（時間の上限は監視を始めた時刻から）。
  - 確認の実行中に止まったら、起動のとき（`recoverInterrupted`）に、ほかの工程の実行と同じく、`DeploymentChecked`（`retry`、`unknown`、`interrupted`、`run.daemonStopped`）と `TaskPaused`（`error`、`run.daemonStopped`）を記録する。
    再開で確かめ直す。
  - 始める前の確認は、起動の後にワーカーが実行する。

コード: `apps/daemon/src/service.ts`（`pause`・`resume`・`cancel`・`recoverInterrupted`・`checkDeployments`・`pollDeploymentCi`・`checkDeployment`）

## 工程の無い以前のタスク

- PBI-116 より前の作業履歴（工程に `deployment` が無く、完了したタスクに `DeploymentWatchStarted` がある）は、書き換えずにそのまま読む。
- その監視は、これまでどおり完了したタスクのまま進める（工程・状態を変えない）。
  - 確認のイメージは実装の工程のイメージ。
  - 止めた・デーモンが止まった確認は、確かめられなかった（`deploy.stopped`・`run.daemonStopped`。`check_unknown`）として終える（やり直さない）。
  - 答えの形は今の形。
- プロジェクトの設定の `deploymentWatch` は読まない。
  保存した定義からは捨て、以前の書き出しのファイルにあっても、読み込みを止めずに捨てる（[書き出しと読み込み](export.md)）。

コード: `packages/core/src/projection.ts`（`applyEvent`）、`apps/daemon/src/service.ts`（`checkDeployment`・`recoverInterrupted`）、`packages/core/src/projects.ts`（`ProjectDefinition`・`ProjectExport`）

## 画面

- タスクの工程の並びに「マージの後の監視」を出す（飛ばしたら飛ばしたこと）。
  工程のイメージは、ほかの工程と同じく変えられる。
- タスクの詳細の「マージの後の監視」
  - 監視を始める前：マージを待っていることと使うスキル。
    飛ばしたなら理由（工程を決めたときの理由か、変更なしで承認したこと）。
  - 始めた後
    - 状態・理由
    - マージのコミット（リンク）とベースブランチ
    - 監視を始めた時刻と CI/CD を待つ上限
    - CI/CD の実行とチェック（失敗・実行中のものを先に 20 件）
    - 失敗したワークフローとジョブ（リンクとログの抜粋）
    - スキルに従った確認（スキル・全体の結果・CI/CD の確認とデプロイの確認それぞれの結果と理由・要点・根拠）
    - 修正のタスク（リンク）か、作らなかった理由
- 修正のタスクの詳細のプロパティの「修正の元」に、元のタスクへのリンクと段数を出す。
- 作業履歴には、7つのイベントを文で出す。
  工程を決めた記録には、監視をするか（スキル）・飛ばす理由を出す。
  止めた確認には、確かめ直すことを出す。
- 工程ごとの費用の表には、この工程の行（工程の順）に、確認の実行（実行中・止めた回も）を出す。
  工程の無い以前のタスクでも、工程の一覧に無い工程の行として出す。
- 通知（[Slack の通知](notifications.md)）
  - 完了の通知は、監視が終わって完了したときに送る。
  - 止まったときの通知には、工程の名前（マージの後の監視）を書く。
- プロジェクトの設定に、マージの後の監視の設定は無い。

コード: `apps/web/src/components/deployment.tsx`（`DeploymentWatchCard`）、`apps/web/src/components/task-detail.tsx`、`apps/web/src/lib/labels.ts`（`describeEvent`・`statusText`）、`apps/web/src/lib/step-costs.ts`（`stepCosts`）、`apps/daemon/src/notifier.ts`（`notificationFor`・`notificationText`）
