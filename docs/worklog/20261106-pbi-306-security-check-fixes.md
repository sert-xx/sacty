# セキュリティチェックの指摘のうち、今の main で再現するものを直す

- 日付: 2026-11-06（UTC）
- タスク: PBI-306
- PR: #311
- ブランチ: feat/issue-306-security-check-fixes
- 関係する ADR: [git で取得した層の extends を、ネットワークの先のリポジトリに限る](../adr/20261106-0255-limit-extends-of-fetched-layers-to-network-repositories.md)

## 目的

承認待ちのセキュリティチェックのレポート4件の指摘を、今の main で確かめ、再現するものを直す。

## したこと

- `apps/web/src/lib/audit-report.ts`：表のセルで、バックスラッシュと単独の CR も処理した（CodeQL #6）。
- `packages/core/src/github-url.ts`：URL の正規化を線形時間にした（CodeQL #14・#15）。20万文字の入力で18秒ほど止まっていた。改行の混ざった入力の結果は変えていない。
- `apps/daemon/src/gateway.ts`：メソッドを上書きするヘッダーを、`_` の綴りも含めて上流へ送らないようにした。許可リストにはしなかった。組織内 PF が使う独自のヘッダーを壊さないためである。
- `apps/daemon/src/context.ts`：git で取得した層の `extends` を、ネットワークの先のリポジトリに限った。エラーの文も、書ける形を示す文に直した。
- `apps/web/next.config.ts`：画面の応答に `frame-ancestors 'none'` を付けた。

`apps/daemon/src/prompts.ts` の表のセルの指摘は、すでに main で直っていたので変えていない。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npx vitest run`・`npm run build`
- 足したテストは、修正を戻すと失敗する。
- `apps/web/.next/routes-manifest.json` に、全パスのヘッダーの設定が入っている。
- 実際の応答のヘッダーは確かめていない（確かめるためのサーバーを起動できなかった）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| `?`・`#` の後に改行があると、以前は拒否した URL を受け付ける | 最後の行末より後ろだけを除くようにし、テストを足した |
| 単独の CR で表が崩れる | CR も空白にし、テストを足した |
| `x_http_method_override` が上流へ届く | `_` を `-` と同じに扱った |
| エラーの文が実態と合わない | 日英の文を直した |
| `headers()` のテストが無い | テストを足した |
| `user@host:path` と同じ名前のエントリがデーモンのカレントディレクトリにあると、git がローカルから読む | 直していない（残したことを参照） |
| PR のレビュー：「URL と `user@host:path` だけ」「相対パスは止まる」では、同じリポジトリの中の `./`・`../` も禁止されると読める | 制限は別リポジトリの指定に適用されると、ADR・仕様書・ユーザードキュメント（日英）・エラーの文に書いた |

## 残したこと

- `user@host:path` と同じ名前のエントリをデーモンのカレントディレクトリに置ける場合の読み取り。
- クエリの `_method` でメソッドを上書きする上流への対策。
- main のルールセットの承認数と、CI のワークフローの追加（利用者の判断待ち）。
