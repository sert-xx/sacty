import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * コンテキストリポジトリの雛形（PBI-45）。既定のコンテキスト（default-context）と同じ構成にし、
 * 各ファイルには何を書く場所かの説明だけを入れる（中身はコメントなので、そのまま指定しても何も変えない）。
 * 規則（rules.md）は書いた文がそのままエージェントに渡るので、説明は HTML のコメントにする。
 */
export const CONTEXT_TEMPLATE_FILES: Readonly<Record<string, string>> = {
  "README.md": `# コンテキストリポジトリ

sacty の工程エージェントに渡す規則・スキル・MCP・外部 PF・エージェントの設定を置くリポジトリです。
プロジェクトの設定で「コンテキストリポジトリ」に指定すると、sacty の既定のコンテキストの上に重ねて渡します。
このファイル（README.md）はエージェントに渡しません。

- \`rules.md\`（または \`rules/*.md\`）：規則。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡す
- \`skills/<名前>/SKILL.md\`：スキル。上位の層の同じ名前のスキルは上書きする。SKILL.md の無いディレクトリはグループ（\`skills/<グループ>/<名前>/SKILL.md\` も名前 \`<名前>\` のスキル）
- \`mcp.yaml\`：MCP サーバー。秘密情報は値を書かず、名前か 1Password の参照で書く。command のサーバーは、既定で sacty を動かすホストで起動する（このリポジトリを編集できる人は、そのホストでコマンドを動かせる。config.yaml と同じくらい信頼できる人だけが編集できるようにする）
- \`platforms.yaml\`：ゲートウェイの外部 PF（書き方は config.yaml の gateway.platforms と同じ）。このプロジェクトのタスクだけが使える。秘密情報は名前か 1Password の参照で書き、値はホストのゲートウェイだけが付ける
- \`agents/codex/\`・\`agents/claude/\`：worker の CODEX_HOME・CLAUDE_CONFIG_DIR に写すファイル（同じパスは下位が上書き）
  - \`config.toml\`・\`settings.json\` はキーごとに重ね、下位が上書きする
  - Codex のルール（\`agents/codex/rules/*.rules\`）は、既定のルールを消さないように \`sacty.rules\` 以外の名前にする
  - 段階のサブエージェントの定義（\`agents/claude/agents/<段階>.md\`・\`agents/codex/agents/*.toml\` の name が段階のもの・Codex の config.toml の \`[agents.<段階>]\`。段階は lite・entry・standard・advanced・ultimate）は、sacty が config.yaml の claude_<段階>・codex_<段階> から作るので、ここに置いても使わない
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
SKILL.md の無いディレクトリはグループで、\`skills/<グループ>/<名前>/SKILL.md\` も名前 \`<名前>\` のスキルになります（関連するスキルをまとめて置けます）。
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
# HTTP のサーバーは、sacty のゲートウェイ経由で使う（認証のヘッダーはホストで付け、コンテナには渡さない）。
# command のサーバーは、sacty を動かすホストで起動し、ゲートウェイ経由で使う（env の秘密情報はホストで入れ、コンテナには
# 渡さない）。作業ディレクトリは、このリポジトリの写し（相対パスは、このリポジトリの直下から）。npx・uvx などのコマンドは、
# ホストに入れておく。このリポジトリを編集できる人は、ホストでコマンドを動かせるので、編集できる人を絞る。
# コンテナの中で起動する（HTTP はコンテナから直接つなぐ）ときは、そのサーバーに via_gateway: false と書く。
# servers:
#   docs:
#     url: https://mcp.example.com/mcp
#     headers:
#       Authorization: { secret: docs-token, prefix: "Bearer " }
#   local-tool:
#     command: npx
#     args: ["-y", "example-mcp-server"]
#     startup_timeout_sec: 60   # 起動を待つ上限（秒。任意）
#     tool_timeout_sec: 900     # ツールの呼び出しを待つ上限（秒。任意。実行全体の上限（既定 30 分）より短くする）
#   （次はコンテナの中で起動する例）
#   container-tool:
#     command: npx
#     args: ["-y", "example-container-mcp"]
#     via_gateway: false
`,
  "platforms.yaml": `# 工程エージェントが $SACTY_PF_URL/<名前>/… で呼べる外部 PF（書き方は config.yaml の gateway.platforms と同じ）。
# 名前ごとに、上位の層の同じ名前の PF を上書きする。config.yaml の gateway.platforms に同じ名前があれば、そちらを使う。
# このプロジェクトのタスクだけが使える（ほかのプロジェクトのタスクからは、名前を知っていても使えない）。
# 認証の秘密情報は値を書かず、キーチェーンの名前か 1Password の参照を書く（値はホストのゲートウェイだけが取り出して付ける）。
# allow は使える API（* は1階層、** はそれ以下すべて）。書いていない API はすべて拒否する。
# platforms:
#   ticket:
#     upstream: https://ticket.internal.example.com
#     description: Tickets
#     auth:
#       header: Authorization
#       prefix: "Bearer "
#       secret: op://Work/Ticket/token
#     allow:
#       - GET /api/v1/tickets/**
`,
  "sacty-context.yaml": `# extends：このリポジトリの親（上位の層）のコンテキストリポジトリ。URL#ref で ref を指定できる
#   同じリポジトリの中のディレクトリ（モノレポ）は、この層から見た相対パス（例 ../base）で書ける。
#   ほかのリポジトリの中のディレクトリは、repo・ref・path の3つの項目で書く
# extends: git@github.com:acme/sacty-context.git#main
# locked：下位の層で上書き・取り除きできないスキル・MCP サーバー・外部 PF
# locked:
#   skills: [review]
#   mcp: [docs]
#   platforms: [ticket]
# remove：上位の層から引き継いだスキル・MCP サーバー・外部 PF を取り除く
# remove:
#   skills: []
#   mcp: []
#   platforms: []
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
  // 途中のディレクトリ（skills・agents・agents/codex）がリンクやファイルだと、書き込みがリンクの先や外へ
  // 届くので、--force でも書かずに止める（リンクの先のファイルを書き換えないため）
  const parents = [
    ...new Set(
      paths.flatMap((path) =>
        path
          .split("/")
          .slice(0, -1)
          .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
      ),
    ),
  ];
  const unsafe = parents.filter((path) => {
    try {
      return !lstatSync(join(dir, path)).isDirectory();
    } catch {
      return false;
    }
  });
  if (unsafe.length > 0) {
    throw new Error(
      `${dir} の ${unsafe.join("・")} がディレクトリではありません（シンボリックリンクなど）。リンクの先に書き込まないよう、作成を止めました。通常のディレクトリにしてから実行してください。`,
    );
  }
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
