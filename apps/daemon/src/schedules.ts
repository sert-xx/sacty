import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { DatabaseSync } from "node:sqlite";
import {
  dueScheduleSlot,
  message,
  nextScheduleSlot,
  Schedule,
  ScheduleInput,
  type ScheduleView,
  type Task,
} from "@sacty/core";
import { InvalidOperationError, type TaskService } from "./service.js";

/** スケジュールタスクの保存先。プロジェクトと同じく設定なので書き換えられる。 */
export interface ScheduleStore {
  all(): Schedule[];
  get(id: string): Schedule | undefined;
  /** 作るか、置き換える。 */
  put(schedule: Schedule): Schedule;
  /** 消す。無ければ false。 */
  delete(id: string): boolean;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** SQLite によるスケジュールタスクの保存先（作業履歴と同じファイル）。 */
export class SqliteScheduleStore implements ScheduleStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  all(): Schedule[] {
    const rows = this.db.prepare("SELECT value FROM schedules ORDER BY created_at, id").all() as {
      value: string;
    }[];
    return rows.map((row) => Schedule.parse(JSON.parse(row.value)));
  }

  get(id: string): Schedule | undefined {
    const row = this.db.prepare("SELECT value FROM schedules WHERE id = ?").get(id) as
      | { value: string }
      | undefined;
    return row ? Schedule.parse(JSON.parse(row.value)) : undefined;
  }

  put(schedule: Schedule): Schedule {
    this.db
      .prepare(
        `INSERT INTO schedules (id, project_id, value, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, value = excluded.value`,
      )
      .run(schedule.id, schedule.projectId, JSON.stringify(schedule), schedule.createdAt);
    return schedule;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/** メモリ上の保存先（テスト用）。 */
export class MemoryScheduleStore implements ScheduleStore {
  private readonly items = new Map<string, Schedule>();
  all(): Schedule[] {
    return [...this.items.values()];
  }
  get(id: string): Schedule | undefined {
    return this.items.get(id);
  }
  put(schedule: Schedule): Schedule {
    this.items.set(schedule.id, schedule);
    return schedule;
  }
  delete(id: string): boolean {
    return this.items.delete(id);
  }
  close(): void {}
}

/** ネットにつながるかを確かめる時間の上限。 */
const REACHABLE_TIMEOUT_MS = 5_000;

/**
 * ネットにつながるか（github.com の名前を引けるか）。つながらない間は、スケジュールタスクのタスクを作らない（作っても、
 * エージェントの実行や GitHub への問い合わせで失敗するため）。
 */
export async function networkReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup("github.com").then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), REACHABLE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Tasks = Pick<
  TaskService,
  | "checkScheduledTask"
  | "createScheduledTask"
  | "scheduledTask"
  | "list"
  | "listProjects"
  | "visibleTask"
>;

/**
 * スケジュールタスク（決めた内容のタスクを、決めた予定で作る）。予定の時刻はローカルの時刻で数える。
 *
 * sacty はローカルで動くので、予定の時刻に PC が動いている・ネットにつながるとは限らない。そこで、予定の時刻を過ぎて
 * から確かめ（起動したとき・その後は1分ごと。スリープから戻ったときも、次の確認で）、直前の予定の回をまだ処理して
 * いなければ、そのときにタスクを1つ作る。逃した回がいくつあっても作るのは直前の1回だけで、同じ回を二重に作らない
 * （作ったタスクに回を記録し、回の処理を保存する）。ネットにつながらない間は作らず、つながってから作る。
 */
export class ScheduledTasks {
  /** 直近の確認で、作るべき回があるのにネットにつながらなかったか（始まりと戻ったときに、1回だけログに出す）。 */
  private waitingForNetwork = false;

  constructor(
    private readonly deps: {
      store: ScheduleStore;
      tasks: Tasks;
      now?: () => Date;
      reachable?: () => Promise<boolean>;
      log?: (line: string) => void;
    },
  ) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private view(schedule: Schedule): ScheduleView {
    const now = this.now();
    const next = schedule.enabled ? nextScheduleSlot(schedule.rule, now) : undefined;
    const waiting = this.waitingForNetwork && dueScheduleSlot(schedule, now) !== undefined;
    return {
      ...schedule,
      ...(next ? { nextRunAt: next.toISOString() } : {}),
      ...(waiting ? { waitingForNetwork: true as const } : {}),
    };
  }

  private project(projectId: string) {
    return this.deps.tasks.listProjects().find((p) => p.id === projectId);
  }

  /** プロジェクトのスケジュールタスク（作った順）。プロジェクトが無ければ undefined。 */
  list(projectId: string): ScheduleView[] | undefined {
    if (!this.project(projectId)) return undefined;
    return this.deps.store
      .all()
      .filter((s) => s.projectId === projectId)
      .map((s) => this.view(s));
  }

  /** スケジュールタスクと、それが作ったタスク（新しい順）。無い・プロジェクトを消したなら undefined。 */
  get(id: string): { schedule: ScheduleView; tasks: Task[] } | undefined {
    const schedule = this.deps.store.get(id);
    if (!schedule || !this.project(schedule.projectId)) return undefined;
    const tasks = this.deps.tasks
      .list()
      .filter((t) => t.schedule?.id === id && this.deps.tasks.visibleTask(t.id));
    return { schedule: this.view(schedule), tasks };
  }

