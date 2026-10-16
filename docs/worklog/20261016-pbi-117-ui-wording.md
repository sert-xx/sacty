# 画面の文章をすべて見直し、補足はツールチップで出す

- 日付: 2026-10-16（UTC）
- タスク: PBI-117
- PR: #127
- ブランチ: feat/issue-117-ui-wording
- 関係する ADR: [画面の文言を本文と補足に分け、仕組みの説明はツールチップで出す](../adr/20261016-1244-ui-wording-body-and-hints.md)

## 目的

画面の文章が説明口調で読みづらい（ステークホルダーの指摘）。画面の文言をすべて見直し、本文は「いま何が起きているか・次に何をするか」
だけにし、仕組み・理由・数値・設定ファイルの場所は補足（マウスを乗せると出るツールチップ）に移す。補足はキーボードとタップでも開ける。
日本語と英語の両方。規則から外れた文言に気づけるテストを足す。分割せず 1 本で行う（ステークホルダー）。

## したこと

- 補足の部品 `apps/web/src/components/ui/hint.tsx`（`Hint`・`WithHint`）。base-ui の Popover を `openOnHover` で使い、キーボードで
  印に止まったとき（`:focus-visible`）にも開く。`keepMounted` で文を DOM に残し、印の `aria-describedby` で結び付ける。乗せただけで
  出た補足にフォーカスを移さない（`initialFocus`・`finalFocus` を false）。`CardSection` に `hint` を足した（`note` は短い事実）。
- 辞書（`apps/web/src/i18n/messages/*`）を日英とも書き直した。見出しの脇の note・常に出ていた説明の段落・判断の案内の長文・括弧の注釈・
  作業履歴の矢印と言い訳を、本文から外すか補足（`hint`・`*Hint`）に移した。例：
  - sacty の設定・プロジェクトの設定の各節の説明の段落 → 見出しの横の補足。
  - 実装の承認の案内（約 230 字）→「マージで承認、コメントで差し戻しです。」と、取り込みの仕組み・間隔の補足。
  - 「前段の調査（人間の承認なし。後の工程に渡す）」→「前段の調査」と補足。「違う内容でマージされた（承認として進めます）」→
    「別の内容でマージ・承認へ」。
  - 工程のテストのコマンドの欄から根拠を外し、補足で出す（`testCommandOfNoTests` の引数から根拠を外した）。
- 部品を直した：説明の段落（`whitespace-pre-line` の `p`）を消し、見出し・ラベルの横に `Hint` を置いた。`title` 属性で出していた補足
  （費用の「概算」、修正の子タスク）を `Hint` に置き換えた。ラベルの中に印を置けない所（`label` の中に `button` は置けない）は、
  `Label` と `Hint` を並べる形にした。
- テスト `apps/web/src/i18n/wording-policy.test.ts`：辞書の文字列の葉を日英まとめて確かめる（本文は改行なし・日本語 60 字・英語 130 字・
  括弧書き 14/30 字未満、補足は 150/320 字）。例外はキーのパスと理由の一覧（`EXCEPTIONS`）。文言を固定していたテスト
  （`labels.test.ts`・`settings-form.test.ts`・`intake.test.ts`・`live-*.test.ts`・`intake-wording.test.ts`）を新しい文言に直した。
- docs：仕様書 [画面の文言と補足](../spec/ui-wording.md)（日英）を足し、目次に入れた。ユーザードキュメント [タスクを進める](../user/tasks.md)
  の引用（テストのコマンドの欄・前の提出の見出し・更新が止まっているときの表示）と、補足の印の説明を直した。仕様書
  [タスクと工程](../spec/tasks-and-steps.md) の示し方を直した。CONTRIBUTING に文言の規則への案内を足した。ADR を足した。
- 変えなかったもの：デーモンが作って画面に出す文（`packages/core/src/messages.ts`）。エラーと失敗の理由で、CLI・Slack の通知と共有
  するため（PBI の範囲に入れていたが、規則上も本文に残すものなので、仕様書に理由を書いた）。Slack の通知の本文・CLI の出力・
  プロンプト（範囲外）。

## 確かめたこと

- `npx biome check apps packages tests docs README.md README.en.md CONTRIBUTING.md`：通った（`npm run lint` は、別のセッションの
  worktree `.claude/worktrees/` の `biome.json` を拾って止まるので、対象を指定した）。
- `npm run typecheck`・`npx vitest run`（88 ファイル・1809 件）・`npm run build`：通った。
- 画面：`preview_start`（`.claude/launch.json` の `sacty`）で、sacty の設定・プロジェクトの設定・タスクの作成の画面を開き、補足の印に
  マウスを乗せる・Tab で止まる・スマホの幅でタップする・Esc で閉じる、ライトとダーク、日本語と英語を確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA のセルフレビュー）補足に、操作に要る情報が入っていないか | 指摘の入力欄の「差し戻すときは必須」は補足に書いたが、差し戻しのボタンを押したときのエラー（`gate.remarksRequired`）で分かるので、本文はラベル「指摘（1 行に 1 件）」のままにした |

## 残したこと

- なし
