import type { ReactNode } from "react";

/**
 * タスク詳細のカード。collapsed なら折りたたんで見出しだけを出す（開けば中身を読める）。
 * 承認済みの成果物など、確かめ終えたものでページが長くならないようにする。
 */
export function CardSection({
  id,
  title,
  note,
  collapsed = false,
  footer,
  children,
}: {
  id: string;
  title: ReactNode;
  note?: ReactNode;
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
    </h2>
  );
  if (collapsed) {
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
