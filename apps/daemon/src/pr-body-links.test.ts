import { describe, expect, it } from "vitest";
import { withoutWorkspaceLinks } from "./pr-body-links.js";

describe("PR の本文の、コンテナの作業領域へのリンク（PBI-366）", () => {
  it("作業領域のパスへのリンクを外し、表示の文字を残す", () => {
    expect(withoutWorkspaceLinks("- [README.md](/workspace/README.md) を直した")).toBe(
      "- README.md を直した",
    );
    expect(withoutWorkspaceLinks("[`src/pay.ts`](/workspace/src/pay.ts#L12)")).toBe("`src/pay.ts`");
    expect(
      withoutWorkspaceLinks('[docs/a.md](</workspace/docs/a.md>) と [b](/workspace/b.md "題")'),
    ).toBe("docs/a.md と b（`b.md`）");
  });

  it("表示の文字からパスが分からなければ、リポジトリのルートからのパスを添える", () => {
    expect(withoutWorkspaceLinks("[手順](/workspace/docs/setup.md#始める)")).toBe(
      "手順（`docs/setup.md#始める`）",
    );
    expect(withoutWorkspaceLinks("![図](/workspace/assets/flow.png)")).toBe(
      "図（`assets/flow.png`）",
    );
    expect(withoutWorkspaceLinks("[](/workspace/a.md)")).toBe("`a.md`");
  });

  it("作業領域そのものへのリンクは、表示の文字だけにする", () => {
    expect(withoutWorkspaceLinks("[作業領域](/workspace) と [ルート](/workspace/)")).toBe(
      "作業領域 と ルート",
    );
  });

  it("1行に複数あれば、すべて外す", () => {
    expect(withoutWorkspaceLinks("[a.ts](/workspace/a.ts)・[b.ts](/workspace/src/b.ts)")).toBe(
      "a.ts・b.ts（`src/b.ts`）",
    );
    expect(withoutWorkspaceLinks("[x](/workspace/a.ts)[y](docs/y.md)[a.ts](/workspace/a.ts)")).toBe(
      "x（`a.ts`）[y](docs/y.md)a.ts",
    );
  });

  it("ほかのリンクは変えない", () => {
    const body = [
      "[PR](https://github.com/acme/app/pull/1)",
      "[相対](docs/a.md)",
      "[別の名前](/workspace-tools/a.md)",
      "[別の場所](/workspaces/a.md)",
      "[外のパス](/tmp/workspace/a.md)",
      "/workspace/README.md を読んだ",
    ].join("\n");
    expect(withoutWorkspaceLinks(body)).toBe(body);
  });

  it("コードブロックとインラインコードの中は変えない", () => {
    const body = [
      "`[a](/workspace/a.md)` と書くと [a.md](/workspace/a.md) になる",
      "```md",
      "[a](/workspace/a.md)",
      "```",
      "~~~~",
      "```",
      "[b](/workspace/b.md)",
      "~~~~",
      "[c.md](/workspace/c.md)",
    ].join("\n");
    expect(withoutWorkspaceLinks(body)).toBe(
      [
        "`[a](/workspace/a.md)` と書くと a.md になる",
        "```md",
        "[a](/workspace/a.md)",
        "```",
        "~~~~",
        "```",
        "[b](/workspace/b.md)",
        "~~~~",
        "c.md",
      ].join("\n"),
    );
  });

  it("長い行でも時間がかからない", () => {
    const lines = [
      `${"[".repeat(50_000)}](/workspace/a.md)`,
      `${"[a](/workspace/".repeat(20_000)}`,
      `${"` `` ".repeat(20_000)}[a.md](/workspace/a.md)`,
      `${"[a.md](/workspace/a.md) ".repeat(20_000)}`,
    ];
    const started = Date.now();
    for (const line of lines) withoutWorkspaceLinks(line);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(withoutWorkspaceLinks(lines[3] ?? "")).toBe("a.md ".repeat(20_000));
  });
});
