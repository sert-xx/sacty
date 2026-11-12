import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_INSTRUCTIONS_MAX_BYTES,
  claudeLaunch,
  codexLaunch,
  codexUserMcpServers,
  LaunchError,
  type LaunchFile,
  tomlValue,
} from "./local-launch.js";

const file = (path: string, content: string, from?: string): LaunchFile => ({
  path,
  content: Buffer.from(content).toString("base64"),
  ...(from ? { from } : {}),
});

/** -c の値の一覧（-c の次の引数）。 */
const overrides = (args: readonly string[]) =>
  args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

describe("claudeLaunch", () => {
  it("規則・設定・MCP・サブエージェント・スキルを、設定の場所を変えずに引数で渡す", () => {
    const plan = claudeLaunch(
      "/tmp/l",
      [
        file("CLAUDE.md", "規則\n"),
        file("settings.json", "{}\n"),
        file("mcp.json", '{ "mcpServers": { "wiki": {} } }\n'),
        file(
          "agents/standard.md",
          '---\nname: standard\ndescription: "段階"\nmodel: "claude-sonnet-5-5"\neffort: "high"\n---\n\n依頼文に従う\n',
        ),
        file("skills/review/SKILL.md", "# review", "acme/context"),
      ],
      ["--model", "claude-opus-5-5"],
    );
    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual([
      "--append-system-prompt-file",
      "/tmp/l/CLAUDE.md",
      "--settings",
      "/tmp/l/settings.json",
      "--mcp-config",
      "/tmp/l/mcp.json",
      "--strict-mcp-config",
      "--agents",
      JSON.stringify({
        standard: { description: "段階", prompt: "依頼文に従う", model: "claude-sonnet-5-5" },
      }),
      "--add-dir",
      "/tmp/l",
      "--permission-mode",
      "default",
      "--model",
      "claude-opus-5-5",
    ]);
    expect(plan.files.map((f) => f.path)).toEqual([
      "CLAUDE.md",
      "settings.json",
      "mcp.json",
      ".claude/skills/review/SKILL.md",
    ]);
    expect(plan.notApplied).toEqual([]);
  });

  it("MCP サーバーが無くても、利用者の MCP サーバーを使わないよう空の設定を渡し、渡せないファイルは知らせる", () => {
    const plan = claudeLaunch("/tmp/l", [
      file("commands/hello.md", "hi", "acme/context"),
      file("rules/x.rules", "#", "sacty-default@e24b633"),
    ]);
    expect(plan.files).toEqual([
      { path: "mcp.json", content: Buffer.from('{ "mcpServers": {} }\n') },
    ]);
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.args).not.toContain("--add-dir");
    expect(plan.notApplied).toEqual([{ path: "commands/hello.md", from: "acme/context" }]);
  });
});

