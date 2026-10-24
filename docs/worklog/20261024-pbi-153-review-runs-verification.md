# PR のレビューの工程で、依存関係を取得して検証を実行させる

- 日付: 2026-10-24（UTC）
- タスク: PBI-153
- PR: （作成後に書く）
- ブランチ: feat/issue-153-review-runs-verification
- 関係する ADR: [PR のレビューの工程が、作業領域で依存関係を取得して検証を実行する](../adr/20261024-0310-review-runs-verification-in-workspace.md)

## 目的

PR のレビューのタスクで、レビューの工程が「作業領域に node_modules が無いので、typegen・tsc・vitest は手元で流していません。結果は CI と作者の報告によります」と報告した。
スキル `review-dispatch` の手順（`verification-run`）には検証の実行があるが、1回目は参照先を開かずに見送り、再レビューはスキルを使わなかった。
sacty のレビューの指示に、検証を実行してよいことと手順を書く（ステークホルダー）。sacty がレビューの前にテストを実行する案は採らない。

## したこと

- `apps/daemon/src/prompts.ts`
  - `reviewVerificationLines` を足し、レビューの工程の指示の「コードは変更しない」の直後に入れた。
    依存関係をロックファイルどおりに取得して検証を実行してよいこと、スキルの手順で担当の起動の前に実行すること、依存関係が無いことを理由に見送らないこと、CI の結果や作者の報告で代えないこと、実行できなかった検証はコマンドと理由を本文に書くことを書く。
    オーケストレーターが決めたテストのコマンドがあれば、候補として示す。
  - `rereviewLines` に、再レビューでもスキルの再レビューの手順でレビューし、今回のコードで検証を実行し直すことを足した。
- テスト：`prompts.test.ts`（検証の行の文言と位置・テストのコマンドの有無・言語やパッケージマネージャの名前を出さない・初回には再レビューの行を出さない・再レビューの行）。
- 仕様書（`spec/tasks-and-steps` の PR のレビュー）・ユーザードキュメント（`user/intake`）の日英、ADR を足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/prompts.test.ts -t "PBI-111|PBI-153"`：通った。
  `prompts.ts` を main に戻すと、足したテストと、検査を足した再レビューのテストの2件が失敗することを確かめた。
- `npm run lint`：初回はテストの整形で1件落ちた。`biome format --write` で直して通った（449 ファイル）。`npm run typecheck`：通った。
- `npx vitest run`：2603 件すべて通った。`npx vitest run tests/docs`：93 件通った（利用者向けの文書を足した後）。
