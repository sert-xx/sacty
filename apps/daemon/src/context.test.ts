import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ContextFetcher,
  type ContextRef,
  composeContext,
  GitContextFetcher,
  prepareContext,
  resolveContext,
} from "./context.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-context-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** リポジトリ（URL）ごとに、決めたファイルを置く偽物。 */
class FakeFetcher implements ContextFetcher {
  fetched: string[] = [];
  constructor(private readonly repos: Record<string, Record<string, string>>) {}
  async fetch(ref: ContextRef, out: string) {
    this.fetched.push(`${ref.repo}#${ref.ref ?? ""}`);
    const files = this.repos[ref.repo];
    if (!files) throw new Error("repository not found");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), content);
    }
    return { commit: `${ref.repo.replace(/\W/g, "")}`.padEnd(40, "0").slice(0, 40) };
  }
}

const company = {
  "rules.md": "# 会社の規約\n- 個人情報をログに出さない",
  "skills/review/SKILL.md": "---\ndescription: 会社のレビュー観点\n---\n会社版",
  "skills/release/SKILL.md": "---\ndescription: リリース手順\n---\n会社版",
  "sacty-context.yaml": "locked:\n  skills: [review]\n",
};
const team = {
  "rules/01-style.md": "# チームの規約\n- 早期リターン",
  "rules/02-test.md": "- テストは日本語で書く",
  "skills/review/SKILL.md": "チーム版（上書き禁止に当たる）",
  "skills/release/SKILL.md": "---\ndescription: チームのリリース手順\n---\nチーム版",
  "skills/local/SKILL.md": "チームだけのスキル",
  "sacty-context.yaml":
    "extends: https://example.com/company.git#main\nremove:\n  skills: [review]\n",
};

