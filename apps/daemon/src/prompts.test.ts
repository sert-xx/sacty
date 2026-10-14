import {
  type ActivityEvent,
  EventInput,
  project,
  renderMessage,
  type Task,
  type TaskQuestion,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  allowedPlans,
  buildChatPrompt,
  buildExportDocument,
  buildExportPrompt,
  buildOrchestratorPrompt,
  buildPrompt,
  buildPullRequestBody,
  buildReworkPrompt,
  buildStepDocument,
  buildStepPullRequestBody,
  buildStepPullRequestTitle,
  buildTicketPullRequestComment,
  CHAT_PROMPT_MAX,
  commentableLines,
  extractExport,
  extractIntegrationReview,
  extractReviewComments,
  extractSplitPlan,
  extractStepPlan,
  servicePromptLines,
} from "./prompts.js";

const diff = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,3 +1,3 @@",
  " import { pay } from './pay';",
  "-export const retry = 1;",
  "+export const retry = 3;",
  " export const once = 1;",
  "@@ -20,2 +20,3 @@ export function run() {",
  "   run();",
  "+  log();",
  "\\ No newline at end of file",
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-old",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
].join("\n");

describe("PR の差分で行へのコメントを付けられる行（PBI-19）", () => {
  it("追加した行と前後の行の、先頭のファイルの行番号を返し、消した行・消したファイルは含めない", () => {
    const lines = commentableLines(diff);
    expect([...(lines.get("src/retry.ts") ?? [])]).toEqual([1, 2, 3, 20, 21]);
    expect([...(lines.get("src/new.ts") ?? [])]).toEqual([1, 2]);
    expect(lines.has("src/old.ts")).toBe(false);
  });
});

describe("レビューの出力から行へのコメントを取り出す（PBI-19）", () => {
  const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

  it("形式の正しくないものは捨て、ブロックは本文から取り除く", () => {
    const output = `# 評価\n\n${block({
      "sacty-review-comments": [
        { path: "src/new.ts", line: "2", body: "文字列の行番号も読む" },
        { path: "src/new.ts", line: 0, body: "0 行目" },
        { path: "src/new.ts", line: 1.5, body: "小数" },
        { path: "", line: 1, body: "パスが無い" },
        { path: "src/new.ts", line: 1, body: "" },
      ],
    })}`;
    expect(extractReviewComments(output, diff)).toEqual({
      output: "# 評価",
      comments: [{ path: "src/new.ts", line: 2, body: "文字列の行番号も読む" }],
    });
  });

  it("上限を超えた行へのコメントは本文に入れる", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      path: "src/new.ts",
      line: 1,
      body: `指摘${i + 1}`,
    }));
    const result = extractReviewComments(block({ "sacty-review-comments": many }), diff);
    expect(result.comments).toHaveLength(50);
    expect(result.output).toContain("`src/new.ts:1` 指摘51");
    expect(result.output).not.toContain("指摘50\n");
  });
});

describe("レビューの工程の差分の渡し方（PBI-65）", () => {
  const reviewTask = {
    title: "レビュー",
    body: "",
    steps: [{ key: "review", state: "todo" }],
    remarks: [],
    outputs: {},
    approved: {},
    reproductionTests: [],
    reviewTarget: {
      repo: "https://github.com/acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      title: "retry",
      body: "",
      headCommit: "h".repeat(40),
      baseCommit: "b".repeat(40),
    },
  } as unknown as Task;
  const big = `diff --git a/x b/x\n${"+".repeat(10)}\n`.repeat(20_000);

  it("差分が大きいときは先頭だけを渡し、全体のファイルの場所を伝える（写しに .git は無い）", () => {
    const prompt = buildPrompt(reviewTask, "review", {
      diff: big,
      diffFile: "/sacty-review/pr.diff",
    });
    expect(prompt).toContain(
      "PR の差分の全体（切り詰めなし）は、作業領域の外のファイル /sacty-review/pr.diff にあります（sacty が置いた読み取り専用のファイルで、PR の一部ではありません。レビューの対象にしないでください）",
    );
    expect(prompt).toContain(
      "残りは /sacty-review/pr.diff の差分の全体と作業領域のコードを読んでください",
    );
    expect(prompt).toContain(".git はありません");
    expect(prompt.length).toBeLessThan(big.length);
  });

  it("差分のファイルが無いときは、作業領域のコードを読むように伝える", () => {
    const prompt = buildPrompt(reviewTask, "review", { diff: big });
    expect(prompt).toContain("残りは作業領域のコードを読んでください");
    expect(prompt).not.toContain("/sacty-review/pr.diff");
  });
});

