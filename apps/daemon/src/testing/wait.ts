/**
 * テストで、偽のコマンド・プロセスの合図（ファイルを置く・プロセスが起動するなど）を待つ（PBI-85）。
 * 本体のコードからは使わない（ビルドの対象から外している）。
 */

import { TestRunner } from "vitest";

/** 待っている間に、合図を出すはずのもの（実行・プロセス）が終わったことを知らせるもの。 */
export type WaitSource = {
  /** 何が終わったのか（エラーの文に入れる）。例：「偽の docker の実行」 */
  name: string;
  /** 終わったら解決する（失敗なら拒否する）。待ちが終わった後も、呼ぶ側はそのまま待ってよい。 */
  ended: Promise<unknown>;
  /** 終わったときの値を、原因がわかる文にする（終了コード・出力の末尾など）。無ければ JSON にする。 */
  describe?: (value: unknown) => string;
};

export type WaitOptions = {
  /** 待っているもの（エラーの文に入れる）。例：「準備の合図（ready）」 */
  what: string;
  /** 合図を出すはずのもの。これが先に終わったら、期限を待たずにすぐ失敗する。 */
  source?: WaitSource;
  /**
   * この時間を過ぎても合図が来なければ失敗する。省いたとき・テストの残りの時間より長いときは、テストの残りの時間から余裕
   * （TEST_TIMEOUT_MARGIN_MS）を引いた時間にする（テストの時間切れの汎用のエラーより先に、理由を書いたエラーで落とすため）。
   */
  timeoutMs?: number;
  /** 確かめる間隔。既定は 20ms。 */
  intervalMs?: number;
};

/** テストの外（Vitest の現在のテストが無い）で、timeoutMs を省いたときの期限。 */
export const FALLBACK_TIMEOUT_MS = 10_000;

/**
 * テストの時間切れより前に落とすための余裕（テストの時間切れの5分の1か、これの短いほう）。確かめる処理（ps など）が、
 * 負荷が高いと数百ミリ秒かかっても、テストの時間切れより先に理由を書いたエラーにできる長さ。
 */
export const TEST_TIMEOUT_MARGIN_MS = 1_000;

/** 今のテストの、時間切れまでの残りから余裕を引いた時間。テストの外・時間切れが無いテストでは undefined。 */
export function testTimeLeftMs(now = Date.now()): number | undefined {
  const test = TestRunner.getCurrentTest();
  const timeout = test?.timeout;
  if (!test || !timeout || !Number.isFinite(timeout) || timeout <= 0) return undefined;
  const startedAt = test.result?.startTime ?? now;
  const margin = Math.min(TEST_TIMEOUT_MARGIN_MS, timeout / 5);
  return Math.max(0, startedAt + timeout - margin - now);
}

const describeValue = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * check が真になるのを待つ。source が先に終わったら（合図を出さないまま終わった）、その原因を書いたエラーですぐ失敗する。
 * 期限を過ぎたら、何を待っていたか・source の様子（まだ動いている）・待った時間を書いたエラーで失敗する。期限は、
 * テストの時間切れより必ず前にする（timeoutMs の説明）。
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  options: WaitOptions,
): Promise<void> {
  const { what, source, intervalMs = 20 } = options;
  const started = Date.now();
  const left = testTimeLeftMs(started);
  const limit =
    options.timeoutMs === undefined
      ? (left ?? FALLBACK_TIMEOUT_MS)
      : Math.min(options.timeoutMs, left ?? options.timeoutMs);
  const byTest = left !== undefined && limit === left && left !== options.timeoutMs;
  let ended: { value: unknown } | { error: unknown } | undefined;
  source?.ended.then(
    (value) => {
      ended = { value };
    },
    (error: unknown) => {
      ended = { error };
    },
  );
  const deadline = started + limit;
  for (;;) {
    // 終わったのを知ってから確かめ直す（終わる直前に合図を出していれば、成功にする）
    const endedBefore = ended;
    if (await check()) return;
    if (endedBefore && source) {
      const detail =
        "error" in endedBefore
          ? `失敗した：${describeValue(endedBefore.error)}`
          : `終わった：${(source.describe ?? describeValue)(endedBefore.value)}`;
      throw new Error(`${what}を待っている間に、${source.name}が、合図を出さないまま${detail}`);
    }
    const now = Date.now();
    if (now >= deadline) {
      const state = source ? `${source.name}はまだ動いている。` : "";
      const reason = byTest ? "（テストの時間切れの前に止めた）" : "";
      throw new Error(
        `${what}が来なかった：${state}${now - started}ms 待った（期限 ${limit}ms${reason}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - now)));
  }
}

type ChildLike = {
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  stderr?: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    once(event: "close", listener: () => void): unknown;
  } | null;
};

/**
 * 子プロセスの終わり（終了コード・シグナルと、標準エラー出力の末尾）を、WaitSource にする。
 * 終わった（exit）後、標準エラー出力を読み終える（close）まで、1 秒を上限に待ってから終わったことにする（末尾を取りこぼさない。
 * 子孫が標準エラー出力を開いたままでも、待ち続けない）。
 */
export function processSource(
  name: string,
  child: ChildLike,
  tailBytes = 2000,
): WaitSource & { stderr: () => string } {
  let err = "";
  let stderrClosed = !child.stderr;
  child.stderr?.on("data", (chunk: Buffer) => {
    err = (err + chunk.toString("utf8")).slice(-tailBytes);
  });
  const closed = new Promise<void>((resolve) => {
    if (!child.stderr) return resolve();
    child.stderr.once("close", () => {
      stderrClosed = true;
      resolve();
    });
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => {
      const done = () => resolve({ code, signal });
      if (stderrClosed) return done();
      const timer = setTimeout(done, 1_000);
      void closed.then(() => {
        clearTimeout(timer);
        done();
      });
    }),
  );
  return {
    name,
    ended,
    stderr: () => err,
    describe: (value) => {
      const { code, signal } = value as { code: number | null; signal: NodeJS.Signals | null };
      return `終了コード ${code}・シグナル ${signal}・標準エラー出力の末尾 ${JSON.stringify(err)}`;
    },
  };
}
