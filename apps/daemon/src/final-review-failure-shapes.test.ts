import { type FinalReview, GuardianTests, guardianTestsPassed, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildFinalReviewPrompt, buildPrompt, extractFinalReview } from "./prompts.js";

// ゴールガーディアンが、環境による失敗などの一覧を、文字列でなくオブジェクトの配列で返しても読めること。
// 実証（複数言語のモノレポ）で、`environmentFailures` が `{name, reason}` の配列で返され、文字列だけを読む読み取りが
// すべて捨てて、合格のはずの最終レビューが「不合格（0件）」になり、実装が差分なしの再送を繰り返した。

const COMMAND = "make setup && make lint test smoke build";

const block = (b: Record<string, unknown>) =>
  `説明の文\n\`\`\`json\n${JSON.stringify({ "sacty-final-review": b })}\n\`\`\``;

/** 実際に不合格になった出力の形：観点は検証済み・指摘は再発なし・終了コード 2・環境による失敗がオブジェクトの配列。 */
const SETUP_FAILURE = {
  name: "make setup（cd worker && python3 -m venv .venv）",
  reason:
    "イメージの python3 に ensurepip が無く、venv を作れません。起点のコミットを別の場所に取り出して make setup を実行しても、同じエラーで終了コード 2 になりました。",
};
const FLATTENED = `${SETUP_FAILURE.name}：${SETUP_FAILURE.reason}`;

