import { describe, expect, it } from "vitest";
import { githubAccountChoices } from "./github-accounts";

const accounts = [
  { host: "github.com", login: "me", active: true },
  { host: "github.com", login: "side", active: false },
  { host: "ghe.example.com", login: "corp", active: true },
];

describe("プロジェクトの GitHub アカウントを選ぶホスト（PBI-40）", () => {
  it("対象が GHE、コンテキストが github.com なら、github.com のアカウントも選べて、保存に含める（レビュー指摘）", () => {
    const choices = githubAccountChoices({
      targets: [{ scope: "repo", target: "https://ghe.example.com/acme/app" }],
      contextRepo: "https://github.com/acme/private-context.git",
      chosen: {},
      accounts,
    });
    expect(choices.hosts).toEqual([
      { host: "ghe.example.com", required: true, forContext: false },
      { host: "github.com", required: false, forContext: true },
    ]);
    // まだ選んでいなければ、そのホストのアクティブなアカウント
    expect(choices.githubAccounts).toEqual({ "ghe.example.com": "corp", "github.com": "me" });
    expect(choices.missing).toBe(false);
  });

  it("保存済みのアカウントは、対象・コンテキストのホストでなくても消さない。選ばない（空）にすれば保存から外す", () => {
    const saved = { "ghe.example.com": "corp", "github.com": "side" };
    const kept = githubAccountChoices({
      targets: [{ scope: "repo", target: "https://ghe.example.com/acme/app" }],
      contextRepo: "",
      chosen: saved,
      accounts,
    });
    expect(kept.githubAccounts).toEqual(saved);
    expect(kept.hosts.find((h) => h.host === "github.com")).toEqual({
      host: "github.com",
      required: false,
      forContext: false,
    });
    const dropped = githubAccountChoices({
      targets: [{ scope: "repo", target: "https://ghe.example.com/acme/app" }],
      contextRepo: "https://github.com/acme/private-context",
      chosen: { ...saved, "github.com": "" },
      accounts,
    });
    expect(dropped.githubAccounts).toEqual({ "ghe.example.com": "corp" });
  });

  it("対象のホストのアカウントが無ければ、選ぶまで保存させない。SSH・ローカルのコンテキストはホストに数えない", () => {
    const choices = githubAccountChoices({
      targets: [{ scope: "org", target: "https://ghe2.example.com/acme" }],
      contextRepo: "git@github.com:acme/ctx.git",
      chosen: {},
      accounts,
    });
    expect(choices.hosts.map((h) => h.host)).toEqual(["ghe2.example.com"]);
    expect(choices.missing).toBe(true);
  });
});
