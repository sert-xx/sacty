# 秘密情報を伏せる処理が、重なる値・届く分の境目をまたぐ値でも、値の一部を残さないようにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-438
- PR: なし
- ブランチ: なし
- 関係する ADR: [20261121-1200-redact-overlapping-and-boundary-values.md](../adr/20261121-1200-redact-overlapping-and-boundary-values.md)

## 目的

重なって現れる値と、届く分の境目をまたぐ値で、値の一部が作業履歴・セッションログに残る問題を直す。

## したこと

- `apps/daemon/src/agents/redact.ts`：`redact` を、出現の区間を集めて重なるものを束ねる方式に変えた。途中までの版 `redactPartial` を足した。
- `apps/daemon/src/session-logs.ts`・`apps/daemon/src/agent-sessions.ts`：持ち越しを伏せる前の文字列にした。
- `apps/daemon/src/agents/redact-overlap.test.ts`：表の例、素朴な総当たりとの突き合わせ、分けて渡す乱数のテスト、重ならない入力で修正前の手順と同じことを確かめるテストを足した。
- 仕様（日英）の伏せ方の説明を直した。

## 確かめたこと

- 検査の結果は、PR の本文に書いた。

## 残したこと

- `StreamRedactor` の値が途中で増えたときに持ち越しが足りない分は、今までどおり閉じるときの伏せ直しで補う。