const reported = (tests: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  block({
    viewpoints: [{ id: "REQ", verified: true, reason: "受け入れ条件をテストが検証している" }],
    remarks: [{ id: "implement-1-1", notRecurred: true, reason: "再発していない" }],
    tests: { command: COMMAND, output: "make setup が終了コード 2", missingCommands: [], ...tests },
    humanChecks: [],
    summary: "要求を満たす。合格",
    ...extra,
  });

const read = (output: string, options: { documentsOnly?: boolean } = {}) =>
  extractFinalReview(output, ["REQ"], ["implement-1-1"], { testCommand: COMMAND, ...options });

describe("最終レビューの、環境による失敗がオブジェクトの配列で返ったとき", () => {
  it("実際の出力の形（終了コード 2・{name, reason}）でも、環境による失敗だけとして合格にし、「名前：根拠」の文字列で記録する", () => {
    const review = read(reported({ exitCode: 2, environmentFailures: [SETUP_FAILURE] }));
    expect(review.passed).toBe(true);
    expect(review.tests?.exitCode).toBe(2);
    expect(review.tests?.environmentFailures).toEqual([FLATTENED]);
    // 記録する形（FinalReviewed の tests）として読めて、通ったものと判定される
    const recorded = GuardianTests.parse(review.tests);
    expect(guardianTestsPassed(recorded)).toBe(true);
    // 指摘が無いまま不合格になる（観点も指摘も問題が無い）形ではない
    expect(review.viewpoints.every((v) => v.verified)).toBe(true);
    expect(review.remarks.every((m) => m.notRecurred)).toBe(true);
  });

  it("文字列の配列（これまでの形）と、文字列とオブジェクトが混ざった配列も読む。読めない項目だけ捨てる", () => {
    const strings = read(reported({ exitCode: 2, environmentFailures: [FLATTENED] }));
    expect(strings.passed).toBe(true);
    expect(strings.tests?.environmentFailures).toEqual([FLATTENED]);
    const mixed = read(
      reported({
        exitCode: 2,
        environmentFailures: [
          SETUP_FAILURE,
          "go test：差分と関係の無いプロセスの権限で失敗する",
          {},
          { name: "", reason: "  " },
          { count: 3, nested: { a: "b" } },
          null,
          7,
          [],
          "",
        ],
      }),
    );
    expect(mixed.passed).toBe(true);
    expect(mixed.tests?.environmentFailures).toEqual([
      FLATTENED,
      "go test：差分と関係の無いプロセスの権限で失敗する",
    ]);
  });

  it("名前だけ・根拠だけのオブジェクトも、1件として読む。値の改行は1行にする（人の確認の項目に入るため）", () => {
    const review = read(
      reported({
        exitCode: 1,
        environmentFailures: [
          { name: "make setup" },
          { reason: "ensurepip が無い\n\n起点でも同じ" },
        ],
      }),
    );
    expect(review.tests?.environmentFailures).toEqual([
      "make setup",
      "ensurepip が無い 起点でも同じ",
    ]);
  });
});

describe("最終レビューの、環境による失敗の境界（不合格のままにするもの）", () => {
  it("環境による失敗を申告していない（キーが無い・空）終了コード 2 は不合格のまま", () => {
    for (const environmentFailures of [
      undefined,
      [],
      [{}],
      [{ name: "", reason: "" }],
      [null, 3],
    ]) {
      const review = read(reported({ exitCode: 2, environmentFailures }));
      expect(review.passed, JSON.stringify(environmentFailures)).toBe(false);
      expect(review.tests).not.toHaveProperty("environmentFailures");
    }
  });

  it("配列でない申告（「なし」の文字列・1件のオブジェクト）は、環境による失敗として読まない", () => {
    for (const environmentFailures of ["なし", "ensurepip が無い", SETUP_FAILURE, 1, true]) {
      const review = read(reported({ exitCode: 2, environmentFailures }));
      expect(review.passed, JSON.stringify(environmentFailures)).toBe(false);
      expect(review.tests).not.toHaveProperty("environmentFailures");
    }
  });

  it("環境の失敗と本物の失敗が混ざるときは、ゴールガーディアンが環境による失敗を空にして申告し、不合格になる", () => {
    const review = read(
      reported({
        exitCode: 1,
        environmentFailures: [],
        otherFailures: [{ name: "go test ./order", reason: "TestShippingCountry が失敗する" }],
      }),
    );
    expect(review.passed).toBe(false);
    expect(review.tests).not.toHaveProperty("environmentFailures");
  });

  it("終了コードの申告が無ければ、環境による失敗の申告があっても不合格にする", () => {
    const review = read(reported({ environmentFailures: [SETUP_FAILURE] }));
    expect(review.passed).toBe(false);
    expect(review.tests).not.toHaveProperty("environmentFailures");
  });

  it("終了コード 0 なら合格のまま。環境による失敗の申告は記録しない", () => {
    const review = read(reported({ exitCode: 0, environmentFailures: [SETUP_FAILURE] }));
    expect(review.passed).toBe(true);
    expect(review.tests).not.toHaveProperty("environmentFailures");
  });

  it("環境による失敗だけでも、観点が未検証・指摘が再発していれば不合格にする", () => {
    const unverified = read(
      reported(
        { exitCode: 2, environmentFailures: [SETUP_FAILURE] },
        { viewpoints: [{ id: "REQ", verified: false, reason: "形だけ" }] },
      ),
    );
    expect(unverified.passed).toBe(false);
    const recurred = read(
      reported(
        { exitCode: 2, environmentFailures: [SETUP_FAILURE] },
        { remarks: [{ id: "implement-1-1", notRecurred: false, reason: "再発している" }] },
      ),
    );
    expect(recurred.passed).toBe(false);
  });
});

describe("最終レビューの、一覧の項目の読み方（項目名・伏せ字・「無い」を表す項目）", () => {
  it("オブジェクトは、決めた項目名の文字列だけを読む。output・log など、ほかの項目は PR の本文に出さない", () => {
    const review = read(
      reported({
        exitCode: 2,
        environmentFailures: [
          {
            name: "make setup",
            reason: "ensurepip が無い",
            output: "TOKEN=abc123def456ghi789jkl012 の入った長い出力",
            log: "/Users/someone/work の中身",
            stderr: "error",
          },
        ],
      }),
    );
    expect(review.tests?.environmentFailures).toEqual(["make setup：ensurepip が無い"]);
  });

  it("JSON の項目の並びにかかわらず「名前：根拠」の順にする。message・description・check なども読む", () => {
    const review = read(
      reported({
        exitCode: 2,
        environmentFailures: [
          { reason: "ensurepip が無い", name: "make setup" },
          { message: "権限が無い", check: "go test ./proc" },
          { description: "ネットワークに届かない", test: "npm ci" },
        ],
      }),
    );
    expect(review.tests?.environmentFailures).toEqual([
      "make setup：ensurepip が無い",
      "go test ./proc：権限が無い",
      "npm ci：ネットワークに届かない",
    ]);
  });

  it("項目は、人に見せる前に、秘密情報と URL の認証情報を伏せる（文字列・オブジェクトとも）", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const review = read(
      reported(
        {
          exitCode: 2,
          environmentFailures: [
            {
              name: "npm ci",
              reason: `https://user:hunter2pass@registry.example.com/x?token=${secret} に届かない`,
            },
            `git clone HTTPS://bob:pa55word@example.com/r.git が失敗する（${secret}）`,
          ],
        },
        { humanChecks: [{ check: `実機で確かめる ${secret}` }] },
      ),
    );
    const shown = JSON.stringify([review.tests?.environmentFailures, review.humanChecks]);
    for (const value of [secret, "hunter2pass", "pa55word"]) expect(shown).not.toContain(value);
    expect(review.tests?.environmentFailures?.[0]).toContain("npm ci：");
    expect(review.passed).toBe(true);
  });

  it("「環境による失敗ではない」「無い」を表す項目は、環境による失敗として通さない", () => {
    for (const environmentFailures of [
      [{ environment: false }],
      ["environment: false", "environment=false"],
      ["none"],
      ["なし", "無し。"],
      ["n/a", "N/A"],
      ["null", "false", "no"],
      [{ name: "none" }, { reason: "なし" }, { name: "N/A" }],
    ]) {
      const review = read(reported({ exitCode: 2, environmentFailures }));
      expect(review.passed, JSON.stringify(environmentFailures)).toBe(false);
      expect(review.tests).not.toHaveProperty("environmentFailures");
    }
    // 名前と根拠の両方が「無い」を表す項目（連結すると「なし：なし」になって残っていた）
    for (const environmentFailures of [
      [{ name: "なし", reason: "なし" }],
      [{ name: "none", reason: "none" }],
      [{ name: "n/a", reason: "N/A" }],
      [
        { name: "なし", reason: "none" },
        { test: "N/A", message: "なし" },
      ],
      [{ name: "なし", reason: "環境による失敗はありません" }],
      [{ name: "ＮＯＮＥ", reason: "ｎ／ａ" }],
      [{ name: "-", reason: "ー" }],
      [{ name: "なし", reason: "なし" }, "なし", { reason: "none" }],
    ]) {
      const review = read(reported({ exitCode: 2, environmentFailures }));
      expect(review.passed, JSON.stringify(environmentFailures)).toBe(false);
      expect(review.tests).not.toHaveProperty("environmentFailures");
    }
    // 片方だけが「無い」を表すなら、有効な方だけ読む
    const half = read(
      reported({
        exitCode: 2,
        environmentFailures: [
          { name: "make setup", reason: "なし" },
          { name: "", reason: "ensurepip が無い" },
        ],
      }),
    );
    expect(half.passed).toBe(true);
    expect(half.tests?.environmentFailures).toEqual(["make setup", "ensurepip が無い"]);
    // 本物の項目が混ざっていれば、その項目だけ読む
    const mixed = read(
      reported({ exitCode: 2, environmentFailures: ["なし", "make setup：ensurepip が無い"] }),
    );
    expect(mixed.passed).toBe(true);
    expect(mixed.tests?.environmentFailures).toEqual(["make setup：ensurepip が無い"]);
  });
});

