import {
  type DaemonText,
  type FinalReview,
  message,
  type RemarkResponse,
  renderMessage,
  type StepKey,
  type Task,
  type TaskProposal,
  type TestMapping,
  type TestViewpoint,
  type Verdict,
} from "@sacty/core";

/** 記録した文（コードと引数の文言を含む）を、指示や PR の本文に入れる日本語の文にする。 */
const ja = (value: DaemonText) => renderMessage(value, "ja");

/**
 * 実行できる工程（PR作成はエージェントではなく sacty が実行する）。
 * ここに無い工程は、承認後も実行せずに待機する。
 */
export const EXECUTABLE_STEPS: readonly StepKey[] = ["requirements", "design", "implement", "pr"];

const RESPONSES_HEADING = "sacty-responses";
const VIEWPOINTS_HEADING = "sacty-test-viewpoints";
const PROPOSAL_HEADING = "sacty-change-proposal";
const VERDICT_HEADING = "sacty-verdict";
const TEST_MAP_HEADING = "sacty-test-map";
const FINAL_REVIEW_HEADING = "sacty-final-review";

/** テストの出力は、末尾のこの文字数だけプロンプトに入れる。 */
const OUTPUT_IN_PROMPT = 8_000;

function viewpointLines(viewpoints: readonly TestViewpoint[]): string[] {
  if (viewpoints.length === 0) return ["（なし）"];
  return viewpoints.map((v) =>
    [`- [${v.id}] ${v.title}`, `  - 入力：${v.input}`, `  - 期待結果：${v.expected}`].join("\n"),
  );
}

/** 人間の差し戻しの指摘（全工程・無効にしたものを除く）。 */
function humanRemarks(task: Task) {
  return task.remarks.filter((r) => !r.voided);
}

/** 直前の検証で通らなかった内容（実装のやり直しに渡す）。 */
function feedbackLines(task: Task): string[] {
  const feedback = task.verifyFeedback;
  if (!feedback) return [];
  if (feedback.kind === "tests") {
    const t = feedback.tests;
    return [
      "",
      "--- 前回の検証：テストが通りませんでした ---",
      `コマンド：${t.command}（終了コード ${t.exitCode}）`,
      ...(t.unmappedViewpoints.length > 0
        ? [`テストが対応していない観点：${t.unmappedViewpoints.join(", ")}`]
        : []),
      ...(t.note ? [`sacty の注記：${ja(t.note)}`] : []),
      "出力の末尾：",
      t.output.slice(-OUTPUT_IN_PROMPT),
    ];
  }
  const r = feedback.review;
  return [
    "",
    "--- 前回の検証：ゴールガーディアンの最終レビューに通りませんでした ---",
    ...(r.summary ? [ja(r.summary)] : []),
    ...r.viewpoints
      .filter((v) => !v.verified)
      .map((v) => `- [${v.viewpointId}] 観点を検証できていない：${ja(v.reason)}`),
    ...r.remarks
      .filter((m) => !m.notRecurred)
      .map((m) => `- [${m.remarkId}] 過去の指摘が再発している：${ja(m.reason)}`),
  ];
}

const STEP_NAME: Record<StepKey, string> = {
  requirements: "要求要件",
  design: "設計",
  implement: "実装",
  pr: "PR作成",
};

/** その工程の実行中に変更を申し出られる、承認済みの工程（その工程より前のもの）。 */
export function changeableSteps(task: Task, step: StepKey): StepKey[] {
  const index = task.steps.findIndex((s) => s.key === step);
  return task.steps
    .slice(0, Math.max(index, 0))
    .map((s) => s.key)
    .filter((key) => task.approved[key]);
}

/** 承認済みの成果物の変更を申し出る方法。申し出られる工程が無ければ何も足さない。 */
function proposalLines(task: Task, step: StepKey): string[] {
  const targets = changeableSteps(task, step);
  if (targets.length === 0) return [];
  return [
    "",
    `--- 承認済みの成果物（${targets.map((t) => STEP_NAME[t]).join("・")}）の変更の申し出 ---`,
    "承認済みの成果物は凍結されていて、あなたは変更できません。",
    "それに従うとゴールを達成できないと事実で示せる場合だけ、変更を申し出てください。",
    "申し出はゴールガーディアンが判定します。作業を楽にするための変更は認められません。",
    "申し出は1回の実行で1件までです。次の形式で、本文のあとに付けてください。",
    "```json",
    `{"${PROPOSAL_HEADING}": {"target": "${targets.join('" または "')}", "reason": "変更したい理由", "facts": ["根拠となる事実（仕様、コード、実行結果など）"], "proposed": "変更後の成果物の全文"}}`,
    "```",
    "申し出をしても、この工程の成果物は、いまの承認済みの成果物に従って作ってください。",
  ];
}

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
/**
 * 要求要件・設計の工程で、作業領域にある対象リポジトリのコードについて伝える（PBI-15）。
 * 起点のコミットのコードを読み取り専用で渡しているので、読むだけにさせる。
 */
