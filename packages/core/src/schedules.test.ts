import { describe, expect, it } from "vitest";
import {
  dueScheduleSlot,
  latestScheduleSlot,
  nextScheduleSlot,
  type Schedule,
  ScheduleInput,
  ScheduleRule,
} from "./schedules.js";

/** ローカルの時刻（月は 1 始まり）。 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: "s1",
  projectId: "p1",
  name: "毎朝の確認",
  enabled: true,
  rule: { kind: "daily", time: "09:00" },
  task: { title: "確認", body: "", repo: undefined } as Schedule["task"],
  createdAt: at(2026, 10, 1).toISOString(),
  updatedAt: at(2026, 10, 1).toISOString(),
  since: at(2026, 10, 1).toISOString(),
  ...overrides,
});

describe("スケジュールタスクの予定の時刻", () => {
  it("毎日：直前と次の予定（ローカルの時刻）", () => {
    const rule = ScheduleRule.parse({ kind: "daily", time: "09:00" });
    expect(latestScheduleSlot(rule, at(2026, 10, 25, 8, 59))).toEqual(at(2026, 10, 24, 9));
    expect(latestScheduleSlot(rule, at(2026, 10, 25, 9, 0))).toEqual(at(2026, 10, 25, 9));
    expect(nextScheduleSlot(rule, at(2026, 10, 25, 9, 0))).toEqual(at(2026, 10, 26, 9));
  });

  it("毎週：選んだ曜日だけ（2026-10-25 は日曜）", () => {
    const rule = ScheduleRule.parse({ kind: "weekly", time: "18:30", days: [3, 1, 1] });
    expect(rule).toMatchObject({ days: [1, 3] });
    expect(latestScheduleSlot(rule, at(2026, 10, 25, 12))).toEqual(at(2026, 10, 21, 18, 30));
    expect(nextScheduleSlot(rule, at(2026, 10, 25, 12))).toEqual(at(2026, 10, 26, 18, 30));
  });

  it("毎月：その月に無い日は、月の最後の日", () => {
    const rule = ScheduleRule.parse({ kind: "monthly", time: "07:00", day: 31 });
    expect(nextScheduleSlot(rule, at(2026, 11, 1))).toEqual(at(2026, 11, 30, 7));
    expect(nextScheduleSlot(rule, at(2027, 2, 1))).toEqual(at(2027, 2, 28, 7));
    expect(latestScheduleSlot(rule, at(2026, 11, 15))).toEqual(at(2026, 10, 31, 7));
  });

  it("逃した予定がいくつあっても、作るのは直前の1回だけ。処理した回は二度と作らない", () => {
    const s = schedule();
    // 3日分を逃して、10/25 の 12:00 に起動した
    const now = at(2026, 10, 25, 12);
    const due = dueScheduleSlot(s, now);
    expect(due).toEqual(at(2026, 10, 25, 9));
    const done = { ...s, lastRun: { slot: due?.toISOString() ?? "", at: now.toISOString() } };
    expect(dueScheduleSlot(done, at(2026, 10, 25, 23))).toBeUndefined();
    expect(dueScheduleSlot(done, at(2026, 10, 26, 9))).toEqual(at(2026, 10, 26, 9));
  });

  it("作った・予定を変えた時刻より前の回と、止めている間は作らない", () => {
    const since = at(2026, 10, 25, 10).toISOString();
    expect(dueScheduleSlot(schedule({ since }), at(2026, 10, 25, 11))).toBeUndefined();
    expect(dueScheduleSlot(schedule({ enabled: false }), at(2026, 10, 25, 11))).toBeUndefined();
  });
});

describe("スケジュールタスクの入力", () => {
  const base = { name: "定期", rule: { kind: "daily", time: "09:00" } };

  it("テンプレートでなければ題が要る。テンプレートなら題・説明・進め方を持たない", () => {
    expect(ScheduleInput.safeParse({ ...base, task: { title: " " } }).success).toBe(false);
    expect(
      ScheduleInput.parse({
        ...base,
        task: {
          template: "sacty-setup",
          title: "x",
          plan: "direct",
          repo: "https://github.com/a/b",
        },
      }).task,
    ).toEqual({ template: "sacty-setup", title: "", body: "", repo: "https://github.com/a/b" });
  });

  it("時刻・曜日・日の誤りを断る", () => {
    for (const rule of [
      { kind: "daily", time: "24:00" },
      { kind: "weekly", time: "09:00", days: [] },
      { kind: "monthly", time: "09:00", day: 0 },
    ]) {
      expect(ScheduleInput.safeParse({ ...base, rule, task: { title: "t" } }).success).toBe(false);
    }
  });
});
