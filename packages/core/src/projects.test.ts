import { describe, expect, it } from "vitest";
import { parseRepoUrl, RepoUrl, targetUrlProblem } from "./github-url.js";
import { issueMessage, renderMessage } from "./messages.js";
import {
  DEFAULT_INTAKE_INTERVAL_SEC,
  DEFAULT_MEMORY_RETENTION_DAYS,
  excludedRepositories,
  exportProject,
  intakeIntervalSec,
  MAX_MEMORY_RETENTION_DAYS,
  MIN_INTAKE_INTERVAL_SEC,
  type Project,
  ProjectDefinition,
  type ProjectDefinitionInput,
  ProjectExport,
  projectConflicts,
  responsibleProject,
  responsibleTicketProject,
  SactySettings,
  targetHost,
  targetImageOf,
} from "./projects.js";

const make = (id: string, def: ProjectDefinitionInput): Project => ({
  ...ProjectDefinition.parse(def),
  id,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

const projects = [
  make("p1", { name: "決済", targets: [{ scope: "org", target: "https://github.com/acme" }] }),
  make("p2", {
    name: "認証",
    targets: [{ scope: "repo", target: "https://github.com/acme/auth" }],
  }),
];

describe("プロジェクトの対象（PBI-5・PBI-25）", () => {
  it("同じ Org・同じリポジトリは、複数のプロジェクトに登録できない（大文字・小文字は区別しない）", () => {
    const def = ProjectDefinition.parse({
      name: "新規",
      targets: [
        { scope: "org", target: "https://github.com/ACME" },
        { scope: "repo", target: "https://github.com/Acme/Auth" },
      ],
    });
    const conflicts = projectConflicts(projects, undefined, def);
    expect(conflicts).toEqual([
      {
        code: "project.targetTaken",
        params: { scope: "org", target: "https://github.com/ACME", project: "決済" },
      },
      {
        code: "project.targetTaken",
        params: { scope: "repo", target: "https://github.com/Acme/Auth", project: "認証" },
      },
    ]);
    expect(conflicts.map((m) => renderMessage(m, "ja"))).toEqual([
      "Org「https://github.com/ACME」は、プロジェクト「決済」に登録されています。",
      "リポジトリ「https://github.com/Acme/Auth」は、プロジェクト「認証」に登録されています。",
    ]);
    expect(renderMessage(conflicts[1], "en")).toBe(
      'The repository "https://github.com/Acme/Auth" is already registered in the project "認証".',
    );
    // 自分自身の登録は重複にしない
    expect(projectConflicts(projects, "p1", ProjectDefinition.parse(projects[0]))).toEqual([]);
    // Org と、その中のリポジトリを別のプロジェクトに登録するのはよい
    const narrower = ProjectDefinition.parse({
      name: "請求",
      targets: [{ scope: "repo", target: "https://github.com/acme/billing" }],
    });
    expect(projectConflicts(projects, undefined, narrower)).toEqual([]);
  });

  it("同じ定義の中での重複も拒否する", () => {
    const def = ProjectDefinition.parse({
      name: "x",
      targets: [
        { scope: "repo", target: "https://github.com/o/r" },
        { scope: "repo", target: "https://github.com/O/R" },
      ],
    });
    expect(projectConflicts([], undefined, def).map((m) => renderMessage(m, "ja"))).toEqual([
      "リポジトリ「https://github.com/O/R」が重複しています。",
    ]);
  });

  it("範囲が狭い指定（リポジトリ）が優先し、無ければ Org の指定が担当する", () => {
    expect(responsibleProject(projects, "https://github.com/acme/auth")?.project.id).toBe("p2");
    expect(responsibleProject(projects, "https://github.com/ACME/payments")).toMatchObject({
      project: { id: "p1" },
      target: { scope: "org", target: "https://github.com/acme" },
    });
    expect(responsibleProject(projects, "https://github.com/other/repo")).toBeUndefined();
  });

  it("Org の対象から除かれる、ほかのプロジェクトのリポジトリを返す", () => {
    expect(excludedRepositories(projects, "p1", "https://github.com/acme")).toEqual([
      { repo: "https://github.com/acme/auth", projectName: "認証" },
    ]);
    expect(excludedRepositories(projects, "p2", "https://github.com/acme")).toEqual([]);
    // 同じ名前の Org でも、ほかのホストなら除かない（PBI-40）
    expect(excludedRepositories(projects, "p1", "https://ghe.example.co.jp/acme")).toEqual([]);
  });

  it("対象はホストを含めた URL で書き、ホストが違えば別の対象として扱う（PBI-40）", () => {
    const def = ProjectDefinition.parse({
      name: "GHE",
      targets: [
        { scope: "repo", target: " https://GHE.example.co.jp/acme/auth.git/ " },
        { scope: "org", target: "https://ghe2.example.co.jp:8443/acme/" },
      ],
      githubAccounts: { "ghe.example.co.jp": "corp", "ghe2.example.co.jp:8443": "corp" },
    });
    // 書き方の揺れ（前後の空白・末尾の / と .git・ホストの大文字）はそろえる
    expect(def.targets).toEqual([
      { scope: "repo", target: "https://ghe.example.co.jp/acme/auth" },
      { scope: "org", target: "https://ghe2.example.co.jp:8443/acme" },
    ]);
    // github.com の同じ名前とは重複しない
    expect(projectConflicts(projects, undefined, def)).toEqual([]);
    expect(responsibleProject(projects, "https://ghe.example.co.jp/acme/auth")).toBeUndefined();
    const all = [...projects, make("p3", def)];
    expect(responsibleProject(all, "https://ghe.example.co.jp/acme/auth")?.project.id).toBe("p3");
    expect(responsibleProject(all, "https://ghe2.example.co.jp:8443/acme/x")?.project.id).toBe(
      "p3",
    );
    expect(responsibleProject(all, "https://github.com/acme/auth")?.project.id).toBe("p2");
    // 短縮表記（owner/name・Org の名前だけ）や、http・ホストの無いものは受け付けない。読めない理由を示す
    for (const [target, problem] of [
      ["acme/auth", /input\.invalidRepo/],
      ["http://github.com/acme/auth", /input\.urlNotHttps/],
      ["https://github.com/acme/auth/x", /input\.urlExtraPath/],
    ] as const) {
      expect(() =>
        ProjectDefinition.parse({ name: "x", targets: [{ scope: "repo", target }] }),
      ).toThrow(problem);
    }
    expect(() =>
      ProjectDefinition.parse({ name: "x", targets: [{ scope: "org", target: "acme" }] }),
    ).toThrow(/input\.invalidOrg/);
  });

  it("見た目では正しい URL（全角の文字・ゼロ幅の空白・クエリ）を読み、読めないものは理由を示す", () => {
    for (const url of [
      "https：／／ghe.example.co.jp／acme／app",
      "https://ghe.example.co.jp/acme/app\u200b",
      "\ufeffhttps://ghe.example.co.jp/acme/app",
      "https://ghe.example.co.jp/acme/app?tab=readme-ov-file",
      "https://ghe.example.co.jp/acme/app#readme",
    ]) {
      expect(parseRepoUrl(url)?.url).toBe("https://ghe.example.co.jp/acme/app");
      expect(targetHost({ scope: "repo", target: url })).toBe("ghe.example.co.jp");
      expect(targetUrlProblem("repo", url)).toBeUndefined();
    }
    expect(targetUrlProblem("repo", "")).toBeUndefined();
    expect(targetUrlProblem("repo", "git@ghe.example.co.jp:acme/app.git")).toBe("input.urlSsh");
    expect(targetUrlProblem("repo", "ssh://git@ghe.example.co.jp/acme/app")).toBe("input.urlSsh");
    expect(targetUrlProblem("repo", "http://ghe.example.co.jp/acme/app")).toBe("input.urlNotHttps");
    expect(targetUrlProblem("repo", "https://me@ghe.example.co.jp/acme/app")).toBe(
      "input.urlCredentials",
    );
    expect(targetUrlProblem("repo", "https://git_srv.example.co.jp/acme/app")).toBe(
      "input.urlHost",
    );
    expect(targetUrlProblem("repo", "https://ghe.example.co.jp/acme/app/tree/main")).toBe(
      "input.urlExtraPath",
    );
    expect(targetUrlProblem("repo", "https://ghe.example.co.jp/acme")).toBe(
      "input.repoLooksLikeOrg",
    );
    expect(targetUrlProblem("org", "https://ghe.example.co.jp/acme/app")).toBe(
      "input.orgLooksLikeRepo",
    );
    expect(targetUrlProblem("org", "https://ghe.example.co.jp/acme")).toBeUndefined();
    expect(() =>
      ProjectDefinition.parse({
        name: "x",
        targets: [{ scope: "repo", target: "https://ghe.example.co.jp/acme" }],
      }),
    ).toThrow(/input\.repoLooksLikeOrg/);
  });

  it("リポジトリ名は、先頭がドット・アンダースコアのもの（.github・_tools）も受け付ける（PBI-40 レビュー指摘）", () => {
    for (const host of ["github.com", "ghe.example.co.jp"]) {
      for (const name of [".github", "_tools", "a", "x.y_z-1"]) {
        const url = `https://${host}/acme/${name}`;
        expect(RepoUrl.safeParse(url).success).toBe(true);
        expect(parseRepoUrl(url)).toMatchObject({
          host,
          owner: "acme",
          name,
          path: `acme/${name}`,
        });
        // Org の対象から担当を判定できる
        const project = make("p9", {
          name: "x",
          targets: [{ scope: "org", target: `https://${host}/acme` }],
        });
        expect(responsibleProject([project], url)?.project.id).toBe("p9");
      }
      // . と .. は名前にできない。Org 名は先頭が英数字
      for (const bad of [
        `https://${host}/acme/.`,
        `https://${host}/acme/..`,
        `https://${host}/.acme/app`,
        `https://${host}/_acme/app`,
      ]) {
        expect(RepoUrl.safeParse(bad).success).toBe(false);
      }
    }
  });

  it("名前の形を検査し、取り込み元・リポジトリの設定（以前の形）は持たない", () => {
    expect(() =>
      ProjectDefinition.parse({ name: "x", targets: [{ scope: "repo", target: "acme" }] }),
    ).toThrow(/input\.invalidRepo/);
    expect(() => ProjectDefinition.parse({ name: " " })).toThrow(/input\.nameRequired/);
    const parsed = ProjectDefinition.parse({
      name: "x",
      sources: [{ scope: "org", target: "https://github.com/acme", label: "sacty" }],
      repositories: [{ repo: "https://github.com/acme/app", testCommand: "npm test" }],
    });
    expect(parsed).toEqual({ name: "x", targets: [] });
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  const full = make("p9", {
    name: "決済",
    targets: [
      { scope: "org", target: "https://github.com/acme" },
      { scope: "repo", target: "https://github.com/other/payments" },
    ],
    context: { repo: "https://example.com/ctx.git", ref: "main" },
    // 個人の設定（gh のアカウント。PBI-13）は書き出さない
    githubAccounts: { "github.com": "side-job" },
  });

  it("定義の項目だけを書き出し、ID・日時は含めない。書き出したものはそのまま読める", () => {
    const exported = exportProject(full);
    expect(exported).toEqual({
      sacty: "project",
      version: 5,
      project: {
        name: "決済",
        targets: [
          { scope: "org", target: "https://github.com/acme" },
          { scope: "repo", target: "https://github.com/other/payments" },
        ],
        context: { repo: "https://example.com/ctx.git", ref: "main" },
      },
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain("p9");
    expect(text).not.toContain("2026-10-10");
    expect(text).not.toContain("side-job");
    expect(ProjectExport.parse(JSON.parse(text))).toEqual(exported);
    // 書き出したファイルに足されていても、読まない（strict）
    expect(() =>
      ProjectExport.parse({
        ...exported,
        project: { ...exported.project, githubAccounts: { "github.com": "x" } },
      }),
    ).toThrow();
  });

  it("マージの後の監視の On・Off は持たない。以前の版の deploymentWatch は読まずに捨てる（PBI-116）", () => {
    const exported = exportProject({ ...full, deploymentWatch: true } as Project);
    expect("deploymentWatch" in exported.project).toBe(false);
    for (const old of [true, false, "yes"]) {
      const parsed = ProjectExport.parse({
        ...exported,
        project: { ...exported.project, deploymentWatch: old },
      });
      expect(parsed).toEqual(exported);
      expect("deploymentWatch" in parsed.project).toBe(false);
    }
    // 保存した定義に残っていても読まない
    const stored = ProjectDefinition.parse({ name: "acme", deploymentWatch: true });
    expect("deploymentWatch" in stored).toBe(false);
  });

  it("形式・版の違うファイルや、知らない項目（秘密情報など）は読まない", () => {
    const ok = exportProject(full);
    expect(() => ProjectExport.parse({ ...ok, sacty: "task" })).toThrow(/input\.notExportFile/);
    // 以前の版（取り込み元・リポジトリの設定）は読まない（移行の手段は設けない。PBI-25）
    expect(() => ProjectExport.parse({ ...ok, version: 1 })).toThrow(/input\.unsupportedVersion/);
    expect(() =>
      ProjectExport.parse({ ...ok, project: { ...ok.project, token: "ghp_secret" } }),
    ).toThrow();
    expect(() =>
      ProjectExport.parse({
        ...ok,
        project: {
          ...ok.project,
          targets: [{ scope: "org", target: "https://github.com/acme", token: "t" }],
        },
      }),
    ).toThrow();
  });
});

describe("Slack の通知先（PBI-38。PBI-115 で sacty の設定に移した）", () => {
  const settings = (notification: unknown) =>
    SactySettings.safeParse(notification === undefined ? {} : { notification });

  it("sacty の設定に、Slack API の形と Incoming Webhook を書け、秘密情報は名前か参照だけ", () => {
    const api = settings({
      kind: "slack-api",
      url: "https://slack-proxy-b.example.com/api/chat.postMessage",
      channel: "#sacty",
    });
    expect(api.success && api.data.notification).toEqual({
      kind: "slack-api",
      url: "https://slack-proxy-b.example.com/api/chat.postMessage",
      channel: "#sacty",
      language: "ja",
    });
    expect(
      settings({ kind: "slack-webhook", webhook: "op://Work/Slack/webhook", language: "en" })
        .success,
    ).toBe(true);
    // 書かなければ通知しない
    const none = settings(undefined);
    expect(none.success && none.data).not.toHaveProperty("notification");
    const reasons = (notification: unknown) => {
      const result = settings(notification);
      expect(result.success).toBe(false);
      return result.error?.issues.map((i) => i.message);
    };
    // 秘密情報の値（URL）をそのまま書いたら受け付けない
    expect(
      reasons({ kind: "slack-webhook", webhook: "https://hooks.slack.com/services/T/B/X" }),
    ).toContain("input.secretRef");
    expect(reasons({ kind: "slack-api", url: "not a url", channel: "#a" })).toContain(
      "input.invalidUrl",
    );
    expect(
      reasons({ kind: "slack-api", url: "https://slack.com/api/chat.postMessage", channel: " " }),
    ).toContain("input.channelRequired");
    expect(
      reasons({
        kind: "slack-api",
        url: "https://slack.com/api/chat.postMessage",
        channel: "#a",
        token: "xoxb secret",
      }),
    ).toContain("input.secretRef");
    expect(settings({ kind: "email", to: "a@example.com" }).success).toBe(false);
    expect(settings({ kind: "slack-webhook", webhook: "hook", language: "fr" }).success).toBe(
      false,
    );
  });

  it("メンション（PBI-69）：ユーザー・ユーザーグループ・@here・@channel を複数書け、種類の既定は人の出番だけ", () => {
    const parse = (mention: unknown, kind: "slack-api" | "slack-webhook" = "slack-api") =>
      settings(
        kind === "slack-api"
          ? {
              kind,
              url: "https://slack.com/api/chat.postMessage",
              channel: "#a",
              ...(mention === undefined ? {} : { mention }),
            }
          : { kind, webhook: "slack-webhook", ...(mention === undefined ? {} : { mention }) },
      );
    const both = parse({
      targets: [" U0123ABCD ", "W0456", "S0789EFGH", "@here", "@channel", "U0123ABCD"],
    });
    expect(both.success && both.data.notification?.mention).toEqual({
      // 前後の空白は落とし、重複は1つにする
      targets: ["U0123ABCD", "W0456", "S0789EFGH", "@here", "@channel"],
      kinds: ["approval", "escalation", "paused"],
    });
    // 1件だけでも、Webhook でも書ける。種類は決まった並びにそろえ、重複は1つにする
    const one = parse(
      { targets: ["@here"], kinds: ["completed", "approval", "completed"] },
      "slack-webhook",
    );
    expect(one.success && one.data.notification?.mention).toEqual({
      targets: ["@here"],
      kinds: ["approval", "completed"],
    });
    // 書かなければ、メンションしない
    const none = parse(undefined);
    expect(none.success && none.data.notification).not.toHaveProperty("mention");

    const reason = (mention: unknown) => {
      const result = parse(mention);
      expect(result.success).toBe(false);
      return result.error?.issues.map((i) => i.message);
    };
    // 名前・小文字・本文を壊す文字・Slack の書き方そのもの・here（@ なし）は受け付けず、理由を示す
    for (const bad of [
      "@alice",
      "u0123abcd",
      "U0123>",
      "U01<!channel>",
      "U01|x",
      "U01&x",
      "<@U0123ABCD>",
      "here",
      "C0123ABCD",
      "U",
      "",
    ]) {
      expect(reason({ targets: [bad] }), bad).toContain("input.slackMention");
    }
    // 相手が空・種類が空・知らない種類も、理由を示す
    expect(reason({ targets: [] })).toContain("input.slackMention");
    expect(reason({ targets: ["@here"], kinds: [] })).toContain("input.mentionKinds");
    expect(parse({ targets: ["@here"], kinds: ["merged"] }).success).toBe(false);
    expect(renderMessage({ code: "input.slackMention" }, "ja")).toContain("メンバー ID");
    expect(renderMessage({ code: "input.mentionKinds" }, "en")).toContain("at least one");
  });

  describe("プロジェクトには通知先を持たない（PBI-115）", () => {
    const old = {
      kind: "slack-api",
      url: "https://slack.com/api/chat.postMessage",
      channel: "#old",
      token: "op://Work/Slack/token",
      mention: { targets: ["U0123ABCD"] },
    };

    it("プロジェクトの定義に通知先の項目は無く、保存してあった古い通知先は読まずに捨てる（壊れたものでも）", () => {
      expect(Object.keys(ProjectDefinition.shape)).not.toContain("notification");
      for (const notification of [old, { kind: "nope" }, "broken", null]) {
        const parsed = ProjectDefinition.parse({ name: "決済", notification });
        expect(parsed).not.toHaveProperty("notification");
        expect(parsed.name).toBe("決済");
      }
    });

    it("エクスポートに通知先を含めず、通知先を書いたファイルは知らない項目として読まない", () => {
      const project = {
        ...ProjectDefinition.parse({ name: "決済", notification: old }),
        // 型の外から古い通知先が紛れ込んでも、書き出さない
        notification: old,
        id: "p",
        createdAt: "",
        updatedAt: "",
      } as Project;
      const exported = exportProject(project);
      expect(exported.version).toBe(5);
      const text = JSON.stringify(exported);
      expect(text).not.toContain("notification");
      expect(text).not.toContain("slack");
      expect(text).not.toContain("U0123ABCD");
      const result = ProjectExport.safeParse({
        ...exported,
        project: { ...exported.project, notification: { kind: "slack-webhook", webhook: "x" } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => issueMessage(i))).toContainEqual({
        code: "input.unknownKeys",
        params: { keys: "notification" },
      });
    });

    it("通知先を含んでいた版（3・4）のファイルは、通知先があってもなくても、理由を示して読まない", () => {
      const exported = exportProject({
        ...ProjectDefinition.parse({ name: "決済" }),
        id: "p",
        createdAt: "",
        updatedAt: "",
      });
      for (const version of [3, 4]) {
        for (const project of [
          { ...exported.project, notification: old },
          exported.project,
          { name: "古い" },
        ]) {
          const result = ProjectExport.safeParse({ sacty: "project", version, project });
          expect(result.success).toBe(false);
          // 画面が出すのは最初の誤りなので、版の誤りが最初に来る
          expect(result.error?.issues[0]).toMatchObject({
            path: ["version"],
            message: "input.exportVersionWithNotification",
          });
        }
      }
      expect(renderMessage({ code: "input.exportVersionWithNotification" }, "ja")).toContain(
        "Sacty の設定",
      );
      expect(renderMessage({ code: "input.exportVersionWithNotification" }, "en")).toContain(
        "Sacty settings",
      );
      // ほかの版は、これまでどおりの理由
      for (const version of [1, 2, 6, "5", "4", "3"]) {
        const result = ProjectExport.safeParse({ ...exported, version });
        expect(result.error?.issues[0]?.message, String(version)).toBe("input.unsupportedVersion");
      }
    });
  });

  it("対象で指定したイメージは、リポジトリの対象の指定が Org の対象の指定より優先する（PBI-41）", () => {
    const project = (targets: unknown[]) =>
      ({ id: "p", ...ProjectDefinition.parse({ name: "x", targets }) }) as Project;
    const both = project([
      { scope: "org", target: "https://github.com/acme", image: "java" },
      { scope: "repo", target: "https://github.com/acme/web", image: "default" },
      { scope: "repo", target: "https://github.com/acme/api" },
    ]);
    expect(targetImageOf(both, "https://github.com/acme/web")).toBe("default");
    // リポジトリの対象に指定が無ければ、Org の対象の指定
    expect(targetImageOf(both, "https://github.com/ACME/api")).toBe("java");
    expect(targetImageOf(both, "https://github.com/acme/other")).toBe("java");
    expect(targetImageOf(both, "https://github.com/else/x")).toBeUndefined();
    // 空の指定は「指定しない」
    expect(
      targetImageOf(
        project([{ scope: "repo", target: "https://github.com/a/b", image: "" }]),
        "https://github.com/a/b",
      ),
    ).toBeUndefined();
    expect(() =>
      ProjectDefinition.parse({
        name: "x",
        targets: [{ scope: "repo", target: "https://github.com/a/b", image: "Java 17" }],
      }),
    ).toThrow();
  });
});

describe("チケットの取り込み先（PBI-52）", () => {
  const payments = make("p1", {
    name: "決済",
    targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
    tickets: [
      { platform: "jira", service: "jira-server", keys: ["PAY", "BILL"] },
      { platform: "cloud", service: "jira-cloud", keys: ["PAY"] },
    ],
  });

  it("取り込み先を複数書け、キーの形と上限を確かめる", () => {
    expect(payments.tickets).toHaveLength(2);
    for (const keys of [[], ["pay"], ["1PAY"], ["PAY-1"], ["A".repeat(51)]]) {
      expect(() =>
        ProjectDefinition.parse({
          name: "x",
          tickets: [{ platform: "jira", service: "jira-server", keys }],
        }),
      ).toThrow();
    }
    expect(() =>
      ProjectDefinition.parse({
        name: "x",
        tickets: [{ platform: "jira", service: "asana", keys: ["PAY"] }],
      }),
    ).toThrow();
    expect(() =>
      ProjectDefinition.parse({
        name: "x",
        tickets: [{ platform: "a/b", service: "jira-server", keys: ["PAY"] }],
      }),
    ).toThrow();
    // 前後の空白は除く
    expect(
      ProjectDefinition.parse({
        name: "x",
        tickets: [{ platform: "jira", service: "jira-server", keys: [" PAY "] }],
      }).tickets?.[0]?.keys,
    ).toEqual(["PAY"]);
  });

  it("同じ接続先の同じキーは、1つのプロジェクトにだけ書ける（接続先が違えば別）", () => {
    const def = ProjectDefinition.parse({
      name: "請求",
      tickets: [
        { platform: "jira", service: "jira-server", keys: ["BILL", "OPS", "OPS"] },
        { platform: "other", service: "jira-server", keys: ["PAY"] },
      ],
    });
    expect(projectConflicts([payments], undefined, def).map((m) => renderMessage(m, "ja"))).toEqual(
      [expect.stringContaining("BILL"), expect.stringContaining("OPS")],
    );
    // 自分自身とは重ならない
    expect(projectConflicts([payments], "p1", ProjectDefinition.parse(payments))).toEqual([]);
  });

  it("担当のプロジェクトは、接続先とキー（番号の前）で決める", () => {
    const ops = make("p2", {
      name: "運用",
      tickets: [{ platform: "jira", service: "jira-server", keys: ["OPS"] }],
    });
    expect(responsibleTicketProject([payments, ops], "jira", "PAY-12")?.project.id).toBe("p1");
    expect(responsibleTicketProject([payments, ops], "jira", "OPS-3")?.project.id).toBe("p2");
    expect(responsibleTicketProject([payments, ops], "cloud", "PAY-1")?.source.service).toBe(
      "jira-cloud",
    );
    expect(responsibleTicketProject([payments, ops], "cloud", "OPS-3")).toBeUndefined();
    expect(responsibleTicketProject([payments, ops], "jira", "PAYX-1")).toBeUndefined();
  });

  it("取り込み先と、対象のイメージを書き出す", () => {
    const withImage = make("p3", {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments", image: "java" }],
      tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
    });
    const exported = exportProject(withImage);
    expect(exported.project).toMatchObject({
      targets: [{ scope: "repo", target: "https://github.com/acme/payments", image: "java" }],
      tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
    });
    expect(ProjectExport.parse(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
  });
});

describe("共用の compose（PBI-70）", () => {
  const base = { name: "決済", targets: [] };
  const infra = {
    name: "infra",
    repo: "https://github.com/acme/test-infra",
    file: "compose/redis.yml",
  };
  const codeOf = (input: unknown) => {
    const parsed = ProjectDefinition.safeParse({ ...base, sharedComposes: [input] });
    return parsed.success ? undefined : renderMessage(parsed.error.issues[0]?.message, "ja");
  };

  it("無い・1つ・複数を持てる。空の ref・説明は持たない", () => {
    expect(ProjectDefinition.parse(base).sharedComposes).toBeUndefined();
    expect(ProjectDefinition.parse({ ...base, sharedComposes: [] }).sharedComposes).toEqual([]);
    const parsed = ProjectDefinition.parse({
      ...base,
      sharedComposes: [
        { ...infra, ref: " main ", description: "  Redis。結合テストに要る " },
        { name: "kafka", repo: "/srv/kafka", file: "compose.yaml", ref: "", description: " " },
        { name: "ssh", repo: "git@github.com:acme/infra.git", file: "a/b.yml" },
      ],
    });
    expect(parsed.sharedComposes).toEqual([
      { ...infra, ref: "main", description: "Redis。結合テストに要る" },
      { name: "kafka", repo: "/srv/kafka", file: "compose.yaml", ref: "" },
      { name: "ssh", repo: "git@github.com:acme/infra.git", file: "a/b.yml" },
    ]);
  });

  it("名前・リポジトリ・ファイル・ref の形を確かめる", () => {
    expect(codeOf({ ...infra, name: "Infra" })).toContain("共用の compose の名前");
    expect(codeOf({ ...infra, name: "" })).toContain("共用の compose の名前");
    expect(codeOf({ ...infra, name: "a".repeat(41) })).toContain("共用の compose の名前");
    expect(codeOf({ ...infra, repo: " " })).toContain("リポジトリを入力");
    expect(codeOf({ ...infra, file: "" })).toContain("相対パス");
    expect(codeOf({ ...infra, file: "/etc/compose.yml" })).toContain("相対パス");
    expect(codeOf({ ...infra, file: "../other/compose.yml" })).toContain("相対パス");
    expect(codeOf({ ...infra, file: "compose/../../x.yml" })).toContain("相対パス");
    expect(codeOf({ ...infra, file: "$HOME/x.yml" })).toContain("相対パス");
    expect(codeOf({ ...infra, file: "-f.yml" })).toContain("相対パス");
    expect(codeOf({ ...infra, ref: "main; rm -rf /" })).toContain("ref");
    expect(codeOf({ ...infra, description: "x".repeat(1001) })).toBeDefined();
    expect(codeOf(infra)).toBeUndefined();
  });

  it("リポジトリは git の URL かローカルの絶対パス（相対パスは取得先が定まらないので使えない）", () => {
    for (const repo of [
      "https://github.com/acme/infra",
      "ssh://git@example.com/infra.git",
      "git@github.com:acme/infra.git",
      "file:///srv/infra",
      "/srv/infra",
    ]) {
      expect(codeOf({ ...infra, repo })).toBeUndefined();
    }
    for (const repo of ["infra", "./infra", "../infra", "~/infra"]) {
      expect(codeOf({ ...infra, repo })).toContain("ローカルの絶対パス");
    }
  });

  it("リポジトリの URL に認証の値を書かせない", () => {
    for (const repo of [
      "https://x-access-token:ghp_abc@github.com/acme/infra",
      "https://ghp_abc@github.com/acme/infra",
      "http://user@example.com/infra.git",
      "ssh://git:password@example.com/infra.git",
    ]) {
      expect(codeOf({ ...infra, repo })).toContain("トークンを書かないでください");
    }
    // ユーザー名だけの SSH は、パスワードを含まないので使える
    expect(codeOf({ ...infra, repo: "ssh://git@example.com/infra.git" })).toBeUndefined();
  });

  it("名前の重複は保存できない（オーケストレーターが名前で選ぶため）", () => {
    const definition = ProjectDefinition.parse({
      ...base,
      sharedComposes: [infra, { ...infra, repo: "/srv/other" }, { ...infra, name: "kafka" }],
    });
    const problems = projectConflicts([], undefined, definition);
    expect(problems.map((p) => renderMessage(p, "ja"))).toEqual([
      "共用の compose の名前「infra」が重複しています。",
    ]);
    expect(
      projectConflicts(
        [],
        undefined,
        ProjectDefinition.parse({ ...base, sharedComposes: [infra] }),
      ),
    ).toEqual([]);
  });

  it("エクスポートに含め、インポートで読める（無ければ含めない）", () => {
    const project = make("p1", {
      ...base,
      sharedComposes: [{ ...infra, ref: "main", description: "Redis" }],
    });
    const exported = exportProject(project);
    expect(exported.project.sharedComposes).toEqual([
      { ...infra, ref: "main", description: "Redis" },
    ]);
    expect(ProjectExport.parse(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
    expect(exportProject(make("p2", base)).project).not.toHaveProperty("sharedComposes");
    // 知らない項目（認証の値など）は拒否する
    expect(
      ProjectExport.safeParse({
        ...exported,
        project: { ...exported.project, sharedComposes: [{ ...infra, token: "ghp_abc" }] },
      }).success,
    ).toBe(false);
  });
});

describe("取り込みの種類ごとの間隔（PBI-100）", () => {
  it("種類ごとに間隔を持ち、設定していなければ既定の 300 秒。画面の入力（文字列）と空も受け付ける", () => {
    expect(DEFAULT_INTAKE_INTERVAL_SEC).toBe(300);
    const settings = SactySettings.parse({
      issueIntervalSec: "60",
      reviewIntervalSec: 900,
      ticketIntervalSec: " ",
    });
    expect(settings).toEqual({ issueIntervalSec: 60, reviewIntervalSec: 900 });
    expect(intakeIntervalSec(settings, "issues")).toBe(60);
    expect(intakeIntervalSec(settings, "reviews")).toBe(900);
    expect(intakeIntervalSec(settings, "tickets")).toBe(300);
    expect(intakeIntervalSec({}, "issues")).toBe(300);
  });

  it("60 秒より短い間隔・整数でない値・数でない値は、どの種類の間隔かがわかる日本語と英語の文で弾く", () => {
    const cases = [
      ["issueIntervalSec", "input.issueIntervalInvalid", "Issue", "issue"],
      ["reviewIntervalSec", "input.reviewIntervalInvalid", "PR のレビュー", "PR review"],
      ["ticketIntervalSec", "input.ticketIntervalInvalid", "チケット", "ticket"],
    ] as const;
    for (const [key, code, ja, en] of cases) {
      for (const bad of [59, "59", 0, -60, 60.5, "abc", "1e400", true]) {
        const result = SactySettings.safeParse({ [key]: bad });
        expect(result.success, `${key} ${String(bad)}`).toBe(false);
        const issue = result.error?.issues[0];
        expect(issue?.path, key).toEqual([key]);
        expect(issueMessage(issue as never), `${key} ${String(bad)}`).toEqual({ code });
      }
      expect(SactySettings.parse({ [key]: 60 })).toEqual({ [key]: 60 });
      // 文言の下限と既定値は、定数と一致する
      for (const [lang, kind] of [
        ["ja", ja],
        ["en", en],
      ] as const) {
        const text = renderMessage({ code }, lang);
        expect(text, lang).toContain(kind);
        expect(text, lang).toContain(String(MIN_INTAKE_INTERVAL_SEC));
        expect(text, lang).toContain(String(DEFAULT_INTAKE_INTERVAL_SEC));
      }
    }
  });
});

describe("メモリーを残す日数（PBI-127）", () => {
  it("1〜上限の整数。画面の入力（文字列）と空も受け付け、空は設定しない（既定の 90 日）", () => {
    expect(DEFAULT_MEMORY_RETENTION_DAYS).toBe(90);
    expect(SactySettings.parse({ memoryRetentionDays: "30" })).toEqual({ memoryRetentionDays: 30 });
    expect(SactySettings.parse({ memoryRetentionDays: 1 })).toEqual({ memoryRetentionDays: 1 });
    expect(SactySettings.parse({ memoryRetentionDays: MAX_MEMORY_RETENTION_DAYS })).toEqual({
      memoryRetentionDays: MAX_MEMORY_RETENTION_DAYS,
    });
    expect(SactySettings.parse({ memoryRetentionDays: " " })).toEqual({});
    for (const bad of [0, -1, 1.5, MAX_MEMORY_RETENTION_DAYS + 1, "abc"]) {
      const result = SactySettings.safeParse({ memoryRetentionDays: bad });
      expect(result.success, String(bad)).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["memoryRetentionDays"]);
    }
  });
});

describe("レビューのメンションの相手", () => {
  it("On（画面のチェックボックスの on も）なら true を持ち、Off なら持たない（既定は PR の作者にメンションする）", () => {
    expect(SactySettings.parse({ reviewMentionSelf: "on" })).toEqual({ reviewMentionSelf: true });
    expect(SactySettings.parse({ reviewMentionSelf: true })).toEqual({ reviewMentionSelf: true });
    expect(SactySettings.parse({ reviewMentionSelf: false })).toEqual({});
    expect(SactySettings.parse({})).toEqual({});
  });
});
