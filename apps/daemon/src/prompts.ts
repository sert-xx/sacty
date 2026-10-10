import type { RemarkResponse, StepKey, Task } from "@sacty/core";

/**
 * 実行できる工程。設計（PBI-8）以降は順次追加する。
 * ここに無い工程は、承認後も実行せずに待機する。
 */
export const EXECUTABLE_STEPS: readonly StepKey[] = ["requirements"];

const RESPONSES_HEADING = "sacty-responses";

/**
 * 工程ごとの指示。再提出のときは、前回の下書きと有効な指摘の全件を渡し、
 * 指摘ごとの対応を決まった形式で返してもらう。
 */
export function buildPrompt(task: Task, step: StepKey): string {
  const ticket = [`# ${task.title}`, "", task.body || "（内容なし）"].join("\n");
  const remarks = task.remarks.filter((r) => r.step === step && !r.voided);
  const previous = task.outputs[step];

  switch (step) {
    case "requirements": {
      const lines = [
        "あなたはソフトウェア開発の工程エージェントです。",
        "次のチケットから、要求要件をMarkdownで書いてください。",
        "",
        "- 何を実現するかを1〜3文で書く",
        "- 受け入れ条件を、検証できる形の箇条書きで書く",
        "- 実装方法には踏み込まない",
        "- チケットから判断できないことは「確認したいこと」として最後に列挙する",
        "",
        "--- チケット ---",
        ticket,
      ];
      if (remarks.length > 0) {
        lines.push(
          "",
          "--- 前回の下書き ---",
          previous ?? "（なし）",
          "",
          "--- 人間の指摘（すべてに対応してください。過去の指摘が再発しないようにしてください） ---",
          ...remarks.map((r) => `- [${r.id}] ${r.text}`),
          "",
          "要求要件の本文のあとに、指摘ごとの対応を次の形式で必ず付けてください。",
          "```json",
          `{"${RESPONSES_HEADING}": [{"remarkId": "指摘のID", "text": "どう対応したか"}]}`,
          "```",
        );
      }
      return lines.join("\n");
    }
    default:
      return [`工程「${step}」はまだ実装されていません。`, "", ticket].join("\n");
  }
}

/**
 * エージェントの出力から、指摘への対応（JSONのブロック）を取り出す。
 * 対応のブロックは表示用の本文から取り除く。知らない指摘のIDは無視する。
 */
export function extractResponses(
  output: string,
  validRemarkIds: ReadonlySet<string>,
): { output: string; responses: RemarkResponse[] } {
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  for (const block of blocks.reverse()) {
    const body = block[1] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const list = (parsed as Record<string, unknown>)?.[RESPONSES_HEADING];
    if (!Array.isArray(list)) continue;
    const responses = list
      .filter(
        (r): r is { remarkId: string; text: string } =>
          typeof r?.remarkId === "string" && typeof r?.text === "string",
      )
      .filter((r) => validRemarkIds.has(r.remarkId))
      .map((r) => ({ remarkId: r.remarkId, text: r.text.trim() }));
    const cleaned = (
      output.slice(0, block.index) + output.slice((block.index ?? 0) + block[0].length)
    ).trim();
    return { output: cleaned, responses };
  }
  return { output, responses: [] };
}
