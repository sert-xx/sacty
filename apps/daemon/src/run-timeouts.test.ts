import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { CONFIG_TEMPLATE, loadConfig } from "./config.js";
import { AGENT_RUN_TIMEOUT_MS } from "./context.js";
import {
  agentTimeoutMs,
  DEFAULT_AGENT_TIMEOUT_MINUTES,
  DEFAULT_TEST_TIMEOUT_MINUTES,
  testTimeoutMs,
} from "./run-timeouts.js";

/*
 * エージェントの実行とテストの実行の上限を、config.yaml の run_timeout で決める（PBI-150）。
 */

function load(extra: string) {
  const dir = mkdtempSync(join(tmpdir(), "sacty-pbi150-"));
  try {
    writeFileSync(
      join(dir, "config.yaml"),
      `default_agent: s\nagents:\n  s:\n    runtime: stub\n${extra}`,
    );
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("config.yaml の run_timeout", () => {
  it("書かなければ、エージェント 30 分・テスト 20 分（PBI-150 より前と同じ）", () => {
    const config = load("");
    expect(config).toMatchObject({
      ok: true,
      config: { runTimeouts: { agentMinutes: 30, testMinutes: 20, roles: {} } },
    });
    expect(DEFAULT_AGENT_TIMEOUT_MINUTES * 60_000).toBe(AGENT_RUN_TIMEOUT_MS);
    expect(DEFAULT_TEST_TIMEOUT_MINUTES).toBe(20);
  });

  it("既定と、役割ごとの上書きを読む", () => {
    const config = load(
      [
        "run_timeout:",
        "  agent_minutes: 45",
        "  test_minutes: 7",
        "  roles:",
        "    implement: 90",
        "    guardian: 15",
        "    final-review: 60",
        "",
      ].join("\n"),
    );
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.config.runTimeouts).toEqual({
      agentMinutes: 45,
      testMinutes: 7,
      roles: { implement: 90, guardian: 15, "final-review": 60 },
    });
  });

  it("範囲（1〜720 分の整数）の外・整数でない・数でない・知らない役割は、設定の誤り（境界：1 と 720 は読む）", () => {
    for (const ok of [
      "agent_minutes: 1",
      "agent_minutes: 720",
      "test_minutes: 1",
      "roles: { implement: 720 }",
    ]) {
      expect(load(`run_timeout:\n  ${ok}\n`).ok, ok).toBe(true);
    }
    for (const bad of [
      "agent_minutes: 0",
      "agent_minutes: 721",
      "agent_minutes: 1.5",
      'agent_minutes: "30"',
      "test_minutes: 0",
      "test_minutes: 721",
      "roles: { implement: 0 }",
      "roles: { implement: 721 }",
      "roles: { unknown: 10 }",
    ]) {
      expect(load(`run_timeout:\n  ${bad}\n`).ok, bad).toBe(false);
    }
  });

  it("雛形は既定のまま（例はコメントだけ）で、例のとおりに書けば読める", () => {
    expect(CONFIG_TEMPLATE).toMatch(/^# run_timeout:$/m);
    expect(CONFIG_TEMPLATE).toMatch(/^# {3}agent_minutes: 30/m);
    // 「# run_timeout:」から、続くコメントの例の行（「#   」で始まる）だけを取り出し、コメントを外す
    const lines = CONFIG_TEMPLATE.split("\n");
    const start = lines.indexOf("# run_timeout:");
    expect(start).toBeGreaterThan(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => !line.startsWith("#   "));
    const example = ["run_timeout:", ...rest.slice(0, end === -1 ? undefined : end)]
      .map((line) => line.replace(/^# /, "").replace(/\s+#.*$/, ""))
      .join("\n");
    const config = load(`${example}\n`);
    expect(config).toMatchObject({
      ok: true,
      config: { runTimeouts: { agentMinutes: 30, testMinutes: 20, roles: { implement: 90 } } },
    });
  });
});

describe("実行に使う上限", () => {
  const timeouts = { agentMinutes: 45, testMinutes: 7, roles: { implement: 90, guardian: 15 } };

  it("役割の上書きがあればそれ、無ければ既定", () => {
    expect(agentTimeoutMs(timeouts, "implement")).toBe(90 * 60_000);
    expect(agentTimeoutMs(timeouts, "guardian")).toBe(15 * 60_000);
    expect(agentTimeoutMs(timeouts, "requirements")).toBe(45 * 60_000);
    expect(agentTimeoutMs(timeouts)).toBe(45 * 60_000);
    expect(testTimeoutMs(timeouts)).toBe(7 * 60_000);
  });

  it("設定を読めなければ、固定の既定", () => {
    expect(agentTimeoutMs(undefined, "implement")).toBe(30 * 60_000);
    expect(testTimeoutMs(undefined)).toBe(20 * 60_000);
  });
});

describe("時間切れの英語の文言（PR #169 レビュー提案）", () => {
  it("1 分なら minute、それ以外は minutes", () => {
    const en = (code: "run.timeout" | "run.testTimeout", minutes: number) =>
      renderMessage(message(code, { minutes }), "en");
    expect(en("run.timeout", 1)).toBe("Stopped the agent because it ran longer than 1 minute.");
    expect(en("run.timeout", 30)).toBe("Stopped the agent because it ran longer than 30 minutes.");
    expect(en("run.testTimeout", 1)).toBe(
      "Stopped the tests because they ran longer than 1 minute.",
    );
    expect(en("run.testTimeout", 20)).toBe(
      "Stopped the tests because they ran longer than 20 minutes.",
    );
    const mcp = (minutes: number) =>
      renderMessage(
        message("context.mcpTimeoutOverRun", {
          name: "x",
          key: "tool_timeout_sec",
          seconds: 60,
          minutes,
        }),
        "en",
      );
    expect(mcp(1)).toContain("(1 minute)");
    expect(mcp(30)).toContain("(30 minutes)");
    // 日本語は変わらない
    expect(renderMessage(message("run.timeout", { minutes: 1 }), "ja")).toBe(
      "エージェントの実行が 1 分を超えたため止めました。",
    );
  });
});
