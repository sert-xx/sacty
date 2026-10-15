**日本語** | [English](deployment-watch.en.md)

# マージの後の監視（CI/CD とデプロイ）

sacty のタスクの実装の PR がマージされたら、マージのコミットに対する CI/CD（GitHub Actions のワークフローの実行・チェック）を待ち、
通ったらデプロイの確認のスキルでデプロイ後のアプリをエージェントに確かめさせる。失敗していたら、修正のタスクを自動で登録する。
プロジェクトの設定 `deploymentWatch` が `true` のときだけ行う。

関係する ADR: [sacty のタスクの実装の PR がマージされたら、CI/CD とデプロイ後のアプリを見届け、失敗したら修正のタスクを登録する](../adr/20261014-1439-deployment-watch-after-merge.md)

## 対象と開始

- プロジェクトの `deploymentWatch` が `true` のときだけ。書いていない・`false` なら行わない（記録も増えない）。
- 見るのは、実装の PR（成果物チェック、工程 `pr`）のマージだけ。要求要件・設計の PR は見ない。修正のタスクも、そのマージで同じく見る。
- PR の確認（[承認と差し戻し](approval.md) の「PR の確認」）でマージを記録するとき、同じ追記で `DeploymentWatchStarted`（PR の番号・
  リポジトリ・ベースブランチ・マージのコミット）を記録する。マージのコミットは GitHub の `merge_commit_sha`。取れなければ
  コミットを持たず、監視を飛ばす（理由 `no_commit`）。
- 1つのタスクの監視は1回だけ（二度目の開始は受け付けない）。

コード: `apps/daemon/src/service.ts`（`checkPullRequests`・`deploymentWatchEvents`）、`packages/core/src/projects.ts`（`ProjectDefinition`）、`packages/core/src/events.ts`（`DeploymentWatchStarted`）

## 状態

タスクの `deployment`（`DeploymentWatch`）に持つ。タスクの `status` と工程は変えない（完了したタスクのまま）。

| `state` | 意味 |
| --- | --- |
| `waiting` | 待っている。`phase` が `ci` なら CI/CD の結果、`check` ならデプロイの確認（`check` があれば確認の実行中） |
| `passed` | 通った（CI/CD が通り、デプロイの確認で `healthy`。スキルが無ければ CI/CD が通っただけで、`reason` が `no_skill`） |
| `failed` | 失敗した（CI/CD の失敗か、デプロイの確認で `unhealthy`） |
| `skipped` | 飛ばした（理由は `reason`） |
| `timed_out` | CI/CD が時間内に終わらなかった |

`reason`（`DeploymentWatchReason`）：`no_commit`（マージのコミットが分からない）・`no_ci`（CI/CD が無い）・`no_skill`（スキルが無い）・
`budget`（予算の上限）・`check_unknown`（デプロイの確認で確かめられなかった）。詳しい理由は `detail`（文言のコード）に持つ。

コード: `packages/core/src/projection.ts`（`DeploymentWatch`・`DeploymentWatchState`・`DeploymentWatchReason`・`applyEvent`・`awaitingDeploymentCi`・`awaitingDeploymentCheck`・`deploymentCheckRunning`）

## CI/CD の監視

PR の確認（60秒ごと）の終わりに、CI/CD を待っているタスクについて、プロジェクトのそのホストの GitHub のアカウントで次を読む。

| 種類（`kind`） | API | 扱い |
| --- | --- | --- |
| `workflow` | `/repos/<owner>/<name>/actions/runs?head_sha=<コミット>` | 同じワークフロー（`workflow_id`）は、いちばん新しい実行だけ（`newerRun`：別の実行は `run_number`・`created_at`・ID の順で比べ、同じ実行の中では `run_attempt` で比べる） |
| `check` | `/repos/<owner>/<name>/commits/<コミット>/check-runs` | GitHub Actions のもの（`app.slug` が `github-actions`）は除く（ワークフローの実行で見る） |
| `status` | `/repos/<owner>/<name>/commits/<コミット>/status` の `statuses` | `pending` 以外は終わったものとする |

判定は次の順。時間は `DeploymentWatchStarted` の時刻から数える（デーモンを再起動しても延びない）。

1. 読めない（認証・ネットワーク・CI/CD を読む口が無い）：記録しない（理由はデーモンのログ）。`DEPLOYMENT_CI_TIMEOUT_MS`（60分）を
   過ぎていれば `timed_out`。
2. 1つも無い：`DEPLOYMENT_CI_GRACE_MS`（5分）を過ぎていれば `none`（`skipped`、`no_ci`）。それまでは待つ。
3. 終わっていないものがある：60分を過ぎていれば `timed_out`。それまでは待つ。
   すべて終わっていても、前の確認と同じ並び（種類・名前・URL・結論）になるまでは決めない（CI の後に `workflow_run` などで別の
   ワークフローが現れるのを、1回の確認ぶん待つ。前の確認の並びはメモリーにだけ持つので、再起動の後は1回ぶん余分に待つ。60分を過ぎていれば
   待たない）。
