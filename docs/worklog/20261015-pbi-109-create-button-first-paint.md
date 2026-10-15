# タスクの一覧の「タスクを作成」ボタンを、候補の取得を待たずに最初から出す

- 日付: 2026-10-15（UTC）
- タスク: PBI-109
- PR: #118
- ブランチ: feat/issue-109-create-button-first-paint
- 関係する ADR: なし

## 目的

タスクの一覧で、「タスクを作成」ボタンが画面を開いてから数秒たって出るのを直す。あわせて、画面の自動の更新のたびに
リポジトリの候補を GitHub に問い合わせないようにする（PBI-108 で常に3秒ごとに更新するため）。

## 原因

- ボタンを出す部品（`apps/web/src/app/page.tsx` の `NewTask`）が、対象リポジトリの候補（デーモンの
  `GET /api/projects/:id/repositories`。Org の対象は gh で GitHub に問い合わせる）の取得を待ってから描いていた。
- 待っている間の表示（Suspense の fallback）が `null` だったので、取得が終わるまでボタンが出なかった。
- 描画のたびに候補を読むので、画面の自動の更新（`router.refresh`）のたびに GitHub に問い合わせ直していた。

## したこと

- `apps/web/src/components/new-task.tsx`（`NewTask`・`NewTaskPlaceholder`）：ボタンは、表示しているプロジェクトだけを読んで
  出す（候補は読まない）。プロジェクトを読むまでは、同じ大きさの押せないボタンを fallback に出す（位置をずらさない）。
  Next.js の page からは決まった名前しかエクスポートできないので、`page.tsx` から移した。
- `apps/web/src/app/projects/[id]/repositories/route.ts`：候補を返す画面のルート。読めなかった Org の理由と失敗の理由は、画面の
  言語の文言にして返す。サーバーアクションにしなかったのは、サーバーアクションは順に1つずつ実行されるので、候補の取得の途中に
  「作成する」を押すと、作成が取得の終わりまで待たされるため。
- `apps/web/src/lib/repository-candidates.ts`（`fetchRepositoryCandidates`・`candidatesLoader`）：ダイアログを開くたびに候補を読み、
  前に開いたときの遅れて届いた結果は捨てる。対象の無いプロジェクトでは読まない。失敗しても投げずに理由を返す。
- `apps/web/src/components/new-task-dialog.tsx`：候補を props で受け取らず、開いたときに読む。読んでいる途中・読めなかった・
  候補が無いことをダイアログの中に出す（どの状態でも、リポジトリを入力して作れる）。読めなかった Org の理由は、これまでどおり
  上に出す。候補が1つのときの自動の入力は、入力欄の `defaultValue` で行う（入力していなければ、届いたときに入る）。
- 文言（`forms.task.repositoriesLoading`・`repositoriesFailed`・`repositoriesEmpty`・`repositoriesNoAnswer`。ja・en）を足した。
- 仕様書 `docs/spec/tasks-and-steps.md`、ユーザードキュメント `docs/user/tasks.md`（英語の版も）を直した。

## ボタンを待たせていたほかの取得（受け入れ条件4）

| 取得 | 結果 |
| --- | --- |
| 対象リポジトリの候補 | 描画では読まない（ダイアログを開いたとき） |
| 表示しているプロジェクト（`listProjects`） | 読むまで同じ大きさの押せないボタンを出す |
| プロジェクトの名前（`ProjectName`） | もとから同じ高さの空の行を fallback に出している（変えていない） |
| 工程を実行する AI の設定・人間の判断が要るタスク | ボタンより下に出る。ボタンの位置には関係しない（変えていない） |

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（70 ファイル・1535 件）・`npm run build`・
  `npx vitest run tests/docs`（89 件）が通った。
- 回帰テスト：`apps/web/src/app/page.test.ts`（4 件）・`apps/web/src/components/new-task-dialog.test.ts`（3 件）・
  `apps/web/src/lib/repository-candidates.test.ts`（5 件）・`apps/web/src/app/projects/[id]/repositories/route.test.ts`（3 件）。
- 修正を戻すと落ちることを確かめた。描画で候補を読むように戻すと 2 件、fallback を `null` に戻すと 1 件、遅れて届いた結果を
  捨てないようにすると 2 件が落ちた。
- 自分のブランチを別のポート（4931・4941）と一時的な SACTY_HOME で起動し、偽の gh（`auth token` で 4 秒待ってから失敗する）で
  Org の候補の取得を遅くして、Playwright で確かめた。
  - ボタンは開いてから約 0.2 秒で出て、押せた。読み込みの前後でボタンの位置と大きさは同じだった。
  - `router.refresh` を 3 回しても、画面のルートへの候補の取得は 0 回。画面の読み直しを 3 回しても、画面のルートへの取得と
    gh の呼び出しは 0 回。ダイアログを開くたびに 1 回。
  - 取得の途中に入力した題・リポジトリは、候補が届いた後も残った。候補が1つのプロジェクトでは、届いた後に入力欄に入り、
    先に入力していれば上書きしなかった。
  - 候補の取得が失敗したとき（届かない・503）は、理由をダイアログに出し、「作成する」は押せた。
- 動作確認の動画を撮った（一覧を開いた瞬間からボタンが出る → ダイアログを開くと候補が出る → Org の対象で取得が遅いときの表示）。

## 直さなかったこと

- デーモンにつながらないときは、押せないボタンが一瞬出た後に消える（最後にボタンを出さないのは今と同じ）。
- 候補が届いて読めなかった Org の理由が出ると、ダイアログの中の入力欄が下に動く（一覧のボタンの位置は動かない）。
- 候補は期限つきで持たず、ダイアログを開くたびに読み直す（開いたときの最新の候補を出すため）。
