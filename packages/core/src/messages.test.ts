import { describe, expect, it } from "vitest";
import { message } from "./message-code.js";
import { DAEMON_MESSAGES, isMessageCode, renderMessage } from "./messages.js";

describe("デーモンの文言（PBI-11）", () => {
  it("コードと引数を、画面の言語の文言にする", () => {
    const m = message("resume.capTooLow", { usedUsd: 1.5 });
    expect(m).toEqual({ code: "resume.capTooLow", params: { usedUsd: 1.5 } });
    expect(renderMessage(m, "ja")).toBe(
      "新しい上限は、使用済み（$1.50）より大きい金額にしてください。",
    );
    expect(renderMessage(m, "en")).toBe("Set a new cap greater than the amount used ($1.50).");
    expect(renderMessage(message("task.notFound"), "en")).toBe("Task not found.");
  });

  it("コードでない文（古い台帳の文や、外から来た文）は、そのまま返す", () => {
    expect(renderMessage("デーモンが停止したため、実行が中断されました。", "en")).toBe(
      "デーモンが停止したため、実行が中断されました。",
    );
    // 知らないコード・プロトタイプの名前は、文言として扱わない
    expect(renderMessage({ code: "no.such", params: {} }, "ja")).toBe("no.such");
    expect(isMessageCode("toString")).toBe(false);
    expect(renderMessage("constructor", "ja")).toBe("constructor");
    // 引数の形が合わなければ、コードを出す（例外にしない）
    expect(renderMessage({ code: "project.sourceTaken" }, "ja")).toBe("project.sourceTaken");
  });

  it("日本語と英語で、同じコードがそろっている", () => {
    expect(Object.keys(DAEMON_MESSAGES.en).sort()).toEqual(Object.keys(DAEMON_MESSAGES.ja).sort());
  });
});
