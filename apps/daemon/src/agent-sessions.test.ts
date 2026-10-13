import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveAgentSessionFiles,
  archivedFilePath,
  ByteRedactor,
  checkArchivedFiles,
  fileCaps,
  guessSessionId,
  safeRelativePath,
  selectAgentSessionFiles,
} from "./agent-sessions.js";
import { DockerExecutor } from "./agents/docker.js";
import { buildInvocation } from "./agents/invocation.js";
import { ClaudeOutcomeReader, CodexOutcomeReader } from "./agents/parse.js";
import type { AgentConfig } from "./config.js";
import { MemorySecretStore } from "./secrets.js";
import { SessionLogStore, TRUNCATED_EVENT } from "./session-logs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-agent-sessions-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** 相対パスと中身から、設定の場所を作る。 */
function configDir(files: Record<string, string | Buffer>): string {
  const root = join(dir, "config");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

// 認証なしで起動した Claude Code 2.1（sacty-agent:0.1.0）が CLAUDE_CONFIG_DIR に書いたファイルの形と、
// サブエージェント・大きなツールの結果の置き場所（公開されている形）
const CLAUDE_SESSION = "1240edc9-293c-48ee-a33a-5d92d10ceb19";
const claudeFiles = {
  [`projects/-workspace/${CLAUDE_SESSION}.jsonl`]: `${[
    { type: "queue-operation", operation: "enqueue", sessionId: CLAUDE_SESSION, content: "hello" },
    {
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "hello" },
      cwd: "/workspace",
      sessionId: CLAUDE_SESSION,
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n")}\n`,
  [`projects/-workspace/${CLAUDE_SESSION}/subagents/agent-a1b2.jsonl`]:
    '{"type":"assistant","isSidechain":true}\n',
  [`projects/-workspace/${CLAUDE_SESSION}/tool-results/toolu_1.txt`]: "large output",
  ".claude.json": '{"userID":"u","machineID":"m"}',
  ".credentials.json": '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-secret"}}',
  "backups/.claude.json.backup.1791932780017": "{}",
  "sessions/1.json": '{"pid":1}',
  "history.jsonl": '{"display":"hello"}\n',
};

// 認証なしで起動した Codex 0.160（sacty-agent:0.1.0）が CODEX_HOME に書いたファイルの形
const CODEX_THREAD = "01a13785-0109-7b22-a3a2-ec091320bd0c";
const codexFiles = {
  [`sessions/2026/10/13/rollout-2026-10-13T23-07-05-${CODEX_THREAD}.jsonl`]: `${JSON.stringify({
    timestamp: "2026-10-13T23:07:05.917Z",
    type: "session_meta",
    payload: { id: CODEX_THREAD, cwd: "/workspace", originator: "codex_exec" },
  })}\n`,
  "auth.json": '{"tokens":{"access_token":"codex-access-token-123456"}}',
  "config.toml": 'model = "x"',
  installation_id: "4730d09e",
  "state_5.sqlite": Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff]),
  "logs_2.sqlite-wal": "wal",
  [`shell_snapshots/${CODEX_THREAD}.1.sh`]: "export X=1",
  [`thread-writer-locks/${CODEX_THREAD}.lock`]: "",
  "skills/.system/skill-creator/SKILL.md": "# skill",
  ".tmp/plugins.sync.lock": "",
};

