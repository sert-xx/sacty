# 取り込みの設定を「Issue の取り込み」と「PR のレビューの取り込み」に分け、sacty の PR にはレビュー用のラベルを付ける

- 日付: 2026-10-15（UTC）
- タスク: PBI-99
- PR: #108
- ブランチ: feat/issue-99-intake-settings
- 関係する ADR: [取り込みを「Issue の取り込み」と「PR のレビューの取り込み」に分け、sacty の PR にはレビュー用のラベルを付ける](../adr/20261015-0240-split-issue-and-pr-review-intake.md)

## 目的

PR の取り込みが「Issue・PR の取り込み」（取り込むラベル）と「PR のレビューの取り込み」の2つにあって紛らわしいので、取り込むラベルは
Issue だけ、PR は PR のレビューの取り込みだけにする。sacty が作る PR に付けるラベル（PBI-88）も、レビュー用のラベルに変える。
まだ本格運用していないので、要らなくなる設定の項目は互換を保たずに消す（保存されているデータからも）。2つのラベルが同じ名前の
設定は単純に扱う（保存のときに拒否する）。

## したこと

- 設定の型（`packages/core/src/projects.ts`）
  - `TriageKind` から `pullRequests` を消した（`issues`・`reviewLabel`・`tickets`）。古い値を読む互換の処理は作らない。
  - 保存のときの型 `SactySettingsUpdate` を足し、取り込むラベルとレビュー用のラベルの同じ名前（大文字・小文字を区別しない）を
    `input.sameIntakeAndReviewLabel`（`reviewLabel` の誤り）で拒否する。読み込み（`SactySettings`）では拒否しない（すでに同じ名前で
    保存されている設定で、デーモンが設定を読めなくならないように）。
- 設定の保存先（`apps/daemon/src/settings.ts`）：開くときに、保存されている `triageOff` の `pullRequests` を消して書き直す
  （`dropRemovedItems`。空になれば項目ごと消す。消すものが無ければ書かない）。
- 取り込み（`apps/daemon/src/service.ts`）
  - 取り込むラベルの検索を `is:open is:issue …` にし、取り込みでも PR は通常のタスクにしない。
  - sacty の PR の判定（`source.review: sacty`）を、取り込むラベルからレビュー用のラベルに変えた。レビュー用のラベルの検索が先に来るように
    並べ替えていた処理は、PR が取り込むラベルの検索に出なくなったので消した。
  - PR に付けるラベル（`labelForPullRequests`。旧 `intakeLabelForPullRequests`）を、レビュー用のラベル（そのトリアージが Off なら無し）に
    変えた。付ける予定の記録は `label` の項目に残す（`packages/core/src/events.ts`。旧 `intakeLabel`）。台帳は書き換えない。
  - 保存は `SactySettingsUpdate` で検査する。
- 画面（`apps/web`）
  - 「Issue・PR の取り込み」を「Issue の取り込み」にし、「PR を取り込む」の切り替えを消した。説明に、PR は取り込まないこと、sacty の PR には
    レビュー用のラベルを付けることを書いた（日本語・英語）。
  - 保存で送る Off の種類から `pullRequests` を消した。プロジェクトの一覧の取り込みの状態を「Issue：ラベル …」にした。
- 文言（`packages/core/src/messages.ts`）：`input.sameIntakeAndReviewLabel` を足し、sacty の PR のレビューの理由を「sacty がほかのタスクで
  作った PR」にした。
- docs：仕様書（取り込み・承認と差し戻し・全体の構成・タスクと工程）、ユーザードキュメント（取り込み・プロジェクトの設定・
  トラブルシューティング）を直した。PBI-88 の ADR を一部置き換えたので、`20261014-1445-superseded-label-sacty-pull-requests-for-review.md`
  に変え、新しい ADR を足した。英語の版の docs（PR 107）はまだ main に入っていない。

決めたこと（詳しくは ADR）：

