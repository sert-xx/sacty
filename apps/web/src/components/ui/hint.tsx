"use client";

import { Popover } from "@base-ui/react/popover";
import { cn } from "cn";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { useMessages } from "@/i18n/client";

/**
 * 補足（ツールチップ。PBI-117）。見出し・ラベル・値の横の小さな印に、マウスを乗せる・Tab で止まる・タップすると出す。
 * Esc と外側のクリック・タップで閉じる。補足の文は印の中にも隠して置き（sr-only）、aria-describedby で結び付けるので、
 * 開かなくてもスクリーンリーダーで読める（ポータルの補足は、初めて開くまで DOM に無いため）。
 * 長い補足は高さを、配置した側の空き（Positioner の --available-height）に収め、中をスクロールする。印に止まったまま矢印キー・PageUp/PageDown でもスクロールできる
 * （補足はポータルに出るので、Tab では中に移れない。PR #127 レビュー指摘）。
 * 補足が無ければ何も出さない。本文に要る情報（操作・エラー・注意）は補足に入れない（docs/spec/ui-wording.md）。
 */
export function Hint({ text, className }: { text?: ReactNode; className?: string }) {
  const m = useMessages().common;
  const id = useId();
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  if (!text) return null;
  // 印に止まったまま、矢印キー・PageUp/PageDown で補足の中をスクロールする
  const scrollKeys: Record<string, number> = {
    ArrowDown: 40,
    ArrowUp: -40,
    PageDown: 200,
    PageUp: -200,
  };
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
        onKeyDown={(e) => {
          const by = scrollKeys[e.key];
          if (!open || by === undefined || !popup.current) return;
          e.preventDefault();
          popup.current.scrollBy({ top: by });
        }}
        className={cn(
          "inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full align-[-0.2em] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground",
          className,
        )}
      >
        <InfoIcon aria-hidden="true" className="size-3.5" strokeWidth={2} />
        <span id={id} className="sr-only">
          {text}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="z-50">
          <Popover.Popup
            ref={popup}
            // 乗せただけで出た補足に、フォーカスを移さない
            initialFocus={false}
            finalFocus={false}
            className="max-h-[min(20rem,var(--available-height,calc(100dvh-4rem)))] max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-5 font-normal text-popover-foreground shadow-lg outline-none data-closed:hidden"
          >
            <Popover.Description className="whitespace-pre-line [overflow-wrap:anywhere]">
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
