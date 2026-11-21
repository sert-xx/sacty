import type { TestViewpoint } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  applyDesignEdits,
  applyEditsToFile,
  applyEditsToFileChecked,
  applyViewpointToDocument,
  DESIGN_EDIT_MAX,
  INVALID_VALUE,
  readDesignEditBlock,
} from "./design-edit.js";

const OUTPUT = [
  "# 設計",
  "",
  "## スコープ",
  "",
  "決済 API を作る。",
  "",
  "## エラー表",
  "",
  "- 決済失敗：「失敗しました」",
  "- 在庫切れ：「在庫がありません」",
  "",
  "## 確認したいこと",
  "",
  "- must 1：再送は 1 回でよいか",
  "",
  "## 既定で決めたこと",
  "",
  "- 再送は 1 回",
].join("\n");

const VIEWPOINTS: TestViewpoint[] = [
  { id: "TV-1", title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
  {
    id: "TV-2",
    title: "失敗時の文言",
    input: "決済を失敗させる",
    expected: "エラー文言が表示される",
  },
];

const FILE = [
  "<!-- sacty task t1 の設計。sacty が作成しました。 -->",
  "",
  OUTPUT,
  "",
  "## テスト観点",
  "",
  "- [TV-1] 同じキーの再送",
  "  - 入力：同じキーで2回送る",
  "  - 期待結果：決済は1回",
  "- [TV-2] 失敗時の文言",
  "  - 入力：決済を失敗させる",
  "  - 期待結果：エラー文言が表示される",
  "",
].join("\n");

const ids = new Set(["implement-1-1"]);
const run = (raw: unknown[], extra: Record<string, unknown> = {}) =>
  applyDesignEdits(raw, {
    remarkIds: ids,
    output: OUTPUT,
    viewpoints: VIEWPOINTS,
    file: FILE,
    secrets: ["SECRET-VALUE-123"],
    ...extra,
  });
const body = (before: string, after: string, extra: Record<string, unknown> = {}) => ({
  remarks: ["implement-1-1"],
  before,
  after,
  reason: "指摘の文言に合わせる",
  sensitive: false,
  ...extra,
});

describe("設計の直しの検査と適用（PBI-446）", () => {
  it("本文の局所の直しは、承認済みの設計の該当箇所だけを after にする", () => {
    const r = run([body("「失敗しました」", "「決済に失敗しました」")]);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toHaveLength(1);
    expect(r.output).toBe(OUTPUT.replace("「失敗しました」", "「決済に失敗しました」"));
    expect(r.viewpoints).toEqual(VIEWPOINTS);
  });

  it("前の直しの after の一部を before にする直しは、順に当たる", () => {
    const r = run([
      body("「失敗しました」", "「決済に失敗しました」"),
      body("決済に失敗しました", "決済が失敗しました"),
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.output).toContain("「決済が失敗しました」");
  });

  it("観点の文言の直しは、その観点のその欄の該当箇所だけを直し、ID・数・ほかの観点は変えない", () => {
    const r = run([
      body("エラー文言", "決済エラーの文言", { viewpoint: "TV-2", field: "expected" }),
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.viewpoints.map((v) => v.id)).toEqual(["TV-1", "TV-2"]);
    expect(r.viewpoints[1]?.expected).toBe("決済エラーの文言が表示される");
    expect(r.viewpoints[0]).toEqual(VIEWPOINTS[0]);
    expect(r.viewpoints[1]?.title).toBe("失敗時の文言");
    // 本文は変わらない（本文の「失敗しました」は別の直しの対象）
    expect(r.output).toBe(OUTPUT);
  });

  it("設計のファイルのテスト観点の節は、その観点の行だけが直る（本文の同じ文言・ほかの観点は変わらない）", () => {
    const next = applyEditsToFile(FILE, [
      {
        remarks: ["implement-1-1"],
        viewpoint: "TV-2",
        field: "expected",
        before: "エラー文言",
        after: "決済エラーの文言",
        reason: "r",
      },
    ]);
    const changed = FILE.split("\n").filter((l, i) => l !== next.split("\n")[i]);
    expect(changed).toEqual(["  - 期待結果：エラー文言が表示される"]);
    expect(next).toContain("  - 期待結果：決済エラーの文言が表示される");
    expect(next).toContain("- 決済失敗：「失敗しました」");
    expect(next.match(/## テスト観点/g)).toHaveLength(1);
  });

  it("ファイルに当てる直しは、当たらなければ飛ばし、人が直した内容は残す", () => {
    const edited = FILE.replace("- 再送は 1 回", "- 再送は 1 回\n- 人が足した行");
    const next = applyEditsToFile(edited, [
      { remarks: ["r"], before: "「失敗しました」", after: "「決済に失敗しました」", reason: "r" },
      // すでに当たっている・ファイルに無い before は飛ばす
      { remarks: ["r"], before: "「決済に失敗しました」の無い文", after: "x", reason: "r" },
    ]);
    expect(next).toContain("- 人が足した行");
    expect(next).toContain("- 決済失敗：「決済に失敗しました」");
    expect(
      applyViewpointToDocument(FILE, {
        viewpoint: "TV-9",
        field: "title",
        before: "a",
        after: "b",
      }),
    ).toBeUndefined();
  });

  describe("反映しない直し（理由を残し、承認済みの設計は変えない）", () => {
    const longText = "あ".repeat(2_001);
    const cases: [string, unknown, RegExp][] = [
      [
        "今回の指摘に無い ID",
        body("「失敗しました」", "x", { remarks: ["implement-9-9"] }),
        /指摘の ID/,
      ],
      ["sensitive が真", body("「失敗しました」", "x", { sensitive: true }), /セキュリティ/],
      ["承認済みの設計に無い before", body("存在しない文", "x"), /承認済みの設計にありません/],
      ["2 か所にある before", body("再送は 1 回", "x", {}), /(?!)/],
      [
        "確認したいことの節の before",
        body("再送は 1 回でよいか", "x"),
        /実装の工程からは直せません/,
      ],
      [
        "既定で決めたことの節の before",
        body("- 再送は 1 回", "- 再送は 2 回"),
        /実装の工程からは直せません/,
      ],
      ["スコープの節の before", body("決済 API を作る。", "x"), /実装の工程からは直せません/],
      [
        "無い viewpoint",
        body("a", "b", { viewpoint: "TV-9", field: "title" }),
        /承認済みのテスト観点にありません/,
      ],
      [
        "観点の欄に無い before",
        body("存在しない", "b", { viewpoint: "TV-1", field: "title" }),
        /その欄にありません/,
      ],
      [
        "field が 3 つのどれでもない",
        body("同じ", "b", { viewpoint: "TV-1", field: "name" }),
        /field が/,
      ],
      [
        "観点の ID を変える after",
        body("同じキー", "[TV-5] 同じキー", { viewpoint: "TV-1", field: "title" }),
        /観点の ID/,
      ],
      ["見出しの行を変える after", body("## エラー表", "## 失敗表"), /見出しの行/],
      ["2,001 文字の after", body("「失敗しました」", longText), /2000 文字/],
      ["秘密情報の値を含む after", body("「失敗しました」", "token SECRET-VALUE-123"), /秘密情報/],
      [
        "内部のパスを含む after",
        body("「失敗しました」", "詳細は /sacty-input/a を見る"),
        /内部のパス/,
      ],
      ["before が空", body("", "x"), /before が空/],
    ];
    for (const [name, edit, why] of cases) {
      if (name === "2 か所にある before") continue;
      it(name, () => {
        const r = run([edit]);
        expect(r.applied).toEqual([]);
        expect(r.output).toBe(OUTPUT);
        expect(r.viewpoints).toEqual(VIEWPOINTS);
        expect(r.rejected).toHaveLength(1);
        expect(String(r.rejected[0]?.rejection)).toMatch(why);
      });
    }

    it("2 か所にある before は、直さない", () => {
      const doubled = `${OUTPUT}\n\n- 在庫切れ：「在庫がありません」`;
      const r = run([body("「在庫がありません」", "x")], { output: doubled, file: undefined });
      expect(r.applied).toEqual([]);
      expect(String(r.rejected[0]?.rejection)).toMatch(/2 か所以上/);
    });

    it("テスト観点の節にある before は、本文の形では直せない（人が直した設計の本文に入る節）", () => {
      const merged = `${OUTPUT}\n\n## テスト観点\n\n- [TV-2] 失敗時の文言\n  - 期待結果：エラー文言が表示される`;
      const r = run([body("エラー文言が表示される", "x")], { output: merged, file: undefined });
      expect(r.applied).toEqual([]);
      expect(String(r.rejected[0]?.rejection)).toMatch(/実装の工程からは直せません/);
    });

    it("設計のファイルにだけ無い before は、直さない（承認済みと PR のファイルをそろえるため）", () => {
      const r = run([body("「在庫がありません」", "x")], {
        file: FILE.replace("「在庫がありません」", "別の文"),
      });
      expect(r.applied).toEqual([]);
      expect(String(r.rejected[0]?.rejection)).toMatch(/設計のファイルにありません/);
    });

    it("11 件目以降は反映しない", () => {
      const edits = Array.from({ length: DESIGN_EDIT_MAX + 1 }, (_, i) =>
        body("「失敗しました」", i === 0 ? "「A」" : "「失敗しました」"),
      );
      const r = run(edits);
      expect(r.applied).toHaveLength(1);
      expect(r.rejected.length).toBeGreaterThanOrEqual(1);
      expect(String(r.rejected.at(-1)?.rejection)).toMatch(/11 件目以降/);
    });

    it("rejectAll を渡すと、すべての直しを反映しない（変更の申し出と同時・ファイルを読めない）", () => {
      const r = run([body("「失敗しました」", "x")], { rejectAll: "申し出と同時" });
      expect(r.applied).toEqual([]);
      expect(r.rejected[0]?.rejection).toBe("申し出と同時");
    });
  });

  it("@ の付く名前を含む after は反映を止めない", () => {
    const r = run([body("「失敗しました」", "「@alice に連絡しました」")]);
    expect(r.rejected).toEqual([]);
    expect(r.output).toContain("@alice");
  });

  it("残す文（remarks・viewpoint・field・before・after・reason）は、形に合う値だけをそのまま載せ、秘密情報と内部のパスを伏せる", () => {
    const r = run([
      {
        remarks: ["implement-1-1", "SECRET-VALUE-123", "/sacty-input/x", "@alice"],
        viewpoint: "TV-1/sacty-input/secret",
        field: "token SECRET-VALUE-123",
        before: "before SECRET-VALUE-123 /sacty-input/a",
        after: "after SECRET-VALUE-123 /sacty-input/b",
        reason: "reason SECRET-VALUE-123",
        sensitive: false,
      },
    ]);
    expect(r.applied).toEqual([]);
    const shown = JSON.stringify(r.rejected);
    expect(shown).not.toContain("SECRET-VALUE-123");
    expect(shown).not.toContain("/sacty-input");
    expect(r.rejected[0]?.remarks).toEqual([
      "implement-1-1",
      INVALID_VALUE,
      INVALID_VALUE,
      INVALID_VALUE,
    ]);
    expect(r.rejected[0]?.viewpoint).toBe(INVALID_VALUE);
    expect(r.rejected[0]?.field).toBe(INVALID_VALUE);
  });

  it("ブロックの形が違えば、読めなかったものとして扱う", () => {
    expect(readDesignEditBlock("文字列").kind).toBe("unreadable");
    expect(readDesignEditBlock({ edits: "x" }).kind).toBe("unreadable");
    expect(readDesignEditBlock({ edits: [] })).toEqual({ kind: "read", edits: [] });
  });
});

describe("設計の直しの検査のすり抜け（レビューの指摘）", () => {
  const why = (r: ReturnType<typeof run>) => String(r.rejected[0]?.rejection);
  const unchanged = (r: ReturnType<typeof run>) => {
    expect(r.applied).toEqual([]);
    expect(r.output).toBe(OUTPUT);
    expect(r.viewpoints).toEqual(VIEWPOINTS);
  };

  it("見出しの語だけを before にした直しは、見出しが変わるので反映しない", () => {
    const r = run([body("エラー表", "失敗表")]);
    unchanged(r);
    expect(why(r)).toMatch(/見出しの行/);
  });

  it("直せる節から直せない節をまたぐ before は、反映しない", () => {
    const before = "「在庫がありません」\n\n## 確認したいこと\n\n- must 1：再送は 1 回でよいか";
    const r = run([body(before, before.replace("1 回でよいか", "2 回でよいか"))]);
    unchanged(r);
    expect(why(r)).toMatch(/実装の工程からは直せません/);
  });

  it("直せない節の中のコードブロックの `#` 行を、見出しとして数えない", () => {
    const output = OUTPUT.replace(
      "- must 1：再送は 1 回でよいか",
      "```\n# コメント\n```\n- must 1：再送は 1 回でよいか",
    );
    const r = run([body("再送は 1 回でよいか", "x")], { output, file: undefined });
    expect(r.applied).toEqual([]);
    expect(why(r)).toMatch(/実装の工程からは直せません/);
  });

  it("コードブロックの中の `#` 行は見出しではないので、直せる節のコードの直しは反映する", () => {
    const output = OUTPUT.replace(
      "- 在庫切れ：「在庫がありません」",
      "- 在庫切れ：「在庫がありません」\n\n```\n# 例\nfoo\n```",
    );
    const r = run([body("foo", "bar")], { output, file: undefined });
    expect(r.rejected).toEqual([]);
    expect(r.output).toContain("bar");
  });

  it("観点の直しは、設計のファイルのその観点の行に当たらなければ反映しない（承認済みの観点も変えない）", () => {
    const file = FILE.replace("  - 期待結果：エラー文言が表示される", "  - 期待結果：別の文言");
    const r = run(
      [body("エラー文言が表示される", "エラーが出る", { viewpoint: "TV-2", field: "expected" })],
      { file },
    );
    unchanged(r);
    expect(why(r)).toMatch(/設計のファイルのその観点の行にありません/);
  });

  it("2,000 文字ちょうどの after は反映し、2,001 文字は反映しない", () => {
    const ok = run([body("「失敗しました」", "あ".repeat(2_000))]);
    expect(ok.rejected).toEqual([]);
    const ng = run([body("「失敗しました」", "あ".repeat(2_001))]);
    expect(ng.applied).toEqual([]);
  });

  it("観点の数を変える after・欄の無い field は反映しない", () => {
    unchanged(run([body("同じキー", "同じキー TV-1 TV-3", { viewpoint: "TV-1", field: "title" })]));
    unchanged(run([body("決済は1回", "x", { viewpoint: "TV-1" })]));
  });

  it("反映しない直しの before・reason に秘密情報・内部のパスがあっても、載せる文には残らない", () => {
    const r = run([
      body("存在しない SECRET-VALUE-123", "x", { reason: "/sacty-input/a SECRET-VALUE-123" }),
    ]);
    const text = JSON.stringify(r.rejected);
    expect(text).not.toContain("SECRET-VALUE-123");
    expect(text).not.toContain("/sacty-input");
  });

  it("反映した直しの reason の内部のパスは、置き換えて記録する", () => {
    const r = run([body("「失敗しました」", "「A」", { reason: "/sacty-input/a を見た" })]);
    expect(r.applied).toHaveLength(1);
    expect(JSON.stringify(r.applied)).not.toContain("/sacty-input");
  });

  it("コミットでは、当たらない直しを飛ばした直しとして返す", () => {
    const edit = {
      remarks: ["implement-1-1"],
      viewpoint: "TV-2",
      field: "expected",
      before: "存在しない",
      after: "x",
      reason: "r",
    };
    const r = applyEditsToFileChecked(FILE, [edit]);
    expect(r.doc).toBe(FILE);
    expect(r.skipped).toEqual([edit]);
  });
});