describe("コンテキストリポジトリの合成（PBI-6）", () => {
  it("extends をたどって上位から並べ、規約は上位から連結、スキルは下位が上書きし、上書き禁止は守る", async () => {
    const fetcher = new FakeFetcher({
      "https://example.com/company.git": company,
      "https://example.com/team.git": team,
    });
    const layers = await resolveContext(
      fetcher,
      { repo: "https://example.com/team.git" },
      join(dir, "w"),
    );
    expect(fetcher.fetched).toEqual([
      "https://example.com/team.git#",
      "https://example.com/company.git#main",
    ]);
    expect(layers.map((l) => l.repo)).toEqual([
      "https://example.com/company.git",
      "https://example.com/team.git",
    ]);
    const composed = composeContext(layers);
    expect(composed.rules.indexOf("会社の規約")).toBeLessThan(
      composed.rules.indexOf("チームの規約"),
    );
    expect(composed.rules.indexOf("早期リターン")).toBeLessThan(
      composed.rules.indexOf("日本語で書く"),
    );
    const skills = Object.fromEntries(composed.skills.map((s) => [s.name, s]));
    expect(readFileSync(join(skills.review?.dir ?? "", "SKILL.md"), "utf8")).toContain("会社版");
    expect(readFileSync(join(skills.release?.dir ?? "", "SKILL.md"), "utf8")).toContain("チーム版");
    expect(skills.local).toBeDefined();
    expect(composed.warnings).toHaveLength(2); // 取り除き・上書きの両方が、上書き禁止に当たった
    expect(composed.warnings.join()).toContain("review");
  });

  it("上書き禁止でない項目は、下位で取り除ける", async () => {
    const fetcher = new FakeFetcher({
      "c.git": { "skills/old/SKILL.md": "x" },
      "t.git": { "sacty-context.yaml": "extends: c.git\nremove:\n  skills: [old]\n" },
    });
    const composed = composeContext(
      await resolveContext(fetcher, { repo: "t.git" }, join(dir, "w")),
    );
    expect(composed.skills).toEqual([]);
    expect(composed.warnings).toEqual([]);
  });

  it("継承の循環・深すぎる継承・取得の失敗・誤った設定は、理由つきで止める", async () => {
    const loop = new FakeFetcher({
      "a.git": { "sacty-context.yaml": "extends: b.git\n" },
      "b.git": { "sacty-context.yaml": "extends: a.git\n" },
    });
    await expect(resolveContext(loop, { repo: "a.git" }, join(dir, "1"))).rejects.toThrow(/循環/);

    const deep: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 12; i++)
      deep[`r${i}.git`] = { "sacty-context.yaml": `extends: r${i + 1}.git\n` };
    await expect(
      resolveContext(new FakeFetcher(deep), { repo: "r0.git" }, join(dir, "2")),
    ).rejects.toThrow(/深すぎます/);

    await expect(
      resolveContext(new FakeFetcher({}), { repo: "missing.git" }, join(dir, "3")),
    ).rejects.toThrow(/取得できません/);

    const bad = new FakeFetcher({ "x.git": { "sacty-context.yaml": "locked: 1\n" } });
    await expect(resolveContext(bad, { repo: "x.git" }, join(dir, "4"))).rejects.toThrow(
      /誤りがあります/,
    );
  });

  it("Claude Code には CLAUDE.md と skills/ を、Codex には AGENTS.md（スキルの一覧つき）と skills/ を書く", async () => {
    const fetcher = new FakeFetcher({
      "https://example.com/company.git": company,
      "https://example.com/team.git": team,
    });
    const claude = await prepareContext(
      fetcher,
      { repo: "https://example.com/team.git" },
      "claude-code",
      "/tmp/sacty-claude-config",
    );
    expect(readFileSync(join(claude.dir, "CLAUDE.md"), "utf8")).toContain("会社の規約");
    expect(existsSync(join(claude.dir, "skills", "release", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claude.dir, "AGENTS.md"))).toBe(false);
    expect(claude.layers).toEqual([
      { repo: "https://example.com/company.git", ref: "main", commit: expect.any(String) },
      { repo: "https://example.com/team.git", commit: expect.any(String) },
    ]);
    claude.dispose();
    expect(existsSync(claude.dir)).toBe(false);

    const codex = await prepareContext(
      fetcher,
      { repo: "https://example.com/team.git" },
      "codex",
      "/tmp/sacty-codex-home",
    );
    const agents = readFileSync(join(codex.dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("チームの規約");
    expect(agents).toContain(
      "- release：チームのリリース手順（/tmp/sacty-codex-home/skills/release/SKILL.md）",
    );
    expect(existsSync(join(codex.dir, "CLAUDE.md"))).toBe(false);
    codex.dispose();
  });
});

describe("MCP サーバーの合成と変換（PBI-6b）", () => {
  const companyMcp = {
    "mcp.yaml": [
      "servers:",
      "  github:",
      "    command: npx",
      "    args: [-y, server-github]",
      "    env:",
      "      GITHUB_TOKEN: { secret: gh-token }",
      "      LOG_LEVEL: info",
      "  docs:",
      "    url: https://docs.example.com/mcp",
      "    headers:",
      "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
      "      X-Team: company",
      "  old:",
      "    command: old-server",
    ].join("\n"),
    "sacty-context.yaml": "locked:\n  mcp: [github]\n",
  };
  const teamMcp = {
    "mcp.yaml": [
      "servers:",
      "  github:",
      "    command: team-github",
      "  docs:",
      "    url: https://team.example.com/mcp",
      "  local:",
      "    command: ./local-server",
    ].join("\n"),
    "sacty-context.yaml": "extends: company.git\nremove:\n  mcp: [old]\n",
  };
  const fetcher = () => new FakeFetcher({ "company.git": companyMcp, "team.git": teamMcp });

  it("名前ごとに下位が上書きし、上書き禁止は守り、取り除ける", async () => {
    const composed = composeContext(
      await resolveContext(fetcher(), { repo: "team.git" }, join(dir, "w")),
    );
    const mcp = Object.fromEntries(composed.mcp.map((m) => [m.name, m.server]));
    expect(Object.keys(mcp).sort()).toEqual(["docs", "github", "local"]);
    expect(mcp.github).toMatchObject({ command: "npx" }); // 上書き禁止
    expect(mcp.docs).toEqual({ url: "https://team.example.com/mcp", headers: {} }); // 下位が上書き
    expect(composed.warnings).toEqual([expect.stringContaining("MCP サーバー「github」を上書き")]);
  });

  it("Claude Code には、秘密情報を環境変数の参照にした mcp.json を書く（値は書かない）", async () => {
    const companyOnly = await prepareContext(
      fetcher(),
      { repo: "company.git" },
      "claude-code",
      "/tmp/sacty-claude-config",
    );
    const json = JSON.parse(readFileSync(join(companyOnly.dir, "mcp.json"), "utf8"));
    expect(json).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "server-github"],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: 設定に書く参照の文字列そのもの
          env: { GITHUB_TOKEN: "${SACTY_MCP_SECRET_0}", LOG_LEVEL: "info" },
        },
        docs: {
          type: "http",
          url: "https://docs.example.com/mcp",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: 設定に書く参照の文字列そのもの
          headers: { Authorization: "${SACTY_MCP_SECRET_1}", "X-Team": "company" },
        },
        old: { command: "old-server", args: [], env: {} },
      },
    });
    expect(companyOnly.placed).toEqual({
      mcpServers: ["github", "docs", "old"],
      secrets: [
        { env: "SACTY_MCP_SECRET_0", secret: "gh-token", prefix: "" },
        { env: "SACTY_MCP_SECRET_1", secret: "docs-token", prefix: "Bearer " },
      ],
    });
    companyOnly.dispose();
  });

  it("Codex には config.toml を書き、秘密情報は env_vars と env_http_headers で名前だけを渡す", async () => {
    const codex = await prepareContext(
      fetcher(),
      { repo: "company.git" },
      "codex",
      "/tmp/sacty-codex-home",
    );
    const toml = readFileSync(join(codex.dir, "config.toml"), "utf8");
    expect(toml).toBe(
      [
        '[mcp_servers."github"]',
        'command = "/bin/sh"',
        'args = ["-c", "export GITHUB_TOKEN=\\"$SACTY_MCP_SECRET_0\\"; exec \\"$0\\" \\"$@\\"", "npx", "-y", "server-github"]',
        'env_vars = ["SACTY_MCP_SECRET_0"]',
        'env = { "LOG_LEVEL" = "info" }',
        "",
        '[mcp_servers."docs"]',
        'url = "https://docs.example.com/mcp"',
        'http_headers = { "X-Team" = "company" }',
        'env_http_headers = { "Authorization" = "SACTY_MCP_SECRET_1" }',
        "",
        '[mcp_servers."old"]',
        'command = "old-server"',
        "args = []",
        "",
      ].join("\n"),
    );
    expect(codex.placed.secrets).toHaveLength(2);
    codex.dispose();
  });

  it("TOML で使えない文字（DEL）はエスケープする", async () => {
    const codex = await prepareContext(
      new FakeFetcher({
        "x.git": { "mcp.yaml": 'servers:\n  a:\n    command: x\n    args: ["a\\x7Fb\\n"]\n' },
      }),
      { repo: "x.git" },
      "codex",
      "/tmp/sacty-codex-home",
    );
    expect(readFileSync(join(codex.dir, "config.toml"), "utf8")).toContain(
      'args = ["a\\u007Fb\\n"]',
    );
    codex.dispose();
  });

  it("誤った MCP の設定は、理由つきで止める", async () => {
    const cases: [string, RegExp][] = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 設定に書く参照の文字列そのもの
      ["servers:\n  a:\n    command: x\n    env:\n      K: 'v${HOME}'\n", /servers\.a\.env\.K/],
      ["servers:\n  a:\n    command: x\n    env:\n      K: { secret: 'a b' }\n", /secret/],
      ["servers:\n  a.b:\n    command: x\n", /MCP サーバーの名前/],
      ["servers:\n  a:\n    command: x\n    url: https://x\n", /mcp.yaml に誤り/],
      ["servers:\n  a:\n    url: file:///etc/passwd\n", /mcp.yaml に誤り/],
      ["servers:\n  a:\n    command: x\n    env:\n      'A-B': v\n", /環境変数の名前/],
    ];
    for (const [i, [yaml, error]] of cases.entries()) {
      await expect(
        resolveContext(
          new FakeFetcher({ "x.git": { "mcp.yaml": yaml } }),
          { repo: "x.git" },
          join(dir, String(i)),
        ),
      ).rejects.toThrow(error);
    }
  });
});

