# PR のレビューの工程で、依存関係を取得して検証を実行させる

- 日付: 2026-10-24（UTC）
- タスク: PBI-153
- PR: #212
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
- `npx vitest run`：2603 件すべて通った。
- `npx vitest run tests/docs`：作業履歴の PR の欄を仮の文字のままにして1件落ちた（コミットの後に気付いた）。PR の番号を書いて 93 件通った。

## レビューの指摘と対応（PR #212、sacty のレビュー）

sacty のレビューの工程が、この PR の変更どおり手元で `npm ci`・lint・typecheck・`npx vitest run` を実行してレビューした（実プロセスのテスト 16 件が、Node の版の違う環境で落ちたと報告。この PR とは関係しない）。

- [要修正] 取り込んだ PR のコードを、エージェントの認証情報のあるコンテナで必ず実行させることになる：ステークホルダーの判断で、検証は絞らず、文書に書いて受け入れる。
  `user/intake`（日英）に、PR のコードがコンテナの認証情報を読めることと、フォークや作者を信頼できない PR を取り込ませないことを書いた。
  仕様書の PR のレビューの「検証」と ADR の「決定」「理由」「影響」にも書いた。
- [提案] 取り込みのレビューのタスクでは、テストのコマンドの候補の行が出ない：コードで確かめたとおり（`chooseReviewSteps` は `testCommand` を持たない）。候補は示さないことを、JSDoc・仕様書（日英）・ADR に書いた。
- [提案] レビューの工程の時間の上限が延びていない：`TEST_RUNNING_ROLES` に `review` を足した。`run-timeouts.test.ts` と、`spec/agent-execution`・`spec/configuration`・`user/config`（日英）を直した。
- [提案] 「スキルの再レビューの手順で」は、前回以降の差分を渡さないのでスキルと食い違う：再レビューの行を「スキル review-dispatch（流れは pr-review）でレビューし、検証は今回のコードで実行し直す」に絞った。
- [提案] `existingReviewLines` の JSDoc がずれた：`reviewVerificationLines` を、その JSDoc の前に移した。
- [提案] 言語の名前を出さない検査がプロンプト全体に掛かっている：検査を検証の行（オーケストレーターのコマンドの値を除く）に絞り、`yarn`・`pip` なども見るようにした。
- [提案] フォーマッターは確かめるだけのモードで実行するよう書く：指示に「対象のファイルは書き換えない（フォーマッターなどは確かめるだけのモードで実行する）」を足し、テストで確かめた。

確かめたこと：

- `npx vitest run apps/daemon/src/prompts.test.ts apps/daemon/src/run-timeouts.test.ts`：120 件通った。
  `run-timeouts.ts` を main に戻すと時間の上限のテストが、フォーマッターの一文を除くと検証の行のテストが失敗することを確かめた。
- `npm run lint`・`npm run typecheck`：通った。`npx vitest run`：2603 件すべて通った。`npx vitest run tests/docs`：93 件通った。

## 2回目のレビューの指摘と対応（PR #212、sacty のレビュー。判定：提案あり）

前回の7件は、すべて対応を確かめたとされた。

- [提案] 設定を読めないときの上限の記述と、`run-timeouts.ts` の先頭のコメントに `review` が入っていない：`spec/agent-execution`（日英）の設定を読めないときの行と、先頭のコメントに PR のレビューを足した。
- [提案] 注意書きの、PR のコードが触れられるものと、取り込まれる経路が、実際より狭い：`spec/gateway`（GitHub の読み取りの中継は、プロジェクトの gh のアカウントを実行に結びつける）と `agents/docker.ts` の書き戻しで確かめて、次を足した。
  - `user/intake`（日英）：codex の `auth.json` の書き換えがホストに残ること、実行の間はゲートウェイで GitHub の読み取りと MCP を使えること、Bot の依存関係の更新の PR でもインストールのスクリプトが動くこと、取り込みはフォーク・Bot で絞らず、ラベルの自動の付与や CODEOWNERS などの自動の依頼では人が判断しないまま取り込まれうること、「レビューだけ」でも同じこと。
  - `user/tasks`（日英）の「レビューだけ」に、注意と `user/intake` の節へのリンク。
  - 仕様書（日英）の「検証」と ADR の「影響」を同じ範囲にそろえた。

確かめたこと：

- `npm run lint`・`npm run typecheck`：通った。`npx vitest run`：2603 件すべて通った（`tests/docs` の 93 件を含む）。
