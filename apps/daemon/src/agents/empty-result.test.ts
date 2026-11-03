import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
import { DockerExecutor } from "./docker.js";
import { ClaudeOutcomeReader, parseClaudeResult, parseCodexEvents } from "./parse.js";

// エージェントの最後の結果が空でも、中身のある結果を成果物にする。中身のある結果が無ければ失敗にする（PBI-290。S16 r2 の設計1回目）

const ja = (text: unknown) => renderMessage(text, "ja");

/** claude -p --output-format stream-json の result の出来事。origin は、起こした番の元（バックグラウンドの完了通知など）。 */
const result = (
  text: string,
  usage: number,
  extra: Record<string, unknown> = {},
  isError = false,
) =>
  JSON.stringify({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: text,
    session_id: "s",
    usage: {
      input_tokens: usage,
      cache_read_input_tokens: usage * 10,
      cache_creation_input_tokens: usage * 2,
      output_tokens: usage * 3,
    },
    ...extra,
  });

const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });
const notification = { origin: { kind: "task-notification", producer: "session-task" } };
const design = `# 設計：顧客ごとの値引き率\n\n${"本文。".repeat(200)}`;

describe("最後の result が空のとき（Claude Code）", () => {
  it("中身のある result の後に、完了通知の番の空の result が来ても、中身のある最後の result を成果物にする", () => {
    // S16 r2 の形：レビュー担当の引き継ぎの result、設計の本文（行 834）、新しい番の空の result（行 836）
    const lines = [
      init,
      result("4 回目のレビューの担当 3 つを起動しました。結果を待ちます。", 1),
      result(design, 2),
      init,
      result("", 4, notification),
    ].join("\n");
    expect(parseClaudeResult(lines, 0)).toEqual({
      kind: "completed",
      output: design,
      usage: { input: 7, cacheRead: 70, cacheWrite: 14, output: 21 },
    });
  });

  it("空白・改行だけの result も空として扱う。中身のある result が複数あれば、そのうち最後のもの", () => {
    const lines = [result("途中の答え", 1), result(design, 2), result(" \n\t\n", 3, notification)];
    expect(parseClaudeResult(lines.join("\n"), 0)).toMatchObject({
      kind: "completed",
      output: design,
    });
  });

  it("空の result が続いても、その前の中身のある result を使う", () => {
    const lines = [result(design, 1), result("", 2, notification), result("", 3, notification)];
    expect(parseClaudeResult(lines.join("\n"), 0)).toMatchObject({
      kind: "completed",
      output: design,
    });
  });

  it("使い分けを知らせる（デーモンのログとセッションログに残す）。空でなければ知らせない", () => {
    const reader = new ClaudeOutcomeReader();
    reader.push([result(design, 1), result("", 2, notification)].join("\n"));
    reader.finish(0);
    expect(reader.notice).toContain("最後の result が空だったので");
    const plain = new ClaudeOutcomeReader();
    plain.push([result("待っています。", 1), result(design, 2)].join("\n"));
    plain.finish(0);
    expect(plain.notice).toBeUndefined();
  });

  it("目印（prefer）がある役割で、目印を含む result が無く最後が空でも、中身のある result を使う", () => {
    const reader = new ClaudeOutcomeReader(undefined, { prefer: '"sacty-review-verdict"' });
    reader.push([result("総評です。", 1), result("", 2, notification)].join("\n"));
    expect(reader.finish(0)).toMatchObject({ kind: "completed", output: "総評です。" });
    // 目印を含む result があれば、それを使う（これまでどおり）
    const marked = new ClaudeOutcomeReader(undefined, { prefer: '"sacty-review-verdict"' });
    const verdict = '```json\n{"sacty-review-verdict": {"verdict": "ok"}}\n```';
    marked.push([result(verdict, 1), result("待機中", 2), result("", 3)].join("\n"));
    expect(marked.finish(0)).toMatchObject({ kind: "completed", output: verdict });
  });

  it("中身のある result がどこにも無ければ、空の成果物にせず、使った分を残して失敗にする", () => {
    const outcome = parseClaudeResult([init, result("", 2, notification)].join("\n"), 0);
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "error",
      usage: { input: 2, cacheRead: 20, cacheWrite: 4, output: 6 },
    });
    expect(outcome.kind === "failed" && ja(outcome.message)).toContain("最後の結果が空");
    // 空の result が複数あっても同じ
    expect(
      parseClaudeResult([result("", 1), result("  ", 2), result("\n", 3)].join("\n"), 0),
    ).toMatchObject({ kind: "failed", reason: "error", usage: { input: 6 } });
    // json の形（result が1つ）も同じ
    expect(parseClaudeResult(result("", 5), 0)).toMatchObject({ kind: "failed", reason: "error" });
  });

  it("最後の result の後に始まった番の使用量は足し、全体は不明にする", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_late",
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    });
    expect(parseClaudeResult([result("", 1), assistant].join("\n"), 0)).toMatchObject({
      kind: "failed",
      costUnknown: true,
      usage: { input: 6, output: 10 },
    });
  });

  it("失敗の result（is_error）は、その前の中身のある result で置き換えず、これまでどおり失敗にする", () => {
    const outcome = parseClaudeResult(
      [result(design, 1), result("", 2, { errors: ["API Error: 429 rate limit"] }, true)].join(
        "\n",
      ),
      0,
    );
    expect(outcome).toMatchObject({ kind: "failed", reason: "usage_limit" });
    expect(outcome.kind === "failed" && outcome.message).toBe("API Error: 429 rate limit");
    // 終了コードが 0 でない実行も同じ（stderr の文を理由にする）
    expect(
      parseClaudeResult([result(design, 1), result("", 2)].join("\n"), 1, "boom"),
    ).toMatchObject({ kind: "failed", message: "boom" });
  });

  it("代わりの候補は成功の result だけ。本文のある is_error の result は、空の最後の result の代わりにしない", () => {
    const lines = [
      result(design, 1),
      result("API Error: 本文のある失敗の result", 2, {}, true),
      result("", 3, notification),
    ];
    expect(parseClaudeResult(lines.join("\n"), 0)).toMatchObject({
      kind: "completed",
      output: design,
    });
    // 成功の本文が無く、本文のある is_error の result だけなら、それを答えにせず失敗にする
    expect(
      parseClaudeResult(
        [result("API Error: 失敗", 1, {}, true), result("", 2, notification)].join("\n"),
        0,
      ),
    ).toMatchObject({ kind: "failed", message: { code: "run.emptyResult" } });
  });

  it("中身のある result が1つだけなら、これまでどおり（置き換えも知らせもしない）", () => {
    const reader = new ClaudeOutcomeReader();
    reader.push(result(design, 1));
    expect(reader.finish(0)).toMatchObject({ kind: "completed", output: design });
    expect(reader.notice).toBeUndefined();
  });
});