function codeLines(task: Task): string[] {
  if (!task.repository) return [];
  return [
    "",
    `作業領域（カレントディレクトリ）に、対象リポジトリ（${task.repository.url}）の起点のコミット（${task.repository.baseCommit.slice(0, 7)}）のコードがあります。既存のコードを読み、構成・規約・影響範囲を踏まえて書いてください。`,
    "この工程ではコードを読むだけです（作業領域は読み取り専用で、変更はできません）。",
  ];
}

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
        ...codeLines(task),
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
        "- テスト観点は、受け入れ条件をすべて網羅し、異常系と境界値を含める",
        "- テスト観点ごとに、何を確かめるか・入力（前提）・期待する結果を、第三者が検証できる具体さで書く",
        ...codeLines(task),
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
          "",
          "--- 前回のテスト観点（人間の指摘は、この TV-n の ID で観点を指すことがあります） ---",
          ...(task.testViewpoints.length > 0
            ? task.testViewpoints.map((v) =>
                [
                  `- [${v.id}] ${v.title}`,
                  `  - 入力：${v.input}`,
                  `  - 期待結果：${v.expected}`,
                ].join("\n"),
              )
            : ["（なし）"]),
          "",
          "テスト観点は、直さないものも含めて全件を出し直してください（ID は sacty が振り直します）。",
        );
      }
      lines.push(...remarkLines(task, step, "テスト観点"), ...proposalLines(task, step));
      return lines.join("\n");
    }
    case "implement": {
      // 実装への差し戻しの指摘は、対応を答えてもらう（下の remarkLines）。ほかの工程の指摘は再発の防止に使う
      const remarks = humanRemarks(task).filter((r) => r.step !== "implement");
      const lines = [
        "あなたはソフトウェア開発の工程エージェントです。",
        "作業ディレクトリは実装の対象リポジトリです。人間が承認した要求要件と設計に従って実装し、",
        "テスト観点ごとに、その観点を検証するテストを書いてください。",
        "",
        "- テストは、観点の入力を与え、期待結果を確かめるものにする（観点を検証しない形だけのテストにしない）",
        "- 書いたテストは、リポジトリのテストのコマンドで実行されるようにする",
        "- コミットやプッシュはしない（sacty が行います）",
        "- 実装の説明をMarkdownで書き、そのあとに、観点ごとのテストの対応を次の形式で必ず付ける",
        "```json",
        `{"${TEST_MAP_HEADING}": [{"viewpointId": "TV-1", "tests": ["テストのファイル › テストの名前"]}]}`,
        "```",
        "",
        "--- 承認済みの要求要件 ---",
        task.approved.requirements?.output ?? "（なし）",
        "",
        "--- 承認済みの設計 ---",
        task.approved.design?.output ?? "（なし）",
        "",
        "--- テスト観点（承認済み・すべてにテストを対応させる） ---",
        ...viewpointLines(task.approved.design?.testViewpoints ?? []),
      ];
      if (remarks.length > 0) {
        lines.push(
          "",
          "--- これまでの人間の指摘（再発させないでください） ---",
          ...remarks.map((r) => `- [${r.id}] ${r.text}`),
        );
      }
      if (previous) lines.push("", "--- 前回の実装の説明 ---", previous);
      lines.push(
        ...feedbackLines(task),
        ...remarkLines(task, step, "観点ごとのテストの対応"),
        ...proposalLines(task, step),
      );
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
  /** 承認済みの成果物への変更の申し出（1件まで）。 */
  proposal?: ExtractedProposal;
  /** 実装の工程が申告した、観点とテストの対応。 */
  testMap: TestMapping[];
};

export type ExtractedProposal = Pick<
  TaskProposal,
  "target" | "reason" | "facts" | "proposed" | "testViewpoints"
