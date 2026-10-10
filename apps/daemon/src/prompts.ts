import type { RemarkResponse, StepKey, Task, TestViewpoint } from "@sacty/core";

/**
 * 実行できる工程。実装（PBI-10）以降は順次追加する。
 * ここに無い工程は、承認後も実行せずに待機する。
 */
export const EXECUTABLE_STEPS: readonly StepKey[] = ["requirements", "design"];

const RESPONSES_HEADING = "sacty-responses";
const VIEWPOINTS_HEADING = "sacty-test-viewpoints";

function remarkLines(task: Task, step: StepKey, label: string): string[] {
  const remarks = task.remarks.filter((r) => r.step === step && !r.voided);
  if (remarks.length === 0) return [];
  return [
    "",
    "--- 人間の指摘（すべてに対応してください。過去の指摘が再発しないようにしてください） ---",
    ...remarks.map((r) => `- [${r.id}] ${r.text}`),
    "",
    `${label}のあとに、指摘ごとの対応を次の形式で必ず付けてください。`,
    "```json",
    `{"${RESPONSES_HEADING}": [{"remarkId": "指摘のID", "text": "どう対応したか"}]}`,
    "```",
  ];
}

/**
 * 工程ごとの指示。再提出のときは、前回の下書きと有効な指摘の全件を渡し、
 * 指摘ごとの対応を決まった形式で返してもらう。
 */
export function buildPrompt(task: Task, step: StepKey): string {
  const ticket = [`# ${task.title}`, "", task.body || "（内容なし）"].join("\n");
  const hasRemarks = task.remarks.some((r) => r.step === step && !r.voided);
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
      if (hasRemarks) lines.push("", "--- 前回の下書き ---", previous ?? "（なし）");
      lines.push(...remarkLines(task, step, "要求要件の本文"));
      return lines.join("\n");
    }
    case "design": {
      // 設計は、人間が承認して凍結した要求要件だけを根拠にする
      const requirements =
        task.approved.requirements?.output ?? "（承認済みの要求要件がありません）";
      const lines = [
        "あなたはソフトウェア開発の工程エージェントです。",
        "人間が承認した要求要件から、設計とテスト観点を作ってください。",
        "",
        "- 設計はMarkdownで書く（構成、データ、処理の流れ、エラー時の振る舞い、影響範囲）",
        "- 要求要件は承認済みで変更できません。要求要件に問題があれば、設計の最後に「要求要件への確認」として書く",
        "- テスト観点は、受け入れ条件をすべて網羅し、異常系と境界値を含める",
        "- テスト観点ごとに、何を確かめるか・入力（前提）・期待する結果を、第三者が検証できる具体さで書く",
        "",
        "設計の本文のあとに、テスト観点を次の形式で必ず付けてください。",
        "```json",
        `{"${VIEWPOINTS_HEADING}": [{"title": "何を確かめるか", "input": "入力・前提", "expected": "期待する結果"}]}`,
        "```",
        "",
        "--- 承認済みの要求要件 ---",
        requirements,
        "",
        "--- チケット ---",
        ticket,
      ];
      if (previous) {
        lines.push(
          "",
          "--- 前回の下書き（要求要件が変わった場合は、最新の要求要件に合わせてください） ---",
          previous,
        );
      }
      lines.push(...remarkLines(task, step, "テスト観点"));
      return lines.join("\n");
    }
    default:
      return [`工程「${step}」はまだ実装されていません。`, "", ticket].join("\n");
  }
}

export type Extracted = {
  /** 表示用の本文（sacty が読むJSONのブロックを除いたもの）。 */
  output: string;
  responses: RemarkResponse[];
  testViewpoints: TestViewpoint[];
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * エージェントの出力から、指摘への対応とテスト観点（JSONのブロック）を取り出す。
 * 読んだブロックは表示用の本文から取り除く。同じ種類のブロックが複数あれば最後のものを使う。
 * 知らない指摘のIDと、項目の欠けたテスト観点は無視する。
 */
export function extractBlocks(output: string, validRemarkIds: ReadonlySet<string>): Extracted {
  let responses: RemarkResponse[] | undefined;
  let testViewpoints: TestViewpoint[] | undefined;
  let cleaned = output;
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].reverse();
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? "");
    } catch {
      continue;
    }
    const record = (parsed ?? {}) as Record<string, unknown>;
    const list = record[RESPONSES_HEADING];
    const viewpoints = record[VIEWPOINTS_HEADING];
    let used = false;
    if (Array.isArray(list)) {
      used = true;
      responses ??= list
        .map((r) => ({ remarkId: text(r?.remarkId), text: text(r?.text) }))
        .filter((r) => r.text && validRemarkIds.has(r.remarkId));
    }
    if (Array.isArray(viewpoints)) {
      used = true;
      testViewpoints ??= viewpoints
        .map((v) => ({ title: text(v?.title), input: text(v?.input), expected: text(v?.expected) }))
        .filter((v) => v.title && v.input && v.expected)
        .map((v, i) => ({ id: `TV-${i + 1}`, ...v }));
    }
    // 後ろから取り除くので、前のブロックの位置は変わらない
    if (used) {
      const start = block.index ?? 0;
      cleaned = cleaned.slice(0, start) + cleaned.slice(start + block[0].length);
    }
  }
  return {
    output: cleaned.trim(),
    responses: responses ?? [],
    testViewpoints: testViewpoints ?? [],
  };
}
