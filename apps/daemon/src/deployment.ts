import { posix } from "node:path";
import {
  type CiFailure,
  type DaemonText,
  type DeploymentWatch,
  message,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
  type Task,
} from "@sacty/core";
import { headedObject, lastJsonAnswer } from "./agent-json.js";
import { errorText } from "./errors.js";
import type { RepositoryWorkspace } from "./repository.js";

/**
 * デプロイの確認のスキル（PBI-89）。原本は .agents、.claude は原本へのシンボリックリンクの想定。この順に探し、先に
 * 使えたものを使う。
 */
export const DEPLOYMENT_SKILL_PATHS = [
  ".agents/skills/deployment-observer/SKILL.md",
  ".claude/skills/deployment-observer/SKILL.md",
] as const;

/** シンボリックリンクをたどる回数の上限。 */
const MAX_LINK_HOPS = 8;

/**
 * リポジトリの中のパスの、途中のシンボリックリンクをたどった先（PBI-89）。リポジトリの外を指す（絶対パス・根より上）か、
 * たどりすぎたら outside。
 */
export async function resolveInRepository(
  readLink: (path: string) => Promise<string | undefined>,
  path: string,
): Promise<{ path: string } | { outside: true }> {
  let current = path;
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const parts = current.split("/");
    let linked: string | undefined;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const target = await readLink(prefix);
      if (target === undefined) continue;
      if (target.startsWith("/") || target.includes("\0")) return { outside: true };
      const resolved = posix.normalize(posix.join(posix.dirname(prefix), target));
      if (resolved === ".." || resolved.startsWith("../") || resolved === ".") {
        return { outside: true };
      }
      linked = [resolved, ...parts.slice(i)].join("/");
      break;
    }
    if (linked === undefined) return { path: current };
    current = linked;
  }
  return { outside: true };
}

/**
 * マージのコミットの、デプロイの確認のスキル（PBI-89）。見つかれば、たどった先のパス（リポジトリの根から）。無ければ
 * 理由（リンクが外を指す・読めない。どれも無ければ skillMissing）。コミットは取得済みであること。
 */
export async function findDeploymentSkill(
  repos: Pick<RepositoryWorkspace, "readFile" | "readLink">,
  gitDir: string,
  commit: string,
): Promise<{ path: string } | { problem: DaemonText }> {
  let problem: DaemonText | undefined;
  for (const candidate of DEPLOYMENT_SKILL_PATHS) {
    const resolved = await resolveInRepository((p) => repos.readLink(gitDir, commit, p), candidate);
    if ("outside" in resolved) {
      problem ??= message("deploy.skillOutside", { path: candidate });
      continue;
    }
    try {
      const content = await repos.readFile(gitDir, commit, resolved.path);
      if (content !== undefined) return { path: resolved.path };
    } catch (error) {
      problem ??= message("deploy.skillUnreadable", { path: candidate, detail: errorText(error) });
    }
  }
  return { problem: problem ?? message("deploy.skillMissing") };
}

