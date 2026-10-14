# sacty が作る PR の本文を、リポジトリ・Org の PR テンプレートに従わせる

- 日付: 2026-10-14（UTC）
- タスク: PBI-87
- PR: #99
- ブランチ: feat/issue-87-pr-template
- 関係する ADR: [sacty が作る PR の本文を、リポジトリ・Org の PR テンプレートの見出しに沿って決まった規則で埋める](../adr/20261014-1517-pr-body-follows-repository-template.md)

## 目的

sacty が作る PR（実装の PR と、要求要件・設計の PR）の本文を、対象のリポジトリ（無ければ Org）の PR テンプレートの
見出し・項目の形で書く。sacty が後の処理に使う情報（タスクの ID・`Closes`）は失わず、テンプレートが無い・読めないときは
今の本文で PR を作り、どちらにしたかを台帳とタスクの画面に残す。

## したこと

- `apps/daemon/src/pr-template.ts` を足した。
  - `GitHubPullRequestTemplates`：contents API で、対象のリポジトリの `.github/`・ルート・`docs/` の `pull_request_template.md`
    （大文字・小文字を区別しない）→ 同じ順の `PULL_REQUEST_TEMPLATE/` の中の `.md`（名前の順で最初のもの）→ Org の公開の
    `.github` リポジトリの同じ場所、の順に探す。404 は無いものとし、ほかの失敗・時間切れ（全体で30秒）・32 KiB を超える・
    空・UTF-8 でないものは「使えない」として理由を返す（例外にしない）。
  - `fillTemplate`：見出し（ATX と行全体の太字）で分け、見出しの文から種類（目的・変更・テスト・関係する Issue・書けないもの）を
    決まった規則（`CATEGORY_RULES`）で決めて内容を入れる。説明の文・コードブロックは消し、コメントとチェックボックスは残して、
    チェックボックスはすべて外す。埋められない見出しは「該当なし（sacty は記入していません）」。見出しに入らない内容と
    sacty の記録は末尾の折りたたみに置き、タスクの ID などの最後の部分（footer）は必ず最後に置く。
  - `limitBody`：本文を 65,000 文字までにし、超えたら footer の前の後ろを省く（閉じられていないコメント・コードブロック・
    折りたたみは閉じる。サロゲートペアの途中で切らない）。
- `apps/daemon/src/prompts.ts`：今の本文を組み立てていた部分を関数に分け（出力は変えていない）、テンプレートに入れる中身
  （`buildPullRequestBodyParts`・`buildStepPullRequestBodyParts`）を足した。
- `apps/daemon/src/service.ts`：`publish`・`publishStepPullRequest` で、PR を作る・更新する前に `pullRequestBody` で本文を作る
  （テンプレートを探す口 `templates` は依存として注入し、無ければ今の本文）。使った秘密の値を伏せ、記録
  （`PullRequestPublished`・`StepPullRequestPublished` の `template`）に使ったテンプレートか理由を残す。
- `packages/core`：`PullRequestTemplateUse`（記録の形）と、理由の文言 `pr.templateFailed`・`pr.templateTooLarge`・
  `pr.templateInvalid`・`pr.templateEmpty`・`pr.templateOrgPrivate`。
- 画面：タスクの PR の欄に「本文」の行を足し、実装の PR と要求要件・設計の PR それぞれに、使ったテンプレートか、決まった形に
  した理由を出す（`apps/web/src/components/pull-request.tsx` の `TemplateUse`）。
- docs：仕様書 `docs/spec/approval.md` に「PR の本文と PR テンプレート」の節、ユーザードキュメント `docs/user/tasks.md` に1項目、
  ADR を足した。

### Dev の判断

- 複数のテンプレート（`PULL_REQUEST_TEMPLATE/`）は、1つのファイルが無いときだけ、名前の順で最初の `.md` を使う
  （GitHub は既定には使わないが、ディレクトリだけのリポジトリでも従えるように。どれを使ったかは記録に残る）。
- Org の `.github` は、GitHub と同じく公開のものだけを使う（非公開なら使わず、理由を残す）。
- テンプレートを埋めるのにエージェントは使わない（費用・時間・出力の揺れを避ける。ADR に理由）。
- テンプレートでチェックされているチェックボックスも外す（sacty は確かめていないので）。
- 要求要件・設計の PR では、関係する Issue は `#<番号>` の参照だけにする（タスクブランチへのマージでは閉じない）。
- PR 96（PBI-88。同じ PR の作成の処理を触る）とぶつかりにくいよう、PR の作成の処理の変更は本文を作る行と記録の項目だけにし、
  仕様書の節は PR 96 が足す節と離れた場所に置き、仕様書の先頭の「関係する ADR」の行は変えずに節の中にリンクを書いた。

## 確かめたこと

- 単体テスト（`apps/daemon/src/pr-template.test.ts`）：見出しの当て方（日本語・英語・太字・よくある英語のテンプレート・Detail）、
  チェックボックスを外す、コメントを残す、コードブロック・コメントの中の見出し、閉じられていないコメント、CRLF、見出しの無い
  テンプレート、長さの上限（footer を残す・閉じる・サロゲートペア）、探す順番（.github → ルート → docs、大文字・小文字）、
  複数のテンプレート、Org（公開・非公開・無い）、対象が `.github` そのもの、403・500・通信の失敗・時間切れ、大きすぎる（中身を
  読まない）・中身の無い応答・空・UTF-8 でない、BOM、GitHub Enterprise Server。
