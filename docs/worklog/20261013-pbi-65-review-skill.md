# 既定のコンテキストに、観点ごとのサブエージェントで見落としを防ぐレビュースキルを同梱する

- 日付: 2026-10-13（UTC）
- タスク: PBI-65
- PR: #72
- ブランチ: feat/issue-65-review-skill
- 関係する ADR: [スキルをグループのディレクトリにまとめて置けるようにし、名前で扱う](../adr/20261014-0034-skill-groups.md)、[既定のコンテキストに、観点ごとのサブエージェントを並列に起動して集約するレビュースキル（親と担当を別のスキル）を同梱する](../adr/20261014-0034-review-skill-subagents.md)、[レビューの工程では、PR の差分の全体を切り詰めずに sacty が管理する場所に置き、読み取り専用でマウントして渡す](../adr/20261014-0034-review-diff-readonly-mount.md)

## 目的

単一のエージェントのレビューは、対象が大きい・観点が広いと見落とす。親が観点ごとのサブエージェントを並列に起動して集約する
レビュースキルを既定のコンテキストに同梱し、どのプロジェクトのレビューの工程でも使えるようにする。

## したこと

- スキルの探索：`apps/daemon/src/context.ts` で、`SKILL.md` の無いディレクトリをグループとして再帰的に探し、名前で扱うようにした。
  worker にはグループを外して置き、同じ層の同じ名前は先のものを使って `context.duplicateSkill` の警告を残す。
- スキル：`apps/daemon/default-context/skills/review/` の下に `review-dispatch`（親。流れ・主対象の種類の判定・観点の起動の規則・
  依頼文・逐次モード。references に観点カタログ・自己レビュー・PR レビュー・集約・担当の出力の形式）と `review-execution`
  （観点担当。観点の外は指摘しない・根拠を添える・共通の JSON の出力。references に 30 観点の資料）を置いた。
- 役割の混線を止める：スキルの説明文・冒頭の判定の表・依頼文の禁止の行。`apps/daemon/default-context/agents/codex/config.toml` で
  Codex のサブエージェントを有効にし、`max_depth = 1` にした。
- レビューの差分：`apps/daemon/src/repository.ts` の `diffCommits` に `full` を足し、`apps/daemon/src/service.ts` でレビューの工程の
  差分の全体を `_review/<runId>/pr.diff` に置く。`apps/daemon/src/agents/invocation.ts`・`docker.ts` に追加の読み取り専用マウントを足し、
  `/sacty-review` に渡す。`apps/daemon/src/prompts.ts` でその場所を伝える。
- 既定のコンテキストと雛形の README・雛形のテストを、既定のスキルが置かれる前提に更新した。

## 確かめたこと

- 階層のスキルのテストを足した（グループの下のスキルが名前で扱われる・下位の層がグループの外から上書きできる・重なりは警告・
  worker には `skills/<名前>/` で置かれ Codex の AGENTS.md の一覧に載る）。
- `npx biome check apps packages`：問題なし（`npm run lint` は `.claude/worktrees/` 内の biome.json で止まるため、対象を絞って実行した）。
- `npx vitest run`：すべて通った。既定の Codex の設定のテストは、`[features]`・`[agents]` を含む期待値に更新した。
- レビューの対応の後、全 724 件、さらに全 725 件のテスト・型検査・`biome check` が通った。
- 差分のテスト：`repository.test.ts`（実 git で、既定では後ろのファイルの差分が消え、`full` では含まれる）、`daemon.test.ts`
  （マウントの場所が `_review` の下・読み取り専用・写しに `.sacty` が無い・実行後に消える・プロンプトの案内）、`prompts.test.ts`（切り詰めの文）。
- 確かめなかったこと：worker が実際にサブエージェントを起動する様子、実際の Docker でのマウント。動作の動画は無い。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| [P2] 作業領域は `.git` の無い写しなので、プロンプトで切り詰めた差分の残りを worker が `git diff` で取れない | 差分の全体をファイルで置いてプロンプトで場所を伝え、`pr-review.md` の取得の順を git を前提にしない形にした |
| [P2] サブエージェント無しの代替手順が、担当の冒頭の判定・「途中で役割を変えない」と循環する | `review-dispatch` に逐次モード（依頼文を先に書き、宣言して担当に切り替え・親に戻る）を足し、役割の表の唯一の例外として明記した。`review-execution` の判定でも親が自分のために書いた依頼文を認めた |
| [P1] 写しの中の `.sacty/pr.diff` への書き込みが、PR 由来のシンボリックリンクをたどってホストのファイルを上書きできる | 写しの中には書かず、sacty が管理する `_review/<runId>/pr.diff` に置き、`Invocation.mounts` で `/sacty-review` に読み取り専用でマウントし、実行後に消すようにした |
| [P2] `diffCommits` が 20 万文字で切り詰めるので、ファイルの差分が全体になっていない | `diffCommits` に `full` を足し、レビューの工程では切り詰めずに取るようにした。既定の振る舞いは変えていない |

再レビューで、指摘の解消が確かめられた（追加の指摘は無し）。

## 残したこと

- 利用者の環境で確かめること：レビューの工程で、親が `review-dispatch` を読んでサブエージェントを起動し、担当が `review-execution` だけを
  読み、投稿の本文に「レビューの範囲」の折りたたみが付くか。Codex の `[features] multi_agent = true` が版によって既定で有効でも、
  二重に書いて害が無いか。
- sacty のレビューの工程は、再レビューでも前回のレビューと前回以降の差分をプロンプトに渡していない。スキルの再レビューの規則を生かすには
  sacty 側の改善が要る。