describe("git でのコンテキストの取得（PBI-6）", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  function makeRepo(name: string, files: Record<string, string>, branch = "main") {
    const repo = join(dir, name);
    mkdirSync(repo);
    git(repo, "init", `--initial-branch=${branch}`);
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git(repo, "add", "--all");
    git(repo, "commit", "-m", "init");
    return repo;
  }

  it("ローカルのリポジトリを継承をたどって取得し、使ったコミットを返す", async () => {
    const parent = makeRepo("company", { "rules.md": "会社の規約" }, "stable");
    const child = makeRepo("team", {
      "rules.md": "チームの規約",
      "sacty-context.yaml": `extends: ${parent}#stable\n`,
    });
    const prepared = await prepareContext(
      new GitContextFetcher(),
      { repo: child },
      "claude-code",
      "/tmp/sacty-claude-config",
    );
    expect(prepared.layers).toEqual([
      { repo: parent, ref: "stable", commit: git(parent, "rev-parse", "HEAD") },
      { repo: child, commit: git(child, "rev-parse", "HEAD") },
    ]);
    expect(readFileSync(join(prepared.dir, "CLAUDE.md"), "utf8")).toMatch(
      /会社の規約[\s\S]*チームの規約/,
    );
    prepared.dispose();
  });

  it("設定・規約・スキルのシンボリックリンクは、リポジトリの外を指しても中を指しても、理由を示して止める", async () => {
    const outside = join(dir, "host-secret.txt");
    writeFileSync(outside, "HOST-ONLY-MARKER");
    const cases: [string, (repo: string) => void][] = [
      ["rules.md", (repo) => symlinkSync(outside, join(repo, "rules.md"))],
      ["sacty-context.yaml", (repo) => symlinkSync(outside, join(repo, "sacty-context.yaml"))],
      [
        "rules/01.md",
        (repo) => {
          mkdirSync(join(repo, "rules"));
          symlinkSync(outside, join(repo, "rules", "01.md"));
        },
      ],
      [
        "skills/sample/ref.md",
        (repo) => {
          mkdirSync(join(repo, "skills", "sample"), { recursive: true });
          writeFileSync(join(repo, "skills", "sample", "SKILL.md"), "スキル");
          writeFileSync(join(repo, "skills", "sample", "guide.md"), "手引き");
          symlinkSync("guide.md", join(repo, "skills", "sample", "ref.md"));
        },
      ],
      [
        "skills",
        (repo) => {
          mkdirSync(join(repo, "real-skills", "s"), { recursive: true });
          writeFileSync(join(repo, "real-skills", "s", "SKILL.md"), "スキル");
          symlinkSync("real-skills", join(repo, "skills"));
        },
      ],
    ];
    for (const [i, [path, setup]] of cases.entries()) {
      const repo = makeRepo(`linked-${i}`, { "README.md": "x" });
      setup(repo);
      git(repo, "add", "--all");
      git(repo, "commit", "-m", "link");
      await expect(
        prepareContext(new GitContextFetcher(), { repo }, "claude-code", "/tmp/x"),
      ).rejects.toThrow(`${path} はシンボリックリンクです`);
    }
  });

  it("sacty が読まない場所のシンボリックリンクは、取得を妨げない", async () => {
    const repo = makeRepo("other-link", { "rules.md": "規約" });
    symlinkSync("rules.md", join(repo, "README.md"));
    git(repo, "add", "--all");
    git(repo, "commit", "-m", "link");
    const prepared = await prepareContext(
      new GitContextFetcher(),
      { repo },
      "claude-code",
      "/tmp/x",
    );
    expect(readFileSync(join(prepared.dir, "CLAUDE.md"), "utf8")).toContain("規約");
    prepared.dispose();
  });
});
