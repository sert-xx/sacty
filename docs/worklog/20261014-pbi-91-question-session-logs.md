# オーケストレーターへの質問で、各実行のセッションログの原本を調べられるようにする

- 日付: 2026-10-14（UTC）
- タスク: PBI-91
- PR: #95
- ブランチ: feat/issue-91-question-session-logs
- 関係する ADR: [質問の答えでセッションログを読み取り専用で読ませる](../adr/20261014-1445-superseded-question-reads-session-logs.md)

## 目的

「オーケストレーターに質問」の答えを作るときに、台帳だけでなく、そのタスクの各実行（工程のエージェント・オーケストレーター自身・
ゴールガーディアン・これまでの質問への答えなど。Claude Code・Codex の両方）のセッションログの原本を調べられるようにする。
ログは指示に丸ごと入れず、探して読める形で読み取り専用で渡し、ほかのタスクのログ・ログ以外のファイルには触れさせない。秘密の値は
これまでの伏せ字のまま出さず、ログの無い・切り詰めた・読めない実行があっても答えを作る。費用はこれまでどおりタスクの予算に入れる。

## したこと

- `apps/daemon/src/question-logs.ts`（新規）：`stageQuestionLogs` で、タスクの `runs/<タスク ID>/` から終わった実行の `meta.json`・
  `events.jsonl`・`stderr.log` と、作業履歴の `AgentSessionArchived` に記録したエージェントのファイル（記録と大きさが同じ通常のファイル
  だけ）を、答えの実行ごとの場所に並べる（ハードリンク、できなければ写す）。実行の一覧（状態 `available`・`unfinished`・`missing`・
  `unreadable`、役割と何回目か、切り詰め、エージェントのファイルの件数、並べられなかったファイル）を返し、`index.json` に書く。
- `apps/daemon/src/session-logs.ts`：`SessionLogStore` に `taskDir`・`metaPath` を足した。
- `apps/daemon/src/service.ts`：`answerQuestion` で、答えの実行の前にログを並べ、`/sacty-logs` に読み取り専用でマウントし、終わったら
  消す。並べられなければ、ログを読めないことを指示に書いて答えさせる。`runGuardian`・`ExecuteRun` に `mounts`・`readDirs` を通した。
- `apps/daemon/src/agents/invocation.ts`：作業領域の外で読ませる場所（`readDirs`）を、Claude Code には `--add-dir` で渡す。
- `apps/daemon/src/prompts.ts`：`buildChatPrompt` に、ログの置き場所・読み方と実行の一覧（`CHAT_LOGS_IN_PROMPT` = 8000 文字まで。
  超えたら古い実行を省く）の節を、台帳の前に足した。
- 仕様書（`docs/spec/tasks-and-steps.md`・`docs/spec/agent-execution.md`）とユーザードキュメント（`docs/user/tasks.md`）を直し、ADR を足した。

## 確かめたこと

- `npm run lint`（終了コード 0）・`npm run typecheck`・`npx vitest run`（全件成功）・`npm run build`・`npx vitest run tests/docs`。
- 足したテスト：
  - `apps/daemon/src/question-logs.test.ts`：このタスクの終わった実行のログと記録したエージェントのファイルだけを並べ、ほかのタスクの
    ログ・記録の無いファイル（認証の写し）・ログ以外のファイル・リンクは並べない。伏せた後の中身である。終わっていない・ログの無い・
    記録を読めない・間を省いた・記録と大きさの違うファイルを一覧に出す。ID の形が違うタスクは探さない。
  - `apps/daemon/src/daemon.test.ts`：工程のエージェントの元のファイルにだけ書いたコマンドを、マウントされたログから探して答えられる。
    マウントは読み取り専用で、ほかのタスクの実行・秘密の値（`oauth-secret`）は含まない。答えの費用がタスクの予算に入る。並べた場所は
    答えの後に消える。オーケストレーター自身と前の質問への答えの実行も、始めた順・何回目かが分かる形で一覧に出る。ログを用意できない・
    残していないときも、台帳から答えて、読めないことを指示に書く。
  - `apps/daemon/src/prompts.test.ts`：一覧の行の形（状態ごとの文）、実行が多くても上限に収め新しい実行を残すこと。
  - `apps/daemon/src/agents/agents.test.ts`：Claude Code には `--add-dir` を足し、Codex には足さない。
- 修正を戻したときにテストが落ちることを確かめた：終わっていない実行も並べる・エージェントのファイルを並べない／大きさを確かめない・
  マウントを読み書きにする／並べた場所を消さない。
- 確かめていないこと：実際の Claude Code・Codex が `/sacty-logs` を探して読んで答えること（認証のある実際の AI では動かしていない）。
  画面の変更は無い。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| [P2] タスクのログの場所を開けない（EACCES・ENOTDIR など）ときも握りつぶし、作業履歴にある実行を `missing` と記録したうえ、ログを用意できたものとして `/sacty-logs` をマウントする | 場所が無い（ENOENT）ときだけ実行の無いタスクとし、ほかの失敗は投げるようにした。呼ぶ側はマウントせず、読めないことと理由（エラーの種類）を指示に書いて台帳から答えさせる。同じ握りつぶしを探し、`meta.json` の lstat の失敗（ENOENT 以外）は読めない記録に、`events.jsonl`・`stderr.log` の有無の確かめ（`existsSync` はどの失敗も「無い」にする）は、ENOENT 以外なら読めないファイルにした。回帰テスト：`question-logs.test.ts`（ディレクトリでない・権限が無いと投げる。無いときだけ `missing`）、`daemon.test.ts`（場所がファイルになったタスクで質問すると、マウントせず `ENOTDIR` を伝えて答える）。修正を戻すと2件が落ちることを確かめた |

## 残したこと

- 実行中の工程のログは、終わるまで読めない（閉じる前のファイルには、後から分かった秘密情報が残りうるため）。
- デーモンが答えの途中で落ちたときに残る `_question-logs/` の掃除はしない（ほかの使い捨ての場所と同じ）。
