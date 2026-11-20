import { join } from "node:path";
import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import { MemoryProjectStore } from "./projects.js";
import { MemorySettingsStore } from "./settings.js";
import { dir, FakePulls, FakeRepos, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

// 前回のレビュー以降の差分が文書だけの再レビューで、観点と検証を絞る指示が入るかを、準備の判定（rereviewDocsOnlyOf）から
// 指示の文までを通して確かめる（PBI-421）。

const out = (text: string): AgentOutcome => ({
  kind: "completed",
  output: text,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
});
const verdictBlock = (verdict: string) =>
  `\`\`\`json\n${JSON.stringify({ "sacty-review-verdict": { verdict } })}\n\`\`\``;
const commentsBlock = (path: string, line: number, severity: string) =>
  `\`\`\`json\n${JSON.stringify({
    "sacty-review-comments": [{ path, line, severity, body: "指摘" }],
  })}\n\`\`\``;

const HEAD_A = "a".repeat(40);
const HEAD_B = "b1".repeat(20);
const BASE_A = "0a".repeat(20);
const BASE_B = "0b".repeat(20);
const MERGE_BASE_OF_A = "ee".repeat(20);
const MERGE_BASE_OF_B = "dd".repeat(20);

const NARROW = "--- 再レビューの範囲（前回以降が文書だけ） ---";
const KEEP_DISPATCH = "前回からの変更が文書だけでも、担当の起動は省かない";
const KEEP_VERIFY = "差分にコードの変更があれば、主対象が文書でも全部の検証を実行する";
const KEEP_RERUN = "検証は今回のコードで実行し直す（前回の結果や CI の結果だけで済ませない）";

const SRC_DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,2 +1,3 @@",
  " import { pay } from './pay';",
  "+export const retry = 3;",
  " export const once = 1;",
].join("\n");
const DOC_DIFF = [
  "diff --git a/docs/a.md b/docs/a.md",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -1,2 +1,3 @@",
  " # 説明",
  "+追記",
  " 末尾",
].join("\n");

type Options = {
  /** 前回の回の出力（判定。コメントがあれば含める）。 */
  first?: string;
  /** PR の差分（pr.diff）。 */
  diff?: string;
  /** 今回の向き先のブランチ。 */
  baseRef?: string;
  /** 前回の向き先のブランチ。undefined なら持たない記録にはできないので、baseRef を付けない。 */
  firstBaseRef?: string | null;
  /** ベースブランチが進んで、向き先のコミットが変わった。 */
  baseMoved?: boolean;
  /** 前回の先頭から今回の先頭までの変更のパス。 */
  changed?: string[];
  /** repos の細工。 */
  repos?: (repos: FakeRepos) => void;
  /** 実装の前の文書の PR の範囲の節が入る回にする。 */
  docBeforeImplement?: boolean;
  /** 初回のレビューのまま（前回が無い）にする。 */
  firstOnly?: boolean;
};

