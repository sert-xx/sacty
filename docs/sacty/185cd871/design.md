<!-- sacty task 185cd871-dfde-4ab3-aca7-58e619e54980 の設計。sacty が作成しました。 -->

# 設計：設定の呼び分け・「Sacty の設定」の入口・保存していない変更の表示と確認

## スコープ

サイドメニューの名称を「プロジェクトの設定」「プロジェクト」に変え、「Sacty の設定」の項目を下の端に足します。
2 つの設定の画面に、次の 3 つを足します。
- 保存していない変更の表示
- 画面の下に見える「保存する」
- 離れるときの確認

- 対象
  - サイドメニュー（`shell/rail.tsx`）の項目・名称・強調と、狭い幅の下の横並びでの名称の収め方
  - プロジェクトの設定の見出しとブラウザーのタイトル
  - `SettingsForm` と `ProjectEditor`（`project` があるときだけ）の変更の判定・表示・下に固定する「保存する」・離れるときの確認
  - テスト、`docs/user`（`getting-started`・`project-settings`・`config` の日英）、`docs/spec/architecture.md`（日英）のサイドメニューの表、作業履歴、ADR、スクリーンショットの撮り直し
- 対象外
  - ブラウザーの戻る・進むでの確認（「確認したいこと」の 2）
  - プロジェクトの作成のフォーム（`/projects` と最初の作成の画面）の表示と確認
  - 人のアイコンのメニューの「Sacty の設定」（変えずに残す）

## 確認したいこと

### must

なし

### should

1. 640px 未満で「プロジェクトの設定」を「プロジェクト」と「設定」の 2 行に折ってよいか。幅 320px で収まらなければ、狭い幅だけ項目の間と左右の余白を詰めてよいか。
   - 推奨：はい。辞書のキーを増やさずに、どの幅でも同じ語を出せます。
   - 懸念：幅 320px では、1 項目の名称に使える幅が約 55px です。「プロジェクト」は 10px の文字で約 60px なので、収まるかはぎりぎりです。詰めても収まらなければ、狭い幅だけの短い語（キーが 1 つ増えます）に変えるので、文言をレビューし直す手間が出ます。
2. ブラウザーの戻る・進むは、確認の対象にしなくてよいか。
   - 推奨：対象にしない。受け入れ条件 6 に無いからです。また、App Router の戻る・進む（popstate）は、`onNavigate` でも `beforeunload` でも止められず、止めるには履歴を書き換える独自の仕組みが要ります。
   - 懸念：スマートフォンで戻るの操作をした利用者は、確認なしに編集中の値を失います。

### 確認しないと決めたこと

- プロジェクトの作成のフォーム：表示と確認の対象にしない。受け入れ条件 5・6 が挙げるのは、2 つの設定の画面だけだからです。
- パンくず（`/projects`）：サイドメニューと同じ確認を付ける。画面を移るリンクで、付けても困る人がいないからです。
- エクスポートのリンク（`download`）：確認しない。画面を離れず、入力を失わないからです。
- 照合に失敗した後の「再読み込み」：ブラウザーの確認を出す。押すと保存していない入力を失うので、6 の「リロード」に当たるからです。併合して保存した後は変更が無いので、確認は出ません。
- 英語の見出し：`Project "<name>" settings` にする。受け入れ条件 3 の「製品名と取り違えない形」を満たし、日本語の「」と対応するからです。
- ブラウザーのタイトル：見出しと同じ文言だけにし、製品名は付けない。受け入れ条件 3 が「同じ文言」と定めているからです。

## 既定で決めたこと

- 変更の判定：送る値の写し（JSON）を、基準の写しと比べる。元の値に戻せば、変更が無い扱いになります（PR に書く）。
- アイコン：「Sacty の設定」は lucide の `SettingsIcon`（歯車）。「プロジェクトの設定」は今の `SlidersHorizontalIcon` のままです。
- 確認の方式：画面の中の移動は `window.confirm`、閉じる・リロード・`<a>` の移動は `beforeunload` で確かめる。画面の確認のダイアログは作りません。
- 下に固定する「保存する」は左寄せにする。狭い幅で、右下の質問の丸いボタンと重ならないようにします。
- スクリーンショット：サイドメニューが写るので、`npm run docs:screenshots` で全部の画像を撮り直す。

## 構成

