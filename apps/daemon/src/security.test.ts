import { renderMessage, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildPullRequestBody, extractFinalReview, extractStepPlan } from "./prompts.js";
import { parseNumstat } from "./repository.js";
import {
  extractSecurityFindings,
  extractSecurityScope,
  pathInScope,
  SECURITY_FIX_MAX_CHANGED_LINES,
  scopeViolation,
  securityFixTask,
} from "./security.js";

const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("セキュリティチェックの指摘の一覧", () => {
  it("最後の一覧を読み、区分か題の無い指摘は除き、重さが無ければ medium にする", () => {
    const output = [
      json({ "sacty-security-findings": { findings: [{ category: "code", title: "古い案" }] } }),
      json({
        "sacty-security-findings": {
          findings: [
            {
              id: "SF-1",
              category: "dependency",
              severity: "critical",
              title: "A",
              refs: ["CVE-1"],
            },
            { category: "unknown", title: "区分が違う" },
            { category: "secret", title: "" },
            { category: "config", title: "B", severity: "?" },
          ],
        },
      }),
    ].join("\n");
    expect(extractSecurityFindings(output)).toEqual([
      {
        id: "SF-1",
        category: "dependency",
        severity: "critical",
        title: "A",
        refs: ["CVE-1"],
        location: "",
        fix: "",
      },
      {
        id: "SF-4",
        category: "config",
        severity: "medium",
        title: "B",
        refs: [],
        location: "",
        fix: "",
      },
    ]);
  });

  it("一覧が無ければ undefined", () => {
    expect(extractSecurityFindings("# レポート")).toBeUndefined();
  });
});

describe("修正の範囲の宣言", () => {
  it("パスの ./ を除いて読み、パスが無い宣言は読まない", () => {
    expect(
      extractSecurityScope(
        json({
          "sacty-security-scope": {
            paths: ["./package.json"],
            packages: [{ name: "lib", from: "1.0.0", to: "1.0.1" }, { from: "x" }],
            verification: "osv-scanner scan source -r .",
            reason: "上げるだけ",
          },
        }),
      ),
    ).toEqual({
      paths: ["package.json"],
      packages: [{ name: "lib", from: "1.0.0", to: "1.0.1" }],
      verification: "osv-scanner scan source -r .",
      reason: "上げるだけ",
    });
    expect(extractSecurityScope(json({ "sacty-security-scope": { paths: [] } }))).toBeUndefined();
  });
});

