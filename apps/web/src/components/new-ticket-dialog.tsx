"use client";

import { useActionState, useState } from "react";
import { type CreateTicketState, createTicketAction } from "@/app/actions";
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
import { Textarea } from "@/components/ui/textarea";

const initial: CreateTicketState = {};

/**
 * チケットの作成。作成先は、この画面を表示したときのプロジェクトに固定する
 * （入力中に別のタブでプロジェクトを切り替えても、表示していたプロジェクトに作るため）。
 */
export function NewTicketDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [state, formAction, pending] = useActionState(createTicketAction, initial);
  // 作成先は、ダイアログを開いたときのプロジェクトに固定し、閉じるまで変えない
  // （入力中に画面が自動で更新され、別のタブで切り替えたプロジェクトが props で渡されても、
  // 書いている途中のチケットの作成先は変えないため）
  const [target, setTarget] = useState({ id: projectId, name: projectName });

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) setTarget({ id: projectId, name: projectName });
      }}
    >
      <DialogTrigger render={<Button size="lg" />}>チケットを作成</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="projectId" value={target.id} />
          <DialogHeader>
            <DialogTitle>チケットを作成</DialogTitle>
            <DialogDescription>
              プロジェクト「{target.name}
              」に作成します。作成すると、工程（要求要件 → 設計 → 実装 →
              PR作成）が決まり、台帳に記録されます。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-title">タイトル</Label>
            <Input
              id="ticket-title"
              name="title"
              defaultValue={state.values?.title}
              aria-invalid={Boolean(state.fieldErrors?.title)}
              aria-describedby={state.fieldErrors?.title ? "ticket-title-error" : undefined}
              autoFocus
            />
            {state.fieldErrors?.title && (
              <p id="ticket-title-error" className="text-sm text-warn">
                {state.fieldErrors.title[0]}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-body">内容</Label>
            <Textarea
              id="ticket-body"
              name="body"
              rows={6}
              className="max-h-72 overflow-y-auto"
              defaultValue={state.values?.body}
              placeholder="背景や、満たしてほしい条件"
              aria-invalid={Boolean(state.fieldErrors?.body)}
              aria-describedby={state.fieldErrors?.body ? "ticket-body-error" : undefined}
            />
            {state.fieldErrors?.body && (
              <p id="ticket-body-error" className="text-sm text-warn">
                {state.fieldErrors.body[0]}
              </p>
            )}
          </div>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>閉じる</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "作成中…" : "作成する"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