/** PR 9 を取り込んで 1 回レビューして投稿し、先頭を進めて再レビューを始める。再レビューの指示と、repos を返す。 */
let sequence = 0;
async function rereviewPrompt(options: Options = {}) {
  const activity = new SqliteActivityStore(join(dir, `sacty-${sequence++}.db`));
  const pulls = new FakePulls();
  const firstBaseRef = options.firstBaseRef === undefined ? "main" : options.firstBaseRef;
  pulls.prInfo = {
    ...pulls.prInfo,
    number: 9,
    url: "https://github.com/acme/app/pull/9",
    headSha: HEAD_A,
    baseSha: BASE_A,
    ...(firstBaseRef ? { baseRef: firstBaseRef } : {}),
    author: "me",
  };
  const projects = new MemoryProjectStore();
  projects.put("default", {
    name: "デフォルト",
    targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
    githubAccounts: { "github.com": "me" },
  });
  const repos = new FakeRepos();
  repos.prDiff = options.diff ?? SRC_DIFF;
  repos.changedBetween[`${HEAD_A}..${HEAD_B}`] = options.changed ?? ["docs/a.md"];
  repos.mergeBases[`${HEAD_A}..${BASE_A}`] = MERGE_BASE_OF_A;
  repos.mergeBases[`${HEAD_B}..${options.baseMoved ? BASE_B : BASE_A}`] = MERGE_BASE_OF_A;
  const { service, executor } = makeService(
    activity,
    [
      out(options.first ?? `# 1回目\n${verdictBlock("changes_required")}`),
      out(`# 2回目\n${verdictBlock("no_findings")}`),
    ],
    {
      pulls,
      repos,
      projects,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review", reviewRequested: true }),
    },
  );
  const [task] = service.importIssues([
    {
      repo: "https://github.com/acme/app",
      number: 9,
      title: "PR 9",
      body: "本文",
      url: "https://github.com/acme/app/pull/9",
      labels: ["sacty-review"],
      pullRequest: true,
    },
  ]);
  const id = task?.id ?? "";
  if (options.docBeforeImplement) {
    (service as unknown as { reviewReworkContext: () => unknown }).reviewReworkContext = () => ({
      reviewRework: {
        gateStep: "design",
        targets: [],
        parent: {
          steps: [
            { key: "design", state: "done" },
            { key: "implement", state: "pending" },
          ],
        },
      },
    });
  }
  await service.runNext(id);
  await service.runNext(id);
  if (options.firstOnly) {
    return { prompt: executor.calls.at(-1)?.command.join(" ") ?? "", repos, pulls, activity };
  }
  // 先頭を進めて、再レビューを始める
  pulls.prInfo = {
    ...pulls.prInfo,
    headSha: HEAD_B,
    baseSha: options.baseMoved ? BASE_B : BASE_A,
    baseRef: options.baseRef ?? "main",
  };
  options.repos?.(repos);
  repos.fetchedCommits.length = 0;
  service.rereview(id);
  await service.runNext(id);
  const task2 = service.get(id)?.task as Task;
  expect(task2.previousReview?.headCommit).toBe(HEAD_A);
  return { prompt: executor.calls.at(-1)?.command.join(" ") ?? "", repos, pulls, activity };
}

const narrowed = (prompt: string) => {
  expect(prompt).toContain(NARROW);
  // 前回と今回の先頭のコミットと、変わったパスを示し、規則 10 で行うことと、その要点を書く
  expect(prompt).toContain(HEAD_A.slice(0, 7));
  expect(prompt).toContain(HEAD_B.slice(0, 7));
  expect(prompt).toContain("docs/a.md");
  expect(prompt).toContain("規則 10");
  expect(prompt).toContain("U-1・U-5");
  expect(prompt).toContain("D-2・D-5");
  expect(prompt).toContain("起動しない");
  expect(prompt).toContain("scope: docs");
  expect(prompt).toContain("skipped");
  expect(prompt).toContain("絞らずに、規則 1〜7 で観点を決め");
  expect(prompt).not.toContain(KEEP_DISPATCH);
  expect(prompt).not.toContain(KEEP_VERIFY);
  expect(prompt).not.toContain(KEEP_RERUN);
  // 判定・重みの決め方・前回の指摘の節は、絞らない再レビューと同じ
  expect(prompt).toContain("「前回の指摘」の節");
};
const notNarrowed = (prompt: string) => {
  expect(prompt).not.toContain(NARROW);
  expect(prompt).toContain(KEEP_DISPATCH);
  expect(prompt).toContain(KEEP_VERIFY);
  expect(prompt).toContain(KEEP_RERUN);
};

