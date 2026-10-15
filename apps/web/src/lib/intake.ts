import type { IntakeKind } from "@sacty/core";
import type { IntakeRun, IntakeStatus } from "@/lib/daemon";

/**
 * 画面に出す、取り込みの種類ごとの直近の取り込みと、取り込めなかった対象（PBI-100）。Off や未設定の種類は出さない
 * （止めた種類の古い結果を、いまの状況として見せないため）。
 */
export function intakeRuns(intake: IntakeStatus): {
  runs: (IntakeRun & { kind: IntakeKind })[];
  errors: NonNullable<IntakeRun["errors"]>;
} {
  const off = intake.triageOff ?? [];
  const enabled: Record<IntakeKind, boolean> = {
    issues: Boolean(intake.label) && !off.includes("issues"),
    reviews:
      intake.reviewRequested === true ||
      (Boolean(intake.reviewLabel) && !off.includes("reviewLabel")),
    tickets: Boolean(intake.ticketLabel) && !off.includes("tickets"),
  };
  const runs = (["issues", "reviews", "tickets"] as const).flatMap((kind) => {
    const run = intake.runs?.[kind];
    return run && enabled[kind] ? [{ ...run, kind }] : [];
  });
  return { runs, errors: runs.flatMap((run) => run.errors ?? []) };
}