describe("タスク分割（PBI-27）", () => {
  const task = (parent?: Task["parent"]) =>
    ({ title: "決済", body: "", ...(parent ? { parent } : {}) }) as Task;
  const plan = (children: unknown[]) =>
    extractSplitPlan(
      `本文\n\`\`\`json\n${JSON.stringify({ "sacty-split": { reason: "理由", children } })}\n\`\`\``,
    );
  const ja = (r: ReturnType<typeof extractSplitPlan>) =>
    r.ok ? "" : renderMessage(r.message, "ja");
  const child = (key: string, dependsOn: string[] = []) => ({
    key,
    title: key,
    body: "",
    dependsOn,
  });

  it("分割は、子タスクでないときだけオーケストレーターの候補にする（1段だけ）", () => {
    expect(allowedPlans(task())).toContain("split");
    expect(allowedPlans(task({ taskId: "p", dependsOn: [] }))).not.toContain("split");
    expect(buildOrchestratorPrompt(task())).toContain("- split：");
    expect(buildOrchestratorPrompt(task({ taskId: "p", dependsOn: [] }))).not.toContain("split");
  });

  it("子タスクの一覧を読み、数・key の重複・存在しない依存・循環を確かめる", () => {
    expect(plan([child("A"), child("B", ["A"])])).toEqual({
      ok: true,
      reason: "理由",
      children: [child("A"), child("B", ["A"])],
    });
    expect(ja(extractSplitPlan("JSON なし"))).toMatch(/読み取れませんでした/);
    expect(ja(plan([child("A"), { key: "B" }]))).toMatch(/読み取れませんでした/);
    expect(ja(plan([child("A")]))).toMatch(/2〜10件にしてください（分割案は1件）/);
    expect(ja(plan(Array.from({ length: 11 }, (_, i) => child(`K${i}`))))).toMatch(
      /（分割案は11件）/,
    );
    expect(ja(plan([child("A"), child("A")]))).toMatch(/「A」が重複/);
    expect(ja(plan([child("A"), child("B", ["C"])]))).toMatch(/「B」が、存在しない子タスク「C」/);
    expect(ja(plan([child("A", ["A"]), child("B")]))).toMatch(/「A」が、存在しない子タスク「A」/);
    expect(ja(plan([child("A", ["C"]), child("B", ["A"]), child("C", ["B"]), child("D")]))).toMatch(
      /循環しています（A, B, C）/,
    );
  });
});

describe("統合レビュー（PBI-31）", () => {
  const review = (r: Record<string, unknown>) =>
    `# 説明\n\n\`\`\`json\n${JSON.stringify({ "sacty-integration-review": r })}\n\`\`\``;
  const verified = { viewpoints: [{ id: "TV-1", verified: true, reason: "満たす" }], remarks: [] };

  it("すべての観点を満たし、足りないことが無いときだけ合格にし、判定の形式を除いた説明を返す", () => {
    const passed = extractIntegrationReview(
      review({ ...verified, findings: [], summary: "所見" }),
      ["TV-1"],
      [],
    );
    expect(passed).toMatchObject({ passed: true, findings: [], summary: "所見", output: "# 説明" });
    // 観点を満たすと書いても、足りないことがあれば不合格（修正の子タスクで直す）
    expect(
      extractIntegrationReview(review({ ...verified, findings: ["つなぐ", " "] }), ["TV-1"], []),
    ).toMatchObject({ passed: false, findings: ["つなぐ"] });
    // 判定の無い観点・指摘は不合格
    const missing = extractIntegrationReview(
      review({ ...verified, findings: [] }),
      ["TV-1", "TV-2"],
      ["split-1-1"],
    );
    expect(missing.passed).toBe(false);
    expect(renderMessage(missing.viewpoints[1]?.reason, "ja")).toBe("判定がありません。");
    expect(missing.remarks).toEqual([
      expect.objectContaining({ remarkId: "split-1-1", notRecurred: false }),
    ]);
  });

  it("判定を読めなければ、統合レビューを読めなかった理由で不合格にする", () => {
    const unreadable = extractIntegrationReview("判定なし", ["TV-1"], []);
    expect(unreadable.passed).toBe(false);
    expect(unreadable.output).toBe("判定なし");
    expect(renderMessage(unreadable.summary, "ja")).toMatch(/統合レビューの出力から/);
    expect(renderMessage(unreadable.viewpoints[0]?.reason, "ja")).toMatch(/統合レビューの出力から/);
  });

  it("修正の子タスクの追加は、1件から作れる", () => {
    const one = `\`\`\`json\n${JSON.stringify({ "sacty-split": { reason: "直す", children: [{ key: "F", title: "F" }] } })}\n\`\`\``;
    expect(extractSplitPlan(one).ok).toBe(false);
    expect(extractSplitPlan(one, 1).ok).toBe(true);
    expect(
      extractSplitPlan(one.replace('"children":[{"key":"F","title":"F"}]', '"children":[]'), 1),
    ).toMatchObject({ ok: false });
  });
});