describe("最後の発言が空のとき（Codex）", () => {
  const message = (text: string) =>
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const turn = (output: number) => [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: output },
    }),
  ];

  it("空の発言は、その前の中身のある発言を置き換えない", () => {
    const lines = [...turn(1), message(design), ...turn(2), message("  ")].join("\n");
    expect(parseCodexEvents(lines, 0)).toMatchObject({
      kind: "completed",
      output: design,
      usage: { input: 20, output: 3 },
    });
  });

  it("中身のある発言がどこにも無ければ、失敗にする。使用量は読めた分を残す", () => {
    const outcome = parseCodexEvents([...turn(4), message("")].join("\n"), 0);
    expect(outcome).toMatchObject({ kind: "failed", reason: "error", usage: { output: 4 } });
    expect(outcome.kind === "failed" && ja(outcome.message)).toContain("最後の結果が空");
    // 発言が1つも無い実行も同じ
    expect(parseCodexEvents(turn(1).join("\n"), 0)).toMatchObject({ kind: "failed" });
  });

  it("終わっていない番があれば、全体の使用量は不明にする", () => {
    const lines = [...turn(4), JSON.stringify({ type: "turn.started" })].join("\n");
    expect(parseCodexEvents(lines, 0)).toMatchObject({ kind: "failed", costUnknown: true });
  });
});

describe("コンテナの実行（偽の docker コマンド）", () => {
  let dir: string;
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (lines: string[]) => {
    dir = mkdtempSync(join(tmpdir(), "sacty-emptyresult-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "out.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nif [ "$1" != "run" ]; then exit 0; fi\ncat "${join(dir, "out.jsonl")}"\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    return new DockerExecutor().run({
      runId: "r290",
      image: "img",
      workspaceDir: dir,
      invocation: { command: ["claude"], env: {}, parser: "claude-json" },
    });
  };

  it("最後の result が空でも、前の中身のある result が成果物になる", async () => {
    const outcome = await run([init, result(design, 1), result("", 2, notification)]);
    expect(outcome).toMatchObject({ kind: "completed", output: design });
  });

  it("中身のある result が無ければ、失敗の結果になる（一時停止・代わりのエージェントへの切り替えは、失敗の扱いに従う）", async () => {
    const outcome = await run([init, result("", 2, notification)]);
    expect(outcome).toMatchObject({ kind: "failed", reason: "error" });
  });
});
