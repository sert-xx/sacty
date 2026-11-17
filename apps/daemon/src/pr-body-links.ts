import { Worker } from "node:worker_threads";
import { CONTAINER_WORKSPACE } from "./agents/docker.js";
import { redact } from "./agents/redact.js";
import { type ConvertJob, cannotLinkToWorkspace } from "./pr-body-links-worker.js";
import { PR_BODY_MAX } from "./pr-template.js";

// PR の本文から、コンテナの作業領域のパスへのリンクを外す（PBI-366）。外し方は `convertWorkspaceLinks`
// （`pr-body-links-worker.ts`）に書く。その解析は同期で動き、終わるまで戻らない（記号が長く続く本文では、数秒〜数十秒）
// ので、デーモンのスレッドでは呼ばない。このファイルが、別スレッドで動かして、時間とメモリを区切る（PBI-372）。

/**
 * 1つの本文の解析を待つ時間の上限（ミリ秒）。別スレッドを起動してから数える（順番を待つ時間は入れない）。ふつうの本文
 * （長さの上限いっぱいの本文）は、別スレッドの起動を含めて 0.1〜0.3 秒で終わる。記号が長く続く本文は、長さの上限では
 * 数秒〜数十秒かかるので、ここで打ち切って、本文を変えずに使う。待つ間も、デーモンはほかの処理に応える。
 */
export const PARSE_TIMEOUT_MS = 5_000;

/**
 * 別スレッドのメモリ（古い世代のヒープ）の上限（MB）。超えたら、別スレッドはエラーで終わり、本文を変えずに使う。長さの上限
 * いっぱいのふつうの本文（リンクの並び・見出しと表とコードと箇条書き・文とリンク）は、40MB で解析できた（32MB では、
 * できないものがあった）。その3倍ほどを取る。
 */
export const PARSE_MEMORY_MB = 128;

/**
 * 同時に動かす別スレッドの数。1つずつ動かし、ほかは順番を待つ（遅い本文が重なっても、使う CPU とメモリは1つ分）。
 * ふつうの本文は 0.1〜0.3 秒で終わるので、待ちは短い。前に遅い本文があるときは、その1つにつき最大で時間の上限だけ待つ。
 */
const PARSE_CONCURRENCY = 1;

/**
 * 作業領域へのリンクを外さなかった理由。timeout：解析が時間の上限までに終わらなかった。error：解析に失敗した（例外・
 * メモリの上限・別スレッドを起動できない・別スレッドが答えずに終わった）。
 */
export type UnlinkSkipped = "timeout" | "error";

/**
 * リンクを外した結果。body：PR に書く本文。skipped：外せなかったので、リンクを外さなかった（その理由）。cause：失敗
 * （error）の原因の短い文字（エラーの名前・コード・終了コード。本文の中身は入れない）。
 */
export type UnlinkedBody = { body: string; skipped?: UnlinkSkipped; cause?: string };

