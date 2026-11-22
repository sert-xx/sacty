# CI の Playwright の準備で `--with-deps` をやめ、ブラウザだけを入れる

- 日付: 2026-11-21（UTC）
- タスク: PBI-466
- PR: #558
- ブランチ: なし
- 関係する ADR: [最小の CI を GitHub Actions で足し、main の承認数は 0 のままにする](../adr/20261112-0224-minimal-ci-without-required-approvals.md)

## 目的

CI の `npx playwright install --with-deps --only-shell chromium` は OS のライブラリを apt で入れている。利用者が 2026-11-21 に、これをやめてブラウザだけを入れると決めた。

## したこと

- `.github/workflows/ci.yml` を `npx playwright install --only-shell chromium` に変えた。
- `CONTRIBUTING.md` の CI の手順を合わせた（`--with-deps` と、ci.yml と食い違っていた `--only-shell` なしの記述を直した）。英語の版はリポジトリに無いので足していない。
- 新しい ADR は足していない。ADR は Chromium を入れることだけを決めていて、`--with-deps` には触れていない。

## 確かめたこと

変える前のジョブの時間（main への push の実行。ランナーは ubuntu-latest）：

| 実行（コミット） | Playwright の準備 | ジョブ全体 |
| --- | --- | --- |
| 44929587404（71bf18b） | 13 秒（apt は約7秒） | 約7分05秒 |
| 44926920772（64589c3） | 16 秒 | 約7分03秒 |
| 44915001427（6678c24） | 13 秒 | 約6分08秒 |

- 変える前の実行では、Chromium 用のライブラリはランナーに最初から入っていて、`--with-deps` が新しく入れたのはフォント9個（IPA ゴシック・WenQuanYi など）だけだった。
- 変えた後の CI は、この PR の実行 44972539078（先頭 969f0eb）で通った。`*.browser.test.ts` を含むテストがすべて成功し、足りないライブラリやフォントを apt で入れる必要は出なかった。時間は次のとおり。

| 手順 | 時間（UTC） |
| --- | --- |
| `npx playwright install --only-shell chromium` | 約6秒（01:40:58〜01:41:04） |
| `npx vitest run --no-file-parallelism` | 約6分（01:41:04〜01:47:04） |
| ジョブ全体 | 約6分45秒（01:40:22〜01:47:07） |

- Playwright の準備は、変える前の13〜16秒から約6秒になった。ジョブ全体の差はテストの時間のばらつきに隠れる。
- 表の3回では、テスト（vitest）の時間が約5分23秒〜6分12秒、ジョブ全体が約6分08秒〜7分05秒とばらつく。テストの時間のばらつきが、準備の差（数秒）より大きい。比べるときは準備の手順の時間を見る。
- 実行した検査：`npm run lint` は通った。`npx vitest run tests/docs` は98件が通った。`npm test`（全件）は334ファイル中16が失敗した（`packages/cli`・`tests/desktop` は `@sacty/daemon` のパッケージが見つからず、画面のテスト5ファイルはこの環境にブラウザとフォントが無いため。どれも今回の変更とは無関係）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 変えた後の時間と結果の追記、ci.yml・CONTRIBUTING.md・作業履歴の直し | 追記・直しをした |

## 残したこと

- なし。
