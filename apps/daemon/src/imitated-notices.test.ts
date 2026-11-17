import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerExecutor } from "./agents/docker.js";
import {
  ClaudeOutcomeReader,
  countImitatedNotices,
  IMITATED_NOTICES_MAX,
  parseClaudeResult,
} from "./agents/parse.js";

// エージェント（工程の親）の発言に、サブエージェントの完了の通知・システムの知らせの形の文面があったら、作業履歴に残す（PBI-368）。
// 実行の記録で見つかった 3 つの形（背景で起動した担当の結果が届く前に、親が自分で書いた文面）を拾う。
// 作業履歴への記録（TaskService）のテストは、daemon-steps.test.ts の「工程の実行と費用」にある。

/** 見つかった形 1：システムの知らせの形で、担当ごとの結果を書いた（9 件のうち 2 件に縮めた）。 */
const REMINDERS = [
  "<system-reminder>",
  "[Agent completed: Review D-5 (subagent standard)]",
  'Output: Result: {"viewpoint":"D-5","status":"completed","findings":[]}',
  "</system-reminder>",
  "",
  "<system-reminder>",
  "[Agent completed: Review D-8 (subagent standard)]",
  'Output: Result: {"viewpoint":"D-8","status":"completed","findings":[]}',
  "</system-reminder>",
].join("\n");

/** 見つかった形 2：待っているという文の後に、完了の知らせを 1 つ書いた。 */
const ONE_LINE = [
  "2つのレビュー担当の結果を待っています。",
  "",
  "<system-reminder>",
  'Agent "D-4 review of requirements fix" completed.',
  "</system-reminder>",
].join("\n");

/** 見つかった形 3：背景の処理の完了の通知の全文を書いた。 */
const TASK_NOTIFICATION = [
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This is an automated background-task event, NOT a message from the user.",
  "",
  "<task-notification>",
  "<task-id>a0000000000000000</task-id>",
  "<status>completed</status>",
  '<summary>Agent "Review X-1 cross-cutting" finished</summary>',
  '<result>{"viewpoint":"X-1","status":"completed","findings":[]}</result>',
  "</task-notification>",
].join("\n");

const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });
const assistant = (text: string, parent: string | null = null) =>
  JSON.stringify({
    type: "assistant",
    session_id: "s",
    parent_tool_use_id: parent,
    message: { id: `m-${text.length}`, content: [{ type: "text", text }] },
  });
const result = (text: string) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "s",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

describe("通知の形の文面の数え方", () => {
  it("実行の記録で見つかった 3 つの形を、どれも拾う", () => {
    expect(countImitatedNotices(REMINDERS)).toBe(2);
    expect(countImitatedNotices(ONE_LINE)).toBe(1);
    expect(countImitatedNotices(TASK_NOTIFICATION)).toBe(1);
  });

  it("数えるのは、行の先頭（字下げなし）のタグだけ。字下げした行・引用の印やリストの印の後ろ・閉じるタグは数えない", () => {
    expect(countImitatedNotices("<task-notification>\n</task-notification>")).toBe(1);
    expect(
      countImitatedNotices("  <task-notification>\n    <system-reminder>\n\t<system-reminder>"),
    ).toBe(0);
    expect(
      countImitatedNotices("> <system-reminder>\n- <system-reminder>\n1. <task-notification>"),
    ).toBe(0);
    expect(countImitatedNotices("</system-reminder>\n</task-notification>")).toBe(0);
  });

  it("文の中での言及・コードブロックの中の引用・タグの無い文は数えない", () => {
    expect(countImitatedNotices("完了の通知（<task-notification>）は、実行環境が届ける。")).toBe(0);
    expect(countImitatedNotices("- `<system-reminder>` を親が書いた実行が 3 件")).toBe(0);
    expect(countImitatedNotices(`\`\`\`\n${TASK_NOTIFICATION}\n\`\`\``)).toBe(0);
    expect(countImitatedNotices(`~~~text\n${REMINDERS}\n~~~`)).toBe(0);
    // 長いフェンスの中の短いフェンスでは、コードブロックは閉じない
    expect(countImitatedNotices(`\`\`\`\`\n\`\`\`\n${ONE_LINE}\n\`\`\`\n\`\`\`\``)).toBe(0);
    expect(countImitatedNotices("担当の結果を待っています。")).toBe(0);
    expect(countImitatedNotices("")).toBe(0);
  });

  it("リスト・引用の中のコードブロック（開く行が、リストの印・引用の印・字下げの後ろ）の中の引用は数えない", () => {
    const quoted = ["  <system-reminder>", '  Agent "D-4" completed.', "  </system-reminder>"].join(
      "\n",
    );
    expect(countImitatedNotices(`- 例：\n- \`\`\`\n${quoted}\n  \`\`\``)).toBe(0);
    expect(countImitatedNotices(`1. \`\`\`xml\n${quoted}\n   \`\`\``)).toBe(0);
    expect(countImitatedNotices(`> \`\`\`\n> <system-reminder>\n> \`\`\``)).toBe(0);
    expect(countImitatedNotices(`- 例\n\n  ~~~\n${quoted}\n  ~~~`)).toBe(0);
  });

  it("リスト・引用の中や、4 つ以上字下げした ``` は、字下げの無い行で終わる（開いたまま、後ろの文面を見逃さない）", () => {
    expect(countImitatedNotices(`    \`\`\`\n${ONE_LINE}`)).toBe(1);
    expect(countImitatedNotices(`\t~~~\n${ONE_LINE}`)).toBe(1);
    expect(countImitatedNotices(`- \`\`\`\n  引用\n${ONE_LINE}`)).toBe(1);
    // 空白 3 つまでの字下げで開いたコードブロックは、閉じる行まで続く（中の行が行の先頭から始まっていても数えない）
    expect(countImitatedNotices(`   \`\`\`\n${ONE_LINE}\n   \`\`\``)).toBe(0);
    // 空行では終わらない
    expect(countImitatedNotices(`- \`\`\`\n\n  <system-reminder>\n  \`\`\``)).toBe(0);
  });

  it("コードブロックの中の ```xml のような行では、コードブロックを閉じない", () => {
    expect(countImitatedNotices(`\`\`\`\n\`\`\`xml\n${ONE_LINE}\n\`\`\``)).toBe(0);
    expect(countImitatedNotices(`~~~\n~~~ text\n${ONE_LINE}\n~~~`)).toBe(0);
    // 記号の違う行でも閉じない。閉じる行の後ろの空白は許す
    expect(countImitatedNotices(`\`\`\`\n~~~\n${ONE_LINE}\n\`\`\`  \n${ONE_LINE}`)).toBe(1);
  });

  it("行の中のコード（``` で始まり、同じ行に ` がある）は、コードブロックを開かない", () => {
    expect(countImitatedNotices(`\`\`\`<system-reminder>\`\`\` は目印\n${ONE_LINE}`)).toBe(1);
  });

  it("コードブロックを閉じた後の文面は数える", () => {
    expect(countImitatedNotices(`\`\`\`\n引用\n\`\`\`\n${ONE_LINE}`)).toBe(1);
  });

  it("数は上限で止める", () => {
    const many = "<system-reminder>\n".repeat(IMITATED_NOTICES_MAX + 50);
    expect(countImitatedNotices(many)).toBe(IMITATED_NOTICES_MAX);
  });
});

