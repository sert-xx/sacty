# 既定のレビューの観点ごとの段階を下げ、expert も既定で使わない

- 日付: 2026-11-14（UTC）
- タスク: PBI-344
- PR: #370
- ブランチ: feat/issue-344-review-viewpoint-tiers
- 関係する ADR: [既定のレビューの観点ごとの段階を下げ、expert も既定で使わない](../adr/20261114-1354-lower-review-viewpoint-tiers.md)

## 目的

既定の review スキルは、観点 1 つにつき担当を 1 つ起動する。レビューの AI の使用量が大きいので、起動の規則は変えず、観点ごとの段階だけを下げる。
下げる観点と段階は、ステークホルダーが決めた（ADR の表）。

## したこと

- `apps/daemon/default-context/skills/review/review-dispatch/references/viewpoints.md`：「観点ごとの段階」の表を直した。
  - X-1 を `expert` から `advanced` に、C-2・D-3・D-5 を `advanced` から `standard` に、C-5・C-15・D-4・X-2・X-3 を `standard` から `entry` に移した。
  - `expert` の行を消し、表で使わない段階に `expert` を足した。
- `apps/daemon/default-context/skills/review/review-dispatch/SKILL.md`：起動表の例の段階（X-1・X-3）を合わせた。
- `docs/user/config.md`・`config.en.md`：段階の表の「想定する使い方」を合わせた。`standard` の「ほとんどの観点の既定」は、`entry` の観点が増えて合わなくなったので直した。
- ADR を足し、X-1 を `expert` とした ADR を置き換え済みにした（名前の変更で切れるリンクを直した）。
- 仕様書（`docs/spec/context.md`）は、観点ごとの段階の中身を書いていない（観点カタログで決めるとだけ書く）ので、直していない。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通った。
- `npx vitest run --no-file-parallelism`：219 ファイル・4266 件が通った（1 件は元からのスキップ）。
- `apps/daemon/src/default-skills.test.ts` に、段階の表のテストを足した（どの観点も 1 つの段階にだけ入る・カタログの観点がすべて表にある・起動表の例が表と食い違わない）。
  スキルの変更だけを戻すと、足したテストと X-3 の段階のテストの 3 件が失敗することを確かめた。
- 古い段階の記述（X-1 と `expert` の組み合わせなど）が、スキル・仕様書・ユーザードキュメントに残っていないことを `grep` で確かめた。

確かめていないこと：使用量がどれだけ減るか、下げた段階で見落としが増えないか。

## レビューの指摘と対応

- セルフレビュー：ユーザードキュメントの `standard` の説明（「ほとんどの観点の既定」）が、変更後の割り当てと合わないことに気づき、直した。