describe("工程の選択と内容の調査では、開発のセットアップを省く（PBI-43）", () => {
  const NO_SETUP =
    "開発のためのセットアップ（依存関係のインストール・ビルド・setup のスクリプトなど）は実行しない";
  const PRIORITY =
    "リポジトリの AGENTS.md・CLAUDE.md・README などの指示とぶつかる場合は、このプロンプトの指示を優先する";
  const task = (steps: Task["steps"][number]["key"][], investigation?: Task["investigation"]) =>
    ({
      title: "決済",
      body: "",
      steps: steps.map((key) => ({ key, state: "todo" })),
      remarks: [],
      outputs: {},
      approved: {},
      reproductionTests: [],
      testCommand: "npm test",
      repository: {
        url: "https://github.com/acme/app",
        baseBranch: "main",
        baseCommit: "abcdef1234",
      },
      ...(investigation ? { investigation } : {}),
    }) as unknown as Task;

  it("オーケストレーターのプロンプトに、セットアップをしないこと・リポジトリの指示より優先することを書き、調査の性質を決めさせる", () => {
    const prompt = buildOrchestratorPrompt(task([]));
    expect(prompt).toContain(NO_SETUP);
    expect(prompt).toContain(PRIORITY);
    expect(prompt).toContain("- investigation：");
    expect(prompt).toContain('"investigation": "content または bug"');
  });

  it("内容の調査（調査だけ・前段の調査）のプロンプトに、セットアップをしないこと・優先することを書く", () => {
    for (const t of [
      task(["investigate"], "content"),
      task(["investigate", "requirements", "implement", "pr"], "content"),
      // オーケストレーターが判断しなかったときは、セットアップをしない側
      task(["investigate"]),
    ]) {
      const prompt = buildPrompt(t, "investigate");
      expect(prompt).toContain(NO_SETUP);
      expect(prompt).toContain(PRIORITY);
      // セットアップを勧める文言は入れない
      expect(prompt).not.toContain(
        "セットアップ（依存関係の取得など）や、調べるためのコマンド・テストは実行してかまいません",
      );
    }
  });

  it("不具合の調査・再現・実装のプロンプトには、セットアップを省く指示を出さない", () => {
    const bugfix = task(["investigate", "reproduce", "implement", "pr"], "bug");
    const prompts = [
      buildPrompt(task(["investigate"], "bug"), "investigate"),
      buildPrompt(bugfix, "investigate"),
      buildPrompt(bugfix, "reproduce"),
      buildPrompt(bugfix, "implement"),
      // 内容の調査のあとの実装でも出さない
      buildPrompt(task(["investigate", "requirements", "implement", "pr"], "content"), "implement"),
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toContain(NO_SETUP);
      expect(prompt).not.toContain(PRIORITY);
    }
    // 不具合の調査は、これまでどおりリポジトリの手順のセットアップを実行してよい
    expect(prompts[0]).toContain("リポジトリの手順にあるセットアップ（依存関係の取得など）");
  });

  it("オーケストレーターの出力から、調査の性質を読む（決めた値のときだけ）", () => {
    const output = (investigation: unknown) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "investigate", reason: "質問", investigation } })}\n\`\`\``;
    expect(extractStepPlan(output("bug"))).toMatchObject({ investigation: "bug" });
    expect(extractStepPlan(output("content"))).toMatchObject({ investigation: "content" });
    expect(extractStepPlan(output("other"))).not.toHaveProperty("investigation");
    expect(extractStepPlan(output(undefined))).not.toHaveProperty("investigation");
  });

  it("イメージの候補は渡したときだけ見せ、出力からは工程とイメージの名前の形が正しいものだけを読む（PBI-41）", () => {
    const repoTask = { title: "x", body: "", steps: [] } as unknown as Task;
    const none = buildOrchestratorPrompt(repoTask);
    expect(none).not.toContain("images：");
    expect(none).not.toContain('"images"');
    const prompt = buildOrchestratorPrompt(repoTask, {
      images: [{ name: "java17", description: "Java 17・Maven" }],
    });
    expect(prompt).toContain("- images：工程ごとに使う実行のイメージ");
    expect(prompt).toContain("  - default：既定のイメージ");
    expect(prompt).toContain("  - java17：Java 17・Maven");
    expect(prompt).toContain('"images": {"implement": "イメージの名前"}');

    const output = (images: unknown, imageReason?: unknown) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "standard", reason: "r", images, imageReason } })}\n\`\`\``;
    expect(
      extractStepPlan(
        output(
          {
            implement: "java17",
            design: "default",
            nope: "java17",
            requirements: "Bad Name",
            pr: 3,
          },
          "pom.xml",
        ),
      ),
    ).toMatchObject({ images: { implement: "java17", design: "default" }, imageReason: "pom.xml" });
    expect(extractStepPlan(output("java17"))).not.toHaveProperty("images");
    expect(extractStepPlan(output({}))).not.toHaveProperty("images");
    expect(extractStepPlan(output(undefined))).not.toHaveProperty("imageReason");
  });

  it("共用の compose は名前で選ばせ、使う・使わない理由を書かせる。設定が無い・対象リポジトリが無いなら聞かない（PBI-70）", () => {
    const output = (v: Record<string, unknown>) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "standard", reason: "r", ...v } })}\n\`\`\``;
    // 名前で選ぶ（ファイルは設定のものを使うので読まない。両方あれば共用の compose）
    expect(
      extractStepPlan(
        output({
          services: { compose: "infra", file: "x.yml", names: ["redis"], steps: ["implement"] },
          servicesReason: "結合テストが Redis を使う",
        }),
      ),
    ).toMatchObject({
      services: { compose: "infra", names: ["redis"], steps: ["implement"] },
      servicesReason: "結合テストが Redis を使う",
    });
    expect(
      extractStepPlan(output({ services: { compose: "infra", names: [], steps: ["implement"] } }))
        ?.services,
    ).not.toHaveProperty("file");
    // 名前の形でなければ、対象リポジトリの compose ファイルとして読む（無ければ指定しなかったことにする）
    expect(
      extractStepPlan(
        output({ services: { compose: "Bad Name", file: "compose.yaml", steps: ["implement"] } }),
      )?.services,
    ).toEqual({ file: "compose.yaml", names: [], steps: ["implement"] });
    expect(
      extractStepPlan(output({ services: { compose: "../x", steps: ["implement"] } })),
    ).not.toHaveProperty("services");
    // 使わない理由だけでも残す。長すぎる理由は切り詰める
    expect(extractStepPlan(output({ servicesReason: "使わない" }))).toMatchObject({
      servicesReason: "使わない",
    });
    expect(
      extractStepPlan(output({ servicesReason: "x".repeat(2000) }))?.servicesReason,
    ).toHaveLength(1000);
    expect(extractStepPlan(output({}))).not.toHaveProperty("servicesReason");

    const withRepo = {
      title: "x",
      body: "",
      steps: [],
      repository: { url: "https://github.com/a/b.git", baseBranch: "main", baseCommit: "abc1234" },
    } as unknown as Task;
    const shared = [
      { name: "infra", file: "compose/redis.yml", description: "Redis。結合テストに要る" },
      { name: "kafka", file: "compose.yaml" },
    ];
    const prompt = buildOrchestratorPrompt(withRepo, { sharedComposes: shared });
    expect(prompt).toContain("設定してあるだけでは起動しません");
    expect(prompt).toContain(
      "- infra：compose ファイル compose/redis.yml。Redis。結合テストに要る",
    );
    expect(prompt).toContain("- kafka：compose ファイル compose.yaml\n");
    expect(prompt).toContain("- servicesReason：");
    expect(prompt).toContain('"compose": "または共用の compose の名前"');
    // 1つだけでも聞く
    expect(buildOrchestratorPrompt(withRepo, { sharedComposes: [shared[1] as never] })).toContain(
      "- kafka：compose ファイル compose.yaml",
    );
    for (const without of [
      buildOrchestratorPrompt(withRepo),
      buildOrchestratorPrompt(withRepo, { sharedComposes: [] }),
      buildOrchestratorPrompt({ title: "x", body: "", steps: [] } as unknown as Task, {
        sharedComposes: shared,
      }),
    ]) {
      expect(without).not.toContain("共用の compose");
      expect(without).not.toContain("servicesReason");
    }
  });

  it("サービスの指定は、リポジトリの中の相対パスと、コードを動かす工程だけを読む（PBI-47）", () => {
    const output = (services: unknown) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "standard", reason: "r", services } })}\n\`\`\``;
    expect(
      extractStepPlan(
        output({
          file: "deploy/compose.yaml",
          names: ["db", "db", "mock-api", "bad name", 3],
          steps: ["implement", "design", "reproduce", "nope"],
        }),
      ),
    ).toMatchObject({
      services: {
        file: "deploy/compose.yaml",
        names: ["db", "mock-api"],
        steps: ["implement", "reproduce"],
      },
    });
    for (const file of ["/etc/compose.yaml", "../other/compose.yaml", "a/../../compose.yaml", ""]) {
      expect(extractStepPlan(output({ file, names: [], steps: ["implement"] }))).not.toHaveProperty(
        "services",
      );
    }
    // 使える工程が無ければ、指定しなかったことにする
    expect(
      extractStepPlan(output({ file: "compose.yaml", names: [], steps: ["design"] })),
    ).not.toHaveProperty("services");
    // オーケストレーターには、対象リポジトリがあるときだけ聞く
    const withRepo = {
      title: "x",
      body: "",
      steps: [],
      repository: { url: "https://github.com/a/b.git", baseBranch: "main", baseCommit: "abc1234" },
    } as unknown as Task;
    expect(buildOrchestratorPrompt(withRepo)).toContain("- services：テストや動作確認に");
    expect(
      buildOrchestratorPrompt({ title: "x", body: "", steps: [] } as unknown as Task),
    ).not.toContain("- services：");
    expect(
      servicePromptLines([
        { name: "db", ports: [5432, 5433] },
        { name: "mock", ports: [] },
      ]),
    ).toEqual([
      "",
      "--- 起動しているサービス（docker compose） ---",
      expect.stringContaining("docker・docker compose のコマンドは使えません"),
      expect.stringContaining("127.0.0.1 と書いてください"),
      "- db：db:5432 または localhost:5432、db:5433 または localhost:5433",
      "- mock",
    ]);
    // localhost でもサービス名でも接続できる。設定は書き換えさせない（PBI-60）
    const intro = servicePromptLines([{ name: "db", ports: [5432] }])[2];
    expect(intro).toContain("localhost のそのポート");
    expect(intro).toContain("書き換えずにそのまま使ってください");
    expect(intro).not.toContain("localhost ではありません");
    expect(servicePromptLines([{ name: "db", ports: [5432] }])[3]).toContain(
      "サービスと同じポートでアプリを待ち受けさせると、転送とぶつかります",
    );
    // 複数のサービスが使うポートは、localhost に転送していないと伝える
    expect(
      servicePromptLines([
        { name: "a", ports: [8080, 9000] },
        { name: "b", ports: [8080] },
      ]).slice(4),
    ).toEqual([
      "- a：a:8080（localhost:8080 は、複数のサービスが使う番号のため、転送していません）、a:9000 または localhost:9000",
      "- b：b:8080（localhost:8080 は、複数のサービスが使う番号のため、転送していません）",
    ]);
    // ホストに出すポートが違えば、そのポートでも届くと伝える。ぶつかる番号は転送していないと伝える
    expect(
      servicePromptLines([
        { name: "db", ports: [5432], hostPorts: [{ port: 15432, target: 5432 }] },
        { name: "cache", ports: [6379], hostPorts: [{ port: 15432, target: 6379 }] },
      ]).slice(4),
    ).toEqual([
      "- db：db:5432 または localhost:5432（localhost:15432 は、複数のサービスが使う番号のため、転送していません）",
      "- cache：cache:6379 または localhost:6379（localhost:15432 は、複数のサービスが使う番号のため、転送していません）",
    ]);
    expect(
      servicePromptLines([
        { name: "db", ports: [5432], hostPorts: [{ port: 15432, target: 5432 }] },
      ]),
    ).toContain("- db：db:5432 または localhost:5432・localhost:15432");
    expect(servicePromptLines([{ name: "db", ports: [5432] }])[2]).toContain(
      "そのポート（localhost:15432）でも届きます",
    );
    // 同じサービスの中では、ホストに出すポートの対応を優先する。UDP は転送しない（PBI-60 レビュー指摘）
    const app = {
      name: "app",
      ports: [80, 8080],
      hostPorts: [
        { port: 8080, target: 80 },
        { port: 18080, target: 8080 },
      ],
      otherPorts: [{ port: 8125, protocol: "udp" }],
    };
    expect(servicePromptLines([app]).slice(4)).toEqual([
      "- app：app:80 または localhost:80・localhost:8080、app:8080 または localhost:18080、app:8125/udp（localhost には転送していません）",
    ]);
    expect(servicePromptLines([app, { name: "mock", ports: [8080] }]).slice(4)).toEqual([
      "- app：app:80 または localhost:80（localhost:8080 は、複数のサービスが使う番号のため、転送していません）、app:8080 または localhost:18080、app:8125/udp（localhost には転送していません）",
      "- mock：mock:8080（localhost:8080 は、複数のサービスが使う番号のため、転送していません）",
    ]);
    expect(servicePromptLines([])).toEqual([]);
  });
});

