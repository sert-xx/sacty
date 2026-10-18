import { message } from "@sacty/core";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { sameConnection, selectTiers, tierFilePath, tierFiles } from "./tiers.js";

const claude = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "claude-subscription",
  runtime: "claude-code",
  auth: { mode: "subscription", secret: "claude-oauth-token" },
  price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  via_gateway: false,
  ...overrides,
});

const codex = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "codex-key",
  runtime: "codex",
  auth: { mode: "api-key", secret: "openai-key" },
  price: { input: 1.25, cachedInput: 0.125, cacheWrite: 0, output: 10 },
  via_gateway: false,
  ...overrides,
});

describe("エージェントの段階（PBI-119）", () => {
  it("親と認証・接続先が同じ段階だけを、段階の順に置き、違う段階は警告にする", () => {
    const parent = claude();
    const { entries, warnings } = selectTiers(parent, {
      ultimate: claude({
        id: "claude_ultimate",
        model: "claude-opus-5-5",
        reasoning_effort: "high",
      }),
      lite: claude({ id: "claude_lite", model: "claude-haiku-5-5" }),
      // 別のトークン（別の契約）で動く段階は、親のプロセスでは使えない
      standard: claude({
        id: "claude_standard",
        model: "claude-sonnet-5-5",
        auth: { mode: "subscription", secret: "another-token" },
      }),
    });
    expect(entries).toEqual([
      { tier: "lite", agentId: "claude_lite", model: "claude-haiku-5-5" },
      {
        tier: "ultimate",
        agentId: "claude_ultimate",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
      },
    ]);
    expect(warnings).toEqual([
      message("agents.tierConnectionDiffers", {
        tier: "standard",
        id: "claude_standard",
        parent: "claude-subscription",
      }),
    ]);
  });

  it("モデルを書いていない段階も置く（親のモデルを引き継ぐ定義になる）", () => {
    const { entries, warnings } = selectTiers(claude(), { entry: claude({ id: "claude_entry" }) });
    expect(entries).toEqual([{ tier: "entry", agentId: "claude_entry" }]);
    expect(warnings).toEqual([]);
    expect(tierFiles("claude-code", entries)[0]).toMatchObject({
      path: "agents/entry.md",
    });
    const content = (tierFiles("claude-code", entries)[0] as { content: string }).content;
    expect(content).not.toContain("model:");
    expect(content).not.toContain("effort:");
  });

  it("stub の親には何も置かない", () => {
    const parent = claude({ id: "stub", runtime: "stub", auth: { mode: "stub" } });
    expect(selectTiers(parent, { standard: claude({ id: "claude_standard" }) })).toEqual({
      entries: [],
      warnings: [],
    });
  });

  it("接続先の比較は、runtime・認証・providers の接続先・ゲートウェイ経由で行う", () => {
    expect(sameConnection(codex(), codex({ id: "codex_lite", model: "gpt-6-mini" }))).toBe(true);
    expect(sameConnection(codex(), codex({ via_gateway: true }))).toBe(false);
    expect(
      sameConnection(
        codex({
          auth: { mode: "provider", provider: "corp" },
          endpoint: { name: "corp", baseUrl: "https://gw.example/v1", viaGateway: false },
        }),
        codex({
          auth: { mode: "provider", provider: "corp" },
          endpoint: { name: "corp", baseUrl: "https://other.example/v1", viaGateway: false },
        }),
      ),
    ).toBe(false);
    expect(sameConnection(claude(), codex())).toBe(false);
  });

  it("Claude Code には agents/<段階>.md（frontmatter の name・model・effort）を置く", () => {
    const [file] = tierFiles("claude-code", [
      {
        tier: "advanced",
        agentId: "claude_advanced",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
      },
    ]);
    expect(file?.path).toBe("agents/advanced.md");
    const content = (file as { content: string }).content;
    const [, frontmatter, body] = content.split("---\n");
    expect(frontmatter).toContain("name: advanced\n");
    expect(frontmatter).toContain('model: "claude-opus-5-5"\n');
    expect(frontmatter).toContain('effort: "high"\n');
    expect(frontmatter).toContain("description: ");
    // 本文は、親の依頼文だけに従うことを書く
    expect(body).toContain("依頼文");
  });

  it("Codex には agents/<段階>.toml（name・description・developer_instructions・model・model_reasoning_effort）を置く", () => {
    const [file] = tierFiles("codex", [
      { tier: "lite", agentId: "codex_lite", model: "gpt-6-mini", reasoningEffort: "low" },
    ]);
    expect(file?.path).toBe("agents/lite.toml");
    const parsed = parseToml((file as { content: string }).content);
    expect(parsed).toEqual({
      name: "lite",
      description: expect.stringContaining("lite"),
      developer_instructions: expect.stringContaining("依頼文"),
      model: "gpt-6-mini",
      model_reasoning_effort: "low",
    });
    // 文字列の記号（引用符・改行）を TOML として逃がす
    expect(tierFilePath("codex", "ultimate")).toBe("agents/ultimate.toml");
  });
});
