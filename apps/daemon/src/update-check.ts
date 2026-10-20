import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * sacty の最新版の確かめ（PBI-135・PBI-147）。動いている sacty の版（apps/daemon/package.json の version）と、GitHub の sacty の
 * リポジトリの最新のリリース（GitHub Releases の latest。タグ v<版>）を比べ、最新のリリースの版が新しければ、新しい版があるとする。
 * 確かめられないとき（版を読めない・リリースが無い・ネットワークに届かない・タグが semver でないなど）は、黙って何も知らせない。
 * 1.0.0 より前は、手元のコミットと main を比べていた（リリースを運用していなかったため）。
 */

/** 比べる相手の、sacty のリポジトリ。 */
export const SACTY_REPOSITORY = "sert-xx/sacty";

/** 確かめる間隔（1日）。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 間隔が来たか、OFF から ON に変わったかを見る間隔（1時間。GitHub にはこの間隔では問い合わせない）。 */
export const UPDATE_CHECK_TICK_MS = 60 * 60 * 1000;
/** GitHub への問い合わせを待つ上限。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 新しい版があるときの知らせ（画面に出す）。版は MAJOR.MINOR.PATCH の形にそろえる。 */
export type UpdateStatus = {
  /** 最新のリリースの版（タグの先頭の v を除いたもの。例 1.2.0）。 */
  latest: string;
  /** 動いている sacty の版（package.json の version）。 */
  current: string;
  /** 最新のリリースのページ（GitHub）。 */
  releaseUrl: string;
};

/** 版の数（MAJOR・MINOR・PATCH）。 */
export type Version = [number, number, number];

/** semver の MAJOR.MINOR.PATCH（先頭の v は任意。先行ゼロは認めない）。プレリリースやビルドの付いたものは版として読まない（リリースには付けない）。 */
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 版の文字列を数に読む。形が違えば undefined。 */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** a が b より新しければ正、同じなら 0、古ければ負。 */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const formatVersion = (v: Version) => v.join(".");

/** GitHub の最新のリリースの API（`/releases/latest`）の応答のうち、使うもの。latest は下書き・プレリリースを返さないが、念のため読む。 */
const Release = z.object({
  tag_name: z.string(),
  html_url: z.url({ protocol: /^https$/ }),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

export type UpdateCheckDeps = {
  /** 動いている sacty の版（package.json の version）。わからなければ undefined。 */
  localVersion: () => Promise<string | undefined>;
  /** 確かめるか（config.yaml の update_check。読めなければ ON）。 */
  enabled: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
};

export class UpdateChecker {
  private latest: UpdateStatus | undefined;
  private lastAttempt: number | undefined;
  private version: Promise<string | undefined> | undefined;
  /** OFF を見るたびに進める。問い合わせの途中で OFF になったら、その結果を捨てる（PR #147 レビュー指摘）。 */
  private generation = 0;

  constructor(private readonly deps: UpdateCheckDeps) {}

  /** 画面に出す知らせ。最新・確かめられない・OFF のときは undefined。OFF を見たら、状態も消す。 */
  status(): UpdateStatus | undefined {
    if (!this.deps.enabled()) {
      this.reset();
      return undefined;
    }
    return this.latest;
  }

  /**
   * 間隔が来ていれば確かめる。問い合わせる前に時刻を記録するので、問い合わせの間に呼ばれても重ねて問い合わせない。
   * OFF なら問い合わせず、知らせを消す（ON に戻したら、次の時刻に確かめる）。
   */
  async check(): Promise<void> {
    if (!this.deps.enabled()) {
      this.reset();
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    if (this.lastAttempt !== undefined && now - this.lastAttempt < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastAttempt = now;
    const generation = this.generation;
    const status = await this.fetchStatus(generation);
    // 問い合わせの間に OFF になった（ON に戻っていても）なら、結果を残さない
    if (this.current(generation)) this.latest = status;
  }

  /** OFF を見たときに、知らせと問い合わせの時刻を消す（ON に戻したら、間隔を待たずに確かめる）。 */
  private reset(): void {
    this.latest = undefined;
    this.lastAttempt = undefined;
    this.generation += 1;
  }

  /** 問い合わせを始めたときから OFF になっていないか（いまも ON か）。 */
  private current(generation: number): boolean {
    if (!this.deps.enabled()) {
      this.reset();
      return false;
    }
    return generation === this.generation;
  }

  /** GitHub に問い合わせる。確かめられなければ undefined（黙る）。 */
  private async fetchStatus(generation: number): Promise<UpdateStatus | undefined> {
    try {
      // 動いているコードの版なので、起動のときに1回だけ読む（更新しても、起動し直すまでは前の版と比べる）
      this.version ??= this.deps.localVersion();
      const text = await this.version;
      const current = text === undefined ? undefined : parseVersion(text);
      if (!current) return undefined;
      // 版を待つ間に OFF にされたら、GitHub に問い合わせない（PR #147 レビュー指摘）
      if (!this.current(generation)) return undefined;
      const res = await (this.deps.fetch ?? fetch)(
        `https://api.github.com/repos/${SACTY_REPOSITORY}/releases/latest`,
        {
          headers: { accept: "application/vnd.github+json", "user-agent": "sacty-update-check" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      // リリースが1つも無ければ 404。レート制限などの失敗も黙る
      if (!res.ok) return undefined;
      const parsed = Release.safeParse(await res.json());
      if (!parsed.success || parsed.data.draft || parsed.data.prerelease) return undefined;
      const latest = parseVersion(parsed.data.tag_name);
      // タグが版の形でない・同じ・古い（手元が開発中の新しい版）なら知らせない
      if (!latest || compareVersions(latest, current) <= 0) return undefined;
      return {
        latest: formatVersion(latest),
        current: formatVersion(current),
        releaseUrl: parsed.data.html_url,
      };
    } catch {
      return undefined;
    }
  }
}

/** 動いている sacty の版を書いたファイル（src・dist のどちらからも apps/daemon/package.json）。 */
const PACKAGE_JSON = new URL("../package.json", import.meta.url);

/** 動いている sacty の版（apps/daemon/package.json の version）。読めなければ undefined。 */
export async function packageVersion(
  file: URL | string = PACKAGE_JSON,
): Promise<string | undefined> {
  try {
    const parsed = z
      .object({ version: z.string() })
      .safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data.version : undefined;
  } catch {
    return undefined;
  }
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