describe("エージェントの出力の読み取り（Claude Code）", () => {
  const read = (lines: string[]) => {
    const reader = new ClaudeOutcomeReader();
    reader.push(`${lines.join("\n")}\n`);
    const outcome = reader.finish(0);
    return { outcome, imitated: reader.imitatedNotices };
  };

  it("親の発言の、通知の形の文面を、発言をまたいで合計する", () => {
    const { outcome, imitated } = read([
      init,
      assistant(REMINDERS),
      assistant("修正しました。"),
      assistant(TASK_NOTIFICATION),
      result("# 設計"),
    ]);
    expect(imitated).toBe(3);
    // 実行の結果（成果物）は変えない
    expect(outcome).toMatchObject({ kind: "completed", output: "# 設計" });
  });

  it("1 つの発言の本文が分かれていても、全体をつないでコードブロックを見分ける", () => {
    const blocks = (texts: string[]) =>
      JSON.stringify({
        type: "assistant",
        session_id: "s",
        parent_tool_use_id: null,
        message: { id: "m-blocks", content: texts.map((text) => ({ type: "text", text })) },
      });
    // コードブロックの開始と、引用した文面が、別の本文に分かれている
    expect(read([init, blocks(["引用：\n```", `${ONE_LINE}\n\`\`\``]), result("x")]).imitated).toBe(
      0,
    );
    // 閉じた後の本文は数える
    expect(read([init, blocks(["```\n引用\n```", ONE_LINE]), result("x")]).imitated).toBe(1);
  });

  it("サブエージェントの発言（parent_tool_use_id を持つ）は数えない", () => {
    expect(read([init, assistant(ONE_LINE, "toolu_1"), result("# 設計")]).imitated).toBe(0);
  });

  it("実行環境が届けた通知（user の出来事）と、result の本文は数えない", () => {
    const delivered = JSON.stringify({
      type: "user",
      session_id: "s",
      message: { role: "user", content: TASK_NOTIFICATION },
    });
    expect(read([init, delivered, assistant("集約します。"), result(ONE_LINE)]).imitated).toBe(0);
  });

  it("文面が無い実行は 0 で、結果に印を持たせない", () => {
    const { outcome, imitated } = read([init, assistant("担当の結果が揃いました。"), result("x")]);
    expect(imitated).toBe(0);
    expect(outcome).not.toHaveProperty("imitatedNotices");
    expect(parseClaudeResult([init, assistant(ONE_LINE), result("x")].join("\n"), 0)).toMatchObject(
      {
        kind: "completed",
      },
    );
  });
});

describe("コンテナの実行（偽の docker コマンド）", () => {
  let dir: string;
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (lines: string[], exit = 0) => {
    dir = mkdtempSync(join(tmpdir(), "sacty-imitated-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "out.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nif [ "$1" != "run" ]; then exit 0; fi\ncat "${join(dir, "out.jsonl")}"\nexit ${exit}\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    return new DockerExecutor().run({
      runId: "r368",
      image: "img",
      workspaceDir: dir,
      invocation: { command: ["claude"], env: {}, parser: "claude-json" },
    });
  };

  it("通知の形の文面があった実行の結果に、件数を持たせる（成果物はそのまま）", async () => {
    const outcome = await run([init, assistant(REMINDERS), result("# 設計")]);
    expect(outcome).toMatchObject({ kind: "completed", output: "# 設計", imitatedNotices: 2 });
  });

  it("失敗した実行の結果にも持たせる", async () => {
    const outcome = await run([init, assistant(ONE_LINE)], 1);
    expect(outcome).toMatchObject({ kind: "failed", imitatedNotices: 1 });
  });

  it("文面が無い実行の結果には持たせない", async () => {
    const outcome = await run([init, assistant("集約します。"), result("# 設計")]);
    expect(outcome).not.toHaveProperty("imitatedNotices");
  });
});