describe("オーケストレーターへの質問の指示（PBI-54）", () => {
  let seq = 0;
  const ev = (input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
    ({
      ...EventInput.parse(input),
      seq: ++seq,
      id: `e${seq}`,
      taskId: "t1",
      projectId: "default",
      actor,
      at: "2026-10-13T00:00:00.000Z",
    }) as ActivityEvent;
  const ledger = (body: string, extra: EventInput[]) => {
    seq = 0;
    const events = [
      ev({ type: "TaskCreated", payload: { title: "決済API", body, start: "sacty" } }, "person"),
      ev({ type: "StepsChosen", payload: { steps: ["requirements", "design"] } }),
      ...extra.map((input) => ev(input)),
      ev({ type: "QuestionAsked", payload: { questionId: "Q-1", text: "いまどこ？" } }, "person"),
    ];
    const task = project(events).get("t1") as Task;
    return { task, events, question: task.questions[0] as TaskQuestion };
  };

  it("台帳がどれだけ長くても上限の長さに収め、質問と新しい作業履歴を残す（古い作業履歴から省く）", () => {
    // 日本語の長い内容と、たくさんの作業履歴
    const many = Array.from(
      { length: 2000 },
      (_, i): EventInput => ({
        type: "AiRequestsRetried",
        payload: {
          runId: `run-${i}`,
          agentId: "あ".repeat(400),
          retries: 1,
          waitedMs: 1,
          statuses: [429],
          gaveUp: false,
        },
      }),
    );
    for (const body of ["い".repeat(200_000), "短い本文"]) {
      const { task, events, question } = ledger(body, many);
      const prompt = buildChatPrompt(task, events, question);
      expect(prompt.length).toBeLessThanOrEqual(CHAT_PROMPT_MAX);
      // 日本語（3バイト）でも、コマンドの引数の上限（128KiB）に収まる
      expect(Buffer.byteLength(prompt)).toBeLessThan(128 * 1024);
      expect(prompt.endsWith("--- 質問 ---\nいまどこ？")).toBe(true);
      expect(prompt).toContain("run-1999");
      expect(prompt).not.toContain('run-0"');
    }
  });

  it("作業履歴が少なければすべて入れ、質問と答えのイベントは作業履歴に重ねない", () => {
    const { task, events, question } = ledger("本文", []);
    const prompt = buildChatPrompt(task, events, question);
    expect(prompt).toContain("person TaskCreated");
    expect(prompt).toContain("sacty StepsChosen");
    expect(prompt).not.toContain("QuestionAsked");
    expect(prompt).toContain("要求要件（active） → 設計（todo）");
  });
});

describe("成果の書き出し（PBI-56）", () => {
  const base = {
    id: "t1",
    title: "決済の再送",
    body: "",
    steps: [{ key: "requirements", state: "done" }],
    exports: {},
    stepPullRequests: [],
  } as unknown as Task;

  it("使える接続先を渡したときだけ、書き出し先を決めさせる（取り込み元と規約も渡す）", () => {
    const none = buildOrchestratorPrompt(base);
    expect(none).not.toContain("exports：");
    expect(none).not.toContain('"exports"');
    const prompt = buildOrchestratorPrompt(
      { ...base, ticket: { key: "PAY-1", url: "https://jira/PAY-1" } } as unknown as Task,
      {
        exports: {
          destinations: [
            { via: "platform", name: "confluence", description: "Confluence" },
            { via: "mcp", name: "docs", description: "" },
          ],
          rules: "要件は DEV に置く",
        },
      },
    );
    expect(prompt).toContain("- exports：人間が承認した成果");
    expect(prompt).toContain("取り込み元：PAY-1（https://jira/PAY-1）");
    expect(prompt).toContain("confluence（via: platform・ゲートウェイの接続先）：Confluence");
    expect(prompt).toContain("docs（via: mcp・MCP サーバー）");
    expect(prompt).toContain("要件は DEV に置く");
    expect(prompt).toContain('"exports": {"requirements": {"to": "接続先の名前"');
  });

  it("オーケストレーターの出力から、工程ごとの書き出し先を読む（工程の名前の形が正しいものだけ）", () => {
    const output = (exports: unknown) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "standard", reason: "r", exports } })}\n\`\`\``;
    expect(
      extractStepPlan(
        output({
          requirements: { to: "confluence", via: "platform", location: "DEV", reason: "規約" },
          design: { to: "", reason: "要らない" },
          nope: { to: "x", reason: "y" },
          investigate: "broken",
          integrate: { to: "docs", via: "other", reason: "?" },
        }),
      )?.exports,
    ).toEqual({
      requirements: {
        to: { via: "platform", name: "confluence", location: "DEV" },
        reason: "規約",
      },
      design: { reason: "要らない" },
      integrate: { to: { name: "docs", location: "" }, reason: "?" },
    });
    expect(extractStepPlan(output(undefined))).not.toHaveProperty("exports");
    expect(extractStepPlan(output({}))).not.toHaveProperty("exports");
    expect(extractStepPlan(output(["requirements"]))).not.toHaveProperty("exports");
  });

  it("書き出しの指示：前に書き出した先があれば更新させ、中断の後は目印で探させる", () => {
    const input = {
      via: "platform",
      name: "confluence",
      description: "",
      location: "DEV",
    } as const;
    const fresh = buildExportPrompt(base, "requirements", { ...input, interrupted: false });
    // 前の書き出しが結果を返せなかったかもしれないので、作る前に目印で探させる
    expect(fresh).toContain(
      "目印「sacty-export:t1:requirements」を含むページを探し、あればそのページを更新する（新しく作らない）。無ければ、新しいページを作る",
    );
    expect(fresh).toContain("ページの題：決済の再送：要求要件");
    const update = buildExportPrompt(base, "requirements", {
      ...input,
      previousUrl: "https://wiki/1",
      interrupted: true,
    });
    expect(update).toContain(
      "前にこの成果を書き出したページ（https://wiki/1）を、この内容で更新する",
    );
    expect(update).not.toContain("新しいページを作る");
    const resumed = buildExportPrompt(base, "requirements", { ...input, interrupted: true });
    expect(resumed).toContain("目印「sacty-export:t1:requirements」を含むページを探し");
  });

  it("書き出す内容は承認済みの版で、設計はテスト観点を含め、目印を入れる", () => {
    const task = {
      ...base,
      approved: {
        design: {
          submission: 2,
          output: "# 設計 v2",
          testViewpoints: [{ id: "TV-1", title: "再送", input: "同じキー", expected: "1回だけ" }],
          at: "x",
        },
      },
      outputs: { design: "# 下書き" },
    } as unknown as Task;
    const doc = buildExportDocument(task, "design");
    expect(doc).toContain("# 設計 v2");
    expect(doc).not.toContain("# 下書き");
    expect(doc).toContain("[TV-1] 再送");
    expect(doc).toContain("2回目の提出");
    expect(doc).toContain("目印：sacty-export:t1:design");
  });

  it("書き出しの出力から、URL（http(s) の形）か、書き出せなかった理由（長ければ切り詰める）を読む", () => {
    const output = (v: unknown) => `\`\`\`json\n${JSON.stringify({ "sacty-export": v })}\n\`\`\``;
    expect(extractExport(output({ url: "https://wiki/1", error: "" }))).toEqual({
      url: "https://wiki/1",
    });
    expect(extractExport(output({ url: "javascript:alert(1)", error: "" }))).toBeUndefined();
    expect(extractExport(output({ url: "", error: "権限が無い" }))).toEqual({
      error: "権限が無い",
    });
    const long = extractExport(output({ error: "x".repeat(1500) }));
    expect(long && "error" in long && long.error).toBe(`${"x".repeat(1000)}…`);
    expect(extractExport("書きました")).toBeUndefined();
  });

  it("PR の本文に、書き出した成果の URL を入れる。書き出していなければ入れない", () => {
    const task = {
      ...base,
      steps: [
        { key: "requirements", state: "done" },
        { key: "design", state: "done" },
        { key: "implement", state: "done" },
      ],
      approved: {},
      testMap: [],
      reproductionTests: [],
      exports: {
        requirements: { url: "https://wiki/1" },
        design: { url: "https://wiki/2" },
      },
    } as unknown as Task;
    const body = buildPullRequestBody(task);
    expect(body).toContain(
      "## 書き出した成果\n\n- 要求要件：https://wiki/1\n- 設計：https://wiki/2\n",
    );
    expect(buildPullRequestBody({ ...task, exports: {} })).not.toContain("書き出した成果");
  });

  it("チケットへの PR のコメントに、書き出した成果の URL を添える", () => {
    const task = {
      ...base,
      steps: [
        { key: "requirements", state: "done" },
        { key: "design", state: "done" },
      ],
      pullRequest: { url: "https://github.com/acme/app/pull/7" },
      exports: { requirements: { url: "https://wiki/1" } },
    } as unknown as Task;
    const body = buildTicketPullRequestComment(task);
    expect(body).toContain("sacty が PR を作りました：https://github.com/acme/app/pull/7");
    expect(body).toContain("- 要求要件：https://wiki/1");
    expect(body).not.toContain("設計：");
    expect(buildTicketPullRequestComment({ ...task, exports: {} })).toBe(
      "sacty が PR を作りました：https://github.com/acme/app/pull/7\n\n（sacty のタスク t1）",
    );
  });
});

