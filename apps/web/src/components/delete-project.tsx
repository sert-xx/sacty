"use client";

import { useActionState, useState } from "react";
import { type DeleteProjectState, deleteProjectAction } from "@/app/actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";

const initial: DeleteProjectState = {};

/**
 * プロジェクトの設定の「危険な操作」：プロジェクトの削除。打ち間違いで消さないよう、確認のダイアログでプロジェクトの名前を
 * 入力したときだけ、削除のボタンを押せる（サーバーアクションでも一致を確かめる）。
 */
export function DeleteProjectSection({ id, name }: { id: string; name: string }) {
  const t = useMessages().projects.danger;
  const [state, formAction, pending] = useActionState(deleteProjectAction, initial);
  const [confirm, setConfirm] = useState("");
  return (
    <section
      aria-labelledby="danger-zone"
      className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-card p-5"
    >
      <h2 id="danger-zone" className="text-[15px] font-semibold text-destructive">
        {t.title}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">{t.deleteNote}</span>
        <Dialog onOpenChange={(open) => open || setConfirm("")}>
          <DialogTrigger
            render={
              <Button variant="destructive" className="min-h-9" data-testid="delete-project-open">
                {t.delete}
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <form action={formAction} className="flex flex-col gap-4">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="name" value={name} />
              <DialogHeader>
                <DialogTitle>{t.dialogTitle(name)}</DialogTitle>
                <DialogDescription>{t.dialogDescription}</DialogDescription>
                <p className="text-sm text-muted-foreground">{t.dialogImpact}</p>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="delete-project-confirm">{t.confirmLabel(name)}</Label>
                <Input
                  id="delete-project-confirm"
                  name="confirm"
                  autoComplete="off"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  data-testid="delete-project-confirm"
                />
              </div>
              {state.message && (
                <p role="alert" className="text-sm leading-6 whitespace-pre-line text-warn">
                  {state.message}
                </p>
              )}
              <DialogFooter>
                <DialogClose render={<Button variant="outline" type="button" />}>
                  {t.cancel}
                </DialogClose>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={pending || confirm !== name}
                  data-testid="delete-project-submit"
                >
                  {pending ? t.submitting : t.submit}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}
