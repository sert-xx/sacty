/**
 * sacty が作るコミットのメッセージを、リポジトリが定める形にする（PBI-301 A8）。リポジトリが Conventional Commits の形
 * （`feat: ...`。Commitizen・commitlint の設定、AGENTS.md・CONTRIBUTING などの決まり）を定めているときだけ、1行目に種類を付ける。
 * 定めが無い（読めない）ときは、これまでどおりタスクの題のままにする。
 */

/** 定めを探すリポジトリのファイル（起点のコミットにあるもの）。設定のファイル。 */
export const COMMIT_CONFIG_FILES = [
  "package.json",
  ".czrc",
  ".cz.json",
  ".cz.toml",
  "cz.toml",
  ".cz-config.js",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.json",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
] as const;

/** 定めを探すリポジトリのファイル（起点のコミットにあるもの）。人が読む決まりの文書。 */
export const COMMIT_RULE_DOCS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "README.md",
] as const;

/** 探すファイルすべて（読めたものだけを detectCommitConvention に渡す）。 */
export const COMMIT_CONVENTION_FILES: readonly string[] = [
  ...COMMIT_CONFIG_FILES,
  ...COMMIT_RULE_DOCS,
];

/** コミットの種類。sacty が作るコミットは、成果物の文書・文書だけの依頼の実装（docs）、不具合の修正（fix）、それ以外の実装（feat）。 */
export type CommitKind = "feat" | "fix" | "docs";

const CONVENTION_WORDS = /conventional[\s-]*commits?|commitizen|commitlint|cz-conventional/i;
const TYPE_EXAMPLE = (type: string) =>
  new RegExp(`(?:^|[\\s\`'"(\\[|])${type}(?:\\([\\w./,-]+\\))?!?:(?=[\\s\`])`, "m");
/** 1行目がすでに `type: ` または `type(scope): ` の形か。 */
const CONVENTIONAL_HEADER = /^[a-z]+(?:\([^)\n]*\))?!?:\s/;
/** commitlint の1行目の形を独自に決めている設定（sacty は読み解けない）。 */
const CUSTOM_HEADER = /headerPattern|parserPreset/;

function packageJsonUsesConvention(text: string): boolean {
  try {
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== "object") return false;
    const pkg = json as Record<string, unknown>;
    if ("commitlint" in pkg) return true;
    const config = pkg.config;
    if (config && typeof config === "object" && "commitizen" in config) return true;
    const names = ["dependencies", "devDependencies"].flatMap((key) => {
      const group = pkg[key];
      return group && typeof group === "object" ? Object.keys(group) : [];
    });
    return names.some((name) => /^(?:commitizen|cz-|commitlint|@commitlint\/)/.test(name));
  } catch {
    return false;
  }
}

/**
 * リポジトリが Conventional Commits の形のコミットメッセージを定めているか。files は、探すファイルのうち読めたもの
 * （パス → 内容）。設定のファイル（Commitizen・commitlint。package.json は項目と依存で判断する）があるか、決まりの文書が
 * Conventional Commits・Commitizen・commitlint に触れるか、`feat:` と `fix:` の両方を例に挙げていれば、定めているとする。
 * commitlint が1行目の形を独自に決めているとき（headerPattern・parserPreset）は、ほかのファイルに依存や設定があっても、読み解けないので定めていないものとして扱う（独自の形を優先し、種類を付けない）。
 */
export function detectCommitConvention(
  files: Readonly<Record<string, string | undefined>>,
): boolean {
  // 1行目の形を独自に決めている設定（headerPattern・parserPreset）が、どのファイルにでもあれば、依存や別のファイルの設定の
  // 有無によらず、読み解けないものとして定めていない扱いにする（独自の形を優先し、種類を付けない）
  const custom = COMMIT_CONFIG_FILES.some((path) => {
    const text = files[path];
    if (text === undefined || !CUSTOM_HEADER.test(text)) return false;
    return path !== "package.json" || packageJsonUsesConvention(text);
  });
  if (custom) return false;
  for (const path of COMMIT_CONFIG_FILES) {
    const text = files[path];
    if (text === undefined) continue;
    if (path === "package.json") {
      if (packageJsonUsesConvention(text)) return true;
      continue;
    }
    return true;
  }
  for (const path of COMMIT_RULE_DOCS) {
    const text = files[path];
    if (text === undefined) continue;
    if (CONVENTION_WORDS.test(text)) return true;
    if (TYPE_EXAMPLE("feat").test(text) && TYPE_EXAMPLE("fix").test(text)) return true;
  }
  return false;
}

/**
 * コミットの1行目。リポジトリが形を定めていれば `<種類>: <題>`。題がすでにその形なら変えない。
 * 定めが無ければ題のまま。
 */
export function commitSubject(title: string, kind: CommitKind, conventional: boolean): string {
  if (!conventional) return title;
  return CONVENTIONAL_HEADER.test(title) ? title : `${kind}: ${title}`;
}
