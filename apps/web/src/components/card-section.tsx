"use client";

import { createContext, type ReactNode, useContext } from "react";
import { Hint } from "@/components/ui/hint";

/**
 * 中のカードを折りたたまない範囲。成果物を工程ごとに1つずつ表示するときは、確かめ終えたものでもページが長くならない
 * ので、開いて出す。
 */
export const ExpandCards = createContext(false);

/**
 * タスク詳細のカード。collapsed なら折りたたんで見出しだけを出す（開けば中身を読める）。
 * 承認済みの成果物など、確かめ終えたものでページが長くならないようにする。
 * note は見出しの横に出す短い事実（件数・状態）。仕組みの説明は hint に書き、印にマウスを乗せると出す（PBI-117）。
 */
export function CardSection({
  id,
  title,
  note,
  hint,
  collapsed = false,
  footer,
  children,
}: {
  id: string;
  title: ReactNode;
  note?: ReactNode;
  /** 補足（ツールチップ）。折りたたんでも印は見える。 */
  hint?: ReactNode;
  collapsed?: boolean;
  /** 折りたたんでも見せるもの（書き出した先の URL など）。中身の後に出す。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <h2 id={id} className="inline text-[15px] font-semibold">
      {title}
      {note && (
        <>
          {" "}
          <span className="text-[13px] font-normal text-muted-foreground">{note}</span>
        </>
      )}
      {hint && (
        <>
          {" "}
          <Hint text={hint} />
        </>
      )}
    </h2>
  );
  const expand = useContext(ExpandCards);
  if (collapsed && !expand) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
        <details aria-labelledby={id} className="group [&[open]>summary]:mb-3">
          <summary className="cursor-pointer marker:text-muted-foreground">{heading}</summary>
          <div className="flex flex-col gap-3">{children}</div>
        </details>
        {footer}
      </div>
    );
  }
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      {heading}
      {children}
      {footer}
    </section>
  );
}