4. 失敗がある（`isFailedCiCheck`：結論が `failure`・`timed_out`・`action_required`・`startup_failure`、コミットの状態は `failure`・`error`。
   `cancelled`・`skipped`・`neutral`・`stale` は失敗ではない）：`failed`。失敗したワークフローの実行のジョブ（`/actions/runs/<ID>/jobs?filter=latest`）
   のうち失敗したものと、ジョブのログの末尾（`/actions/jobs/<ID>/logs`）を、合わせて `CI_FAILURES_MAX`（5）件まで読む。ジョブが読めなければ
   ワークフローの実行だけを書く。ワークフローの実行の外の失敗（ほかのアプリのチェック・コミットの状態）も、名前・結論・URL を書く。
5. すべて通った：マージのコミットに、デプロイの確認のスキルがあるかを見て（下の「スキルの探し方」）、あれば `skill`、無ければ `skipCheck`
   （理由）を付けて `passed` を記録する。コミットを取得できなければ記録せず、次の確認でやり直す（60分を過ぎていれば、スキルが無いとして記録する）。

`DeploymentCiFinished` に記録する実行・チェックは、失敗・終わっていないものを先に 50 件まで。

ログの抜粋（`logExcerpt`）：ログを読みながら末尾の `CI_LOG_BYTES`（2,000,000 バイト）だけを持ち（`readTail`。全体をメモリーに読み込まない。
切ったときは、先頭の切れた行を捨てる）、秘密情報を伏せてから、行の先頭の時刻を
除き、末尾の `CI_LOG_LINES`（80）行を取り、`CI_EXCERPT_MAX`（3000）文字に切り詰める（長ければ末尾を残す）。伏せるのは、使った GitHub の
トークンと、よくある秘密情報の形（`redactLog`：GitHub・Slack・AWS のトークン、JWT、秘密鍵、`Authorization` の値、`password`・`token`・`api_key`
などの値）。

コード: `apps/daemon/src/service.ts`（`checkDeployments`・`pollDeploymentCi`・`deploymentSkill`）、`apps/daemon/src/ci.ts`（`GitHubCiStatus`・`newerRun`・`readTail`・`redactLog`・`logExcerpt`・`CI_FAILURES_MAX`・`CI_LOG_LINES`・`CI_EXCERPT_MAX`）、`packages/core/src/events.ts`（`DeploymentCiFinished`・`isFailedCiCheck`・`DEPLOYMENT_CI_GRACE_MS`・`DEPLOYMENT_CI_TIMEOUT_MS`）

## スキルの探し方

- `.agents/skills/deployment-observer/SKILL.md`、`.claude/skills/deployment-observer/SKILL.md` の順に、マージのコミットで探す
  （`DEPLOYMENT_SKILL_PATHS`）。先に使えたものを使う。
- パスの途中（`SKILL.md` 自身を含む）のシンボリックリンクは、リンクの先がリポジトリの中なら、たどった先で探す。絶対パス・リポジトリの根より上・
  根そのものを指すリンク、8回を超えてたどるリンク（循環など）は使わない（理由 `deploy.skillOutside`）。
- 読めない（通常のファイルでない・大きすぎる・テキストでない）なら使わない（理由 `deploy.skillUnreadable`）。どれも無ければ `deploy.skillMissing`。
- 記録するのは、たどった先のパス（リポジトリの根から）。

コード: `apps/daemon/src/deployment.ts`（`findDeploymentSkill`・`resolveInRepository`・`DEPLOYMENT_SKILL_PATHS`）、`apps/daemon/src/repository.ts`（`readLink`・`readFile`）

## デプロイの確認

- スキルがあり、確認を待っている（`awaitingDeploymentCheck`）タスクは、ワーカーが実行待ちとして拾う（一時停止中のタスクは拾わない）。
  同時に実行する数の上限・一時停止・中止は、ほかの実行と同じ。
- 予算の上限に達していれば実行せず、`DeploymentWatchSkipped`（`budget`）を記録する（タスクは止めない）。
- AI は `step_agents.deployment`（無ければ `default_agent`）。イメージは実装の工程のイメージ（無ければ既定のイメージ）。作業領域は
  `workspaces/_deployment/<実行 ID>` に書き出したマージのコミットのコードの写し（終わったら消す）。プロジェクトのコンテキスト（外部 PF・
  MCP サーバー）を、工程のエージェントと同じく渡す。
- 実行の前に `DeploymentCheckStarted`（実行の ID・スキル）を記録する。指示（`buildDeploymentPrompt`）は、スキルを読んで従い、確かめるだけで
  何も変えないこと、秘密情報を書かないことを求める。
- 答えは見出し `sacty-deployment` の JSON（`extractDeploymentCheck`）。`result`（`healthy`・`unhealthy`・`unknown`）・`summary`（4000 文字まで）・
  `evidence`（20 件、1件 2000 文字まで）。
