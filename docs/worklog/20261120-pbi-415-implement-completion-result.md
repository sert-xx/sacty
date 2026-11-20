# PBI-415 実装の実行の答えに、完了の申告を含む最後の result を使う

- 日付: 2026-11-20（UTC）
- タスク: PBI-415
- PR: なし
- ブランチ: なし
- 関係する ADR: なし（PBI-154 の方針の対象を広げただけ）

## 目的

実装の工程の実行が、完了の報告の後に背景の処理の通知へ短く返事して終わっても、報告と申告を答えとして読む。

## したこと

- `apps/daemon/src/prompts.ts`：`answerMarker("implement")` が `sacty-completion` を返す（PBI-154 の `preferResult` を実装の工程にも使う）。
- `apps/daemon/src/agents/parse.ts`：目印が `sacty-completion` のとき、`ClaudeOutcomeReader` は文字列に触れただけでなく、閉じた申告のコードブロックがある `result` を答えにする（`takeFences`。`extractCompletion` と同じ見分け方で、`~~~` と字下げも含む）。
- 仕様書 `agent-execution` の「出力の扱い」の対象の役割に、実装と最終レビュー（以前の版の役割）を足した。
- テスト：出力の読み取りの単体テスト（`agents.test.ts`）、デーモンの実装の工程が目印を渡すこと（`daemon-implement.test.ts`）。

## 決めたこと

- 閉じていない申告のコードブロックは「申告を含む」に数えない（`extractCompletion` が未完了にするため）。
