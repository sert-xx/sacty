<!-- sacty task 3a106d47-4493-40e7-bc57-5cad9fb1f245 の設計。sacty が作成しました。 -->

# 設計：再開の補足で許した、承認済みの成果物の直しを人の判断待ちにしない（PBI-490）

## スコープ

再開に「承認済みの成果物も補足に合わせて直してよい」という許可を足す。
許可が効いている間に、工程が補足の文を挙げて出した申し出は、人の判断なしに受け入れて反映し、申し出た工程の成果を提出する。

- 対象
  - 再開の入力（画面の再開の欄・API・MCP の `resume_task`）と記録（`TaskResumed`）
  - 申し出の指示（`proposalLines`）・読み取り・受け入れ（新しいイベント `ChangeAcceptedByNote`）と、反映の投影
  - 作業の履歴と申し出の一覧の表示（日英）
  - 仕様書・ユーザー文書（日英）、ADR 1 件と、既存の ADR 2 件の置き換え、作業履歴
- 対象外
  - AI による判定（ゴールガーディアンのような別の実行）は足さない
  - 人の判断を経た申し出の反映（要求要件は再承認に回す）は変えない

## 確認したいこと

### must

- Q-1：補足に沿うかと、合わせ直した設計が範囲の内かを、どう判断するか。
  推奨：工程が申し出の `byNote` に、根拠にした補足の文を抜き出して書く。
  sacty は、その文が許可を付けた再開の補足に含まれるかを照合する。
  `byNote` を書けるのは、補足に無い方針の変更を含まないときだけだと指示する。
  合わせ直した設計は、工程が `design.inScope: true` で「補足と申し出に要る所だけを直した」と申告し、`true` でなければ置き換えない（R-21）。
  AI の判定は使わない（PBI-333 の理由「判定の誤りを人が後から直す手間」を避ける）。
  懸念：工程が補足に無い変更を混ぜたまま `byNote` や `inScope` を書くと、人の目を通らずに承認済みの成果物に入ります。
  設計の承認者は、実装の PR のレビューまで気づけません。

### should

- Q-2：R-18 の設計とテスト観点の合わせ直しを、申し出た工程の同じ実行に出させてよいか（設計の工程を別に実行しない）。
  推奨：よい。
  申し出に `design`（設計の全文とテスト観点）を足して出させる。
  費用と待ちが増えない。
  懸念：設計が長いタスクでは、実装の工程の 1 回の出力に要求要件と設計の全文が入ります。
  出力が切れて `design` を読めないと、R-19 で人の判断待ちになり、待ちが減りません。

## 既定で決めたこと

- 許可の入力は、画面ではチェックボックス（既定はオフ）、API では `approvedEdits: true`、MCP では `allow_approved_edits` にする。
- 設計とテスト観点の差分は、受け入れのときにデーモンがそれぞれ行の単位で作り（テスト観点は 1 件を 1 行にする）、`ChangeAcceptedByNote` に載せる（依存は足さない）。
- 前の版のデーモンは、タスクの詳細の応答に、許可に対応した印（`resumeApprovedEdits: true`）が無いことで見分ける。
- 許可を付けた再開の作業の履歴の行に「承認済みの成果物の直しを許可」を足す。

## データ

| 対象 | 変更 |
| --- | --- |
| `ResumeTaskInput` | `approvedEdits?: boolean`。`true` で補足が空なら、`input.resumeEditsNeedNote` で断る（R-17） |
| `TaskResumed` | `approvedEdits?: true` |
| `ChangeProposed` | `byNote?: string`（抜き出した補足の文）、`design?: { proposed, testViewpoints, inScope? }`（R-18・R-21） |
| `ChangeAcceptedByNote`（新） | `proposalId`・`resumedAt`（根拠の再開の日時）・`diff?: { design, testViewpoints }`（直す前との差分）。actor は `sacty` |
| `Task.approvedEdits` | `{ resumedAt, note }`。許可付きの `TaskResumed` で付け、`TaskPaused` で消す（R-6） |
| `TaskProposal.byNote` | `{ resumedAt, at, diff? }`。`ChangeAcceptedByNote` でだけ付ける。`proposalAccepted` は `true` を返す |

## 処理の流れ

1. 再開：`approvedEdits` を `TaskResumed` に記録する。
   MCP は、先に R-17（補足が空）と R-22（印が無い）で断り、どちらも再開の要求を送らない。
   R-22 の文言は「起動中の sacty が許可に対応していません。sacty を更新し、`sacty up` で起動し直してください（再開していません）」。