describe("写すファイルの選び方（PBI-66）", () => {
  it("Claude Code：projects の下（サブエージェント・ツールの結果を含む）と履歴だけを写し、設定・認証・バックアップは写さない", () => {
    const root = configDir(claudeFiles);
    expect(selectAgentSessionFiles("claude-code", root).map((f) => f.path)).toEqual([
      "history.jsonl",
      `projects/-workspace/${CLAUDE_SESSION}.jsonl`,
      `projects/-workspace/${CLAUDE_SESSION}/subagents/agent-a1b2.jsonl`,
      `projects/-workspace/${CLAUDE_SESSION}/tool-results/toolu_1.txt`,
    ]);
  });

  it("Codex：sessions の下だけを写し、auth.json・config.toml・データベース・スキル・シェルの写しは写さない", () => {
    const root = configDir(codexFiles);
    expect(selectAgentSessionFiles("codex", root)).toEqual([
      {
        path: `sessions/2026/10/13/rollout-2026-10-13T23-07-05-${CODEX_THREAD}.jsonl`,
        size: Buffer.byteLength(Object.values(codexFiles)[0] as string),
      },
    ]);
  });

  it("選んだ場所の下の認証のファイル・シンボリックリンク（ホストのほかのファイルを指すもの）は写さない", () => {
    const root = configDir({
      "projects/-workspace/s.jsonl": "{}\n",
      "projects/-workspace/auth.json": "{}",
      "projects/-workspace/.credentials.json": "{}",
      "sessions/auth.json": "{}",
    });
    writeFileSync(join(dir, "host-secret"), "host secret");
    symlinkSync(join(dir, "host-secret"), join(root, "projects/-workspace/link.jsonl"));
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside/x.jsonl"), "x");
    symlinkSync(join(dir, "outside"), join(root, "projects/linked-dir"));
    symlinkSync(join(dir, "host-secret"), join(root, "history.jsonl"));
    expect(selectAgentSessionFiles("claude-code", root).map((f) => f.path)).toEqual([
      "projects/-workspace/s.jsonl",
    ]);
    expect(selectAgentSessionFiles("codex", root)).toEqual([]);
    // projects 自体がリンクでも辿らない
    const other = join(dir, "other");
    mkdirSync(other);
    symlinkSync(join(root, "projects"), join(other, "projects"));
    expect(selectAgentSessionFiles("claude-code", other)).toEqual([]);
  });

  it("設定の場所が無い・空なら何も選ばない", () => {
    expect(selectAgentSessionFiles("claude-code", join(dir, "missing"))).toEqual([]);
    expect(selectAgentSessionFiles("codex", configDir({}))).toEqual([]);
  });
});

describe("秘密情報を伏せる（PBI-66）", () => {
  it("読んだ分の境目をまたいだ値も伏せる（1バイトずつ届いても）", () => {
    const secret = "sk-ant-oat01-ABCDEFGHIJ";
    const text = `{"a":"x ${secret} y"}\n{"b":"${secret}"}`;
    for (const size of [1, 2, 7, 13, text.length]) {
      const r = new ByteRedactor([secret]);
      const parts: Buffer[] = [];
      const buf = Buffer.from(text);
      for (let i = 0; i < buf.length; i += size) parts.push(r.push(buf.subarray(i, i + size)));
      parts.push(r.flush());
      const out = Buffer.concat(parts).toString("utf8");
      expect(out, `size ${size}`).toBe('{"a":"x [REDACTED] y"}\n{"b":"[REDACTED]"}');
    }
  });

  it("JSON でエスケープされた形・UTF-8 の値も伏せ、UTF-8 でないバイト列は壊さない", () => {
    const quoted = 'pa"ss\\word-123';
    const japanese = "ひみつの値です";
    const escaped = JSON.stringify(quoted).slice(1, -1);
    const input = Buffer.concat([
      Buffer.from(`${escaped} ${japanese} `),
      Buffer.from([0xff, 0xfe, 0x00, 0x80]),
    ]);
    const r = new ByteRedactor([quoted, japanese]);
    const out = Buffer.concat([r.push(input), r.flush()]);
    expect(out.subarray(0, out.length - 4).toString("utf8")).toBe("[REDACTED] [REDACTED] ");
    expect([...out.subarray(out.length - 4)]).toEqual([0xff, 0xfe, 0x00, 0x80]);
  });
});

