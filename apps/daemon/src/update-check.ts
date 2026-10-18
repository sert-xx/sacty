import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * sacty の最新版の確かめ（PBI-135）。動いている sacty のコミットと、GitHub の sacty のリポジトリの main を比べ、main に
 * 手元に無いコミットがあれば、新しい版があるとする。確かめられないとき（git の作業ツリーでない・GitHub が知らないコミット・
 * ネットワークに届かないなど）は、黙って何も知らせない。リリースの運用を始めたら、GitHub Releases に切り替える。
 */

/** 比べる相手の、sacty のリポジトリと枝。 */
export const SACTY_REPOSITORY = "sert-xx/sacty";
export const SACTY_BRANCH = "main";

/** 確かめる間隔（1日）。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 間隔が来たか、OFF から ON に変わったかを見る間隔（1時間。GitHub にはこの間隔では問い合わせない）。 */
export const UPDATE_CHECK_TICK_MS = 60 * 60 * 1000;
/** GitHub への問い合わせを待つ上限。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 新しい版があるときの知らせ（画面に出す）。 */
export type UpdateStatus = {
  /** main にあって、手元に無いコミットの数。 */
  behindBy: number;
  /** 手元のコミットと main の差分を見る GitHub のページ。 */
  compareUrl: string;
};

/**
 * GitHub の比較の API（`<手元>...main`）の応答のうち、使うもの。status・ahead_by は、base（手元）から見た head（main）の向き。
 * main に手元に無いコミットがあれば status が ahead（または diverged）で、その数が ahead_by（behind_by は手元だけにあるコミットの数）。
 */
const Compare = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  ahead_by: z.number().int().nonnegative(),
  html_url: z.url({ protocol: /^https$/ }),
});

export type UpdateCheckDeps = {
  /** 動いている sacty のコミット（40桁の SHA）。わからなければ undefined。 */
  localCommit: () => Promise<string | undefined>;
  /** 確かめるか（config.yaml の update_check。読めなければ ON）。 */
  enabled: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
};

export class UpdateChecker {
  private latest: UpdateStatus | undefined;
  private lastAttempt: number | undefined;
  private commit: Promise<string | undefined> | undefined;

  constructor(private readonly deps: UpdateCheckDeps) {}

  /** 画面に出す知らせ。最新・確かめられない・OFF のときは undefined。 */
  status(): UpdateStatus | undefined {
    return this.deps.enabled() ? this.latest : undefined;
  }

  /**
   * 間隔が来ていれば確かめる。問い合わせる前に時刻を記録するので、問い合わせの間に呼ばれても重ねて問い合わせない。
   * OFF なら問い合わせず、知らせを消す（ON に戻したら、次の時刻に確かめる）。
   */
  async check(): Promise<void> {
    if (!this.deps.enabled()) {
      this.latest = undefined;
      this.lastAttempt = undefined;
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    if (this.lastAttempt !== undefined && now - this.lastAttempt < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastAttempt = now;
    this.latest = await this.fetchStatus();
  }

  /** GitHub に問い合わせる。確かめられなければ undefined（黙る）。 */
  private async fetchStatus(): Promise<UpdateStatus | undefined> {
    try {
      // 動いているコードのコミットなので、起動のときに1回だけ取る（git pull しても、起動し直すまでは古いまま）
      this.commit ??= this.deps.localCommit();
      const commit = await this.commit;
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return undefined;
      const res = await (this.deps.fetch ?? fetch)(
        `https://api.github.com/repos/${SACTY_REPOSITORY}/compare/${commit}...${SACTY_BRANCH}`,
        {
          headers: { accept: "application/vnd.github+json", "user-agent": "sacty-update-check" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!res.ok) return undefined;
      const parsed = Compare.safeParse(await res.json());
      // main が手元より進んでいる（ahead_by）分が、手元に無い変更（PBI-135 の動作確認で、向きを本物の応答で確かめた）
      if (!parsed.success || parsed.data.ahead_by === 0) return undefined;
      return { behindBy: parsed.data.ahead_by, compareUrl: parsed.data.html_url };
    } catch {
      return undefined;
    }
  }
}

/** sacty のリポジトリの場所（src・dist のどちらからも、リポジトリの直下）。 */
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 手元の sacty のリポジトリの HEAD のコミット。git の作業ツリーでなければ undefined。 */
export function gitHeadCommit(root: string = REPOSITORY_ROOT): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}

/** 起動のときと、それから1時間ごとに確かめる（間隔の判断は UpdateChecker.check）。止める関数を返す。 */
export function startUpdateCheck(
  checker: UpdateChecker,
  tickMs = UPDATE_CHECK_TICK_MS,
): () => void {
  void checker.check();
  const timer = setInterval(() => void checker.check(), tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
