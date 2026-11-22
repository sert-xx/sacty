<!-- sacty task efd55ea1-1ed3-4eb3-8a97-5060c545c21a の設計。sacty が作成しました。 -->

# 設計：notFound() のページのタブの題と、デーモンに届かないときの知らせの文言（PBI-477）

## スコープ

`notFound()` を呼ぶ 8 ページに `generateMetadata` を置き、無いときに「ページが見つかりません - Sacty」を返す。
文言の検査を文とラベルに分けて括弧の基準を厳しくし、外れる文言（`live.stale` ほか 7 件ほど）を直す。

- 対象
  - 8 ページの `generateMetadata`、共通の題の関数、`not-found.tsx`
  - 8 ページを `notFound()` の道で描くテスト
  - `wording-policy.test.ts` と、外れる辞書の文（日英。引数を取る文言を含む）
  - 仕様書（`architecture`・`ui-wording`）とユーザー文書（`tasks`）の日英、作業履歴、ADR
- 対象外
  - 対象のページのうち、データがあるときの題（今のまま。設定のページは「プロジェクト「<名前>」の設定」、ほかは「Sacty」）
  - デーモンに届かないときの題（今のまま「Sacty」）

## 確認したいこと

### must

なし

### should

- 題を、ページの描画とは別に `generateMetadata` で決めてよいか。
  推奨：よい。`notFound()` は今の場所（`<Suspense>` の中）のまま呼ぶので、応答コードが変わらない（R-7）。
  懸念：実ブラウザーでストリーミングした題が付くかは、テストでは見えません。人の確かめで「Sacty」のままなら、直し方を選び直す作業が実装の後に要ります。

## 既定で決めたこと

- 存在の判定は、ページの部品と `generateMetadata` が、React の `cache` で包んだ同じ読み込みの関数を使う。デーモンへの問い合わせは 1 回のままにする。
- 共通の関数は `apps/web/src/lib/not-found-metadata.ts` の `notFoundMetadata()` にし、`not-found.tsx` もこれを使う。
- 括弧の例外は、新しい一覧 `PAREN_EXCEPTIONS` に分ける。今の `EXCEPTIONS` は改行・長さの例外だけに使う。
- `live.stale`：日「デーモンに届かないため、最後に取得した内容を表示しています。`sacty up` が動いているか確認してください。」、英 "The daemon cannot be reached, so the last fetched data is shown. Check that `sacty up` is running."

## 構成

| ファイル | 変更 |
| --- | --- |
| `apps/web/src/lib/not-found-metadata.ts`（新規） | `notFoundMetadata()`：画面の言語で `{ title: "<common.notFound.title> - Sacty" }` を返す |
| `apps/web/src/app/not-found.tsx` | `generateMetadata` が `notFoundMetadata()` を返す（題は今のまま） |
| 8 ページの `page.tsx` | 読み込みを `cache` で包んだ関数にし、`generateMetadata` を足す（設定のページは、無いときの戻り値だけ変える） |
| `apps/web/src/app/not-found-pages.test.ts`（新規） | 8 ページを表で並べ、`notFound()` の道と題・本文・リンクを日英で確かめる |
| `apps/web/src/i18n/wording-policy.test.ts` | 文の判定、認める括弧の中身、`PAREN_EXCEPTIONS`、判定の関数への固定の入力のテスト |
| `apps/web/src/i18n/messages/*.ts` | 検査で落ちる文と、引数を取る文言の文の括弧を直す |

## 処理の流れ

- `generateMetadata`：ページの部品と同じ条件（例：スケジュールタスクの詳細は「プロジェクトが無い・スケジュールタスクが無い・別のプロジェクトのもの」）で無いと判定したら `notFoundMetadata()`、あれば `{}` を返す。
- 文言の検査（日英の同じキーを組にして判定する）
  - 片方でも文なら、両方の括弧の中身を R-1 の形（数字と単位・助数詞、`PR`・`PBI`・`Issue` を前に付けうる ID、形式名の一覧 `FORMAT_NAMES`）で確かめる。
  - 文でないもの（ラベル）は、今の長さの基準（日 14 字・英 30 字以上で失敗）で確かめる。
  - `PAREN_EXCEPTIONS` のキーだけ、両方の確かめを外す。`EXCEPTIONS` のキーも括弧は確かめる。
  - 判定を関数にし、辞書の全体と、テストの固定の入力の両方に当てる。