describe("写す・ハッシュを記録する・確かめる（PBI-66）", () => {
  it("相対パスのまま、伏せてから写し、写した後の大きさと SHA-256 を返す（利用者だけが読める）", async () => {
    const secret = "codex-access-token-123456";
    const root = configDir({
      ...codexFiles,
      [`sessions/2026/10/13/rollout-2026-10-13T23-07-05-${CODEX_THREAD}.jsonl`]: `{"token":"${secret}"}\n`,
    });
    const dest = join(dir, "runs/task/run/agent");
    const archive = await archiveAgentSessionFiles({
      runtime: "codex",
      configDir: root,
      dest,
      secrets: [secret],
    });
    const path = `sessions/2026/10/13/rollout-2026-10-13T23-07-05-${CODEX_THREAD}.jsonl`;
    const written = readFileSync(join(dest, path), "utf8");
    expect(written).toBe('{"token":"[REDACTED]"}\n');
    expect(archive).toEqual({
      files: [
        {
          path,
          bytes: Buffer.byteLength(written),
          sha256: sha(written),
          sourceBytes: Buffer.byteLength(`{"token":"${secret}"}\n`),
        },
      ],
      skipped: [],
      limitBytes: 200 * 1024 * 1024,
    });
    expect(existsSync(join(dest, "auth.json"))).toBe(false);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    expect(statSync(join(dest, "sessions/2026/10")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dest, path)).mode & 0o777).toBe(0o600);
    expect(guessSessionId("codex", archive.files)).toBe(CODEX_THREAD);

    // 記録と比べる：一致・書き換え（同じ大きさでも）・消した
    expect((await checkArchivedFiles(dest, archive.files)).map((f) => f.status)).toEqual(["match"]);
    writeFileSync(join(dest, path), written.replace("REDACTED", "redacted"));
    const [changed] = await checkArchivedFiles(dest, archive.files);
    expect(changed?.status).toBe("mismatch");
    expect(changed?.current?.bytes).toBe(archive.files[0]?.bytes);
    rmSync(join(dest, path));
    expect((await checkArchivedFiles(dest, archive.files))[0]?.status).toBe("missing");
  });

  it("ファイルを読む単位（1MB）の境目をまたいだ値も伏せる（回帰）", async () => {
    const secret = "boundary-secret-value-0123456789";
    const MB = 1024 * 1024;
    for (const offset of [MB - 1, MB - 10, MB - secret.length + 1]) {
      const content = `${"a".repeat(offset)}${secret}${"b".repeat(100)}`;
      const root = join(dir, `c${offset}`);
      mkdirSync(join(root, "projects/p"), { recursive: true });
      writeFileSync(join(root, "projects/p/s.jsonl"), content);
      const dest = join(dir, `d${offset}`);
      await archiveAgentSessionFiles({
        runtime: "claude-code",
        configDir: root,
        dest,
        secrets: [secret],
      });
      const out = readFileSync(join(dest, "projects/p/s.jsonl"), "utf8");
      expect(out, `offset ${offset}`).toBe(`${"a".repeat(offset)}[REDACTED]${"b".repeat(100)}`);
    }
  });

  it("写すファイルが無ければ、何も作らない", async () => {
    const dest = join(dir, "agent");
    const archive = await archiveAgentSessionFiles({
      runtime: "claude-code",
      configDir: configDir({ ".claude.json": "{}" }),
      dest,
      secrets: [],
    });
    expect(archive.files).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it("読めないファイルは写さずに知らせ、ほかのファイルは写す", async () => {
    const root = configDir({ "projects/p/a.jsonl": "a\n", "projects/p/b.jsonl": "b\n" });
    chmodSync(join(root, "projects/p/a.jsonl"), 0o000);
    const archive = await archiveAgentSessionFiles({
      runtime: "claude-code",
      configDir: root,
      dest: join(dir, "agent"),
      secrets: [],
    });
    expect(archive.skipped).toEqual(["projects/p/a.jsonl"]);
    expect(archive.files.map((f) => f.path)).toEqual(["projects/p/b.jsonl"]);
    expect(existsSync(join(dir, "agent/projects/p/a.jsonl"))).toBe(false);
  });
});

describe("上限（PBI-66）", () => {
  it("合計が上限に収まれば省かない。超えたら、小さいファイルは丸ごと残し、残りを大きいファイルで分ける", () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(fileCaps([10, 20], 30)).toEqual([inf, inf]);
    expect(fileCaps([10, 100, 100], 110)).toEqual([inf, 50, 50]);
    expect(fileCaps([100, 5], 50)).toEqual([45, inf]);
    expect(fileCaps([], 10)).toEqual([]);
  });

  it("上限を超えたら、先頭と末尾を残して間を省き、そのことを目印と記録に残す（伏せてから切り詰める）", async () => {
    const secret = "SECRET-VALUE-0123456789";
    const lines = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ i, text: `line ${i} ${secret} ${"x".repeat(40)}` }),
    );
    const root = configDir({
      "projects/p/big.jsonl": `${lines.join("\n")}\n`,
      "projects/p/small.jsonl": '{"small":true}\n',
      "projects/p/tool-results/big.txt": `${secret}${"y".repeat(5000)}${secret}`,
    });
    const limit = 4000;
    const dest = join(dir, "agent");
    const archive = await archiveAgentSessionFiles({
      runtime: "claude-code",
      configDir: root,
      dest,
      secrets: [secret],
      limit,
    });
    const byPath = Object.fromEntries(archive.files.map((f) => [f.path, f]));
    expect(byPath["projects/p/small.jsonl"]?.truncated).toBeUndefined();
    const big = readFileSync(join(dest, "projects/p/big.jsonl"), "utf8");
    expect(big).not.toContain(secret);
    expect(big).not.toContain(secret.slice(0, 8));
    expect(big).not.toContain(secret.slice(-8));
    // JSONL のまま（どの行も JSON）で、先頭と末尾の行が残り、間に目印の行がある
    const rows = big
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { i?: number; type?: string; droppedBytes?: number });
    expect(rows[0]?.i).toBe(0);
    expect(rows[rows.length - 1]?.i).toBe(199);
    const mark = rows.find((r) => r.type === TRUNCATED_EVENT);
    expect(mark?.droppedBytes).toBe(byPath["projects/p/big.jsonl"]?.truncated?.droppedBytes);
    expect(byPath["projects/p/big.jsonl"]?.truncated?.droppedLines).toBeGreaterThan(0);
    // JSONL でないファイルは、文の目印
    const text = readFileSync(join(dest, "projects/p/tool-results/big.txt"), "utf8");
    expect(text).toContain("[sacty] truncated:");
    expect(text.startsWith("[REDACTED]")).toBe(true);
    expect(text.endsWith("[REDACTED]")).toBe(true);
    expect(text).not.toContain(secret.slice(0, 8));
    // 写した合計は、上限（と目印の分）に収まる。記録した大きさとハッシュは、写したファイルのもの
    const total = archive.files.reduce((a, f) => a + f.bytes, 0);
    expect(total).toBeLessThan(limit + 400);
    expect(byPath["projects/p/big.jsonl"]?.sha256).toBe(sha(big));
    expect(byPath["projects/p/big.jsonl"]?.bytes).toBe(Buffer.byteLength(big));
  });

  it("秘密情報が、残す先頭の終わりをまたいでいても、切れ端を残さない", async () => {
    const secret = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    // 先頭の上限（上限の8割 = 800バイト）の位置に秘密情報がかかるようにする
    const content = `${"a".repeat(790)}${secret}${"b".repeat(2000)}`;
    const root = configDir({ "projects/p/t.txt": content });
    const dest = join(dir, "agent");
    await archiveAgentSessionFiles({
      runtime: "claude-code",
      configDir: root,
      dest,
      secrets: [secret],
      limit: 1000,
    });
    const out = readFileSync(join(dest, "projects/p/t.txt"), "utf8");
    for (let n = 6; n <= secret.length; n++) {
      expect(out).not.toContain(secret.slice(0, n));
      expect(out).not.toContain(secret.slice(-n));
    }
    expect(out).toContain("[sacty] truncated:");
  });
});

