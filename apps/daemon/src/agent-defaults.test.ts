import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonText, renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { DEFAULT_AGENTS_PATH, fallbackAgentFor, loadConfig, parseTierId } from "./config.js";

/*
 * エージェントの既定をリポジトリ（config/agents.yaml）に持ち、config.yaml は接続先と単価だけで動く（PBI-134）。
 */

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const ja = (text: DaemonText) => renderMessage(text, "ja");

function load(yaml: string, defaultsPath?: string) {
  dir = dir || mkdtempSync(join(tmpdir(), "sacty-pbi134-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return loadConfig(dir, defaultsPath);
}

function loaded(yaml: string) {
  const result = load(yaml);
  if (!result.ok) throw new Error(ja(result.problem));
  return result.config;
}

function problem(yaml: string): string {
  const result = load(yaml);
  return result.ok ? "" : ja(result.problem);
}

const LUNA = "      gpt-6-luna: { input: 0.25, cached_input: 0.025, output: 2 }\n";
const SOL = "      gpt-6.1-sol: { input: 1.25, cached_input: 0.125, output: 10 }\n";
const codex = (models = LUNA + SOL) =>
  `  codex:\n    auth: { mode: api-key, secret: openai-api-key }\n    available_models:${models ? `\n${models}` : " {}\n"}`;
const CLAUDE_MODELS = [
  "      claude-haiku-5-5: { input: 1, cached_input: 0.1, cache_write: 1.25, output: 5 }\n",
  "      claude-sonnet-5-5: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }\n",
  "      claude-opus-5-5: { input: 15, cached_input: 1.5, cache_write: 18.75, output: 75 }\n",
].join("");
const claude = (models = CLAUDE_MODELS) =>
  `  claude:\n    auth: { mode: subscription, secret: claude-oauth-token }\n    available_models:\n${models}`;
const ALL_TIERS = ["lite", "entry", "standard", "advanced", "ultimate"];

describe("リポジトリの既定（config/agents.yaml）", () => {
  const defaults = parseYaml(readFileSync(DEFAULT_AGENTS_PATH, "utf8")) as {
    default_agent: string[];
    agents: Record<string, { runtime: string; model: string; reasoning_effort?: string }>;
  };
  const table = (prefix: string) =>
    Object.entries(defaults.agents)
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, a]) => [id, a.model, a.reasoning_effort ?? null]);

  it("codex の 5 段階は、決めたモデルとリーズニングエフォート", () => {
    expect(table("codex_")).toEqual([
      ["codex_lite", "gpt-6-luna", "low"],
      ["codex_entry", "gpt-6-luna", "high"],
      ["codex_standard", "gpt-6.1-sol", "low"],
      ["codex_advanced", "gpt-6.1-sol", "medium"],
      ["codex_ultimate", "gpt-6.1-sol", "high"],
    ]);
  });

  it("claude の 5 段階もあり、名前の接頭辞と runtime が合う。既定の工程の AI は codex_standard、次に claude_standard", () => {
    expect(table("claude_").map(([id]) => id)).toEqual(ALL_TIERS.map((t) => `claude_${t}`));
    for (const [id, agent] of Object.entries(defaults.agents)) {
      expect(parseTierId(id)?.runtime, id).toBe(agent.runtime);
    }
    expect(defaults.default_agent).toEqual(["codex_standard", "claude_standard"]);
  });

  it("読めない・形が違うときは、どの既定のファイルかを示して止める", () => {
    const yaml = `providers:\n${codex()}`;
    const missing = load(yaml, join(tmpdir(), "sacty-no-such-defaults.yaml"));
    expect(missing).toMatchObject({ ok: false, problem: { code: "config.defaultsUnreadable" } });
    const bad = join(mkdtempSync(join(tmpdir(), "sacty-pbi134-defaults-")), "agents.yaml");
    try {
      writeFileSync(bad, "default_agent: []\nagents: {}\n");
      const result = load(yaml, bad);
      expect(result.ok ? "" : ja(result.problem)).toContain(bad);
      // 既定のエージェントに runtime が無いのも誤り
      writeFileSync(bad, "default_agent: [x]\nagents:\n  x:\n    model: m\n");
      expect(load(yaml, bad)).toMatchObject({
        ok: false,
        problem: { code: "config.defaultsUnreadable" },
      });
    } finally {
      rmSync(join(bad, ".."), { recursive: true, force: true });
    }
  });
});

