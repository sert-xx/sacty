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
  children,
}: {
  id: string;
  title: ReactNode;
  note?: ReactNode;
  collapsed?: boolean;
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
      <details
        aria-labelledby={id}
        className="group rounded-xl border border-border bg-card p-5 [&[open]>summary]:mb-3"
      >
        <summary className="cursor-pointer marker:text-muted-foreground">{heading}</summary>
        <div className="flex flex-col gap-3">{children}</div>
      </details>
    );
  }
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      {heading}
      {children}
    </section>
  );
}
