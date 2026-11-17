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
      definition(
        Array.from({ length: 51 }, (_, i) => ({
          scope: "repo",
          target: `https://github.com/o/r${i}`,
        })),
      ),
    );
    expect(tooMany).toEqual({ code: "input.tooMany", params: { maximum: 50 } });

    const longRef = first(definition([], { repo: "ctx", ref: "a".repeat(201) }));
    expect(longRef).toEqual({ code: "input.tooLong", params: { maximum: 200 } });
    expect(renderMessage(longRef, "ja")).toBe("200文字以内で入力してください。");
    expect(renderMessage(longRef, "en")).toBe("Keep it within 200 characters.");

    const unknown = first(
      ProjectExport.safeParse({ sacty: "project", version: 5, project: { name: "x" }, token: "t" }),
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

describe("実装が終わらないための一時停止の理由（PBI-353）", () => {
  const incomplete = message("implement.incomplete", {
    count: 11,
    stalled: false,
    declared: true,
    remaining: "docs を直す / テストを足す",
    total: 2,
  });
  const unmapped = message("implement.unmappedViewpoints", {
    count: 11,
    stalled: true,
    ids: "TV-2, TV-3",
    total: 2,
  });

  it("再開すると、同じエージェントなら続きから（続けられなければ最初から）、エージェントを変えると最初から進むことを伝える", () => {
    expect(renderMessage(incomplete, "ja")).toBe(
      "実装の工程が、範囲を実装し終える前に終わりました（11回続けて）。提出していません（PR は作っていません・更新していません）。残っていること：docs を直す / テストを足す。再開すると、同じエージェントなら、前の実行の続きから実装を続けます（続きから進められないときは、最初から実行し直します）。工程のエージェントを変えて再開すると、最初から実行し直します。",
    );
    expect(renderMessage(incomplete, "en")).toBe(
      "The implementation step ended before it finished its scope (11 times in a row). Nothing was submitted (no PR was opened or updated). What remains: docs を直す / テストを足す. Resuming with the same agent continues the implementation from where the previous run left off (when it cannot be continued, the implementation starts over). If you change the agent of the step and then resume, the implementation starts over.",
    );
    expect(renderMessage(unmapped, "ja")).toBe(
      "実装の工程が、テストの対応していないテスト観点を残して終わりました（やり直しても、作業領域が何も変わりませんでした）。提出していません（PR は作っていません・更新していません）。テストが対応していない観点：TV-2, TV-3。再開すると、同じエージェントなら、前の実行の続きから実装を続けます（続きから進められないときは、最初から実行し直します）。工程のエージェントを変えて再開すると、最初から実行し直します。",
    );
    expect(renderMessage(unmapped, "en")).toBe(
      "The implementation step ended with test viewpoints that have no test mapped (redoing it changed nothing in the workspace). Nothing was submitted (no PR was opened or updated). Viewpoints without a test: TV-2, TV-3. Resuming with the same agent continues the implementation from where the previous run left off (when it cannot be continued, the implementation starts over). If you change the agent of the step and then resume, the implementation starts over.",
    );
  });

  it("やり直しで変更が無いための一時停止の文は、最初からやり直すと伝える", () => {
    const unchanged = message("implement.unchanged", { number: 7 });
    expect(renderMessage(unchanged, "ja")).toContain("再開すると、指摘を渡して実装をやり直します");
    expect(renderMessage(unchanged, "en")).toContain(
      "Resuming redoes the implementation with the findings",
    );
  });

  it("断った理由を返信して判定し直させても指摘が残ったための一時停止の文は、止めた理由と、再開で何が起きるかを伝える（PBI-357）", () => {
    const again = message("implement.declinedAgain", { number: 7 });
    const ja = renderMessage(again, "ja");
    expect(ja).toContain("PR #7 の AI のレビューの指摘をすべて、理由を付けて断り");
    expect(ja).toContain("判定し直させましたが、指摘が残りました");
    expect(ja).toContain("再開すると、残った指摘を渡してやり直します");
    const en = renderMessage(again, "en");
    expect(en).toContain("declined every finding of the AI review on PR #7");
    expect(en).toContain("Resuming redoes the work with the remaining findings");
  });
});

describe("オーケストレーターを実行できなかった理由（PBI-34）", () => {
  it("理由の文の終わりの句点を重ねない", () => {
    const detail = message("secret.opSignedOut", { ref: "op://Work/Bedrock/credential" });
    const ja = renderMessage(message("orchestrator.failed", { detail }), "ja");
    expect(ja).not.toContain("。。");
    expect(ja).toMatch(/再開してください。再開すると、工程の選択からやり直します。$/);
    const en = renderMessage(message("orchestrator.failed", { detail }), "en");
    expect(en).not.toContain("..");
    expect(
      renderMessage(message("orchestrator.failed", { detail: "401 Unauthorized" }), "ja"),
    ).toBe(
      "オーケストレーターを実行できませんでした：401 Unauthorized。再開すると、工程の選択からやり直します。",
    );
  });
});
