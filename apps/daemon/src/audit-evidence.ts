import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEvent, AuditEvidenceKind } from "@sacty/core";

/*
 * 監査の根拠になる出来事の件数を、sacty が作業履歴とセッションログから数える（PBI-125）。エージェントに数えさせないので、
 * 画面の件数とダッシュボードの推移は、同じ規則で決まる。
 */

/**
 * セッションログ（エージェントの標準出力の JSONL）の中の、失敗したツール呼び出しの数。画面のログの表示
 * （apps/web/src/lib/session-log.ts）と同じ規則：Claude Code は tool_result の is_error、Codex は終わった
 * command_execution の終了コードが 0 でない・失敗、mcp_tool_call のエラー・失敗。読めない行は数えない。
 */
export function countToolFailures(jsonl: string): number {
  let failures = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "user" || event.type === "assistant") {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const c = (part ?? {}) as Record<string, unknown>;
        if (c.type === "tool_result" && c.is_error === true) failures++;
      }
      continue;
    }
    if (event.type === "item.completed") {
      const item = (event.item ?? {}) as Record<string, unknown>;
      const type = item.type ?? item.item_type;
      if (type === "command_execution") {
        const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
        if ((exit !== undefined && exit !== 0) || item.status === "failed") failures++;
      } else if (type === "mcp_tool_call") {
        if (item.error || item.status === "failed") failures++;
      }
    }
  }
  return failures;
}

/**
 * 根拠の種類ごとの件数。人の差し戻しは人が差し戻した指摘の数、PR の指摘は取り込んだ PR のレビュー・コメントの数、やり直しは
 * エージェントの実行の失敗・テスト・最終レビュー・統合レビューの不合格の数。ツール呼び出しの失敗は、セッションログから数えた数。
 */
export function auditCounts(
  activity: readonly ActivityEvent[],
  toolFailures: number,
): Record<AuditEvidenceKind, number> {
  const counts: Record<AuditEvidenceKind, number> = {
    changesRequested: 0,
    pullRequestRemark: 0,
    pause: 0,
    retry: 0,
    toolFailure: toolFailures,
    escalation: 0,
  };
  for (const event of activity) {
    switch (event.type) {
      case "ChangesRequested":
        if (event.actor === "person") counts.changesRequested += event.payload.remarks.length;
        break;
      case "PullRequestReviewImported":
        counts.pullRequestRemark += event.payload.items.length;
        break;
      case "TaskPaused":
        counts.pause++;
        break;
      case "AgentRunFailed":
        counts.retry++;
        break;
      case "TestsRun":
      case "FinalReviewed":
      case "IntegrationReviewed":
        if (!event.payload.passed) counts.retry++;
        break;
      case "TaskEscalated":
        counts.escalation++;
        break;
    }
  }
  return counts;
}

/**
 * 値の中のすべての文字列に hide をかける（オブジェクト・配列はたどる。監査の材料の秘密情報を伏せる。PR #135 レビュー指摘）。
 * キーは変えない。
 */
export function redactDeep<T>(value: T, hide: (text: string) => string): T {
  if (typeof value === "string") return hide(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, hide)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, hide)])) as T;
  }
  return value;
}

/**
 * dir の下のファイルを、秘密情報を伏せた写しに置き換える（監査に渡すセッションログ。PR #135 再レビュー指摘）。並べたファイルは
 * 元のログへのハードリンクのことがあるので、上書きせずに、消してから書く（元のログは変えない）。1つずつ非同期で行う。
 */
export async function redactStagedFiles(
  dir: string,
  hide: (text: string) => string,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, "utf8");
    const hidden = hide(text);
    await unlink(path);
    await writeFile(path, hidden);
  }
}
