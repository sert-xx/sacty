# 工程のイメージは images から選ばせ、既定のイメージは最後の手段にする

- 日付: 2026-10-15（UTC）
- タスク: PBI-105
- PR: なし
- ブランチ: feat/issue-105-prefer-language-images
- 関係する ADR: [工程のイメージは images から選ばせ、既定のイメージは最後の手段にして、使う理由（または理由が無いこと）を作業履歴に残す](../adr/20261015-1118-default-image-as-last-resort.md)

## 目的

Node.js のリポジトリ（Next.js）のタスクで、`images` に Playwright の入った Node.js のイメージがあるのに、実装の工程が既定の
イメージで動き、テストが失敗した。`images` に合うイメージがあればそれを使い、既定のイメージは、どれも合わないときだけにする。

## 原因

オーケストレーターへの指示（`apps/daemon/src/prompts.ts` の `buildOrchestratorPrompt`）が、候補の先頭に
「default：既定のイメージ（Node.js・Claude Code・Codex）」を並べ、「書かない工程は default」としていた。Node.js のリポジトリでは
既定のイメージが合うように見え、書かなくても既定のイメージになり、そのことは作業履歴に出なかった。

## したこと

- `apps/daemon/src/prompts.ts`
  - `buildOrchestratorPrompt`：`images` があるとき、PR 作成を除く工程それぞれに `images` から選ばせる（書き漏らさない）。既定の
    イメージは候補に並べず、最後の手段として中身のとおりに説明し、使う工程には `defaultReasons` に理由を書かせる。テストを実行する
    イメージを、テストのコマンドとリポジトリの依存（ブラウザのテスト・DB のクライアントなど）から選ばせる。リポジトリの無いタスクの
    指示は、既定のイメージの説明だけを中身のとおりに直した。
  - `extractStepPlan`：`defaultReasons` を読む（工程の名前が正しく、空でないものだけ。1000 文字まで）。
- `apps/daemon/src/service.ts`：`withImages` で、`images` の候補を見せたとき（リポジトリの無いまま進めるタスクを除く）、既定の
  イメージで動く工程（`defaultImagesOf`）の理由を `defaultImageReasons` に、理由が無い工程を `imagesUnexplained` に入れる。止めずに進める。
- `packages/core/src/events.ts`：`StepsChosen` に省略できる `defaultImageReasons`・`imagesUnexplained` を足した。
- `apps/web/src/lib/labels.ts`・`apps/web/src/i18n/messages/labels.ts`：作業履歴の「工程を決定」に、既定のイメージの理由と、
  理由が無いまま既定のイメージで動かす工程を出す（ja・en）。
- 仕様書 `docs/spec/tasks-and-steps.md`（英語の版も）、ユーザードキュメント `docs/user/images.md`（英語の版も）を直した。

## 確かめたこと

- テストを足した・直した：
  - `apps/daemon/src/prompts.test.ts`：指示の文（既定のイメージを候補に並べない・最後の手段として中身のとおりに説明する・工程を
    書き漏らさない・理由を書かせる・テストのイメージを依存から選ばせる・`images` が無ければ出さない）と、`defaultReasons` の読み取り。
  - `apps/daemon/src/daemon.test.ts`：理由のある工程・`default` と書いて理由が無い工程・書かなかった工程の記録（PR 作成と、選んで
    いない工程・`images` から選んだ工程の理由は捨てる）、1つも書かなかったとき、`images` が無いとき・プロジェクトの対象で指定して
    いるとき・リポジトリの無いタスクでは記録しないこと。
  - `apps/web/src/lib/labels.test.ts`：作業履歴の表示（ja・en）。
- 修正を戻すと落ちること：`prompts.ts`・`service.ts`・`labels.ts`（文言を含む）を `origin/main` に戻すと、6件落ちる（指示の文・
  記録・表示）。`images` が無いとき・対象の指定・リポジトリの無いタスクのテストは、動作が変わらないことを確かめるもので、戻しても通る。
- 画面：一時的な `SACTY_HOME`・ポート 4860/4870 で、理由のある工程と理由の無い工程を持つ工程の決定を作業履歴に入れて起動し、
  Playwright でタスクの画面の作業履歴に出ることを動画に撮った。
- `npm run lint`（終了コード0）・`npm run typecheck`・`npx vitest run`（66ファイル・1503件が通過）・`npm run build`・
  `npx vitest run tests/docs`。

## わからないこと・確かめていないこと

- 本物のオーケストレーターが、新しい指示で Playwright の入ったイメージを選ぶかは確かめていない（Playwright のイメージと Next.js の
  リポジトリが手元に無い）。業務の環境で確かめる手順は PR に書いた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA）PR 作成の工程にもイメージを選ばせるべきか | PR 作成は sacty がコンテナを使わずに行う（イメージを使わない）ので、選ばせず、理由も求めない |
| （DA）理由が無い工程で止めないと、黙って既定のイメージに倒すのと同じではないか | 作業履歴（タスクの画面）に「理由が無いまま既定のイメージで動かす」と工程の名前を出す。止めない理由は ADR に書いた |
