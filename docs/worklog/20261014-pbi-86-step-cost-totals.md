# 工程ごとの費用の表の合計を、タスクの費用と同じ規則で集計して一致させる

- 日付: 2026-10-14（UTC）
- タスク: PBI-86
- PR: #93
- ブランチ: feat/issue-86-step-cost-totals
- 関係する ADR: なし

## 目的

タスクの詳細の「工程ごとの費用」の表（`apps/web/src/lib/step-costs.ts`）は、チケットの読み取り（`TicketTriaged`）と
リポジトリの選択（`RepositoryChosen`）の費用を数えていなかった。projection はこの2つをタスクの費用に足しているので、
表の合計とタスクの費用（予算の使用済み）がずれていた。表と projection が同じ規則で集計するようにし、どのタスクでも
合計が一致するようにする。あわせて、`chooseSteps`・`extractStepPlan` の古いコメント（判断できなければ標準の工程にする）を
今の振る舞い（`OrchestratorFailed` を記録して一時停止する）に直す。

## したこと

- 費用（`costUsd`）を持つイベントを洗い出した。`StepsChosen`・`OrchestratorFailed`・`TicketTriaged`・`RepositoryChosen`・
  `AgentRunCompleted`・`AgentRunFailed`・`ChangeJudged`・`ReworkJudged`・`FinalReviewed`・`FinalReviewFailed`・
  `QuestionAnswered`・`OutputExported` の12種類。統合レビュー（`IntegrationReviewed`）は費用を持たず、費用は続く
  `AgentRunCompleted` に記録される（工程の行に入る）。
- `packages/core/src/cost.ts` に、共通の規則を置いた。
  - `CHARGED_EVENT_TYPES`（上の12種類）・`isChargedEvent`・`addUsd`・`chargeBudget`（費用を予算の使用済みに足す）。
  - 費用を持つイベントの種類を一覧に足し忘れると、型の検査（`Exclude<...> extends never`）で typecheck が落ちる。
- `packages/core/src/projection.ts` は、各イベントの case で個別に足していた費用を消し、switch の後で `chargeBudget` を
  1回だけ呼ぶようにした（受け付けない並びは switch の中で投げるので、その費用は入らない。これまでと同じ）。
- `apps/web/src/lib/step-costs.ts` は、
  - 合計の費用・換算値かを、projection と同じ `chargeBudget` で作業履歴の順に足して出す（行の合計を足し直さない）。
    行の順に足すと、100万分の1ドルの丸めの順が変わり、投影と1e-6 ずれることがあった（テストで見つけた）。
  - 費用を持つイベントを行に振り分ける switch を、`ChargedEvent` に対して網羅させた（`satisfies never`）。費用を持つ種類を
    足して行を決めないと typecheck で落ちる。
  - 工程の外の行に「チケットの読み取り（オーケストレーター）」（`triage`）・「リポジトリの選択（オーケストレーター）」
    （`repository`）を足した。工程の選択（オーケストレーター）の行の前に出す。人が選んだ記録（費用・使用量・エージェントが
    無い）は、実行に数えない（工程を固定していた頃の `StepsChosen` と同じ扱い）。
- 画面の文言（`apps/web/src/i18n/messages/task.ts`）と、行の名前の出し分け（`apps/web/src/components/step-costs.tsx`）。
- コメント：`apps/daemon/src/prompts.ts` の `extractStepPlan`、`apps/daemon/src/service.ts` の `chooseSteps`、
  `packages/core/src/events.ts` の `StepsChosen`・`fallback`・`MVP_STEPS` を、今の振る舞いに直した（判断できない・実行に
  失敗したときは、標準の工程で進めず `OrchestratorFailed` を記録して一時停止する。PBI-40 で変わった）。
- 仕様書：はじめは費用の節を書く仕様書（PR #91）が main に無かったので直していなかった。#90・#91・#92 のマージの後に
  rebase し、`docs/spec/event-log.md` を直した（下の「レビューの指摘と対応」）。

## 確かめたこと

- テストを足した。
  - `packages/core/src/cost.test.ts`：`EventInput` の種類のうち費用を持つものと `CHARGED_EVENT_TYPES` が一致する。
    `chargeBudget` の足し方。
  - `apps/web/src/lib/step-costs-totals.test.ts`：種を決めた乱数で、projection が受け付ける作業履歴を300件作り
    （チケット・リポジトリの無いタスク・ふつうのタスク。途中で終わる作業履歴も。費用は小数第7位まで）、表の合計・換算値かが
    タスクの費用と完全に一致する、行の合計とも一致する、費用のある記録がすべてどれかの行に入る、12種類すべてを通る、を
    確かめる。チケットの読み取り・リポジトリの選択の行の位置と中身、人が選んだときに行を出さないこと。
- 修正を戻すと落ちること：`apps/web/src/lib/step-costs.ts` を main の版に戻すと、足したテスト4件がすべて落ちた
  （チケットの読み取り・リポジトリの選択の費用が合計に入らない。費用が無い場合も、丸めの順の違いで
  `0.47378` と `0.473781` のようにずれた）。`CHARGED_EVENT_TYPES` から `TicketTriaged` を消すと、typecheck が落ちた。
- `npm run lint`（終了コード0）・`npm run typecheck`・`npx vitest run`（51ファイル・1169件が通過）・`npm run build`。
- 画面：一時的な SACTY_HOME と別のポートで起動し（本物の AI・秘密情報は使わず、費用を持つイベントを入れた作業履歴を
  用意）、チケットのタスクとリポジトリの無いタスクの詳細で、「チケットの読み取り」「リポジトリの選択」の行が出て、表の合計
  （$0.2038・$0.1180）がページ上部のタスクの費用と一致することを確かめた（main の版の表は、この2行が無いので、合計がそれぞれ $0.1717・$0.0993 になる計算。画面では撮っていない）。
  動作確認の動画は、リポジトリには入れない（PR の説明で扱う）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （セルフレビュー）`chooseSteps` のコメントに、リポジトリを選べなかったときの戻り値が書かれていない | 「選べなければ failure」を書き足した |
| #89 のマージに追従する | rebase した（衝突なし）。#89 は費用を持つイベント・投影を変えていないので、一覧と表はそのまま |
| #90・#91・#92 のマージの後、仕様書の費用の節を今回の実装に合わせる | rebase した（衝突なし）。`docs/spec/event-log.md` の投影の費用の説明・「費用」の節（12種類のイベントと表の行の対応、共通の規則 `chargeBudget`）・「画面の表示」の表の行の順と合計を直し、コードの参照を `packages/core/src/cost.ts` に移した（`addUsd` は projection から cost.ts に移ったため、参照の検査が落ちていた）。ユーザードキュメントは、表の行を説明している箇所が書き出しの1行だけで、変わらないので直していない |

## 残したこと

なし
