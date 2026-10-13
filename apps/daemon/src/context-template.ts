import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * コンテキストリポジトリの雛形（PBI-45）。既定のコンテキスト（default-context）と同じ構成にし、
 * 各ファイルには何を書く場所かの説明だけを入れる（中身はコメントなので、そのまま指定しても何も変えない）。
 * 規則（rules.md）は書いた文がそのままエージェントに渡るので、説明は HTML のコメントにする。
 */
export const CONTEXT_TEMPLATE_FILES: Readonly<Record<string, string>> = {
  "README.md": `# コンテキストリポジトリ

sacty の工程エージェントに渡す規則・スキル・MCP・エージェントの設定を置くリポジトリです。
プロジェクトの設定で「コンテキストリポジトリ」に指定すると、sacty の既定のコンテキストの上に重ねて渡します。
このファイル（README.md）はエージェントに渡しません。

- \`rules.md\`（または \`rules/*.md\`）：規則。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡す
- \`skills/<名前>/SKILL.md\`：スキル。上位の層の同じ名前のスキルは上書きする
- \`mcp.yaml\`：MCP サーバー。秘密情報は値を書かず、名前か 1Password の参照で書く
- \`agents/codex/\`・\`agents/claude/\`：worker の CODEX_HOME・CLAUDE_CONFIG_DIR に写すファイル（同じパスは下位が上書き）
  - \`config.toml\`・\`settings.json\` はキーごとに重ね、下位が上書きする
  - Codex のルール（\`agents/codex/rules/*.rules\`）は、既定のルールを消さないように \`sacty.rules\` 以外の名前にする
- \`sacty-context.yaml\`：extends（親のリポジトリ）・locked（下位で上書き・取り除きできない項目）・remove（上位から引き継いだ項目を取り除く）
`,
  "rules.md": `# プロジェクトの規則

<!--
工程エージェントに守らせる規則を書きます（Claude Code には CLAUDE.md、Codex には AGENTS.md として渡します）。
ファイルを分けたいときは、rules.md の代わりに rules/*.md に置きます（名前の順に連結します）。
例：
- コミットメッセージは日本語で書く
- テストは \`npm test\` で実行する
-->
`,
  "skills/README.md": `# スキル

\`skills/<名前>/SKILL.md\` に置いたディレクトリが、スキルになります（このファイルは渡しません）。
SKILL.md の先頭の front matter の description に、いつ使うスキルかを書きます。

\`\`\`markdown
---
description: リリースの手順
---
リリースするときは……
\`\`\`
`,
  "mcp.yaml": `# 工程エージェントに渡す MCP サーバー。名前ごとに、上位の層の同じ名前のサーバーを上書きする。
# 秘密情報は値を書かず、{ secret: 名前 } でキーチェーンの名前か 1Password の参照を書く（prefix は値の前につける）。
# servers:
#   docs:
#     url: https://mcp.example.com/mcp
#     headers:
#       Authorization: { secret: docs-token, prefix: "Bearer " }
#   local-tool:
#     command: npx
#     args: ["-y", "example-mcp-server"]
`,
  "sacty-context.yaml": `# extends：このリポジトリの親（上位の層）のコンテキストリポジトリ。URL#ref で ref を指定できる
# extends: git@github.com:acme/sacty-context.git#main
# locked：下位の層で上書き・取り除きできないスキル・MCP サーバー
# locked:
#   skills: [review]
#   mcp: [docs]
# remove：上位の層から引き継いだスキル・MCP サーバーを取り除く
# remove:
#   skills: []
#   mcp: []
`,
  "agents/codex/config.toml": `# Codex の設定（worker の CODEX_HOME/config.toml に、sacty の既定の上にキーごとに重ねる）。
# 承認の方針（approval_policy）・サンドボックス（sandbox_mode）・接続先・MCP は sacty が決めるので、ここには書かない。
# 例：
# model_reasoning_effort = "high"
`,
};

/**
 * dir にコンテキストリポジトリの雛形を書き、書いたファイル（dir からの相対パス）を返す。
 * 雛形と同じパス（と rules/）があれば、force でなければ何も書かずに止める（ほかのファイルはそのまま残す）。
 */
export function initContextRepo(dir: string, force: boolean): string[] {
  const paths = Object.keys(CONTEXT_TEMPLATE_FILES);
  // リンク自体も見るため、existsSync（リンク先を見る）ではなく lstat で有無を確かめる
  const exists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  // rules/ があると、作る rules.md が優先されて rules/*.md が読まれなくなるので、ある場合も止める
  const existing = [...paths, "rules"].filter((path) => exists(join(dir, path)));
  if (existing.length > 0 && !force) {
    throw new Error(
      `${dir} にはすでに ${existing.join("・")} があります。上書きする場合は --force を付けてください。`,
    );
  }
  for (const path of paths) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    // リンクだった場合にリンク先を書き換えないよう、消してから書く
    rmSync(target, { force: true });
    writeFileSync(target, CONTEXT_TEMPLATE_FILES[path] ?? "");
  }
  return paths;
}