/** リポジトリの URL を、目印に使う形にそろえる（大文字・小文字、末尾の / と .git）。 */
function repoKey(repo: string): string {
  return repo
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

/** CI/CD の失敗の目印（PBI-89）。リポジトリと、失敗したワークフロー・ジョブの名前の組。 */
export function ciFingerprint(repo: string, failures: readonly CiFailure[]): string {
  const names = [
    ...new Set(failures.map((f) => (f.job ? `${f.workflow} / ${f.job}` : f.workflow))),
  ].sort();
  return `ci|${repoKey(repo)}|${names.join("|")}`;
}

/** デプロイの確認の失敗の目印（PBI-89）。リポジトリごと。 */
export function deploymentFingerprint(repo: string): string {
  return `deployment|${repoKey(repo)}`;
}

/** 本文の中の抜粋を囲む、抜粋の中に無い長さのバッククォート。 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function originLines(task: Task, watch: DeploymentWatch): string[] {
  const commit = watch.commit ?? "";
  const pr = task.pullRequest?.url ?? `#${watch.number}`;
  return [
    `- 元のタスク：${task.title}（sacty のタスク ${task.id}）`,
    `- マージした PR：${pr}`,
    `- リポジトリ：${watch.repo}（ベースブランチ ${watch.branch}）`,
    `- マージのコミット：${commit}（${watch.repo.replace(/\/+$/, "")}/commit/${commit}）`,
  ];
}

/**
 * CI/CD の失敗の、修正のタスクの題と本文（PBI-89）。失敗したワークフロー・ジョブ・実行へのリンクと、ログの抜粋（伏せた後）。
 * 本文が TASK_BODY_MAX に収まるよう、抜粋を末尾から切り詰める。
 */
export function buildCiFixTask(
  task: Task,
  watch: DeploymentWatch,
  failures: readonly CiFailure[],
): { title: string; body: string } {
  const names = failures.map((f) => (f.job ? `${f.workflow} / ${f.job}` : f.workflow));
  const title = clip(
    `CI/CD の失敗を直す：${[...new Set(names)].join("、") || "CI/CD"}（${(watch.commit ?? "").slice(0, 7)}）`,
    TASK_TITLE_MAX,
  );
  const head = [
    "sacty が、マージの後の監視で CI/CD の失敗を見つけました。失敗の原因を調べて直してください。",
    "",
    ...originLines(task, watch),
    "",
    "## 失敗したワークフロー・ジョブ",
  ];
  const section = (f: CiFailure, excerpt: string | undefined) => {
    const lines = [
      "",
      `### ${f.job ? `${f.workflow} / ${f.job}` : f.workflow}（${f.conclusion}）`,
      "",
      `- 実行：${f.url ?? "（リンクなし）"}`,
    ];
    if (excerpt) {
      const fence = fenceFor(excerpt);
      lines.push("", "ログの末尾（秘密情報は伏せています）：", "", `${fence}text`, excerpt, fence);
    }
    return lines.join("\n");
  };
  const fixed = [head.join("\n"), ...failures.map((f) => section(f, undefined))].join("\n");
  const withExcerpts = failures.filter((f) => f.excerpt).length;
  // 抜粋の囲みと見出しのぶんを残して、抜粋に使える長さを等しく分ける
  const room = Math.max(
    200,
    Math.floor((TASK_BODY_MAX - fixed.length - withExcerpts * 80) / Math.max(1, withExcerpts)),
  );
  const body = [
    head.join("\n"),
    ...failures.map((f) =>
      section(
        f,
        f.excerpt && f.excerpt.length > room ? `…${f.excerpt.slice(-(room - 1))}` : f.excerpt,
      ),
    ),
  ].join("\n");
  return { title, body: clip(body, TASK_BODY_MAX) };
}

/** デプロイ後のアプリの確認の失敗の、修正のタスクの題と本文（PBI-89）。結果の要点と根拠を入れる。 */
export function buildDeploymentFixTask(
  task: Task,
  watch: DeploymentWatch,
): { title: string; body: string } {
  const check = watch.check;
  const title = clip(
    `デプロイ後のアプリのエラーを直す（${(watch.commit ?? "").slice(0, 7)}）`,
    TASK_TITLE_MAX,
  );
  const body = [
    "sacty が、マージの後のデプロイの確認で、デプロイ後のアプリのエラーを見つけました。原因を調べて直してください。",
    "",
    ...originLines(task, watch),
    `- 確認に使ったスキル：${check?.skill ?? ""}`,
    "",
    "## 確認の結果",
    "",
    check?.summary ?? "（要点なし）",
    "",
    "## 根拠",
    "",
    ...(check?.evidence?.length ? check.evidence.map((e) => `- ${e}`) : ["（根拠なし）"]),
  ].join("\n");
  return { title, body: clip(body, TASK_BODY_MAX) };
}

/** デプロイの確認のエージェントの答えの見出し（PBI-89）。 */
export const DEPLOYMENT_HEADING = "sacty-deployment";

/**
 * デプロイの確認の指示（PBI-89）。マージのコミットのコードの写しを作業領域にし、スキルに従って、デプロイの完了と
 * デプロイ後のアプリの状態を確かめさせる（変更はさせない）。
 */
export function buildDeploymentPrompt(task: Task, watch: DeploymentWatch, skill: string): string {
  return [
    "あなたは sacty のデプロイの確認のエージェントです。sacty のタスクの実装の PR がマージされ、マージのコミットの CI/CD が通りました。",
    "リポジトリのスキル deployment-observer に従って、デプロイが終わったかと、デプロイ後のアプリが正しく動いているかを確かめてください。",
    "",
    `- スキル：作業領域（カレントディレクトリ）の ${skill}。最初に読み、その手順に従う。何をデプロイの完了とみなすかもスキルに従う`,
    `- リポジトリ：${watch.repo}（ベースブランチ ${watch.branch}）`,
    `- マージのコミット：${watch.commit ?? ""}`,
    `- マージした PR：${task.pullRequest?.url ?? `#${watch.number}`}（タスクの題：${task.title}）`,
    "- 作業領域は、マージのコミットのコードの使い捨ての写しです",
    "- 確かめるだけにする。コード・リポジトリ・アプリ・データ・設定を変更しない。デプロイのやり直しやロールバックもしない",
    "- 秘密情報（API キー・トークン・パスワードなど）は出力に書かない",
    "- デプロイがまだ終わらない・確かめる手段が無いなど、判断できないときは unknown にし、理由を summary に書く",
    "",
    "最後に、次の形式で必ず出してください（result は healthy：正しく動いている、unhealthy：エラーになっている、unknown：判断できない）。",
    "```json",
    `{"${DEPLOYMENT_HEADING}": {"result": "healthy | unhealthy | unknown", "summary": "結果の要点", "evidence": ["根拠（確かめたこと・見たログやレスポンスの要点）"]}}`,
    "```",
  ].join("\n");
}

const SUMMARY_MAX = 4_000;
const EVIDENCE_MAX = 2_000;
const EVIDENCE_ITEMS = 20;

/**
 * デプロイの確認のエージェントの答えを読む（PBI-89）。秘密情報は、呼び出し側が出力の全文から取り除いている（切り詰める
 * のは、その後）。読めなければ undefined。
 */
export function extractDeploymentCheck(
  output: string,
):
  | { result: "healthy" | "unhealthy" | "unknown"; summary?: string; evidence: string[] }
  | undefined {
  return lastJsonAnswer(output, (value) => {
    const v = headedObject(value, DEPLOYMENT_HEADING);
    if (!v) return undefined;
    const result = typeof v.result === "string" ? v.result.trim() : "";
    if (result !== "healthy" && result !== "unhealthy" && result !== "unknown") return undefined;
    const summary = typeof v.summary === "string" ? v.summary.trim() : "";
    const evidence = Array.isArray(v.evidence)
      ? v.evidence
          .filter((e): e is string => typeof e === "string" && e.trim() !== "")
          .slice(0, EVIDENCE_ITEMS)
          .map((e) => clip(e.trim(), EVIDENCE_MAX))
      : [];
    return {
      result: result as "healthy" | "unhealthy" | "unknown",
      ...(summary ? { summary: clip(summary, SUMMARY_MAX) } : {}),
      evidence,
    };
  })?.value;
}
