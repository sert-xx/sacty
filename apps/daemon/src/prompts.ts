import type { StepKey, Task } from "@sacty/core";

/**
 * 工程ごとの指示。PBI-2では要求要件の下書きまで。
 * 承認ゲートや設計以降の工程はPBI-7以降で作り込む。
 */
export function buildPrompt(task: Task, step: StepKey): string {
  const ticket = [`# ${task.title}`, "", task.body || "（内容なし）"].join("\n");
  switch (step) {
    case "requirements":
      return [
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
      ].join("\n");
    default:
      return [`工程「${step}」はまだ実装されていません。`, "", ticket].join("\n");
  }
}
