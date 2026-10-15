import { describe, expect, it } from "vitest";
import { messagesFor } from "@/i18n";
import { intakeRuns } from "./intake";

const run = (lastRunAt: string, error?: string) => ({
  lastRunAt,
  imported: 1,
  ...(error ? { errors: [{ query: error, message: error }] } : {}),
});

describe("取り込みの種類ごとの直近の取り込み（PBI-100）", () => {
  it("種類ごとに出し、取り込めなかった対象は種類をまとめて出す", () => {
    const { runs, errors } = intakeRuns({
      label: "sacty",
      reviewRequested: true,
      ticketLabel: "sacty",
      runs: {
        tickets: run("2026-10-15T00:02:00Z", "jira"),
        issues: run("2026-10-15T00:00:00Z", "issue"),
        reviews: run("2026-10-15T00:01:00Z"),
      },
    });
    expect(runs.map((r) => [r.kind, r.lastRunAt])).toEqual([
      ["issues", "2026-10-15T00:00:00Z"],
      ["reviews", "2026-10-15T00:01:00Z"],
      ["tickets", "2026-10-15T00:02:00Z"],
    ]);
    expect(errors.map((e) => e.query)).toEqual(["issue", "jira"]);
  });

  it("Off や未設定の種類の結果は出さない", () => {
    const runs = {
      issues: run("2026-10-15T00:00:00Z", "issue"),
      reviews: run("2026-10-15T00:01:00Z", "review"),
      tickets: run("2026-10-15T00:02:00Z", "jira"),
    };
    expect(intakeRuns({ runs })).toEqual({ runs: [], errors: [] });
    const off = intakeRuns({
      label: "sacty",
      reviewLabel: "sacty-review",
      ticketLabel: "sacty",
      triageOff: ["issues", "reviewLabel"],
      runs,
    });
    expect(off.runs.map((r) => r.kind)).toEqual(["tickets"]);
    expect(off.errors.map((e) => e.query)).toEqual(["jira"]);
  });

  it("種類の名前は日本語と英語で出す", () => {
    for (const lang of ["ja", "en"] as const) {
      const t = messagesFor(lang).projects.intake;
      expect(Object.keys(t.runKinds).sort(), lang).toEqual(["issues", "reviews", "tickets"]);
      expect(t.lastRun(t.runKinds.reviews, "10:00", 2), lang).toContain(t.runKinds.reviews);
    }
    expect(messagesFor("ja").projects.intake.lastRun("PR のレビュー", "10:00", 2)).toBe(
      "最後の取り込み（PR のレビュー）：10:00（2件のタスクを作成）",
    );
  });
});