describe("最終レビューの、項目の URL と「環境によるものではない」旗", () => {
  it("確かめる対象の URL（クエリ・フラグメント）は残し、認証情報と秘密らしい名前の値だけ伏せる", () => {
    const review = read(
      reported(
        { exitCode: 0 },
        {
          humanChecks: [
            "http://localhost:3000/#/settings?tab=2 を開いて目視する",
            { check: "https://example.com/a?page=3&sort=asc#section-2 を見る" },
            "https://bob:pa55word@example.com/x?token=abcd1234efgh&tab=2 を開く",
            "http://localhost:3000/cb?code=1&api_key=abcd1234efgh#access_token=zzzz9999yyyy を確かめる",
            "https://example.com/?signature=s1g9n4tur3&Password=hunter22 を開く",
          ],
        },
      ),
    );
    const checks = review.humanChecks ?? [];
    expect(checks[0]).toBe("http://localhost:3000/#/settings?tab=2 を開いて目視する");
    expect(checks[1]).toBe("https://example.com/a?page=3&sort=asc#section-2 を見る");
    expect(checks[2]).toContain("tab=2");
    expect(checks[3]).toContain("code=1");
    const shown = JSON.stringify(checks);
    for (const value of ["pa55word", "abcd1234efgh", "zzzz9999yyyy", "s1g9n4tur3", "hunter22"]) {
      expect(shown, value).not.toContain(value);
    }
  });

  it("パラメーター名が符号化されていても、秘密らしい名前の値を伏せる（%5F・%74・二重の符号化・壊れた符号化・大小文字・全角）", () => {
    const urls = [
      "https://example.com/?api%5Fkey=FAKEVALUE1&%74oken=FAKEVALUE2",
      "https://example.com/?%61pi%2Dkey=FAKEVALUE3&%50assword=FAKEVALUE4",
      "https://example.com/?%2574oken=FAKEVALUE5",
      "https://example.com/?%E3%81%82%74oken=FAKEVALUE6&%zz%50assword=FAKEVALUE6b&sign=FAKEVALUE6c",
      "https://example.com/#access%5Ftoken=FAKEVALUE7&X-Amz-Signature=FAKEVALUE8",
      "https://example.com/?apiKey=FAKEVALUE9&clientSecret=FAKEVALUE10&APIKey=FAKEVALUE11",
      "https://example.com/?apikey=FAKEVALUE12&sessionid=FAKEVALUE13&auth_token=FAKEVALUE14",
      "https://example.com/?ｔｏｋｅｎ=FAKEVALUE15&filter[token]=FAKEVALUE16",
      "https://example.com/app;jsessionid=FAKEVALUE17?PHPSESSID=FAKEVALUE18",
    ];
    const review = read(
      reported(
        { exitCode: 2, environmentFailures: [{ name: "fetch", reason: urls[0] }] },
        { humanChecks: [...urls.slice(1), { check: "開く", reason: urls[0] }] },
      ),
    );
    const shown = JSON.stringify([review.tests?.environmentFailures, review.humanChecks]);
    for (let n = 1; n <= 18; n++) expect(shown, `FAKEVALUE${n}`).not.toContain(`FAKEVALUE${n}=`);
    expect(shown).not.toMatch(/FAKEVALUE\d+/);
    expect(shown).toContain("[REDACTED]");
  });

  it("秘密らしい名前でも、通常の語の一部（author・design・keyword・signIn・monkey）は伏せず、表示条件の URL を残す", () => {
    const url =
      "https://example.com/articles?author=alice&design=mobile&keyword=cats&signIn=1&monkey=2&tab=3&sort_by=date";
    const review = read(reported({ exitCode: 0 }, { humanChecks: [`${url} を開く`] }));
    expect(review.humanChecks).toEqual([`${url} を開く`]);
    // 同じ URL に秘密らしい名前が混ざれば、その値だけ伏せる
    const mixed = read(
      reported(
        { exitCode: 0 },
        { humanChecks: ["https://example.com/?author=alice&token=FAKEVALUE1&design=mobile"] },
      ),
    );
    expect(mixed.humanChecks).toEqual([
      "https://example.com/?author=alice&token=[REDACTED]&design=mobile",
    ]);
  });

  it("`;` で区切ったパラメーター・パスパラメーターの後ろの秘密値も伏せ、後ろのクエリ（?tab=2）は残す", () => {
    const cases: [string, string][] = [
      [
        "https://example.com/?page=1;signature=FAKEVALUE1",
        "https://example.com/?page=1;signature=[REDACTED]",
      ],
      [
        "https://example.com/?page=1;signature=FAKEVALUE2&tab=2",
        "https://example.com/?page=1;signature=[REDACTED]&tab=2",
      ],
      [
        "https://example.com/app;jsessionid=FAKEVALUE3?tab=2",
        "https://example.com/app;jsessionid=[REDACTED]?tab=2",
      ],
      [
        "https://example.com/app;jsessionid=FAKEVALUE4?tab=2&sort=asc#access_token=FAKEVALUE5",
        "https://example.com/app;jsessionid=[REDACTED]?tab=2&sort=asc#access_token=[REDACTED]",
      ],
      // 秘密でない名前の値が、後ろの秘密のパラメーターを飲み込まない（next の値の中の ?token= など）
      [
        "https://example.com/?next=https://a.example/x?token=FAKEVALUE7&tab=2",
        "https://example.com/?next=https://a.example/x?token=[REDACTED]&tab=2",
      ],
      [
        "https://example.com/?a=1;b=2;password=FAKEVALUE8;c=3",
        "https://example.com/?a=1;b=2;password=[REDACTED];c=3",
      ],
      // HTML の `&amp;` で区切られていても伏せる
      [
        "https://example.com/?page=1&amp;token=FAKEVALUE9",
        "https://example.com/?page=1&amp;token=[REDACTED]",
      ],
      // 秘密の値に `;`・`?` が入っていても（後ろに名前=が続かなければ）、続きまで伏せる
      [
        "https://example.com/?token=FAKE;VALUE10?x&tab=2",
        "https://example.com/?token=[REDACTED]&tab=2",
      ],
    ];
    const review = read(
      reported({ exitCode: 0 }, { humanChecks: cases.map(([input]) => ({ check: input })) }),
    );
    expect(review.humanChecks).toEqual(cases.map(([, expected]) => expected));
  });

  it("環境による失敗の項目でも、URL は残し、認証情報を伏せる", () => {
    const review = read(
      reported({
        exitCode: 2,
        environmentFailures: [
          {
            name: "npm ci",
            reason: "https://u:p4ssw0rd9@registry.example.com/pkg?tab=2 に届かない",
          },
        ],
      }),
    );
    const failure = review.tests?.environmentFailures?.[0] ?? "";
    expect(failure).toContain("registry.example.com/pkg?tab=2");
    expect(failure).not.toContain("p4ssw0rd9");
  });

  it("environment・environmental・isEnvironment が false の項目は、環境による失敗として読まない", () => {
    for (const flag of [
      { environment: false },
      { environmental: false },
      { isEnvironment: false },
      { is_environmental: "false" },
      { environment: "no" },
    ]) {
      const review = read(
        reported({
          exitCode: 2,
          environmentFailures: [{ name: "go test ./order", reason: "TestX が失敗する", ...flag }],
        }),
      );
      expect(review.passed, JSON.stringify(flag)).toBe(false);
      expect(review.tests).not.toHaveProperty("environmentFailures");
    }
    // true・旗なしの項目は読む。旗が false の項目だけ除く
    const mixed = read(
      reported({
        exitCode: 2,
        environmentFailures: [
          { name: "a", reason: "ensurepip が無い", environment: true },
          { name: "b", reason: "本物の失敗", environment: false },
          { name: "c", reason: "権限が無い" },
        ],
      }),
    );
    expect(mixed.tests?.environmentFailures).toEqual(["a：ensurepip が無い", "c：権限が無い"]);
  });
});