## エラー時の振る舞い

- `generateMetadata` で `DaemonUnavailableError` ほかの例外が起きたら、`{}` を返す（題は「Sacty」。描画のエラーの表示はページの部品が今のまま出す）。

## 影響範囲

- 文書（R-3〜R-5・R-12）
  - `architecture`：無いページの題を、各ページの `generateMetadata` が付けることを書く。
  - `ui-wording`：「本文の規則」と「辞書と検査」の括弧の記述を、文とラベルの別・認める中身・`PAREN_EXCEPTIONS` に直す。
  - `docs/user/tasks`：知らせの記述を新しい `live.stale` に合わせる（日本語版も括弧を外す）。
  - 作業履歴と ADR を 1 件ずつ足す。ADR は `20261016-1244-ui-wording-body-and-hints` を置き換えない。

## テスト観点

- [TV-1] 8 ページの notFound() の道で、題・本文・リンクが日英で無いページのものになる
  - 入力：8 ページそれぞれで、読み込み（getTask・loadTaskDetail・loadRunLog・loadTaskList・getProject・listProjects と listSchedules・getSchedule・getProjectAudits）を無い結果に mock し、画面の言語を ja・en にして、ページの部品を描き、ページの generateMetadata を呼び、not-found.tsx を描く。
  - 期待結果：ページの部品の描画が notFound() で止まり、generateMetadata が ja で { title: "ページが見つかりません - Sacty" }・en で { title: "Page not found - Sacty" } を返し、not-found.tsx が h1「ページが見つかりません」（en "Page not found"）と /dashboard へのリンクを出し、ページの generateMetadata を外すとテストが落ちる。
- [TV-2] スケジュールタスクの詳細は、別のプロジェクトのスケジュールタスクでも無いページの題になる
  - 入力：projects/[id]/schedules/[scheduleId] で、プロジェクトとスケジュールタスクはあるが、スケジュールタスクの projectId が URL のプロジェクトと違う。
  - 期待結果：ページの部品の描画が notFound() で止まり、generateMetadata が { title: "ページが見つかりません - Sacty" } を返す。
- [TV-3] データがあるときと、デーモンに届かないときの題は変わらない
  - 入力：8 ページそれぞれで、読み込みが見つかった結果を返すときと、DaemonUnavailableError を投げるときに generateMetadata を呼ぶ。
  - 期待結果：設定のページは見つかったときに projects.settingsTitle(名前) を返し、ほかの 7 ページは見つかったときに {} を返し、8 ページとも DaemonUnavailableError のときに例外を投げずに {} を返す。
- [TV-4] 無い URL の題は日英で今のまま
  - 入力：画面の言語を ja・en にして、not-found.tsx の generateMetadata を呼ぶ。
  - 期待結果：ja で { title: "ページが見つかりません - Sacty" }、en で { title: "Page not found - Sacty" } を返す。
- [TV-5] 今の辞書の全体が、文の括弧・ラベルの括弧・改行・長さの検査を通る
  - 入力：直した後の辞書（ja・en）に wording-policy.test.ts の検査を当てる。
  - 期待結果：文の括弧、PAREN_EXCEPTIONS 以外のラベルの括弧（日 14 字・英 30 字以上で失敗）、本文の改行と長さ（日 60 字・英 130 字）、補足の検査がすべて通る。
- [TV-6] 直す前の live.stale は文の括弧の検査で落ちる
  - 入力：検査の関数に、ja「デーモンに届きません。`sacty up` が動いているか確認してください（表示は最後に取得した内容）。」と en "The daemon cannot be reached. Check that `sacty up` is running (showing the last data)." の組を渡す。
  - 期待結果：文の括弧の違反として、そのキーが返る。
- [TV-7] EXCEPTIONS のキーの文と「？」で終わる文の注釈の括弧書きは落ちる
  - 入力：検査の関数に、EXCEPTIONS にあるキー（common.daemon.unreachable など）で注釈の括弧書きを足した文の組と、「…しますか（あとで変えられる）？」の形で終わる文の組を渡す。
  - 期待結果：どちらも文の括弧の違反として返る。
- [TV-8] 認める括弧の中身だけを通す
  - 入力：検査の関数に、括弧の中が「3 件」「PR #12」「PBI-477」「`JSONL`」の文と、「補足・差し替え」「表示は最後に取得した内容」の文を渡す。
  - 期待結果：前の 4 つは通り、後の 2 つは文の括弧の違反として返る。
