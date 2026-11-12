import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompts.js";
import {
  assertReviewerVerdict,
  evalEnabled,
  evalRuns,
  findingsOf,
  flagsOtherOverwriting,
  REVIEW_SKILLS_DIR,
  readFixture,
  removesRepositoryRuleCondition,
  runAgent,
  s12Task,
  s18Workspace,
  viewpointRow,
} from "./testing/review-eval/index.js";

// レビューの観点の指示を、実験 S18 に近い実在の例に当てて確かめる（PBI-282）。
// 常に走るのは、例が本当に問題の形になっていること（固定の確認）。実際の AI に渡す確認は、SACTY_REVIEW_EVAL=1 のときだけ走る
// （AI を呼ぶので時間と費用がかかる。指示を変えたときに、変更の前後で流して比べる）。
//   SACTY_REVIEW_EVAL=1 SACTY_REVIEW_EVAL_RUNS=3 npx vitest run apps/daemon/src/review-eval.test.ts
// 担当の AI を差し替えるときは SACTY_REVIEW_EVAL_AGENT（プロンプトを標準入力から読み、答えを標準出力に出すコマンド）。

describe("例 s18：リポジトリの決まりから導いた条件が、要求要件に入っている", () => {
  it("下書きの R-2（定義・生成物・版）は、リポジトリの README の決まりから導かれ、確かめ方も決まりのコマンドである", () => {
    const draft = readFixture("s18/draft.md");
    expect(draft).toMatch(/\| R-2 \| 蔵書 API \| API の定義・生成した型とリファレンスに/);
    expect(draft).toContain("版を 1.4.0 にする");
    // 担当に渡る根拠（集めた情報）にも、R-2 がリポジトリの決まりから要る、と出典付きで書かれている
    const task = readFixture("s18/task.md");
    expect(task).toContain(
      "リポジトリの決まり（README.md「変更の決まり」・「API の定義と生成するファイル」）から、あわせて次が要る",
    );
    expect(readFixture("s18/context.md")).toContain("実装方法に踏み込まない");
    expect(draft).toContain("npm run check:generated");
    const readme = readFixture("s18/repo/README.md");
    expect(readme).toContain("## 変更の決まり");
    expect(readme).toContain("CHANGELOG.md");
    expect(readme).toContain("同じ値に上げる");
    expect(readme).toContain("npm run generate");
    expect(readme).toContain("check:generated");
    // AGENTS.md には生成の決まりが無い（README にだけある）
    expect(readFixture("s18/repo/AGENTS.md")).not.toContain("generate");
  });

  it("下書きには、R-2 のほかにも書きすぎの指摘が出る箇所がある（既存の一覧の並びの書き直し）。指示が D-10 を黙らせていないかの確認に使う", () => {
    const draft = readFixture("s18/draft.md");
    expect(draft).toContain("登録の新しい順で返す");
    expect(draft).not.toContain("query を載せ");
  });

  it("観点カタログの D-10 の行を、担当への依頼文に写せる", () => {
    const row = viewpointRow("D-10");
    expect(row.name).toBe("簡潔さ・範囲");
    expect(row.see).toContain("既存の仕組みが保証していて今回の変更で変わらない振る舞いの書き直し");
    expect(row.notSee).toContain("書かれていないこと（D-3）");
  });
});

describe("判定の読み取り（固定の確認）", () => {
  const finding = (extra: Record<string, string>) => ({
    severity: "should",
    path: "draft.md",
    title: "",
    problem: "",
    evidence: "",
    suggestion: "",
    ...extra,
  });
  const output = (findings: Record<string, string>[]) =>
    JSON.stringify({
      viewpoint: "D-10",
      status: "changes_required",
      findings: findings.map(finding),
    });

  it("R-2 を消す・縮める指摘を見つける（nit も）。直す指摘・別の要求を消す指摘は見つけない", () => {
    const removes = findingsOf(
      output([
        {
          title: "R-2 は README の変更の決まりの書き直しになっている",
          problem: "R-2 は README の決まりと同じ",
          suggestion: "R-2 と確かめ方を消す",
        },
      ]),
    );
    expect(removesRepositoryRuleCondition(removes)).toHaveLength(1);
    const keeps = findingsOf(
      output([
        {
          title: "R-2 の確かめ方を直す",
          problem: "R-2 の版",
          suggestion: "check:generated の結果で確かめる形に直す",
        },
        {
          title: "R-5 は既存の並びの書き直し",
          problem: "R-5 の並び",
          suggestion: "R-5 から並びを消す",
        },
      ]),
    );
    expect(removesRepositoryRuleCondition(keeps)).toEqual([]);
    expect(flagsOtherOverwriting(keeps)).toBe(true);
    expect(flagsOtherOverwriting(removes)).toBe(false);
  });

  it("JSON が前後の文章や囲みに包まれていても読む。読めなければ指摘は空", () => {
    const body = output([{ title: "R-5 を消す", problem: "R-5", suggestion: "消す" }]);
    expect(findingsOf(`結果です\n\`\`\`json\n${body}\n\`\`\``)).toHaveLength(1);
    expect(findingsOf(`前置き ${body} 後書き`)).toHaveLength(1);
    expect(findingsOf("JSON ではありません")).toEqual([]);
    expect(findingsOf('{"findings": "なし"}')).toEqual([]);
  });
});

