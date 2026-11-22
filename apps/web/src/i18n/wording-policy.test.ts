import { describe, expect, it } from "vitest";
import { messagesFor } from "./index";
import type { Locale } from "./locale";

/**
 * 画面の文言の規則（docs/README.md の「画面の文言の書き方」。PBI-117）を、辞書の文字列の葉について機械的に確かめる。
 * - 本文（常に見える文言）：改行を含まない。長すぎない。文（案内・エラー）には、数値・ID・形式名でない括弧書きの注釈を入れない。
 *   ラベル・見出し・選択肢には、長い括弧書きの注釈を入れない。
 * - 補足（キーが hint・*Hint のもの）：本文より長くてよいが、上限がある。*Help は常に見える判断の案内なので本文として確かめる。
 * 引数を取る文言（関数）は呼び出さないと文にならないので、ここでは確かめない（レビューで見る）。
 */

/** 本文の上限（文字数）。目安は日本語 40・英語 80 だが、エラー・判断の案内は 2 文まで認めるので、ここでは上限を広く取る。 */
const BODY_MAX = { ja: 60, en: 130 } as const;
/** 補足の上限（文字数）。 */
const HINT_MAX = { ja: 150, en: 320 } as const;
/** 本文に認める括弧書きの長さ（文字数）。数値・ID・短い語を添える程度。 */
const PAREN_MAX = { ja: 14, en: 30 } as const;

/**
 * 改行・長さの規則の例外（キーのパス）。理由を添える。足すときは、本文に残す理由が「判断に要る」「エラー」のどちらかであること。
 * 括弧の規則は、ここにあるキーにも当てる（括弧の例外は PAREN_EXCEPTIONS）。
 */
const EXCEPTIONS: Record<string, string> = {
  // 中止・判断を求める場面の案内：何が起きたか・何を決めるかの2文（判断に要る）
  "task.gate.noChangesHelp": "判断の案内。何が起きた・何を決めるの2文",
  "task.gate.prMergedOutdatedHelp": "判断の案内。何が起きた・次に何が起きるの2文",
  "task.gate.integrateHelp": "判断の案内。承認と差し戻しの結果の2文",
  "review.gate.operationExecutedHelp": "判断の案内。できないことと、することの2文",
  "review.gate.notReproducedHelp": "判断の案内。何が起きた・何をするの2文",
  "review.gate.noChangesHelp": "判断の案内。何が起きた・承認と差し戻しの結果の2文",
  "review.gate.prMergedOutdated": "判断の案内。何が起きた・次に何が起きるの2文",
  "parts.changeDecision.requirementsHelp": "判断の案内。認める・認めないの結果の2文",
  "parts.changeDecision.designHelp": "判断の案内。認める・認めないの結果の2文",
  "parts.implementation.noTestsSkipped": "検証の状態。何をしていない・何から判定するの2文",
  "parts.resume.ticketNoRepo": "エラー。何が無い・何をするの2文",
  "forms.task.templateSetupNote": "テンプレートを選んだときの説明。何をする・何を決めるの2文",
  "forms.task.templateDocsSetupNote": "テンプレートを選んだときの説明。何をする・何を決めるの2文",
  "forms.task.noRepository": "エラー。何が無い・何をするの2文",
  "projects.editor.ticketsNoPlatforms": "エラー。何が無い・何をするの2文",
  "labels.pauseHelp.usage_limit": "一時停止の案内。何が起きた・再開すると何が起きるの2文",
  "labels.pauseHelp.error": "一時停止の案内。何が起きた・再開すると何が起きるの2文",
  "labels.pauseHelp.verification": "一時停止の案内。何が起きた・何をするの2文",
  "labels.pauseHelp.child_cancelled": "一時停止の案内。再開・中止の結果の2文",
  "labels.event.AgentSessionNotArchived": "作業履歴の1行。理由を含む",
  "labels.event.GuardianMissed": "作業履歴の1行。何が起きたか",
  "labels.event.NoChangesFound": "作業履歴の1行。理由を含む",
  "labels.event.TestsSkipped": "作業履歴の1行。理由を含む",
  "runLog.unfinished": "状態と、考えられる理由の2文",
  "runLog.notFoundHelp": "無い理由の案内",
  "runLog.agentFiles.notArchived.container_not_confirmed": "写していない理由の注記",
  "runLog.agentFiles.notArchived.secret_file_too_large": "写していない理由の注記",
  "task.orchestratorSession.notSaved": "何が起きた・次に何が起きるの2文",
  "task.deployment.suppressed.duplicate": "作らなかった理由",
  "common.daemon.notConfigured": "エラー。何が無い・何をするの2文",
  "common.daemon.unreachable": "エラー。何が起きた・何をするの2文",
  "common.action.daemonDown": "エラー。何が起きた・何をするの2文",
  "common.action.createFailed": "エラー。何が起きた・何をするの2文",
  "common.action.resumeFailed": "エラー。何が起きた・何をするの2文",
  "common.action.fileTooLarge": "エラー。何が起きた・何をするの2文",
  "common.action.notJson": "エラー。何が起きた・何をするの2文",
  "settings.intakeOff": "状態と理由の2文",
  "settings.ticketsOff": "状態と理由の2文",
  "projects.preview.unavailable": "エラー。何が起きた・何をするの2文",
  "projects.intake.noLabel": "状態と理由の2文",
  "task.images.unavailable": "エラー。何が起きた・何をするの2文",
};

