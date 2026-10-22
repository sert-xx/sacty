# テストが決まらずに止まったタスクを、人がテストを決めて再開できるようにし、決めずに再開したら工程の選択からやり直す

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: #201
- ブランチ: claude/ecstatic-noether-obv960
- 関係する ADR: [テストが決まらずに止まったタスクは、人が再開のときにテストのコマンドかテストなしを決められ、決めずに再開すると工程の選択からやり直す](../adr/20261022-1544-decide-tests-when-resuming.md)

## 目的

エージェントのスキルを集めたリポジトリや、ドキュメントを置くだけのリポジトリで、「オーケストレーターが、対象リポジトリのテストのコマンドを決められませんでした。…タスクの内容にテストの実行方法を書いて、作り直してください」で止まる、という報告への対応。
テストを書く種類のリポジトリではないので書けることが無く、止まったタスクには「再開する」しか無くて内容を直せず、再開すると費用をかけた後の検証で同じ理由でまた止まっていた。

- オーケストレーターが、調べてもテストの仕組みが見つからなければ、ちゃんと `noTests` と答えるようにする。
- 止まったタスクの上で、人がテストのコマンドを指定するか、テストなしで進めるかを決めて再開できるようにする。
- 決めずに再開したら、同じ工程のまま進めずに、工程の選択からやり直す。

## したこと

- オーケストレーターへの指示（`apps/daemon/src/prompts.ts` の `buildOrchestratorPrompt`）
  - 「分からなければ空にする（推測で書かない）」と「テストの仕組みはあるのにコマンドが分からないときは `noTests` を書かない」をやめた。
  - 調べる場所（パッケージの設定・Makefile・justfile・Taskfile・CI の設定・pre-commit・README・CONTRIBUTING・AGENTS.md・CLAUDE.md・テストのファイル）を挙げ、見つからなければ `noTests` に根拠を書かせ、実装する組み合わせでは両方を空にさせないようにした。スキル集・ドキュメントだけのリポジトリの例を足した。
  - 既定のスキル `plan-steps`（`apps/daemon/default-context/skills/plan-steps/SKILL.md`）にも同じ決まりを足した。
- 人がテストを決める
  - `packages/core/src/events.ts`：イベント `TestsDecided`（`testCommand` か `noTestsReason` のどちらか1つ）を足し、`ResumeTaskInput` に `tests` を足した。
  - `packages/core/src/projection.ts`：`testsUndecided`・`canDecideTests` を足し、`TestsDecided` で `testCommand` か `noTestsReason` と `testsDecidedBy: "person"` を持つようにした。不具合の修正（再現の工程がある）はテストなしにできない。
  - `apps/daemon/src/service.ts` の `resume`：`tests` があれば、検査して `TestsDecided` を記録してから再開する（`resume.testsNotUndecided`・`resume.bugfixNeedsTestCommand`）。
  - 実装・最終レビューの指示と PR の本文で、人が決めた理由だとわかるようにした（`noTestsReasonLines`・`noTestsJudge`・`resultTableLines`）。
- 決めずに再開したら選び直す
  - `TaskResumed` に `rechooseSteps` を足した。`canRechooseSteps`（工程を選んだ直後に止まり、まだどの工程の成果も無い）のときに記録し、投影で工程の選択で決めたもの（工程・理由・テストのコマンド・イメージ・サービス・書き出し先、人が工程ごとに変えたイメージ・エージェント）を消す（`clearChosenSteps`。予算の上限は残す）。次の実行でオーケストレーターが選び直す。
- 文言（`packages/core/src/messages.ts`）：`orchestrator.testCommandUnknown`・`orchestrator.noTests*`・`orchestrator.bugfixNeedsTests` を、作り直しではなく、再開のときの選び方の案内にした（日英）。
- 画面
  - 再開の欄（`apps/web/src/components/resume-form.tsx`）に「テストの扱い」（決めずに再開する・テストのコマンドを指定する・テストなしで進める）を足した。不具合の修正ではテストなしを選べない。テストなしの理由には既定の文を入れておく。
  - `apps/web/src/app/actions.ts`・`apps/web/src/lib/daemon.ts`：選んだテストの扱いを再開の API に渡す。
  - 工程の欄に、人が指定したテストのコマンド・人が決めた理由であることを出す。作業履歴に `TestsDecided` と、選び直す再開を出す。