describe("接続先と単価だけの config.yaml", () => {
  it("providers.codex だけ：既定の codex の段階がすべて使え、工程の AI は codex_standard。警告は無い", () => {
    const config = loaded(`providers:\n${codex()}`);
    expect(config.defaultAgent).toMatchObject({
      id: "codex_standard",
      model: "gpt-6.1-sol",
      reasoning_effort: "low",
      auth: { mode: "api-key", secret: "openai-api-key" },
      price: { input: 1.25, cachedInput: 0.125, cacheWrite: 0, output: 10 },
    });
    expect(config.guardianAgent.id).toBe("codex_standard");
    expect(config.auditAgent.id).toBe("codex_standard");
    expect(Object.keys(config.tierAgents?.codex ?? {})).toEqual(ALL_TIERS);
    // 接続先の無い claude の既定は、使えないだけ（誤りにも警告にもしない）
    expect(Object.keys(config.agents ?? {}).some((id) => id.startsWith("claude_"))).toBe(false);
    expect(config.agentWarnings).toEqual([]);
  });

  it("providers.claude だけ：工程の AI は claude_standard になる", () => {
    const config = loaded(`providers:\n${claude()}`);
    expect(config.defaultAgent).toMatchObject({
      id: "claude_standard",
      model: "claude-sonnet-5-5",
      reasoning_effort: "medium",
    });
    expect(Object.keys(config.tierAgents?.["claude-code"] ?? {})).toEqual(ALL_TIERS);
    expect(config.tierAgents?.["claude-code"]?.lite?.reasoning_effort).toBeUndefined();
    expect(config.agentWarnings).toEqual([]);
  });

  it("両方：既定の工程の AI は codex_standard", () => {
    const config = loaded(`providers:\n${codex()}${claude()}`);
    expect(config.defaultAgent.id).toBe("codex_standard");
    expect(Object.keys(config.agents ?? {})).toHaveLength(10);
  });

  it("providers・agents・available_models の下をすべてコメントにしても（null）、書いていないのと同じに読む", () => {
    expect(
      loaded(`providers:\n${codex()}agents:\n  # codex_ultimate:\n`).agents?.codex_ultimate,
    ).toMatchObject({ reasoning_effort: "high" });
    expect(load("providers:\n  # codex:\n")).toMatchObject({
      ok: false,
      problem: { code: "config.noDefaultAgent" },
    });
    const empty = loaded(
      `default_agent: s\nagents:\n  s:\n    runtime: stub\nproviders:\n  codex:\n    auth: { mode: subscription }\n    available_models:\n`,
    );
    expect(empty.tierAgents?.codex).toBeUndefined();
    expect(empty.agentWarnings).toHaveLength(2);
  });

  it("providers が無く default_agent も無ければ、工程を動かす AI が無いことを示して止める", () => {
    expect(load("budget:\n  default_per_task_usd: 2\n")).toMatchObject({
      ok: false,
      problem: { code: "config.noDefaultAgent" },
    });
    // 既定の候補がどれも使えない（単価が無い）ときも同じ
    expect(load(`providers:\n${codex("")}`)).toMatchObject({
      ok: false,
      problem: { code: "config.noDefaultAgent" },
    });
    // スタブだけでも動かせる
    expect(loaded("default_agent: s\nagents:\n  s:\n    runtime: stub\n").defaultAgent.id).toBe(
      "s",
    );
  });
});