describe("最終レビューの、他の一覧の項目がオブジェクトで返ったとき", () => {
  it("humanChecks も、{description} のようなオブジェクトを読んで記録する", () => {
    const review = read(
      reported(
        { exitCode: 0 },
        { humanChecks: ["画面を目で見る", { check: "実機で確かめる", reason: "作業領域に無い" }] },
      ),
    );
    expect(review.passed).toBe(true);
    expect(review.humanChecks).toEqual(["画面を目で見る", "実機で確かめる：作業領域に無い"]);
  });

  it("otherFailures は存在で見る：読めない形でも、書いてあれば、文書だけの差分でツール不足を通ったものにしない", () => {
    for (const otherFailures of [
      [{ name: "docs:lint", reason: "リンクが切れている" }],
      "lint failed",
      ["lint failed"],
      "no",
      ["false"],
      [{ detail: { file: "README.md", line: 3 } }],
      [{}],
      [{ failure: "x" }],
      [["lint failed"]],
      [1],
      [true],
      { name: "docs:lint" },
    ]) {
      const output = reported({ exitCode: 1, missingCommands: ["make"], otherFailures });
      const review = read(output, { documentsOnly: true });
      expect(review.tests?.missingCommands, JSON.stringify(otherFailures)).toBeUndefined();
      expect(review.passed, JSON.stringify(otherFailures)).toBe(false);
    }
  });

  it("otherFailures が無い・空・「なし」だけなら、文書だけの差分でツール不足を人の確認に回して通す", () => {
    for (const otherFailures of [
      undefined,
      null,
      [],
      "",
      "  ",
      ["", " ", null],
      "なし",
      ["none"],
      [false, 0, "N/A", "なし。"],
    ]) {
      const output = reported({ exitCode: 127, missingCommands: ["make"], otherFailures });
      const review = read(output, { documentsOnly: true });
      expect(review.tests?.missingCommands, JSON.stringify(otherFailures)).toEqual(["make"]);
      expect(review.passed, JSON.stringify(otherFailures)).toBe(true);
    }
  });

  it("missingCommands が {name} のオブジェクトでも、ツール不足として読む（読めずに黙って不合格にしない）", () => {
    const output = reported({
      exitCode: 127,
      missingCommands: [{ name: "make" }, { tool: "make" }],
    });
    // 文書だけでなければ、ツール不足として止める側に返す
    expect(read(output).missingCommands).toEqual(["make"]);
    // 文書だけなら、止めずに記録して通す
    const docs = read(output, { documentsOnly: true });
    expect(docs.missingCommands).toEqual([]);
    expect(docs.tests?.missingCommands).toEqual(["make"]);
    expect(docs.passed).toBe(true);
    // コマンドに書いていない名前・パスは、これまでどおり読まない
    const unknown = read(
      reported({ exitCode: 127, missingCommands: [{ name: "cargo" }, { name: "/usr/bin/make" }] }),
    );
    expect(unknown.missingCommands).toEqual([]);
  });
});

