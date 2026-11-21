<!-- sacty task 4636da2f-4dc2-4bd2-b523-5e5fd3d4e7f2 の設計。sacty が作成しました。 -->

# 設計：MCP で承認待ちの成果物の「確認したいこと」を問いとして読む（PBI-475）

## スコープ

承認待ちの要求要件・設計の成果物にある「確認したいこと」を、新しい読み取りのツール `get_step_questions` で返す。
返すのは、件数と問いごとの文。
タスクの要約には、問いがあるかと件数を出す。

- 対象
  - `apps/daemon/src/step-questions.ts`：`readStepQuestions` の `counted` に、問いごとの文（`items`）を足す
  - `apps/daemon/src/task-mcp.ts`：ツール `get_step_questions`、要約の欄 `stepQuestions`、`get_task` の説明と `INSTRUCTIONS` の案内
  - 仕様書 `docs/spec/mcp-server.md`・`.en.md`、ユーザー文書 `docs/user/mcp.md`・`.en.md`、新しい ADR（日本語だけ）
  - テスト：`step-questions.test.ts`・`task-mcp-read.test.ts`（または `task-mcp.test.ts`）
- 対象外
  - 要求要件・設計のほかの工程（調査など）の成果物。PR の本文に問いを出す工程と同じ範囲にする
  - デーモンの HTTP API の追加。MCP の層が、`get_task` と同じ `GET /api/tasks/:id` の結果から読む
  - `wait_for_task` の cursor と、待ちを起こす条件
  - PR の本文の見た目と、マージの振る舞い

## 確認したいこと

- must
  - 問いごとの中身は、いちばん浅い箇条書きの1項目（入れ子と続きの行を含む）を1件の文として返し、問い・推奨の答え・理由・懸念の欄には分けない、でよいか。
    推奨：はい。成果物の書き方の決まりは「2〜3行で書く」だけで欄の札が無く、欄に分けて読み取ると外れやすいため。
    懸念：手元の AI が `recommendation` などの欄から推奨の答えを取り出す使い方を想定しているなら、AI が文から読み直す手間が残り、欄に分ける読み取りを作り直すことになる。
- should
  - 対象を要求要件・設計の工程に限り、調査の工程は入れない、でよいか。
    推奨：はい。調査の「確認したいこと」は must・should に分けないので、いつも「読み取れなかった」になり、要約にそう出続けるため。
    懸念：調査だけのタスクを承認するとき、手元の AI は問いを MCP で知れず、今と同じく `get_deliverable` で全文を読む必要が残る。

確認しないと決めたこと

- 答え方：`humanAsks.howToAnswer` と同じ分け方にする（`approval.method` が `pull_request` なら PR のコメントとマージ、`approve_step` なら `request_changes` の `comments` と `approve_step`）。そこに「答えずに承認すると推奨の答えで進む（must も同じ）」を足す。受け入れ条件 5 は PR の場合だけを挙げているが、PR の無い工程で、無い PR を案内しないため。既存の分け方で決まるので確かめない。
- 長さの上限：1件の文は 1000 文字（`humanAsks` の `text` と同じ `clip`）、件数は must・should それぞれ 20 件（`confirms` と同じ）にし、省いた件数を返す。数えられないときの節の本文は 4000 文字（`DETAIL_BODY_MAX`）。受け入れ条件 6 の「ほかの MCP の結果と同じ」に、いちばん近い前例の値を当てた。
- 秘密の値と内部のパス：伏せ直さない。読む元は `get_deliverable` と同じで、作業履歴に書く前に伏せてある。PR の本文はさらに置き換えをするが、文字を置き換えても節の形は変わらないので、件数は食い違わない。
- 要約に出す範囲：`summarizeTask` に足すので、`list_tasks`・`get_task`・`wait_for_task` の要約にも出る。読み取るのは承認待ちの要求要件・設計の成果物だけで、一覧での手間は承認待ちの件数に比例するだけなので絞らない。
- `wait_for_task` の cursor：件数を入れない。問いが変わるのは新しい提出のときだけで、そのときは状態の変化でもう待ちが起きるため。

