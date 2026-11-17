import { Worker } from "node:worker_threads";
import { CONTAINER_WORKSPACE } from "./agents/docker.js";
import { redact } from "./agents/redact.js";
import {
  type ConvertJob,
  cannotLinkToWorkspace,
  convertWorkspaceLinks,
} from "./pr-body-links-worker.js";
import { PR_BODY_MAX } from "./pr-template.js";

/**
 * PR の本文から、コンテナの作業領域のパスへのリンクを外す（PBI-366）。外し方は `convertWorkspaceLinks`
 * （`pr-body-links-worker.ts`）に書く。解析できなければ、本文を変えずに返す。
 *
 * この関数は同期で動き、解析が終わるまで戻らない（記号が長く続く本文では、数秒〜数十秒）。デーモンは、PR の作成・更新で
 * この関数を直接は呼ばず、別スレッドで動かして時間を区切る（`unlinkedGeneratedBody`・`unlinkedMergedBody`）。
 */
export function withoutWorkspaceLinks(body: string): string {
  return convertWorkspaceLinks(body, CONTAINER_WORKSPACE).body;
}

/**
 * 本文の解析を待つ時間の上限（ミリ秒）。ふつうの本文（長さの上限いっぱいにリンクが並ぶもの）は、別スレッドの起動を含めて
 * 0.2 秒ほどで終わる。記号が長く続く本文は、長さの上限では数秒〜数十秒かかるので、ここで打ち切って、本文を変えずに使う。
 * 待つ間も、デーモンはほかの処理に応える（解析は別スレッドで動く）。
 */
export const PARSE_TIMEOUT_MS = 5_000;

/**
 * 作業領域へのリンクを外さなかった理由。timeout：解析が時間の上限までに終わらなかった。error：解析に失敗した（例外・
 * 別スレッドを起動できない・別スレッドが答えずに終わった）。
 */
export type UnlinkSkipped = "timeout" | "error";

/** リンクを外した結果。body：PR に書く本文。skipped：外せなかったので、本文を変えなかった（その理由）。 */
export type UnlinkedBody = { body: string; skipped?: UnlinkSkipped };

/** 解析を待つ時間の上限を変える（テスト用）。 */
export type UnlinkOptions = { timeoutMs?: number };

/** 別スレッドで読むファイル。ビルドした成果物では `.js`、ソースのまま動かすとき（テスト）は `.ts`。 */
function workerFile(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./pr-body-links-worker.${extension}`, import.meta.url);
}

/**
 * 作業領域へのリンクを、別スレッドで外す（PBI-372）。解析（`convertWorkspaceLinks`）は同期で、途中で止められないので、
 * デーモンのスレッドでは動かさない。時間の上限までに終わらなければ、別スレッドを止めて、本文を変えずに返す（PR の作成・
 * 更新は止めない）。遅くなる本文を、解析の前に形で見分けることはしない（遅くなる形は、記号の種類と並びの組み合わせで
 * いくつもあり、ふつうの本文と区別しきれない）。
 *
 * 作業領域へのリンクがありえない本文（`cannotLinkToWorkspace`。本文の長さに比例する時間で分かる）は、別スレッドを
 * 起動せずに、そのまま返す。別スレッドは、呼ぶたびに1つ起動して、答えを受け取ったら止める。
 */
function convertOffThread(body: string, timeoutMs: number): Promise<UnlinkedBody> {
  if (cannotLinkToWorkspace(body, CONTAINER_WORKSPACE)) return Promise.resolve({ body });
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (result: UnlinkedBody) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 止めるのに失敗しても、結果は変えない（別スレッドは、デーモンが終わるときに一緒に終わる）
      worker?.terminate().catch(() => {});
      resolve(result);
    };
    try {
      const job: ConvertJob = { sactyPrBodyLinks: true, body, workspace: CONTAINER_WORKSPACE };
      worker = new Worker(workerFile(), { workerData: job });
    } catch {
      finish({ body, skipped: "error" });
      return;
    }
    timer = setTimeout(() => finish({ body, skipped: "timeout" }), timeoutMs);
    worker.once("message", (answer: unknown) => {
      const converted = answer as { body?: unknown; failed?: unknown } | null;
      // 置き換えは本文を長くしない。そうでない答えは、使わない
      if (typeof converted?.body !== "string" || converted.body.length > body.length) {
        finish({ body, skipped: "error" });
      } else if (converted.failed === true) {
        finish({ body, skipped: "error" });
      } else {
        finish({ body: converted.body });
      }
    });
    // 別スレッドの中の例外・メモリの上限・読み込みの失敗と、答えを送らずに終わったとき
    worker.once("error", () => finish({ body, skipped: "error" }));
    worker.once("exit", () => finish({ body, skipped: "error" }));
  });
}

/**
 * 作業領域へのリンクを外した本文を、PR に書ける形にする。外した後に文字がつながる・リンク先の文字参照が元の文字に戻ると、
 * 伏せたはずの秘密の値（secrets）が現れうるので、外した後に伏せ直す。伏せた結果が長さの上限を超える（伏せ字が値より
 * 長い）ときは、外すのをやめて、渡された本文（上限の中）を返す。always：外すリンクが無くても、伏せ直すか。
 */
async function unlinked(
  body: string,
  secrets: readonly string[],
  always: boolean,
  options: UnlinkOptions,
): Promise<UnlinkedBody> {
  const converted = await convertOffThread(body, options.timeoutMs ?? PARSE_TIMEOUT_MS);
  const skipped = converted.skipped ? { skipped: converted.skipped } : {};
  if (converted.body === body && !always) return { body, ...skipped };
  const hidden = redact(converted.body, secrets);
  return { body: hidden.length <= PR_BODY_MAX ? hidden : body, ...skipped };
}

/**
 * sacty が組み立てた本文（長さの上限と、秘密の値の扱いの後のもの）から、作業領域へのリンクを外す。外すリンクが無くても、
 * 伏せ直す（sacty が書いた文字だけの本文なので、秘密の値と同じ文字は、いつも伏せてよい）。解析は別スレッドで動かし、
 * 時間の上限までに終わらない・失敗したときは、リンクを外さずに返す（skipped に理由）。
 */
export function unlinkedGeneratedBody(
  body: string,
  secrets: readonly string[],
  options: UnlinkOptions = {},
): Promise<UnlinkedBody> {
  return unlinked(body, secrets, true, options);
}

/**
 * すでにある PR の更新で、人の直しとマージした本文・エージェントがまとめた本文（どれも長さの上限の中）から、作業領域への
 * リンクを外す。`unlinkedGeneratedBody` と違い、伏せ直すのは、外して本文が変わったときだけ。外すリンクが無ければ、
 * 渡された本文をそのまま返す（人が書いた文字を含む本文なので、作業領域へのリンクが無い本文には、手を加えない）。解析は
 * 別スレッドで動かし、時間の上限までに終わらない・失敗したときは、渡された本文をそのまま返す（skipped に理由）。
 */
export function unlinkedMergedBody(
  body: string,
  secrets: readonly string[],
  options: UnlinkOptions = {},
): Promise<UnlinkedBody> {
  return unlinked(body, secrets, false, options);
}