describe("差分と範囲の照合", () => {
  const diff = (files: Record<string, number>) =>
    Object.entries(files).map(([path, added]) => ({ path, added, removed: 0 }));

  it("numstat の出力を読む。名前の変更は変更元の削除と変更先の追加として数え、行の数の無いものは unknown にする", () => {
    expect(
      parseNumstat(
        "2\t1\ta.ts\0" + "0\t10\tsrc/unrelated.ts\0" + "10\t0\tsrc/fix.ts\0-\t-\timg.png\0",
      ),
    ).toEqual([
      { path: "a.ts", added: 2, removed: 1 },
      { path: "src/unrelated.ts", added: 0, removed: 10 },
      { path: "src/fix.ts", added: 10, removed: 0 },
      { path: "img.png", added: 0, removed: 0, unknown: true },
    ]);
  });

  it("範囲の外のファイルを範囲の中へ移したら、変更元を範囲の外として返す", () => {
    expect(
      scopeViolation({ paths: ["src/fix.ts"], packages: [], verification: "", reason: "" }, [
        { path: "src/unrelated.ts", added: 0, removed: 10 },
        { path: "src/fix.ts", added: 10, removed: 0 },
      ])?.outside,
    ).toEqual(["src/unrelated.ts"]);
  });

  it("パスは、そのもの・末尾の / の下・* の当たり（/ をまたがない）で範囲に入る", () => {
    expect(pathInScope("package.json", ["package.json"])).toBe(true);
    expect(pathInScope("src/a/b.ts", ["src/"])).toBe(true);
    expect(pathInScope("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(pathInScope("src/a/b.ts", ["src/*.ts"])).toBe(false);
    expect(pathInScope("package.json.bak", ["package.json"])).toBe(false);
  });

  const scope = {
    paths: ["package.json", "package-lock.json"],
    packages: [],
    verification: "",
    reason: "",
  };

  it("範囲の外のファイルを返す。テストのファイルは範囲の外でも違反にしない", () => {
    expect(
      scopeViolation(
        scope,
        diff({ "package.json": 1, "src/util.ts": 1, "src/pay.test.ts": 3, "tests/e2e/a.ts": 1 }),
      ),
    ).toEqual({ outside: ["src/util.ts"], max: SECURITY_FIX_MAX_CHANGED_LINES });
    expect(scopeViolation(scope, diff({ "package.json": 1 }))).toBeUndefined();
  });

  it("ロックファイルを除いた行の数が上限を超えたら返す。範囲の宣言が無ければ行の数だけを確かめる", () => {
    const max = SECURITY_FIX_MAX_CHANGED_LINES;
    expect(
      scopeViolation(scope, diff({ "package.json": 1, "package-lock.json": 5000 })),
    ).toBeUndefined();
    expect(scopeViolation(scope, diff({ "package.json": max + 1 }))).toEqual({
      outside: [],
      lines: max + 1,
      max,
    });
    expect(scopeViolation(undefined, diff({ "src/anything.ts": max }))).toBeUndefined();
    expect(scopeViolation(undefined, diff({ "src/anything.ts": max + 1 }))?.lines).toBe(max + 1);
  });
});

describe("最終レビューの SEC-MIN", () => {
  const output = json({
    "sacty-final-review": {
      viewpoints: [
        { id: "REQ", verified: true, reason: "ok" },
        { id: "SEC-MIN", verified: true, reason: "最小限" },
      ],
      remarks: [],
      summary: "",
    },
  });

  it("範囲の違反があれば、ゴールガーディアンが合格にしても SEC-MIN を不合格にする", () => {
    const violation = { outside: ["src/util.ts"], max: SECURITY_FIX_MAX_CHANGED_LINES };
    const review = extractFinalReview(output, ["REQ", "SEC-MIN"], [], {
      scopeViolation: violation,
    });
    expect(review.passed).toBe(false);
    const min = review.viewpoints.find((v) => v.viewpointId === "SEC-MIN");
    expect(min?.verified).toBe(false);
    expect(renderMessage(min?.reason ?? "", "ja")).toContain("src/util.ts");
    expect(renderMessage(min?.reason ?? "", "en")).toContain("outside the scope");
    expect(extractFinalReview(output, ["REQ", "SEC-MIN"], []).passed).toBe(true);
  });
});

describe("区分の対応のタスクと PR の本文", () => {
  const report = {
    id: "t-1",
    title: "セキュリティチェック（acme/app）",
  } as unknown as Task;

  it("対応のタスクの説明には、その区分の指摘だけを入れる", () => {
    const { title, body } = securityFixTask(report, "supply-chain", [
      {
        id: "SF-1",
        category: "dependency",
        severity: "high",
        title: "依存",
        refs: [],
        location: "",
        fix: "",
      },
      {
        id: "SF-2",
        category: "supply-chain",
        severity: "medium",
        title: "Actions の固定",
        refs: [],
        location: ".github/workflows/ci.yml:12",
        fix: "SHA で固定する",
      },
    ]);
    expect(title).toBe("セキュリティ対応：サプライチェーン（セキュリティチェック（acme/app））");
    expect(body).toContain("SF-2［medium］Actions の固定");
    expect(body).toContain("SHA で固定する");
    expect(body).not.toContain("SF-1");
  });

  it("セキュリティ対応の PR の本文に、修正の範囲を出す", () => {
    const task = {
      id: "t-2",
      title: "GHSA を直す",
      body: "",
      requestedPlan: "security-fix",
      steps: [
        { key: "investigate", state: "done" },
        { key: "implement", state: "awaiting_approval" },
      ],
      approved: {
        investigate: {
          output: json({
            "sacty-security-scope": {
              paths: ["package.json"],
              packages: [{ name: "lib", from: "1.0.0", to: "1.0.1" }],
              verification: "osv-scanner scan source -r .",
              reason: "上げるだけ",
            },
          }),
        },
      },
      outputs: { implement: "# 実装" },
      testMap: [],
      remarks: [],
      stepPullRequests: [],
      exports: {},
      testViewpoints: [],
    } as unknown as Task;
    const body = buildPullRequestBody(task);
    expect(body).toContain("## 修正の範囲（セキュリティ対応）");
    expect(body).toContain("- 変えてよいファイル：`package.json`");
    expect(body).toContain("- 上げる依存：lib 1.0.0 → 1.0.1");
    expect(body).toContain("- 解消の確かめ方：`osv-scanner scan source -r .`");
  });
});

describe("セキュリティ対応で既存の PR を引き継ぐ", () => {
  it("security-fix の答えの continuePullRequest を読む（実装しない組み合わせでは読まない）", () => {
    const answer = (plan: string) =>
      json({
        "sacty-steps": { plan, reason: "PR のセキュリティの指摘", continuePullRequest: true },
      });
    expect(extractStepPlan(answer("security-fix"))).toMatchObject({
      plan: "security-fix",
      continuePullRequest: true,
    });
    expect(extractStepPlan(answer("security-check"))?.continuePullRequest).toBeUndefined();
  });
});
