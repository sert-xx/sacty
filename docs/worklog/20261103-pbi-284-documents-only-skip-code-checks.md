# 文書だけの依頼では testCommand にコードの検証を入れず、イメージの選び方と testCommand の指示の矛盾を直す

- 日付: 2026-11-03（UTC）
- タスク: PBI-284
- PR: なし
- ブランチ: feat/issue-284-pbi-284
- 関係する ADR: [文書だけの依頼では、テストのコマンドにコードの検証を入れず、依頼の判断と差分が食い違ったら最終レビューの前に止める](../adr/20261102-2359-documents-only-request-skips-code-checks.md)

## 目的

実験（S2）で、Markdown だけの依頼に、オーケストレーターがリポジトリ全体の検証（Go のテスト・lint・pnpm のビルド）を `testCommand` に設定し、Go が無いイメージで最終レビューが止まった。
PBI-158 で、文書だけの差分ならツール不足で止めなくなったが、要らない重い検証を設定することは変わっていなかった。考察の改善案のうち、案B（B-1）と案Eを入れる。案Cは見送り。

- 文書だけの依頼では、`testCommand` にコードの検証を入れない（文書向けの検証だけか、空）。空にしても、テストのファイルがあるリポジトリで矛盾として止まらない。
- コードも変える依頼では、今までどおり変更が及ぶ範囲の検証のすべてを入れる。
- 依頼の段階の判断と、実装の差分による判定（PBI-158）が食い違わない。
- イメージの選び方と `testCommand` の指示に順序をつけ、既定のイメージの説明を実際の中身に合わせる。

## したこと

- オーケストレーターの答えに `documentsOnly: true` を足した（`extractStepPlan`、`StepsChosen` の `documentsOnly`、`Task.documentsOnly`）。実装を含み、不具合の修正でない組み合わせのときだけ受け付ける。
- 指示（`buildOrchestratorPrompt`）：文書だけの依頼ではコードの検証を入れず、文書向けの検証だけか `noTests` にさせる。文書のファイルは、`isDocumentsOnly` と同じ拡張子の一覧（`CHANGE_DOCUMENT_EXTENSION_LIST`）を示す。コード中のコメント・設定・`txt`・画像の変更を含むなら文書だけにしない。コードも変える依頼では、変更が及ぶ範囲の検証のすべてを入れる、と明記した。
- `checkNoTests`：`documentsOnly` なら、起点のコードのテストのファイルを探す歯止めを行わない。
- 食い違いの歯止め：最終レビューの前に、差分に文書のファイル以外があれば、ゴールガーディアンを実行せずに一時停止する（`verify.documentsOnlyContradicted`、`changesOutsideDocuments`）。再開のときに、テストの扱いを決め直せる（`documentsOnlyContradicted`、`canDecideTests`）。決めたら `documentsOnly` を消す。
- 案E：イメージの選び方と `testCommand` の関係を、ツールを持つイメージを優先し、どこにも無いときだけ書いたうえで `imageReason` に理由を書く、という順序にした。
- 既定のイメージの説明：作った `sacty-agent:1.15.1` のコンテナで、コマンドの有無を確かめて合わせた（入る：node・npm・git・jq・rg・fd・tree・file・less・curl・zip・unzip・xz・bzip2・patch・make・sqlite3・python3・shellcheck・drawio・osv-scanner・gitleaks・claude・codex。無い：go・java・pnpm・yarn・golangci-lint・psql・mysql・redis-cli・chromium・kustomize・helm・terraform・gcc）。オーケストレーターの指示の3か所（工程の選択・リポジトリ無しの選択・レビューのイメージの選択）の説明を同じ定数にした。
- 仕様書・ユーザードキュメント（日英）・ADR を直した。

## 確かめたこと

作業は、リポジトリの外の worktree（`sacty-wt-pbi-284`）で行った。

- `npx biome check .`・`npm run typecheck`・`npx vitest run tests/docs`：通った。
- 追加したテスト（`daemon.test.ts`・`prompts.test.ts`・`projection.test.ts`）：
  - 文書だけの依頼（`documentsOnly`）で、テストのファイルがあるリポジトリでも止まらず、差分が文書だけなら最終レビューを通って承認待ちへ進む。`documentsOnly` が無ければ今までどおり止まる。不具合の修正では使わない。
  - 差分にコードがあれば、最終レビューをせずに止まる（ゴールガーディアンを実行しない）。決めずに再開すると同じ理由で止まる。テストの扱いを決めて再開すれば、その扱いで最終レビューに進む。文書向けの検証を `testCommand` に書いたときも同じ。コードも変える依頼は今までどおり進む。
  - 指示の文面（コードの検証を入れない・コードも変える依頼ではすべて入れる・順序・既定のイメージの説明）と、既定のイメージの説明がイメージを作る手順と合っていること。
- 修正を戻すと失敗することも確かめた：①テストのファイルを探す歯止めを外す処理を戻す → 文書だけの依頼のテストが落ちる。②差分の歯止めを無効にする → 食い違いのテスト4件が落ちる。③`TestsDecided` と工程の選び直しで `documentsOnly` を消す処理を戻す → 2件が落ちる。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| DA（自分で確認）：誤って文書だけと判断されても、コードの変更が検証なしで通らないか | 最終レビューの前に差分を調べ、文書でないファイルが1件でもあれば止める。1件だけのとき・文書向けの検証を `testCommand` に書いたときも止まることをテストで確かめた |
| DA：差分が空のとき | 止めない（検証されないコードの変更が無い）。テストを足した |
| DA：不具合の修正（再現がある）で `documentsOnly` を答えたとき | 受け付けず捨て、今までどおり `orchestrator.bugfixNeedsTests` で止まる |
| DA：人がテストの扱いを決めて再開した後、同じ理由でまた止まらないか | `TestsDecided` で `documentsOnly` を消すので止まらない（テストで確かめた） |

## 残したこと

- 案C（必要なツールがイメージに無いことを、実装の前に申告させて止める）は、人の判断で見送った。
- 案B-2（`testCommand` を文書向けの最小のコマンドに絞る）は、推測でコマンドを作ることになるため入れていない。
