import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFinalReviewPrompt, buildPrompt, extractFinalReview } from "./prompts.js";
import {
  findingsOf,
  flagsOtherOverwriting,
  REVIEW_SKILLS_DIR,
  readFixture,
  removesRepositoryRuleCondition,
  runAgent,
  s12FinalReviewPrompt,
  s12Input,
  s12Task,
  s12Workspace,
  s18Workspace,
  viewpointRow,
} from "./testing/review-eval/index.js";

// レビューの観点の指示を、実験 S18・S12 に近い実在の例に当てて確かめる（PBI-282）。
// 常に走るのは、例が本当に問題の形になっていること（固定の確認）。実際の AI に渡す確認は、SACTY_REVIEW_EVAL=1 のときだけ走る
// （AI を呼ぶので時間と費用がかかる。指示を変えたときに、変更の前後で流して比べる）。
//   SACTY_REVIEW_EVAL=1 SACTY_REVIEW_EVAL_RUNS=3 npx vitest run apps/daemon/src/review-eval.test.ts
// 担当の AI を差し替えるときは SACTY_REVIEW_EVAL_AGENT（プロンプトを標準入力から読み、答えを標準出力に出すコマンド）。

describe("例 s12：共通化で、複数の異常が重なる入力の 422 のメッセージが変わる", () => {
  it("変更前後で、異常が 1 つだけの入力は同じ結果になり、既存のテストでは気づけない", async () => {
    const before = await import("./testing/review-eval/fixtures/s12/before.mjs");
    const after = await import("./testing/review-eval/fixtures/s12/after.mjs");
    const result = (mod: typeof before | typeof after, input: ReturnType<typeof s12Input>) => {
      try {
        mod.newReservation(input);
        return "ok";
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    };
    const past = {
      startsAt: new Date("2099-01-02T08:00:00Z"),
      endsAt: new Date("2099-01-02T08:30:00Z"),
    };
    const future = {
      startsAt: new Date("2099-01-02T10:00:00Z"),
      endsAt: new Date("2099-01-02T10:30:00Z"),
    };
    const inactive = { room: { id: "room1", name: "R", isActive: false, capacity: 6 } };
    const single = [
      s12Input({ ...future }),
      s12Input({ ...past }),
      s12Input({ ...future, ...inactive }),
      s12Input({ ...future, attendees: 7 }),
    ];
    for (const input of single) expect(result(after, input)).toBe(result(before, input));
    // 異常が 1 つだけの入力の結果（既存のテストが確かめる範囲）
    expect(result(before, s12Input({ ...past }))).toBe(
      "BusinessRuleError: Reservations must start in the future",
    );
    expect(result(before, s12Input({ ...future, ...inactive }))).toBe(
      'BusinessRuleError: Room "R" is not available for booking',
    );
  });

  it("開始が過去かつ会議室が利用停止の入力では、状態コード（422）は同じで、メッセージが変わる", async () => {
    const before = await import("./testing/review-eval/fixtures/s12/before.mjs");
    const after = await import("./testing/review-eval/fixtures/s12/after.mjs");
    const input = s12Input({ room: { id: "room1", name: "R", isActive: false, capacity: 6 } });
    const message = (fn: (i: typeof input) => unknown) => {
      try {
        fn(input);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    };
    const was = message(before.newReservation);
    const now = message(after.newReservation);
    expect(was).toBeInstanceOf(before.BusinessRuleError);
    expect(now).toBeInstanceOf(after.BusinessRuleError);
    expect(was?.message).toBe("Reservations must start in the future");
    expect(now?.message).toBe('Room "R" is not available for booking');
  });

  it("対照（after-same-order）は、同じ共通化で検査の順番を保ち、どの入力の組み合わせでも変更前と同じ結果になる", async () => {
    const before = await import("./testing/review-eval/fixtures/s12/before.mjs");
    const same = await import("./testing/review-eval/fixtures/s12/after-same-order.mjs");
    const after = await import("./testing/review-eval/fixtures/s12/after.mjs");
    const run = (mod: { newReservation: (i: never) => unknown }, input: unknown) => {
      try {
        mod.newReservation(input as never);
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    };
    const now = new Date("2099-01-02T09:00:00Z");
    const at = (h: number, m = 0) => new Date(Date.UTC(2099, 0, 2, h, m));
    let differs = 0;
    let total = 0;
    for (const [startsAt, endsAt] of [
      [at(8), at(8, 30)], // 開始が過去
      [at(10), at(10, 30)], // 開始が未来
      [at(10), at(15)], // 開始が未来で、240 分を超える
      [at(8), at(13)], // 開始が過去で、240 分を超える
    ] as const) {
      for (const isActive of [true, false]) {
        for (const attendees of [2, 9]) {
          const input = s12Input({
            startsAt,
            endsAt,
            attendees,
            now,
            room: { id: "room1", name: "R", isActive, capacity: 6 },
          });
          total++;
          expect(run(same, input)).toBe(run(before, input));
          if (run(after, input) !== run(before, input)) differs++;
        }
      }
    }
    // 順番を入れ替えた版（after）は、異常が重なる入力のうち一部（全部ではない）で結果が変わる
    expect(differs).toBeGreaterThan(0);
    expect(differs).toBeLessThan(total);
  });

  it("例の差分は、作成の検査を共通の関数に分けた変更と、変更（changeReservation）の追加で、承認済みの設計に順番の変更は書かれていない", () => {
    const { diff } = s12Workspace();
    expect(diff).toContain("+function validateFormat(");
    expect(diff).toContain("+function validateRules(");
    expect(diff).toContain("+export function changeReservation(");
    // 開始が未来の検査が、会議室の検査より後ろに動いている
    expect(diff).toMatch(
      /-\s+if \(input\.startsAt\.getTime\(\) <= input\.now\.getTime\(\)\) \{\n-\s+throw new BusinessRuleError\("Reservations must start in the future"\)/,
    );
    const design = readFixture("s12/design.md");
    expect(design).toContain("開始が未来の検査を除いて共通の関数に分け");
    expect(design).not.toMatch(/検査の順|順番を変え|メッセージが変わ/);
    expect(readFixture("s12/requirements.md")).not.toMatch(/メッセージ/);
  });
});

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

  it("最終レビューの指示に、既存の振る舞いの変化（エラーの種類・メッセージ・検査の順番・応答の形）を、リファクタリングを含めて確かめ、範囲外として申告させることがある", () => {
    for (const prompt of [
      s12FinalReviewPrompt("diff"),
      buildFinalReviewPrompt(s12Task(), "diff", { testCommand: "npm test" }),
    ]) {
      expect(prompt).toContain(
        "既存の振る舞い（エラーの種類・状態コード・メッセージ、検査の順番、応答の形・項目、既定値）",
      );
      expect(prompt).toContain("承認済みの要求要件・設計");
      expect(prompt).toContain(
        "共通化・分割・移動・名前の付け替えのリファクタリングも例外にしない",
      );
      expect(prompt).toContain("複数の異常が同時に当たる入力");
      expect(prompt).toContain("どちらの検査が先に働き、どのエラーを返すかを追う");
      expect(prompt).toContain("既存のテストが通っていても同じ");
      expect(prompt).toContain(
        "outOfScope に「どの入力で、変更前は何を返し、変更後は何を返すか」を書き、不合格にする",
      );
      // 振る舞いを変えない変更は範囲外にしない（比較で確かめる）、リポジトリの決まりが求める変更は範囲内、は変えない
      expect(prompt).toContain(
        "リファクタリング・整形などの振る舞いを変えない変更は、ここでは範囲外としない（変えていないことは、次の項目で確かめる）",
      );
      expect(prompt).toContain("要求要件・設計に書かれていなくても範囲内とする");
    }
  });

  it("セキュリティ対応の最終レビューには入れない（観点 SEC-MIN が見る）", () => {
    const task = { ...s12Task(), requestedPlan: "security-fix" } as unknown as ReturnType<
      typeof s12Task
    >;
    expect(buildFinalReviewPrompt(task, "diff")).not.toContain("既存の振る舞い（エラーの種類");
  });
});

// ここから先は、実際の AI を呼ぶ確認。SACTY_REVIEW_EVAL=1 のときだけ走る。
const live = process.env.SACTY_REVIEW_EVAL ? describe : describe.skip;
const RUNS = Math.max(1, Number(process.env.SACTY_REVIEW_EVAL_RUNS ?? 1));
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

  /** s12 の最終レビューを流し、範囲外の変更（観点 SCOPE）として申告された内容を返す。 */
  const s12Reported = (variant: "after" | "after-same-order", run: number) => {
    const ws = s12Workspace(variant);
    const task = s12Task();
    const ids = (task.approved.design?.testViewpoints ?? []).map((v) => v.id);
    const { output } = runAgent(s12FinalReviewPrompt(ws.diff), { cwd: ws.dir, addDirs: [] });
    const review = extractFinalReview(output, ids, [], {});
    const scope = review.viewpoints.find((v) => v.viewpointId === "SCOPE");
    const reported = scope && !scope.verified ? JSON.stringify(scope.reason) : "";
    record(
      `[s12 ${variant} run ${run}] SCOPE: ${reported || "（申告なし）"}\n${output.slice(-800)}`,
    );
    return reported;
  };
  // 検査の順番（開始が過去と会議室の利用停止のどちらが先か）に触れた申告
  const ORDER = /Reservations must start in the future|is not available for booking|検査の順|順番/;

  it(
    "s12：最終レビューが、共通化で変わった検査の順番（422 のメッセージ）を範囲外の変更として申告する",
    () => {
      const failures: string[] = [];
      for (let run = 1; run <= RUNS; run++) {
        if (!ORDER.test(s12Reported("after", run))) {
          failures.push(`run ${run}: 検査の順番の変化を申告していない`);
        }
      }
      expect(failures).toEqual([]);
    },
    MINUTES * RUNS,
  );

  it(
    "s12（対照）：検査の順番を保った共通化は、範囲外として申告しない（指示が過剰に働かない）",
    () => {
      const failures: string[] = [];
      for (let run = 1; run <= RUNS; run++) {
        const reported = s12Reported("after-same-order", run);
        if (ORDER.test(reported)) failures.push(`run ${run}: 順番を保っているのに申告した`);
      }
      expect(failures).toEqual([]);
    },
    MINUTES * RUNS,
  );
});