>;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * エージェントの出力から、指摘への対応とテスト観点（JSONのブロック）を取り出す。
 * 読んだブロックは表示用の本文から取り除く。同じ種類のブロックが複数あれば最後のものを使う。
 * 知らない指摘のIDと、項目の欠けたテスト観点は無視する。
 */
export function extractBlocks(
  output: string,
  validRemarkIds: ReadonlySet<string>,
  /** 変更を申し出られる工程。ここに無い工程への申し出は無視する。 */
  changeable: readonly StepKey[] = [],
): Extracted {
  let responses: RemarkResponse[] | undefined;
  let testViewpoints: TestViewpoint[] | undefined;
  let proposal: ExtractedProposal | undefined;
  let proposalSeen = false;
  let testMap: TestMapping[] | undefined;
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
    const proposed = record[PROPOSAL_HEADING];
    const map = record[TEST_MAP_HEADING];
    let used = false;
    if (Array.isArray(map)) {
      used = true;
      testMap ??= map
        .map((m) => {
          const r = (m ?? {}) as Record<string, unknown>;
          const tests = Array.isArray(r.tests) ? r.tests.map(text).filter(Boolean) : [];
          return { viewpointId: text(r.viewpointId), tests };
        })
        .filter((m) => m.viewpointId && m.tests.length > 0);
    }
    if (proposed && typeof proposed === "object" && !Array.isArray(proposed)) {
      used = true;
      if (!proposalSeen) {
        proposalSeen = true;
        proposal = toProposal(proposed as Record<string, unknown>, changeable);
      }
    }
    if (Array.isArray(list)) {
      used = true;
      responses ??= list
        .map((r) => ({ remarkId: text(r?.remarkId), text: text(r?.text) }))
        .filter((r) => r.text && validRemarkIds.has(r.remarkId));
    }
    if (Array.isArray(viewpoints)) {
      used = true;
      testViewpoints ??= toViewpoints(viewpoints);
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
    proposal,
    testMap: testMap ?? [],
  };
}

function toViewpoints(list: unknown[]): TestViewpoint[] {
  return list
    .map((v) => {
      const r = (v ?? {}) as Record<string, unknown>;
      return { title: text(r.title), input: text(r.input), expected: text(r.expected) };
    })
    .filter((v) => v.title && v.input && v.expected)
    .map((v, i) => ({ id: `TV-${i + 1}`, ...v }));
}

function toProposal(
  raw: Record<string, unknown>,
  changeable: readonly StepKey[],
): ExtractedProposal | undefined {
  const target = changeable.find((s) => s === raw.target);
  const reason = text(raw.reason);
  const proposed = text(raw.proposed);
  if (!target || !reason || !proposed) return undefined;
  const facts = Array.isArray(raw.facts) ? raw.facts.map(text).filter(Boolean) : [];
  const viewpoints =
    target === "design" && Array.isArray(raw.testViewpoints)
      ? toViewpoints(raw.testViewpoints)
      : undefined;
  return {
    target,
    reason,
    facts,
    proposed,
    ...(viewpoints && viewpoints.length > 0 ? { testViewpoints: viewpoints } : {}),
  };
}

/**
 * ゴールガーディアンへの指示。判定ごとに新しいセッションで実行し、承認済みの要求要件・設計、
 * 変更理由、根拠となる事実（と変更後の全文）だけを渡す。チケットや工程の経緯、過去の判定は渡さない。
 */
export function buildGuardianPrompt(task: Task, proposal: TaskProposal): string {
  const approved = (["requirements", "design"] as const)
    .filter((step) => task.approved[step])
    .flatMap((step) => [
      "",
      `--- 承認済みの${STEP_NAME[step]} ---`,
      task.approved[step]?.output ?? "",
    ]);
  return [
    "あなたはゴールガーディアンです。人間が承認した成果物（ゴール）を守る立場で、",
    "工程エージェントからの変更の申し出を判定してください。",
    "",
    "- 承認：変更しなければゴールを達成できないことが、根拠となる事実で裏付けられている。",
    "  かつ、変更後の全文がゴールの意図を損なわない",
    "- 却下：事実の裏付けが無い、作業を楽にするための変更、またはゴールの意図を損なう変更",
    "- 判定できない：事実が足りない、または人間の判断が必要な価値判断を含む",
    "",
    ...approved,
    "",
    `--- 変更の申し出（${STEP_NAME[proposal.target]}への変更） ---`,
    `理由：${proposal.reason}`,
    "根拠となる事実：",
    ...(proposal.facts.length > 0 ? proposal.facts.map((f) => `- ${f}`) : ["（なし）"]),
    "",
    "--- 変更後の全文 ---",
    proposal.proposed,
    ...(proposal.testViewpoints
      ? [
          "",
          "--- 変更後のテスト観点 ---",
          ...proposal.testViewpoints.map(
            (v) => `- [${v.id}] ${v.title}（入力：${v.input} / 期待結果：${v.expected}）`,
          ),
        ]
      : []),
    "",
    "判定を、次の形式で必ず出してください。",
    "```json",
    `{"${VERDICT_HEADING}": {"verdict": "approved または rejected または undecidable", "reason": "判定の理由"}}`,
    "```",
  ].join("\n");
}