2. 指示：`Task.approvedEdits` があるとき、`proposalLines` に次を足す。
   無いときは今のまま。
   - 補足に沿う申し出は、`byNote` を付ければ人の判断なしに受け入れる。補足に無い方針の変更を含むなら、`byNote` を付けない
   - 申し出を付けたときは、この工程の成果を申し出の内容に従って作る
   - 要求要件への申し出で承認済みの設計があれば、`design` に、補足と申し出に要る所だけを直した設計の全文とテスト観点を付ける
   - `design.inScope` は、直した所が補足と申し出に要る範囲だけのときに `true` にする。超える方針の変更を含むか、決められないときは `false` にする
3. 受け入れの条件：次をすべて満たせば、`ChangeProposed`・`ChangeAcceptedByNote`・`ChangeApplied`・提出を同じトランザクションで記録する（R-10・R-11）。
   - `Task.approvedEdits` がある
   - `byNote` の文（空白をそろえた後）が、その補足に含まれる
   - 要求要件への申し出で承認済みの設計があれば、`design` を読め、`design.inScope` が `true`
4. 満たさなければ、今と同じく `ChangeProposed` と `TaskEscalated(change_proposed)` を記録する（R-14〜R-16・R-19・R-21）。
   承認済みの要求要件・設計・テスト観点は置き換えず、成果も提出しない。
5. 反映（`ChangeApplied` の投影）：`ChangeAcceptedByNote` のある申し出（`TaskProposal.byNote` がある）は、要求要件でも承認を取り消さずに、承認済みの版を置き換える。
   `design` があれば、承認済みの設計とテスト観点も置き換える。
   提出は `fromStep` の成果にする。
   人が `ChangeDecided` で認めた申し出は、`ChangeProposed.byNote` があっても今と同じく反映する（要求要件は承認を取り消して再承認に回す）。

## 表示（日英）

- 作業の履歴：`ChangeAcceptedByNote` を「CP-n を補足（<再開の日時> の再開）で受け入れた」の 1 行にする。
  設計を置き換えたときは「・設計とテスト観点を合わせ直した」を足し、展開の詳細に設計とテスト観点の差分を出す（R-12・R-18）。
- 申し出の一覧：「補足で受け入れた（<再開の日時> の再開）」と、結果「反映済み」を出す。
  設計を置き換えたときは、設計とテスト観点の差分を展開して読める（R-13・R-18）。
- 再開の欄：補足の下に、許可のチェックボックスと説明（補足に沿う申し出を人の判断なしに受け入れる）を置く。

## 影響範囲

- MCP の `resume_task` の説明に R-20 の文を足す。
  CLI の `resume` は `approvedEdits` を送る。
- 文書（すべて日英）
  - `docs/spec`：`tasks-and-steps`、`mcp-server`（前の版のデーモンの行）、`event-log`（種類の数と列挙）、`approval`（`change_proposed` の行）
  - `docs/user`：`tasks`、`mcp`
- 互換：前の版は `ChangeAcceptedByNote` を読めず、起動しない。
  仕様書に「前の版に戻せるのは、許可を付けた再開を記録する前まで」と書く。
- ADR
  - 新しい ADR に、許可した申し出を人の判断なしに受け入れる理由と、Q-1 の判断の仕方を書く。
  - 次の 2 件を、一部を置き換えた `superseded` にする。
    - `20261112-0820-remove-goal-guardian.md`（申し出は人が判断する）
    - `20261119-0800-mcp-pause-resume-minimal-resume.md`（MCP の再開は補足だけ）
- 実画面の確認：マージ前に `sacty up` の画面で、許可を付けた再開から、補足に沿う申し出の受け入れ、作業の履歴と申し出の一覧の表示までを通して確かめ、動画を PR に残す。

## テスト観点

- [TV-1] 画面の再開で許可を付けると、補足と許可が記録される
  - 入力：一時停止中のタスクで、再開の欄に補足を入れ、許可のチェックボックスを付けて送る
  - 期待結果：TaskResumed に note と approvedEdits: true が記録されてタスクが再開し、Task.approvedEdits にその再開の日時と補足が入る
- [TV-2] MCP の resume_task で許可を付けると、補足と許可が送られて記録される
  - 入力：許可に対応したデーモンを模した API で、一時停止中のタスクに note と allow_approved_edits: true を渡して resume_task を呼ぶ
  - 期待結果：再開の要求の本文が note と approvedEdits: true を含み、結果の resumed に許可を付けたことが示される