- 移行：`triageOff` の `pullRequests` は、型・画面・API から消し、保存されている設定からはデーモンの起動のときに消す。API で送ると拒否する。
- 2つのラベルが同じ名前：保存のときに拒否する。すでに同じ名前で保存されている設定は読み込めて、Issue は取り込むラベル、PR はレビュー用の
  ラベルとして動く（次の保存で別の名前を求める）。
- 台帳の `intakeLabel`（取り込むラベルを付ける予定）：名前を `label` に変え、これまでの記録は読めるが付ける予定として扱わない。台帳は
  書き換えない。

## 確かめたこと

- `npm run lint`（終了コード 0）、`npm run typecheck`、`npx vitest run`（61 ファイル・1398 件。テストを足した後）、`npm run build`、
  `npx vitest run tests/docs` が通った。
- 足した・直したテスト
  - 取り込み：取り込むラベルの PR は、sacty の PR でもほかの PR でも取り込まない。検索は `is:issue`。すでに取り込んだ PR のタスク（台帳に
    書いて作った）は、これまでどおり進む（レビューの対象・調査の結果のコメント）。
  - ラベル：実装の PR・要求要件・設計の PR・修正のタスクの PR にレビュー用のラベルを付ける。取り込むラベルだけ・レビュー用のラベルが無い・
    そのトリアージが Off なら付けない。再開で付けるのもレビュー用のラベル。
  - レビューの対応：レビュー用のラベルの sacty の PR はレビューだけのタスク（`sacty`）になり、直すべき指摘のある回だけ元のタスクに届く
    （アカウントが違っても）。直して PR を更新しても、もうレビューのタスクを作らない（繰り返さない）。sacty が作っていない PR は `label`。
    2つのラベルが両方付いた sacty の PR も `sacty`。
  - 設定：同じ名前（大文字・小文字だけ違うものも）は保存できず、API は `reviewLabel` の `input.sameIntakeAndReviewLabel` を返す。
    `pullRequests` は保存で拒否する。保存先を開くと `pullRequests` が消え、データからも消える（空なら項目ごと）。消すものが無ければ
    更新日時も変えない。
  - 台帳：`PullRequestPublished` の `label` を残し、これまでの `intakeLabel` は読めるが残らない。
  - 画面：設定の画面を描いて、最初の区画が「Issue の取り込み」で PR の切り替えが無いこと、切り替えは `issues`・`reviewLabel`・`tickets`
    だけであること（日本語・英語）。保存で `pullRequests` を送らないこと、デーモンの拒否の理由を返すこと。
- 修正を戻すと落ちること：PR を取り込まない判定（4件）、PR に付けるラベル（9件）、保存先の移行（1件）、同じ名前の検査（2件）、
  保存で送る種類（1件）、画面の切り替え（1件）を、それぞれ戻して落ちることを確かめた。
- 画面：一時的な SACTY_HOME（`triageOff` に `pullRequests` を持つ古い設定を書いておいた）、偽の `gh`・`docker`、ポート 4991/4992 で
  起動し、設定の画面が開けること、保存先から `pullRequests` が消えたこと、2つの区画の表示、同じ名前（`SACTY`）を保存すると理由が出ること、
  別の名前で保存できること、Issue を Off にすると止まっていると出ること、英語の画面を動画に撮った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （PO）互換を保たずに消し、保存されているデータからも消す。同じ名前は保存で弾くなど単純に | 型・画面・API から消し、保存先は起動のときに消すようにした。同じ名前は保存で拒否する |
| （DA）保存で送る種類のテストが、古い画面の値を送っていたので、修正を戻しても通った | 古い値を送らない形にして、戻すと落ちることを確かめた |

## 残したこと

- 英語の版の docs（PR 107）が先に main に入ったら、直した docs の英語の版を直す。
- レビューの依頼だけで取り込んだ sacty の PR（レビュー用のラベルが無い）は、これまでどおり `requested` で、元のタスクには届かない（変えていない）。
