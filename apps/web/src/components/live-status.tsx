"use client";

import { useEffect, useTransition } from "react";
import { followProjectAction } from "@/app/actions";
import { useMessages } from "@/i18n/client";

/**
 * 取り直しで更新できない間に出す（PR #119 レビュー指摘）。表示は最後に取れたデータのまま残し、それが今の値でないかも
 * しれないことを知らせる。更新できたら消える。
 */
export function StaleNotice({ stale }: { stale: boolean }) {
  const m = useMessages().common.live;
  if (!stale) return null;
  return (
    <p
      role="status"
      data-testid="live-stale"
      className="rounded-xl border border-warn-line bg-warn-soft px-4 py-2.5 text-sm text-warn"
    >
      {m.stale}
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
