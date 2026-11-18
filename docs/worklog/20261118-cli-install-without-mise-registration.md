# sacty コマンドの入口を mise に登録するのをやめ、いつも ~/.local/bin などに置く

- 日付: 2026-11-18（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/magical-meitner-j348hd
- 関係する ADR: [sacty コマンドの入口を mise に登録するのをやめ、いつも ~/.local/bin などに置く](../adr/20261118-1322-cli-install-without-mise-registration.md)

## 目的

mise を使う環境で、`npm run cli:install` の入れ方（入口を `mise link` と `mise use --global` で mise に登録する）がうまくない、とリポジトリの持ち主から報告があった。
持ち主が検討していた、mise の設定の `_.path` にリポジトリの `bin` を足す案と比べたうえで、mise に登録せず、いつも `~/.local/bin`（`SACTY_BIN_DIR` があればそこ）に入口を置くことにした。

## したこと

- `scripts/cli-install.mjs`：mise に登録する処理（`useMise`・`miseToolDir`・`installWithMise`・`checkMise`）を消し、いつも `launcherDir` の場所に入口を置くようにした。
  前の版が mise に登録した sacty を外す処理（`legacyMiseRoot`・`removeMiseRegistration`）を足した。入口を置いた後に行い、外せなければ注意を出して続ける。
- `tests/scripts/cli-install.test.ts`：消した関数のテストを消し、外す処理のテストを足した。
- 仕様書（`docs/spec/architecture.md` と英語の版）・ユーザードキュメント（`docs/user/getting-started.md` と英語の版）を、今の動きに合わせた。
- ADR を足し、前の ADR を、一部の置き換えとして `superseded` にした（本文は書き換えていない）。名前の変更で切れるリンク（前の ADR を指す ADR と作業履歴）を直した。

## 確かめたこと

- `npx vitest run tests/scripts/cli-install.test.ts`：通った。
- `npm run lint`・`npm run typecheck`・`npx vitest run tests/docs`：通った。
- `npm test`：5 ファイルの 8 件が失敗した（`apps/daemon/src/agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts`、`apps/web/src/components/question-form.browser.test.ts`・`shell/menus.browser.test.ts`）。
  この変更を外した状態でも同じ 8 件が失敗した。確かめた環境の Node.js は 22.23.5 で、リポジトリが求める版（26.13.1）ではない。失敗の原因は調べていない。
- 仮のホームと偽の `mise`（受けた引数を記録し、`where` で登録のリンクの場所を返すもの）で `node scripts/cli-install.mjs` を実行した。
  - 前の版の入口のディレクトリがあるとき：`~/.local/bin/sacty` に入口が置かれ、`mise where sacty@<版>`・`mise unuse --global sacty` が呼ばれ、登録のリンクと前の版の入口のディレクトリが消えた。置いた入口の `sacty --version` は、別のディレクトリからでもリポジトリの版を出した。
  - mise も前の版の入口も無いとき：`~/.local/bin/sacty` に入口が置かれ、`PATH` に無いことの注意が出た。
- 確かめられなかったこと：実際の mise での動き（この環境に mise を入れられなかった。配布元への通信が通らない）。`mise unuse --global sacty` が `mise link` で登録した道具を外せるかは、確かめていない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし（レビューの前） | なし |

## 残したこと

- 実際の mise で、前の登録が外れることを確かめる。
