import { describe, expect, it } from "vitest";
import { messagesFor } from "./index";
import type { Locale } from "./locale";

/**
 * 画面の文言の規則（docs/README.md の「画面の文言の書き方」。PBI-117）を、辞書の文字列の葉について機械的に確かめる。
 * - 本文（常に見える文言）：改行を含まない。長すぎない。長い括弧書きの注釈を含まない。
 * - 補足（キーが hint・*Hint・*Help のもの）：本文より長くてよいが、上限がある。
 * 引数を取る文言（関数）は呼び出さないと文にならないので、ここでは確かめない（レビューで見る）。
 */

/** 本文の上限（文字数）。目安は日本語 40・英語 80 だが、エラー・判断の案内は 2 文まで認めるので、ここでは上限を広く取る。 */
const BODY_MAX = { ja: 60, en: 130 } as const;
/** 補足の上限（文字数）。 */
const HINT_MAX = { ja: 150, en: 320 } as const;
/** 本文に認める括弧書きの長さ（文字数）。数値・ID・短い語を添える程度。 */
const PAREN_MAX = { ja: 14, en: 30 } as const;

/**
 * 規則の例外（キーのパス）。理由を添える。足すときは、本文に残す理由が「判断に要る」「エラー」のどちらかであること。
 */
const EXCEPTIONS: Record<string, string> = {
  // 役割の見出し：ゴールガーディアンの何の判断かを括弧で添える（見出しなので括弧の例外）
  "runLog.roles.guardian": "見出し。括弧で判断の種類を添える",
  "runLog.roles.final-review": "見出し。括弧で判断の種類を添える",
  "runLog.roles.rework": "見出し。括弧で判断の種類を添える",
  // 中止・判断を求める場面の案内：何が起きたか・何を決めるかの2文（判断に要る）
  "task.gate.noChangesHelp": "判断の案内。何が起きた・何を決めるの2文",
  "task.gate.prMergedOutdatedHelp": "判断の案内。何が起きた・次に何が起きるの2文",
  "task.gate.integrateHelp": "判断の案内。承認と差し戻しの結果の2文",
  "review.gate.operationExecutedHelp": "判断の案内。できないことと、することの2文",
  "review.gate.notReproducedHelp": "判断の案内。何が起きた・何をするの2文",
  "review.gate.noChangesHelp": "判断の案内。何が起きた・承認と差し戻しの結果の2文",
  "review.gate.prMergedOutdated": "判断の案内。何が起きた・次に何が起きるの2文",
  "review.gate.prHint": "補足（キーの名前が Hint で終わらないが補足）",
  "parts.changeDecision.requirementsHelp": "判断の案内。認める・認めないの結果の2文",
  "parts.changeDecision.designHelp": "判断の案内。認める・認めないの結果の2文",
  "parts.implementation.noTestsSkipped": "検証の状態。何をしていない・誰が判定するの2文",
  "parts.resume.ticketNoRepo": "エラー。何が無い・何をするの2文",
  "forms.task.templateSetupNote": "テンプレートを選んだときの説明。何をする・何を決めるの2文",
  "forms.task.noRepository": "エラー。何が無い・何をするの2文",
  "projects.editor.ticketsNoPlatforms": "エラー。何が無い・何をするの2文",
  "projects.editor.excluded": "見出し。括弧で理由を添える",
  // 選択肢・ラベルに添える短い説明（何を含むか・どんな値か）
  "task.images.defaultDescription": "選択肢の説明。括弧で中身を添える",
  "projects.editor.githubForContext": "ラベルに添える語。何のための選択かを括弧で添える",
  "projects.editor.githubForShared": "ラベルに添える語。何のための選択かを括弧で添える",
  "projects.editor.sharedRepo": "ラベル。括弧で書き方を添える",
  "settings.notifyApi": "選択肢。括弧で送り方を添える",
  "labels.pauseHelp.usage_limit": "一時停止の案内。何が起きた・再開すると何が起きるの2文",
  "labels.pauseHelp.error": "一時停止の案内。何が起きた・再開すると何が起きるの2文",
  "labels.pauseHelp.verification": "一時停止の案内。何が起きた・何をするの2文",
  "labels.pauseHelp.child_cancelled": "一時停止の案内。再開・中止の結果の2文",
  "labels.event.AgentSessionNotArchived": "作業履歴の1行。理由を含む",
  "labels.event.GuardianMissed": "作業履歴の1行。何が起きたか",
  "labels.event.NoChangesFound": "作業履歴の1行。理由を含む",
  "labels.event.TestsSkipped": "作業履歴の1行。理由を含む",
  "runLog.unfinished": "状態と、考えられる理由の2文",
  "runLog.clipped": "省略の印。括弧で理由を添える",
  "runLog.notFoundHelp": "無い理由の案内",
  "runLog.agentFiles.notArchived.container_not_confirmed": "写していない理由の注記",
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
  return key === "hint" || key.endsWith("Hint") || key.endsWith("Help");
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

      it(`本文に ${PAREN_MAX[locale]} 文字以上の括弧書きを入れない`, () => {
        const paren = body.filter((l) => longestParenthesis(l.text) >= PAREN_MAX[locale]);
        expect(paren.map((l) => `${l.path}: ${l.text}`)).toEqual([]);
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
  });
});
