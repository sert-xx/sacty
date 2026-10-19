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
    expect(errors.map((e) => [e.kind, e.query])).toEqual([
      ["issues", "issue"],
      ["tickets", "jira"],
    ]);
  });

  it("検索の条件の無い同じ失敗が複数の種類で起きても、種類で見分けられる（レビュー指摘）", () => {
    const failed = {
      lastRunAt: "2026-10-15T00:00:00Z",
      imported: 0,
      errors: [{ message: "読めません" }],
    };
    const { errors } = intakeRuns({
      label: "sacty",
      reviewRequested: true,
      runs: { issues: failed, reviews: failed },
    });
    expect(errors.map((e) => [e.kind, e.message])).toEqual([
      ["issues", "読めません"],
      ["reviews", "読めません"],
    ]);
    for (const lang of ["ja", "en"] as const) {
      const t = messagesFor(lang).projects.intake;
      const shown = errors.map((e) => t.errorKind(t.runKinds[e.kind]));
      expect(new Set(shown).size, lang).toBe(2);
    }
    expect(messagesFor("ja").projects.intake.errorKind("Issue")).toBe("【Issue】");
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

  it("sacty の設定を読めなかったときは、記録をすべて出す（読めなかった理由を見せる。レビュー指摘）", () => {
    const failed = {
      lastRunAt: "2026-10-15T00:00:00Z",
      imported: 0,
      errors: [{ message: "読めません" }],
    };
    const { runs, errors } = intakeRuns({
      settingsUnreadable: true,
      runs: { issues: failed, reviews: failed, tickets: failed },
    });
    expect(runs.map((r) => r.kind)).toEqual(["issues", "reviews", "tickets"]);
    expect(errors).toHaveLength(3);
    expect(messagesFor("ja").projects.intake.settingsUnreadable).toContain(
      "Sacty の設定を読めない",
    );
    expect(messagesFor("en").projects.intake.settingsUnreadable).toContain("cannot be read");
    // 理由はこの文の後に続ける（下の一覧には、定期の確認の前は出ないため）
    expect(messagesFor("ja").projects.intake.settingsUnreadable).not.toContain("下に出ます");
  });

  it("種類の名前は日本語と英語で出す", () => {
    for (const lang of ["ja", "en"] as const) {
      const t = messagesFor(lang).projects.intake;
      expect(Object.keys(t.runKinds).sort(), lang).toEqual(["issues", "reviews", "tickets"]);
      expect(t.lastRun(t.runKinds.reviews, "10:00", 2), lang).toContain(t.runKinds.reviews);
    }
    expect(messagesFor("ja").projects.intake.lastRun("PR のレビュー", "10:00", 2)).toBe(
      "最後の取り込み（PR のレビュー）：10:00・2件のタスクを作成",
    );
  });
});
