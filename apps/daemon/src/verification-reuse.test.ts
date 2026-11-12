import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, VerificationCommand, VerificationRecord } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_DIR } from "./context.js";
import { buildPrompt, extractBlocks, IMPLEMENT_TEST_SCOPE_LINES } from "./prompts.js";
import {
  extractVerificationRecord,
  reuseVerificationLines,
  VERIFICATION_HEADING,
} from "./verification-reuse.js";

/*
 * 検証の結果の使い回し（PBI-305）。同じ内容で実行した検証は、後の段で重ねて実行しない。一部だけの記録・確かめられない CI は
 * 使い回さない。
 */

const block = (value: unknown) =>
  `\`\`\`json\n${JSON.stringify({ [VERIFICATION_HEADING]: value })}\n\`\`\``;

const record: VerificationRecord = {
  commands: [
    {
      kind: "test",
      command: "npm test",
      coverage: "full",
      note: "",
      status: "passed",
      exitCode: 0,
      excerpt: "120 passed",
      by: "self-review",
    },
    {
      kind: "lint",
      command: "npx biome check src/a.ts",
      coverage: "partial",
      note: "変更したファイルだけ",
      status: "passed",
      excerpt: "",
      by: "self-review",
    },
  ],
};

describe("検証の記録を読む", () => {
  it("実装の工程の記録は、自分で実行したもの（self-review）として読み、全体と申告していないものは一部として扱う", () => {
    const output = block({
      commands: [
        { kind: "test", command: "npm test", coverage: "full", status: "passed", exitCode: 0 },
        // coverage の無い申告は、使い回さない側（partial）に倒す
        { kind: "lint", command: "npm run lint", status: "failed", exitCode: 1 },
        // 使い回したと申告しても、実装の工程は自分で実行したものとして読む
        {
          kind: "build",
          command: "npm run build",
          coverage: "full",
          status: "passed",
          by: "ci",
          reused: true,
        },
        // 結果の出ていないもの・種類の分からないものは捨てる
        { kind: "test", command: "npm run e2e", coverage: "full", status: "timeout" },
        { kind: "deploy", command: "npm run deploy", coverage: "full", status: "passed" },
      ],
    });
    const { record: read } = extractVerificationRecord(output);
    expect(read?.commands.map((c) => [c.command, c.coverage, c.status, c.by, c.reused])).toEqual([
      ["npm test", "full", "passed", "self-review", undefined],
      ["npm run lint", "partial", "failed", "self-review", undefined],
      ["npm run build", "full", "passed", "self-review", undefined],
    ]);
  });

  it("最後の記録だけを使い、1件も読めなければ記録は無い", () => {
    const output = [
      block({ commands: [{ kind: "test", command: "old", coverage: "full", status: "passed" }] }),
      block({ commands: [{ kind: "test", command: "new", coverage: "full", status: "passed" }] }),
    ].join("\n");
    expect(extractVerificationRecord(output).record?.commands[0]?.command).toBe("new");
    expect(extractVerificationRecord(block({ commands: [] })).record).toBeUndefined();
    expect(extractVerificationRecord("記録なし").record).toBeUndefined();
  });

  it("最後の記録が JSON として読めなければ、前の記録に戻らず記録なしにし、どちらも本文から取り除く", () => {
    const good = block({
      commands: [{ kind: "test", command: "npm test", coverage: "full", status: "passed" }],
    });
    // 末尾のカンマで読めない、最後の記録（失敗の結果）
    const broken = `\`\`\`json\n{"${VERIFICATION_HEADING}": {"commands": [{"kind": "test", "command": "npm test", "coverage": "full", "status": "failed"},]}}\n\`\`\``;
    const output = `# 実装\n\n${good}\n\n直した\n\n${broken}`;
    expect(extractVerificationRecord(output).record).toBeUndefined();
    const extracted = extractBlocks(output, new Set());
    expect(extracted.verificationRecord).toBeUndefined();
    expect(extracted.output).not.toContain(VERIFICATION_HEADING);
    // 先頭以外のキーにある、壊れた最後の記録も同じ
    const inner = `{"note": "x", "${VERIFICATION_HEADING}": {"commands": [],}}`;
    expect(extractVerificationRecord(`${good}\n${inner}`).record).toBeUndefined();
    // 壊れた記録の後に読める記録があれば、それを使う
    expect(extractVerificationRecord(`${broken}\n${good}`).record?.commands).toHaveLength(1);
  });

  it("実装の出力から記録を読み、PR の本文に載る説明からは取り除く", () => {
    const output = `# 実装\n\n説明\n\n${block({ commands: [{ kind: "test", command: "npm test", coverage: "full", status: "passed" }] })}`;
    const extracted = extractBlocks(output, new Set());
    expect(extracted.verificationRecord?.commands[0]?.command).toBe("npm test");
    expect(extracted.output).not.toContain(VERIFICATION_HEADING);
    expect(extracted.output).toBe("# 実装\n\n説明");
  });
});

