# オーケストレーターの前に情報収集のエージェントを置き、集めた情報をすべての工程とゴールガーディアンに引き継ぐ

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/nice-faraday-e1n1ip
- 関係する ADR: [オーケストレーターの前に情報収集のエージェントを置き、集めた情報をすべての工程とゴールガーディアンに引き継ぐ](../adr/20261022-2350-gather-information-before-orchestrator.md)

## 目的

実際に使ってみて、オーケストレーターがチケットの本文だけから進め方を選ぶと、人の判断とずれるという気づきへの対応。
人は、チケットの親（ストーリー・エピック）、チケットにある URL の中身、MCP・外部 PF で見つかる関係する情報を集めてから判断している。

- オーケストレーターの前に、情報を集めて関係するものだけに絞り込み、まとめる情報収集のエージェントを置く。
- まとめを、オーケストレーター・すべての工程・ゴールガーディアンに引き継ぐ。

## したこと

- core
  - `packages/core/src/events.ts`：イベント `InformationGathered`（まとめ `brief`・情報源 `sources`・費用）と上限 `GATHERED_BRIEF_MAX`（30000 文字）、actor `gatherer` を足した。
  - `packages/core/src/projection.ts`：タスクに `gathered` を持たせ、`awaitingGathering`（工程を選ぶ前で、まだ集めておらず、分割の子タスクではない）を足した。
  - `packages/core/src/cost.ts`：`InformationGathered` を予算に入れる費用の種類に足した。
  - `packages/core/src/messages.ts`：`gather.failed`・`gather.unreadable`（日英）。
- デーモン
  - `apps/daemon/src/service.ts`：`gatherInformation` を足し、`runNextInner` でチケットのトリアージより前に呼ぶ。`runOrchestrator` に役割（`gather`）を渡せるようにし、実行・コンテキスト・外部 PF・費用・失敗の扱いをオーケストレーターと共通にした。失敗・読めないときは `OrchestratorFailed`（actor `gatherer`）を記録し、代わりのエージェントか一時停止。テスト用の差し替え `gatherer` を足した。
  - `apps/daemon/src/prompts.ts`：`buildGatherPrompt`（チケットの親・リンク・URL・MCP・外部 PF を辿り、決まった見出しでまとめる。読むだけ・コードは読まない）、`extractGathered`、`gatheredLines` を足した。工程の指示（タスクの内容）・オーケストレーターの指示（工程の選択・リポジトリの無いタスク・レビューのイメージ・工程の見直し）・チケットのトリアージ・質問への答え・ゴールガーディアンの指示（変更の申し出・最終レビュー・統合レビュー・PR の指摘の戻し先2種）に添えた。ゴールガーディアンには、承認されていない情報なので判定の根拠にしないよう添える（公正さの原則。ADR の理由）。子タスクの内容（`buildChildBody`）に親のまとめを添えた。
  - `apps/daemon/src/config.ts`：`step_agents.gather`（無ければオーケストレーターの AI）、スタブのエージェントの出力 `gather`、設定のひな形のコメント。
  - `apps/daemon/src/agents/invocation.ts`・`apps/daemon/src/run-timeouts.ts`：役割 `gather`。
- 画面
  - `apps/web/src/components/task-detail.tsx`：タスクの詳細に「集めた情報」のカード（まとめと情報源。工程が始まったら折りたたむ）。
  - `apps/web/src/lib/labels.ts`・`apps/web/src/i18n/messages/labels.ts`：作業履歴の文言と actor の名前（日英）。
  - `apps/web/src/lib/step-costs.ts`・`apps/web/src/components/step-costs.tsx`：工程ごとの費用の表に「情報収集」の行（失敗した実行も、actor が `gatherer` ならこの行）。
  - `apps/web/src/lib/session-log.ts`：実行のログを見られる行に足した。
