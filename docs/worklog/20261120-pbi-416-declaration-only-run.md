# PBI-416 テストに対応しない観点の「テストなし」と、申告だけを求める実行

- 日付: 2026-11-20（UTC）
- タスク: PBI-416
- PR: なし
- ブランチ: なし
- 関係する ADR: [申告だけが欠けて止まる前に、申告だけを求める実行を1回足す](../adr/20261120-1200-ask-declaration-only-before-pausing.md)

## 目的

直しが終わっているのに、申告だけが欠けて一時停止し、人が再開するまで提出されないことを無くす。

## したこと

- `apps/daemon/src/prompts.ts`：テストで確かめようがない観点を、`tests` を空にした理由つきの `untested` で申告する指示を足した（実装の指示・観点が欠けたときのやり直しの指示）。実行される振る舞いを変える観点は、今までどおりテストを書く。
- `apps/daemon/src/service.ts`・`packages/core`：欠けているのが申告だけで作業領域が変わらないとき、止める前に申告だけを求める実行を1回足す。記録は `ImplementationIncomplete` の `declarationOnly`、投影は `incompleteRuns.declarationAsked`。
- `apps/daemon/src/timeout-resume.ts`：続きの実行の知らせに、申告の出し直しの形を足した。
- 画面の作業履歴の行と、一時停止の文言（`declarationAsked`）を足した。
- 仕様書・ユーザードキュメント（日英）を直した。

## 決めたこと

- 人が再開すると、`declarationAsked` も数え直す（再開の後に再び同じ条件になれば、もう1回求める）。
- 申告だけを求める実行で作業領域が変わったときは、`declarationAsked` を消す（後の別の止まりで、もう1回求めうる）。

## 確かめたこと

`daemon-implement.test.ts` の PBI-416 の節（欠けた観点・申告なし・2回目は止まる・未完了の申告・作業領域が変わる・上限・投影・指示の文）、`labels.test.ts`、`timeout-resume.test.ts`。
