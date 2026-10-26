import { posix } from "node:path";
import { TASK_BODY_MAX, TASK_TITLE_MAX, type TaskTemplate } from "@sacty/core";
import { CI_REFERENCE, DEPLOYMENT_HEADING, DEPLOYMENT_SKILL_PATHS } from "./deployment.js";

/**
 * デプロイの確認のスキル（PBI-89 のマージの後の監視が探すもの）。置き場所は DEPLOYMENT_SKILL_PATHS から作り、二か所に
 * 持たない（PBI-90）。原本は .agents/skills/ の下、Claude Code 用は .claude/skills/ の下の、原本へのシンボリックリンク。
 */
const [SKILL_ORIGINAL, SKILL_FOR_CLAUDE] = DEPLOYMENT_SKILL_PATHS;
const SKILL_DIR = posix.dirname(SKILL_ORIGINAL);
const SKILL_LINK = posix.dirname(SKILL_FOR_CLAUDE);
const SKILL_NAME = posix.basename(SKILL_DIR);
/** Claude Code 用のリンクから見た、原本のディレクトリへの相対パス（例 ../../.agents/skills/deployment-observer）。 */
const SKILL_LINK_TARGET = posix.relative(posix.dirname(SKILL_LINK), SKILL_DIR);

/** リポジトリの URL から、題に出す短い名前（owner/name）を作る。形が違えば、そのまま。 */
function shortName(repo: string): string {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repo);
  return match?.[1] ?? repo;
}

/**
 * 「Sacty セットアップ」のゴール（PBI-90）。対象のリポジトリを sacty で扱うために要るエージェントの設定を検査し、
 * 足りないものを整える PR を作らせる。あらゆる言語・構成のリポジトリに通じるよう、特定の言語・ツールに寄せない。
 */