describe("写したファイルの場所（PBI-66）", () => {
  it("場所の外・絶対パス・空の部分・区切りの違うパスは受け付けない", () => {
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b", "a\0b"]) {
      expect(safeRelativePath(bad), bad).toBe(false);
    }
    expect(safeRelativePath("projects/-workspace/s.jsonl")).toBe(true);
  });

  it("リンク（途中のディレクトリを含む）は返さない", () => {
    const root = join(dir, "agent");
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(join(root, "projects/a.jsonl"), "a");
    writeFileSync(join(dir, "host"), "host");
    symlinkSync(join(dir, "host"), join(root, "projects/link.jsonl"));
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere/b.jsonl"), "b");
    symlinkSync(join(dir, "elsewhere"), join(root, "linked"));
    expect(archivedFilePath(root, "projects/a.jsonl")).toBe(join(root, "projects/a.jsonl"));
    expect(archivedFilePath(root, "projects/link.jsonl")).toBeUndefined();
    expect(archivedFilePath(root, "linked/b.jsonl")).toBeUndefined();
    expect(archivedFilePath(root, "projects")).toBeUndefined();
    expect(archivedFilePath(root, "projects/missing.jsonl")).toBeUndefined();
  });

  it("セッションの ID は、出力の最初のもの（Claude Code の session_id・Codex の thread.started）を読む", () => {
    const claude = new ClaudeOutcomeReader();
    claude.push('{"type":"system","subtype":"init","session_id":"main"}\n');
    claude.push('{"type":"assistant","session_id":"other","message":{"content":[]}}\n');
    expect(claude.sessionId).toBe("main");
    const codex = new CodexOutcomeReader();
    codex.push('{"type":"turn.started"}\n{"type":"thread.started","thread_id":"t-1"}\n');
    codex.push('{"type":"thread.started","thread_id":"t-2"}\n');
    expect(codex.sessionId).toBe("t-1");
    expect(new CodexOutcomeReader().sessionId).toBeUndefined();
  });

  it("セッションの ID を、写したファイルの名前から推し量る（1つに決まらなければ無し）", () => {
    expect(
      guessSessionId("claude-code", [
        { path: `projects/-workspace/${CLAUDE_SESSION}.jsonl` },
        { path: `projects/-workspace/${CLAUDE_SESSION}/subagents/agent-a1.jsonl` },
      ]),
    ).toBe(CLAUDE_SESSION);
    expect(
      guessSessionId("claude-code", [
        { path: "projects/a/s1.jsonl" },
        { path: "projects/a/s2.jsonl" },
      ]),
    ).toBeUndefined();
    expect(guessSessionId("codex", [])).toBeUndefined();
  });
});

