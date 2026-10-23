"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { followProjectAction } from "@/app/actions";
import { useMessages } from "@/i18n/client";
import type { LiveStale } from "@/lib/live";

/**
 * 取り直しで更新できない間に出す（PR #119 レビュー指摘）。表示は最後に取れたデータのまま残し、それが今の値でないかも
 * しれないことを知らせる。更新できたら消える。画面の認証が無い（sacty を起動し直した）ときは、デーモンに届かないのではなく、
 * 端末の新しい URL で入り直すよう出す（PR #141 レビュー提案）。
 */
export function StaleNotice({ stale }: { stale: LiveStale }) {
  const m = useMessages().common.live;
  if (!stale) return null;
  return (
    <p
      role="status"
      data-testid="live-stale"
      className="rounded-xl border border-warn-line bg-warn-soft px-4 py-2.5 text-sm text-warn"
    >
      {stale === "signedOut" ? m.signedOut : m.stale}
    </p>
  );
}

/**
 * 描いたときにデーモンに届かず、後から取り直しで中身が出たときに、その中身のプロジェクトを表示しているプロジェクトにする
 * （ヘッダーと本文をずらさない。描いたときに届いていれば、サーバーの FollowProject が合わせる。PR #119 レビュー指摘）。
 * 合わせる必要があるか（cookie と違うか・プロジェクトがあるか）は、サーバーアクションが確かめる。
 */
export function FollowProjectAfterRecovery({ projectId }: { projectId: string | undefined }) {
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (projectId) startTransition(() => followProjectAction(projectId));
  }, [projectId]);
  return null;
}

/**
 * 取り直しで対象が無くなった（タスクを開いている間に、そのプロジェクトを削除したなど）ら、画面を描き直す。サーバーが
 * 無いものとして描く（404）ので、消したプロジェクトのタスクを開いたまま残さない。
 */
export function RefreshWhenMissing({ missing }: { missing: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (missing) router.refresh();
  }, [missing, router]);
  return null;
}
