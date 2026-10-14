/**
 * テストで、偽のコマンド・プロセスの合図（ファイルを置く・プロセスが起動するなど）を待つ（PBI-85）。
 * 本体のコードからは使わない（ビルドの対象から外している）。
 */

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
  /** この時間を過ぎても合図が来なければ失敗する。既定は 10 秒。 */
  timeoutMs?: number;
  /** 確かめる間隔。既定は 20ms。 */
  intervalMs?: number;
};

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
 * 期限を過ぎたら、何を待っていたかを書いたエラーで失敗する。
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  options: WaitOptions,
): Promise<void> {
  const { what, source, timeoutMs = 10_000, intervalMs = 20 } = options;
  let ended: { value: unknown } | { error: unknown } | undefined;
  source?.ended.then(
    (value) => {
      ended = { value };
    },
    (error: unknown) => {
      ended = { error };
    },
  );
  const deadline = Date.now() + timeoutMs;
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
    if (Date.now() > deadline) {
      throw new Error(`${what}を ${timeoutMs}ms 待ったが、来なかった`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
