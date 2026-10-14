# 実装の PR のマージの後に、CI/CD とデプロイ後のアプリを監視し、失敗したら修正のタスクを登録する

- 日付: 2026-10-14（UTC）
- タスク: PBI-89
- PR: #97
- ブランチ: feat/issue-89-deploy-observer
- 関係する ADR: [sacty のタスクの実装の PR がマージされたら、CI/CD とデプロイ後のアプリを見届け、失敗したら修正のタスクを登録する](../adr/20261014-1439-deployment-watch-after-merge.md)

## 目的

sacty のタスクの実装の PR がマージされた後、ベースブランチの CI/CD が通ったか、デプロイされたアプリが動いているかまで見届け、
失敗していたら修正のタスクを自動で登録する。プロジェクトごとに Off にでき、設定していないプロジェクトの動作は変えない。
同じ失敗で二重に登録せず、修正のタスクのマージでの失敗の連鎖も際限なく続けない。費用はタスクの予算に入れる。

## したこと

- 仕様（監視の状態・CI/CD の判定・修正のタスクの重複の防止と連鎖の上限・再起動・予算・既定）を先に決め、ADR に残した。
- 作業履歴のイベントを7つ足した（`DeploymentWatchStarted`・`DeploymentCiFinished`・`DeploymentCheckStarted`・`DeploymentChecked`・
  `DeploymentWatchSkipped`・`DeploymentFixRegistered`・`DeploymentFixSuppressed`）。`DeploymentChecked` は費用を持つイベントにした。
  タスクの作られ方に `deployment`、`TaskCreated` に `fix`（元のタスク・種類・目印・段数）を足した（`packages/core/src/events.ts`）。
- 投影に `deployment`（監視の状態）と `fix` を足し、記録の順の誤りを受け付けないようにした（`packages/core/src/projection.ts`）。
- プロジェクトの設定に `deploymentWatch`（既定 Off。エクスポートにも含める）、`config.yaml` の `step_agents` に `deployment` を足した。
- GitHub の CI/CD の状態を読む口（`apps/daemon/src/ci.ts`）：ワークフローの実行・チェック・コミットの状態、失敗したジョブとログの末尾。
  ログは伏せてから切り詰める（切った先頭の行は捨てる）。
- スキルの探し方とリンクのたどり方、修正のタスクの題と本文、確認の指示と答えの読み取り（`apps/daemon/src/deployment.ts`）。
  リポジトリの口に `readLink` を足した。
- サービス（`apps/daemon/src/service.ts`）：マージの記録で監視を始める・PR の確認の終わりに CI/CD を確かめる（`checkDeployments`）・
  ワーカーでデプロイの確認を実行する（`checkDeployment`）・修正のタスクの登録と作り直し・再起動のときの中断の記録。
- 画面：タスクの詳細に「マージの後の監視」のカード（`apps/web/src/components/deployment.tsx`）、修正のタスクに元のタスクへのリンク、
  作業履歴の文、工程ごとの費用の表の「デプロイの確認」の行、プロジェクトの設定のチェック。
- 仕様書（`docs/spec/deployment-watch.md` を足し、作業履歴・タスクと工程・承認・設定・起動・書き出しを直した）とユーザードキュメント
  （`docs/user/deployment-watch.md` を足し、目次・プロジェクトの設定・config.yaml・タスクを直した）。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（54 ファイル・1265 件）・`npm run build`・
  `npx vitest run tests/docs`（66 件）がすべて通った。
- 修正を戻すとテストが落ちることを、10 か所で確かめた（重複の防止・連鎖の上限・決めるのを1回待つ・Off・5分の待ち・外を指すリンク・
  ログの伏せ・予算・再起動の回復・登録後の作り直し。それぞれ、対応するテストだけが落ちた）。
- 実際の git で、`.claude` から `.agents` へのリンク・外を指すリンク（相対・絶対）・`SKILL.md` 自体のリンク・リンクの循環を確かめた。
- 画面：一時的な SACTY_HOME・ポート 4791/4792、偽の gh/docker で起動し、本物の TaskService の流れ（偽の GitHub・CI・エージェント）で
  記録を作って、タスクの詳細・修正のタスク・費用の表・プロジェクトの設定を Playwright で録画して確かめた。起動したデーモンは、待っている
  監視で GitHub の API を実際に呼び、偽のトークンで 401 になり、待ったままになること（ログにトークンが出ないこと）を確かめた。
- 確かめていないこと：本物の GitHub の Actions・チェック・ログの API と、本物のエージェントでのスキルの実行、GitHub Enterprise Server。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA のセルフレビュー）CI のワークフローがすべて終わった直後に決めると、CI の後に `workflow_run` で現れるデプロイのワークフローの失敗を見落とす | すべて終わっても、次の確認で同じ並びになるまで決めないようにした（60分を過ぎていれば待たない）。テストを足し、戻すと落ちることを確かめた |
| （DA のセルフレビュー）ログの末尾をバイトで切ると、先頭の行が秘密情報の途中から始まり、伏せられないことがある | 切ったときは先頭の行を捨ててから伏せるようにした |

## 残したこと

- 監視の結果の Slack への通知（修正のタスクは、承認待ちなどで通知される）。
- 時間切れ・確かめられなかった監視をやり直す操作。