/** ゴールガーディアンの出力から判定を読む。読めなければ判定できなかったものとして扱う。 */
export function extractVerdict(output: string): { verdict: Verdict; reason: DaemonText } {
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].reverse();
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1] ?? "") as Record<string, unknown>;
      const v = (parsed?.[VERDICT_HEADING] ?? {}) as Record<string, unknown>;
      const verdict = ["approved", "rejected", "undecidable"].find((x) => x === v.verdict);
      const reason = text(v.reason);
      if (verdict && reason) return { verdict: verdict as Verdict, reason };
    } catch {
      // 次のブロックを試す
    }
  }
  return { verdict: "undecidable", reason: message("guardian.verdictUnreadable") };
}

/**
 * ゴールガーディアンの最終レビューへの指示。判定ごとに新しいセッションで実行する。
 * 承認済みの要求要件・設計・テスト観点、差分、観点とテストの対応、テストの結果、
 * 人間の差し戻しの指摘を渡す。過去の最終レビューの判定や、工程エージェントの説明は渡さない。
 */
export function buildFinalReviewPrompt(task: Task, diff: string): string {
  const viewpoints = task.approved.design?.testViewpoints ?? [];
  const remarks = humanRemarks(task);
  const tests = task.lastTests;
  return [
    "あなたはゴールガーディアンです。人間が承認した成果物（ゴール）を守る立場で、実装を最終レビューしてください。",
    "",
    "- テスト観点ごとに、対応するテストがその観点を本当に検証しているか（入力を与え、期待結果を確かめているか）を判定する",
    "- テストが通っていても、観点を検証していない（形だけ・期待結果を確かめていない・対応が違う）なら不合格にする",
    "- 人間の過去の指摘ごとに、指摘された問題が今回の実装で再発していないかを判定する",
    "- 判断の根拠は、下の差分とテストの結果だけにする",
    "",
    "--- 承認済みの要求要件 ---",
    task.approved.requirements?.output ?? "（なし）",
    "",
    "--- 承認済みの設計 ---",
    task.approved.design?.output ?? "（なし）",
    "",
    "--- テスト観点 ---",
    ...viewpointLines(viewpoints),
    "",
    "--- 観点とテストの対応（工程エージェントの申告） ---",
    ...(task.testMap.length > 0
      ? task.testMap.map((m) => `- [${m.viewpointId}] ${m.tests.join(" / ")}`)
      : ["（なし）"]),
    "",
    "--- テストの結果（sacty が実行） ---",
    tests
      ? `コマンド：${tests.command}（終了コード ${tests.exitCode}）\n出力の末尾：\n${tests.output.slice(-OUTPUT_IN_PROMPT)}`
      : "（なし）",
    "",
    "--- 人間の過去の指摘 ---",
    ...(remarks.length > 0 ? remarks.map((r) => `- [${r.id}] ${r.text}`) : ["（なし）"]),
    "",
    "--- 差分 ---",
    diff || "（差分がありません）",
    "",
    "判定を、次の形式で必ず出してください。観点と指摘は、上のものをすべて含めてください。",
    "```json",
    `{"${FINAL_REVIEW_HEADING}": {"viewpoints": [{"id": "TV-1", "verified": true, "reason": "理由"}], "remarks": [{"id": "指摘のID", "notRecurred": true, "reason": "理由"}], "summary": "全体の所見"}}`,
    "```",
  ].join("\n");
}

/**
 * 最終レビューの出力を読む。判定の無い観点・指摘は不合格として扱い、
 * すべての観点が検証済みで、すべての指摘が再発なしのときだけ合格にする。
 */
