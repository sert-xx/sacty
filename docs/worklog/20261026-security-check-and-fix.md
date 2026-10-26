# セキュリティチェックとセキュリティ対応の進め方を足す

- 日付: 2026-10-26（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/fervent-cori-xrvo95
- 関係する ADR: [セキュリティチェックとセキュリティ対応を、既存の工程の組み合わせとして足し、対応の差分を修正の範囲と照らして最小限に保つ](../adr/20261026-1520-security-check-and-fix-plans.md)

## 目的

脆弱性・サプライチェーン攻撃への備えとして、セキュリティチェック（成果物はレポート）とセキュリティ対応（成果物は PR）を sacty で扱えるようにする。
対応は、チェックのレポートからも、特定の問題から直接でも始められ、PR は問題を解消する最小限の変更にする。

利用者と決めたこと：

- 公開リポジトリへの PR は、特に止めずに作る。
- 修正の範囲の宣言は承認しない（最終的な PR で確かめる）。
- 対応のタスクは、レポートの区分（依存の脆弱性・サプライチェーンなど）ごとに分ける。
- 既定のイメージに検査の道具を足してよい。

## したこと

- 組み合わせ `security-check`（`investigate`）と `security-fix`（`investigate` → `implement` → `deployment`）を足した（`packages/core/src/events.ts`）。
  どちらもリポジトリが要る組み合わせ（`REPO_PLANS`）にし、リポジトリの無いタスクで `security-check` を選んだときもリポジトリを選ばせる。
- 指示（`apps/daemon/src/prompts.ts`）
  - 進め方の説明と選び方に2つを足した。セキュリティの問題を直す依頼は、規模にかかわらず `security-fix` を選ばせる。
  - 調査で、検査の道具を実行させ、秘密情報の値と悪用の手順を書かせない（`SECURITY_TOOL_LINES`）。
  - チェックは区分ごとに点検させ、`sacty-security-findings` の JSON で指摘を出させる（`securityCheckLines`）。
  - 対応の前段の調査で、`sacty-security-scope` の JSON で修正の範囲を宣言させる（`securityScopeLines`）。
  - 対応の実装に、最小限の変更の決まりと範囲を渡す（`securityFixImplementLines`）。
  - 最終レビューに観点 `SEC-MIN` を足し、範囲の違反を伝える（`securityFinalReviewLines`・`finalReviewVerdictIds`）。
  - 実装の PR の本文の目的の節を「修正の範囲」にする（`securityScopeBodyLines`）。
- 範囲の照合（`apps/daemon/src/security.ts` の `scopeViolation`）を、検証の最終レビューの前に当てる（`verify`）。違反があれば `SEC-MIN` を不合格にする（`extractFinalReview`）。
- レポートの区分から対応のタスクを作る `POST /api/tasks/:id/security-fixes` と、指摘を返す `GET /api/tasks/:id/security-findings` を足した。
  `SecurityFixRequested` を記録してから作り、起動のときに作り直す（`resumeSecurityFixTasks`）。
- セキュリティのタスクの成果を、取り込み元の Issue・チケットにコメントせず、PR・Issue へのコメントの頼みも投稿しない。
- テンプレート `security-check` を足した（進め方を `security-check` に決める）。
- 画面：作成のダイアログのテンプレートと進め方、タスクの詳細の「セキュリティ対応」の欄（`SecurityFixesCard`）、作業履歴の行、日英の文言。
- 既定のイメージに osv-scanner（v2.7.0）と gitleaks（v8.30.1）を足した（`packages/cli/docker/install-security-tools.sh`）。
  - 版はタグを `git ls-remote` で、添付物とハッシュのファイルの名前はそれぞれの `.goreleaser.yml` で確かめた。
  - このセッションからはリリースの添付物を取得できず、ハッシュをこのリポジトリに固定できなかった。そのため、同じリリースのハッシュのファイルで確かめる形にした（ADR の理由）。
- docs：仕様書（タスクと工程・取り込み・マージの後の監視・エージェントの実行）、ユーザードキュメント（タスクを進める・設定・イメージ）を日英で直し、作成のダイアログのスクリーンショットを撮り直した。

## 確かめたこと

- `npm run lint`：通った。
- `npm run typecheck`：通った。
- `npm run build`：通った。
- `npx vitest run`：足したテストを含めて通った。ただし、次の9件は、このコンテナ（root で動き、ブラウザーのテストの環境が無い）で、変更の前のコミットでも同じように失敗することを確かめた。
  - `apps/daemon/src/agent-sessions.test.ts`（読めないファイル）
  - `apps/daemon/src/context-mcp.test.ts`（層の写しの失敗）
  - `apps/daemon/src/host-mcp-processes.test.ts`（プロセスの後始末の6件）
  - `apps/web/src/components/question-form.browser.test.ts`
- 足したテスト
  - `apps/daemon/src/security.test.ts`：指摘・範囲の読み取り、差分の行の数え方、パスの当て方、範囲の違反（テストのファイル・ロックファイルの扱い）、`SEC-MIN` の不合格、対応のタスクの説明、PR の本文。
  - `apps/daemon/src/daemon.test.ts`：テンプレートで進め方が決まること、Issue に返さないこと、区分ごとに1回だけ作ること（再起動しても重ねない）、範囲の中・外の差分の最終レビュー。
  - `apps/web/src/app/actions.test.ts`：区分を渡して作る・知らない区分を断る。
- 範囲の照合と、Issue に返さない処理を外すと、それぞれのテストが失敗することを確かめた。
- `npx vitest run tests/docs`：通った。
- `install-security-tools.sh` は `sh -n` で構文だけを確かめた。イメージのビルドは、このセッションでは Docker が無いので確かめていない。
- スクリーンショットは、このセッションの Chromium で撮ると、変えていない画面も描画の違いで変わるので、作成のダイアログ（日英）だけを差し替えた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 変えた行の数の上限（300 行）を設定で変えられるようにすること。
- ロックファイルの中身が範囲の依存だけかを、sacty が機械的に確かめること（今はゴールガーディアンが判定する）。
- Dependabot・code scanning のアラートの取り込み。
- マージの後の監視が作る修正のタスクに、セキュリティ対応の決まりを引き継ぐこと。
- osv-scanner・gitleaks のハッシュを、このリポジトリに固定すること。
