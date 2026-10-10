import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { children: text }));

describe("Markdown の表示（PBI-12）", () => {
  it("見出し・箇条書き・表・コードを、読みやすい要素にする", () => {
    const html = render(
      [
        "# 要求要件",
        "",
        "- 受け入れ条件1",
        "- [x] 済み",
        "",
        "| 観点 | 結果 |",
        "| --- | --- |",
        "| TV-1 | 合格 |",
        "",
        "`inline` と",
        "",
        "```js",
        "const a = 1;",
        "```",
      ].join("\n"),
    );
    expect(html).toContain(">要求要件</h3>");
    expect(html).toMatch(/<ul[^>]*>\s*<li[^>]*>受け入れ条件1<\/li>/);
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<table[^>]*>[\s\S]*<td[^>]*>TV-1<\/td>/);
    expect(html).toMatch(/<code[^>]*>inline<\/code>/);
    expect(html).toMatch(/<pre[^>]*><code[^>]*>const a = 1;\n<\/code><\/pre>/);
  });

  it("エージェントの出力の HTML やスクリプト、危ない URL は描画しない", () => {
    const html = render(
      [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "",
        "[危ない](javascript:alert(1)) と [普通](https://example.com)",
        "",
        "![画像](https://example.com/a.png)",
      ].join("\n"),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    // リンクは別タブで開き、参照元を渡さない
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noreferrer noopener"',
    );
    // 画像は読み込まず、リンクにする
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/a.png"');
  });
});
