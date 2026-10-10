"use client";

import { cn } from "cn";
import { useActionState, useState } from "react";
import { cancelTaskAction, pauseTaskAction, type TaskControlState } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useMessages } from "@/i18n/client";
import type { CleanupItem } from "@/lib/daemon";

const initial: TaskControlState = {};

/**
 * タスクの一時停止と中止。中止は、片付ける対象を確認の画面に並べてから実行する。
 */
export function TaskControls({
  taskId,
  title,
  canPause,
  plan,
}: {
  taskId: string;
  title: string;
  /** 一時停止できる状態か（実行待ち・実行中・検証中）。 */
  canPause: boolean;
  /** 中止したときに片付けるもの。 */
  plan: CleanupItem[];
}) {
  const m = useMessages();
  const t = m.parts.control;
  const [pauseState, pauseAction, pausing] = useActionState(pauseTaskAction, initial);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelTaskAction, initial);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {canPause && (
          <form action={pauseAction}>
            <input type="hidden" name="taskId" value={taskId} />
            <Button type="submit" variant="outline" disabled={pausing} className="min-h-10">
              {pausing ? t.pausing : t.pause}
            </Button>
          </form>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button variant="outline" className="min-h-10 border-warn-line text-warn">
                {t.cancel}
              </Button>
            }
          />
          <DialogContent className="sm:max-w-lg">
            <form action={cancelAction} className="flex flex-col gap-4">
              <input type="hidden" name="taskId" value={taskId} />
              <DialogHeader>
                <DialogTitle>{t.dialogTitle(title)}</DialogTitle>
                <DialogDescription>{t.dialogBody}</DialogDescription>
              </DialogHeader>
              <ul className="flex flex-col gap-2 text-sm">
                {plan.map((item) => (
                  <li
                    key={item.target}
                    className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2"
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{m.labels.cleanupTarget[item.target]}</span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs",
                          item.present
                            ? "border-warn-line bg-warn-soft text-warn"
                            : "border-input text-muted-foreground",
                        )}
                      >
                        {item.present ? t.present : t.absent}
                      </span>
                    </span>
                    {item.target === "session" ? (
                      <span className="text-xs text-muted-foreground">{t.sessionNote}</span>
                    ) : (
                      item.detail && (
                        <span className="font-mono text-xs break-all text-muted-foreground">
                          {item.detail}
                        </span>
                      )
                    )}
                  </li>
                ))}
              </ul>
              {cancelState.message && (
                <p role="alert" className="text-sm text-warn">
                  {cancelState.message}
                </p>
              )}
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>{t.keep}</DialogClose>
                <Button
                  type="submit"
                  disabled={cancelling}
                  className="bg-warn text-white hover:bg-warn/90 dark:text-background"
                >
                  {cancelling ? t.cancelling : t.confirm}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {pauseState.message && (
        <p role="alert" className="text-sm text-warn">
          {pauseState.message}
        </p>
      )}
    </div>
  );
}
