<!-- sacty task b7c3f763-57d4-458d-bb8b-b02ea272e681 の設計。sacty が作成しました。 -->

# PBI-442 設計：「あなたの出番」を 2 つの組に分け、4 か所で同じ並びにする

## スコープ

人の出番の判定・組・並びを `packages/core` の 1 か所に置き、ダッシュボード・ベル・一覧のカード・MCP の `list_tasks` を同じ対象・同じ順にする。
承認待ちの PR を AI がレビューしている間は、3 か所の行に「レビュー中」を添える。

- 対象
  - core の判定・組・並び（新しいファイル）と、デーモンの集計・一覧の応答（`listView`）・MCP の `list_tasks`
  - 画面：ダッシュボードの「あなたの出番」、ベル（`NotificationsMenu` の中と `live-header.tsx` の渡し方）、プロジェクトの切り替えの件数、一覧の上のカード（`task-list-data.ts` だけ）
  - 辞書（`dashboard.ts`・`shell.ts`・`labels.ts` の出番の節）、日英の文書、ADR、スクリーンショット
- 対象外
  - `task-list.tsx`・辞書 `tasks.ts`・一覧の表の「状態」の列
  - `statusText`・`personLink`・`prConflictNote`、`statusTone` のほかの分岐を移すこと
  - MCP の結果への「レビュー中」、`wait_for_task` の「人の出番」（完了・中止を含む別の定義）

## 確認したいこと

### must

なし

### should

1. 組の見出しの文は、ja「判断で進むタスク」「再開を待つタスク」、en「Ready for your decision」「Waiting to resume」でよいか。
   推奨：このとおり。状態の名前（承認待ち・エスカレーション・一時停止中）とも、すぐ下の欄「止まっているタスクの理由」とも紛れない。
   懸念：語が意図と違うと、ダッシュボードとベルの文言・辞書のテスト・文書を直し、スクリーンショットも撮り直すことになる。
2. 「レビュー中」の添え方は、状態の文の後ろに ja「・AI のレビュー中」、en「 · AI review in progress」を付ける形でよいか。
   推奨：このとおり。一覧のカードは `status` を文字列でしか描けず、`task-list.tsx` を変えずに 3 か所をそろえられる形はこれだけ。
   懸念：別の印（バッジなど）にしたいと後で分かると、カードのためだけに `task-list.tsx` を触る別の PR が要る。

### 確認しないと決めたこと

- ヘッダーと一覧のカードは、待ち始めを `GET /api/dashboard`（`getDashboardSummary`）で読む。ダッシュボード・MCP と同じ出どころで、完了したタスクや作業履歴を運ばない（受け入れ条件 5 を満たす）。デーモンの集計は畳み込み済みで、新しい経路も要らない。
- ベルから、消したプロジェクトのタスクが消える。受け入れ条件 5 が「ダッシュボードと同じ対象」と定めている。
- MCP では、各タスクに `personTurnGroup`（`decision`｜`paused`）を足し、`order` は `personTurnGroup_waitingSince_asc` にする。依頼が「名前と値は実装で決め、`order` は変えてよい」と定めている。

## 既定で決めたこと