- 結果（`DeploymentChecked`）：`healthy` は `passed`、`unhealthy` は `failed`、それ以外は `skipped`（`check_unknown`）。実行に失敗した
  （`deploy.checkFailed`）・答えを読めない（`deploy.unreadable`）・`unknown`（`deploy.undetermined`）・人が止めた・中止した（`deploy.stopped`）も
  `check_unknown`。費用（失敗したときも）は元のタスクの予算に入れ、80% の通知を判定する。

コード: `apps/daemon/src/service.ts`（`queuedTaskIds`・`runNextInner`・`checkDeployment`）、`apps/daemon/src/deployment.ts`（`buildDeploymentPrompt`・`extractDeploymentCheck`・`DEPLOYMENT_HEADING`）、`apps/daemon/src/config.ts`（`agentFor`）

## 修正のタスク

失敗（`failed`）で、修正のタスクをまだ決めていない（`fixDecisionPending`）とき、1つの監視で1つだけ決める。

- 目印（`fingerprint`）：CI/CD は `ci|<リポジトリ>|<失敗したワークフロー / ジョブの名前の並び>`（`ciFingerprint`）、デプロイの確認は
  `deployment|<リポジトリ>`（`deploymentFingerprint`）。リポジトリは小文字にし、末尾の `/`・`.git` を除く。
- 二重の登録：同じプロジェクトに、同じ目印の終わっていない修正のタスク（`fixTaskOpen`：中止しておらず、完了していないか、完了してもその監視が
  `waiting`）か、登録して作る前のものがあれば、作らずに `DeploymentFixSuppressed`（`duplicate`、そのタスクの ID）を記録する。
- 連鎖の上限：段数（元のタスクの `fix.depth`、無ければ 0）+ 1 が `MAX_FIX_CHAIN`（3）を超えるなら、作らずに `DeploymentFixSuppressed`
  （`chain_limit`）を記録する。
- 作るときは、元のタスクに `DeploymentFixRegistered`（作るタスクの ID・種類・目印・段数・題・本文）を記録してから、その ID で `TaskCreated`
  （`start: deployment`、`repo` は監視したリポジトリ、`fix` に元のタスク・種類・目印・段数、予算は `budget.default_per_task_usd`）を記録する。
  作る前にデーモンが止まったら、次の確認で作る（`createRegisteredFixTask`）。
- 本文（`buildCiFixTask`・`buildDeploymentFixTask`。`TASK_BODY_MAX` まで）：元のタスクの題と ID、マージした PR、リポジトリとベースブランチ、
  マージのコミットとそのリンク。CI/CD なら、失敗したワークフロー・ジョブ・結論・実行へのリンクと、ログの抜粋（入りきらなければ、抜粋を
  等しく末尾から切り詰める）。デプロイの確認なら、スキル・結果の要点・根拠。題は `TASK_TITLE_MAX` まで。
- 修正のタスクは、ふつうのタスクとして実行待ちになる（オーケストレーターが進め方を選ぶ）。

コード: `apps/daemon/src/service.ts`（`registerFixTask`・`createRegisteredFixTask`）、`apps/daemon/src/deployment.ts`（`ciFingerprint`・`deploymentFingerprint`・`buildCiFixTask`・`buildDeploymentFixTask`）、`packages/core/src/projection.ts`（`fixDecisionPending`・`fixTaskOpen`）、`packages/core/src/events.ts`（`MAX_FIX_CHAIN`・`DeploymentFixRegistered`・`DeploymentFixSuppressed`）

## 再起動と中止

- CI/CD を待っている監視は、再起動の後も続く（時間の上限は監視を始めた時刻から）。
- デプロイの確認の実行中に止まったら、起動のとき（`recoverInterrupted`）に `DeploymentChecked`（`unknown`、`interrupted`、`run.daemonStopped`）を
  記録して `skipped` にする（やり直さない）。始める前の確認は、起動の後にワーカーが実行する。
- 元のタスクを中止したら、監視は終わる（中止したタスクには記録しない）。確認の実行中なら、ほかの実行と同じく止める。

コード: `apps/daemon/src/service.ts`（`recoverInterrupted`・`checkDeployments`）

## 画面

- タスクの詳細の「マージの後の監視」に、状態・理由・マージのコミット（リンク）とベースブランチ・監視を始めた時刻と CI/CD を待つ上限・CI/CD の
  実行とチェック（失敗・実行中のものを先に 20 件）・失敗したワークフローとジョブ（リンクとログの抜粋）・デプロイの確認（スキル・結果・要点・根拠）・
  修正のタスク（リンク）か作らなかった理由を出す。待っている間は画面を自動で更新する。
- 修正のタスクの詳細の先頭に、元のタスクへのリンクと段数を出す。
- 作業履歴には、7つのイベントを文で出す。工程ごとの費用の表に「デプロイの確認」の行（`deployment`）を出す。
- プロジェクトの設定に「マージの後の監視」のチェックを出す（既定は Off）。

コード: `apps/web/src/components/deployment.tsx`（`DeploymentWatchCard`）、`apps/web/src/app/tasks/[id]/page.tsx`、`apps/web/src/lib/labels.ts`（`describeEvent`）、`apps/web/src/lib/step-costs.ts`（`stepCosts`）、`apps/web/src/components/project-editor.tsx`