function setupBody(repo: string): string {
  const skill = SKILL_NAME;
  return [
    "対象のリポジトリを sacty で扱えるように、AI エージェント（Claude Code・Codex など）向けの設定を検査し、足りないものを整える PR を作ってください。",
    "このタスクは、sacty のタスクのテンプレート「Sacty セットアップ」で作ったものです。",
    "",
    // URL は行の末尾に置く（画面の Markdown で、後ろの文字までリンクにしないため）
    `- 対象のリポジトリ：${repo}`,
    "",
    "## 検査して整えるもの",
    "",
    "1. エージェント向けの指示（AGENTS.md・CLAUDE.md など）",
    "   - リポジトリの目的と構成（主なディレクトリ・モジュール）、使っている言語・ランタイムとその版、依存の入れ方、ビルドの仕方、コードの規約、変えてはいけないもの・やってはいけないことが書かれているか。",
    "   - 片方を原本にし、もう片方は原本を読むよう案内するなどして、同じ内容を二重に管理しない（すでに決まった形があれば、それに従う）。",
    "2. テストの実行の仕方",
    "   - テスト・lint・フォーマット・型の検査など、変更を確かめるコマンドと、その前提（ランタイムの版・依存の入れ方・環境変数の名前）が、エージェント向けの指示か README などに書かれているか。",
    "   - 書かれたコマンドが、リポジトリの今の設定（ビルドの定義・タスクランナー・CI の定義など）と合っているか。CI の定義があれば、CI が実行しているものを手がかりにする。",
    "   - テストの仕組みがまだ無いリポジトリでは、無いことと、変更をどう確かめればよいか（手で確かめる手順など）がわかるように書く。このタスクで、言語やテストの仕組みを新しく選んで入れない（入れるなら、別のタスクにする）。",
    "3. テストに要るサービス",
    "   - テストや動作確認に、データベース・キャッシュ・メッセージキュー・外部 API のモックなどが要るか。要るなら、起動の仕方（docker compose のファイルなど）と、サービスの名前・つなぎ先・起動の順番が書かれているか。",
    "   - 要らなければ、要らないことがわかるように書く。",
    `4. マージの後の監視のスキル \`${skill}\`（CI/CD のあるリポジトリだけ。デプロイしていなくても作る）`,
    "   - sacty は、タスクを始めるときに、リポジトリにこのスキルがあるかを見て、マージの後の監視の工程をするかを決める。スキルが無ければ、工程を飛ばす（CI/CD も見ない）。",
    "   - 工程では、sacty がタスクの PR のマージのコミットの CI/CD が終わるのを待ち（時間の上限まで）、失敗していれば修正のタスクを登録する。通ったら、このスキルに従ってエージェントに確かめさせる。どこまで確かめるか（CI/CD の確認・デプロイの確認のどれをするか）と確かめ方は、このスキルの書き方で決まる。",
    "   - CI/CD の定義（ワークフローなど）を読み、CI/CD があるか・マージでデプロイしているかを判断する。CI/CD が無ければスキルを作らず、その判断と根拠を報告する。",
    `   - 置き場所：原本を \`${SKILL_ORIGINAL}\` に置き、Claude Code 用の \`${SKILL_LINK}\` は、原本のディレクトリへの相対のシンボリックリンク（\`${SKILL_LINK_TARGET}\`）にする。二重に管理しない。ほかのスキルも、同じく \`${posix.dirname(SKILL_DIR)}/\` を原本にする。`,
    `   - SKILL.md の先頭に、\`name: ${skill}\` と \`description\`（いつ使うスキルか）の front matter を書く。`,
    `   - CI/CD の確認の仕方の reference を \`${SKILL_DIR}/${CI_REFERENCE}\` に作り、SKILL.md から参照する。書くこと：どのワークフロー・チェックが何を確かめているか、マージのコミットで通るべきもの・失敗を無視してよいもの（あれば）、結果やログの見方（使うコマンド・画面。秘密情報は名前だけ）。`,
    "   - デプロイしているリポジトリでは、本文に書くこと：何をデプロイの完了とみなすか（どの仕組み・どの環境へ・何を見れば終わったとわかるか）、デプロイ後のアプリの確かめ方（ヘルスチェック・主な画面や API・ログ・監視など）、つなぎ方（使う接続先・MCP サーバー・コマンド。秘密情報は名前だけ）、エラーとみなす基準。",
    "   - デプロイしていないリポジトリでは、本文に、デプロイしていないのでデプロイの確認を飛ばす（deployment の result を skipped にし、reason にデプロイしていないことを書く）と書き、CI/CD の確認だけをさせる。",
    "   - 本文に必ず書く約束：確かめるだけにし、コード・アプリ・データ・設定を変更しない（CI/CD の再実行・デプロイのやり直し・ロールバックもしない）。秘密情報を出力に書かない。CI/CD やデプロイが終わるのを長く待たない（待つのは sacty）。終わっていない・確かめる手段が無いなど判断できないときは unknown にする。",
    "   - 最後の答えの形（sacty が読む）：次の JSON を、```json の囲みで出す。ci.result は passed（通っている）・failed（失敗がある）・skipped（確かめない）・unknown（判断できない）、deployment.result は healthy（正しく動いている）・unhealthy（エラーになっている）・skipped（確かめない）・unknown（判断できない）。飛ばしたもの・判断できないものは、reason に理由を書く。",
    "",
    "     ```json",
    `     {"${DEPLOYMENT_HEADING}": {"ci": {"result": "passed | failed | skipped | unknown", "summary": "CI/CD の確認の要点", "reason": "飛ばした・判断できない理由"}, "deployment": {"result": "healthy | unhealthy | skipped | unknown", "summary": "デプロイの確認の要点", "reason": "飛ばした・判断できない理由"}, "summary": "結果の要点", "evidence": ["根拠（確かめたこと・見たログやレスポンスの要点）"]}}`,
    "     ```",
    "",
    "## 進め方",
    "",
    "- まず、上の項目ごとに今のリポジトリを検査する。リポジトリの言語・構成・既存の規約に合わせ、特定の言語やツールを前提にしない。",
    "- すべて整っていて変更が要らなければ、PR を作らずに、調査だけ（工程の組み合わせは investigate）で終える。そのときは、項目ごとの検査の結果（あるもの・その場所・判断の根拠）を報告に残す。",
    "- 足りないもの・実際と合わないものがあれば、それを整える PR を作る。PR の説明に、項目ごとの検査の結果と、足した・直したものを書く。",
    "- 工程を進めた後（要求要件・設計・実装の途中）で、すべて整っていて変更が要らないとわかったときは、ファイルを変えずに、項目ごとの検査の結果と変更が要らない理由を実装の説明に書く。何も変えなければ、sacty は PR を作らず、人が確かめて変更なしで完了にする。",
    "- 既にある内容は、誤りでない限り消さずに活かす。リポジトリの目的に関係のない変更はしない。",
    "- リポジトリから確かめられないこと（デプロイ先の URL・アプリへのつなぎ方など）は推測で書かない。人に確かめることとして、PR の説明か報告に挙げる。",
    "- 秘密情報（API キー・トークン・パスワードなど）の値を書かない。要るものは、名前と入手の仕方だけを書く。",
  ].join("\n");
}

/**
 * 「セキュリティチェック」のゴール。進め方は security-check に決め（工程の指示で点検の区分と答えの形を伝える）、ここでは
 * 対象と、レポートを区分ごとの対応に使うことだけを書く。
 */
function securityCheckBody(repo: string): string {
  return [
    "対象のリポジトリのセキュリティチェックをして、区分ごとの指摘のレポートを作ってください。",
    "このタスクは、sacty のタスクのテンプレート「セキュリティチェック」で作ったものです。",
    "",
    // URL は行の末尾に置く（画面の Markdown で、後ろの文字までリンクにしないため）
    `- 対象のリポジトリ：${repo}`,
    "",
    "- 点検する区分：依存の脆弱性・サプライチェーン・コードの脆弱性・秘密情報の混入・設定・IaC",
    "- 承認したレポートの区分ごとに、対応のタスク（進め方 security-fix）を作ります。指摘には、問題を解消する最小限の直し方の案を書いてください。",
    "- コードは変えないでください。",
  ].join("\n");
}

/** テンプレートで作るタスクの題と説明（PBI-90）。 */
export function templateTask(
  template: TaskTemplate,
  repo: string,
): { title: string; body: string } {
  switch (template) {
    case "sacty-setup":
      return {
        title: `Sacty セットアップ（${shortName(repo)}）`.slice(0, TASK_TITLE_MAX),
        body: setupBody(repo).slice(0, TASK_BODY_MAX),
      };
    case "security-check":
      return {
        title: `セキュリティチェック（${shortName(repo)}）`.slice(0, TASK_TITLE_MAX),
        body: securityCheckBody(repo).slice(0, TASK_BODY_MAX),
      };
  }
}