/**
 * 括弧の規則の例外（キーのパス）。理由を添える。ここにあるキーだけ、括弧の確かめ（文の括弧の中身・ラベルの括弧の長さ）を外す。
 * 足すときは、括弧が要る理由（見出し・ラベルに添える語など）を書くこと。注釈を入れたいだけなら、文に直す。
 */
const PAREN_EXCEPTIONS: Record<string, string> = {
  // 役割の見出し：何の判断かを括弧で添える
  "runLog.roles.guardian": "見出し。括弧で判断の種類を添える",
  "runLog.roles.final-review": "見出し。括弧で判断の種類を添える",
  "runLog.roles.rework": "見出し。括弧で判断の種類を添える",
  "projects.editor.excluded": "見出し。括弧で理由を添える",
  // 選択肢・ラベルに添える説明（何を含むか・どんな値か）。名前の中の "." を含む
  "task.images.defaultDescription": "選択肢の説明。括弧で中身（名前の一覧）を添える",
  "projects.editor.githubForContext": "ラベルに添える語。何のための選択かを括弧で添える",
  "projects.editor.githubForShared": "ラベルに添える語。何のための選択かを括弧で添える",
  "projects.editor.sharedRepo": "ラベル。括弧で書き方を添える",
  "settings.notifyApi": "選択肢。括弧で送り方（API の名前）を添える",
  "runLog.clipped": "省略の印。括弧で理由を添える",
};

/** 文の括弧に認める形式名・コード名（括弧の中に書いてよい語）。 */
const FORMAT_NAMES = new Set([
  "JSONL",
  "JSON",
  "YAML",
  "Markdown",
  "CSV",
  "HTML",
  "SVG",
  "PNG",
  "PDF",
  "CLI",
  "API",
  "URL",
]);

type Leaf = { path: string; text: string };

function leaves(value: unknown, path: string, out: Leaf[]): void {
  if (typeof value === "string") {
    out.push({ path, text: value });
    return;
  }
  if (typeof value === "function") return;
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) leaves(child, `${path}.${key}`, out);
  }
}

function isHint(path: string): boolean {
  const key = path.split(".").at(-1) ?? "";
  return key === "hint" || key.endsWith("Hint");
}

/** 括弧書き（全角・半角）の中の長さの最大。 */
function longestParenthesis(text: string): number {
  const inner = [...text.matchAll(/[（(]([^（()）]*)[)）]/g)].map((m) => m[1] ?? "");
  return Math.max(0, ...inner.map((s) => s.length));
}

