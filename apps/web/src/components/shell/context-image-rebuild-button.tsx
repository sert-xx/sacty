"use client";

import { useActionState } from "react";
import { rebuildContextImageAction, type TaskControlState } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: TaskControlState = {};

/** 作成に失敗したコンテキストのイメージを作り直す（PBI-325）。 */
export function ContextImageRebuildButton({
  projectId,
  name,
}: {
  projectId: string;
  name: string;
}) {
  const m = useMessages().shell.contextImages;
  const [state, action, pending] = useActionState(rebuildContextImageAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="name" value={name} />
      <Button type="submit" variant="outline" disabled={pending} className="min-h-10">
        {pending ? m.rebuilding : m.rebuild}
      </Button>
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
