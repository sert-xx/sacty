<!-- sacty task 211edd12-40f0-43d3-9430-feda1104385c の設計。sacty が作成しました。 -->

# 設計：補足で受け入れた申し出の表示を読みやすくする（PBI-495）

## スコープ

作業の履歴と申し出の一覧に、補足による受け入れの再開の日時と、設計・テスト観点の差分を読める形で出す。
記録済みの差分の文字列を画面の側で行ごとに解析して、描き分ける。

- 対象
  - 作業の履歴の「CP-n を補足（<日時> の再開）で受け入れた」の日時を、利用者の地域の時刻で出す（日英）
  - 差分を描く部品を新しく作り、作業の履歴の詳細と申し出の一覧の両方で使う
  - 画面のテスト、作業履歴（`docs/worklog/`）
- 対象外
  - デーモンの差分の作り方と、`ChangeAcceptedByNote`・`TaskProposal.byNote` の形（記録の変更は範囲の外）
  - 差分の比べ方（先頭と末尾の一致だけで比べるので、途中の変わらない行も削除と追加に出る）

## 確認したいこと

- must：なし
- should
  - Q-1 受け入れ条件4の実画面の確かめと動画は、承認の代理がマージ前に、実際の Sacty で行う形でよいか。
    推奨：はい。実装の環境には Docker が無く、PBI-490（PR #596）も同じ形にした。実装は画面のテストまでを行う。
    懸念：実装の工程で動画を撮る前提だった場合、実装の工程をやり直すまで PR に動画が付かず、マージが止まる。
- 確認しないと決めたこと
  - 記録の形と記録済みのイベントの扱い：イベントの形は変えず、画面で文字列を解析する。依頼が記録の変更を範囲の外にしており、記録済みのイベントもこの解析でそのまま読めるため。

## 既定で決めたこと

- テスト観点の差分は、同じ ID の削除と追加のカードを隣に並べる。並びは、差分の中で ID が最初に出た順にする。
- 差分の各行・各カードに「削除」「追加」（英 Removed・Added）の印を付ける。差分が空なら「差分なし」（英 No changes）と出す。
- 日時は、メッセージの関数が `Date` を受けて中で整える（`AgentFellBack` と同じ方式）。`describeEventParts` が locale を受けないため。

## 構成

| 場所 | 変更 |
| --- | --- |
| `apps/web/src/components/note-diff.tsx`（新規） | `NoteDiff`：`diff: { design, testViewpoints }` を受けて、設計とテスト観点の差分を描く |
| `apps/web/src/components/task-detail.tsx` の `EventText` | `ChangeAcceptedByNote` に diff があるとき、詳細に `NoteDiff` を出す（文字列の detail は出さない） |
| `apps/web/src/components/proposals.tsx` | 差分の 2 つの `<pre>` を `NoteDiff` に置き換える |
| `apps/web/src/lib/labels.ts` の `describeEventText` | `resumedAt` を `new Date(...)` で渡す。detail の文字列は変えない |
| `apps/web/src/i18n/messages/labels.ts` | `ChangeAcceptedByNote(id, at: Date, aligned)`。`formatStamp` と同じ項目（月/日 時:分、英は 24 時間）で整える |
| `apps/web/src/i18n/messages/parts.ts` | 印と「差分なし」の文言（日英）。`docs/spec/ui-wording.md` に従う |

## 処理の流れ（`NoteDiff` の解析）

- 各行の先頭の 1 文字（`-`・`+`）を記号、2 文字目からを本文とする。
- 設計の差分：1 行を、記号の欄と本文の欄に分けた行で出す。行の背景色を削除と追加で分け、本文は `whitespace-pre-wrap break-words` で折り返す。
- テスト観点の差分：本文を JSON として読み、`id`・`title`・`input`・`expected` が文字列で揃えば、`TestViewpoints` と同じ形のカードで出す。
- 読めない行（JSON でない・項目が欠ける・記号が無い）は、その行をそのまま折り返して出す。ほかの行の表示は止めない。

## 影響範囲

- `apps/web/src/lib/labels.test.ts` の、ISO の文字列を含むことを確かめる行を、地域の時刻の文字列に直す。
- 利用者向け文書（`docs/user/`）と仕様（`docs/spec/`）は直さない。差分の見え方の記述が無く、記録の形も変えないため。

## テスト観点

- [TV-1] 作業の履歴の画面に出る再開の日時が、申し出の一覧と同じ地域の時刻で出る（日英）
  - 入力：画面のテスト（event-text.test.ts と proposals-note.test.ts の形）で、resumedAt が 2026-11-22T12:00:00Z の ChangeAcceptedByNote を EventText で、同じ受け入れを byNote に持つ task を Proposals で、ja と en でそれぞれ描く
  - 期待結果：EventText の描画結果が formatStamp(resumedAt, locale) の文字列を含み、2026-11-22T12:00:00Z を含まず、その文字列が同じ locale の Proposals の「補足で受け入れた」の行の日時と一致する
- [TV-2] テスト観点の差分が、観点ごとに ID・題・入力・期待結果のカードで出る（履歴と申し出の一覧、日英）
  - 入力：diff.testViewpoints が TV-2 の旧版の -行・TV-2 の新版の +行・TV-3 の +行（どれも JSON.stringify した観点）の ChangeAcceptedByNote を、EventText と Proposals で ja と en で描く
  - 期待結果：どちらにも TV-2 の削除・TV-2 の追加・TV-3 の追加の 3 枚のカードがこの順に並び、各カードに ID・題・入力・期待結果と削除・追加の印が出て、{"id" の文字列は出ない
- [TV-3] 解析できないテスト観点の行は、そのままの文字で出て、ほかの行のカードは出る
  - 入力：diff.testViewpoints が「+not json」の行と、正しい観点の +行の 2 行
  - 期待結果：「not json」がそのまま文字で出て、もう 1 行は観点のカードで出る
- [TV-4] 設計の差分で、差分の記号と本文の箇条書きの記号が別の欄に出て、行の色が削除と追加で分かれる
  - 入力：diff.design が「-- 旧い項目」と「+- 新しい項目」の 2 行の ChangeAcceptedByNote を、EventText と Proposals で描く
  - 期待結果：各行の記号の欄が「-」「+」、本文の欄が「- 旧い項目」「- 新しい項目」で、削除の行と追加の行の背景色が異なる
- [TV-5] 差分が空のとき「差分なし」と出る
  - 入力：diff.design が空の文字列で、diff.testViewpoints に 1 行ある ChangeAcceptedByNote を、ja と en で描く
  - 期待結果：設計の差分に「差分なし」（en は No changes）が出て、テスト観点の差分はカードで出る
- [TV-6] 狭い画面で、差分が表示の幅の中で折り返し、横にはみ出さない
  - 入力：画面のテスト（*.browser.test.ts）で、空白の無い 400 文字の input の観点と 400 文字の設計の行を持つ ChangeAcceptedByNote のタスクを、幅 375px で作業の履歴のタブと申し出の一覧を開き、差分を展開する
  - 期待結果：差分の領域の scrollWidth が clientWidth 以下で、ページも横にスクロールしない
- [TV-7] マージ前に実画面で 1〜3 を確かめた動画が残る
  - 入力：PR のマージ前に、補足で受け入れた申し出のあるタスクを、実際の Sacty の画面で日英で開く
  - 期待結果：PR に、作業の履歴の地域の時刻の日時・テスト観点のカード・設計の差分の記号の欄が映った動画が付いている