function collect(locale: Locale): Leaf[] {
  const out: Leaf[] = [];
  const { locale: _, ...dictionaries } = messagesFor(locale);
  leaves(dictionaries, "", out);
  return out.map((l) => ({ ...l, path: l.path.slice(1) }));
}

/** 括弧書き（全角・半角）の中身を、閉じた順に取り出す。入れ子は、内側と、内側を含む外側の両方を返す。 */
function parentheses(text: string): string[] {
  const out: string[] = [];
  const opens: number[] = [];
  [...text].forEach((ch, i) => {
    if (ch === "（" || ch === "(") opens.push(i);
    else if ((ch === "）" || ch === ")") && opens.length > 0) {
      const start = opens.pop() as number;
      out.push([...text].slice(start + 1, i).join(""));
    }
  });
  return out;
}

/** 括弧書きを取り除いた、括弧の外の本文。 */
function outsideParentheses(text: string): string {
  let rest = text;
  for (let before = ""; before !== rest; ) {
    before = rest;
    rest = rest.replace(/[（(][^（()）]*[)）]/g, "");
  }
  return rest;
}

/**
 * 文か（括弧の外に「。」、後ろに空白か末尾が続く "."、または「？」「！」「…」（英語は "?" "!" "…"）で終わる）。
 * 語の中の "."（Node.js）と略語（e.g.・i.e.・etc.）の "." は数えない。括弧の中は見ない。
 */
function isSentence(text: string): boolean {
  const outside = outsideParentheses(text).replace(/\b(?:e\.g\.|i\.e\.|etc\.)/g, "");
  return /。|\.(?:\s|$)/.test(outside) || /[？！…?!]\s*$/.test(outside);
}

/** 数字と単位・助数詞（「3 件」「30 秒」「2 MB」）。単位は一覧の語だけで、数字に続く任意の語（「2件の指摘は未対応」）は認めない。 */
const NUMBER_WITH_UNIT =
  /^\d[\d,.]*\s*(?:件|回|秒|分|時間|日|文字|行|個|つ|人|%|ms|s|KB|MB|GB|items?|times?|seconds?|minutes?|hours?|days?|chars?|characters?|lines?)?$/u;

