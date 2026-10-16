import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CI_REFERENCE,
  DEPLOYMENT_SKILL_PATHS,
  extractDeploymentCheck,
  resolveInRepository,
} from "./deployment.js";
import { templateTask } from "./task-templates.js";

describe("「Sacty セットアップ」のゴールと、マージの後の監視（PBI-89）の食い違い（PBI-90）", () => {
  const { body } = templateTask("sacty-setup", "https://github.com/acme/api");

  it("ゴールのとおりに置いたスキルを、監視が原本として見つける", async () => {
    const placed =
      /原本を `([^`]+)` に置き、Claude Code 用の `([^`]+)` は、原本のディレクトリへの相対のシンボリックリンク（`([^`]+)`）/.exec(
        body,
      );
    expect(placed).not.toBeNull();
    const [, original, link, target] = placed ?? [];
    expect(original).toBe(DEPLOYMENT_SKILL_PATHS[0]);
    expect(`${link}/SKILL.md`).toBe(DEPLOYMENT_SKILL_PATHS[1]);
    // Claude Code 用のリンクをたどると、原本に着く（リポジトリの外を指さない）
    const readLink = async (p: string) => (p === link ? target : undefined);
    expect(await resolveInRepository(readLink, DEPLOYMENT_SKILL_PATHS[1])).toEqual({
      path: DEPLOYMENT_SKILL_PATHS[0],
    });
  });

  it("ゴールに書いた答えの形を、監視が読める（CI/CD・デプロイの確認それぞれの結果。PBI-116）", () => {
    const example = /\{"sacty-deployment".*\}\}/.exec(body)?.[0] ?? "";
    expect(example).not.toBe("");
    const cases = [
      ["passed", "healthy", "healthy"],
      ["passed", "skipped", "healthy"],
      ["failed", "skipped", "unhealthy"],
      ["passed", "unhealthy", "unhealthy"],
      ["unknown", "healthy", "unknown"],
      ["skipped", "skipped", "healthy"],
    ] as const;
    for (const [ci, deployment, result] of cases) {
      const answer = example
        .replace("passed | failed | skipped | unknown", ci)
        .replace("healthy | unhealthy | skipped | unknown", deployment);
      expect(extractDeploymentCheck(`確かめました\n\n\`\`\`json\n${answer}\n\`\`\``)).toMatchObject(
        {
          result,
          ci: { result: ci },
          deployment: { result: deployment },
          summary: "結果の要点",
        },
      );
    }
  });

  it("CI/CD のあるリポジトリではデプロイしていなくてもスキルを作り、CI/CD の reference と、デプロイの確認を飛ばす書き方を指示する（PBI-116）", () => {
    expect(body).toContain("CI/CD のあるリポジトリだけ。デプロイしていなくても作る");
    expect(body).toContain(`\`${posix.dirname(DEPLOYMENT_SKILL_PATHS[0])}/${CI_REFERENCE}\``);
    expect(body).toContain("CI/CD の確認の仕方の reference");
    expect(body).toMatch(
      /デプロイしていないリポジトリでは、本文に、デプロイしていないのでデプロイの確認を飛ばす（deployment の result を skipped/,
    );
    expect(body).toContain("CI/CD が無ければスキルを作らず");
    // 待つのは sacty（エージェントに際限なく待たせない）
    expect(body).toContain("CI/CD やデプロイが終わるのを長く待たない");
  });
});