describe("要求要件・設計の PR（PBI-57）", () => {
  const plan = (v: Record<string, unknown>) =>
    `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "standard", reason: "r", ...v } })}\n\`\`\``;

  it("オーケストレーターに、規約に置き場所があるときだけ置き場所を書かせ、使える形のものだけ読む", () => {
    const task = {
      id: "t1",
      title: "決済",
      body: "",
      steps: [],
      exports: {},
      stepPullRequests: [],
    } as unknown as Task;
    expect(buildOrchestratorPrompt(task)).not.toContain("documentsDir");
    const prompt = buildOrchestratorPrompt(task, {
      documents: { rules: "設計書は docs/adr に置く" },
    });
    expect(prompt).toContain("- documentsDir：");
    expect(prompt).toContain("既定は docs/sacty");
    expect(prompt).toContain("設計書は docs/adr に置く");
    expect(prompt).toContain('"documentsDir"');
    expect(extractStepPlan(plan({ documentsDir: "docs/adr/" }))?.documentsDir).toBe("docs/adr");
    for (const bad of ["../x", "/abs", ".GIT/hooks", "a/./b", "a b", ""]) {
      expect(extractStepPlan(plan({ documentsDir: bad }))?.documentsDir).toBeUndefined();
    }
  });

  it("設計のファイルにはテスト観点を入れ、PR の本文にはマージが承認であることと置き場所を書く", () => {
    const task = {
      id: "t1",
      title: "決済",
      outputs: { requirements: "# 要求要件", design: "# 設計" },
      testViewpoints: [{ id: "TV-1", title: "再送", input: "2回", expected: "1回" }],
      remarks: [
        {
          id: "design-1-1",
          step: "design",
          round: 1,
          text: "観点が足りない",
          response: "足した",
          voided: false,
        },
      ],
      stepPullRequests: [
        { step: "requirements", state: "merged", url: "https://github.com/acme/app/pull/7" },
      ],
    } as unknown as Task;
    expect(buildStepDocument(task, "requirements")).toBe(
      "<!-- sacty task t1 の要求要件。sacty が作成しました。 -->\n\n# 要求要件\n",
    );
    const doc = buildStepDocument(task, "design");
    expect(doc).toContain("# 設計\n\n## テスト観点\n\n- [TV-1] 再送");
    expect(buildStepPullRequestTitle(task, "design")).toBe("[設計] 決済");
    const body = buildStepPullRequestBody(task, "design", "docs/sacty/t1/design.md");
    expect(body).toContain("成果のファイル：`docs/sacty/t1/design.md`");
    expect(body).toContain("この PR をマージすると、設計を承認したことになり");
    expect(body).toContain("- 要求要件：https://github.com/acme/app/pull/7");
    expect(body).toContain("- [design-1-1] 観点が足りない\n  - 対応：足した");
  });

  it("成果物チェックの PR の指摘の判断の指示は、これまでと同じ（実装・設計・要求要件から選ぶ）", () => {
    const task = {
      id: "t1",
      approved: { requirements: { output: "# 承認済みの要求要件" } },
      outputs: {},
      testViewpoints: [],
    } as unknown as Task;
    const pr = buildReworkPrompt(task, ["x"], ["implement", "requirements"]);
    expect(pr).toContain("成果物（PR）に人間が付けた指摘");
    expect(pr).toContain("- implement（実装）：");
    const step = buildReworkPrompt(task, ["x"], ["design", "requirements"], "design");
    expect(step).toContain("設計の PR に人間が付けた指摘");
    expect(step).not.toContain("implement");
    expect(step).toContain("（設計をやり直します）");
  });
});