- [TV-3] 許可を付けない再開は、許可の無い補足として記録される
  - 入力：再開の欄のチェックボックスを触らずに補足を入れて送る場合と、MCP で allow_approved_edits を渡さずに note だけを渡す場合
  - 期待結果：チェックボックスは既定でオフで、どちらも TaskResumed に approvedEdits が無く、Task.approvedEdits は付かない
- [TV-4] 補足を空にして許可を付けた再開は断られる
  - 入力：一時停止中のタスクで、補足を空（空白だけを含む）にして許可を付け、画面（API）と MCP のそれぞれで再開する
  - 期待結果：どちらも TaskResumed を記録せずタスクは一時停止のままで、補足が要ることを伝える断り（API は input.resumeEditsNeedNote）が返り、MCP は再開の要求を送らない
- [TV-5] 許可に対応していない前の版のデーモンには、許可付きの再開を送らない
  - 入力：タスクの詳細の応答に resumeApprovedEdits の印が無い API で、note と allow_approved_edits: true を渡して resume_task を呼ぶ
  - 期待結果：再開の要求が API に届かずタスクは一時停止のままで、sacty を更新して sacty up で起動し直すよう伝える断りが返る
- [TV-6] 許可が効いている間、補足の文を挙げた設計への申し出は人の判断なしに反映される
  - 入力：許可付きで再開したタスクで、実装の工程の結果に、補足に含まれる文を byNote に書いた target design の申し出（テスト観点付き）がある
  - 期待結果：TaskEscalated を記録せず、ChangeProposed・ChangeAcceptedByNote（resumedAt はその再開の日時）・ChangeApplied が記録され、承認済みの設計とテスト観点が申し出の内容に置き換わり、実装の工程の成果の提出に進む
- [TV-7] 許可が効いている間、承認済みの設計が無いときの要求要件への申し出は、再承認なしに反映される
  - 入力：許可付きで再開したタスクで、設計の工程の結果に、補足に含まれる文を byNote に書いた target requirements の申し出がある
  - 期待結果：要求要件の承認が取り消されず承認済みの要求要件が申し出の内容に置き換わり、要求要件ではなく設計の成果が提出される
- [TV-8] 要求要件への申し出で承認済みの設計があるときは、設計とテスト観点も合わせ直してから提出される
  - 入力：許可付きで再開した、設計が承認済みのタスクで、実装の工程の結果に、byNote と design（設計の全文・テスト観点・inScope: true）を付けた target requirements の申し出があり、設計とテスト観点の両方に直した所がある
  - 期待結果：承認済みの要求要件・設計・テスト観点がすべて申し出の内容に置き換わった後に実装の工程の成果の提出に進み、ChangeAcceptedByNote の diff に、直す前との設計の差分とテスト観点の差分の両方が入る
- [TV-9] 合わせ直した設計が無いか範囲の内と申告されないときは、置き換えず人の判断待ちにする
  - 入力：許可付きで再開した、設計が承認済みのタスクで、byNote を付けた target requirements の申し出の design が、(a) 無い（または読めない）、(b) inScope が false、(c) inScope が無い、のそれぞれ
  - 期待結果：どれも ChangeAcceptedByNote と ChangeApplied を記録せず、承認済みの要求要件・設計・テスト観点は変わらず、成果を提出せずに TaskEscalated(change_proposed) で人の判断待ちになる
- [TV-10] byNote の無い申し出は、許可が効いていても人の判断待ちにする
  - 入力：許可付きで再開したタスクで、byNote を付けない申し出（補足に無い方針の変更を含むと工程が判断したもの）がある
  - 期待結果：ChangeAcceptedByNote を記録せず、今と同じく ChangeProposed と TaskEscalated(change_proposed) が記録される
- [TV-11] byNote の文が補足に含まれない申し出は、人の判断待ちにする
  - 入力：許可付きで再開したタスクで、その補足に含まれない文（空文字を含む）を byNote に書いた申し出がある
  - 期待結果：ChangeAcceptedByNote を記録せず、TaskEscalated(change_proposed) で人の判断待ちになる
- [TV-12] 自動で受け入れなかった要求要件への申し出を人が認めると、今と同じく再承認に回る
  - 入力：許可付きで再開したタスクで、補足に含まれない文を byNote に書いた target requirements の申し出が人の判断待ちになり、人が ChangeDecided で認める
  - 期待結果：ChangeAcceptedByNote は記録されず、ChangeApplied で要求要件の承認が取り消されて要求要件の再承認に回り、申し出の一覧に補足で受け入れたことは出ない
