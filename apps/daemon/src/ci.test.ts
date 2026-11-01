import { describe, expect, it } from "vitest";
import {
  CI_EXCERPT_MAX,
  CI_LOG_BYTES,
  CI_LOG_LINES,
  GitHubCiStatus,
  logExcerpt,
  readTail,
  redactLog,
  redactUrlCredentials,
} from "./ci.js";
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

  it("URL のユーザー情報を、スキームの大文字・小文字にかかわらず伏せる（認証情報の無い URL は変えない）", () => {
    for (const scheme of ["https", "HTTPS", "hTtPs", "http", "HTTP", "git+ssh", "FTP"]) {
      const out = redactLog(`clone ${scheme}://alice:passw0rdSecret@example.com/x.git failed`, []);
      expect(out, scheme).not.toContain("alice");
      expect(out, scheme).not.toContain("passw0rdSecret");
      expect(out, scheme).toContain("example.com/x.git");
    }
    // ユーザー名だけ・パスワードだけ
    expect(redactLog("https://tokenOnly12345@example.com/", [])).not.toContain("tokenOnly12345");
    expect(redactLog("https://:pwOnly12345@example.com/", [])).not.toContain("pwOnly12345");
    // 認証情報の無い URL は、そのまま
    const plain = "see https://example.com/a?b=c#d and HTTPS://Example.com/Path";
    expect(redactLog(plain, [])).toBe(plain);
    // 読めない URL は、中身を残さない
    expect(redactLog("x https://user:secretPw@[bad/ y", [])).not.toContain("secretPw");
  });

  it("ユーザー情報に引用符を含む URL も、認証情報とクエリを残さない", () => {
    // 架空の値。new URL はユーザー情報の ' と " を受け付ける。地の文の " は JSON の文字列の区切りと見なすので、" は JSON の
    // 文字列の中で確かめる
    for (const [quote, text] of [
      ["'", "clone https://alice:p'FAKE_SUFFIX_123@example.com/path?session=FAKE_QUERY_123 failed"],
      [
        '"',
        JSON.stringify({
          cmd: 'clone https://alice:p"FAKE_SUFFIX_123@example.com/path?session=FAKE_QUERY_123 failed',
        }),
      ],
    ] as const) {
      for (const out of [
        redactLog(text, []),
        redactUrlCredentials(text, { queryAndFragment: true }),
      ]) {
        expect(out, quote).not.toContain("alice");
        expect(out, quote).not.toContain("FAKE_SUFFIX_123");
        expect(out, quote).toContain("example.com/path");
      }
      expect(redactUrlCredentials(text, { queryAndFragment: true }), quote).not.toContain(
        "FAKE_QUERY_123",
      );
    }
    // 引用符で囲んだ URL は、引用符を URL に含めない
    const quoted = "git clone 'https://bob:FAKE_PW_456@example.org/x.git' failed";
    const out = redactLog(quoted, []);
    expect(out).not.toContain("FAKE_PW_456");
    expect(out).toContain("example.org/x.git' failed");
    expect(redactLog("see 'https://example.com/a' and \"http://example.org\"", [])).toBe(
      "see 'https://example.com/a' and \"http://example.org\"",
    );
  });

  it("クエリ・フラグメントも伏せる指定では、その中の引用符より後ろの値も残さない", () => {
    // 架空の値
    for (const url of [
      "https://example.com/path?session='FAKE_WHOLE_789",
      "https://example.com/path#'FAKE_WHOLE_789",
      "https://example.com/pa'th?session=FAKE_WHOLE_789",
      "https://example.com/path?session=<FAKE_WHOLE_789>",
    ]) {
      const out = redactUrlCredentials(`GET ${url} done`, { queryAndFragment: true });
      expect(out, url).not.toContain("FAKE_WHOLE_789");
      expect(out, url).toContain("example.com/");
      expect(out, url).toMatch(/ done$/);
    }
    // " は、JSON の文字列の中なら越えて伏せる
    const json = JSON.stringify({
      cmd: 'GET https://example.com/path?a=1&session="FAKE_WHOLE_789 done',
    });
    const hidden = redactUrlCredentials(json, { queryAndFragment: true });
    expect(hidden).not.toContain("FAKE_WHOLE_789");
    expect(JSON.parse(hidden)).toEqual({ cmd: "GET https://example.com/path?REDACTED done" });
    // クエリ・フラグメントの無い URL は、引用符で終える（引用符の後ろを変えない）
    const quoted = "see 'https://example.com/a','b' and 'https://example.org/x?k=v' ok";
    expect(redactUrlCredentials(quoted, { queryAndFragment: true })).toBe(
      "see 'https://example.com/a','b' and 'https://example.org/x?REDACTED ok",
    );
  });

  it("スキームの前に単語の文字がある URL と、ユーザー情報に `\\` やエスケープした引用符がある URL も伏せる", () => {
    // 架空の値
    for (const text of [
      "x _https://alice:FAKE_PW_321@example.com/p",
      "x 1https://alice:FAKE_PW_321@example.com/p",
      'x {"url":"https://alice:FAKE\\"PW_321@example.com/p"}',
      "x https://alice:FAKE\\'PW_321@example.com/p",
      "x https://alice:FAKE\\PW_321@example.com/p",
      "x HTTPS://FAKE\\PW_321@example.com",
      'x {"url":"HTTPS://FAKE\\"PW_321@example.com"}',
    ]) {
      for (const out of [
        redactLog(text, []),
        redactUrlCredentials(text, { queryAndFragment: true }),
      ]) {
        expect(out, text).not.toContain("FAKE");
        expect(out, text).not.toContain("PW_321");
      }
    }
    // パスの `@` は、ユーザー情報と見なさない
    const plain = "see https://registry.example.com/@acme/pkg and https://example.com/users/@alice";
    expect(redactLog(plain, [])).toBe(plain);
  });

  it("JSON の構文を壊さない（URL とメールアドレスが別のフィールドにあっても、伏せる範囲がフィールドの外へ出ない）", () => {
    const values: unknown[] = [
      "https://example.com",
      "a@example.com",
      "https://example.com/p?x=1#f",
      "see 'https://example.com' now",
      "https://alice:FAKE_PW_654@example.com/x",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow",
      'token: abc"def',
      "C:\\path\\x",
      null,
      true,
      12345678,
      ["https://example.com", "a@example.com"],
      { url: "https://example.com/?k=v", mail: "a@example.com" },
    ];
    for (const key of ["summary", "token", "password", "authorization"]) {
      for (const a of values) {
        for (const b of values) {
          const value = { [key]: a, reason: b };
          // そのまま・整形・エスケープした JSON（文字列の中の JSON）
          for (const text of [
            JSON.stringify(value),
            JSON.stringify(value, null, 2),
            JSON.stringify(JSON.stringify(value)),
            JSON.stringify({ nested: JSON.stringify(value) }),
          ]) {
            for (const hidden of [
              redactLog(text, []),
              redactUrlCredentials(redactLog(text, []), { queryAndFragment: true }),
            ]) {
              expect(() => JSON.parse(hidden), hidden).not.toThrow();
              expect(hidden).not.toContain("FAKE_PW_654");
            }
          }
        }
      }
    }
    // 秘密情報の無いフィールドは変えない
    const plain = JSON.stringify({ summary: "https://example.com", reason: "a@example.com" });
    expect(redactLog(plain, [])).toBe(plain);
    // 引用符の無い値は、JSON の文字列にして伏せる（null・true・false は残す）
    expect(JSON.parse(redactLog('{"token":12345678,"secret":null,"password":true}', []))).toEqual({
      token: "[REDACTED]",
      secret: null,
      password: true,
    });
    // 終わりの行が無い秘密鍵は、文字列の末尾まで伏せる
    const key = JSON.stringify({ a: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow", b: "x" });
    expect(JSON.parse(redactLog(key, []))).toEqual({ a: "[REDACTED]", b: "x" });
  });

  it("JSON の文字列の中のエスケープした引用符を含む秘密の値も、入れ子の JSON まで全体を伏せる（JSON の構文は壊さない）", () => {
    // 架空の値。引用符の前が3文字・4文字の値と、引用符の前のエスケープしたバックスラッシュ
    for (const password of [
      'abc"FAKE_SUFFIX_123',
      'abcd"FAKE_SUFFIX_123',
      'ab\\"FAKE_SUFFIX_123',
    ]) {
      const value = { password, x: 1 };
      // そのまま・エスケープした JSON・エスケープを重ねた JSON・JSON の値の中の JSON
      for (const text of [
        JSON.stringify(value),
        JSON.stringify(JSON.stringify(value)),
        JSON.stringify(JSON.stringify(JSON.stringify(value))),
        JSON.stringify({ reason: JSON.stringify(value), y: 2 }),
      ]) {
        const hidden = redactLog(text, []);
        expect(hidden, text).not.toContain("FAKE_SUFFIX_123");
        expect(() => JSON.parse(hidden), hidden).not.toThrow();
      }
    }
    expect(
      JSON.parse(redactLog(JSON.stringify({ password: 'abc"FAKE_SUFFIX_123', x: 1 }), [])),
    ).toEqual({
      password: "[REDACTED]",
      x: 1,
    });
    // `'` で始まる値の中の `"` も値に含める（JSON の文字列の外へは出さない）
    for (const value of [
      { reason: `password='abc"FAKE_SUFFIX_123'`, x: 1 },
      { reason: "password='abcFAKE_SUFFIX_123", x: 1 },
    ]) {
      for (const text of [JSON.stringify(value), JSON.stringify(JSON.stringify(value))]) {
        const hidden = redactLog(text, []);
        expect(hidden, text).not.toContain("FAKE_SUFFIX_123");
        expect(() => JSON.parse(hidden), hidden).not.toThrow();
      }
    }
    expect(
      JSON.parse(redactLog(JSON.stringify({ reason: "password='abcFAKE_SUFFIX_123", x: 1 }), [])),
    ).toEqual({
      reason: "password='[REDACTED]",
      x: 1,
    });
    expect(redactLog(`password='abc"FAKE_SUFFIX_123' next`, [])).toBe("password='[REDACTED]' next");
    // ふつうのログのエスケープした引用符も値に含め、閉じの引用符の後は残す
    expect(redactLog('password="abc\\"FAKE_SUFFIX_123" next', [])).toBe(
      'password="[REDACTED]" next',
    );
  });

  it("括弧を含む秘密の値も、ふつうのログと JSON の両方で全体を伏せる（JSON の構文は壊さない）", () => {
    // 架空の値
    for (const text of [
      "password={FAKE_VALUE_123}",
      "password=abcd{FAKE_VALUE_123}",
      "token: [FAKE_VALUE_123]",
      'password="{FAKE_VALUE_123} x"',
      "password='{FAKE_VALUE_123}'",
      "Authorization: Bearer {FAKE_VALUE_123}",
    ]) {
      expect(redactLog(text, []), text).not.toContain("FAKE_VALUE_123");
    }
    for (const value of [
      { password: "{FAKE_VALUE_123}" },
      { password: "abcd{FAKE_VALUE_123}", x: 1 },
      { secret: "[FAKE_VALUE_123]", list: [1, 2] },
      { reason: "password={FAKE_VALUE_123}" },
      { reason: 'password="{FAKE_VALUE_123}"' },
    ]) {
      // そのまま・エスケープした JSON
      for (const text of [JSON.stringify(value), JSON.stringify(JSON.stringify(value))]) {
        const hidden = redactLog(text, []);
        expect(hidden, text).not.toContain("FAKE_VALUE_123");
        expect(() => JSON.parse(hidden), hidden).not.toThrow();
      }
    }
    // JSON のキーの後の、引用符の無い値と、配列・オブジェクト
    expect(
      JSON.parse(redactLog('{"token":12345678,"api_key":[1,2],"secret":{"a":"b"}}', [])),
    ).toEqual({ token: "[REDACTED]", api_key: [1, 2], secret: { a: "b" } });
    expect(JSON.parse(JSON.parse(redactLog(JSON.stringify('{"token":12345678}'), [])))).toEqual({
      token: "[REDACTED]",
    });
  });

  it("URL の無い長い文字列も、長さに比例する時間で処理する", () => {
    // 区切りの多い長い入力で、候補ごとに残りを探し直さない（2MB のログでもデーモンを止めない）
    for (const input of [
      "a.".repeat(1_000_000),
      "a+b-".repeat(500_000),
      "https://'".repeat(200_000),
      "x://".repeat(500_000),
      "https://a?'".repeat(200_000),
      // 空白もクエリも無い URL の並び（JSON の配列など）
      JSON.stringify(Array(200_000).fill("https://a")),
      "https://a".repeat(200_000),
      `https://${"@".repeat(2_000_000)}`,
      `https://${"x'".repeat(1_000_000)}`,
      // 秘密の値の後ろの、バックスラッシュの長い並び
      `password=${"\\".repeat(2_000_000)}"`,
      `password="${"\\".repeat(2_000_000)}"`,
      // JSON の文字列と、その区切り
      '"'.repeat(2_000_000),
      `{${'"k":"https://a","r":"a@b",'.repeat(80_000)}`,
      `"${'x\\"'.repeat(700_000)}`,
      JSON.stringify(
        JSON.stringify(JSON.stringify(Array(30_000).fill({ u: "https://a?b", m: "a@b" }))),
      ),
    ]) {
      const started = performance.now();
      redactUrlCredentials(input, { queryAndFragment: true });
      redactLog(input, []);
      expect(performance.now() - started, input.slice(0, 8)).toBeLessThan(1_000);
    }
  });

  it("クエリとフラグメントも伏せる指定では、中身を伏せる（指定しなければ残す）", () => {
    const text = "GET HTTPS://example.com/a?token=queryValue#fragValue ok";
    const out = redactUrlCredentials(text, { queryAndFragment: true });
    expect(out).not.toContain("queryValue");
    expect(out).not.toContain("fragValue");
    expect(out).toContain("example.com/a");
    expect(redactUrlCredentials(text)).toBe(text);
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

describe("同じワークフローの実行の選び方（PBI-89 レビュー指摘）", () => {
  const snapshotOf = async (runs: Record<string, unknown>[]) =>
    new GitHubCiStatus(
      fakeFetch({
        [`${api}/actions/runs?head_sha=${sha}`]: { workflow_runs: runs },
        [`${api}/commits/${sha}/check-runs`]: { check_runs: [] },
        [`${api}/commits/${sha}/status`]: { statuses: [] },
      }),
    ).snapshot({ repo: "https://github.com/acme/app", token: "t", commit: sha });

  it("別の実行は、試行の回数ではなく新しさ（通番・作成の時刻）で選ぶ。新しい実行が進行中なら待つ", async () => {
    // 新しい進行中の実行が先、古い成功済みの実行が後（どちらも1回目の試行）
    const snap = await snapshotOf([
      {
        id: 20,
        workflow_id: 10,
        name: "CI",
        run_number: 8,
        run_attempt: 1,
        created_at: "2026-10-14T01:00:00Z",
        status: "in_progress",
        conclusion: null,
      },
      {
        id: 19,
        workflow_id: 10,
        name: "CI",
        run_number: 7,
        run_attempt: 1,
        created_at: "2026-10-14T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
    ]);
    expect(snap.checks).toEqual([{ kind: "workflow", name: "CI", status: "pending" }]);
  });

  it("通番が同じなら作成の時刻で、同じ実行の中では試行の回数で選ぶ。古い実行の再試行の回数が大きくても選ばない", async () => {
    const snap = await snapshotOf([
      {
        id: 30,
        workflow_id: 10,
        name: "CI",
        run_number: 3,
        run_attempt: 3,
        created_at: "2026-10-14T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 31,
        workflow_id: 10,
        name: "CI",
        run_number: 4,
        run_attempt: 1,
        created_at: "2026-10-14T00:05:00Z",
        status: "completed",
        conclusion: "failure",
      },
      {
        id: 40,
        workflow_id: 11,
        name: "Deploy",
        run_attempt: 1,
        created_at: "2026-10-14T00:00:00Z",
        status: "completed",
        conclusion: "failure",
      },
      {
        id: 41,
        workflow_id: 11,
        name: "Deploy",
        run_attempt: 1,
        created_at: "2026-10-14T00:10:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 50,
        workflow_id: 12,
        name: "E2E",
        run_number: 1,
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
      },
      {
        id: 50,
        workflow_id: 12,
        name: "E2E",
        run_number: 1,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      },
    ]);
    expect(snap.checks.map((c) => [c.name, c.conclusion])).toEqual([
      ["CI", "failure"],
      ["Deploy", "success"],
      ["E2E", "success"],
    ]);
    expect(snap.failedRuns.map((r) => r.id)).toEqual([31]);
  });
});

describe("ジョブのログを、末尾の上限の分だけ持って読む（PBI-89 レビュー指摘）", () => {
  /** 塊を順に流すストリーム。持たれていない塊を数えるため、作るたびに数える。 */
  const streamOf = (chunks: number, size: number, fill: (i: number) => number) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks) return controller.close();
        controller.enqueue(new Uint8Array(size).fill(fill(i)));
        i += 1;
      },
    });
  };

  it("上限より長いストリームは、末尾の上限の分だけを返し、切ったことを返す", async () => {
    const { bytes, cut } = await readTail(
      streamOf(10, 7, (i) => 65 + i),
      20,
    );
    expect(cut).toBe(true);
    expect(new TextDecoder().decode(bytes)).toBe(
      `${"H".repeat(6)}${"I".repeat(7)}${"J".repeat(7)}`,
    );
    const short = await readTail(
      streamOf(2, 3, () => 97),
      20,
    );
    expect(short).toEqual({ bytes: new Uint8Array(6).fill(97), cut: false });
    // 1つの塊が上限より大きくても、末尾だけ
    const big = await readTail(
      streamOf(1, 50, () => 98),
      20,
    );
    expect(big.bytes.length).toBe(20);
    expect(big.cut).toBe(true);
  });

  it("ログは全体を読み込まずに（arrayBuffer・text を使わずに）、上限を超える長さでも末尾から抜粋を作る", async () => {
    const secret = "tail-boundary-secret-123456";
    // 先頭に秘密情報があり、上限で切ると、その途中から始まる（捨てられる行）
    const head = new TextEncoder().encode(`x ${secret}\n`);
    const filler = new TextEncoder().encode("ok line\n");
    const last = new TextEncoder().encode("FAIL at the end\n");
    // 全体を上限より 10 バイトだけ長くし、切る位置を先頭の行（秘密情報）の途中にする
    const rest = CI_LOG_BYTES + 10 - head.length - last.length;
    const lines = Math.floor(rest / filler.length);
    const extra = rest - lines * filler.length;
    const pad = extra > 0 ? new TextEncoder().encode(`${"z".repeat(extra - 1)}\n`) : undefined;
    const chunks = [head, ...(pad ? [pad] : [])];
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const fixed = chunks[sent];
        if (fixed) controller.enqueue(fixed);
        else if (sent < chunks.length + lines) controller.enqueue(filler);
        else if (sent === chunks.length + lines) controller.enqueue(last);
        else return controller.close();
        sent += 1;
      },
    });
    const response = new Response(body, { status: 200 });
    response.arrayBuffer = () => Promise.reject(new Error("reads the whole log"));
    response.text = () => Promise.reject(new Error("reads the whole log"));
    const ci = new GitHubCiStatus((async (input: string | URL | Request) =>
      String(input).includes("/jobs/7/logs")
        ? response
        : new Response(
            JSON.stringify({
              jobs: [{ id: 7, name: "test", status: "completed", conclusion: "failure" }],
            }),
            { status: 200 },
          )) as typeof fetch);
    const [failure] = await ci.failures({
      repo: "https://github.com/acme/app",
      token: "t-token",
      runs: [{ id: 1, name: "CI", conclusion: "failure" }],
      // 伏せる値として渡さない（切った先頭の行を捨てることだけで、途中から始まる値が残らないことを確かめる）
      secrets: [],
    });
    expect(failure?.excerpt?.split("\n").at(-1)).toBe("FAIL at the end");
    expect(failure?.excerpt).not.toContain("secret");
  });
});