## 既定で決めたこと

- `get_task` に欄を足さず、読み取りのツールを足す。`get_task` の結果を問いの本文で大きくしないためで、理由は ADR に書く。
- ツールの引数は `task_id` だけにする。工程と提出の回は `approval` から決め、結果に入れる。

## 構成とデータ

- `readStepQuestions` の `counted` に `items: { kind: "must" | "should"; text: string }[]` を足す。
  - `items` は、`countQuestions` が数える範囲と同じ所から作り、件数は `items` の数から出す。数え方と切り出しを1か所にまとめる。
  - `stepQuestionsLines` は `items` を使わない。
- 要約の `stepQuestions`：承認待ちで、`approval.step` が `requirements`・`design` のときだけ入れる。ほかのときは欄ごと入れない。

| `status` | `readStepQuestions` の結果 | 一緒に返す値 |
| --- | --- | --- |
| `counted` | `counted` | `must`・`should` |
| `none` | `none` | なし |
| `unreadable` | `empty`・`missing`・`uncounted` | なし |

- `get_step_questions` の結果の欄
  - `step`・`submission`・`status`・`must`・`should`
  - `questions`（`kind`・`text`）・`omittedQuestions`
  - `content`（`uncounted` のときだけ。節の本文）
  - `howToAnswer`
  - `fullText`（「全文は `get_deliverable`（step と kind `output`）で読めます」）
- ツールの説明に `READ_UNTRUSTED_NOTE` を付け、答える専用のツールは無いと書く。
  `get_task` の説明と `INSTRUCTIONS` にある「`get_deliverable` で読む」の文は、`get_step_questions` への案内に直す。

## エラー時の振る舞い

- タスクが無い・ID の形が違う：`get_task` と同じ失敗の文を返す。
- 承認待ちでない、または承認待ちの工程が要求要件・設計でない：失敗にし、「承認待ちの要求要件・設計の工程がありません」と、`get_task` の `approval` で確かめるよう案内する。
- `unreadable`：「問いは無い」とは書かず、「読み取れませんでした。全文は `get_deliverable` で読めます」と返す。

## 影響範囲

- 要約に欄が増える：`TaskSummarySchema` を使う `list_tasks`・`get_task`・`wait_for_task` の結果。
- ツールの名前の一覧を確かめるテスト（`task-mcp.test.ts`）と、仕様書・ユーザー文書のツールの一覧。
- ユーザー文書の先頭の HTML コメントに `apps/daemon/src/step-questions.ts` を足す（`tests/docs/docs.test.ts` が確かめる）。

## テスト観点

- [TV-1] must・should の札の下に箇条書きがある成果物を、問いごとに読み取れる
  - 入力：must に2項目（2項目めに入れ子の行あり）・should に1項目の「確認したいこと」がある成果物を readStepQuestions に渡す
  - 期待結果：kind が counted で must 2・should 1 になり、items が must 2件・should 1件の順で、2件めの text に入れ子の行が含まれる
- [TV-2] 札の後に文があり並びが無い問いを1件として切り出す
  - 入力：「**must**：〇〇を決めるか」の後に並びが無く、should が「なし」の成果物を readStepQuestions に渡す
  - 期待結果：must 1・should 0 で、items が must の1件だけになり、その text に「〇〇を決めるか」が入る
- [TV-3] 承認待ちの設計の問いを get_step_questions で読める
  - 入力：設計が承認待ち（approval.method が pull_request）で、must 1・should 2 の成果物を持つタスクで get_step_questions を呼ぶ
  - 期待結果：status が counted、must 1・should 2、questions が3件（kind と text）で、step と submission が approval と同じ値になる
- [TV-4] 問いが無い成果物は none を返す
  - 入力：要求要件が承認待ちで、「確認したいこと」の節が「なし」の成果物を持つタスクで get_step_questions を呼ぶ
  - 期待結果：status が none で、questions が空になる