| 置き場所 | 中身 |
| --- | --- |
| `lib/unsaved-changes.tsx`（新） | `UnsavedChangesProvider`：変更のある画面の有無を持つ。`useUnsavedChanges(dirty)`：フォームが登録し、`beforeunload` を付け外しする。`useLeaveGuard()`：Link の `onNavigate` に渡す。変更があれば `confirm` を出し、断られたら `preventDefault` する |
| `app/layout.tsx` | body の中身を `UnsavedChangesProvider` で包む |
| `shell/rail.tsx`・`shell/header.tsx`・プロジェクトの設定のパンくず | Link に `useLeaveGuard()` を付ける。ヘッダーのメニュー（Base UI の `Menu.LinkItem`）は `<a>` なので、`beforeunload` で確かめる |
| `components/save-bar.tsx`（新） | 「保存する」と状態の文（保存していない変更・保存しました・エラー）を並べる。`sticky bottom-0` にし、640px 未満では `bottom-[calc(3.5rem+env(safe-area-inset-bottom))]` にする |
| `rail.tsx` の項目 | すべてのプロジェクトの画面：「プロジェクト」（`/projects`）と「Sacty の設定」。プロジェクトの画面：今の 4 項目と「Sacty の設定」。`SACTY_SETTINGS.active` は `/settings` のときだけ真にする。`paths.ts` に `SETTINGS_PATH` を足す |
| `app/projects/[id]/settings/page.tsx` | `generateMetadata` で、`settingsTitle(name)` をタイトルにする。プロジェクトを取れなければ、既定の「Sacty」にする |

## データ

- 辞書の変更（日英）
  - `shell.nav.settings` を「プロジェクトの\u200b設定」／"Project settings" に変える。
  - `shell.nav.projects`（「プロジェクト」／"Projects"）と `shell.nav.sactySettings`（「Sacty の\u200b設定」／"Sacty settings"）を足す。
  - `shell.unsaved`（「保存していない変更があります」／"You have unsaved changes"）と `shell.leaveConfirm`（離れると失われる旨の問い）を足す。
  - `projects.settingsTitle` を「プロジェクト「<名前>」の設定」／`Project "<name>" settings` に変える。
- 基準の写し：最初に描いたときの値にする。
  - 保存に成功した（`state.saved`。併合を含む）ときは、送った時点の写しに置き換える。
  - 写しにするのは、`ProjectEditor` では送る `definition`、`SettingsForm` では送る欄の値。

## 処理の流れ

1. フォームが写しを比べ、`dirty` を `useUnsavedChanges` に渡す。`dirty` のあいだは、`SaveBar` に「保存していない変更があります」を出す。
2. 移る・閉じる・リロードのときに `dirty` なら、確かめる。断れば、今の画面に残る。
3. 保存に成功すると、基準が送った写しになり、`dirty` が解ける。失敗したときは、基準も入力も変えない。

## エラー時の振る舞い

- 保存に失敗（`message`・`conflict`）したとき：入力と「保存していない変更があります」を残し、離れるときの確認も出したままにする。

## 影響範囲

- 押した時点で効くので対象にしない項目（PR に書く）：デスクトップ通知の On・Off、テストの通知、秘密情報の取り出し直し、保存した設定でのプレビュー、GitHub アカウントの再読み込み、プロジェクトの削除、エクスポート。
- `rail.browser.test.ts`：仮の辞書と「1 項目だけ」のテストを直す。並行して進んでいる時間切れの修正が main に入っていれば、取り込んでから直す。

## テスト観点

- [TV-1] プロジェクトの画面のサイドメニューの項目と名称
  - 入力：日本語と英語の画面で /projects/p1/tasks を開いて RailNav を描く
  - 期待結果：「タスク・スケジュール・監査・プロジェクトの設定・Sacty の設定」（英語は Tasks・Schedules・Audit・Project settings・Sacty settings）がこの順に並び、最後の項目の行き先が /settings である
- [TV-2] すべてのプロジェクトの画面のサイドメニューの項目と名称
  - 入力：日本語と英語の画面で /dashboard を開いて RailNav を描く
  - 期待結果：「プロジェクト」（/projects。英語は Projects）と「Sacty の設定」（/settings。英語は Sacty settings）の 2 項目だけが出る
- [TV-3] /settings での強調
  - 入力：pathname を /settings にして RailNav を描く
  - 期待結果：「Sacty の設定」だけが aria-current="page" で、「プロジェクト」は aria-current を持たない
- [TV-4] プロジェクトの設定での強調
  - 入力：pathname を /projects/p1/settings にして RailNav を描く
  - 期待結果：「プロジェクトの設定」だけが aria-current="page" で、「Sacty の設定」は aria-current を持たない
