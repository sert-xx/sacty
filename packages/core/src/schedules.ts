import { z } from "zod";
import { StepPlan, TASK_BODY_MAX, TASK_TITLE_MAX, TaskTemplate } from "./events.js";
import { code, DaemonText } from "./message-code.js";

/*
 * スケジュールタスク（決めた内容のタスクを、決めた予定で作る）。予定の時刻は、デーモンを動かしている PC の時刻
 * （ローカルの時刻）で数える。PC が止まっていた・スリープしていた・ネットにつながらなかった間の予定は、使えるように
 * なったときに、直前の予定の分だけを1回作る（逃した予定がいくつあっても、まとめて1つ）。
 */

export const SCHEDULE_NAME_MAX = 100;

/** 予定の時刻（ローカルの時刻の HH:MM。24時間制）。 */
export const ScheduleTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, code("schedule.timeInvalid"));

/**
 * 予定の決め方。daily：毎日、weekly：決めた曜日（0 が日曜。1 つ以上）、monthly：毎月の決めた日（その月に無い日なら
 * 月の最後の日）。どれも time の時刻。
 */
export const ScheduleRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: ScheduleTime }).strict(),
  z
    .object({
      kind: z.literal("weekly"),
      time: ScheduleTime,
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1, code("schedule.daysRequired"))
        .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("monthly"),
      time: ScheduleTime,
      day: z
        .number()
        .int()
        .min(1, code("schedule.dayInvalid"))
        .max(31, code("schedule.dayInvalid")),
    })
    .strict(),
]);
export type ScheduleRule = z.infer<typeof ScheduleRule>;
export type ScheduleRuleInput = z.input<typeof ScheduleRule>;

/**
 * 作るタスクの内容（タスクの作成のダイアログと同じ項目）。template があれば、題と説明は sacty が決める（PBI-90）ので
 * 持たない。repo が無ければ、リポジトリを指定せずに作る（テンプレートでは、プロジェクトの対象がリポジトリ1つだけなら
 * それにする）。
 */
export const ScheduledTaskSettings = z
  .object({
    template: TaskTemplate.optional(),
    title: z.string().trim().max(TASK_TITLE_MAX, code("input.titleTooLong")).default(""),
    body: z.string().trim().max(TASK_BODY_MAX, code("input.bodyTooLong")).default(""),
    repo: z.string().trim().min(1).optional(),
    plan: StepPlan.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.template && value.title === "") {
      ctx.addIssue({ code: "custom", path: ["title"], message: code("input.titleRequired") });
    }
  })
  // テンプレートでは、題・説明・進め方を持たない（テンプレートが決める）
  .transform((value) =>
    value.template
      ? {
          template: value.template,
          title: "",
          body: "",
          ...(value.repo ? { repo: value.repo } : {}),
        }
      : value,
  );
export type ScheduledTaskSettings = z.infer<typeof ScheduledTaskSettings>;

/** 画面から受け付ける、スケジュールタスクの作成・編集の入力。 */
export const ScheduleInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, code("schedule.nameRequired"))
      .max(SCHEDULE_NAME_MAX, code("schedule.nameTooLong")),
    /** 止めている間は、タスクを作らない（止めていた間の予定は、再開しても作らない）。 */
    enabled: z.boolean().default(true),
    rule: ScheduleRule,
    task: ScheduledTaskSettings,
  })
  .strict();
export type ScheduleInput = z.infer<typeof ScheduleInput>;
export type ScheduleInputValue = z.input<typeof ScheduleInput>;

/** 予定の回の結果。タスクを作れたら taskId、作れなかったら理由（error）。 */
export const ScheduleRun = z.object({
  /** 予定の時刻（ISO 8601）。 */
  slot: z.string(),
  /** 実際に処理した時刻（ISO 8601）。 */
  at: z.string(),
  taskId: z.string().optional(),
  error: DaemonText.optional(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

/** 保存したスケジュールタスク。 */
export const Schedule = ScheduleInput.extend({
  id: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * この時刻より後の予定だけを数える（ISO 8601）。作ったとき・予定を変えたとき・止めていたのを再開したときに、その時刻に
   * する（それより前の予定のタスクを、さかのぼって作らない）。
   */
  since: z.string(),
  /** 直近に処理した回。 */
  lastRun: ScheduleRun.optional(),
});
export type Schedule = z.infer<typeof Schedule>;

/** 画面に返すスケジュールタスク（次の予定の時刻を添える。止めていれば無い）。 */
export type ScheduleView = Schedule & { nextRunAt?: string };

/** その月の日数。 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** その日（ローカルの日付）の予定の時刻。予定の無い日なら undefined。 */
function slotOn(rule: ScheduleRule, year: number, month: number, date: number): Date | undefined {
  const [hours, minutes] = rule.time.split(":").map(Number) as [number, number];
  const at = new Date(year, month, date, hours, minutes, 0, 0);
  if (rule.kind === "weekly" && !rule.days.includes(new Date(year, month, date).getDay())) {
    return undefined;
  }
  if (rule.kind === "monthly" && date !== Math.min(rule.day, daysInMonth(year, month))) {
    return undefined;
  }
  return at;
}

/** 予定を探す日数（毎月の予定でも、この間に必ず1回はある）。 */
const SEARCH_DAYS = 62;

/** now 以前で、いちばん新しい予定の時刻。 */
export function latestScheduleSlot(rule: ScheduleRule, now: Date): Date | undefined {
  for (let back = 0; back <= SEARCH_DAYS; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const at = slotOn(rule, day.getFullYear(), day.getMonth(), day.getDate());
    if (at && at.getTime() <= now.getTime()) return at;
  }
  return undefined;
}

/** now より後で、いちばん早い予定の時刻。 */
export function nextScheduleSlot(rule: ScheduleRule, now: Date): Date | undefined {
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    const at = slotOn(rule, day.getFullYear(), day.getMonth(), day.getDate());
    if (at && at.getTime() > now.getTime()) return at;
  }
  return undefined;
}

/**
 * 今、作るべき回（予定の時刻）。止めている・まだ予定が来ていない・その回をもう処理したなら undefined。
 * 逃した予定がいくつあっても、直前の1回だけを返す（同じ回を二重に作らない・逃した回の数だけ作らない）。
 */
export function dueScheduleSlot(schedule: Schedule, now: Date): Date | undefined {
  if (!schedule.enabled) return undefined;
  const slot = latestScheduleSlot(schedule.rule, now);
  if (!slot) return undefined;
  if (slot.getTime() <= Date.parse(schedule.since)) return undefined;
  if (schedule.lastRun && slot.getTime() <= Date.parse(schedule.lastRun.slot)) return undefined;
  return slot;
}