describe("前回以降が文書だけの再レビュー（PBI-421）", () => {
  it("主対象が code の PR で、前回以降が文書だけなら、絞る指示が入る（ベースブランチが進んでも、起点が同じなら）", async () => {
    const { prompt, repos } = await rereviewPrompt({ baseMoved: true });
    narrowed(prompt);
    // 今回の先頭と向き先は取得され、前回の先頭と前回の向き先は別の呼び出しで取得される
    expect(repos.fetchedCommits.map((f) => f.commits)).toContainEqual([HEAD_B, BASE_B]);
    expect(repos.fetchedCommits.map((f) => f.commits)).toContainEqual([HEAD_A, BASE_A]);
  });

  it("前回の行へのコメントが、文書へのものか、提案なら、絞る", async () => {
    const first = (path: string, severity: string) =>
      `# 1回目\n${commentsBlock(path, 2, severity)}\n${verdictBlock("changes_required")}`;
    narrowed((await rereviewPrompt({ first: first("src/retry.ts", "should") })).prompt);
  });

  it("前回以降に文書でないファイルがあれば、絞らない", async () => {
    notNarrowed((await rereviewPrompt({ changed: ["docs/a.md", "src/y.ts"] })).prompt);
  });

  it("前回以降の差分を確かめられなければ、絞らず、今回の先頭と向き先を取得して、止まらずに始める", async () => {
    const cases: [string, (repos: FakeRepos) => void][] = [
      ["前回の先頭を取得できない", (r) => r.fetchFailFor.push(HEAD_A)],
      ["前回の向き先を取得できない", (r) => r.fetchFailFor.push(BASE_A)],
      [
        "merge-base が取れない",
        (r) => {
          r.mergeBases[`${HEAD_B}..${BASE_B}`] = undefined;
        },
      ],
      [
        "前回の先頭が今回の祖先でない（履歴を書き換えた）",
        (r) => {
          r.notAncestor = true;
        },
      ],
      [
        "祖先かどうかを確かめられない",
        (r) => {
          r.ancestorFail = "unreachable";
        },
      ],
    ];
    for (const [name, prepare] of cases) {
      const { prompt, repos } = await rereviewPrompt({ repos: prepare, baseMoved: true });
      expect(prompt, name).toContain("--- 再レビュー ---");
      notNarrowed(prompt);
      expect(
        repos.fetchedCommits.map((f) => f.commits),
        name,
      ).toContainEqual([HEAD_B, BASE_B]);
    }
  });

  it("前回の回の記録・PR の起点が条件に合わなければ、絞らない", async () => {
    // 前回の回の判定が無い
    notNarrowed((await rereviewPrompt({ first: "# 1回目" })).prompt);
    // 向き先を替えた
    notNarrowed((await rereviewPrompt({ baseRef: "release" })).prompt);
    // PR がベースを取り込んだ（merge-base が前回と違う）
    notNarrowed(
      (
        await rereviewPrompt({
          baseMoved: true,
          repos: (r) => {
            r.mergeBases[`${HEAD_B}..${BASE_B}`] = MERGE_BASE_OF_B;
          },
        })
      ).prompt,
    );
    // 前回の記録が向き先のブランチを持たない（この変更の前の記録）
    notNarrowed((await rereviewPrompt({ firstBaseRef: null })).prompt);
  });

  it("文書でないパスへの前回の要修正が残っていれば、絞らない", async () => {
    const first = `# 1回目\n${commentsBlock("src/retry.ts", 2, "must")}\n${verdictBlock("changes_required")}`;
    notNarrowed((await rereviewPrompt({ first })).prompt);
  });

  it("主対象が文書の PR・実装の前の文書の PR・初回のレビューは、絞らない", async () => {
    // PR の差分が文書だけ（ベースブランチが分岐の後にコードで進んでも、PR の差分（merge-base から）には入らない）
    const docsPr = await rereviewPrompt({
      diff: DOC_DIFF,
      baseMoved: true,
      repos: (r) => {
        r.changed = ["src/z.ts"];
        r.changedBetween[`${BASE_A}..${HEAD_B}`] = ["src/z.ts"];
      },
    });
    notNarrowed(docsPr.prompt);
    // 実装の前の設計の PR：規則 9 の節が入り、規則 10 の節は入らない
    const design = await rereviewPrompt({ docBeforeImplement: true });
    notNarrowed(design.prompt);
    expect(design.prompt).toContain("--- この PR のレビューの範囲（実装の前の文書） ---");
    // 初回のレビュー
    const first = await rereviewPrompt({ firstOnly: true });
    expect(first.prompt).not.toContain(NARROW);
    expect(first.prompt).not.toContain("--- 再レビュー ---");
    expect(first.prompt).toContain(KEEP_DISPATCH);
  });
});