- [TV-9] 語の中の "."・e.g.・括弧の中だけの「。」は文と数えない
  - 入力：検査の関数に、ja「既定のイメージ（Node.js・Claude Code・Codex）」と en "Default image (Node.js, Claude Code, Codex)" の組、en に e.g. を含む review.causeBaseChanged の組、括弧の中にだけ「。」がある組を渡す。
  - 期待結果：3 つともラベルとして扱われ、文の括弧の違反にならず、ラベルの長さの基準だけが当たる。
- [TV-10] 日英の片方だけが文のキーは、両方を文として確かめる
  - 入力：検査の関数に、ja は「。」を持たないラベルで括弧に注釈があり、en は ". " を持つ文の組を渡す。
  - 期待結果：ja の括弧も文の括弧の違反として返る。
- [TV-11] 括弧の例外は PAREN_EXCEPTIONS だけが外し、ラベルの長い括弧は落ちる
  - 入力：検査の関数に、PAREN_EXCEPTIONS にあるキーで注釈の括弧を持つ文の組と、どの一覧にも無いラベルで日 14 字の括弧を持つ組を渡す。
  - 期待結果：前の組は違反にならず、後の組はラベルの括弧の違反として返る。
- [TV-12] PAREN_EXCEPTIONS に、今の例外の一覧の括弧を理由にするキーが移っている
  - 入力：wording-policy.test.ts の差分を読む。
  - 期待結果：今の EXCEPTIONS のうち理由に括弧を挙げるキー（runLog.roles.* の 3 件・projects.editor.excluded・task.images.defaultDescription・projects.editor.githubForContext・githubForShared・sharedRepo・settings.notifyApi・runLog.clipped）が、括弧の要る理由を添えて PAREN_EXCEPTIONS にあり EXCEPTIONS に無く、PAREN_EXCEPTIONS のキーが実在することをテストが確かめている。
- [TV-13] live.stale が括弧の無い 2 文で、意味を保つ
  - 入力：common.ts の live.stale（ja・en）を読む。
  - 期待結果：ja「デーモンに届かないため、最後に取得した内容を表示しています。`sacty up` が動いているか確認してください。」、en "The daemon cannot be reached, so the last fetched data is shown. Check that `sacty up` is running." である。
- [TV-14] 引数を取る文言の文に、認めない括弧が無い
  - 入力：辞書の関数の文言（ja・en）の差分を読む。
  - 期待結果：文に当たる関数の文言の括弧が、数字と単位・ID・FORMAT_NAMES の語・値そのものの引数 1 つ（`（${command}）` など）だけで、`（${reason}）` のような理由の引数の括弧が無い。
- [TV-15] 仕様書の無いページと括弧の記述が、直した後の振る舞いと一致する
  - 入力：docs/spec/architecture.md・ui-wording.md と英語版の差分を読む。
  - 期待結果：architecture に notFound() を呼ぶページの題を各ページの generateMetadata が付けることが、ui-wording の「本文の規則」と「辞書と検査」に文とラベルの別・認める括弧の中身・ラベルの長さの基準・PAREN_EXCEPTIONS が、日英で同じ内容で書かれている。
- [TV-16] ユーザー文書のデーモンに届かないときの記述が新しい知らせと一致する
  - 入力：docs/user/tasks.md・tasks.en.md の差分を読む。
  - 期待結果：届かないこと・最後に取得した内容を表示していること・`sacty up` を確かめることが、括弧を使わずに日英で書かれている。
- [TV-17] 作業履歴と ADR に要求の事柄が書かれている
  - 入力：docs/worklog/ と docs/adr/ に足したファイルを読み、npx vitest run tests/docs を流す。
  - 期待結果：作業履歴に直した文の件数（引数を取る文言を含む）・残した形・PAREN_EXCEPTIONS に移したキーの件数があり、ADR に文とラベルで括弧の基準を分けた理由と 20261016-1244-ui-wording-body-and-hints を置き換えない理由があり、tests/docs が通る。
- [TV-18] リポジトリの検証がすべて通る
  - 入力：npm run format・npm run lint・npm run typecheck・npm test・npm run build を流す。
  - 期待結果：すべて終了コード 0 で終わる。