describe("単価（available_models）が無いモデル", () => {
  it("空・1件・すべて：単価のあるモデルの段階だけが使え、無いモデルはどの段階が使えないかを警告する（誤りにしない）", () => {
    // 1件（luna だけ）
    const one = loaded(`default_agent: codex_lite\nproviders:\n${codex(LUNA)}`);
    expect(Object.keys(one.tierAgents?.codex ?? {})).toEqual(["lite", "entry"]);
    expect((one.agentWarnings ?? []).map(ja)).toEqual([
      "providers.codex.available_models に gpt-6.1-sol の単価が無いので、codex_standard, codex_advanced, codex_ultimate を使えません。単価を足してください。",
    ]);
    // 空：codex の段階はどれも使えない
    const none = loaded(
      `default_agent: c\nagents:\n  c:\n    runtime: claude-code\n    model: claude-sonnet-5-5\nproviders:\n${codex("")}${claude()}`,
    );
    expect(none.tierAgents?.codex).toBeUndefined();
    expect(
      (none.agentWarnings ?? []).map((w) => (w as { params: { model: string } }).params.model),
    ).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
    // すべて
    expect(loaded(`providers:\n${codex()}`).agentWarnings).toEqual([]);
  });

  it("使えない段階を default_agent・step_agents などで指したら、どれが使えないかを示して止める", () => {
    const base = `providers:\n${codex(LUNA)}`;
    for (const [extra, path] of [
      ["", "default_agent"],
      ["default_agent: codex_lite\nguardian_agent: codex_ultimate\n", "guardian_agent"],
      ["default_agent: codex_lite\naudit_agent: codex_advanced\n", "audit_agent"],
      ["default_agent: codex_lite\nstep_agents:\n  design: codex_standard\n", "step_agents.design"],
    ] as const) {
      // 書いていない default_agent（codex_standard が使えない）は、既定の次の候補を探し、無ければ止める
      const result = load(`${base}${extra}`);
      if (extra === "") {
        expect(result).toMatchObject({ ok: false, problem: { code: "config.noDefaultAgent" } });
        continue;
      }
      expect(result.ok ? "" : ja(result.problem), path).toContain(`（${path}）`);
      expect(result).toMatchObject({
        ok: false,
        problem: { params: { detail: { code: "config.agentUnavailable" } } },
      });
    }
    // 誤りには、使えない理由（足すべき単価・接続先）も載せる。設定が誤りのときは画面の警告が出ないため（PR #146 レビュー提案）
    expect(
      problem(`${base}default_agent: codex_lite\nstep_agents:\n  design: codex_standard\n`),
    ).toBe(
      '設定ファイルに誤りがあります（step_agents.design）：step_agents.design の "codex_standard" は使えません：providers.codex.available_models に gpt-6.1-sol の単価が無いので、codex_standard を使えません。単価を足してください。',
    );
    expect(problem(`${base}default_agent: claude_lite\n`)).toContain(
      "エージェント「claude_lite」は、providers.claude が無いので使えません。",
    );
    // 無い名前は、今までどおり agents に無い名前の誤り（継承したプロパティの名前も）
    for (const id of ["nope", "toString", "constructor"]) {
      expect(load(`${base}default_agent: ${id}\n`)).toMatchObject({
        ok: false,
        problem: { params: { detail: { code: "config.agentMissing" } } },
      });
    }
  });

  it("モデルの名前が継承したプロパティの名前（constructor など）でも、単価があるとはしない", () => {
    const config = loaded(
      `default_agent: codex_lite\nproviders:\n${codex(LUNA)}agents:\n  codex_entry:\n    model: constructor\n`,
    );
    expect(config.agents?.codex_entry).toBeUndefined();
  });
});

