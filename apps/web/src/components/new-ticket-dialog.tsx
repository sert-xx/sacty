"use client";

import { useActionState } from "react";
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

export function NewTicketDialog() {
  const [state, formAction, pending] = useActionState(createTicketAction, initial);

  return (
    <Dialog>
      <DialogTrigger render={<Button size="lg" />}>チケットを作成</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>チケットを作成</DialogTitle>
            <DialogDescription>
              作成すると、工程（要求要件 → 設計 → 実装 → PR作成）が決まり、台帳に記録されます。
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