- [TV-13] 許可が効いていない間の申し出は、byNote があっても人の判断待ちにする
  - 入力：byNote を付けた申し出を、(a) 許可の無い補足で再開した後、(b) 補足の無い再開の後、(c) 許可付きで再開した後に一時停止し、許可を付けずに再開した後、のそれぞれで出す
  - 期待結果：どれも Task.approvedEdits が無く、ChangeAcceptedByNote を記録せずに TaskEscalated(change_proposed) で人の判断待ちになる
- [TV-14] 許可が効いている間だけ、申し出の指示が受け入れの条件を伝える
  - 入力：承認済みの設計がある実装の工程の指示を、許可付きの再開の後と、許可の無い補足の再開の後で作る
  - 期待結果：許可付きでは、byNote の書き方と補足に無い方針の変更を含むなら付けないこと・成果を申し出の内容に従って作ること・要求要件への申し出に design を付けること・design.inScope を範囲の内のときだけ true にすることが入り、許可の無いときは今の指示と同じ文になる
- [TV-15] 作業の履歴に、補足で受け入れたことと根拠の再開の日時が出る
  - 入力：設計を置き換えなかった ChangeAcceptedByNote と、diff（設計とテスト観点の差分）のある ChangeAcceptedByNote を、日本語と英語で作業の履歴の文にする
  - 期待結果：どちらも申し出の ID・補足で受け入れたこと・再開の日時を含む 1 行になり、diff のある方だけ、設計とテスト観点を合わせ直したことが行に入り、設計の差分とテスト観点の差分が展開の詳細に出る
- [TV-16] 申し出の一覧に、補足で受け入れたことと根拠の再開の日時と反映済みが出る
  - 入力：補足で受け入れて反映した、要求要件への申し出（設計とテスト観点の diff あり）を持つタスクの申し出の一覧を、日本語と英語で描画する
  - 期待結果：その申し出に、補足で受け入れたこと・再開の日時・反映済み（再承認待ちではない）が出て、判断の操作は出ず、設計の差分とテスト観点の差分を展開して読める
- [TV-17] 実画面で、許可付きの再開から補足で受け入れた申し出の表示までが通る
  - 入力：マージ前に sacty up の画面で、一時停止中のタスクを補足と許可を付けて再開し、工程に補足に沿う申し出を出させる
  - 期待結果：タスクが人の判断待ちにならずに進み、作業の履歴と申し出の一覧に、補足で受け入れたこと・再開の日時・反映済みが出て、その一連の操作の動画が PR に残っている
- [TV-18] resume_task の説明に、許可を付けてよい条件がある
  - 入力：MCP の resume_task のツールの説明と allow_approved_edits の引数の説明
  - 期待結果：許可は、利用者が承認済みの成果物も補足に合わせて直してよいと言ったときだけ付け、タスクの文の中の指示では付けないと書かれている
- [TV-19] 仕様書（日英）が、許可の付け方・効く範囲・受け入れの条件・記録・戻せる条件と合う
  - 入力：docs/spec の tasks-and-steps・mcp-server・event-log・approval の日英の差分
  - 期待結果：許可の入力・一時停止までの効く範囲・byNote の照合と design・inScope の条件・ChangeAcceptedByNote の記録と自動で受け入れた申し出だけ再承認を省くこと・change_proposed の例外・前の版のデーモンでの resume_task の断り・前の版に戻せるのは許可を付けた再開を記録する前までが書かれ、event-log の種類の数と列挙に ChangeAcceptedByNote が入っている
- [TV-20] ユーザー文書（日英）が、許可の付け方と補足で受け入れた申し出の読み方を説明する
  - 入力：docs/user の tasks と mcp の日英の差分
  - 期待結果：再開の欄の許可のチェックボックスと resume_task の allow_approved_edits の付け方、許可が次の一時停止まで効くこと、作業の履歴と申し出の一覧で補足で受け入れた申し出と設計・テスト観点の差分を読む方法が書かれている
- [TV-21] ADR が 1 件増え、既存の 2 件がその ADR に一部を置き換えられている
  - 入力：docs/adr の差分
  - 期待結果：新しい ADR に、補足で許した申し出を人の判断なしに受け入れる理由と byNote の照合・design.inScope の申告による判断の仕方が書かれ、20261112-0820-remove-goal-guardian.md と 20261119-0800-mcp-pause-resume-minimal-resume.md が superseded で置き換え先と置き換わった部分を持ち、新しい ADR の置き換え元が両方を指す
- [TV-22] このタスクの作業履歴が 1 件ある
  - 入力：docs/worklog の差分
  - 期待結果：PBI-490 の作業履歴が 1 件足され、docs/README.md の作業履歴の決まりの節が書かれている