export function extractFinalReview(
  output: string,
  viewpointIds: readonly string[],
  remarkIds: readonly string[],
): Pick<FinalReview, "passed" | "viewpoints" | "remarks" | "summary"> {
  let raw: Record<string, unknown> | undefined;
  for (const block of [...output.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].reverse()) {
    try {
      const parsed = JSON.parse(block[1] ?? "") as Record<string, unknown>;
      const review = parsed?.[FINAL_REVIEW_HEADING];
      if (review && typeof review === "object" && !Array.isArray(review)) {
        raw = review as Record<string, unknown>;
        break;
      }
    } catch {
      // 次のブロックを試す
    }
  }
  const byId = (list: unknown) => {
    const map = new Map<string, Record<string, unknown>>();
    if (!Array.isArray(list)) return map;
    for (const item of list) {
      const r = (item ?? {}) as Record<string, unknown>;
      const id = text(r.id);
      if (id && !map.has(id)) map.set(id, r);
    }
    return map;
  };
  const vs = byId(raw?.viewpoints);
  const rs = byId(raw?.remarks);
  const missing = raw ? message("review.verdictMissing") : message("review.unreadable");
  const viewpoints = viewpointIds.map((id) => {
    const r = vs.get(id);
    return {
      viewpointId: id,
      verified: r?.verified === true,
      reason: text(r?.reason) || missing,
    };
  });
  const remarks = remarkIds.map((id) => {
    const r = rs.get(id);
    return {
      remarkId: id,
      notRecurred: r?.notRecurred === true,
      reason: text(r?.reason) || missing,
    };
  });
  const passed =
    raw !== undefined && viewpoints.every((v) => v.verified) && remarks.every((r) => r.notRecurred);
  return {
    passed,
    viewpoints,
    remarks,
    summary: text(raw?.summary) || (raw ? "" : missing),
  };
}

/** 表のセルに入れられるよう、改行と縦棒を置き換える。 */
const cell = (value: string) => value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/**
 * sacty が作るPRの本文。承認済みの要求要件、観点とテストの対応、テストの結果、
 * ゴールガーディアンの最終レビューを載せる（人間が成果物を確かめるための材料）。
 */
export function buildPullRequestBody(task: Task): string {
  const viewpoints = task.approved.design?.testViewpoints ?? [];
  const review = task.lastReview;
  const tests = task.lastTests;
  const mapped = new Map(task.testMap.map((m) => [m.viewpointId, m.tests]));
  return [
    `sacty のタスク「${task.title}」の成果物です（sacty task ${task.id}）。`,
    "",
    // 取り込んだ Issue と同じリポジトリの PR なら、マージで Issue を閉じる
    ...(task.source?.kind === "github_issue" ? [`Closes #${task.source.number}`, ""] : []),
    "## 要求要件（人間が承認済み）",
    "",
    task.approved.requirements?.output ?? "（なし）",
    "",
    "## 観点 → テスト → 実行結果",
    "",
    "| 観点 | 入力 | 期待結果 | テスト | 最終レビュー |",
    "| --- | --- | --- | --- | --- |",
    ...viewpoints.map((v) => {
      const judged = review?.viewpoints.find((r) => r.viewpointId === v.id);
      return `| ${v.id} ${cell(v.title)} | ${cell(v.input)} | ${cell(v.expected)} | ${cell((mapped.get(v.id) ?? []).join(" / ") || "（なし）")} | ${judged ? `${judged.verified ? "✅" : "❌"} ${cell(ja(judged.reason))}` : "（なし）"} |`;
    }),
    "",
    tests
      ? `テスト：\`${cell(tests.command)}\` → ${tests.passed ? "合格" : "不合格"}（終了コード ${tests.exitCode}）`
      : "テスト：（未実行）",
    "",
    "## ゴールガーディアンの最終レビュー",
    "",
    review ? `${review.passed ? "合格" : "不合格"}。${ja(review.summary)}` : "（なし）",
    ...(review && review.remarks.length > 0
      ? [
          "",
          ...review.remarks.map(
            (r) =>
              `- ${r.remarkId}：${r.notRecurred ? "再発なし" : "再発している"}（${ja(r.reason)}）`,
          ),
        ]
      : []),
    "",
    "---",
    "この PR は sacty が作成しました。sacty の成果物チェックで承認・差し戻しをしてください。",
  ].join("\n");
}
