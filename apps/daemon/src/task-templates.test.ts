import { describe, expect, it } from "vitest";
import {
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

  it("ゴールに書いた答えの形を、監視が読める", () => {
    const example = /\{"sacty-deployment".*\}\}/.exec(body)?.[0] ?? "";
    expect(example).not.toBe("");
    for (const result of ["healthy", "unhealthy", "unknown"] as const) {
      const answer = example.replace("healthy | unhealthy | unknown", result);
      expect(extractDeploymentCheck(`確かめました\n\n\`\`\`json\n${answer}\n\`\`\``)).toMatchObject(
        {
          result,
          summary: "結果の要点",
        },
      );
    }
  });
});
