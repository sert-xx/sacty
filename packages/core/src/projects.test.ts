import { describe, expect, it } from "vitest";
import { parseRepoUrl, RepoUrl } from "./github-url.js";
import { issueMessage, renderMessage } from "./messages.js";
import {
  DEFAULT_INTAKE_INTERVAL_SEC,
  excludedRepositories,
  exportProject,
  intakeIntervalSec,
  MIN_INTAKE_INTERVAL_SEC,
  type Project,
  ProjectDefinition,
  type ProjectDefinitionInput,
  ProjectExport,
  projectConflicts,
  responsibleProject,
  responsibleTicketProject,
  SactySettings,
  SactySettingsUpdate,
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
    // 短縮表記（owner/name・Org の名前だけ）や、http・ホストの無いものは受け付けない
    for (const target of [
      "acme/auth",
      "http://github.com/acme/auth",
      "https://github.com/acme/auth/x",
    ]) {
      expect(() =>
        ProjectDefinition.parse({ name: "x", targets: [{ scope: "repo", target }] }),
      ).toThrow(/input\.invalidRepo/);
    }
    expect(() =>
      ProjectDefinition.parse({ name: "x", targets: [{ scope: "org", target: "acme" }] }),
    ).toThrow(/input\.invalidOrg/);
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
      version: 3,
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

  it("マージの後の監視（PBI-89）は、On のときだけ書き出し、読める", () => {
    const on = exportProject({ ...full, deploymentWatch: true });
    expect(on.project.deploymentWatch).toBe(true);
    expect(ProjectExport.parse(JSON.parse(JSON.stringify(on)))).toEqual(on);
    expect("deploymentWatch" in exportProject({ ...full, deploymentWatch: false }).project).toBe(
      false,
    );
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

describe("通知先（PBI-38）", () => {
  it("Slack API の形と Incoming Webhook を受け付け、秘密情報は名前か参照だけ。エクスポートにも含める", () => {
    const api = ProjectDefinition.parse({
      name: "決済",
      notification: {
        kind: "slack-api",
        url: "https://slack-proxy-b.example.com/api/chat.postMessage",
        channel: "#sacty",
      },
    });
    expect(api.notification).toEqual({
      kind: "slack-api",
      url: "https://slack-proxy-b.example.com/api/chat.postMessage",
      channel: "#sacty",
      language: "ja",
    });
    expect(
      ProjectDefinition.safeParse({
        name: "x",
        notification: { kind: "slack-webhook", webhook: "op://Work/Slack/webhook", language: "en" },
      }).success,
    ).toBe(true);
    // 秘密情報の値（URL）をそのまま書いたら受け付けない
    expect(
      ProjectDefinition.safeParse({
        name: "x",
        notification: { kind: "slack-webhook", webhook: "https://hooks.slack.com/services/T/B/X" },
      }).success,
    ).toBe(false);
    expect(
      ProjectDefinition.safeParse({
        name: "x",
        notification: { kind: "slack-api", url: "not a url", channel: "#a" },
      }).success,
    ).toBe(false);
    const exported = exportProject({ ...api, targets: [], id: "p", createdAt: "", updatedAt: "" });
    expect(exported.project.notification).toEqual(api.notification);
    expect(ProjectExport.parse(exported).project.notification).toEqual(api.notification);
  });

  it("メンション（PBI-69）：ユーザー・ユーザーグループ・@here・@channel を複数書け、種類の既定は人の出番だけ", () => {
    const parse = (mention: unknown, kind: "slack-api" | "slack-webhook" = "slack-api") =>
      ProjectDefinition.safeParse({
        name: "x",
        notification:
          kind === "slack-api"
            ? {
                kind,
                url: "https://slack.com/api/chat.postMessage",
                channel: "#a",
                ...(mention === undefined ? {} : { mention }),
              }
            : { kind, webhook: "slack-webhook", ...(mention === undefined ? {} : { mention }) },
      });
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
    // 書かなければ、これまでどおりメンションしない
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

  it("メンションはエクスポート・インポートで引き継ぎ、メンションの無い過去の設定・エクスポートもそのまま読める（PBI-69）", () => {
    const def = ProjectDefinition.parse({
      name: "決済",
      notification: {
        kind: "slack-webhook",
        webhook: "op://Work/Slack/webhook",
        mention: { targets: ["S0789EFGH", "U0123ABCD"], kinds: ["completed"] },
      },
    });
    const exported = exportProject({ ...def, id: "p", createdAt: "", updatedAt: "" });
    const imported = ProjectExport.parse(JSON.parse(JSON.stringify(exported))).project;
    expect(imported.notification).toEqual(def.notification);
    expect(ProjectDefinition.parse(imported).notification?.mention).toEqual({
      targets: ["S0789EFGH", "U0123ABCD"],
      kinds: ["completed"],
    });
    // 保存した設定を読み直しても変わらない
    expect(ProjectDefinition.parse(JSON.parse(JSON.stringify(def)))).toEqual(def);

    // 過去の版のエクスポート（メンションの無い通知先）は、そのまま読める
    const old = ProjectExport.parse({
      sacty: "project",
      version: 3,
      project: {
        name: "古い",
        notification: {
          kind: "slack-api",
          url: "https://slack.com/api/chat.postMessage",
          channel: "#a",
        },
      },
    });
    expect(old.project.notification).toEqual({
      kind: "slack-api",
      url: "https://slack.com/api/chat.postMessage",
      channel: "#a",
      language: "ja",
    });
    // インポートでも、メンションの形が違えば受け付けない
    expect(
      ProjectExport.safeParse({
        ...exported,
        project: {
          ...exported.project,
          notification: { ...exported.project.notification, mention: { targets: ["<!everyone>"] } },
        },
      }).success,
    ).toBe(false);
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
        const result = SactySettingsUpdate.safeParse({ [key]: bad });
        expect(result.success, `${key} ${String(bad)}`).toBe(false);
        const issue = result.error?.issues[0];
        expect(issue?.path, key).toEqual([key]);
        expect(issueMessage(issue as never), `${key} ${String(bad)}`).toEqual({ code });
      }
      expect(SactySettingsUpdate.parse({ [key]: 60 })).toEqual({ [key]: 60 });
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
