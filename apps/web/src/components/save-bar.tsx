"use client";

import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

/**
 * 「保存する」と、状態の文（保存していない変更・保存しました）を並べた帯。スクロールしても画面の下に見え、幅 640px 未満では
 * 下の横並びのメニューの上に置く。左寄せにする（狭い幅で、右下の質問の丸いボタンと重ならないように）。
 */
export function SaveBar({
  dirty,
  disabled,
  label,
  children,
}: {
  dirty: boolean;
  disabled: boolean;
  label: string;
  /** 保存したときの文など、状態の文。 */
  children?: React.ReactNode;
}) {
  const unsaved = useMessages().shell.unsaved;
  return (
    <div
      data-testid="save-bar"
      className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-background py-3 sm:bottom-0"
    >
      <Button type="submit" disabled={disabled} className="min-h-11 w-fit px-6">
        {label}
      </Button>
      {dirty && (
        <p role="status" className="text-sm text-warn">
          {unsaved}
        </p>
      )}
      {children}
    </div>
  );
}