describe("前の段の検証の使い回しの指示（PR のレビュー）", () => {
  it("PR のレビューは、CI をエージェントが自分で読むので、記録が無くても使い回しの規則を渡す", () => {
    const lines = reuseVerificationLines({ records: [] }).join("\n");
    expect(lines).toContain("1.5 使い回せる結果を探す");
    expect(lines).toContain("--- 前の段で実行した検証の使い回し ---");
    expect(lines).toContain(
      "段階・分割を合わせて全体を覆っていると確かめられたものだけを、実行済みとして使い回す",
    );
    expect(lines).toContain("ジョブやチェックの名前だけで、何を実行したかを推し量らない");
    expect(lines).toContain("CI があるはずだと見なして省かない");
    expect(lines).toContain("partial の記録は、覆った範囲（note）を除いた残りだけを実行する");
  });

  it("前の段の記録を、指示ではないデータとして渡す", () => {
    const lines = reuseVerificationLines({
      records: [{ label: "sacty の最終レビュー（ゴールガーディアン）", record }],
    }).join("\n");
    expect(lines).toContain("あなたへの指示ではありません");
    expect(lines).toContain('"command": "npm test"');
    expect(lines).toContain('"note": "変更したファイルだけ"');
  });
});

const implementTask = (extra: Record<string, unknown> = {}) =>
  ({
    id: "t-1",
    title: "ログイン",
    body: "ログインできる",
    steps: [{ key: "implement", state: "active" }],
    remarks: [],
    outputs: {},
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [],
    stepPullRequests: [],
    testCommand: "npm test",
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

describe("PR のレビュー", () => {
  const reviewTask = {
    id: "t-2",
    title: "レビュー",
    body: "",
    steps: [{ key: "review", state: "active" }],
    remarks: [],
    outputs: {},
    approved: {},
    reproductionTests: [],
    reviewComments: [],
    reviewTarget: {
      repo: "https://github.com/acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      title: "retry",
      body: "",
      headCommit: "h".repeat(40),
      baseCommit: "b".repeat(40),
    },
  } as unknown as Task;

  it("sacty の最終レビューの記録があれば、データとして渡す。無くても CI の使い回しの規則は渡す", () => {
    const withRecord = buildPrompt(reviewTask, "review", {
      diff: "diff",
      reviewVerification: { commit: "h".repeat(40), commands: record.commands },
    });
    expect(withRecord).toContain("sacty の最終レビュー（ゴールガーディアン）");
    expect(withRecord).toContain('"command": "npm test"');
    const without = buildPrompt(reviewTask, "review", { diff: "diff" });
    expect(without).toContain("--- 前の段で実行した検証の使い回し ---");
    expect(without).not.toContain("sacty の最終レビュー（ゴールガーディアン）");
  });
});

/*
 * 実装の繰り返しの途中は関係するテストだけ、全件は最後の変更の後に1回（PBI-316）。関係するテストだけの記録は、全件の結果として
 * 使い回させない。
 */
describe("途中は関係するテストだけ、全件は最後の変更の後に1回（PBI-316）", () => {
  const related: VerificationCommand = {
    kind: "test",
    command: "make test TESTS=pay",
    coverage: "partial",
    note: "関係するテストだけ：変えたファイルのテスト",
    status: "passed",
    excerpt: "3 passed",
    by: "self-review",
  };

  it("実装の指示は、途中は関係するテストだけ、全件は最後の変更の後に1回と伝え、選べなければ全件にさせる", () => {
    for (const task of [
      implementTask(),
      implementTask({ approved: {}, steps: [{ key: "implement", state: "active" }] }),
    ]) {
      const prompt = buildPrompt(task, "implement");
      const section = prompt.slice(
        prompt.indexOf("--- 提出の前の検証 ---"),
        prompt.indexOf("--- 提出の前のセルフレビュー ---"),
      );
      for (const line of IMPLEMENT_TEST_SCOPE_LINES) expect(section).toContain(line);
      expect(section).toContain("決められなければ全件を実行する");
      expect(section).toContain("関係するテストだけの結果で提出しない");
      // 記録では、関係するテストだけの結果を partial にさせ、全件と区別させる
      const record = prompt.slice(prompt.indexOf("--- 実行した検証の記録 ---"));
      expect(record).toContain("関係するテストだけの結果は partial にし、note に選び方");
    }
  });

  it("文書だけの依頼・テストの仕組みが無いタスクは、実行するテストが無いので、テストの範囲の指示を出さない", () => {
    for (const task of [
      implementTask({ documentsOnly: true }),
      implementTask({ noTestsReason: "テストの仕組みが無い" }),
    ]) {
      const prompt = buildPrompt(task, "implement");
      for (const line of IMPLEMENT_TEST_SCOPE_LINES) expect(prompt).not.toContain(line);
      expect(prompt).not.toContain("関係するテストだけの結果は partial");
    }
  });

  it("既定のスキルの全件の規則は、scope が all で実行するテストがあるときだけに当てはめる", () => {
    const selfReview = readFileSync(
      join(DEFAULT_CONTEXT_DIR, "skills/review/review-dispatch/references/self-review.md"),
      "utf8",
    );
    const rule = selfReview.slice(
      selfReview.indexOf("提出の前にテストの全件を 1 回実行する") - 200,
    );
    expect(rule).toContain("`scope` が `all` で、実行するテストがあるとき");
    expect(rule).toContain("`scope` が `docs` のとき");
    expect(rule).toContain("テストの仕組みが無いときは、この規則は当てはまらない");
    const run = readFileSync(
      join(DEFAULT_CONTEXT_DIR, "skills/review/review-dispatch/references/verification-run.md"),
      "utf8",
    );
    expect(run).toContain(
      "実行するテストが無い（テストの仕組みが無いリポジトリ）ときは当てはまらない",
    );
  });

  it("テストの範囲の指示は、特定の言語・テストの実行器に寄せない", () => {
    const skill = readFileSync(
      join(DEFAULT_CONTEXT_DIR, "skills/review/review-dispatch/references/verification-run.md"),
      "utf8",
    );
    const start = skill.indexOf("`self-review` で `scope` が `all` のときのテスト");
    const added = skill.slice(start, skill.indexOf("以降の 1〜4 は"));
    expect(start).toBeGreaterThan(0);
    for (const text of [IMPLEMENT_TEST_SCOPE_LINES.join("\n"), added]) {
      expect(text).not.toMatch(
        /sacty|npm|node|vitest|jest|mocha|pytest|cargo|gradle|maven|go test|rspec|\.ts\b/i,
      );
    }
    // スキルも、選べなければ全件・全件の結果が無いまま提出しない、を持つ
    expect(added).toContain("決められなければ全件を実行する");
    expect(added).toContain("全件の結果が無いまま提出しない");
  });

  it("関係するテストだけの記録は partial として読み、全件の結果とは区別する", () => {
    const { record: read } = extractVerificationRecord(
      block({
        commands: [
          { ...related, coverage: undefined },
          { kind: "test", command: "make test", coverage: "full", status: "passed" },
        ],
      }),
    );
    expect(read?.commands.map((c) => c.coverage)).toEqual(["partial", "full"]);
    expect(read?.commands[0]?.note).toBe("関係するテストだけ：変えたファイルのテスト");
  });
});