const failedTask = (review: Partial<FinalReview>) =>
  ({
    id: "t-1",
    title: "配送先を足す",
    body: "配送先の国コードを足す",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
    outputs: { implement: "# 実装の説明" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["order.test.ts"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    verifyFeedback: {
      kind: "review",
      review: {
        passed: false,
        viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
        remarks: [],
        summary: "テストが通らなかった",
        tests: { command: COMMAND, exitCode: 2, output: "make: *** [setup] Error 2" },
        agentId: "claude",
        runId: "r1",
        costUsd: 0,
        estimated: false,
        at: "2026-10-31T15:31:00.000Z",
        ...review,
      },
    },
  }) as unknown as Task;

const NO_FINDINGS =
  "観点と過去の指摘には、問題は見つかっていません。不合格の理由は、ゴールガーディアンが実行したテストが通らなかったことだけです。";

describe("指摘が無いままテストだけで不合格になったときの、実装のやり直しの指示", () => {
  it("観点・指摘に問題が無く、テストが通らなかったことだけが理由だと伝え、無関係な変更を足させない", () => {
    const prompt = buildPrompt(failedTask({}), "implement");
    expect(prompt).toContain(NO_FINDINGS);
    expect(prompt).toContain("実装で直る失敗が無ければ、無関係な変更を足さないでください");
    expect(prompt).toContain("テスト：make setup && make lint test smoke build（終了コード 2）");
  });

  it("観点が未検証・指摘が再発しているときは、その指摘を挙げ、この文は出さない", () => {
    const unverified = buildPrompt(
      failedTask({ viewpoints: [{ viewpointId: "REQ", verified: false, reason: "形だけ" }] }),
      "implement",
    );
    expect(unverified).toContain("[REQ] 観点を検証できていない：形だけ");
    expect(unverified).not.toContain(NO_FINDINGS);
    const recurred = buildPrompt(
      failedTask({ remarks: [{ remarkId: "r-1", notRecurred: false, reason: "再発" }] }),
      "implement",
    );
    expect(recurred).toContain("[r-1] 過去の指摘が再発している：再発");
    expect(recurred).not.toContain(NO_FINDINGS);
  });
});

describe("ゴールガーディアンへの指示の、環境による失敗の書き方", () => {
  it("environmentFailures を、1件が「名前：根拠」の文字列の配列で書かせる", () => {
    const prompt = buildFinalReviewPrompt(failedTask({}), "diff", { testCommand: COMMAND });
    expect(prompt).toContain("1件は「名前：根拠」の1つの文字列にして、文字列の配列で書きます");
    expect(prompt).toContain("（1件は「名前：根拠」の1つの文字列にした、文字列の配列）");
  });
});
