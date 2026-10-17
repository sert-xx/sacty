**日本語** | [English](memory.en.md)

# メモリー

完了したタスクの監査が、次のタスクにも役立つ知見をメモリーとして登録する。工程のエージェントは、タスクのプロジェクトと対象リポジトリの
メモリーを、索引から関係するものだけ読む。登録するのは監査だけで、人は誤ったメモリーを消せる。

関係する ADR: [監査が登録したメモリーを、作業履歴を正本にして、スキルの索引の形で書き出す](../adr/20261018-0130-audit-memory.md)

## 階層と置き場所

- 階層はプロジェクトとリポジトリの2つ（グローバルの階層は持たない）。どちらも `SACTY_HOME/memory` の下に置く。

| 階層 | 置き場所 | 中身 |
| --- | --- | --- |
| プロジェクト | `memory/projects/<プロジェクトの ID>/` | そのプロジェクトのタスクで得た知見 |
| リポジトリ | `memory/repos/<ホスト>/<オーナー>/<名前>/` | そのリポジトリそのものに関する知見。プロジェクトの外に置き、プロジェクトの設定を変えても使い続ける |

- リポジトリの階層の鍵は、`.git` の無い GitHub のリポジトリの URL を小文字にそろえたもの（clone の URL・SSH の形も読む）。GitHub の
  リポジトリでないもの（ローカルのパスなど）には、リポジトリの階層を作らない。
- パスの区切りに使えない名前（`..` を含むなど）は、ハッシュ（`_` と SHA-256 の先頭 16 文字）にする。
- 各階層は、索引の `SKILL.md` と、1件ずつの中身の `references/<メモリーの ID>.md` でできている。
  - 索引の各行は `- [題](references/<ID>.md)：概要（有効な最終利用日：YYYY-MM-DD）` だけ。中身は書かない。
  - 中身のファイルは、題・概要・有効な最終利用日・登録した日と、中身（Markdown）。
  - 有効な最終利用日は、登録した時刻の日付（UTC）。

コード: `apps/daemon/src/memory.ts`（`memoryLayerDir`・`repositoryMemoryKey`・`renderMemoryIndex`・`renderMemoryReference`・`indexLine`）

## 正本と書き出し

- 正本は作業履歴。登録は深掘りの結果（`AuditDeepDived` の `memories`）に、削除は `AuditMemoryDeleted`（`memoryId`・`reason`）に記録する。
  どちらも、メモリーを登録した監査のタスクの作業履歴に追記する。`reason` は `person`（人が消した）・`capacity`（件数の上限）。
- 書き出すのはデーモンだけ。登録・削除を記録した後、その階層を作業履歴から書き直す。メモリーが無くなった階層は、ディレクトリごと消す。
  - ディレクトリは置き換えず、中のファイルを、同じディレクトリの一時ファイルに書いてから置き換える（実行中のコンテナがマウントしている
    場所を保ち、書きかけを読ませない）。中身が同じなら書かない。
  - 書けなくても記録は残り、警告を出す。
- 起動のとき、件数の上限を超えた分を消してから、すべての階層を作業履歴に合わせて書き直す。記録の無い階層のディレクトリは消す
  （記録の後・書き出しの前に止まっても直る）。
- 書き出す場所（`memoryRoot`）が無ければ、メモリーを書き出さず、深掘りにも登録を求めない。

コード: `apps/daemon/src/memory.ts`（`liveMemories`・`writeMemoryLayer`・`syncMemoryLayers`）、`apps/daemon/src/service.ts`（`writeMemories`・`syncMemories`）、
`packages/core/src/events.ts`（`AuditMemoryRecord`・`MEMORY_DELETE_REASONS`）、`packages/core/src/projection.ts`（`TaskAuditMemory`）

## 監査からの登録

- 深掘りの指示に、タスクのプロジェクトと対象リポジトリの既存のメモリー（ID・階層・題・概要と、中身を読める場所）と、登録の決まりを入れる。
  - 登録するのは、次の同じ種類のタスクでも役立つ具体的な知見。このタスクだけの事情・一度きりの出来事は登録しない。
  - 既存と同じ知見なら `sameAs` に ID を書かせ、登録しない。
  - `scope` は、リポジトリそのものに関すること（ビルド・テスト・規約・構成）なら `repository`、プロジェクトやコンテキストに固有のことなら
    `project`。`repository` には、プロジェクト・組織・コンテキストに固有の名前や事情を書かせない。GitHub の対象リポジトリが無ければ
    `project` だけ。
  - 秘密情報・個人の情報を書かせない。
