import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage, type Task } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
import { cut } from "./audit-prompts.js";
import { auditTargetCandidates } from "./audit-targets.js";
import { loadConfig } from "./config.js";

/*
 * 監査の設定・宛先の候補・文の切り詰め（PR #135 レビュー指摘）。
 */

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const base = `agents:
  a:
    runtime: stub
    auth: { mode: stub }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
  b:
    runtime: stub
    auth: { mode: stub }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }
default_agent: a
`;

function load(extra: string) {
  dir = mkdtempSync(join(tmpdir(), "sacty-audit-config-"));
  writeFileSync(join(dir, "config.yaml"), `${base}${extra}`);
  return loadConfig(dir);
}

describe("audit_agent（PBI-125）", () => {
  it("書けば監査の AI、書かなければ guardian_agent、それも無ければ default_agent", () => {
    const own = load("guardian_agent: a\naudit_agent: b\n");
    expect(own.ok && own.config.auditAgent.id).toBe("b");
    const guardian = load("guardian_agent: b\n");
    expect(guardian.ok && guardian.config.auditAgent.id).toBe("b");
    const fallback = load("");
    expect(fallback.ok && fallback.config.auditAgent.id).toBe("a");
  });

  it.each(["nope", "", "constructor", "toString"])(
    "agents に無い名前（%j）は、例外ではなく設定の誤りにする",
    (name) => {
      const result = load(`audit_agent: ${JSON.stringify(name)}\n`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(renderMessage(result.problem, "ja")).toContain("audit_agent");
    },
  );
});

describe("宛先の候補の形（PR #135 レビュー指摘）", () => {
  const task = (patch: Partial<Task>) => patch as Task;

  it("対象リポジトリ・コンテキストは .git の無い GitHub の URL にそろえ、GitHub でないものは候補にしない", () => {
    expect(
      auditTargetCandidates(
        task({
          repository: {
            url: "https://github.com/acme/app.git",
            baseBranch: "main",
            baseCommit: "c",
          },
          context: {
            runId: "r",
            layers: [
              { repo: "sacty-default", commit: "d" },
              { repo: "git@github.com:acme/ctx-org.git", commit: "a" },
              { repo: "/Users/me/context", commit: "b" },
              { repo: "https://github.com/acme/ctx-team", commit: "c" },
            ],
            warnings: [],
            at: "",
          },
        }),
        undefined,
      ),
    ).toEqual([
      { kind: "repository", repo: "https://github.com/acme/app" },
      { kind: "context", repo: "https://github.com/acme/ctx-org", depth: 2 },
      { kind: "context", repo: "https://github.com/acme/ctx-team", depth: 0 },
      { kind: "sacty" },
    ]);
  });
});

describe("監査の文の切り詰め（PR #135 レビュー指摘）", () => {
  it("上限に収め、サロゲートペアの間では切らない", () => {
    const emoji = "😀".repeat(101);
    const cutted = cut(emoji, 200);
    expect(cutted.length).toBeLessThanOrEqual(200);
    expect(cutted.endsWith("…")).toBe(true);
    // 壊れた文字（単独のサロゲート）を含まない
    expect(cutted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cut("あ".repeat(10), 10)).toBe("あ".repeat(10));
    expect(cut("a".repeat(11), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
