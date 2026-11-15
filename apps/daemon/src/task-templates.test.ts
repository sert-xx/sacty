import { posix } from "node:path";
import { TASK_BODY_MAX } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  CI_REFERENCE,
  DEPLOYMENT_SKILL_PATHS,
  extractDeploymentCheck,
  resolveInRepository,
} from "./deployment.js";
import { DOCS_SKILLS, DOCS_STATUS, templateTask } from "./task-templates.js";

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

describe("「ドキュメント構築」のゴール", () => {
  const { title, body } = templateTask("docs-setup", "https://github.com/acme/api");

  it("題にリポジトリの短い名前を出し、説明の行の末尾に URL を置く", () => {
    expect(title).toBe("ドキュメント構築（acme/api）");
    expect(body).toContain("- 対象のリポジトリ：https://github.com/acme/api\n");
  });

  it("参照する・直すスキルを、デプロイの確認のスキルと同じ置き場所の規則で作らせる", () => {
    const [original] = DEPLOYMENT_SKILL_PATHS;
    const originalDir = posix.dirname(posix.dirname(original));
    for (const name of Object.values(DOCS_SKILLS)) {
      const placed = new RegExp(
        `原本を \`${originalDir}/${name}/SKILL\\.md\` に置き、Claude Code 用の \`([^\`]+)\` は、原本のディレクトリへの相対のシンボリックリンク（\`([^\`]+)\`）`,
      ).exec(body);
      expect(placed).not.toBeNull();
      const [, link, target] = placed ?? [];
      expect(`${link}/SKILL.md`).toBe(
        DEPLOYMENT_SKILL_PATHS[1].replace("deployment-observer", name),
      );
      // リンクをたどると、原本のディレクトリに着く
      expect(posix.join(posix.dirname(link ?? ""), target ?? "")).toBe(`${originalDir}/${name}`);
    }
  });

  it("既存のドキュメントを棚卸しして活かし、書き直させない", () => {
    expect(body).toContain("既存のドキュメントを棚卸しする");
    expect(body).toContain("既存のドキュメントは消さない・動かさない・書き直さない");
    expect(body).toContain("置き場所・形・言語が既に決まっていれば、それに従う");
  });

  it("全体の構成と主な処理の流れに図を添えさせ、前提を知らない読み手が読める組み立てにさせる", () => {
    // 文章では読み取りにくい関係（依存の向き・処理が通る順）は、図でも示させる
    expect(body).toContain(
      "- 全体の構成：主なディレクトリ・モジュールの責務と、依存の向き（どこからどこを呼んでよいか）。依存の向きは、図でも示す\n",
    );
    expect(body).toContain(
      "- 主な処理の流れ（リクエスト・ジョブ・イベントなどが、どのモジュールを通るか）。通る順と分かれ道は、図でも示す\n",
    );
    // 図は関係にだけ使い、形式は既存の図に合わせる。無ければ、テキストで書ける形式（特定の道具に決めない）
    expect(body).toContain(
      "図は、文章では読み取りにくい関係（依存の向き・処理が通る順・状態の移り方）にだけ使い、1つの図で言うことを1つにする",
    );
    expect(body).toContain(
      "形式は、リポジトリの既存のドキュメントの図に合わせる。無ければ、Markdown の中にテキストで書ける形式（Mermaid など）にする",
    );
    expect(body).toContain("図の前に何の図かを1文で書き、図に書いたことは本文にも書く");
    // 読み手は前提を知らないので、最初に何のドキュメントかを書かせ、用語の対応を書かせる
    expect(body).toContain(
      "最初に、何について書いたものか・どの作業の前に読むかを書き、節の最初に、その節の要点を1〜2文で書く",
    );
    expect(body).toContain("コードの名前とドメインの用語は、最初に出る所で対応を書く");
    // 細かい決まりは既定のスキル writing に任せ、リポジトリの決まりを優先させる
    expect(body).toContain(
      "既定のスキル `writing`（後から読まれる文書・図と画像の決まり）があれば、それに従う。リポジトリの文章の決まりがあれば、そちらを優先する",
    );
    // 直すスキルにも、図を直すことと、書き方の約束を書かせる
    expect(body).toContain("（図にした構成・流れが変わったら、図も直す）");
    expect(body).toContain(
      "上の「書き方の約束」（状態・対応するコードの場所・推測しない・`（未確認）`・最初に書くこと・図の扱い）",
    );
    // 説明は、タスクの説明の上限に収まる（切り詰められない）
    expect(body.length).toBeLessThan(TASK_BODY_MAX);
    expect(body.endsWith("要るものは、名前と入手の仕方だけを書く。")).toBe(true);
  });

  it("レビューの負担を抑えるため、最初の PR を絞り、状態と確かめてほしいことを書かせる", () => {
    expect(body).toContain(`\`${DOCS_STATUS.draft}\``);
    expect(body).toContain(
      `状態を \`${DOCS_STATUS.reviewed}\` にするのは、人が中身を確かめたと言ったときだけ`,
    );
    expect(body).toContain(
      "最初の PR は、棚卸しの結果・入口・全体の構成のドキュメント・2つのスキル",
    );
    expect(body).toContain("質問の形で");
    expect(body).toContain("`（未確認）`");
    // 整っていれば PR を作らない・コードは変えない
    expect(body).toContain("PR を作らずに、調査だけ（工程の組み合わせは investigate）で終える");
    expect(body).toContain("コードは変えない");
  });
});
