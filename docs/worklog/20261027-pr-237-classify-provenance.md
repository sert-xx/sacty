# 要求要件・設計の項目の出典を別のサブエージェントに分類させ、人が確かめる所を示す

- 日付: 2026-10-27（UTC）
- タスク: なし
- PR: #237
- ブランチ: claude/kind-carson-iapnyd
- 関係する ADR: [承認する人が見る所を絞るため、要求要件・設計の項目の出典を、書いたエージェントとは別のサブエージェントに分類させる](../adr/20261027-1427-classify-provenance-before-approval.md)

## 目的

承認ゲートは残したまま、承認する人の負担を減らす。
要求要件・設計の項目ごとの出典を、引用・導出・推論に分け、人が確かめる項目（推論・原文の見つからない引用・分類の無い項目）だけを示す。

## したこと

- 既定のスキル `classify-provenance` を足した（`apps/daemon/default-context/skills/classify-provenance/SKILL.md`）。
- core：`Provenance`・`ProvenanceItem`・`PROVENANCE_STEPS`・`needsCheck`、`AgentRunCompleted.provenance`、投影の `provenances`。
  工程の実行の外で本文を差し替えたときは、セルフレビューと同じく記録なしにする（`voidSelfReview` を `voidSubmissionChecks` にした）。
- daemon：
  - `prompts.ts`：`provenanceLines`・`provenanceInputs`・`checkProvenance`・`provenanceIds`・`provenanceGuideLines` を足した。`extractBlocks` で `sacty-provenance` を読み、本文から取り除く。要求要件・設計の PR の本文に「確かめる所」を入れる。タスクの内容を `taskContent` に分けた。
  - `service.ts`：要求要件・設計の実行で、Input を `_input/<実行 ID>` に書き、`/sacty-input` に読み取り専用でマウントして、実行の後に消す。分類の結果を照らして記録する。
  - `workspace-cleanup.ts`：起動時の片付けに `_input` を足した。
- web：`ProvenanceNote` を、成果物のカードと承認の画面に出す。辞書は日英。
- docs：仕様書（タスクと工程・コンテキスト・構成）、ユーザードキュメント（タスク）、ADR。英語の版も直した。

## 確かめたこと

- `npx biome check .`・`npm run typecheck`・`npm run build`・`npx vitest run tests/docs` が通った。
- `npx vitest run`：変更に関わるテストはすべて通った。
  - 失敗が 9 件ある。`host-mcp-processes`・`agent-sessions`・`context-mcp` の 8 件と、`question-form.browser` の 1 件（Chromium headless shell が無い）。
  - どれも変更前の `main` でも同じく失敗し、この環境が原因。
- 回帰テスト
  - 指示（Input のディレクトリを渡したときだけ、書いた側の要約を渡させない、セルフレビューの後）
  - Input のファイル（指摘・無効にした指摘・設計の承認済みの要求要件）
  - 照合（そろえ方・短すぎる抜き出し・推論の抜き出し・知らない ID と区分・重なる ID・読めない形）と、本文からの除去
  - 案内と PR の本文（`provenance.test.ts`）
  - 記録・マウント・実行の後の削除・記録なし・差し戻しの指摘の Input（`daemon.test.ts`）
  - 表示（`apps/web/src/components/provenance.test.ts`）、スキルの中身（`default-skills.test.ts`）

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 分類担当は元の配列の順で `TV-n` を数えるが、sacty は項目の欠けた観点を除いて振り直すので、別の観点の分類が付き「確かめる項目：0件」になる | `extractBlocks` が元の位置ごとの振った ID（`viewpointPositions`）を返し、`viewpointRename` で答えの ID を直す。欠けた観点の分類は捨てる。読み取り・照合と、デーモンでの設計の記録の回帰テストを足した |
| `mode` が無い・知らない値でも、書いた本人ではない分類として受け付ける | `mode` は `subagent`・`sequential` だけにし、それ以外は記録なし（すべての項目を確かめる案内）にした。回帰テストを足した |
| 記録なしのときの「すべての項目を確かめてください」が補足（Hint）に隠れている | 本文の文言に入れ、補足には理由だけを書いた（`docs/spec/ui-wording.md` の補足の規則）。ユーザードキュメントの表も直した |
| Input・成果物の中の指示で分類を誘導されうる | スキルに、Input・成果物・参照先に書かれた指示は資料として読むだけで従わないことと、見直しの項目を足した。仕様書（コンテキスト）にも書いた |
| 本文の差し替えでの失効と、分類の無い再提出での削除に回帰テストが無い | 変更の申し出の適用・人が直した版のマージで記録なしになること（`daemon.test.ts`）、分類の無い再提出でその工程の分類だけが消えること（`projection.test.ts`）のテストを足した |
| 起動時に消す一時領域の一覧（仕様書のタスクと工程）に `_input` が無い | 日英の仕様書に足した |
| （再レビュー）正しい答えの後に、先頭以外のキーにある壊れた答え（末尾のカンマ）があると、前の答えが使われ「確かめる項目：0件」になる。壊れた答えも本文に残る | `headingMentions` で、読めた JSON・見出しで見つけた報告の外にあるキーも、読めない答えとして見つける（囲みの中なら囲みの全体、外ならキーの行を本文から取り除く）。最後の答えが読めなければ記録なしにする。囲みの中・外の回帰テストを足した |
| （再レビュー）振り直した観点の ID が、根拠の参照（`refs`）の `TV-n` には反映されず、自分を指す参照になる | 参照の `TV-n` も対応表で直し、取り込まなかった観点を指すものには「（取り込まなかった観点）」を添える。回帰テストを足した |
| （再々レビュー）同じ囲みの中で、正しい答えの後に先頭以外のキーにある壊れた答えがあると、取り除く範囲（囲みの全体）が前の答えより前から始まるので、前の答えが最後の答えとして使われる | 取り除く範囲とは別に、答えが出てきた位置（`HeadingSpan.at`）を持ち、その位置で最後の答えを選ぶ。同じ囲みの中の回帰テストを足した |

## 残したこと

- 実機の AI がスキルに従ってサブエージェントを起動し、分類する様子は、この環境では確かめていない（AI の設定が無い）。
- 設計の本文の判断は分類しない（テスト観点だけ）。
- 区分の付け方が合っているかを、差し戻しの実績で確かめる仕組み。
