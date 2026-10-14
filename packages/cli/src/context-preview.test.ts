import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimDaemonFile,
  DAEMON_FILE,
  fetchContextPreview,
  formatContextPreview,
  type PreviewView,
  previewOutput,
  readDaemonFile,
  removeDaemonFile,
  writeDaemonFile,
} from "./context-preview.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-cli-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const view: PreviewView = {
  runtime: "codex",
  layers: [
    {
      repo: "https://example.com/ctx.git",
      ref: "main",
      commit: "c0ffee",
      locked: { skills: ["review"], mcp: [], platforms: [] },
      remove: { skills: [], mcp: ["old"], platforms: [] },
    },
  ],
  files: [
    { path: "AGENTS.md", generated: true, size: 6, content: "# 規約" },
    { path: "skills/a/logo.png", from: "ctx@c0ffee0", generated: false, size: 4, binary: true },
  ],
  mcp: [
    {
      name: "docs",
      from: "ctx@c0ffee0",
      agent: { url: "http://host.docker.internal:5001/ctx-mcp/docs" },
      origin: { kind: "gateway", url: "https://docs.example.com/mcp", headers: {} },
    },
  ],
  skills: [{ name: "a", from: "ctx@c0ffee0" }],
  rules: ["ctx@c0ffee0"],
  agentSettings: [],
  effects: [{ kind: "skills", name: "old", effect: "removed", by: "ctx@c0ffee0", of: "base" }],
  secrets: [
    {
      env: "SACTY_MCP_SECRET_0",
      secret: "sacty:gateway-token",
      prefix: "Bearer ",
      gatewayToken: true,
    },
    { env: "SACTY_MCP_SECRET_1", secret: "op://vault/item/token", prefix: "", gatewayToken: false },
  ],
  env: { MCP_TIMEOUT: "45000" },
  platforms: [{ name: "jira", description: "JIRA", allow: [] }],
  warnings: [{ code: "context.hostMcpOverride", params: { from: "ctx@c0ffee0", name: "cloud" } }],
};

