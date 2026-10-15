# コントリビュートの仕方

sacty への Issue・Pull Request（PR）を歓迎する。ドキュメント・コミット・PR は日本語で書いている。

## 始める前に

- バグの報告・機能の提案は、まず [Issue](https://github.com/sert-xx/sacty/issues) で知らせる。大きな変更は、PR の前に Issue で
  方向を相談すると、手戻りが少ない。
- 脆弱性は Issue に書かず、[セキュリティ](SECURITY.md) の手順で報告する。
- 寄せた変更は、このリポジトリの [ライセンス](LICENSE)（MIT）で公開される。

## 開発の環境

macOS・Node.js 22.13 以上・Docker・GitHub CLI（`gh`）が要る（[はじめに](docs/user/getting-started.md)）。

```sh
npm ci
npm run build
```

## 変更の流れ

1. `main` から作業用のブランチを切る（例 `feat/issue-<番号>-<内容>`・`fix/<内容>`）。`main` に直接コミットしない。
2. 変更する。実装を変えたら、同じ PR で docs を直す（下の「ドキュメント」）。
3. 下の「PR を出す前に確かめること」をすべて通す。
4. PR を出す。PR の本文には、何をなぜ変えたか・確かめたこと（コマンドと結果）・確かめていないことを書く。関係する Issue が
   あれば `Closes #<番号>` で結ぶ。

コミットのメッセージは `feat:`・`fix:`・`docs:`・`chore:` などの種類で始め、内容を1行で書く（例 `fix: 〜のときに〜する`）。

## PR を出す前に確かめること

```sh
npm run lint        # Biome（整形と lint）。整形は npm run format で直せる
npm run typecheck   # TypeScript の型検査
npx vitest run      # テスト（docs の規則のテストを含む）
npm run build       # すべてのパッケージのビルド
```

- 振る舞いを変えたら、テストを足すか直す。直したテストは、変更を戻すと失敗することも確かめる。
- docs だけを変えたときも、`npx vitest run tests/docs` で docs の規則（ファイル名・リンク切れ・ADR の置き換えの関係）を確かめる。

## ドキュメント

docs は4種類（仕様書・ユーザードキュメント・ADR・作業履歴）に分けて `docs/` に置き、種類ごとにメンテナンスの方針が違う。
方針は [docs の入口](docs/README.md) にある。要点は次のとおり。

- 実装の振る舞いを変えたら、同じ PR で [仕様書](docs/spec/README.md) を直す。利用者に見える変更（設定・コマンド・画面・既定値・
  エラーの文言）なら [ユーザードキュメント](docs/user/README.md) も直す。
- 方針や仕様を決めた・変えたら、[ADR](docs/adr/README.md) を足す。古い ADR の本文は書き換えない。
- タスク（PR）ごとに [作業履歴](docs/worklog/README.md) を足す。
- 公開リポジトリなので、特定の組織や勤め先の内部を指す語・その組織の名前・秘密の値（トークン・パスワード・鍵）・個人の情報を、
  コード・テスト・docs・コミット・PR に書かない。例の値は `example.com`・`acme` のような架空のものにする。

AI のエージェント（Claude Code・Codex）で作業するときは、同じ方針をスキル（`.claude/skills/sacty-docs/`・
`.agents/skills/sacty-docs/`）として置いている。
