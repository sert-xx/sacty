import type { ComponentProps, JSX } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** 要素に書式をつける（Markdown の構文木 node は DOM に渡さず、元の class とはまとめる）。 */
function styled<T extends keyof JSX.IntrinsicElements>(Tag: T, base: string) {
  return function Styled({
    node: _node,
    className,
    ...props
  }: JSX.IntrinsicElements[T] & { node?: unknown }) {
    const Element = Tag as React.ElementType;
    return <Element {...props} className={cn(base, className)} />;
  };
}

const components: Components = {
  h1: styled("h3", "mt-4 mb-2 text-base font-semibold first:mt-0"),
  h2: styled("h4", "mt-4 mb-2 text-[15px] font-semibold first:mt-0"),
  h3: styled("h5", "mt-3 mb-1.5 text-sm font-semibold first:mt-0"),
  h4: styled("h6", "mt-3 mb-1.5 text-sm font-semibold first:mt-0"),
  h5: styled("h6", "mt-3 mb-1.5 text-sm font-semibold first:mt-0"),
  h6: styled("h6", "mt-3 mb-1.5 text-sm font-semibold first:mt-0"),
  p: styled("p", "my-2 first:mt-0 last:mb-0"),
  ul: styled("ul", "my-2 list-disc pl-5 [&.contains-task-list]:list-none [&_ul]:my-1"),
  ol: styled("ol", "my-2 list-decimal pl-5 [&_ol]:my-1"),
  li: styled("li", "my-0.5 [&>input]:mr-1.5"),
  blockquote: styled("blockquote", "my-2 border-l-2 border-border pl-3 text-muted-foreground"),
  hr: styled("hr", "my-4 border-border"),
  pre: styled(
    "pre",
    "my-2 overflow-x-auto rounded-lg border border-border bg-muted px-4 py-3 font-mono text-xs leading-5",
  ),
  // ブロックのコード（pre の中）は pre の書式に任せ、行内のコードだけ背景をつける
  code: styled(
    "code",
    "font-mono text-[0.85em] [:not(pre)>&]:rounded [:not(pre)>&]:bg-muted [:not(pre)>&]:px-1 [:not(pre)>&]:py-0.5 [:not(pre)>&]:[overflow-wrap:anywhere]",
  ),
  th: styled("th", "border border-border bg-muted px-2.5 py-1.5 font-semibold"),
  td: styled("td", "border border-border px-2.5 py-1.5 align-top"),
  table: ({ node: _node, className, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table {...props} className={cn("w-full border-collapse text-left text-[13px]", className)} />
    </div>
  ),
  a: ({ node: _node, className, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer noopener"
      className={cn("text-accent-foreground underline [overflow-wrap:anywhere]", className)}
    />
  ),
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noreferrer noopener" className="underline">
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    ),
};

/**
 * エージェントが書いた Markdown の表示。エージェントの出力は信頼しないので、生の HTML は描画せず
 * （react-markdown は HTML を通さない）、危ない URL（javascript: など）は無効にする（既定の urlTransform）。
 * 画像は外部の読み込みをしないよう、リンクとして出す。
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: ComponentProps<"div">["className"];
}) {
  return (
    <div className={cn("min-w-0 text-sm leading-7 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
