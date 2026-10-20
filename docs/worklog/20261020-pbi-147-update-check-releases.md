# 更新の知らせを、GitHub の main ではなく GitHub Releases の最新の版で判断する

- 日付: 2026-10-20（UTC）
- タスク: PBI-147
- PR: #164
- ブランチ: feat/pbi-147-update-check-releases
- 関係する ADR: [sacty の最新版を、動いている版と GitHub Releases の最新のリリースで比べて知らせる](../adr/20261020-0008-update-check-against-releases.md)

## 目的

1.0.0 を GitHub Releases で公開したので、更新の知らせを、`main` のコミットの比較から最新のリリースの版の比較に切り替える（PBI-135 の ADR が予定していた切り替え）。
リリースされた新しい版があるときだけ更新を勧め、更新の手順にイメージの作り直しを含める。

## したこと

- デーモン（`apps/daemon/src/update-check.ts`）：`gitHeadCommit` と比較の API を、`packageVersion`（`apps/daemon/package.json` の `version`）と最新のリリースの API
  （`/releases/latest`）に置き換えた。`parseVersion`・`compareVersions` で semver の `MAJOR.MINOR.PATCH` を数で比べる。知らせは `latest`・`current`・`releaseUrl`。
  リリースが無い（404）・取得できない・タグが版の形でない・下書き・プレリリースは黙る。間隔・OFF の振る舞いはそのまま。`main.ts` の配線を変えた。
- 画面（`apps/web`）：`DaemonStatus.update` の形、知らせの描画（最新の版と動いている版、「リリースの内容を見る」のリンク。`safeGitHubUrl`）、文言（日英）、
  更新のコマンドに `npx sacty image build` を足した。
- テスト：`update-check.test.ts`（版の読み方と比べ方、新しい・同じ・古い、本物の応答、リリース無し・取得失敗・形違い・下書き・プレリリース、版が読めないとき、
  間隔、OFF、`packageVersion`）、`daemon.test.ts`（状態の `update`）、`update-notice.test.ts`・`update-notice-live.test.ts`（画面）。
- 仕様書（`daemon-lifecycle`・`configuration`）とユーザードキュメント（`getting-started`・`config`）の日英を直し、古い ADR を superseded にして新しい ADR を足した。

## 確かめたこと

- `npm run lint`：通過（354 ファイル）。`npm run typecheck`：通過。
- `npx vitest run`：119 ファイル・2332 件が通過（`update-check.test.ts` 14 件、画面の知らせのテスト、docs のテストを含む）。
- `gh api repos/sert-xx/sacty/releases/latest` の実物の応答（v1.0.0）を、テストの「本物の応答の形」に写した。
- DA のセルフレビュー（受け入れ条件との照合）：新しい・同じ・古い・リリース無し・取得失敗・形違い・下書き・プレリリース・版が読めないときの振る舞い、
  間隔と OFF が変わっていないこと、画面の文言と更新の手順、仕様書・ユーザードキュメントの日英、ADR の置き換え。
- 実際のデーモンで、起動して知らせが出る・出ないことは手元では確かめていない（手元の版は 1.0.0 で最新のリリースと同じなので、知らせは出ないのが正しい）。
  運用の環境では、次のリリースを作ったときに、更新前の sacty の画面に「Sacty <版> がリリースされました」が出ることを確かめる。

## レビューの指摘と対応（PR #164、Codex の DA レビュー）

| 指摘 | 対応 |
| --- | --- |
| 【提案】ADR の互換性の説明が実際と違う。古い画面が新しい形の `update` を受け取ると、`behindBy <= 0` が `undefined <= 0` で偽になり、知らせが消えずに件数が undefined の文言で出る | ADR の「影響」を、正しく表示できないので画面とデーモンを同時に更新する、という説明に直した（コードは変えていない） |