/** 解析に使う別スレッドのうち、ここで使う部分（テストで差し替える）。 */
export type ConvertWorker = {
  once(event: "message", listener: (answer: unknown) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
};

/** timeoutMs：解析を待つ時間の上限を変える。startWorker：別スレッドの起動を差し替える（どちらもテスト用）。 */
export type UnlinkOptions = {
  timeoutMs?: number;
  startWorker?: (job: ConvertJob) => ConvertWorker;
};

/** 別スレッドを起動する。読むファイルは、ビルドした成果物では `.js`、ソースのまま動かすとき（テスト）は `.ts`。 */
function startConvertWorker(job: ConvertJob): ConvertWorker {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new Worker(new URL(`./pr-body-links-worker.${extension}`, import.meta.url), {
    workerData: job,
    resourceLimits: { maxOldGenerationSizeMb: PARSE_MEMORY_MB },
  });
}

/** 例外の、ログに出してよい短い名前（コードがあればコード、無ければ名前。メッセージは、本文の中身を含みうるので出さない）。 */
function errorLabel(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "Error";
}

let running = 0;
const waiting: (() => void)[] = [];

/** work を、同時に動かす数の上限の中で動かす。上限に達していれば、前の仕事が終わるまで、来た順に待つ。 */
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (running < PARSE_CONCURRENCY) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    // 待っている仕事があれば、空いた番をそのまま渡す。無ければ、番を返す
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/**
 * 1つの本文を、別スレッドで変換する。時間の上限までに終わらなければ、別スレッドを止めて、本文を変えずに返す。別スレッドの
 * 失敗（変換の中の例外・メモリの上限・起動の失敗・答えずに終わった・答えの形が違う）でも、本文を変えずに返す。
 */
function convertInWorker(
  body: string,
  timeoutMs: number,
  start: (job: ConvertJob) => ConvertWorker,
): Promise<UnlinkedBody> {
  return new Promise((resolve) => {
    let worker: ConvertWorker | undefined;
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
    const failed = (cause: string) => finish({ body, skipped: "error", cause });
    try {
      worker = start({ sactyPrBodyLinks: true, body, workspace: CONTAINER_WORKSPACE });
    } catch (error) {
      failed(`別スレッドを起動できない（${errorLabel(error)}）`);
      return;
    }
    timer = setTimeout(() => finish({ body, skipped: "timeout" }), timeoutMs);
    worker.once("message", (answer) => {
      const converted = answer as { body?: unknown; failed?: unknown } | null;
      if (typeof converted?.failed === "string") {
        failed(`変換の例外（${errorLabel({ name: converted.failed })}）`);
        // 置き換えは本文を長くしない。そうでない答え・本文の無い答えは、使わない
      } else if (typeof converted?.body !== "string" || converted.body.length > body.length) {
        failed("別スレッドの答えが不正");
      } else {
        finish({ body: converted.body });
      }
    });
    // 別スレッドの中の、変換の外の例外・メモリの上限・ファイルの読み込みの失敗
    worker.once("error", (error) => failed(`別スレッドのエラー（${errorLabel(error)}）`));
    worker.once("exit", (code) => failed(`別スレッドが答えずに終了（終了コード ${code}）`));
  });
}

/**
 * 作業領域へのリンクを、別スレッドで外す（PBI-372）。解析（`convertWorkspaceLinks`）は同期で、途中で止められないので、
 * デーモンのスレッドでは動かさない。遅くなる本文を、解析の前に形で見分けることはしない（遅くなる形は、記号の種類と並びの
 * 組み合わせでいくつもあり、ふつうの本文と区別しきれない）。
 *
 * 作業領域へのリンクがありえない本文（`cannotLinkToWorkspace`。本文の長さに比例する時間で分かる）は、別スレッドを
 * 起動せず、順番も待たずに、そのまま返す。別スレッドは、本文ごとに1つ起動して、答えを受け取ったら止める。同時に動かすのは
 * 1つで、ほかの本文は順番を待つ。時間の上限は、順番が来て別スレッドを起動してから数える。
 */
function convertOffThread(body: string, options: UnlinkOptions): Promise<UnlinkedBody> {
  if (cannotLinkToWorkspace(body, CONTAINER_WORKSPACE)) return Promise.resolve({ body });
  return inTurn(() =>
    convertInWorker(
      body,
      options.timeoutMs ?? PARSE_TIMEOUT_MS,
      options.startWorker ?? startConvertWorker,
    ),
  );
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
  const { body: converted, ...skipped } = await convertOffThread(body, options);
  if (converted === body && !always) return { body, ...skipped };
  const hidden = redact(converted, secrets);
  return { body: hidden.length <= PR_BODY_MAX ? hidden : body, ...skipped };
}

/**
 * sacty が組み立てた本文（長さの上限と、秘密の値の扱いの後のもの）から、作業領域へのリンクを外す。外すリンクが無くても、
 * 伏せ直す（sacty が書いた文字だけの本文なので、秘密の値と同じ文字は、いつも伏せてよい）。解析は別スレッドで動かし、
 * 時間の上限までに終わらない・失敗したときは、リンクを外さずに（伏せ直しはして）返す（skipped に理由）。
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