describe("リポジトリを指定しないタスク（PBI-73）", () => {
  const repoless = {
    title: "全体の設計",
    body: "",
    noRepo: true,
    steps: [],
    remarks: [],
    outputs: {},
  } as unknown as Task;
  const withRepo = {
    title: "直す",
    body: "https://github.com/acme/app/pull/3 を見て",
    repo: "https://github.com/acme/app",
    remarks: [],
    outputs: {},
    steps: [],
    repository: {
      url: "https://github.com/acme/app.git",
      baseBranch: "main",
      baseCommit: "abc1234",
    },
  } as unknown as Task;

  it("設計だけはリポジトリの無いタスクだけが選べ、リポジトリの無いタスクはレビューを選べない", () => {
    expect(allowedPlans(repoless)).toEqual([
      "standard",
      "skip-design",
      "investigate",
      "design-only",
      "split",
      "bugfix",
    ]);
    expect(allowedPlans(withRepo)).not.toContain("design-only");
    expect(allowedPlans(withRepo)).toContain("review");
    // 対象リポジトリを選ぶ前の版のタスク（noRepo が無い）は、今と同じ
    expect(allowedPlans({ title: "古い", body: "", steps: [] } as unknown as Task)).not.toContain(
      "design-only",
    );
  });

  it("リポジトリの無いタスクの指示は、対象とコンテキストを渡し、コードを変えるならリポジトリを書かせる", () => {
    const prompt = buildOrchestratorPrompt(repoless, {
      repoless: {
        repositories: ["https://github.com/acme/api"],
        context: "https://github.com/acme/ctx",
        rules: "# 規約",
      },
    });
    expect(prompt).toContain("このタスクには対象リポジトリがありません");
    expect(prompt).toContain("- https://github.com/acme/api");
    expect(prompt).toContain("プロジェクトのコンテキストリポジトリ：https://github.com/acme/ctx");
    expect(prompt).toContain("# 規約");
    expect(prompt).toContain('"repo": "作業するリポジトリの URL');
    // テストのコマンド・サービスは決めさせない（コードが無い）
    expect(prompt).not.toContain("testCommand");
    expect(prompt).not.toContain("services");
    // リポジトリのあるタスクは今の指示のまま
    expect(buildOrchestratorPrompt(withRepo)).not.toContain(
      "このタスクには対象リポジトリがありません",
    );
  });

  it("選んだリポジトリと理由を読む（無ければ持たない）", () => {
    const out = (v: Record<string, unknown>) =>
      `\`\`\`json\n${JSON.stringify({ "sacty-steps": { plan: "standard", reason: "r", ...v } })}\n\`\`\``;
    expect(
      extractStepPlan(out({ repo: " https://github.com/acme/api ", repoReason: "API" })),
    ).toMatchObject({ repo: "https://github.com/acme/api", repoReason: "API" });
    const none = extractStepPlan(out({ repo: "", repoReason: 3 }));
    expect(none?.repo).toBeUndefined();
    expect(none?.repoReason).toBeUndefined();
  });

  it("分割案の子タスクのリポジトリと理由を読み、分割の指示ではリポジトリの無いタスクだけ候補を渡す", () => {
    const plan = extractSplitPlan(
      `\`\`\`json\n${JSON.stringify({
        "sacty-split": {
          reason: "r",
          children: [
            { key: "A", title: "a", repo: "https://github.com/acme/api", repoReason: "API" },
            { key: "B", title: "b" },
          ],
        },
      })}\n\`\`\``,
    );
    expect(plan.ok && plan.children).toEqual([
      {
        key: "A",
        title: "a",
        body: "",
        dependsOn: [],
        repo: "https://github.com/acme/api",
        repoReason: "API",
      },
      { key: "B", title: "b", body: "", dependsOn: [] },
    ]);
    const approved = { requirements: { output: "# 要求要件" }, design: { output: "# 設計" } };
    const prompt = buildPrompt({ ...repoless, approved } as unknown as Task, "split", {
      repositories: ["https://github.com/acme/api", "https://github.com/acme/web"],
    });
    expect(prompt).toContain("    - https://github.com/acme/web");
    expect(prompt).toContain("作業領域（カレントディレクトリ）は空で、コードはありません");
    const withRepoPrompt = buildPrompt({ ...withRepo, approved } as unknown as Task, "split", {
      repositories: ["https://github.com/acme/web"],
    });
    expect(withRepoPrompt).not.toContain("acme/web");
    expect(withRepoPrompt).not.toContain('"repo"');
  });
});
