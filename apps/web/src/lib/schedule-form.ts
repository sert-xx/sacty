import {
  type ScheduleInputValue,
  type ScheduleRule,
  type ScheduleView,
  StepPlan,
  TaskTemplate,
} from "@sacty/core";

/** スケジュールタスクの作成・編集のフォームの値（送信の後に、入力をそのまま戻すためにも使う）。 */
export type ScheduleFormValues = {
  name: string;
  enabled: boolean;
  kind: ScheduleRule["kind"];
  time: string;
  /** 毎週の曜日（0 が日曜）。 */
  days: number[];
  /** 毎月の日。 */
  day: string;
  template: TaskTemplate | "";
  repo: string;
  plan: StepPlan | "";
  title: string;
  body: string;
};

export const EMPTY_SCHEDULE_FORM: ScheduleFormValues = {
  name: "",
  enabled: true,
  kind: "daily",
  time: "09:00",
  days: [1, 2, 3, 4, 5],
  day: "1",
  template: "",
  repo: "",
  plan: "",
  title: "",
  body: "",
};

/** 保存したスケジュールタスクを、編集のフォームの値にする。 */
export function scheduleFormValues(schedule: ScheduleView): ScheduleFormValues {
  const { rule, task } = schedule;
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    kind: rule.kind,
    time: rule.time,
    days: rule.kind === "weekly" ? rule.days : EMPTY_SCHEDULE_FORM.days,
    day: rule.kind === "monthly" ? String(rule.day) : EMPTY_SCHEDULE_FORM.day,
    template: task.template ?? "",
    repo: task.repo ?? "",
    plan: task.plan ?? "",
    title: task.title,
    body: task.body,
  };
}

/** 送信したフォームの値を読む。 */
export function readScheduleForm(formData: FormData): ScheduleFormValues {
  const text = (name: string) => String(formData.get(name) ?? "");
  const kind = text("kind");
  const template = TaskTemplate.safeParse(text("template"));
  const plan = StepPlan.safeParse(text("plan"));
  return {
    name: text("name"),
    enabled: formData.get("enabled") === "on",
    kind: kind === "weekly" || kind === "monthly" ? kind : "daily",
    time: text("time"),
    days: formData
      .getAll("days")
      .map(Number)
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    day: text("day"),
    template: template.success ? template.data : "",
    repo: text("repo").trim(),
    plan: plan.success ? plan.data : "",
    title: text("title"),
    body: text("body"),
  };
}

/** フォームの値を、デーモンに渡す入力にする（形の検査はデーモンと同じ ScheduleInput で行う）。 */
export function toScheduleInput(values: ScheduleFormValues): ScheduleInputValue {
  const rule: ScheduleInputValue["rule"] =
    values.kind === "weekly"
      ? { kind: "weekly", time: values.time, days: values.days }
      : values.kind === "monthly"
        ? { kind: "monthly", time: values.time, day: Number(values.day) }
        : { kind: "daily", time: values.time };
  return {
    name: values.name,
    enabled: values.enabled,
    rule,
    task: values.template
      ? { template: values.template, ...(values.repo ? { repo: values.repo } : {}) }
      : {
          title: values.title,
          body: values.body,
          ...(values.repo ? { repo: values.repo } : {}),
          ...(values.plan ? { plan: values.plan } : {}),
        },
  };
}

/** 予定の決め方を、画面の言語の短い文にする（例「毎週 月・水 09:00」）。 */
export function ruleText(
  rule: ScheduleRule,
  m: {
    rule: {
      daily: (time: string) => string;
      weekly: (days: string, time: string) => string;
      monthly: (day: number, time: string) => string;
    };
    weekdays: readonly string[];
    daySeparator: string;
  },
): string {
  if (rule.kind === "weekly") {
    return m.rule.weekly(rule.days.map((d) => m.weekdays[d]).join(m.daySeparator), rule.time);
  }
  if (rule.kind === "monthly") return m.rule.monthly(rule.day, rule.time);
  return m.rule.daily(rule.time);
}
