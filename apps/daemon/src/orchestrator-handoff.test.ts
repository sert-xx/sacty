import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTAINER_HANDOFF_DIR,
  HANDOFF_FILE,
  headOf,
  readTail,
  sessionTranscript,
  stageHandoff,
} from "./orchestrator-handoff.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-handoff-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("前のエージェントのセッションのやり取りを引き継ぐ", () => {
  it("Claude Code のセッションから、指示とエージェントの発言の文だけを取り出す（ツールの呼び出し・結果は入れない）", () => {
    const jsonl = lines(
      { type: "user", message: { role: "user", content: "工程を選んで" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "台帳を読みます" },
            { type: "tool_use", name: "Read", input: { path: "/x" } },
          ],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", content: "中身" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "standard にします" }] } },
      { type: "system", subtype: "init" },
    );
    const transcript = sessionTranscript("claude-code", `${jsonl}\nnot json\n`);
    expect(transcript?.truncated).toBe(false);
    expect(transcript?.text).toBe(
      [
        "# 前のエージェントのセッションのやり取り",
        "",
        "## 指示\n\n工程を選んで\n",
        "## エージェント\n\n台帳を読みます\n",
        "## エージェント\n\nstandard にします\n",
      ].join("\n"),
    );
    expect(transcript?.text).not.toContain("中身");
  });

  it("Codex のセッション（rollout）から、user・assistant の発言だけを取り出す", () => {
    const jsonl = lines(
      { type: "session_meta", payload: { id: "t-1" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "規則" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "質問" }] },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "答え" }],
        },
      },
    );
    const transcript = sessionTranscript("codex", jsonl);
    expect(transcript?.text).toContain("## 指示\n\n質問\n");
    expect(transcript?.text).toContain("## エージェント\n\n答え\n");
    expect(transcript?.text).not.toContain("規則");
  });

  it("長い発言は先頭だけを残し、全体の上限を超えたら古い発言から省く（最後の発言は残す）", () => {
    const jsonl = lines(
      { type: "user", message: { content: "a".repeat(50) } },
      { type: "assistant", message: { content: [{ type: "text", text: "b".repeat(10) }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "c".repeat(10) }] } },
    );
    const transcript = sessionTranscript("claude-code", jsonl, { message: 20, total: 50 });
    expect(transcript?.truncated).toBe(true);
    expect(transcript?.text).toContain("（古い発言 1 件は省いた）");
    expect(transcript?.text).not.toContain("a");
    expect(transcript?.text).toContain("b".repeat(10));
    expect(transcript?.text).toContain("c".repeat(10));
    const long = sessionTranscript("claude-code", jsonl, { message: 20, total: 1000 });
    expect(long?.text).toContain(`${"a".repeat(20)}\n\n（以下略）`);
    expect(long?.truncated).toBe(true);
  });

  it("長い発言を切るとき、サロゲートペアの途中では切らない（PR #172 レビュー提案）", () => {
    const text = `${"a".repeat(7999)}😀b`;
    expect(headOf(text, 8000)).toBe("a".repeat(7999));
    expect(headOf(text, 8001)).toBe(`${"a".repeat(7999)}😀`);
    expect(headOf("短い", 8000)).toBe("短い");
    const jsonl = lines({ type: "user", message: { content: text } });
    const transcript = sessionTranscript("claude-code", jsonl);
    // UTF-8 にしても壊れない（置換文字にならない）
    expect(Buffer.from(transcript?.text ?? "", "utf8").toString("utf8")).not.toContain("\uFFFD");
    expect(transcript?.text).toContain(`${"a".repeat(7999)}\n\n（以下略）`);
  });

  it("大きなファイルは末尾だけを読み、途中から始まる最初の行は捨てる（PR #172 レビュー提案）", () => {
    const path = join(dir, "big.jsonl");
    const old = JSON.stringify({ type: "user", message: { content: "古い指示" } });
    const recent = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "新しい答え" }] },
    });
    writeFileSync(path, `${old}\n${recent}\n`);
    expect(readTail(path, 1024)).toEqual({ text: `${old}\n${recent}\n`, headOmitted: false });
    const tail = readTail(path, Buffer.byteLength(`${recent}\n`) + 5);
    expect(tail).toEqual({ text: `${recent}\n`, headOmitted: true });
    const transcript = sessionTranscript("claude-code", tail.text, undefined, tail.headOmitted);
    expect(transcript?.text).toContain("（古い発言は省いた）");
    expect(transcript?.text).toContain("新しい答え");
    expect(transcript?.text).not.toContain("古い指示");
    expect(transcript?.truncated).toBe(true);
  });

  it("発言が無い・読めないなら引き継がない", () => {
    expect(sessionTranscript("claude-code", lines({ type: "system" }))).toBeUndefined();
    expect(
      stageHandoff(join(dir, "out"), {
        agentId: "claude",
        runtime: "claude-code",
        sessionId: "s-1",
        mainFile: join(dir, "missing.jsonl"),
      }),
    ).toBeUndefined();
  });

  it("やり取りをファイルに書き、読み取り専用のマウントと、指示に足す文を返す", () => {
    const mainFile = join(dir, "s-1.jsonl");
    writeFileSync(mainFile, lines({ type: "user", message: { content: "工程を選んで" } }));
    const staged = stageHandoff(join(dir, "out"), {
      agentId: "claude_standard",
      runtime: "claude-code",
      sessionId: "s-1",
      mainFile,
    });
    expect(staged?.mount).toEqual({
      hostPath: join(dir, "out"),
      containerPath: CONTAINER_HANDOFF_DIR,
      readOnly: true,
    });
    expect(staged?.promptLines.join("\n")).toContain("claude_standard");
    expect(staged?.promptLines.join("\n")).toContain(`${CONTAINER_HANDOFF_DIR}/${HANDOFF_FILE}`);
    expect(readFileSync(join(dir, "out", HANDOFF_FILE), "utf8")).toContain("工程を選んで");
  });
});
