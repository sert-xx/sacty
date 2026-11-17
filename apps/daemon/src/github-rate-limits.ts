import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/*
 * GitHub のレート制限の待ち（PBI-356）。ホストとアカウントごとに、次に試せる時刻と、連続して制限に当たった回数を持つ。
 * デーモンを起動し直しても待ちを失わないよう、ファイルに保存する（ファイルの指定が無ければ、メモリーだけ）。
 * 使うのは、指摘への対応の返信（PBI-352）だけ。秘密の値は入れない（ホスト・アカウントの名前・時刻・回数だけ）。
 */

export type GitHubRateLimitWait = {
  /** 次に試せる時刻（エポックからのミリ秒）。 */
  until: number;
  /** 連続して制限に当たった回数（投稿が成功したら消える）。 */
  streak: number;
};

/** 時刻として扱える最大の値（エポックからのミリ秒。Date の上限）。 */
const MAX_TIME = 8.64e15;

export class GitHubRateLimitStore {
  private readonly waits = new Map<string, GitHubRateLimitWait>();

  constructor(private readonly file?: string) {
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      // 無い・読めない・壊れているときは、待ち無しで始める。まだ保存していない（ファイルが無い）ときのほかは、
      // 保存してあった待ちを失ったことに気づけるよう、警告を残す
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        console.warn(
          `[daemon] 保存してあった GitHub のレート制限の待ちを読めませんでした（待ち無しで始めます）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        "[daemon] 保存してあった GitHub のレート制限の待ちを読めませんでした（待ち無しで始めます）：形が違います。",
      );
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      const { until, streak } = (value ?? {}) as Partial<GitHubRateLimitWait>;
      if (
        typeof until === "number" &&
        // 時刻として読める範囲だけ（壊れた値で、そのアカウントの返信を止め続けない）
        until >= 0 &&
        until <= MAX_TIME &&
        typeof streak === "number" &&
        Number.isInteger(streak) &&
        streak > 0
      ) {
        this.waits.set(key, { until, streak });
      }
    }
  }

  /** そのホストとアカウントの待ち。制限に当たっていなければ undefined。 */
  get(key: string): GitHubRateLimitWait | undefined {
    return this.waits.get(key);
  }

  set(key: string, wait: GitHubRateLimitWait): void {
    this.waits.set(key, wait);
    this.save();
  }

  /** 投稿が成功した：待ちと、連続した回数を消す。 */
  clear(key: string): void {
    if (this.waits.delete(key)) this.save();
  }

  /** 保存できなくても、待ちはメモリーに残る（デーモンを起動し直すと失う。警告を残して続ける）。 */
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(Object.fromEntries(this.waits))}\n`, { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      console.warn(
        `[daemon] GitHub のレート制限の待ちを保存できませんでした（デーモンを起動し直すと、待ちを失います）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