- 出力の `memories` を読む：1回の深掘りで最大 2 つ（`AUDIT_MAX_MEMORIES`）。題（200 文字）・概要（300 文字）は1行にし、中身は 4000 文字まで。
  題・概要・中身のどれかが無いもの、既存の ID を `sameAs` にしたもの、`repository` でも対象リポジトリが無いものは捨てる。`repository` の
  宛先は sacty が対象リポジトリにする（出力の宛先は使わない）。
- 出力は、監査の出力と同じく、記録の前に秘密情報を伏せる。ID は sacty が決める。
- 同じプロジェクトの深掘りは1つずつ実行するので、プロジェクトの階層の重複は、登録の時点の一覧で確かめられる。リポジトリの階層は、
  ほかのプロジェクトの深掘りと同時に登録されることがあり、そのときは同じ知見が2件になりうる。
- 階層ごとの件数の上限は 30（`MEMORY_MAX_PER_LAYER`）。登録で超えたら、有効な最終利用日の古いもの（同じなら登録の古いもの）から
  `capacity` で消す。

コード: `apps/daemon/src/audit-prompts.ts`（`buildAuditDivePrompt`・`extractAuditDive`・`AUDIT_MAX_MEMORIES`）、`apps/daemon/src/service.ts`（`knownMemories`・`trimMemories`・`runAuditAgent`）、
`apps/daemon/src/memory.ts`（`overCapacity`・`MEMORY_MAX_PER_LAYER`）

## エージェントに渡す

- 工程（統合レビューを除く）とその手直し（`rework`）の実行には、タスクのプロジェクトの階層を `/sacty-memory/project`、対象リポジトリの階層を
  `/sacty-memory/repository` に、読み取り専用でマウントする。索引の無い階層はマウントしない。Claude Code には `--add-dir` で読める場所に足す。
- マウントしたときは、指示の先頭に読み方を足す：索引を読み、関係するものだけを `references/` から開く。人の指示・コンテキストの規則と
  スキル・対象のリポジトリの AGENTS.md などと食い違うときは、そちらに従う。
- 監査（大まかな監査・深掘り）にも同じ場所にマウントする（重複を確かめるため）。読み方の指示は足さない。
- ゴールガーディアン（変更の申し出の判定・最終レビュー・統合レビュー）・オーケストレーター・質問への答え・書き出しには渡さない。
- ほかのプロジェクトのプロジェクトの階層、ほかのリポジトリの階層は渡さない。

コード: `apps/daemon/src/service.ts`（`withMemory`・`MEMORY_STEP_ROLES`）、`apps/daemon/src/memory.ts`（`taskMemoryLayers`・`existingLayerDir`・`memoryPromptLines`）

## 既定のスキル

既定のコンテキストに、メモリーを読むためのスキル `memory` がある。置き場所・読み方（索引から関係するものだけを開く。有効な最終利用日の
古いものはリポジトリの実物で確かめる）・従う順（人の指示 → コンテキストとリポジトリの決まり → リポジトリの実物 → メモリー）を書く。

コード: `apps/daemon/default-context/skills/memory/SKILL.md`

## 人が消す

- 監査の欄に、その監査が登録したメモリー（題・階層・リポジトリ・概要・中身）を出す。消していないものには「消す」が出て、確定のボタンを
  押すと消す（`POST /api/audits/memories/:id/delete`）。人は登録できない。
- 消したものは印（人が消した・上限で消した）だけを出し、中身と「消す」は出さない。消したものを、もう一度は消せない（409）。

コード: `apps/daemon/src/service.ts`（`deleteAuditMemory`）、`apps/daemon/src/ledger-audits.ts`（`LedgerAuditService`）、`apps/daemon/src/server.ts`（`createApp`）、
`apps/web/src/components/audit.tsx`（`TaskAuditCard`）
