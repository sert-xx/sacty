"use client";

import { useEffect, useTransition } from "react";
import { selectProjectAction } from "@/app/actions";

/**
 * 開いた画面のプロジェクトを、表示しているプロジェクトにする（PBI-98）。サーバーの描画では cookie を変えられないので、
 * 表示した後にサーバーアクションで変え、画面とヘッダーを描き直す。合わせる必要があるときだけ置く（FollowProject）。
 */
export function SelectProject({ projectId }: { projectId: string }) {
  const [, startTransition] = useTransition();
  useEffect(() => {
    startTransition(() => selectProjectAction(projectId));
  }, [projectId]);
  return null;
}