describe("agents の上書き（任意）", () => {
  const base = `providers:\n${codex()}`;

  it("同じ名前は項目ごとに上書きし、書いていない項目は既定のまま", () => {
    const config = loaded(`${base}agents:\n  codex_ultimate:\n    reasoning_effort: xhigh\n`);
    expect(config.agents?.codex_ultimate).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning_effort: "xhigh",
    });
    const model = loaded(`${base}agents:\n  codex_lite:\n    model: gpt-6.1-sol\n`);
    expect(model.tierAgents?.codex?.lite).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning_effort: "low",
      price: { output: 10 },
    });
  });

  it("上書きしたモデルの単価が無ければ、その段階を使えない扱いにして警告する", () => {
    const config = loaded(`${base}agents:\n  codex_ultimate:\n    model: gpt-7\n`);
    expect(config.agents?.codex_ultimate).toBeUndefined();
    expect((config.agentWarnings ?? []).map(ja)).toEqual([
      "providers.codex.available_models に gpt-7 の単価が無いので、codex_ultimate を使えません。単価を足してください。",
    ]);
  });

  it("新しい名前を足せる（runtime・model が要る）。接続先の無い runtime なら警告する", () => {
    const config = loaded(
      `${base}default_agent: mine\nagents:\n  mine:\n    runtime: codex\n    model: gpt-6-luna\n    reasoning_effort: medium\n  claude-mine:\n    runtime: claude-code\n    model: claude-opus-5-5\n`,
    );
    expect(config.defaultAgent).toMatchObject({ id: "mine", model: "gpt-6-luna" });
    expect((config.agentWarnings ?? []).map(ja)).toEqual([
      "エージェント「claude-mine」は、providers.claude が無いので使えません。",
    ]);
    expect(problem(`${base}agents:\n  mine:\n    model: gpt-6-luna\n`)).toContain(
      "（agents.mine.runtime）",
    );
    expect(problem(`${base}agents:\n  mine:\n    runtime: codex\n`)).toContain(
      "（agents.mine.model）",
    );
  });
});

describe("今までの書き方は誤りにして、直し方を示す（破壊的変更）", () => {
  const base = `providers:\n${codex()}`;

  it("エージェントの auth・provider・via_gateway・price_per_mtok_usd", () => {
    for (const [line, key] of [
      ["auth: { mode: api-key, secret: k }", "auth"],
      ["provider: corp-gw", "provider"],
      ["via_gateway: true", "via_gateway"],
      ["price_per_mtok_usd: { input: 1, cached_input: 0.1, output: 2 }", "price_per_mtok_usd"],
    ]) {
      const text = problem(`${base}agents:\n  codex_lite:\n    ${line}\n`);
      expect(text, key).toContain(`（agents.codex_lite.${key}）`);
      expect(text, key).toContain("providers.codex・providers.claude");
    }
    // スタブには接続先が無いので、単価を書ける（書かなければ 0）
    const stub = loaded(
      `default_agent: s\nagents:\n  s:\n    runtime: stub\n    price_per_mtok_usd: { input: 3, cached_input: 0.3, output: 15 }\n  t:\n    runtime: stub\n`,
    );
    expect(stub.agents?.s?.price).toMatchObject({ input: 3, output: 15 });
    expect(stub.agents?.t?.price).toEqual({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0 });
  });

  it("名前を付けた providers と、今の形式の config.yaml 全体", () => {
    const named = load(
      "providers:\n  corp-gw:\n    base_url: https://gw.example.com/v1\n    secret: k\n",
    );
    expect(named).toMatchObject({
      ok: false,
      problem: {
        params: { path: "providers.corp-gw", detail: { code: "config.providerLegacyName" } },
      },
    });
    expect(ja((named as { problem: DaemonText }).problem)).toContain("mode: openai-compatible");
    // 今までの雛形の形（agents に認証と単価）
    const legacy = load(`default_agent: claude-subscription
agents:
  claude-subscription:
    runtime: claude-code
    auth:
      mode: subscription
      secret: claude-oauth-token
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
`);
    expect(legacy.ok ? "" : ja(legacy.problem)).toContain("agents.claude-subscription.auth");
  });
});

