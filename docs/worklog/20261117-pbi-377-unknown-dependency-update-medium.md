# 依存の版の更新の上げ幅を読み取れないときの、PR のリスク評価の段階を、高から中に変える

- 日付: 2026-11-17（UTC）
- タスク: PBI-377
- PR: #409
- ブランチ: feat/pbi-377-unknown-update-medium
- 関係する ADR: [依存の版の更新の上げ幅を読み取れないときは、PR のリスク評価の段階を中にする](../adr/20261117-0455-unknown-dependency-update-is-medium.md)

## 目的

#408 で、上げ幅を読み取れない依存の版の更新を「高」にした。これは、人の決定に無く、実装で決めた点だった。
リポジトリの持ち主が、この点を「中にする」と決めた。そのとおりに変える。

受け入れ条件の要点：

1. 上げ幅を読み取れない依存の版の更新は、中になる。ほかに合図があれば、合図の決まりと比べて、高いほうになる。
2. メジャーは高、マイナー・パッチは低（ほかの変更が無ければ）のまま。#408 のほかの決まりは変えない。
3. 仕様書・ユーザードキュメント（日英）・テスト・作業履歴を合わせ、決定の変更を ADR に残す。

## したこと

- `apps/daemon/src/risk-assessment.ts`
  - `riskLevelFor`：`dependencyUpdate` が `unknown` のときの段階を、`high` から `medium` にした。合図から決まる段階と比べて、高いほうを返すのは、今までどおり。
  - `riskCriteriaLines`：エージェントへの指示の「major と unknown は high」を、「major は high。unknown は medium」にした。sacty が決め直すことの説明も、合わせた。
- `packages/core/src/events.ts`：`RiskDependencyUpdate` の説明を合わせた。
- `apps/web/src/i18n/messages/parts.ts`：画面の「依存の版の更新」の説明（日英）を合わせた。
- docs：仕様書 `docs/spec/risk-assessment`（日英）、ユーザードキュメント `docs/user/tasks`（日英）、新しい ADR。直前の ADR は、この 1 点を置き換えたので、`superseded` にした（本文は変えていない）。

## 確かめたこと

コマンドと結果（1 回目。PR を作る前のコード）：

- `npm run format`・`npm run lint`：指摘なし。
- `npm run typecheck`：通過。
- `npx vitest run --no-file-parallelism`：254 ファイル・4,865 件が通過（1 件は、もとからスキップ）。
- `riskLevelFor` の `unknown` を `high` に戻すと、直したテストのうち 3 件が落ちることを確かめた（戻した後に、通ることも確かめた）。

足した・直したテスト（`apps/daemon/src/risk-assessment.test.ts`）：

- 上げ幅を読み取れない更新だけ：エージェントが低・中を付けていても、中。
- 上げ幅を読み取れない更新＋軽い合図 1 つ：中。＋軽い合図 2 つ：高。＋重い合図：高。
- 上げ幅を読み取れない更新で、合図が無く、エージェントが高を付けている：高のまま。
- 指示の文面に、「major は high。unknown は medium」が入る。

確かめていないこと：

- 上げ幅を読み取れない更新の、実物の事例（今日の事例に無い）。エージェントが、どんな更新を「読み取れない」と答えるかは、確かめていない。
- 実際のブラウザでの画面の見え方（変えたのは、説明の文だけ）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

なし。