- docs：仕様書 `docs/spec/tasks-and-steps.md`（オーケストレーターの答えの `noTests`・「テストが決まらずに止まったタスクの再開」）、ユーザードキュメント `docs/user/tasks.md`（「テストなしで進めずに止まったとき」）、それぞれの英語の版、ADR を足し、テストのコマンドを人が直す手段を設けないとした ADR を一部置き換えにした。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`（エラー 0）・`npm run build`（終了コード 0）・`npx vitest run tests/docs`（89 件が合格）が通った。
- `npx vitest run`：132 ファイル・2542 件のうち、2533 件が合格、9 件が失敗した。失敗した 9 件（`agent-sessions`・`context-mcp`・`context`・`host-mcp-processes` のテスト）は、この変更の前のコード（同じ環境の別の作業ツリー）でも同じ 9 件が落ちる。この環境（ホストの MCP のプロセス・ファイルの権限）によるもので、この変更とは関係しない。
- 足したテスト
  - 結合（`apps/daemon/src/daemon.test.ts`「テストの仕組みが無いリポジトリ（PBI-94）」）：テストを決めずに再開すると工程の選択からやり直し、同じ答えなら調査を実行せずにまた止まる。選び直しでオーケストレーターが `noTests` を答えれば進む。人がテストなしを選ぶと、テストのファイルがあっても止めずに目的から判定し、指示と PR の本文に人が決めた理由が出る。人がテストのコマンドを指定すると、ゴールガーディアンがそれを実行する。不具合の修正はテストなしにできず、テストが決まらずに止まったのではないタスクには指定できない。
  - 単体：投影（`TestsDecided` の条件、選び直しで消すもの、工程の成果ができた後は選び直せない）、オーケストレーターの指示（両方を空にさせない・前の指示が無い）、作業履歴の表示（日英）、再開の欄（日英・不具合の修正・テストのコマンドがあるタスクには出さない）。
- レビューの対応の後、`npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run tests/docs` が通り、`npx vitest run` は 134 ファイル・2551 件のうち 2542 件が合格した（失敗は上と同じ、環境による 9 件）。
- 修正を戻すと落ちることを、4か所で確かめた（選び直しをやめる・不具合の修正のテストなしを通す・`TestsDecided` を記録しない・指示の見出しを人のものにしない）。それぞれ、対応する結合テストが落ちた。
- 確かめていないこと
  - 本物の AI のオーケストレーターが、新しい指示でスキル集・ドキュメントだけのリポジトリに `noTests` を答えるか（結合テストは答えを偽物で与えている）。
  - 画面をブラウザで開いての確認（サーバーで描いた HTML をテストで確かめただけ）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （PR #201）人がテストのコマンドを指定したときも、実装・最終レビューの指示と PR の本文で、人が指定したことを示す（仕様書と ADR は、コマンドと理由の両方で判断者を示すとしている） | `personTestCommand`・`testCommandLine` を足し、実装・再現の指示（「人が再開のときに指定したテストのコマンド（…）」）、最終レビューのテストの実行（「人が再開のときに指定したもの」）、PR の本文のテストの行（「（人が指定したテストのコマンド）」）に出すようにした。結合テストで3か所を確かめ、表示をやめると落ちることを確かめた |
| （PR #201）画面でテストの扱いを選んで送る経路（ラジオの切り替え・入力欄・`FormData` から `ResumeTaskInput.tests` への変換）を確かめるテストが無い | jsdom で再開の欄を操作するテスト（`apps/web/src/components/resume-form-submit.test.ts`：ラジオを切り替えると入力欄が出る・入れた値を送る・決めずに再開・不具合の修正ではテストなしを選べない）と、Server Action のテスト（`apps/web/src/app/resume-actions.test.ts`：`resumeTask` に渡す `tests`・空白の除去・入力の誤りでは送らない・デーモンが拒んだとき）を足した。`resumeTask` に `tests` を渡さない・入力欄の名前を変えると、それぞれ落ちることを確かめた |

## 残したこと

- 止まったタスクの説明（内容）を直す手段は足していない。内容を直したいときは、今までどおり中止して再実行する。
