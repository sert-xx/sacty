# デーモンのテストを題材ごとのファイルに分け、不安定な gh の中断のテストを直す

- 日付: 2026-11-16（UTC）
- タスク: PBI-359
- PR: #392
- ブランチ: feat/issue-359-split-daemon-tests
- 関係する ADR: なし

## 目的

- `apps/daemon/src/daemon.test.ts` は 2,167,462 バイトで、lint（Biome）の大きさの上限（`biome.json` の `files.maxSize`。2,097,152 バイト）を超えていた。
  Biome は、上限を超えたファイルを、警告だけ出して検査から外す（終了コードは 0）。いちばん大きいテストファイルが、lint の検査を受けていなかった。
- テストの中身・件数を変えずに、題材ごとのファイルに分ける。どのファイルも上限に余裕がある。上限は上げない。
- 今後、上限を超えたファイルが検査から外れたら、CI が落ちるようにする。
- あわせて、CI で1回落ちた `apps/daemon/src/gh.test.ts` のテストを直す（PBI-361）。
  「中断されたら、gh が起動したプロセス（認証の補助など）も、プロセスグループごと止める」が、`expected 0 to be greater than 0` で落ちた。

## したこと

### テストを分けた（PBI-359）

- `daemon.test.ts` の 75 個の `describe` を、題材ごとの 13 個のファイル（`apps/daemon/src/daemon-<題材>.test.ts`）に移した。
  `describe` の中身は、1 行も変えていない。`describe` をまたいで分けてもいない。どのファイルに何を置くかは、`CONTRIBUTING.md` の表に書いた。
- 共通の準備（偽の GitHub・偽のリポジトリ・偽のエージェントの実行と、それらを組んだサービスを作る `makeService` など 31 個）は、
  `apps/daemon/src/testing/daemon.ts` に出した（`src/testing` は、ビルドの対象から外している既存の置き場）。中身は変えず、`export` を付けた。
  - テストごとの作業用のディレクトリ（`dir`・`dbPath`）を作る・消す処理は、`useTempDir()` にして、各テストファイルの先頭で呼ぶ。
    元は、ファイルの直下の `beforeEach`・`afterEach` だった。読み込んだだけで登録される形にしなかったのは、どのファイルが使うかを見えるようにするため。
- 消すのを失敗させる差し替え（`node:fs` の `rmSync`・`node:fs/promises` の `rm` の `vi.mock`）は、中身を `apps/daemon/src/testing/failing-removal.ts` に出した。
  - `vi.mock` は、書いたファイルの読み込みより前に効かせる必要があるので、共通の場所には置けない。使うテストファイルに書く。
  - 使っているテストは 3 件（エラーの分析の後始末 2 件・引き継ぎのファイルの後始末 1 件）で、どれも `daemon-orchestrator-sessions.test.ts` にある。
    ほかの 12 ファイルには、差し替えを書いていない。元は全テストに差し替えが掛かっていたが、失敗させる場所を指定しない限り本物に渡すだけなので、振る舞いは同じ。
- 分けるのは、1 回きりのスクリプトで行った（リポジトリには入れていない）。
  ヘッダー（最初の `describe` の前）と各 `describe` を行で切り出し、どの `describe` も 1 回だけ割り当てたことを確かめてから書き出す。
  各ファイルの `import` は、元の `import` を全部付けてから、Biome で使っていないものを落とした（`biome lint --only=correctness/noUnusedImports --write --unsafe`）。
  その後、`biome check --write` で整形した。

分けた後の大きさ（上限 2,097,152 バイトに対する割合）：

| ファイル | バイト | 割合 |
| --- | --- | --- |
| `daemon-implement.test.ts` | 590,712 | 28% |
| `daemon-step-pull-requests.test.ts` | 265,276 | 13% |
| `daemon-orchestrator-sessions.test.ts` | 169,196 | 8% |
| `daemon-steps.test.ts` | 142,778 | 7% |
| `daemon-projects-intake.test.ts` | 132,379 | 6% |
| `daemon-audit-memory.test.ts` | 128,518 | 6% |
| `daemon-deliverables.test.ts` | 123,183 | 6% |
| `daemon-task-lifecycle.test.ts` | 118,312 | 6% |
| `daemon-split.test.ts` | 116,212 | 6% |
| `daemon-context.test.ts` | 114,459 | 5% |
| `daemon-repoless.test.ts` | 90,592 | 4% |
| `daemon-deployment-security.test.ts` | 74,961 | 4% |
| `daemon-api-settings.test.ts` | 40,933 | 2% |
| `testing/daemon.ts` | 74,429 | 4% |

### 上限を超えたら CI が落ちるようにした

- `npm run lint` を `biome check --error-on-warnings .` にした。CI は `npm run lint` を実行するので、上限を超えたファイルの警告で落ちる。
- 警告になる lint の規則が今後増えたときも、失敗になる（今は、警告は 0 件）。`CONTRIBUTING.md` に書いた。

