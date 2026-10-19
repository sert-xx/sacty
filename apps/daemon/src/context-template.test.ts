import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ContextFetcher,
  type ContextRef,
  composeContext,
  DEFAULT_CONTEXT_DIR,
  loadDefaultContext,
  prepareContext,
  resolveContext,
} from "./context.js";
import { CONTEXT_TEMPLATE_FILES, initContextRepo } from "./context-template.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-context-template-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** リポジトリ（URL）ごとに、ローカルのディレクトリを写す偽物。 */
class DirFetcher implements ContextFetcher {
  constructor(private readonly repos: Record<string, string>) {}
  async fetch(ref: ContextRef, out: string) {
    const src = this.repos[ref.repo];
    if (!src) throw new Error("repository not found");
    cpSync(src, out, { recursive: true });
    return { commit: "0".repeat(40) };
  }
}

const templatePaths = Object.keys(CONTEXT_TEMPLATE_FILES);

describe("コンテキストリポジトリの雛形（PBI-45）", () => {
  it("空のディレクトリに、既定のコンテキストと同じ構成の雛形を作る", () => {
    const repo = join(dir, "context");
    const written = initContextRepo(repo, false);
    expect(written).toEqual(templatePaths);
    expect(templatePaths).toEqual(
      expect.arrayContaining(["README.md", "rules.md", "agents/codex/config.toml"]),
    );
    expect(templatePaths.some((p) => p.startsWith("skills/"))).toBe(true);
    for (const path of templatePaths) {
      expect(readFileSync(join(repo, path), "utf8")).toBe(CONTEXT_TEMPLATE_FILES[path]);
    }
  });

  it.each(["claude-code", "codex"] as const)(
    "作った雛形をコンテキストリポジトリに指定しても、そのまま読めて既定を変えない（%s）",
    async (runtime) => {
      const repo = join(dir, "context");
      initContextRepo(repo, false);
      const fetcher = new DirFetcher({ "https://example.com/context.git": repo });
      const prepared = await prepareContext(
        fetcher,
        { repo: "https://example.com/context.git" },
        runtime,
        "/sacty/context",
        undefined,
        DEFAULT_CONTEXT_DIR,
      );
      try {
        expect(prepared.warnings).toEqual([]);
        expect(prepared.layers.map((l) => l.repo)).toEqual([
          "sacty-default",
          "https://example.com/context.git",
        ]);
        expect(prepared.placed.mcpServers).toEqual([]);
        // 雛形のスキルの説明（skills/README.md）はスキルにならず、既定のスキルだけが置かれる
        expect(readdirSync(join(prepared.dir, "skills"))).toEqual([
          "ears-requirements",
          "git",
          "memory",
          "plan-steps",
          "review-dispatch",
          "review-execution",
          "writing",
        ]);
      } finally {
        prepared.dispose();
      }
      // エージェントの設定・写すファイルは、既定のコンテキストだけのときと同じ
      const layers = await resolveContext(
        fetcher,
        { repo: "https://example.com/context.git" },
        join(dir, "w"),
      );
      const withTemplate = composeContext([loadDefaultContext(DEFAULT_CONTEXT_DIR), ...layers]);
      const defaultOnly = composeContext([loadDefaultContext(DEFAULT_CONTEXT_DIR)]);
      expect(withTemplate.agents).toEqual(defaultOnly.agents);
      expect(withTemplate.agentFiles).toEqual(defaultOnly.agentFiles);
      expect(withTemplate.skills).toEqual(defaultOnly.skills);
      expect(defaultOnly.skills.map((s) => s.name)).toEqual([
        "ears-requirements",
        "git",
        "memory",
        "plan-steps",
        "review-dispatch",
        "review-execution",
        "writing",
      ]);
    },
  );

  it("雛形のコメントの例を外しても、sacty が読める形になっている", async () => {
    const repo = join(dir, "context");
    initContextRepo(repo, false);
    // 例は ASCII の行、説明は日本語の行。例の行だけをコメントから外す
    for (const path of [
      "mcp.yaml",
      "platforms.yaml",
      "sacty-context.yaml",
      "agents/codex/config.toml",
    ]) {
      const lines = readFileSync(join(repo, path), "utf8").split("\n");
      const examples = lines.filter((l) => /^[\x20-\x7e]*$/.test(l)).map((l) => l.slice(2));
      writeFileSync(join(repo, path), examples.join("\n"));
    }
    const parent = join(dir, "parent");
    mkdirSync(join(parent, "skills", "review"), { recursive: true });
    writeFileSync(join(parent, "skills", "review", "SKILL.md"), "親のレビュー");
    const fetcher = new DirFetcher({
      "https://example.com/context.git": repo,
      "git@github.com:acme/sacty-context.git": parent,
    });
    const layers = await resolveContext(
      fetcher,
      { repo: "https://example.com/context.git" },
      join(dir, "w"),
    );
    expect(layers.map((l) => `${l.repo}#${l.ref ?? ""}`)).toEqual([
      "git@github.com:acme/sacty-context.git#main",
      "https://example.com/context.git#",
    ]);
    const composed = composeContext(layers);
    expect(composed.mcp.map((m) => m.name)).toEqual(["docs", "local-tool", "container-tool"]);
    // command のサーバーは既定でホスト、via_gateway: false はコンテナの中（PBI-84）
    expect(
      composed.mcp.map((m) => ("command" in m.server ? m.server.via_gateway : undefined)),
    ).toEqual([undefined, true, false]);
    // 外部 PF の例も読める（PBI-74）
    expect(composed.platforms.map((p) => [p.name, p.allow])).toEqual([
      ["ticket", ["GET /api/v1/tickets/**"]],
    ]);
    expect(composed.agents.codex).toEqual({ model_reasoning_effort: "high" });
    expect(composed.warnings).toEqual([]);
  });

  it("雛形と同じファイルがあれば、何も書かずに理由を示して止まる", () => {
    writeFileSync(join(dir, "rules.md"), "自分の規則");
    expect(() => initContextRepo(dir, false)).toThrow(/rules\.md.*--force/);
    expect(readFileSync(join(dir, "rules.md"), "utf8")).toBe("自分の規則");
    expect(existsSync(join(dir, "README.md"))).toBe(false);
  });

  it("rules/ があれば止まる（作る rules.md が rules/*.md を読まれなくするため）", () => {
    mkdirSync(join(dir, "rules"));
    writeFileSync(join(dir, "rules", "01.md"), "自分の規則");
    expect(() => initContextRepo(dir, false)).toThrow(/rules.*--force/);
    expect(existsSync(join(dir, "rules.md"))).toBe(false);
  });

  it("雛形に無いファイル（.git など）だけなら、残したまま作る", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "notes.txt"), "メモ");
    initContextRepo(dir, false);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("メモ");
    expect(existsSync(join(dir, "rules.md"))).toBe(true);
  });

  it("--force なら、雛形と同じファイルを上書きし、ほかのファイルは残す", () => {
    writeFileSync(join(dir, "rules.md"), "自分の規則");
    writeFileSync(join(dir, "notes.txt"), "メモ");
    initContextRepo(dir, true);
    expect(readFileSync(join(dir, "rules.md"), "utf8")).toBe(CONTEXT_TEMPLATE_FILES["rules.md"]);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("メモ");
  });

  it("リンクも、あるものとして止まる。--force ならリンク先は書き換えずにファイルに置き換える", () => {
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "外のファイル");
    const repo = join(dir, "context");
    mkdirSync(repo);
    symlinkSync(outside, join(repo, "rules.md"));
    symlinkSync(join(dir, "missing"), join(repo, "mcp.yaml"));
    expect(() => initContextRepo(repo, false)).toThrow(/rules\.md・mcp\.yaml/);
    initContextRepo(repo, true);
    expect(readFileSync(outside, "utf8")).toBe("外のファイル");
    expect(readFileSync(join(repo, "rules.md"), "utf8")).toBe(CONTEXT_TEMPLATE_FILES["rules.md"]);
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });

  it.each([
    ["skills", "skills"],
    ["agents", "agents"],
    ["agents/codex", "agents/codex"],
  ])(
    "途中のディレクトリ（%s）がリンクなら、--force でもリンク先に書かずに止まる",
    (link, shown) => {
      const outside = join(dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "README.md"), "外の README");
      writeFileSync(join(outside, "config.toml"), "外の設定");
      const repo = join(dir, "context");
      mkdirSync(join(repo, link, ".."), { recursive: true });
      symlinkSync(outside, join(repo, link));
      for (const force of [false, true]) {
        expect(() => initContextRepo(repo, force)).toThrow(
          new RegExp(`${shown.replace("/", "\\/")} がディレクトリではありません`),
        );
      }
      expect(readFileSync(join(outside, "README.md"), "utf8")).toBe("外の README");
      expect(readFileSync(join(outside, "config.toml"), "utf8")).toBe("外の設定");
      expect(existsSync(join(outside, "codex"))).toBe(false);
      // 止まったときは、ほかの雛形も書かない
      expect(existsSync(join(repo, "rules.md"))).toBe(false);
    },
  );

  it("途中のディレクトリの場所がファイルでも、止まる", () => {
    writeFileSync(join(dir, "skills"), "ファイル");
    expect(() => initContextRepo(dir, true)).toThrow(/skills がディレクトリではありません/);
    expect(readFileSync(join(dir, "skills"), "utf8")).toBe("ファイル");
  });
});

describe("コンテキストリポジトリの雛形の、段階のサブエージェント（PBI-119）", () => {
  it("段階の名前の定義は sacty が作るので、置いても使わないことを README に書く", () => {
    const readme = CONTEXT_TEMPLATE_FILES["README.md"] ?? "";
    expect(readme).toContain("段階のサブエージェントの定義");
    expect(readme).toContain("agents/claude/agents/<段階>.md");
    expect(readme).toContain("[agents.<段階>]");
    expect(readme).toContain("ここに置いても使わない");
  });
});
