# 予算・費用の概算・一時停止と、オーケストレーターへの質問の図とスクリーンショットを docs に足す

- 日付: 2026-10-23（UTC）
- タスク: なし
- PR: #210
- ブランチ: ccr-51405501-y917bn
- 関係する ADR: なし

## 目的

仕様書とユーザードキュメントに図とスクリーンショットを足してきたが、予算（設定・費用の概算・予算の上限での一時停止）と、
タスクの詳細の「オーケストレーターに質問」には、主題にした図もスクリーンショットも無かった。日本語と英語の両方で足す。

## したこと

- スクリーンショット（`scripts/docs-screenshots/`）
  - `seed.mjs`：架空のタスクを足した。
    - 予算の上限で一時停止したタスク（社内ポータル。上限 $2、サブスクリプションの実行で概算、80% の通知の後に上限を超える）。
    - 実装の PR を待つタスクに、オーケストレーターへの質問と答え（`QuestionAsked`・`QuestionAnswered`）。
    - 工程の実行の道具（`run`）で、接続先の認証方式（`authMode`）を変えられるようにした（費用の表の設定の行に出るため）。
  - `shots.mjs`：`task-budget-paused`（予算で止まったタスクの詳細の上部）・`task-costs`（工程ごとの費用の欄）・
    `task-chat`（質問の欄を開いたタスクの詳細）を足した。
  - `npm run docs:screenshots` で全部を撮り直した。架空のタスクが増えたので、ダッシュボード（あなたの出番・止まっている理由・
    予算に近いタスク）とヘッダーの件数が変わり、ほかの既存のスクリーンショットもそろえて撮り直した。
- 図（`scripts/docs-diagrams/diagrams/budget-question.mjs`）
  - `budget-flow`：予算の上限の決まり方（作成・工程の選択）→ 実行で費用を足す → 80% の通知 → 上限の確かめ → 一時停止 → 上限を上げて再開。
  - `question-flow`：質問 → 指示（台帳）とセッションログ（`/sacty-logs`）→ オーケストレーターのセッションの複製 → 答え（費用は予算に入り、状態は変えない）。
- docs
  - `docs/spec/tasks-and-steps(.en).md`：「予算・一時停止・再開・中止」に `budget-flow`、「オーケストレーターに質問」に `question-flow`。
  - `docs/user/tasks(.en).md`：「オーケストレーターに質問する」に `task-chat`（開き方として、画面の右下の AI のアイコンを書き足した）、
    「一時停止・再開・中止」に `task-budget-paused`。
  - `docs/user/config(.en).md`：「予算」に、タスクの詳細の「費用」と「概算」の印・「工程ごとの費用」の説明と `task-costs`。

## 確かめたこと

- `npm ci`・`npm run build`：成功。
- `node scripts/docs-screenshots/capture.mjs`（Playwright は環境のブラウザーに合わせて `playwright@1.56.1` を `--no-save` で入れた）：日本語・英語の 11 枚ずつを書き出し、新しい 3 枚とダッシュボードを目で確かめた。
- `npm run docs:diagrams`・`node scripts/docs-diagrams/build.mjs --check`：一致（警告は既存の `memory-promotion.en`・`audit-flow.en` の2件だけ）。新しい図は Chromium で描いて、日本語・英語の両方を目で確かめた。
- `npx vitest run tests/docs`：93 件すべて成功。
- `npx biome check scripts/`：問題なし。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

なし
