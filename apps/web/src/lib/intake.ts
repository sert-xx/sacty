import type { IntakeKind } from "@sacty/core";
import type { IntakeRun, IntakeStatus } from "@/lib/daemon";

/**
 * 画面に出す、取り込みの種類ごとの直近の取り込みと、取り込めなかった対象（PBI-100）。Off や未設定の種類は出さない
 * （止めた種類の古い結果を、いまの状況として見せないため）。取り込めなかった対象には、どの種類の失敗かを添える
 * （検索の条件の無い失敗が複数の種類で起きても、見分けられるように）。
 */
export function intakeRuns(intake: IntakeStatus): {
  runs: (IntakeRun & { kind: IntakeKind })[];
  errors: (NonNullable<IntakeRun["errors"]>[number] & { kind: IntakeKind })[];
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
  return {
    runs,
    errors: runs.flatMap((run) =>
      (run.errors ?? []).map((error) => ({ ...error, kind: run.kind })),
    ),
  };
}
