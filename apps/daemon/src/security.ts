import {
  canRequestSecurityFix,
  SECURITY_SEVERITIES,
  SecurityCategory,
  type SecurityFinding,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
  type Task,
  taskPlan,
} from "@sacty/core";
import { headedObject, lastJsonAnswer } from "./agent-json.js";
import type { FileChange } from "./repository.js";
import { looksLikeTestFile } from "./test-files.js";

/** セキュリティチェックの指摘の一覧の見出し（レポートの本文の後に出させる JSON）。 */
export const SECURITY_FINDINGS_HEADING = "sacty-security-findings";
/** セキュリティ対応の、修正の範囲の宣言の見出し（前段の調査の後に出させる JSON）。 */
export const SECURITY_SCOPE_HEADING = "sacty-security-scope";
/** セキュリティ対応の最終レビューで、ゴールガーディアンだけが判定する観点（差分が最小限か）。 */
export const MINIMAL_CHANGE_VIEWPOINT = "SEC-MIN";
/**
 * セキュリティ対応で、変えてよい行の数（追加と削除の合計。ロックファイルは数えない）。超えたら、sacty が観点 SEC-MIN を
 * 不合格にする（最小限の変更でなければレビューに時間がかかり、問題の修正が遅れるため）。
 */
export const SECURITY_FIX_MAX_CHANGED_LINES = 300;

/** 区分の名前（指示・対応のタスクの題に出す）。 */
export const SECURITY_CATEGORY_NAME: Record<SecurityCategory, string> = {
  dependency: "依存の脆弱性",
  "supply-chain": "サプライチェーン",
  code: "コードの脆弱性",
  secret: "秘密情報の混入",
  config: "設定・IaC",
};

/**
 * 依存を固定するロックファイルの名前。変更した行の数に数えない（依存を1つ上げるだけでも大きく変わるため）。中身が範囲の
 * パッケージだけかは、ゴールガーディアンが観点 SEC-MIN で確かめる。
 */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "pdm.lock",
  "Gemfile.lock",
  "composer.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "Package.resolved",
]);