- docs：仕様書 `docs/spec/tasks-and-steps.md`（「情報収集」の節・ゴールガーディアン）・`docs/spec/event-log.md`（actor・費用の表）・`docs/spec/configuration.md`、ユーザードキュメント `docs/user/tasks.md`（「タスクの開始時の情報収集」）・`docs/user/config.md`・`docs/user/intake.md`、それぞれの英語の版、図（`tasks-flow`・`tasks-overview`）、ADR。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`（エラー 0）・`npm run build`（終了コード 0）・`npx vitest run tests/docs`（93 件が合格）が通った。
- `npx vitest run`：135 ファイル・2572 件のうち 2563 件が合格、9 件が失敗した。失敗した 9 件（`agent-sessions`・`context-mcp`・`context`・`host-mcp-processes` のテスト）は、この変更の前のコードでも同じく落ちる（`git stash` で戻して確かめた）。この環境によるもので、この変更とは関係しない。
- 足したテスト
  - 結合（`apps/daemon/src/daemon.test.ts`「タスクの開始時の情報収集」）：工程を選ぶ前に1回だけ集めて費用とともに記録し、オーケストレーターと調査の工程の指示にまとめが入る。読めないときは actor `gatherer` の `OrchestratorFailed` で止まり、再開すると集め直す。チケットのタスクは、チケットのトリアージの前に集め、指示にチケットのキーと接続先が入り、トリアージの指示にもまとめが入る。`step_agents.gather` の選び方。
  - 単体：指示（工程・工程の見直し・最終レビューに入る、集めていなければ入らない、ゴールガーディアンにだけ判定の根拠にしない旨が入る、情報収集の指示の中身、出力の読み取り、子タスクの内容）、投影（1回だけ・工程を選んだ後は記録できない・子タスクは集めない）、工程ごとの費用の表（情報収集の行、無作為の作業履歴で表の合計がタスクの費用と一致）。
  - 既存の結合テストは、テスト用の差し替えで情報収集をせずに進める（`makeService` の既定と、並行実行のテストの `TaskService`）。
- 図は `npm run docs:diagrams` で作り直し、ヘッドレスの Chromium で描いて、カードと矢印が重ならないことを目で確かめた（出た2件の幅の警告は、この変更の前からある別の図のもの）。
- 確かめていないこと
  - 本物の AI が、新しい指示でチケットの親・URL・MCP を辿って適切に絞り込むか（結合テストは答えを偽物で与えている）。
  - 画面をブラウザで開いての「集めた情報」のカードの確認（型検査と、作業履歴の文言・費用の表のテストだけ）。スクリーンショットの架空のデータには集めた情報が無いので、撮り直していない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 情報収集 → チケットのトリアージ の順だと、同じチケットを2回読み、実行が1回多い（ユーザーとの相談） | 情報収集がトリアージを兼ねる形に作り直した（下の「作り直し：情報収集がトリアージを兼ねる」） |

## 作り直し：情報収集がトリアージを兼ねる

最初の版は、情報収集の後に、別の実行でオーケストレーターがチケットを読んでトリアージしていた。
同じチケットを2回読むので、情報収集が同じ実行でトリアージも行う形にした。

- `apps/daemon/src/prompts.ts`：`buildGatherPrompt` に、トリアージ（候補・人が選んだリポジトリ）を渡せるようにし、リポジトリ・題・概要を書かせる。`extractGathered` が、答えの `repo`・`title`・`summary`・`reason` を `triage` として読む（`extractTicketTriage` と同じ読み方を `ticketTriageOf` にまとめた）。
- `apps/daemon/src/service.ts`：チケットの接続先と候補を確かめる部分を `ticketTriageTarget` にまとめ、`gatherInformation` と `triageTicket` で使う。情報収集は、まとめを読めたら `InformationGathered` に続けて、`TicketTriaged`（actor `gatherer`・費用なし）か、決められなかった理由の一時停止を記録する（`ticketTriaged`）。`triageTicket` は、情報収集の後にまだ決まっていないとき（決められずに止まった後の再開・人がリポジトリを選んだ後）だけ動く。
- docs：仕様書（「トリアージを兼ねる」の節・取り込み・費用の表）、ユーザードキュメント（タスクを進める・取り込み）、それぞれの英語の版。ADR に兼ねる決定と理由を書き足し、チケットのトリアージの ADR を、オーケストレーターがチケットを読む部分の置き換えとして `superseded` にした（作業履歴 PBI-52 のリンクを直した）。
- 確かめたこと
  - 結合テスト：チケットのタスクは実行1回でまとめとリポジトリ・題・概要が決まり、費用は情報収集にだけ入る。決められなければ集めた情報を残して止まり、人がリポジトリを選んで再開すると、集め直さずに題と概要だけを書き直す（その指示にまとめが入る）。候補に無いリポジトリ・概要の無い答え・トリアージの無い答えでは、トリアージを記録せずに止まる。
  - 単体テスト：トリアージを兼ねる指示（候補・人が選んだリポジトリ・兼ねないときは選ばせない）と、答えの読み取り。
  - `npm run lint`・`npm run typecheck`・`npm run build`・`npx vitest run tests/docs` が通った。`npx vitest run` の失敗は、上と同じ環境による 9 件だけ。

## 残したこと

- 情報収集を、プロジェクトやタスクの種類（PR のレビューだけのタスクなど）ごとに Off にする設定は足していない。すべてのタスクで集める。
- 集めた情報を人が直す・差し戻す手段は無い（承認ゲートを設けない決定。ADR）。