describe("実行器が、実行の後に元のファイルを写す（偽の docker コマンド。PBI-66）", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /**
   * 偽の docker。run の引数から、設定の場所にマウントした一時的な場所を探し、そこにファイルを書いてから script を動かす
   * （実際のコンテナが CLAUDE_CONFIG_DIR・CODEX_HOME に書くのと同じ）。
   */
  const fakeDocker = (script: string) => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
if [ "$1" = "kill" ]; then kill "$(cat "${dir}/run.pid")"; exit 0; fi
if [ "$1" != "run" ]; then exit 0; fi
echo $$ > "${dir}/run.pid"
for a in "$@"; do
  case "$a" in
    *:/tmp/sacty-claude-config) CONFIG="\${a%:/tmp/sacty-claude-config}" ;;
    *:/.codex) CONFIG="\${a%:/.codex}" ;;
  esac
done
${script}`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
  };
  const info = (runtime: string) => ({
    taskId: "task-1",
    runId: "run-1",
    role: "orchestrator",
    agentId: "a",
    runtime,
    authMode: "subscription",
  });
  const base: Omit<AgentConfig, "id" | "runtime" | "auth"> = {
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 },
    price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  };

  it("Claude Code：コンテキストの無い実行（オーケストレーターなど）でも写し、出力のセッションの ID を記録する", async () => {
    const secret = "oauth-token-1234567890";
    fakeDocker(`mkdir -p "$CONFIG/projects/-workspace/sid-1/subagents"
printf '{"type":"user","message":{"content":"t ${secret}"}}\\n' > "$CONFIG/projects/-workspace/sid-1.jsonl"
printf '{"type":"assistant"}\\n' > "$CONFIG/projects/-workspace/sid-1/subagents/agent-x.jsonl"
printf '{"claudeAiOauth":{"accessToken":"${secret}"}}' > "$CONFIG/.credentials.json"
echo '{"type":"system","subtype":"init","session_id":"sid-1"}'
echo '{"type":"result","is_error":false,"result":"done","session_id":"sid-1"}'
`);
    const invocation = await buildInvocation(
      { ...base, id: "c", runtime: "claude-code", auth: { mode: "subscription", secret: "t" } },
      "prompt",
      new MemorySecretStore({ t: secret }),
    );
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info("claude-code"), () => [secret]);
    const outcome = await new DockerExecutor().run({
      runId: "run-1",
      image: "img",
      workspaceDir: dir,
      invocation,
      log,
    });
    expect(outcome).toMatchObject({ kind: "completed", output: "done" });
    expect(log.archived).toMatchObject({
      runtime: "claude-code",
      sessionId: "sid-1",
      files: [
        { path: "projects/-workspace/sid-1.jsonl" },
        { path: "projects/-workspace/sid-1/subagents/agent-x.jsonl" },
      ],
    });
    const agent = join(dir, "runs/task-1/run-1/agent");
    expect(readFileSync(join(agent, "projects/-workspace/sid-1.jsonl"), "utf8")).toBe(
      '{"type":"user","message":{"content":"t [REDACTED]"}}\n',
    );
    expect(existsSync(join(agent, ".credentials.json"))).toBe(false);
  });

  it("Codex：コンテナで更新された auth.json は写さず、その値も伏せる。失敗した実行も写す", async () => {
    const hostAuth = join(dir, "host-auth.json");
    writeFileSync(hostAuth, '{"tokens":{"access_token":"old-access-token-0000"}}');
    fakeDocker(`printf '{"tokens":{"access_token":"new-access-token-9999"}}' > "$CONFIG/auth.json"