/** 文の括弧に認める中身：数字と単位・助数詞、ID の形（前に付ける語は ID の種類を示す語だけ）、形式名の一覧の語。 */
function isAllowedParenthesis(inner: string): boolean {
  const s = inner.replace(/`/g, "").trim();
  if (NUMBER_WITH_UNIT.test(s)) return true;
  if (/^(?:(?:PR|PBI|Issue)\s?)?(?:#\d+|[A-Z][A-Z0-9]*-\d+)$/.test(s)) return true;
  const names = s.split(/[・,、\s]+/).filter(Boolean);
  return names.length > 0 && names.every((n) => FORMAT_NAMES.has(n));
}

type Pair = { path: string; ja: string; en: string };
type ParenViolation = { path: string; kind: "sentence" | "label"; locale: Locale; text: string };

/**
 * 括弧の確かめ。日英の同じキーを組にして判定する。補足（hint・*Hint）と、括弧の例外のキーは確かめない。
 * - どちらかが文なら、両方の括弧の中身を、認める中身（数字と単位・ID・形式名）だけにする（長さによらない）。
 * - どちらも文でない（ラベル・見出し・選択肢）なら、括弧の長さを今の基準（日 14 字・英 30 字以上で失敗）で確かめる。
 */
function parenViolations(pairs: Pair[], exceptions: Record<string, string>): ParenViolation[] {
  const out: ParenViolation[] = [];
  for (const pair of pairs) {
    if (isHint(pair.path) || pair.path in exceptions) continue;
    const sentence = isSentence(pair.ja) || isSentence(pair.en);
    for (const locale of ["ja", "en"] as const) {
      const text = pair[locale];
      const bad = sentence
        ? parentheses(text).some((inner) => !isAllowedParenthesis(inner))
        : longestParenthesis(text) >= PAREN_MAX[locale];
      if (bad) out.push({ path: pair.path, kind: sentence ? "sentence" : "label", locale, text });
    }
  }
  return out;
}

/** 辞書（日英）の葉を、キーごとの組にする。 */
function pairsOf(): Pair[] {
  const en = new Map(collect("en").map((l) => [l.path, l.text]));
  return collect("ja").map((l) => ({ path: l.path, ja: l.text, en: en.get(l.path) ?? "" }));
}

describe("画面の文言の規則（PBI-117）", () => {
  for (const locale of ["ja", "en"] as const) {
    describe(locale, () => {
      const all = collect(locale);
      const body = all.filter((l) => !isHint(l.path) && !(l.path in EXCEPTIONS));
      const hints = all.filter((l) => isHint(l.path) && !(l.path in EXCEPTIONS));

      it("本文は改行を含まない（段落で説明しない）", () => {
        expect(body.filter((l) => l.text.includes("\n")).map((l) => l.path)).toEqual([]);
      });

      it(`本文は ${BODY_MAX[locale]} 文字以内`, () => {
        const long = body.filter((l) => l.text.length > BODY_MAX[locale]);
        expect(long.map((l) => `${l.path}: ${l.text}`)).toEqual([]);
      });

      it(`補足は ${HINT_MAX[locale]} 文字以内`, () => {
        const long = hints.filter((l) => l.text.length > HINT_MAX[locale]);
        expect(long.map((l) => `${l.path}: ${l.text}`)).toEqual([]);
      });

      it("補足は改行を含まない", () => {
        expect(hints.filter((l) => l.text.includes("\n")).map((l) => l.path)).toEqual([]);
      });
    });
  }

  it("例外の一覧にある文言は、実在する", () => {
    const paths = new Set(collect("ja").map((l) => l.path));
    expect(Object.keys(EXCEPTIONS).filter((p) => !paths.has(p))).toEqual([]);
    expect(Object.keys(PAREN_EXCEPTIONS).filter((p) => !paths.has(p))).toEqual([]);
  });

  it("括弧の例外の一覧は、改行・長さの例外の一覧と重ならない", () => {
    expect(Object.keys(PAREN_EXCEPTIONS).filter((p) => p in EXCEPTIONS)).toEqual([]);
  });

  it("辞書の文の括弧は認める中身だけ、ラベルの括弧は日 14 字・英 30 字未満（括弧の例外を除く）", () => {
    const violations = parenViolations(pairsOf(), PAREN_EXCEPTIONS);
    expect(violations.map((v) => `${v.kind} ${v.path} [${v.locale}]: ${v.text}`)).toEqual([]);
  });
});

describe("括弧の判定（固定の入力）", () => {
  const pair = (path: string, ja: string, en: string): Pair => ({ path, ja, en });
  const run = (pairs: Pair[], exceptions: Record<string, string> = PAREN_EXCEPTIONS) =>
    parenViolations(pairs, exceptions);

  it("直す前の live.stale は、文の括弧の違反になる", () => {
    const v = run([
      pair(
        "common.live.stale",
        "デーモンに届きません。`sacty up` が動いているか確認してください（表示は最後に取得した内容）。",
        "The daemon cannot be reached. Check that `sacty up` is running (showing the last data).",
      ),
    ]);
    expect(v.map((x) => [x.path, x.kind, x.locale])).toEqual([
      ["common.live.stale", "sentence", "ja"],
      ["common.live.stale", "sentence", "en"],
    ]);
  });

  it("直した後の live.stale は、括弧が無く通る", () => {
    expect(
      run([
        pair(
          "common.live.stale",
          "デーモンに届かないため、最後に取得した内容を表示しています。`sacty up` が動いているか確認してください。",
          "The daemon cannot be reached, so the last fetched data is shown. Check that `sacty up` is running.",
        ),
      ]),
    ).toEqual([]);
  });

  it("改行・長さの例外（EXCEPTIONS）のキーの文も、注釈の括弧は落ちる", () => {
    const key = "common.daemon.unreachable";
    expect(key in EXCEPTIONS).toBe(true);
    const v = run([
      pair(
        key,
        "デーモンに届きません（接続の失敗）。確認してください。",
        "Cannot reach (a failure). Check it.",
      ),
    ]);
    expect(v.map((x) => x.kind)).toEqual(["sentence", "sentence"]);
  });

  it("「？」で終わる文の注釈の括弧は落ちる", () => {
    const v = run([
      pair(
        "x.ask",
        "この設定を保存しますか（あとで変えられる）？",
        "Save this setting (you can change it later)?",
      ),
    ]);
    expect(v.map((x) => [x.kind, x.locale])).toEqual([
      ["sentence", "ja"],
      ["sentence", "en"],
    ]);
  });

  it("認める括弧の中身（数字と単位・ID・形式名）だけを通し、注釈は落とす", () => {
    const ok = [
      pair("x.count", "対象は絞り込みました（3 件）。", "Narrowed down (3 items)."),
      pair("x.pr", "PR を作りました（PR #12）。", "Opened the PR (PR #12)."),
      pair("x.id", "起票しました（PBI-477）。", "Filed it (PBI-477)."),
      pair("x.format", "出来事を保存しました（`JSONL`）。", "Saved the events (`JSONL`)."),
    ];
    expect(run(ok)).toEqual([]);
    const ng = run([
      pair(
        "x.note1",
        "種類を選んでください（補足・差し替え）。",
        "Choose a kind (supplement or replacement).",
      ),
      pair(
        "x.note2",
        "読み込みました（表示は最後に取得した内容）。",
        "Loaded (shown as last fetched).",
      ),
    ]);
    expect(ng.map((x) => x.path)).toEqual(["x.note1", "x.note1", "x.note2", "x.note2"]);
  });

  it("数字で始まる注釈の括弧は落ちる", () => {
    const v = run([
      pair("x.n1", "完了しました（2件の指摘は未対応）。", "Done (2 findings are open)."),
      pair("x.n2", "成功しました（3回目の再試行で成功）。", "Succeeded (on the 3rd retry)."),
    ]);
    expect(v.map((x) => x.path)).toEqual(["x.n1", "x.n1", "x.n2", "x.n2"]);
  });

  it("「！」「…」・英語の ?・! で終わる文の注釈の括弧も落ち、etc.・i.e. の . は文の終わりに数えない", () => {
    const v = run([
      pair("x.e1", "保存しました（あとで変えられる）！", "Saved (changeable later)!"),
      pair("x.e2", "読み込んでいます（少し待つ）…", "Loading (wait a bit)…"),
      pair("x.e3", "対象（Codex など）", "Targets (Codex, etc.)"),
      pair("x.e4", "種類（i.e. 補足）", "Kind (i.e. a note)"),
    ]);
    expect(v.map((x) => x.path)).toEqual(["x.e1", "x.e1", "x.e2", "x.e2"]);
  });

  it("括弧の外の略語（e.g.・i.e.・etc.）の . は文と数えず、括弧の外の文末の . は文と数える", () => {
    expect(isSentence("Use a tool, e.g. Codex")).toBe(false);
    expect(isSentence("Targets, i.e. tools, etc.")).toBe(false);
    expect(isSentence("Use a tool, e.g. Codex. Then wait.")).toBe(true);
  });

  it("入れ子の括弧は、外側の中身も確かめる（内側が数字でも、外側が注釈なら落ちる）", () => {
    expect(parentheses("表示（最後（3件）に取得）")).toEqual(["3件", "最後（3件）に取得"]);
    const v = run([
      pair(
        "x.nest",
        "表示します（最後（3件）に取得した内容）。",
        "Shown (last (3 items) fetched).",
      ),
      pair("x.nestok", "表示します（3件）。", "Shown (3 items)."),
    ]);
    expect(v.map((x) => x.path)).toEqual(["x.nest", "x.nest"]);
  });

  it("ラベルの括弧は、日 13 字・英 29 字は通り、日 14 字・英 30 字は落ちる", () => {
    const ja13 = "あ".repeat(13);
    const ja14 = "あ".repeat(14);
    const en29 = "a".repeat(29);
    const en30 = "a".repeat(30);
    expect(run([pair("x.ok", `ラベル（${ja13}）`, `Label (${en29})`)])).toEqual([]);
    const v = run([pair("x.ng", `ラベル（${ja14}）`, `Label (${en30})`)]);
    expect(v.map((x) => [x.kind, x.locale])).toEqual([
      ["label", "ja"],
      ["label", "en"],
    ]);
  });

  it('語の中の "."・e.g.・括弧の中だけの「。」は文と数えない（ラベルの長さの基準だけが当たる）', () => {
    const labels = [
      pair(
        "x.image",
        "既定のイメージ（Node.js・Claude Code・Codex）",
        "Default image (Node.js, Claude Code, Codex)",
      ),
      pair(
        "review.causeBaseChanged",
        "ベースブランチの変更による競合（先に別の PR が取り込まれた）",
        "A conflict from changes to the base branch (e.g. an earlier PR merged)",
      ),
      pair("x.history", "不安定なテスト（失敗した。再実行した）", "Flaky test (failed; rerun)"),
    ];
    expect(labels.map((l) => [isSentence(l.ja), isSentence(l.en)])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
    // 括弧が長いラベル（日 14 字以上）はラベルの違反になるが、文の違反にはならない
    expect(run(labels).map((x) => [x.path, x.kind, x.locale])).toEqual([
      ["x.image", "label", "ja"],
      ["review.causeBaseChanged", "label", "ja"],
    ]);
    // 括弧が長いラベルは、ラベルの違反として落ちる
    const long = run([pair("x.long", `ラベル（${"あ".repeat(14)}）`, "Label (short)")]);
    expect(long.map((x) => [x.kind, x.locale])).toEqual([["label", "ja"]]);
  });

  it("日英の片方だけが文のキーは、両方を文として確かめる", () => {
    const v = run([pair("x.mixed", "ラベル（注釈）", "A label (annotation). It has a sentence.")]);
    expect(v.map((x) => [x.kind, x.locale])).toEqual([
      ["sentence", "ja"],
      ["sentence", "en"],
    ]);
  });

  it("括弧の例外だけが括弧の確かめを外す。ラベルの長い括弧は落ち、補足には当てない", () => {
    const exception = Object.keys(PAREN_EXCEPTIONS)[0] as string;
    const v = run([
      pair(
        exception,
        "見出し（注釈のある長い括弧書きです）。",
        "Heading (an annotation that is long enough).",
      ),
      pair("x.label", `ラベル（${"あ".repeat(14)}）`, "Label (ok)"),
      pair("x.noteHint", "補足です（注釈）。", "A hint (annotation)."),
    ]);
    expect(v.map((x) => [x.path, x.kind])).toEqual([["x.label", "label"]]);
  });

  it("括弧の例外の一覧は、括弧を理由にする今までの例外のキーを持ち、理由を添える", () => {
    expect(Object.keys(PAREN_EXCEPTIONS).sort()).toEqual(
      [
        "runLog.roles.guardian",
        "runLog.roles.final-review",
        "runLog.roles.rework",
        "projects.editor.excluded",
        "task.images.defaultDescription",
        "projects.editor.githubForContext",
        "projects.editor.githubForShared",
        "projects.editor.sharedRepo",
        "settings.notifyApi",
        "runLog.clipped",
      ].sort(),
    );
    expect(Object.values(PAREN_EXCEPTIONS).every((reason) => reason.length > 0)).toBe(true);
  });
});
