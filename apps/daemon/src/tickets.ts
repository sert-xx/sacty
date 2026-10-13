import { type DaemonText, message, type TicketService } from "@sacty/core";
import { MessageError } from "./errors.js";
import { hideSecret, isAllowed, type Platform, type PlatformCredentials } from "./platforms.js";

/**
 * チケットの管理のサービス（JIRA）の検索とコメント（PBI-52）。接続先と認証は、ゲートウェイの組織内 PF の設定
 * （gateway.platforms）のものを使い、デーモン（ホスト）から呼ぶ。PF の allow に無い API は呼ばない（利用者が許したもの
 * だけを使う）。Jira Cloud と Jira Server / Data Center の API の違い（検索の API）はここで吸収する。
 */

/** 取り込みで見つけたチケット（中身はオーケストレーターがゲートウェイ経由で読む）。 */
export type FoundTicket = {
  platform: string;
  service: TicketService;
  key: string;
  summary: string;
  url: string;
};

export interface TicketClient {
  /** キーのプロジェクトの、ラベルの付いた、終わっていないチケットを探す。 */
  search(input: {
    platform: Platform;
    service: TicketService;
    keys: readonly string[];
    label: string;
  }): Promise<FoundTicket[]>;
  /** チケットにコメントする。コメントの URL を返す。 */
  comment(input: {
    platform: Platform;
    service: TicketService;
    key: string;
    body: string;
  }): Promise<{ url: string }>;
}

/** 1ページで読む数と、1回の取り込みで読むページの上限（取り込みは定期的に行うので、残りは次の回に読む）。 */
const SEARCH_LIMIT = 50;
const SEARCH_PAGES = 10;

/** チケットのキー（PAY-123）の形。 */
const TICKET_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** JQL（キーのプロジェクト・ラベル・終わっていない）。キーとラベルは設定で形を確かめてある。 */
export function ticketJql(keys: readonly string[], label: string): string {
  const projects = keys.map((k) => `"${k}"`).join(", ");
  return `project in (${projects}) AND labels = "${label}" AND statusCategory != Done ORDER BY created ASC`;
}

/** チケットの画面の URL。 */
export function ticketUrl(platform: Platform, key: string): string {
  return `${platform.upstream}/browse/${key}`;
}

export class JiraTickets implements TicketClient {
  constructor(
    private readonly deps: { credentials: PlatformCredentials; fetchImpl?: typeof fetch },
  ) {}

  private async call(
    platform: Platform,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    // 利用者が allow に書いた API だけを使う
    if (!isAllowed(platform, method, path)) {
      throw new MessageError(
        message("ticket.notAllowed", {
          platform: platform.name,
          method,
          path: path.split("?")[0] ?? "",
        }),
      );
    }
    const header = await this.deps.credentials.header(platform);
    const res = await (this.deps.fetchImpl ?? fetch)(`${platform.upstream}${path}`, {
      method,
      headers: {
        [platform.auth.header]: header,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });
    const text = await res.text();
    if (!res.ok) {
      // 応答の本文に認証の値（ヘッダーの値・接頭辞を除いた値）が含まれていても出さない
      throw new MessageError(
        message("ticket.requestFailed", {
          platform: platform.name,
          status: res.status,
          // 伏せてから切り詰める（境界をまたいだ値の一部を残さない）
          detail: hideSecret(
            hideSecret(text, header),
            header.slice(platform.auth.prefix.length),
          ).slice(0, 300),
        }),
      );
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  async search(input: Parameters<TicketClient["search"]>[0]): Promise<FoundTicket[]> {
    const found: FoundTicket[] = [];
    // 古い順に読むので、ページを送らないと、取り込み済みの先頭のチケットだけを読み続けてしまう
    let startAt = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const query = new URLSearchParams({
        jql: ticketJql(input.keys, input.label),
        fields: "summary",
        maxResults: String(SEARCH_LIMIT),
        // Cloud は次のページの印（nextPageToken）、Server / Data Center は読み始める位置（startAt）で送る
        ...(input.service === "jira-cloud"
          ? pageToken
            ? { nextPageToken: pageToken }
            : {}
          : { startAt: String(startAt) }),
      }).toString();
      // Cloud は新しい検索の API（/rest/api/3/search/jql）、Server / Data Center は /rest/api/2/search
      const path =
        input.service === "jira-cloud"
          ? `/rest/api/3/search/jql?${query}`
          : `/rest/api/2/search?${query}`;
      const result = (await this.call(input.platform, "GET", path)) as {
        issues?: { key?: unknown; fields?: { summary?: unknown } }[];
        total?: unknown;
        nextPageToken?: unknown;
        isLast?: unknown;
      };
      const issues = Array.isArray(result.issues) ? result.issues : [];
      for (const issue of issues) {
        const key = typeof issue.key === "string" ? issue.key : "";
        if (!TICKET_KEY.test(key)) continue;
        found.push({
          platform: input.platform.name,
          service: input.service,
          key,
          summary:
            typeof issue.fields?.summary === "string" ? issue.fields.summary.slice(0, 200) : "",
          url: ticketUrl(input.platform, key),
        });
      }
      if (issues.length === 0) break;
      if (input.service === "jira-cloud") {
        if (result.isLast === true || typeof result.nextPageToken !== "string") break;
        pageToken = result.nextPageToken;
      } else {
        startAt += issues.length;
        if (typeof result.total !== "number" || startAt >= result.total) break;
      }
    }
    return found;
  }

  async comment(input: Parameters<TicketClient["comment"]>[0]): Promise<{ url: string }> {
    if (!TICKET_KEY.test(input.key)) throw new Error(`invalid ticket key: ${input.key}`);
    // コメントの API は、Cloud・Server / Data Center とも /rest/api/2（本文は文字列）で書ける
    const result = (await this.call(
      input.platform,
      "POST",
      `/rest/api/2/issue/${input.key}/comment`,
      {
        body: input.body,
      },
    )) as { id?: unknown };
    const id =
      typeof result.id === "string" || typeof result.id === "number" ? String(result.id) : "";
    const url = ticketUrl(input.platform, input.key);
    return { url: id ? `${url}?focusedCommentId=${id}` : url };
  }
}

/** 取り込みの検索の失敗の理由（作業履歴・画面に出す）。 */
export function ticketErrorText(error: unknown): DaemonText {
  if (error instanceof MessageError) return error.text;
  return error instanceof Error ? error.message : String(error);
}