describe("codexLaunch", () => {
  it("規則・設定・MCP・サブエージェントを -c で渡し、利用者の MCP サーバーを止め、approvals_reviewer は渡さない", () => {
    const plan = codexLaunch(
      "/tmp/l",
      [
        file("AGENTS.md", '規則 "引用"\n- review（/tmp/l/skills/review/SKILL.md）\n'),
        file(
          "config.toml",
          [
            'approvals_reviewer = "auto_review"',
            'model = "gpt-6-sol"',
            "[features]",
            "multi_agent = true",
            "[agents]",
            "max_threads = 16",
            "[agents.helper]",
            'config_file = "agents/helper.toml"',
            '[mcp_servers."wiki"]',
            'url = "http://127.0.0.1:5001/ctx-mcp/wiki"',
            'env_http_headers = { Authorization = "SACTY_MCP_SECRET_0" }',
          ].join("\n"),
        ),
        file("agents/standard.toml", 'name = "standard"\ndescription = "段階"\n'),
        file("skills/review/SKILL.md", "# review"),
      ],
      ["mine"],
      ["--model", "gpt-6-sol"],
    );
    expect(plan.command).toBe("codex");
    expect(overrides(plan.args)).toEqual([
      'developer_instructions="規則 \\"引用\\"\\n- review（/tmp/l/skills/review/SKILL.md）\\n"',
      'mcp_servers.wiki={ url = "http://127.0.0.1:5001/ctx-mcp/wiki", env_http_headers = { Authorization = "SACTY_MCP_SECRET_0" } }',
      'model="gpt-6-sol"',
      "features.multi_agent=true",
      "agents.max_threads=16",
      'agents.helper.config_file="/tmp/l/agents/helper.toml"',
      'agents.standard.config_file="/tmp/l/agents/standard.toml"',
      'agents.standard.description="段階"',
      "mcp_servers.mine.enabled=false",
    ]);
    expect(plan.args.slice(-6)).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--model",
      "gpt-6-sol",
    ]);
    expect(plan.files.map((f) => f.path)).toEqual([
      "agents/standard.toml",
      "skills/review/SKILL.md",
    ]);
  });

  it("利用者の設定と同じ名前のコンテキストの MCP サーバーは、混ざらないよう別の名前で渡し、利用者のものは止める", () => {
    const plan = codexLaunch(
      "/tmp/l",
      [
        file(
          "config.toml",
          '[mcp_servers.xxx]\nurl = "http://127.0.0.1:5001/ctx-mcp/xxx"\n[mcp_servers.wiki]\nurl = "http://w"\n',
        ),
      ],
      ["xxx", "xxx-sacty"],
    );
    expect(overrides(plan.args)).toEqual([
      'mcp_servers.xxx-sacty-2={ url = "http://127.0.0.1:5001/ctx-mcp/xxx" }',
      'mcp_servers.wiki={ url = "http://w" }',
      "mcp_servers.xxx.enabled=false",
      "mcp_servers.xxx-sacty.enabled=false",
    ]);
    expect(plan.renamed).toEqual([{ from: "xxx", to: "xxx-sacty-2" }]);
  });

  it("利用者が `--` の後でサンドボックス・承認の方針を渡したら、sacty の同じ引数は渡さない（2 回渡すと Codex が起動しない）", () => {
    const plan = codexLaunch(
      "/tmp/l",
      [],
      [],
      ["-s", "danger-full-access", "--ask-for-approval=never"],
    );
    expect(plan.args).toEqual(["-s", "danger-full-access", "--ask-for-approval=never"]);
  });

  it("規則が引数で渡せる大きさを超えたら、起動せずに止める", () => {
    expect(() =>
      codexLaunch("/tmp/l", [file("AGENTS.md", "あ".repeat(CODEX_INSTRUCTIONS_MAX_BYTES))]),
    ).toThrow(LaunchError);
  });

  it("「.」を含む設定のキーは、引数で渡せないので止める", () => {
    expect(() =>
      codexLaunch("/tmp/l", [file("config.toml", '[mcp_servers."a.b"]\nurl = "http://x"\n')]),
    ).toThrow(LaunchError);
  });
});

describe("tomlValue", () => {
  it("文字列・数・真偽値・配列・表を TOML の値にする", () => {
    expect(tomlValue("a\nb")).toBe('"a\\nb"');
    expect(tomlValue(3)).toBe("3");
    expect(tomlValue(false)).toBe("false");
    expect(tomlValue(["x", 1])).toBe('["x", 1]');
    expect(tomlValue({ a: 1, "b c": "d" })).toBe('{ a = 1, "b c" = "d" }');
  });
});

describe("codexUserMcpServers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("利用者の設定と、対象リポジトリの根までの .codex/config.toml の MCP サーバーの名前を読む", () => {
    const root = mkdtempSync(join(tmpdir(), "sacty-local-launch-"));
    dirs.push(root);
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".codex"), { recursive: true });
    mkdirSync(join(repo, "pkg", ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.mine]\ncommand = "x"\n');
    writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.repo]\ncommand = "y"\n');
    writeFileSync(join(repo, "pkg", ".codex", "config.toml"), "not toml [");
    expect(codexUserMcpServers(join(repo, "pkg"), {}, home).sort()).toEqual(["mine", "repo"]);
    // CODEX_HOME があれば、そちらの設定を読む
    expect(codexUserMcpServers(repo, { CODEX_HOME: join(root, "none") }, home)).toEqual(["repo"]);
  });
});
