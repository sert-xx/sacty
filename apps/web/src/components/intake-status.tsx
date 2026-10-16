"use client";

import Link from "next/link";
import { runIntakeAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";
import type { DaemonStatus } from "@/lib/daemon";
import { intakeRuns } from "@/lib/intake";
import { formatStamp } from "@/lib/labels";

/**
 * 取り込みの状況（直近の取り込み・取り込めなかった対象・設定へのリンク。PBI-100）。プロジェクトの一覧とダッシュボード
 * （PBI-118）で同じものを出す。intake が null なら設定ファイルを読めず、取り込みは止まっている。
 */
export function IntakeStatusView({ intake }: { intake: DaemonStatus["intake"] }) {
  const m = useMessages();
  const t = m.projects.intake;
  // 取り込みの種類ごとの直近の取り込み（PBI-100）
  const { runs, errors } = intake ? intakeRuns(intake) : { runs: [], errors: [] };
  // 設定ファイルを読めず止まっている（PR #128 レビュー指摘：復旧先の sacty の設定へ進めるようにする）
  if (!intake) {
    return (
      <p className="text-warn">
        {t.stopped}{" "}
        <Link href="/settings" className="underline">
          {t.settings}
        </Link>
      </p>
    );
  }
  if (
    !intake.settingsUnreadable &&
    !intake.label &&
    !intake.reviewLabel &&
    !intake.reviewRequested &&
    !intake.ticketLabel
  ) {
    // 取り込むラベルは sacty 全体の設定（PBI-26）
    return (
      <p className="text-warn">
        {t.noLabel}{" "}
        <Link href="/settings" className="underline">
          {t.settings}
        </Link>
      </p>
    );
  }
  return (
    <>
      {/* sacty の設定を読めなかった（PBI-100）。理由は、定期の確認の前でも状況の API が返す */}
      {intake.settingsUnreadable && (
        <p className="text-warn break-words">
          {t.settingsUnreadable}
          {intake.settingsError && m.labels.text(intake.settingsError)}
        </p>
      )}
      <p className="text-muted-foreground">
        {[
          intake.label ? t.label(intake.label) : "",
          // Off にしたレビュー用のラベルは出さない（PBI-53）
          intake.reviewRequested ||
          (intake.reviewLabel && !intake.triageOff?.includes("reviewLabel"))
            ? t.review(
                intake.reviewRequested === true,
                intake.triageOff?.includes("reviewLabel") ? "" : (intake.reviewLabel ?? ""),
              )
            : "",
          // チケット（PBI-52）。Off なら出さない
          intake.ticketLabel && !intake.triageOff?.includes("tickets")
            ? t.ticket(intake.ticketLabel)
            : "",
        ]
          .filter(Boolean)
          .join(" / ")}
        {(intake.triageOff ?? []).length > 0 &&
          t.off((intake.triageOff ?? []).map((kind) => t.kinds[kind]))}{" "}
        <Link href="/settings" className="underline">
          {t.settings}
        </Link>
      </p>
      {runs.length > 0 ? (
        <ul className="text-muted-foreground">
          {runs.map((run) => (
            <li key={run.kind}>
              {t.lastRun(t.runKinds[run.kind], formatStamp(run.lastRunAt, m.locale), run.imported)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t.never}</p>
      )}
      {errors.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 text-warn">
          <p>{t.errors}</p>
          <ul className="list-disc pl-5">
            {errors.map((e) => (
              <li
                key={`${e.kind}:${e.query ?? ""}:${JSON.stringify(e.message)}`}
                className="break-words"
              >
                {t.errorKind(t.runKinds[e.kind])}
                {e.query && <span className="font-mono text-xs">{e.query}</span>}{" "}
                {m.labels.text(e.message)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** 「今すぐ取り込む」（間隔を待たずに取り込む）。設定ファイルを読めないときは出さない。 */
export function IntakeRunNow({ intake }: { intake: DaemonStatus["intake"] }) {
  const t = useMessages().projects.intake;
  if (!intake) return null;
  return (
    <form action={runIntakeAction}>
      <Button type="submit" variant="outline">
        {t.runNow}
      </Button>
    </form>
  );
}