- 結合テスト（`apps/daemon/src/daemon.test.ts` の「PR テンプレート（PBI-87）」）：要求要件・設計・実装の PR の本文がテンプレートに
  沿い、タスクの ID・承認の仕方が残り、記録に使ったテンプレートが残る。無い・使えない・探す処理が例外のときは今の本文で PR を作り、
  理由を伏せて残す。長い本文を省く。エージェントの出力に紛れたトークンを本文に出さない。
- `apps/daemon/src/intake.test.ts`：Issue から作ったタスクで、テンプレートに Issue の見出しがあってもなくても `Closes #7` と
  タスクの ID が残る。
- 修正を戻すと落ちること：チェックを外さない・footer を捨てる・上限なし・伏せない・Org の公開を確かめない・例外で落とす・
  テンプレートを使わない・.github を先にしない・大きさを見ない・閉じないコメント、の10通りをそれぞれ入れると、足したテストが
  それぞれ1〜5件落ちた。
- 実際の GitHub（公開リポジトリ、読み取りだけ）で探せること：テンプレートの無いリポジトリは none、`.github/PULL_REQUEST_TEMPLATE.md`・
  `.github/pull_request_template.md` を置くリポジトリ（4件）は found。見出しの無いテンプレート（コメントだけ）と、
  見出しとチェックリストのあるテンプレートを埋めた結果を目で確かめた（Detail の見出しが「該当なし」になったので、変更に当てるよう
  規則を直した）。
- 画面：一時的な SACTY_HOME と別のポートで起動し（偽の gh・docker。本物の AI・秘密情報は使わない）、テンプレートあり・
  読めない（403）・無い、の3つのタスクの PR の欄に、それぞれ「PR テンプレート … に沿って作成」「sacty の決まった形（PR
  テンプレートを使えなかった）」と理由、「sacty の決まった形（PR テンプレートが無い）」が出ることを確かめた。動作確認の動画は、
  リポジトリには入れない。
- `npm run lint`（終了コード0）・`npm run typecheck`・`npx vitest run`（54ファイル・1268件が通過）・`npm run build`・
  `npx vitest run tests/docs`。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （セルフレビュー）見出しの無いテンプレートでは、目的・変更・テストがすべて折りたたみに入り、読み落としやすい | どの見出しにも入れられなかったときは、折りたたまずに置くようにした |
| （セルフレビュー）よくある英語のテンプレートの「Types of changes」が種類の一覧なのに変更に当たらない・Rails の「Detail」が目的に当たって「該当なし」になる | 書けない見出しの規則を `types? of changes?` に、`detail` を変更の規則に移した |
| PR #99 レビュー（P2）：長い本文を省くとき、テンプレートが無い・使えないと footer が空で、成果物チェックの案内・マージの案内が消える。Issue の見出しが長い概要の後にあると `Closes` も消える | テンプレートを使わない本文も、main・footer・省けない部分（`keep`）に分けた（`buildPullRequestBodyText`・`buildStepPullRequestBodyText`。つなぐと今の本文と同じ）。`keep` はタスクの ID の行・`Closes`（見出しに入れたものも）・マージが承認になる案内で、`limitBody` が省いて消えたら footer の前に出し直す。回帰テスト：`limitBody` の keep、長い概要の後の Issue の見出し、テンプレート無し・例外のときの長い要求要件の実装の PR（案内とタスクの ID が残る）、`keep` の中身。修正を戻す（keep を出し直さない・footer を分けない・見出しの Issue を keep にしない）と、それぞれ1〜2件落ちた |
| PR #99 レビュー（P2）：前の順番で候補が見つかっても、後の順番の `docs/` の一覧を先に取りに行き、その失敗で `unusable` になる | `.github/`・`docs/` の一覧を、その順番になってから読む（読んだら使い回す）ようにした。回帰テスト：ルート・`.github/` に候補があり `docs/` の一覧が 500 のとき、見つかったものを使い `docs/` を読まない。修正を戻すと落ちた |
| PR #99 再レビュー（P2）：省けない部分が残ったかを `head.includes` の部分一致で判定していて、前に `Closes #123` があると、省かれた `Closes #12` を出し直さない | 残ったかの判定を、行として丸ごと（前後が行の境目）・HTML のコメントとコードブロックの外にあるか、に変えた（`hasBlock`・`withoutHidden`）。タスクの ID の行・承認の案内も同じ判定にした。回帰テスト：前に `Closes #123` がある、同じ文字列が行の一部・コメント・コードブロックの中にだけある、ほかのタスクの ID が前にある、行として残っていれば重ねない。部分一致に戻す・コメントとコードブロックを除かない、のどちらでも落ちた |
| PR #96（PBI-88）が main に入った | main を取り込んだ（衝突なし）。結合テストに、テンプレートの本文と一緒に、取り込むラベルが3つの PR に付くこと（`intakeLabel` の記録を含む）を足した |
| main に #95・#98 が入った | main を取り込んだ（衝突なし）。レビュー対応の後に `npm run lint`（終了コード0）・`npm run typecheck`・`npx vitest run`・`npm run build`・`npx vitest run tests/docs` が通ることを確かめた |

## 残したこと

- 見出しの種類の規則に当たらない書き方の見出しは「該当なし」になる（内容は折りたたみに入る）。運用で見つかったら規則を足す。
- GitHub Enterprise Server での Org の `.github` の扱い（内部公開のリポジトリなど）は確かめていない。公開（`private: false`）のものだけを使う。