- [TV-5] 人のアイコンのメニューの「Sacty の設定」
  - 入力：UserMenu を開く
  - 期待結果：/settings へのリンク「Sacty の設定」が残っている
- [TV-6] プロジェクトの設定の見出しとブラウザーのタイトル
  - 入力：名前が「Sacty」のプロジェクトの /projects/<ID>/settings を日本語と英語で開く
  - 期待結果：h1 と document.title がどちらも「プロジェクト「Sacty」の設定」（英語は Project "Sacty" settings）になる
- [TV-7] 狭い幅の下の横並びで 5 項目が押せて収まる
  - 入力：幅 320px と 375px で、日本語と英語のそれぞれで、プロジェクトの画面のサイドメニューを実際のブラウザーで描く
  - 期待結果：nav が画面の下に固定した横並びのままで、5 項目のどれも 44px 四方以上、名称の矩形が隣の項目の矩形と重ならず、nav の scrollWidth が clientWidth を超えない
- [TV-8] 変更したときの表示
  - 入力：SettingsForm と ProjectEditor（project あり）で、それぞれ 1 つの欄の値を変える
  - 期待結果：「保存する」と同じ下の帯に「保存していない変更があります」が出る
- [TV-9] 元の値に戻したときの表示
  - 入力：欄の値を変えてから元の値に戻す
  - 期待結果：「保存していない変更があります」が消え、離れるときの確認も出ない
- [TV-10] 「保存する」が下に見え、下のメニューに隠れない
  - 入力：幅 375px と 1280px で、2 つの設定の画面を最上部に置いた状態で実際のブラウザーで描く
  - 期待結果：「保存する」の下端がビューポートの中にあり、375px では「保存する」の矩形がサイドメニューの nav の矩形と重ならない
- [TV-11] 変更があるときにサイドメニュー・ヘッダーのリンクで確かめる
  - 入力：欄を変えた状態で、サイドメニューの項目・ヘッダーのロゴ・パンくずを押し、確認を断る
  - 期待結果：window.confirm が呼ばれ、router の移動が起きず、入力が残る
- [TV-12] 変更があるときに閉じる・リロードで確かめる
  - 入力：欄を変えた状態で beforeunload を発火させる
  - 期待結果：イベントの defaultPrevented が真になる
- [TV-13] 変更が無いときは確かめない
  - 入力：欄を変えずに、サイドメニューのリンクを押し、beforeunload を発火させる
  - 期待結果：window.confirm が呼ばれずに移動し、beforeunload の defaultPrevented が偽である
- [TV-14] 保存に成功したら表示と確認が消える
  - 入力：欄を変えて保存し、保存の action が saved（ProjectEditor は merged の場合も）を返す
  - 期待結果：「保存していない変更があります」が消え、リンクを押しても window.confirm が呼ばれず、beforeunload の defaultPrevented が偽である
- [TV-15] 保存に失敗したら入力と表示が残る
  - 入力：欄を変えて保存し、action が message を返す（ProjectEditor は conflict の場合も）
  - 期待結果：入力した値が残り、「保存していない変更があります」が出たままで、beforeunload の defaultPrevented が真である
- [TV-16] 押した時点で効く項目は対象にしない
  - 入力：Sacty の設定でデスクトップ通知の On・Off だけを切り替える
  - 期待結果：「保存していない変更があります」が出ず、beforeunload の defaultPrevented が偽である
- [TV-17] プロジェクトの作成のフォームは対象にしない
  - 入力：project を渡さない ProjectEditor で名前を入力する
  - 期待結果：「保存していない変更があります」が出ず、beforeunload の defaultPrevented が偽である
- [TV-18] 利用者向けの文書
  - 入力：docs/user/getting-started・project-settings・config の日英の差分を読む
  - 期待結果：「画面の構成」にサイドメニューの「プロジェクトの設定」「プロジェクト」「Sacty の設定」と /settings の行があり、project-settings の開き方が「プロジェクトの設定」を押す手順で保存していない変更の表示と確認が書かれ、config に「Sacty の設定」の開き方（サイドメニューと人のアイコンのメニュー）がある
- [TV-19] 仕様書のサイドメニューの表
  - 入力：docs/spec/architecture.md（日英）の「画面のヘッダーとサイドメニュー」の差分を読む
  - 期待結果：表の項目が、すべてのプロジェクトの画面は「プロジェクト」「Sacty の設定」、プロジェクトの画面は「タスク」「スケジュール」「監査」「プロジェクトの設定」「Sacty の設定」になっている