  /** 作る。作るタスクの内容は、画面のタスクの作成と同じく確かめる。 */
  create(projectId: string, raw: unknown): ScheduleView {
    const input = ScheduleInput.parse(raw);
    if (!this.project(projectId)) throw new InvalidOperationError(message("project.notFound"));
    this.deps.tasks.checkScheduledTask(projectId, input.task);
    const at = this.now().toISOString();
    return this.view(
      this.deps.store.put({
        ...input,
        id: randomUUID(),
        projectId,
        createdAt: at,
        updatedAt: at,
        since: at,
      }),
    );
  }

  /**
   * 内容・予定・止める/再開を変える。予定を変えた・再開したなら、それより前の予定の回は作らない（変えた時刻から数える）。
   */
  update(id: string, raw: unknown): ScheduleView {
    const input = ScheduleInput.parse(raw);
    const current = this.deps.store.get(id);
    if (!current || !this.project(current.projectId)) {
      throw new InvalidOperationError(message("schedule.notFound"));
    }
    this.deps.tasks.checkScheduledTask(current.projectId, input.task);
    const at = this.now().toISOString();
    const restart =
      JSON.stringify(current.rule) !== JSON.stringify(input.rule) ||
      (!current.enabled && input.enabled);
    return this.view(
      this.deps.store.put({
        ...current,
        ...input,
        updatedAt: at,
        since: restart ? at : current.since,
      }),
    );
  }

  /** 消す（作ったタスクは残す）。 */
  delete(id: string): void {
    if (!this.deps.store.delete(id)) throw new InvalidOperationError(message("schedule.notFound"));
  }

  /** プロジェクトを消したときに、そのスケジュールタスクを消す。 */
  deleteForProject(projectId: string): void {
    for (const s of this.deps.store.all()) {
      if (s.projectId === projectId) this.deps.store.delete(s.id);
    }
  }

  /**
   * 予定の回が来たスケジュールタスクのタスクを作る。ネットにつながらなければ作らず、次の確認で作る。作れなかった
   * （プロジェクトの対象が変わったなど）なら、理由をその回の結果に残し、同じ回を作り直さない。
   */
  async tick(): Promise<void> {
    const now = this.now();
    const projects = new Set(this.deps.tasks.listProjects().map((p) => p.id));
    const due = this.deps.store
      .all()
      .filter((s) => projects.has(s.projectId))
      .flatMap((s) => {
        const slot = dueScheduleSlot(s, now);
        return slot ? [{ schedule: s, slot: slot.toISOString() }] : [];
      });
    if (due.length === 0) {
      this.waitingForNetwork = false;
      return;
    }
    if (!(await (this.deps.reachable ?? networkReachable)())) {
      if (!this.waitingForNetwork) {
        this.deps.log?.(
          `[daemon] ネットにつながらない（github.com の名前を引けない）ため、スケジュールタスク ${due.length} 件のタスクの作成を待ちます。つながったら作ります。`,
        );
      }
      this.waitingForNetwork = true;
      return;
    }
    if (this.waitingForNetwork) {
      this.deps.log?.(
        "[daemon] ネットにつながったので、待っていたスケジュールタスクのタスクを作ります。",
      );
      this.waitingForNetwork = false;
    }
    for (const { schedule, slot } of due) {
      // 確かめている間に、編集・削除されていれば、今の内容で決め直す
      const current = this.deps.store.get(schedule.id);
      if (!current || dueScheduleSlot(current, now)?.toISOString() !== slot) continue;
      const at = this.now().toISOString();
      // 作った後、回の処理を保存する前に止まっていたら、作ったタスクを記録するだけにする（二重に作らない）
      const existing = this.deps.tasks.scheduledTask(current.id, slot);
      let lastRun: Schedule["lastRun"];
      if (existing) {
        lastRun = { slot, at, taskId: existing.id };
      } else {
        try {
          const task = this.deps.tasks.createScheduledTask(current.projectId, current.task, {
            id: current.id,
            slot,
          });
          lastRun = { slot, at, taskId: task.id };
        } catch (error) {
          if (!(error instanceof InvalidOperationError)) throw error;
          lastRun = {
            slot,
            at,
            error: error.messages[0] ?? message("schedule.projectMissing"),
          };
          this.deps.log?.(
            `[daemon] スケジュールタスク「${current.name}」のタスクを作れませんでした。`,
          );
        }
      }
      this.deps.store.put({ ...current, lastRun });
    }
  }
}

/** スケジュールタスクを、起動したときと間隔ごとに確かめる。確認の重なりは避ける。 */
export class ScheduleRunner {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly schedules: Pick<ScheduledTasks, "tick">,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  tick(): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    const run = this.schedules.tick().catch((error: unknown) => {
      console.warn("[daemon] スケジュールタスクの確認に失敗しました：", error);
    });
    this.current = run;
    void run.finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run;
  }
}