describe("実際の AI に当てる確認の入口（固定の確認）", () => {
  it("SACTY_REVIEW_EVAL は 1 のときだけ有効（0・false・空・true は無効）", () => {
    expect(evalEnabled("1")).toBe(true);
    for (const v of [undefined, "", "0", "false", "true", "yes", " 1"]) {
      expect(evalEnabled(v), String(v)).toBe(false);
    }
  });

  it("SACTY_REVIEW_EVAL_RUNS は 1 以上の整数。数でない・0・負・小数は明示的に失敗する（ループが回らず合格しない）", () => {
    expect(evalRuns(undefined)).toBe(1);
    expect(evalRuns("")).toBe(1);
    expect(evalRuns("1")).toBe(1);
    expect(evalRuns("5")).toBe(5);
    for (const v of [
      "abc",
      "0",
      "-1",
      "1.5",
      "NaN",
      "1e3",
      "Infinity",
      "9".repeat(400),
      "9007199254740993",
    ]) {
      expect(() => evalRuns(v), v).toThrow("1 以上の整数");
    }
  });

  it("AI の実行が失敗した（起動できない・異常終了）ときは、評価せず失敗する。正常に終われば出力を返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "sacty-review-eval-agent-"));
    // 指示文を標準入力から読み切ってから終わる模擬の AI（読まずに終わると、書き込みの途中でパイプが閉じて EPIPE になりうる）
    const script = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return path;
    };
    const before = process.env.SACTY_REVIEW_EVAL_AGENT;
    const withAgent = (agent: string, prompt = "x") => {
      process.env.SACTY_REVIEW_EVAL_AGENT = agent;
      return runAgent(prompt, { cwd: dir });
    };
    try {
      expect(() => withAgent("sacty-no-such-command-xyz")).toThrow("AI の実行に失敗しました");
      expect(() => withAgent(script("fail.sh", "cat >/dev/null\nexit 1"))).toThrow("終了コード 1");
      expect(withAgent("cat")).toMatchObject({ output: "x", status: 0 });
    } finally {
      if (before === undefined) delete process.env.SACTY_REVIEW_EVAL_AGENT;
      else process.env.SACTY_REVIEW_EVAL_AGENT = before;
    }
  });

  it("指示文を読まずに終わる AI（大きな入力で EPIPE になる）でも、実行の失敗として終了コードつきで失敗する（成功にも別の失敗にもならない）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sacty-review-eval-agent-"));
    const before = process.env.SACTY_REVIEW_EVAL_AGENT;
    process.env.SACTY_REVIEW_EVAL_AGENT = "false";
    try {
      // 小さい入力は、書き終えてから終わるか EPIPE かが揺れる。どちらでも同じ形で失敗する
      for (const prompt of ["x", "y".repeat(2_000_000)]) {
        expect(() => runAgent(prompt, { cwd: dir }), String(prompt.length)).toThrow(
          /AI の実行に失敗しました：.*終了コード 1/,
        );
      }
    } finally {
      if (before === undefined) delete process.env.SACTY_REVIEW_EVAL_AGENT;
      else process.env.SACTY_REVIEW_EVAL_AGENT = before;
    }
  });

  it("error と終了コードが同時に返ったとき（EPIPE など）、失敗の理由に両方を併記する（片方が消えると落ちる）", () => {
    const spawned = (r: Record<string, unknown>) =>
      (() => r) as unknown as typeof import("node:child_process").spawnSync;
    const dir = mkdtempSync(join(tmpdir(), "sacty-review-eval-agent-"));
    const message = (r: Record<string, unknown>) => {
      try {
        runAgent("x", { cwd: dir, spawn: spawned(r) });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    const both = message({
      error: new Error("spawnSync false EPIPE"),
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(both).toContain("AI の実行に失敗しました：spawnSync false EPIPE、終了コード 1");
    // error だけ（終了コードが無い：起動失敗・時間切れ）、終了コードだけ、シグナル
    expect(
      message({ error: new Error("spawnSync x ETIMEDOUT"), status: null, signal: "SIGTERM" }),
    ).toContain("AI の実行に失敗しました：spawnSync x ETIMEDOUT、シグナル SIGTERM");
    expect(message({ status: 2, signal: null })).toContain("AI の実行に失敗しました：終了コード 2");
    // 成功（error なし・終了コード 0）は例外にしない
    expect(
      runAgent("x", { cwd: dir, spawn: spawned({ status: 0, stdout: "ok", stderr: "" }) }),
    ).toEqual({
      output: "ok",
      status: 0,
    });
  });

  it("環境変数が設定されていても、引数が省略（undefined）なら既定の挙動になる（環境変数を読まない）", () => {
    const keep = { e: process.env.SACTY_REVIEW_EVAL, r: process.env.SACTY_REVIEW_EVAL_RUNS };
    process.env.SACTY_REVIEW_EVAL = "1";
    process.env.SACTY_REVIEW_EVAL_RUNS = "5";
    try {
      expect(evalEnabled(undefined)).toBe(false);
      expect(evalRuns(undefined)).toBe(1);
    } finally {
      for (const [k, v] of [
        ["SACTY_REVIEW_EVAL", keep.e],
        ["SACTY_REVIEW_EVAL_RUNS", keep.r],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("観点担当の判定は、観点・status・指摘の形まで確かめ、読めなければ評価せず失敗する", () => {
    const ok = (o: Record<string, unknown>) =>
      JSON.stringify({ viewpoint: "D-10", status: "passed", findings: [], ...o });
    for (const bad of [
      "",
      "判定なし",
      '{"findings": "なし"}',
      "```json\n{\n```",
      '{"findings": []}', // viewpoint・status が無い
      ok({ viewpoint: "D-3" }), // 別の観点
      ok({ status: 1 }),
      ok({ status: "failed" }), // 観点を見られなかった判定は評価しない
      ok({ status: "failed", findings: [] }),
      ok({ findings: [{}] }), // title・severity が無い
      ok({ findings: [{ title: "x", severity: "major" }] }),
      ok({ findings: [null] }),
    ]) {
      expect(() => assertReviewerVerdict(bad, "D-10"), bad).toThrow("判定の JSON として読めません");
    }
    expect(() => assertReviewerVerdict(ok({}), "D-10")).not.toThrow();
    expect(() => assertReviewerVerdict(ok({ status: "changes_required" }), "D-10")).not.toThrow();
    expect(() =>
      assertReviewerVerdict(ok({ findings: [{ title: "x", severity: "nit" }] }), "D-10"),
    ).not.toThrow();
  });

  it("skillsDir を指定すると、依頼文の観点の「見るもの」「見ないもの」は、その版のカタログから取る（変更前の版の評価に新しい文言が混ざらない）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sacty-review-eval-skills-"));
    mkdirSync(join(dir, "review-dispatch/references"), { recursive: true });
    writeFileSync(
      join(dir, "review-dispatch/references/viewpoints.md"),
      "| D-10 | 簡潔さ・範囲 | 旧版の見るもの | 旧版の見ないもの |\n",
    );
    const old = s18Workspace(dir).prompt;
    expect(old).toContain("見るもの：旧版の見るもの");
    expect(old).toContain("見ないもの：旧版の見ないもの");
    expect(old).toContain(join(dir, "review-execution/SKILL.md"));
    expect(old).not.toContain("決まりを引ける条件は消す指摘にしない");
    expect(s18Workspace().prompt).toContain("決まりを引ける条件は消す指摘にしない");
    expect(viewpointRow("D-10", dir).see).toBe("旧版の見るもの");
  });
});

describe("観点の指示の文言（PBI-282）", () => {
  const skill = (path: string) => readFileSync(join(REVIEW_SKILLS_DIR, path), "utf8");

  it("観点 D-10 は、リポジトリの決まりから導かれる条件を、消す指摘にしない（観点カタログ・観点の資料・自己レビューの流れ）", () => {
    // 観点カタログ（親が担当への依頼文に写す「見ないもの」）
    expect(viewpointRow("D-10").notSee).toContain("決まりを引ける条件は消す指摘にしない");
    expect(viewpointRow("D-10").notSee).toContain("既存の仕組みが保証する振る舞いではない");
    // 観点の資料：手順・節・逆向きの NG 例・見落としやすい所
    const d10 = skill("review-execution/references/D-10.md");
    expect(d10).toContain("## リポジトリの決まりから導かれる条件は消す指摘にしない");
    expect(d10).toContain("候補が「リポジトリの決まり」から導かれる条件でないかを確かめる");
    expect(d10).toContain("条件の中身が誤っている・確かめられない");
    expect(d10).toContain("消す指摘にせず、直す指摘にする");
    expect(d10).toContain(
      "### 例9：リポジトリの決まりから導かれる条件を、書き直しとして消させる（指摘にしない）",
    );
    expect(d10).toContain("「README に書いてあるから書き直し」という見方");
    // 自己レビューの流れ：D-10 の指摘に従うときも消さない。消すなら理由を記録する
    const flow = skill("review-dispatch/references/self-review.md");
    expect(flow).toContain("「決まりの書き直し」として消さない");
    expect(flow).toContain("消すなら、決まりから導かれないと確かめた理由を");
    expect(flow).toContain("条件を消さずに、誤りを直して応える");
  });

  it("D-10 の本来の役割（依頼に無い要求・既存の仕組みの書き直しを消させる）は残す", () => {
    const d10 = skill("review-execution/references/D-10.md");
    expect(d10).toContain("### 例1：依頼に無い機能");
    expect(d10).toContain("### 例2：既存の仕組みの書き直し");
    expect(viewpointRow("D-10").see).toContain(
      "既存の仕組みが保証していて今回の変更で変わらない振る舞いの書き直し",
    );
    expect(skill("review-dispatch/references/self-review.md")).toContain(
      "記述を削る指摘（D-10）は `should` も直す",
    );
  });

  it("要求要件・設計の指示に、決まりから導いた条件を書き直しとして消さないことと、消すなら理由を総評に書くことがある（実装の指示には入れない）", () => {
    const task = s12Task();
    for (const step of ["requirements", "design"] as const) {
      const prompt = buildPrompt(task, step);
      expect(prompt, step).toContain(
        "記述を削る指摘（D-10）でも「決まりの書き直し」として消さない",
      );
      expect(prompt, step).toContain("決まりの出典を引ける条件は残す");
      expect(prompt, step).toContain("決まりから導かれないと確かめた理由を、報告の summary に書く");
      expect(prompt, step).toContain("条件を消さずに、誤りを直して応える");
      // 最初に書くときも、決まりが求める条件は書く
      expect(prompt, step).toContain("リポジトリの決まりが、この種の変更に求める条件");
    }
    expect(buildPrompt(task, "implement")).not.toContain("「決まりの書き直し」として消さない");
  });
});

// ここから先は、実際の AI を呼ぶ確認。SACTY_REVIEW_EVAL=1 のときだけ走る。
const live = evalEnabled(process.env.SACTY_REVIEW_EVAL) ? describe : describe.skip;
const RUNS = evalEnabled(process.env.SACTY_REVIEW_EVAL)
  ? evalRuns(process.env.SACTY_REVIEW_EVAL_RUNS)
  : 1;
const MINUTES = 25 * 60_000;
/** 結果を標準出力に出し、SACTY_REVIEW_EVAL_LOG があればそのファイルにも追記する（指示の変更の前後を並べて読むため）。 */
function record(text: string) {
  console.log(text);
  if (process.env.SACTY_REVIEW_EVAL_LOG)
    appendFileSync(process.env.SACTY_REVIEW_EVAL_LOG, `${text}\n`);
}
const SKILLS = process.env.SACTY_REVIEW_EVAL_SKILLS_DIR ?? REVIEW_SKILLS_DIR;

live(`実際の AI に当てる（${RUNS} 回ずつ）`, () => {
  it(
    "s18：要求要件のセルフレビュー（D-10）が、リポジトリの決まりから導いた条件 R-2 を消す・縮める指摘にしない。ほかの書きすぎは指摘する",
    () => {
      const failures: string[] = [];
      for (let run = 1; run <= RUNS; run++) {
        const ws = s18Workspace(SKILLS);
        const { output } = runAgent(ws.prompt, { cwd: ws.repo, addDirs: [SKILLS, ws.dir] });
        assertReviewerVerdict(output, "D-10");
        const findings = findingsOf(output);
        record(`[s18 run ${run}] 指摘 ${findings.length} 件\n${JSON.stringify(findings, null, 2)}`);
        const removed = removesRepositoryRuleCondition(findings);
        if (removed.length > 0)
          failures.push(
            `run ${run}: R-2 を消す・縮める指摘 ${removed.map((f) => f.title).join(" / ")}`,
          );
        if (!flagsOtherOverwriting(findings))
          failures.push(`run ${run}: ほかの書きすぎを指摘していない（D-10 が黙った）`);
      }
      expect(failures).toEqual([]);
    },
    MINUTES * RUNS,
  );
});
