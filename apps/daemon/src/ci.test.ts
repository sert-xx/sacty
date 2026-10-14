import { describe, expect, it } from "vitest";
import { CI_EXCERPT_MAX, CI_LOG_LINES, GitHubCiStatus, logExcerpt, redactLog } from "./ci.js";
import { resolveInRepository } from "./deployment.js";

describe("CI のログの伏せ方と抜粋（PBI-89）", () => {
  it("渡した値と、よくある秘密情報の形を伏せる（名前は残す）", () => {
    const log = [
      "token used: s3cr3t-value",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked",
      "Authorization: Bearer abc.def.ghi-token",
      "password=hunter2-long api_key: 'AKIAABCDEFGHIJKLMNOP'",
      "slack xoxb-1234567890-abcdefghij",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactLog(log, ["s3cr3t-value"]);
    for (const secret of [
      "s3cr3t-value",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "abc.def.ghi-token",
      "hunter2-long",
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghij",
      "MIIEow",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("Authorization: Bearer [REDACTED]");
    expect(out).toContain("password=[REDACTED]");
  });

  it("時刻を除き、末尾の行を取り、伏せてから切り詰める（境界をまたぐ値も残らない）", () => {
    const secret = "boundary-secret-0123456789";
    const lines = Array.from(
      { length: 200 },
      (_, i) => `2026-10-14T00:00:${String(i % 60).padStart(2, "0")}.1234567Z line ${i}`,
    );
    const excerpt = logExcerpt(lines.join("\n"), []);
    const kept = excerpt.split("\n");
    expect(kept).toHaveLength(CI_LOG_LINES);
    expect(kept.at(-1)).toBe("line 199");
    expect(excerpt).not.toMatch(/2026-10-14T/);
    // 切り詰める位置に秘密情報がかかっても、伏せてから切るので一部も残らない
    const long = `${"x".repeat(CI_EXCERPT_MAX - 10)}${secret}${"y".repeat(5)}`;
    const clipped = logExcerpt(long, [secret]);
    expect(clipped.length).toBeLessThanOrEqual(CI_EXCERPT_MAX);
    expect(clipped).not.toContain("boundary-secret");
    expect(clipped).not.toContain("0123456789");
  });
});

/** GitHub の API の偽物（URL ごとの応答）。 */
function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const body = routes[key];
    return typeof body === "string"
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const api = "https://api.github.com/repos/acme/app";
const sha = "a".repeat(40);

describe("GitHub の CI/CD の状態（PBI-89）", () => {
  it("ワークフローの実行（再実行は最新の試行）・ほかのアプリのチェック・コミットの状態を読む。Actions のジョブは数えない", async () => {
    const ci = new GitHubCiStatus(
      fakeFetch({
        [`${api}/actions/runs?head_sha=${sha}`]: {
          workflow_runs: [
            {
              id: 1,
              workflow_id: 10,
              name: "CI",
              run_attempt: 1,
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/app/actions/runs/1",
            },
            {
              id: 2,
              workflow_id: 10,
              name: "CI",
              run_attempt: 2,
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/acme/app/actions/runs/2",
            },
            {
              id: 3,
              workflow_id: 11,
              name: "Deploy",
              run_attempt: 1,
              status: "in_progress",
              conclusion: null,
            },
          ],
        },
        [`${api}/commits/${sha}/check-runs`]: {
          check_runs: [
            {
              id: 5,
              name: "build",
              status: "completed",
              conclusion: "failure",
              app: { slug: "github-actions" },
            },
            {
              id: 6,
              name: "codecov",
              status: "completed",
              conclusion: "neutral",
              app: { slug: "codecov" },
              html_url: "https://codecov.example.com/x",
            },
          ],
        },
        [`${api}/commits/${sha}/status`]: {
          statuses: [
            { context: "ci/legacy", state: "error", target_url: "https://ci.example.com/1" },
          ],
        },
      }),
    );
    const snap = await ci.snapshot({
      repo: "https://github.com/acme/app",
      token: "t",
      commit: sha,
    });
    expect(snap.checks).toEqual([
      {
        kind: "workflow",
        name: "CI",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/acme/app/actions/runs/2",
      },
      { kind: "workflow", name: "Deploy", status: "pending" },
      {
        kind: "check",
        name: "codecov",
        status: "completed",
        conclusion: "neutral",
        url: "https://codecov.example.com/x",
      },
      {
        kind: "status",
        name: "ci/legacy",
        status: "completed",
        conclusion: "error",
        url: "https://ci.example.com/1",
      },
    ]);
    expect(snap.failedRuns).toEqual([]);
  });

  it("失敗したワークフローの、失敗したジョブとログの末尾（伏せた後）を読む", async () => {
    const calls: string[] = [];
    const ci = new GitHubCiStatus(
      fakeFetch(
        {
          [`${api}/actions/runs/1/jobs`]: {
            jobs: [
              {
                id: 7,
                name: "test",
                status: "completed",
                conclusion: "failure",
                html_url: "https://github.com/acme/app/actions/runs/1/job/7",
              },
              { id: 8, name: "lint", status: "completed", conclusion: "success" },
              { id: 9, name: "deploy", status: "completed", conclusion: "cancelled" },
            ],
          },
          [`${api}/actions/jobs/7/logs`]:
            "2026-10-14T00:00:00Z npm test\n2026-10-14T00:00:01Z token=tok-123456 FAIL pay.test.ts\n",
        },
        calls,
      ),
    );
    const failures = await ci.failures({
      repo: "https://github.com/acme/app",
      token: "tok-123456",
      runs: [
        {
          id: 1,
          name: "CI",
          conclusion: "failure",
          url: "https://github.com/acme/app/actions/runs/1",
        },
      ],
      secrets: [],
    });
    expect(failures).toEqual([
      {
        workflow: "CI",
        job: "test",
        conclusion: "failure",
        url: "https://github.com/acme/app/actions/runs/1/job/7",
        excerpt: "npm test\ntoken=[REDACTED] FAIL pay.test.ts",
      },
    ]);
  });
});

describe("リポジトリの中のリンクのたどり方（PBI-89）", () => {
  const links = (map: Record<string, string>) => async (p: string) => map[p];
  it("途中のリンクをたどり、外を指す・たどりすぎるものは外とする", async () => {
    expect(
      await resolveInRepository(
        links({ ".claude/skills/x": "../../.agents/skills/x" }),
        ".claude/skills/x/SKILL.md",
      ),
    ).toEqual({ path: ".agents/skills/x/SKILL.md" });
    expect(await resolveInRepository(links({ a: "/etc" }), "a/SKILL.md")).toEqual({
      outside: true,
    });
    expect(await resolveInRepository(links({ "a/b": "../../x" }), "a/b/SKILL.md")).toEqual({
      outside: true,
    });
    expect(await resolveInRepository(links({ a: "." }), "a/SKILL.md")).toEqual({ outside: true });
    expect(await resolveInRepository(links({ a: "b", b: "a" }), "a/SKILL.md")).toEqual({
      outside: true,
    });
    expect(await resolveInRepository(links({}), "a/SKILL.md")).toEqual({ path: "a/SKILL.md" });
  });
});
