import type { AuditStatus, AuditTarget } from "@sacty/core";
import type { Messages } from "@/i18n";
import type { StatusTone } from "@/lib/labels";

/*
 * 完了したタスクの監査の、画面の表示のための小さな関数（PBI-124）。
 */

/**
 * 監査の状態の色（タスクの状態と同じ5つの種類。ADR 20261013-0047）。大まかな監査・深掘りは進めている、待ちは待っている、
 * 失敗と予算での一時停止は人の出番、完了は完了。
 */
export function auditStatusTone(status: AuditStatus): StatusTone {
  switch (status) {
    case "waiting":
      return "waiting";
    case "surveying":
    case "deepDiving":
      return "working";
    case "failed":
    case "budgetPaused":
      return "person";
    case "completed":
      return "completed";
  }
}

/** メモリーをコンテキストにする原因か（原因の鍵が memory:<ID>。PBI-128）。 */
export function isMemoryPromotionCause(causeId: string): boolean {
  return causeId.startsWith("memory:");
}

/**
 * 原因の題。メモリーをコンテキストにする原因は、元のメモリーの題に画面の言語の定型の題を添える（デーモンが作った定型の文は
 * 訳し、元のメモリーの題は訳さない。PR #138 レビュー指摘）。
 */
export function auditCauseTitle(
  causeId: string,
  title: string,
  m: Pick<Messages["audit"], "findings">,
): string {
  return isMemoryPromotionCause(causeId) ? m.findings.memoryPromotion(title) : title;
}

/** 宛先を選ぶ選択肢の値（JSON。キーの並びを決めて、同じ宛先が同じ値になるようにする）。 */
export function auditTargetValue(target: AuditTarget): string {
  switch (target.kind) {
    case "repository":
      return JSON.stringify({ kind: target.kind, repo: target.repo });
    case "context":
      return JSON.stringify({ kind: target.kind, repo: target.repo, depth: target.depth });
    case "sacty":
      return JSON.stringify({ kind: target.kind });
  }
}

/** 宛先の表示：種類と、リポジトリ（コンテキストなら層）。 */
export function auditTargetText(
  target: AuditTarget,
  m: Messages["audit"]["target"],
): { kind: string; detail?: string } {
  switch (target.kind) {
    case "repository":
      return { kind: m.repository, detail: target.repo };
    case "context":
      return {
        kind: m.context(target.depth === 0 ? m.contextOwn : m.contextUpper(target.depth)),
        detail: target.repo,
      };
    case "sacty":
      return { kind: m.sacty };
  }
}

/** 予算で止まった監査の、再開の上限の初期値（タスクの再開と同じ考え方：上限の2倍か、使った額より1ドル多い額）。 */
export function suggestedAuditCap(usedUsd: number, capUsd: number): number {
  return Math.max(capUsd * 2, Math.ceil(usedUsd) + 1);
}

/** 1件あたりの件数（小数第1位まで）。タスクが無ければ null。 */
export function perTask(remarks: number, tasks: number): number | null {
  return tasks === 0 ? null : Math.round((remarks / tasks) * 10) / 10;
}