/** セキュリティ対応の、修正の範囲の宣言（前段の調査の申告）。 */
export type SecurityScope = {
  /** 変えてよいファイル（リポジトリのルートからのパス。末尾が / ならその下、* は / を除く任意の文字）。 */
  paths: string[];
  /** 版を変える依存（名前・今の版・上げる先の版）。 */
  packages: { name: string; from: string; to: string }[];
  /** 問題が解消したことを確かめるコマンド（検査の道具の再実行など。無ければ回帰のテストで確かめる）。 */
  verification: string;
  reason: string;
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const texts = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

/** セキュリティ対応（security-fix）のタスクか。 */
export function isSecurityFix(task: Task): boolean {
  return taskPlan(task) === "security-fix";
}

/**
 * レポートの出力から、指摘の一覧（見出し sacty-security-findings の JSON。最後のもの）を読む。区分か題の無い指摘は除く。
 * 一覧が無い・読めなければ undefined。
 */
export function extractSecurityFindings(output: string): SecurityFinding[] | undefined {
  const found = lastJsonAnswer(output, (value) => {
    const v = headedObject(value, SECURITY_FINDINGS_HEADING);
    return v && Array.isArray(v.findings) ? v.findings : undefined;
  });
  if (!found) return undefined;
  const findings: SecurityFinding[] = [];
  for (const [index, raw] of found.value.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const category = SecurityCategory.safeParse(r.category);
    const title = text(r.title);
    if (!category.success || !title) continue;
    const severity = SECURITY_SEVERITIES.find((s) => s === text(r.severity)) ?? "medium";
    findings.push({
      id: text(r.id) || `SF-${index + 1}`,
      category: category.data,
      severity,
      title,
      refs: texts(r.refs),
      location: text(r.location),
      fix: text(r.fix),
    });
  }
  return findings;
}

/** 前段の調査の出力から、修正の範囲の宣言（見出し sacty-security-scope の JSON。最後のもの）を読む。 */
export function extractSecurityScope(output: string): SecurityScope | undefined {
  const found = lastJsonAnswer(output, (value) => {
    const v = headedObject(value, SECURITY_SCOPE_HEADING);
    if (!v) return undefined;
    const paths = texts(v.paths).map((p) => p.replace(/^\.\//, ""));
    if (paths.length === 0) return undefined;
    const packages = Array.isArray(v.packages)
      ? v.packages.flatMap((p) => {
          if (!p || typeof p !== "object") return [];
          const r = p as Record<string, unknown>;
          const name = text(r.name);
          return name ? [{ name, from: text(r.from), to: text(r.to) }] : [];
        })
      : [];
    return { paths, packages, verification: text(v.verification), reason: text(v.reason) };
  });
  return found?.value;
}

/** セキュリティ対応のタスクの、前段の調査が宣言した修正の範囲。宣言が無い・読めなければ undefined。 */
export function securityScope(task: Task): SecurityScope | undefined {
  if (!isSecurityFix(task)) return undefined;
  const output = task.approved.investigate?.output;
  return output ? extractSecurityScope(output) : undefined;
}

/** 承認したセキュリティチェックのレポートの指摘。レポートが承認されていない・一覧を読めなければ undefined。 */
export function securityFindings(task: Task): SecurityFinding[] | undefined {
  if (!canRequestSecurityFix(task)) return undefined;
  const output = task.approved.investigate?.output;
  return output ? extractSecurityFindings(output) : undefined;
}

/** パスが、範囲の宣言のパス（末尾が / ならその下、* は / を除く任意の文字）のどれかに当たるか。 */
export function pathInScope(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) return path.startsWith(pattern);
    if (!pattern.includes("*")) return path === pattern;
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`,
    );
    return re.test(path);
  });
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** セキュリティ対応の差分が、修正の範囲を守っていないこと（範囲の外のファイル・上限を超えた行の数）。 */
export type ScopeViolation = { outside: string[]; lines?: number; max: number };

/**
 * セキュリティ対応の差分を、修正の範囲と照らす。範囲の外のファイル（テストのファイルは除く。回帰のテストを足すため）と、
 * 変えた行の数の上限を超えたことを返す（守っていれば undefined）。行の数は、テストのファイルを含め、ロックファイルだけを
 * 除いて数える。範囲の宣言が無ければ、行の数だけを確かめる。changes は、切り詰めていない、名前の変更を削除と追加に分けた
 * ファイルごとの変更（RepositoryWorkspace.diffStats）。
 */
export function scopeViolation(
  scope: SecurityScope | undefined,
  changes: readonly FileChange[],
): ScopeViolation | undefined {
  const outside = scope
    ? changes
        .map((c) => c.path)
        .filter((path) => !pathInScope(path, scope.paths) && !isTestPath(path))
    : [];
  const changed = changes
    .filter((c) => !LOCKFILES.has(basename(c.path)))
    .reduce((sum, c) => sum + c.added + c.removed, 0);
  const over = changed > SECURITY_FIX_MAX_CHANGED_LINES;
  if (outside.length === 0 && !over) return undefined;
  return { outside, ...(over ? { lines: changed } : {}), max: SECURITY_FIX_MAX_CHANGED_LINES };
}

/** テストのファイルか（テストのディレクトリの中か、名前がテストの慣習に当たる）。 */
function isTestPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.slice(0, -1).some((dir) => /^(test|tests|__tests__)$/i.test(dir)) ||
    looksLikeTestFile(parts.at(-1) ?? "")
  );
}

/**
 * レポートの区分から作る、対応のタスクの題と説明。その区分の指摘だけを渡し（ほかの区分を混ぜない）、最小限の変更に
 * するよう依頼する。説明に入りきらない指摘は件数だけを書く（全件は securityFix.findings に持ち、工程の指示に渡す）。
 */
export function securityFixTask(
  report: Task,
  category: SecurityCategory,
  findings: readonly SecurityFinding[],
): { title: string; body: string } {
  const name = SECURITY_CATEGORY_NAME[category];
  const listed = findings.filter((f) => f.category === category);
  const title = `セキュリティ対応：${name}（${report.title}）`;
  const head = [
    `セキュリティチェックのレポート（タスク ${report.id}）の「${name}」の指摘（${listed.length}件）を、問題を解消する最小限の変更で直してください。`,
    "リファクタリング・整形・名前の変更・関係の無い修正・指摘に無い依存の更新は混ぜないでください（レビューに時間がかかり、修正が遅れるため）。",
    "",
    "## 対応する指摘",
    "",
  ].join("\n");
  const items = listed.map((f) =>
    [
      `- ${f.id}［${f.severity}］${f.title}`,
      ...(f.refs.length > 0 ? [`  - 識別子：${f.refs.join("・")}`] : []),
      ...(f.location ? [`  - 場所：${f.location}`] : []),
      ...(f.fix ? [`  - 直し方の案：${f.fix}`] : []),
    ].join("\n"),
  );
  // 入りきらない指摘は、途中で切らずに件数だけを書く（残りの件数の行の分を空けておく）
  const rest = (n: number) =>
    `\n- ほか ${n} 件（説明に入りきらないため、全件は sacty が工程に渡します）`;
  let body = head;
  let shown = 0;
  for (const item of items) {
    const next = `${body}${shown > 0 ? "\n" : ""}${item}`;
    if (next.length + rest(items.length).length > TASK_BODY_MAX) break;
    body = next;
    shown++;
  }
  if (shown < items.length) body += rest(items.length - shown);
  return {
    title: title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1)}…` : title,
    body,
  };
}
