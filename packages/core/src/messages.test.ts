import { describe, expect, it } from "vitest";
import { ResumeTaskInput } from "./events.js";
import { message } from "./message-code.js";
import { DAEMON_MESSAGES, isMessageCode, issueMessage, renderMessage } from "./messages.js";
import { ProjectDefinition, ProjectExport } from "./projects.js";

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

  it("コードでない文（古い作業履歴の文や、外から来た文）は、そのまま返す", () => {
    expect(renderMessage("デーモンが停止したため、実行が中断されました。", "en")).toBe(
      "デーモンが停止したため、実行が中断されました。",
    );
    // 知らないコード・プロトタイプの名前は、文言として扱わない
    expect(renderMessage({ code: "no.such", params: {} }, "ja")).toBe("no.such");
    expect(isMessageCode("toString")).toBe(false);
    expect(renderMessage("constructor", "ja")).toBe("constructor");
    // 引数が無い・一部が欠けている・形が合わなければ、コードを出す（例外にも「undefined」にもしない）
    expect(renderMessage({ code: "project.sourceTaken" }, "ja")).toBe("project.sourceTaken");
    expect(renderMessage({ code: "project.sourceTaken", params: {} }, "ja")).toBe(
      "project.sourceTaken",
    );
    expect(renderMessage({ code: "gate.staleSubmission", params: { submission: 2 } }, "en")).toBe(
      "gate.staleSubmission",
    );
    expect(
      renderMessage(
        { code: "project.sourceTaken", params: { scope: "team", target: "a", project: "b" } },
        "ja",
      ),
    ).toBe("project.sourceTaken");
    expect(renderMessage({ code: "resume.capTooLow", params: { usedUsd: "1" } }, "ja")).toBe(
      "resume.capTooLow",
    );
  });

  it("日本語と英語で、同じコードがそろっている", () => {
    expect(Object.keys(DAEMON_MESSAGES.en).sort()).toEqual(Object.keys(DAEMON_MESSAGES.ja).sort());
  });

  it("コードを指定していない標準の検査の誤りも、コードと引数にして画面の言語で出せる", () => {
    const first = (result: { error?: { issues: unknown[] } }) =>
      issueMessage(result.error?.issues[0] as Parameters<typeof issueMessage>[0]);
    const definition = (targets: unknown[], context?: unknown) =>
      ProjectDefinition.safeParse({ name: "x", targets, context });

    const tooMany = first(
      definition(Array.from({ length: 51 }, (_, i) => ({ scope: "repo", target: `o/r${i}` }))),
    );
    expect(tooMany).toEqual({ code: "input.tooMany", params: { maximum: 50 } });

    const longRef = first(definition([], { repo: "ctx", ref: "a".repeat(201) }));
    expect(longRef).toEqual({ code: "input.tooLong", params: { maximum: 200 } });
    expect(renderMessage(longRef, "ja")).toBe("200文字以内で入力してください。");
    expect(renderMessage(longRef, "en")).toBe("Keep it within 200 characters.");

    const unknown = first(
      ProjectExport.safeParse({ sacty: "project", version: 2, project: { name: "x" }, token: "t" }),
    );
    expect(unknown).toEqual({ code: "input.unknownKeys", params: { keys: "token" } });
    expect(renderMessage(unknown, "ja")).toBe("知らない項目があります（token）。");

    const negative = first(ResumeTaskInput.safeParse({ capUsd: -1 }));
    expect(negative).toEqual({
      code: "input.numberTooSmall",
      params: { minimum: 0, inclusive: false },
    });
    expect(renderMessage(negative, "ja")).toBe("0より大きい値にしてください。");
    expect(renderMessage(first(ResumeTaskInput.safeParse({ capUsd: "3" })), "en")).toBe(
      "The value has the wrong type.",
    );

    // コードを指定した検査は、そのコード
    expect(first(definition([{ scope: "repo", target: "bad" }]))).toEqual({
      code: "input.invalidRepo",
    });
  });
});