### gh の中断のテストを直した（PBI-361）

- 原因：テストは、gh の代わりのシェルが PID を書くファイルが「できる」のを待ってから読んでいた。
  シェルの `echo $! > ファイル` は、ファイルを作ってから中身を書くので、できた直後は空のことがある。空を読むと `Number("")` が 0 になる。
- 直し：PID を書き終える（数字と改行）まで待ってから進む。待ちは、既存の `testing/wait.ts` の `waitFor` を使った。
  来なければ、何を待っていたかを書いたエラーで、テストの時間切れより前に落ちる。
- 本体のコード（`gh.ts`）は変えていない。
- 同じ形（ファイルができるのだけを待って、中身を読む）を、テストの全体で探した。ほかには無かった。見たもの：
  - `ready` のファイルを待つテスト（`session-logs.test.ts`・`agent-sessions.test.ts`・`agents/agents.test.ts`）：`touch` で作る合図で、中身を読まない。
  - `drawio-shim.test.ts`：PID が 0 でなくなるまで読み直している。
  - `context-fetch-exit.test.ts`・`daemon-context.test.ts`：PID が 2 行そろうまで待っている。
  - `agents/output-relay.test.ts`：PID を書いたコマンドが終わった後に読んでいる。

## 確かめたこと

- テスト名の一覧と件数（`npx vitest list <対象> --json`。分ける前は `daemon.test.ts`、分けた後は 13 ファイル）：
  分ける前 1,186 件／分けた後 1,186 件。名前の一覧（並べ替えて比較。重複も数える）が一致。消えた 0 件・増えた 0 件。
- 実行した結果（`npx vitest run --no-file-parallelism <対象> --reporter=json`。`it.each` などを開いた後の件数）：
  分ける前 1,234 件（成功 1,234）／分けた後 1,234 件（成功 1,234）。名前と結果の一覧が一致。
  テストの時間の合計は、分ける前 42.6 秒／分けた後 40.9 秒。
- 中身：最初の `describe` 以降の、空行を除く行を、分ける前と後で数えて比べた。43,483 行で、数が違う行は 0。
- 検査に入ったことで出る lint の指摘：0 件（`npx biome check` が、分けた 13 ファイルと共通の準備を検査して、指摘なし）。
- 上限を超えたファイルで落ちること：2,256,022 バイトのファイルを一時的に置いて、
  `biome check`（今まで）は終了コード 0、`biome check --error-on-warnings` は終了コード 1。消すと 0。
- gh の中断のテスト：
  - 直す前の形が落ちること：シェルを「空のファイルを作る→0.3 秒待つ→PID を書く」に変えた写しで実行した。
    直す前の待ち方は CI と同じ `expected 0 to be greater than 0` で落ち、直した待ち方は通った（写しは消した）。
  - 繰り返し：`npx vitest run apps/daemon/src/gh.test.ts -t "プロセスグループごと止める"` を、型検査・ビルドと並行して 60 回。成功 60・失敗 0。
- 差し替え（`vi.mock`）が効いていること：`daemon-orchestrator-sessions.test.ts` の `vi.mock` を一時的に外すと、消すのを失敗させる 3 件が落ちる（戻した）。
- `npm run typecheck`：成功。
- `npm run build`：成功。
- `npx vitest run --no-file-parallelism`：成功（238 ファイル。4,589 件成功・1 件スキップ。270 秒）。分けた 13 ファイルと `gh.test.ts` は、並列（`npx vitest run <対象>`）でも成功（1,241 件）。
- `npm run lint`：手元では、Git で管理していない `.claude/settings.local.json`（手元だけのファイル）の整形の指摘 1 件で失敗する（この変更の前から）。
  このファイルを除いた `npx biome check --error-on-warnings apps packages tests scripts docs *.json *.md .github` は、指摘なしで成功。大きさの警告は出ない。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 1 回目（提案あり・マージは可）：`packages/core/src/projection.test.ts` のコメントが、消した `daemon.test.ts` を指している | 移動先の `daemon-implement.test.ts` に直した。`daemon.test.ts` を名指ししている場所は、過去の作業履歴（直さない決まり）のほかには、ここだけだった |
| 1 回目：作業履歴の `describe` の個数が 76 個になっている（正しくは 75 個） | 数え直した（分ける前 75 個・分けた後の 13 ファイルの合計 75 個）。作業履歴と PR の本文を 75 個に直した |

## 残したこと

- `daemon-implement.test.ts` は 1 つの `describe`（359 件）で、590,712 バイト（上限の 28%）。`describe` の中をさらに分けることはしていない（テストの中身に触れずに分ける、という範囲のため）。
- テストの中身の見直し・重複の整理。
- gh の中断のテストの後半（プロセスが消えるのを、20 ミリ秒おきに 100 回まで待つ）は、落ちた原因ではないので変えていない。
