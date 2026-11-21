/*
 * PR・Issue に投稿する文に載せる、タスクの画面へのリンク（PBI-450）。画面の URL（SACTY_WEB_URL）が、依頼した人のマシンの
 * ループバックなら、GitHub の側だけで PR を読む人は開けないので、注釈を添える。
 */

/** 注釈（リンクのある文の直後に 1 文で足す）。 */
export const TASK_LINK_NOTE = "タスクの画面は、依頼した人のマシンでだけ開けます。";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 画面の URL のホストが、依頼した人のマシンでしか開けないものか。URL として読めないときも、注意を残す側（true）に倒す。 */
export function isLocalOnlyUrl(webUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(webUrl).hostname.toLowerCase());
  } catch {
    return true;
  }
}

/** タスクの画面の URL と、注釈が要るか。 */
export function taskLink(webUrl: string, taskId: string): { url: string; localOnly: boolean } {
  return {
    url: `${webUrl.replace(/\/+$/, "")}/tasks/${taskId}`,
    localOnly: isLocalOnlyUrl(webUrl),
  };
}

/** リンクのある文の直後に足す注釈（要らなければ空の配列）。 */
export function taskLinkNote(localOnly: boolean | undefined): string[] {
  return localOnly ? [TASK_LINK_NOTE] : [];
}