describe("利用制限のときの代わりのエージェント（agents の fallback）", () => {
  it("名前1つか並びで書ける。書かなければ切り替えない。制限中の時間の既定は 60 分", () => {
    const config = loaded(
      `default_agent: claude_standard\nproviders:\n${claude()}${codex()}agents:\n  claude_standard:\n    fallback: codex_standard\n  claude_advanced:\n    fallback: [codex_advanced, claude_standard]\n`,
    );
    expect(config.agents?.claude_standard?.fallback).toEqual(["codex_standard"]);
    expect(config.agents?.claude_advanced?.fallback).toEqual(["codex_advanced", "claude_standard"]);
    // 既定のほかの項目（model など）は残る
    expect(config.agents?.claude_standard?.model).toBe("claude-sonnet-5-5");
    expect(config.defaultAgent.fallback).toEqual(["codex_standard"]);
    expect(config.agents?.codex_standard?.fallback).toBeUndefined();
    expect(config.fallbackCooldownMs).toBe(60 * 60_000);
    expect(config.agentWarnings).toEqual([]);
  });

  it("agent_fallback.cooldown_minutes で制限中の時間を変えられる（1〜1440 分）", () => {
    const base = `providers:\n${codex()}`;
    expect(loaded(`${base}agent_fallback:\n  cooldown_minutes: 15\n`).fallbackCooldownMs).toBe(
      15 * 60_000,
    );
    expect(problem(`${base}agent_fallback:\n  cooldown_minutes: 0\n`)).toContain(
      "agent_fallback.cooldown_minutes",
    );
    expect(problem(`${base}agent_fallback:\n  cooldown_minutes: 1441\n`)).toContain(
      "agent_fallback.cooldown_minutes",
    );
  });

  it("agents に無い名前・自分自身は誤り", () => {
    const base = `providers:\n${codex()}agents:\n  codex_standard:\n`;
    expect(problem(`${base}    fallback: nothing\n`)).toContain(
      'agents.codex_standard.fallback の "nothing" が agents にありません',
    );
    expect(problem(`${base}    fallback: codex_standard\n`)).toContain(
      "そのエージェント自身は書けません",
    );
  });

  it("代わりが使えない（接続先が無い）なら警告し、使えるものだけを残す", () => {
    const config = loaded(
      `providers:\n${codex()}agents:\n  codex_standard:\n    fallback: [claude_standard, codex_advanced]\n  codex_advanced:\n    fallback: claude_advanced\n`,
    );
    expect(config.agents?.codex_standard?.fallback).toEqual(["codex_advanced"]);
    expect(config.agents?.codex_advanced?.fallback).toBeUndefined();
    expect((config.agentWarnings ?? []).map(ja)).toEqual([
      expect.stringContaining(
        "「codex_standard」の代わり（fallback）の「claude_standard」は使えない",
      ),
      expect.stringContaining(
        "「codex_advanced」の代わり（fallback）の「claude_advanced」は使えない",
      ),
    ]);
  });

  it("制限中なら、代わりを上から順に（その代わりも）たどり、制限中でない最初のもの。すべて制限中なら元のもの", () => {
    const config = loaded(
      `providers:\n${claude()}${codex()}agents:\n  claude_ultimate:\n    fallback: [claude_advanced, codex_ultimate]\n  claude_advanced:\n    fallback: codex_advanced\n`,
    );
    const main = config.agents?.claude_ultimate;
    if (!main) throw new Error("unreachable");
    const pick = (...limited: string[]) =>
      fallbackAgentFor(config, main, (id) => limited.includes(id)).id;
    expect(pick()).toBe("claude_ultimate");
    expect(pick("claude_ultimate")).toBe("claude_advanced");
    expect(pick("claude_ultimate", "claude_advanced")).toBe("codex_advanced");
    expect(pick("claude_ultimate", "claude_advanced", "codex_advanced")).toBe("codex_ultimate");
    expect(pick("claude_ultimate", "claude_advanced", "codex_advanced", "codex_ultimate")).toBe(
      "claude_ultimate",
    );
  });
});