mkdir -p "$CONFIG/sessions/2026/10/13"
printf '{"type":"session_meta","payload":{"id":"th-1"}}\\n{"x":"new-access-token-9999 old-access-token-0000"}\\n' > "$CONFIG/sessions/2026/10/13/rollout-2026-10-13T23-07-05-th-1.jsonl"
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}'
exit 1
`);
    const invocation = await buildInvocation(
      {
        ...base,
        id: "x",
        runtime: "codex",
        auth: { mode: "subscription", auth_file: hostAuth },
      },
      "prompt",
      new MemorySecretStore({}),
    );
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info("codex"), () => ["old-access-token-0000"]);
    const outcome = await new DockerExecutor().run({
      runId: "run-1",
      image: "img",
      workspaceDir: dir,
      invocation,
      log,
    });
    expect(outcome.kind).toBe("failed");
    expect(log.archived?.sessionId).toBe("th-1");
    expect(log.archived?.files.map((f) => f.path)).toEqual([
      "sessions/2026/10/13/rollout-2026-10-13T23-07-05-th-1.jsonl",
    ]);
    const copied = readFileSync(
      join(
        dir,
        "runs/task-1/run-1/agent/sessions/2026/10/13/rollout-2026-10-13T23-07-05-th-1.jsonl",
      ),
      "utf8",
    );
    expect(copied).not.toContain("access-token");
    expect(copied).toContain('{"x":"[REDACTED] [REDACTED]"}');
    expect(existsSync(join(dir, "runs/task-1/run-1/agent/auth.json"))).toBe(false);
    // 書き戻しはこれまでどおり
    expect(readFileSync(hostAuth, "utf8")).toContain("new-access-token-9999");
  });

  it("止めた実行（デーモンの停止）も、コンテナが残したところまで写す。出力に ID が無ければ、ファイルの名前から推し量る", async () => {
    fakeDocker(`mkdir -p "$CONFIG/projects/-workspace"
printf '{"type":"user"}\\n' > "$CONFIG/projects/-workspace/sid-9.jsonl"
touch "${dir}/ready"
trap 'exit 137' TERM
while true; do sleep 0.05; done
`);
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info("claude-code"), () => []);
    const executor = new DockerExecutor();
    const running = executor.run({
      runId: "run-1",
      image: "img",
      workspaceDir: dir,
      invocation: {
        command: ["claude"],
        env: {},
        parser: "claude-json",
        stage: { containerDir: "/tmp/sacty-claude-config", files: [] },
        sessionFiles: "claude-code",
      },
      log,
    });
    // コンテナがファイルを書いた後に止める（プロセスの起動が遅い環境でも、決まった時間を待たない）
    while (!existsSync(join(dir, "ready"))) await new Promise((r) => setTimeout(r, 20));
    executor.abortAll();
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "failed", message: { code: "run.daemonStopped" } });
    expect(log.archived).toMatchObject({
      sessionId: "sid-9",
      files: [{ path: "projects/-workspace/sid-9.jsonl" }],
    });
  });

  it("スタブ（元のファイルが無い）では写さない", async () => {
    fakeDocker(`echo '{"type":"result","is_error":false,"result":"stub"}'`);
    const invocation = await buildInvocation(
      { ...base, id: "s", runtime: "stub", auth: { mode: "stub" } },
      "prompt",
      new MemorySecretStore({}),
    );
    expect(invocation.sessionFiles).toBeUndefined();
    expect(invocation.stage).toBeUndefined();
    const store = new SessionLogStore(join(dir, "runs"));
    const log = store.open(info("stub"), () => []);
    await new DockerExecutor().run({
      runId: "run-1",
      image: "img",
      workspaceDir: dir,
      invocation,
      log,
    });
    expect(log.archived).toBeUndefined();
    expect(existsSync(join(dir, "runs/task-1/run-1"))).toBe(false);
  });
});
