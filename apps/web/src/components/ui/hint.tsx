"use client";

import { Popover } from "@base-ui/react/popover";
import { cn } from "cn";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useMessages } from "@/i18n/client";

/**
 * 補足（ツールチップ。PBI-117）。見出し・ラベル・値の横の小さな印に、マウスを乗せる・Tab で止まる・タップすると出す。
 * Esc と外側のクリック・タップで閉じる。補足の文は印に結び付け（aria-describedby）、スクリーンリーダーでも読める。
 * 補足が無ければ何も出さない。本文に要る情報（操作・エラー・注意）は補足に入れない（docs/README.md の画面の文言の規則）。
 */
export function Hint({ text, className }: { text?: ReactNode; className?: string }) {
  const m = useMessages().common;
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        openOnHover
        delay={150}
        closeDelay={100}
        aria-label={m.hint}
        aria-describedby={id}
        data-slot="hint"
        // キーボードで印に止まったら出す（マウスのクリックで止まったときは、クリックで開くので何もしない）
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        className={cn(
          "inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full align-[-0.2em] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground",
          className,
        )}
      >
        <InfoIcon aria-hidden="true" className="size-3.5" strokeWidth={2} />
      </Popover.Trigger>
      {/* 閉じていても文を DOM に残し、印の aria-describedby から読めるようにする */}
      <Popover.Portal keepMounted>
        <Popover.Positioner sideOffset={6} className="z-50">
          <Popover.Popup
            // 乗せただけで出た補足に、フォーカスを移さない
            initialFocus={false}
            finalFocus={false}
            className="max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-5 font-normal text-popover-foreground shadow-lg outline-none data-closed:hidden"
          >
            <Popover.Description id={id} className="whitespace-pre-line [overflow-wrap:anywhere]">
              {text}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 見出しや語の横に補足の印を並べる（折り返しても印が離れないよう、語と印をひとかたまりにする）。 */
export function WithHint({
  children,
  hint,
  className,
}: {
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  if (!hint) return <>{children}</>;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {children}
      <Hint text={hint} />
    </span>
  );
}
