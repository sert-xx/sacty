**日本語** | [English](scheduled-tasks.en.md)

# スケジュールタスク

スケジュールタスクは、決めた内容のタスクを、決めた予定で作る。
sacty は利用者の PC で動くので、予定の時刻に PC が動いている・ネットにつながるとは限らない。
そのため、予定の時刻を過ぎてから確かめ、まだ処理していない直前の回があれば、そのときに1つだけ作る。

関係する ADR: [スケジュールタスクは、逃した予定のうち直前の1回だけを、使えるようになったときに作る](../adr/20261025-1130-scheduled-task-catch-up.md)

## 保存するもの

スケジュールタスクはプロジェクトごとに持ち、`sacty.db` の `schedules` テーブルに1行ずつ置く（値は JSON）。

| 項目 | 意味 |
| --- | --- |
| `name` | 名前（1〜100 文字） |
| `enabled` | 有効か。止めている間はタスクを作らない |
| `rule` | 予定の決め方（下の表） |
| `task` | 作るタスクの内容（[作るタスクの内容](#作るタスクの内容)） |
| `since` | この時刻より後の予定だけを数える。作ったとき・予定を変えたとき・止めていたのを有効に戻したときに、その時刻にする |
| `lastRun` | 直近に処理した回。予定の時刻 `slot`・処理した時刻 `at`・作ったタスク `taskId` か、作れなかった理由 `error` |

| `rule.kind` | 予定 |
| --- | --- |
| `daily` | 毎日 `time`（HH:MM） |
| `weekly` | `days`（0 が日曜。1つ以上）の曜日の `time` |
| `monthly` | 毎月 `day`（1〜31）日の `time`。その月に無い日なら月の最後の日 |

- 予定の時刻は、デーモンを動かしている PC のローカルの時刻で数える。
- 入力の誤りは、文言のコード（`schedule.nameRequired`・`schedule.timeInvalid`・`schedule.daysRequired`・`schedule.dayInvalid` など）で返す。
- プロジェクトを消すと、そのプロジェクトのスケジュールタスクも消す。
  作ったタスクは、ほかのタスクと同じく残る。

コード: `packages/core/src/schedules.ts`（`ScheduleRule`・`ScheduleInput`・`Schedule`）、`apps/daemon/src/schedules.ts`（`SqliteScheduleStore`・`ScheduledTasks`）

## 作るタスクの内容

作るタスクの内容は、画面の「タスクを作成」と同じ項目で決める。

- テンプレート（`template`）があれば、題と説明はテンプレートから決める（題・説明・進め方は持たない）。
  対象リポジトリを省くと、プロジェクトの対象がリポジトリ1つだけならそれにする。
- テンプレートでなければ、題（必須）・内容・対象リポジトリ・進め方（`plan`）を持つ。
  対象リポジトリが無ければ、リポジトリを指定せずに作る（`noRepo`）。
- 保存するとき（作成・編集）に、画面の「タスクを作成」と同じ検査をする。
  対象がプロジェクトの対象に無い・テンプレートでリポジトリが決まらない・選べない進め方なら、理由を返して保存しない（409）。
- 作ったタスクは `TaskCreated` の `start` を `schedule` にし、`schedule` にスケジュールタスクの ID と予定の時刻（`slot`）を記録する。
  記録する人（`actor`）は `sacty`。

コード: `apps/daemon/src/service.ts`（`checkScheduledTask`・`createScheduledTask`・`scheduledTask`・`prepareTask`）、`packages/core/src/schedules.ts`（`ScheduledTaskSettings`）、`packages/core/src/events.ts`（`TaskCreated`）

## 予定の回の確かめ方

デーモンは、取り込みを始めるときにスケジュールタスクの確認を始め、すぐに1回、その後は1分ごとに確かめる。
確認が重ならないように、前の確認が終わるまで次を始めない。
スリープから戻ったときも、次の確認（1分以内）で確かめる。

確認では、有効で、プロジェクトがあるスケジュールタスクごとに、次の回を作るべきかを決める。

1. 今以前で、いちばん新しい予定の時刻（直前の回）を求める。
2. 直前の回が `since` 以前か、`lastRun.slot` 以前なら作らない。
3. 作るべき回が1つでもあれば、ネットにつながるか（`github.com` の名前を引けるか。5 秒まで待つ）を確かめる。
   つながらなければ、どれも作らず、次の確認で確かめ直す。
   作るべき回が無ければ、ネットの確認もしない。
   待ち始めたときと、つながったときに、1回ずつデーモンのログに出す。
   待っている間は、作るべき回のあるスケジュールタスクの API の応答に `waitingForNetwork: true` を添え、画面は一覧の状態に「ネット待ち」、詳細に待っていることを出す。
4. 作る前に、その回のタスクがもう作業履歴にあるかを確かめる。
   あれば作らず、そのタスクを `lastRun` に記録する（作った後、`lastRun` を保存する前にデーモンが止まったとき）。
5. タスクを作り、`lastRun` に回とタスクを保存する。
   作れなかった（プロジェクトの対象が変わったなど）なら、理由を `lastRun.error` に保存し、同じ回を作り直さない。

このため、PC が止まっていた・ネットにつながらなかった間に予定を何回逃しても、作るのは直前の1回分だけで、同じ回を二重に作らない。
作った時刻より前の予定・止めていた間の予定は、さかのぼって作らない。

コード: `packages/core/src/schedules.ts`（`latestScheduleSlot`・`nextScheduleSlot`・`dueScheduleSlot`）、`apps/daemon/src/schedules.ts`（`ScheduledTasks`・`ScheduleRunner`・`networkReachable`）、`apps/daemon/src/main.ts`

## API

| API | 中身 |
| --- | --- |
| `GET /api/projects/:id/schedules` | プロジェクトのスケジュールタスク（次の予定の時刻 `nextRunAt` を添える。止めていれば無い）。プロジェクトが無ければ 404 |
| `POST /api/projects/:id/schedules` | 作る（201） |
| `GET /api/schedules/:id` | スケジュールタスクと、それが作ったタスク（`tasks`。新しい順。消したプロジェクトのタスクは除く） |
| `PUT /api/schedules/:id` | 名前・有効・予定・作るタスクの内容を変える。予定を変えた・有効に戻したなら `since` を今にする |
| `DELETE /api/schedules/:id` | 消す（作ったタスクは残る） |

コード: `apps/daemon/src/server.ts`（`createApp`）

## 画面

- サイドメニューの「スケジュール」は、表示しているプロジェクトのスケジュールタスクの一覧（`/projects/<ID>/schedules`）へ移る。
- 一覧は、名前・予定・次の予定・前回・状態（有効・停止中）を出す。
  「スケジュールタスクを作成」で、作成のダイアログを開く。
- 作成・編集のダイアログは、名前・有効・予定（繰り返し・時刻・曜日・日）と、「タスクを作成」と同じタスクの内容の項目（テンプレート・対象リポジトリ・進め方・タイトル・内容）を持つ。
  タスクの内容の項目は、「タスクを作成」と同じ部品（`TaskFields`）を使う。
  保存すると、詳細へ移る。
- 詳細（`/projects/<ID>/schedules/<スケジュールタスクの ID>`）は、設定・作るタスクの内容・このスケジュールタスクが作ったタスクの一覧（予定の時刻・工程・状態）を出し、編集と削除ができる。
  前回の回でタスクを作れなかったら、理由を出す。
- タスクの一覧・詳細の開始地点は「スケジュールタスク」と出す。

コード: `apps/web/src/components/shell/rail.tsx`（`railItems`）、`apps/web/src/app/projects/[id]/schedules/page.tsx`、`apps/web/src/app/projects/[id]/schedules/[scheduleId]/page.tsx`、`apps/web/src/components/schedule-dialog.tsx`（`ScheduleDialog`・`DeleteScheduleButton`）、`apps/web/src/components/new-task-dialog.tsx`（`TaskFields`）、`apps/web/src/lib/schedule-form.ts`（`toScheduleInput`・`ruleText`）、`apps/web/src/app/actions.ts`（`saveScheduleAction`・`deleteScheduleAction`）