- [TV-5] 節が無い成果物は「読み取れなかった」を返し、問いは無いと返さない
  - 入力：設計が承認待ちで、「確認したいこと」の見出しが無い成果物を持つタスクで get_step_questions を呼ぶ
  - 期待結果：status が unreadable で、結果の文に「読み取れませんでした」と get_deliverable で全文を読める旨があり、none とは返さない
- [TV-6] 形が違って数えられない節は、本文を添えて「読み取れなかった」を返す
  - 入力：設計が承認待ちで、「確認したいこと」に must・should の札が無く箇条書きだけの成果物を持つタスクで get_step_questions を呼ぶ
  - 期待結果：status が unreadable で、content に節の本文が入り、must・should の件数は入らない
- [TV-7] MCP の件数が PR の本文の件数と食い違わない
  - 入力：同じ成果物の文字列を、get_step_questions の結果と buildStepPullRequestBodyText の本文の両方に通す
  - 期待結果：PR の本文の「must N件・should M件」の N・M が、get_step_questions の must・should と同じになる
- [TV-8] 長い問いと多い問いを上限で切り、省いたことを返す
  - 入力：1件 1001 文字の問いを含み、must に 21 件ある成果物を持つ承認待ちの設計のタスクで get_step_questions を呼ぶ
  - 期待結果：1001 文字の問いは 1000 文字と「…（以下 1 文字を省略）」に切られ、must の questions は 20 件で、omittedQuestions が 1 になる
- [TV-9] 承認待ちの要求要件・設計が無いタスクは断る
  - 入力：実装の工程が承認待ちのタスクと、実行中のタスクで、それぞれ get_step_questions を呼ぶ
  - 期待結果：どちらも失敗になり、文に「承認待ちの要求要件・設計の工程がありません」と get_task の approval で確かめる案内が入る
- [TV-10] 要約に問いの有無と件数が出る
  - 入力：設計が承認待ちで must 1・should 2 のタスク、問いが「なし」のタスク、節の無いタスク、実装が承認待ちのタスクを get_task と list_tasks で読む
  - 期待結果：要約の stepQuestions が順に {status: counted, must: 1, should: 2}・{status: none}・{status: unreadable}・欄なしになる
- [TV-11] 答え方が承認の手段に合わせて結果に出る
  - 入力：設計が承認待ちで approval.method が pull_request のタスクと approve_step のタスクで get_step_questions を呼ぶ
  - 期待結果：pull_request では PR のコメントで答え、答えずにマージすると推奨の答えで進む旨が、approve_step では request_changes の comments で答え、答えずに approve_step すると推奨の答えで進む旨が howToAnswer に入る
- [TV-12] ツールの説明に、データとして扱う注意と答え方と全文の読み方が書かれている
  - 入力：get_step_questions のツールの説明と、get_task の説明・INSTRUCTIONS を読む
  - 期待結果：get_step_questions の説明に READ_UNTRUSTED_NOTE と答える専用のツールが無い旨があり、get_task の説明と INSTRUCTIONS が「確認したいこと」を get_step_questions で読むと案内する
- [TV-13] 仕様書とユーザー文書（日英）に、ツール・要約の欄・答え方・読み取れないときの扱いが書かれている
  - 入力：docs/spec/mcp-server.md・.en.md と docs/user/mcp.md・.en.md の差分を読む
  - 期待結果：get_step_questions の節（結果の欄・上限・unreadable の扱い・get_deliverable の案内）、要約の stepQuestions の行、「確認したいこと」は get_step_questions で読む旨があり、humanAsks の節の「get_deliverable で本文を読む」の文が直され、ユーザー文書の先頭の HTML コメントに apps/daemon/src/step-questions.ts がある
- [TV-14] ADR に、読み取りのツールを足した理由と MCP の層で読み取る決定が書かれている
  - 入力：docs/adr に足した ADR の差分を読む
  - 期待結果：get_task に欄を足さずツールを足した理由、readStepQuestions を MCP の層で呼びデーモンの API を足さないこと、答える専用のツールは足さないことが日本語で書かれている
