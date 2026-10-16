"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { BotIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/**
 * オーケストレーターへの質問のサイドパネル（PBI-61）。画面の右下の AI のアイコンから開き、閉じるボタンと Esc で閉じる。
 * 開いている間も本文を読み・操作できるよう、モーダルにしない（外を押しても閉じない）。広い画面ではヘッダーの下の
 * 右側に出し、狭い画面では全幅で重なる。
 * 答えを待っている間は、閉じていてもアイコンに印を出す。閉じても、書きかけの質問が消えないよう中身を残す。
 */
export function ChatPanel({
  pending,
  count,
  form,
  children,
}: {
  /** オーケストレーターの答えを待っているか。 */
  pending: boolean;
  /** 質問の数。増えたら（答えが来たら）一覧を最後まで送る。 */
  count: number;
  /** 質問の入力。一覧を送っても見えるよう、パネルの下に固定する。 */
  form: ReactNode;
  children: ReactNode;
}) {
  const m = useMessages().task.chat;
  const [open, setOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const toLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // 開いたとき（パネルが見えてから）・質問が増えたとき・答えが来たときは、最新の質問と答えを見せる。
  // 自動の更新で中身が変わらない間は送らない（読んでいる位置を動かさない）
  // biome-ignore lint/correctness/useExhaustiveDependencies: count と pending が変わったときに送り直す
  useEffect(() => {
    if (open) toLatest();
  }, [count, pending]);
  const label = pending ? m.openPending : m.open;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => {
        if (opened) toLatest();
      }}
      modal={false}
      disablePointerDismissal
    >
      {/* 本文の最後が、右下のアイコンに隠れないようにする */}
      <div aria-hidden className="h-12 shrink-0" />
      <DialogPrimitive.Trigger
        render={
          <Button
            size="icon-lg"
            className="fixed right-4 bottom-4 z-40 size-12 rounded-full shadow-lg sm:right-6 sm:bottom-6"
          />
        }
        aria-label={label}
        title={label}
      >
        <BotIcon className="size-6" aria-hidden />
        {pending && (
          <span
            aria-hidden
            data-slot="chat-pending"
            className="absolute -top-0.5 -right-0.5 flex size-3.5"
          >
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-warn opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-3.5 rounded-full border-2 border-background bg-warn" />
          </span>
        )}
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal keepMounted>
        <DialogPrimitive.Popup className="fixed inset-y-0 right-0 z-50 flex w-full sm:top-16 flex-col border-l border-border bg-popover text-sm text-popover-foreground shadow-xl outline-none sm:w-[440px] sm:max-w-[calc(100%-3rem)] data-closed:hidden">
          <div className="flex items-start gap-2 border-b border-border p-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogPrimitive.Title className="text-[15px] font-semibold">
                {m.title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="flex items-center gap-1 text-xs text-muted-foreground">
                {m.note}
                <Hint text={m.hint} className="size-4" />
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              render={<Button variant="ghost" size="icon-lg" className="-mt-1 -mr-1" />}
              aria-label={m.close}
              title={m.close}
            >
              <XIcon aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {children}
          </div>
          {/* 入力の領域も、パネルの6割までにする（低い画面でも、質問の一覧と送信のボタンに届くように） */}
          <div className="max-h-[60%] shrink-0 overflow-y-auto border-t border-border p-4">
            {form}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