- デーモンの集計の `waitingSince` も core の判定を使い、AI が判断中の承認待ちには入れない（使う側はどこも、そのタスクを出さない）。
- `Notice` の型に `group`・`waitingSince` を足し、`NotificationsMenu` の props を `notices` 1 つにする（組分けを `live-header.tsx` から外す）。
- 一覧の応答には、`view` と同じ形の `aiReview` を対象のタスクにだけ載せる（`reviewing` 以外の値も、詳細と同じに載る）。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/person-turn.ts`（新） | `personTurnGroup(task)`：`decision`（承認待ち〔`pendingReview` のあるものを除く〕とエスカレーション）・`paused`（一時停止）・`undefined` を返す。`isAwaitingAiJudgement` も置く。`personTurnTasks(tasks, { projectIds, waitingSince })`：消したプロジェクトを除き、組 → 待ち始め（無ければ `updatedAt`）→ ID の順に並べ、組と待ち始めを付けて返す |
| `packages/core/src/dashboard.ts` | 待ち始めを返す条件を `personTurnGroup` にする |
| `apps/web/src/lib/labels.ts` | `needsPerson` と `statusTone` の `pendingReview` の分岐を消し、`personTurnGroup` を使う。`personStatusText(task, labels)`（`aiReview.status === "reviewing"` なら添える）を足す |
| `dashboard-data.ts`・`header-data.ts`・`task-list-data.ts` | どれも `personTurnTasks` の順で行を作り、状態の文は `personStatusText` で作る。行に `group` を持つ |
| `apps/daemon/src/task-mcp.ts` | `isPersonTurn`・`awaitingAiJudgement`・自前の並びを消し、core を使う。説明の文 3 か所（ツール・出力の型・`INSTRUCTIONS`）を直し、「ベルは件数が違う」を消す |
| `apps/daemon/src/ai-review-head.ts`・`service.ts` | `aiReviewsOfHeads(tasks, sameRepo, latestHeadOf)` を足し、`listView` で使う |

## 処理の流れ

- 一覧の「レビュー中」：先に、承認待ちで PR が開いているタスクを集め、無ければ何もしない。あれば全タスクを 1 回だけなめ、レビューのタスクを PR の番号ごとに分ける。対象ごとに同じ番号の束だけを渡して `aiReviewOfHead` を呼ぶ（詳細と同じ関数なので、結果も同じになる）。
- ダッシュボード：`ScrollList`（`ul`）の中に、組ごとに `li` を置く。`li` には見出し（`h3`。文と件数）と、その見出しを `aria-labelledby` で指す `ul` を置き、`ul` に行を並べる。上の組は常に先頭なので、スクロールしなくても見出しと先頭の行が見える。0 件の組は `li` ごと出さない。
- ベル：`notices` を組ごとに分け、`Menu.Group`・`Menu.GroupLabel` で出す。待っている時間は `useClock` と `durationText` で、ダッシュボードと同じ書き方で出す。

## 影響範囲

- ADR を足し、`20261016-0151-dashboard-and-project-urls.md`（お知らせを分けない部分）と `20261010-1030-superseded-app-shell-and-current-project.md`（ほかのプロジェクトを先にする部分）を一部置き換える。前者は `git mv` で名前に `superseded-` を付け、そこへのリンクも直す。
- 文書（日英）：`docs/user/dashboard.md`・`docs/user/mcp.md`・`docs/spec/architecture.md`・`docs/spec/mcp-server.md`。辞書 `dashboard.ts` の `attention.hint` にある並びの説明も直す。
- `scripts/docs-screenshots/` の `dashboard`・`task-list` の場面は、一時停止の行が下に移るので撮り直す。
- 辞書 `shell.ts` の `notices.others`・`notices.here` は使わなくなるので消す。

## テスト観点

- [TV-1] core の personTurnGroup が状態ごとに組を返す
  - 入力：承認待ち・承認待ちで pendingReview あり・エスカレーション・理由の違う一時停止（budget・usage_limit・manual）・実行待ち・完了・中止のタスク
  - 期待結果：承認待ちとエスカレーションは decision、一時停止はどの理由でも paused、pendingReview のある承認待ちと残りの状態は undefined を返す。
- [TV-2] core の personTurnTasks が組 → 待ち始め → ID の順に並べる
  - 入力：decision 2 件・paused 2 件で、待ち始めの順・updatedAt の順・作成の順が互いに違い、待ち始めが同じ 2 件と記録の無い 1 件、消したプロジェクトのタスクを含む集まり
  - 期待結果：decision がすべて paused より前に来て、組の中は待ち始め（記録が無いものは updatedAt）の古い順、同じ時刻は ID の順になり、消したプロジェクトのタスクは入らない。
- [TV-3] デーモンの集計の waitingSince が core の判定に従う
  - 入力：待ち始めの記録がある承認待ち・pendingReview のある承認待ち・一時停止・実行待ちのタスク
  - 期待結果：summary の waitingSince に、承認待ちと一時停止の ID だけが入り、pendingReview のある承認待ちと実行待ちの ID は入らない。
- [TV-4] ダッシュボード・ベル・MCP が同じ ID の列を返す
  - 入力：上の組に複数・下の組に複数（待ち始め・updatedAt・作成の順が互いに違う）に、AI が判断中の承認待ち・消したプロジェクトのタスク・終わったタスクを混ぜた 1 つのタスクの集まり
  - 期待結果：attentionRows の ID の列、loadHeaderData の notices の ID の列、list_tasks（needs_person: true）の tasks の ID の列が、テストに書いた同じ期待の列と一致する。
- [TV-5] core の並びを戻すとそろいのテストが落ちる
  - 入力：personTurnTasks の比べ方を組を見ない待ち始めの順に戻した実装
  - 期待結果：そろいのテストと core の並びのテストが失敗する。
- [TV-6] ベルの件数と対応待ち n が同じ判定で数える
  - 入力：プロジェクト A に承認待ち 1 件・AI が判断中の承認待ち 1 件・一時停止 1 件、消したプロジェクトに承認待ち 1 件
  - 期待結果：loadHeaderData の notices は 2 件、プロジェクト A の needsYou は 2 で、AI が判断中の承認待ちと消したプロジェクトのタスクは数えない。
- [TV-7] ダッシュボードの欄が組ごとに見出しと件数を出す
  - 入力：decision 2 件・paused 3 件の DashboardData を渡した AttentionCard
  - 期待結果：欄の見出しの件数は 5 件のまま出し、その下に「判断で進むタスク」と 2 件、その行、次に「再開を待つタスク」と 3 件、その行の順に出て、各組の ul は見出しの h3 を aria-labelledby で指す。
- [TV-8] 片方の組だけのとき、0 件の組の見出しを出さない
  - 入力：decision 1 件だけの場合と、paused 1 件だけの場合の AttentionCard
  - 期待結果：それぞれ、ある組の見出しと 1 行だけが出て、もう片方の組の見出しは出ない。
- [TV-9] 0 件のとき、欄とベルが空の文を出す
  - 入力：人の出番のタスクが 0 件（AI が判断中の承認待ちだけはある）
  - 期待結果：ダッシュボードの欄は「対応待ちはありません。」だけを出して組の見出しを出さず、ベルは件数を出さずに t.none の文を出す。
- [TV-10] 下の組が多くても上の組がスクロールせずに見える
  - 入力：decision 2 件・paused 8 件の AttentionCard を、幅 1440px と 375px でブラウザに描き、欄をスクロールしない
  - 期待結果：どちらの幅でも、上の組の見出しと先頭の行の getBoundingClientRect が、欄（attention-list）の見えている範囲の中に収まる。
- [TV-11] 見出しの文が状態の名前と紛れない
  - 入力：日本語と英語の辞書の、ダッシュボードとベルの組の見出しの文
  - 期待結果：両方の辞書に 2 つの見出しがあり、どれも状態の名前（承認待ち・エスカレーション・一時停止中・Awaiting approval・Escalated・Paused）と同じでなく、それを含まず、辞書の文言の規則のテストを通る。
- [TV-12] ベルが種類の組で並び、待っている時間を出す
  - 入力：decision 2 件・paused 2 件の notices を、「すべてのプロジェクト」の画面とプロジェクトを選んだ画面の両方で開いたベル
  - 期待結果：どちらの画面でも、組のラベル「判断で進むタスク」「再開を待つタスク」の下に同じ順で行が出て、各行に画面の時計で計算した待っている時間が出て、「ほかのプロジェクト」「このプロジェクト」のラベルは出ない。
- [TV-13] 一覧のカードが同じ対象・同じ順で、見出しを出さない
  - 入力：プロジェクトに decision 2 件・paused 2 件・AI が判断中の承認待ち 1 件があり、デーモンの返す順が並びと違う
  - 期待結果：loadTaskList の needsYou は、AI が判断中のものを除いた 4 件を、decision → paused、それぞれ待ち始めの古い順で返し、組の見出しの欄を持たない。
- [TV-14] 一覧の応答の aiReview が詳細と同じで、対象にだけ付く
  - 入力：承認待ちで PR が開いているタスク（レビュー中・付いた・head 不明）、PR が閉じた承認待ち、一時停止、同じ PR を指すレビューのタスクを持つサービス
  - 期待結果：listView の aiReview は、PR が開いた承認待ちのタスクだけにあり、各値が view(id) の aiReview と同じで、ほかのタスクには aiReview が無い。
- [TV-15] 「レビュー中」を reviewing のときだけ添え、並びを変えない
  - 入力：aiReview の status が reviewing・none・unknown・attached の承認待ちのタスクを含む集まり
  - 期待結果：ダッシュボードの行・ベルの行・一覧のカードの状態の文は、reviewing のときだけ ja「・AI のレビュー中」・en「 · AI review in progress」が後ろに付き、どの行も組と順は添えない場合と同じになる。
- [TV-16] 一覧の表の状態の列は「レビュー中」を添えない
  - 入力：aiReview の status が reviewing の承認待ちのタスクを持つ loadTaskList
  - 期待結果：rows のそのタスクの状態の文は statusText のままで、「AI のレビュー中」を含まない。
- [TV-17] MCP の needs_person が新しい order と組の値を返す
  - 入力：decision 2 件・paused 2 件があるときの list_tasks（needs_person: true）と、ツールの説明・TaskListSchema・INSTRUCTIONS の文
  - 期待結果：order は personTurnGroup_waitingSince_asc、各タスクに personTurnGroup（decision か paused）が入り、3 つの説明の文に欄の名前と値と並びがあり、「ベルは件数が違う」の文が無い。
- [TV-18] MCP の offset・limit で組の境目をまたいでも重なりも抜けも無い
  - 入力：decision 3 件・paused 3 件で、limit 2 で offset 0・2・4 と続けて呼ぶ
  - 期待結果：3 回の結果の ID をつなぐと、1 回で全部取った列と同じ 6 件になり、total と excludedAiJudging はどの回も同じで、waitingSince と waitingSinceSource は今と同じ値になる。
- [TV-19] MCP の needs_person でない呼び出しは変わらない
  - 入力：needs_person を付けない list_tasks
  - 期待結果：order は createdAt_desc で、各タスクに personTurnGroup・waitingSince が入らず、並びは今と同じ新しい順になる。
- [TV-20] 利用者向けの文書が新しい並びを書いている
  - 入力：docs/user/dashboard.md・docs/user/mcp.md と英語の版、images/dashboard.png
  - 期待結果：dashboard.md に上の組（承認待ち・エスカレーション）と下の組（一時停止）の見出し・並び・「レビュー中」が、mcp.md に needs_person の並びと personTurnGroup が書いてあり、画像は組に分かれた欄で撮り直してある。
- [TV-21] 仕様書が新しい判定・並び・経路を書いている
  - 入力：docs/spec/architecture.md・docs/spec/mcp-server.md と英語の版
  - 期待結果：architecture.md のあなたの出番・お知らせの表・待ち始めを返す条件が組と並びと core の判定を、mcp-server.md の order・人の出番の節が新しい値を書き、「画面と違うところ」から写しの記述と「ベルは件数が違う」が消えている。
- [TV-22] ADR がベルの組分けをやめる決定と理由を書いている
  - 入力：新しい ADR と、20261016-0151 と 20261010-1030 の ADR
  - 期待結果：新しい ADR に、ベルのプロジェクトの組分けをやめて対象をダッシュボードにそろえる決定と理由と置き換え元があり、古い 2 つの置き換え先に置き換えた部分が 1 行で書かれ、20261016-0151 のファイル名に superseded が付いている。