describe("sacty context preview（PBI-76）", () => {
  it("起動中のデーモンの接続先は本人だけが読める権限で置き、自分のものだけを消す", () => {
    writeFileSync(join(home, DAEMON_FILE), "{}", { mode: 0o644 });
    writeDaemonFile(home, { url: "http://127.0.0.1:4890", token: "t1" });
    expect(statSync(join(home, DAEMON_FILE)).mode & 0o777).toBe(0o600);
    expect(readDaemonFile(home)).toEqual({ url: "http://127.0.0.1:4890", token: "t1" });
    // ほかの sacty が書いたもの（トークン・接続先が違う）は消さない
    removeDaemonFile(home, { url: "http://127.0.0.1:4890", token: "other" });
    removeDaemonFile(home, { url: "http://127.0.0.1:4999", token: "t1" });
    expect(readDaemonFile(home)).toBeDefined();
    removeDaemonFile(home, { url: "http://127.0.0.1:4890", token: "t1" });
    expect(readDaemonFile(home)).toBeUndefined();
    writeFileSync(join(home, DAEMON_FILE), "not json");
    expect(readDaemonFile(home)).toBeUndefined();
    writeFileSync(join(home, DAEMON_FILE), JSON.stringify({ url: 1 }));
    expect(readDaemonFile(home)).toBeUndefined();
  });

  it("二重に起動しても、動いている sacty の接続の情報を上書きせず、後の起動の終わりで消さない（PR #85 レビュー指摘）", async () => {
    const first = { url: "http://127.0.0.1:4890", token: "first" };
    const second = { url: "http://127.0.0.1:4890", token: "second" };
    const asked: string[] = [];
    const alive = (running: string[]) => async (e: { token: string }) => {
      asked.push(e.token);
      return running.includes(e.token);
    };
    expect(await claimDaemonFile(home, first, alive(["first"]))).toBe(true);
    // 最初の sacty が動いているあいだは、後から起動したものは書かない
    expect(await claimDaemonFile(home, second, alive(["first"]))).toBe(false);
    expect(readDaemonFile(home)).toEqual(first);
    // 後の起動が終わっても（書いていないので）、最初の sacty のものは残る
    removeDaemonFile(home, second);
    expect(readDaemonFile(home)).toEqual(first);
    // 最初の sacty が止まった後に残ったもの（応答しない）は、上書きする
    expect(await claimDaemonFile(home, second, alive([]))).toBe(true);
    expect(readDaemonFile(home)).toEqual(second);
    // 自分のものなら、問い合わせずに書き直す
    asked.length = 0;
    expect(await claimDaemonFile(home, second, alive([]))).toBe(true);
    expect(asked).toEqual([]);
    // 最初の sacty の終わりでは、後の sacty のものを消さない
    removeDaemonFile(home, first);
    expect(readDaemonFile(home)).toEqual(second);
  });

  const endpoint = { url: "http://127.0.0.1:4890", token: "daemon-token" };
  const projects = [
    { id: "id-1", name: "決済" },
    { id: "id-2", name: "同名" },
    { id: "id-3", name: "同名" },
  ];
  const fakeFetch =
    (requested: string[]) => async (url: string, init: { headers: Record<string, string> }) => {
      requested.push(url);
      expect(init.headers.authorization).toBe("Bearer daemon-token");
      if (url.endsWith("/api/projects")) return Response.json({ projects });
      return Response.json({ preview: view });
    };

  it("プロジェクトは ID か名前で指定でき、AI の種類を渡して API から取る", async () => {
    const requested: string[] = [];
    expect(await fetchContextPreview(endpoint, "決済", "codex", fakeFetch(requested))).toEqual({
      preview: view,
    });
    await fetchContextPreview(endpoint, "id-2", "claude-code", fakeFetch(requested));
    expect(requested).toEqual([
      "http://127.0.0.1:4890/api/projects",
      "http://127.0.0.1:4890/api/projects/id-1/context-preview?runtime=codex",
      "http://127.0.0.1:4890/api/projects",
      "http://127.0.0.1:4890/api/projects/id-2/context-preview?runtime=claude-code",
    ]);
  });

  it("無い・同じ名前が複数・デーモンにつながらない・認証できないときは、理由で止める", async () => {
    await expect(fetchContextPreview(endpoint, "無い", "codex", fakeFetch([]))).rejects.toThrow(
      "プロジェクト「無い」がありません",
    );
    await expect(fetchContextPreview(endpoint, "同名", "codex", fakeFetch([]))).rejects.toThrow(
      "ID で指定してください（id-2・id-3）",
    );
    await expect(
      fetchContextPreview(endpoint, "決済", "codex", async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toThrow("デーモンにつながりません");
    await expect(
      fetchContextPreview(endpoint, "決済", "codex", async () => new Response("", { status: 401 })),
    ).rejects.toThrow("認証できません");
  });

  it("人が読む形には、層・警告・効果・MCP の両方の接続先・秘密情報の参照の名前・ファイルを出す", () => {
    const text = formatContextPreview({ preview: view });
    expect(text).toContain("# コンテキストのプレビュー（Codex）");
    expect(text).toContain("https://example.com/ctx.git#main @ c0ffee");
    expect(text).toContain("locked: skills: review");
    expect(text).toContain("remove: mcp: old");
    expect(text).toContain("MCP サーバー「cloud」は、config.yaml の gateway.mcp_servers");
    expect(text).toContain("skills「old」：ctx@c0ffee0 が取り除いた（base のもの）");
    expect(text).toContain("エージェントから：http://host.docker.internal:5001/ctx-mcp/docs");
    expect(text).toContain("元の接続先：ゲートウェイが中継する先：https://docs.example.com/mcp");
    expect(text).toContain("SACTY_MCP_SECRET_0 = Bearer <実行ごとのゲートウェイのトークン>");
    expect(text).toContain("SACTY_MCP_SECRET_1 = <秘密情報「op://vault/item/token」>");
    expect(text).toContain("MCP_TIMEOUT = 45000");
    expect(text).toContain("===== AGENTS.md =====\n# 規約");
    expect(text).toContain("（テキストでないファイル）");
    expect(text).toContain("literal の値は、書かれたまま出ます");
    // 中身を省けば、ファイルの一覧だけ
    expect(formatContextPreview({ preview: view }, false)).not.toContain("=====");
  });

  it("--no-content は、JSON でも人が読む形でも、ファイルの中身を出さない（PR #85 レビュー指摘）", () => {
    const secretish = "literal-header-value";
    const withLiteral: PreviewView = {
      ...view,
      files: [
        { path: "mcp.json", generated: true, size: 30, content: `{"X-Key": "${secretish}"}` },
      ],
    };
    const result = { preview: withLiteral };
    const json = JSON.parse(previewOutput(result, { json: true, content: false }));
    expect(json.preview.files).toEqual([{ path: "mcp.json", generated: true, size: 30 }]);
    expect(previewOutput(result, { json: true, content: false })).not.toContain(secretish);
    expect(previewOutput(result, { json: false, content: false })).not.toContain(secretish);
    // 中身を出すときは、どちらの形でも出す
    expect(previewOutput(result, { json: true, content: true })).toContain(secretish);
    expect(previewOutput(result, { json: false, content: true })).toContain(secretish);
    // 誤りは、どの組み合わせでもそのまま
    const error = { error: "壊れています" };
    expect(JSON.parse(previewOutput(error, { json: true, content: false }))).toEqual(error);
    expect(previewOutput(error, { json: false, content: false })).toContain("壊れています");
  });

  it("誤りは、その理由を出す", () => {
    expect(
      formatContextPreview({
        error: {
          code: "context.fileInvalid",
          params: { key: "ctx#", file: "mcp.yaml", path: "servers.x", detail: "だめ" },
        },
      }),
    ).toBe("コンテキストに誤りがあります：ctx# の mcp.yaml に誤りがあります（servers.x）：だめ");
  });
});
