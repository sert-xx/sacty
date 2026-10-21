import { githubApiBase, StepKey } from "@sacty/core";

/** 工程の実行の役割（出力が工程の成果になるもの）。 */
const STEP_ROLES = StepKey.options;

/**
 * ゲートウェイの GitHub の読み取りの中継（`/r/<実行のトークン>/github/<ホスト>/<パス>`）の、転送先と読み取りの判定。
 * 認証は、タスクのプロジェクトでそのホストに選んだ gh のアカウントのトークンを、ホストで付ける（コンテナには渡さない）。
 * 書き込みはさせない（REST は GET・HEAD だけ、GraphQL は query の操作だけ）。PR・Issue への投稿は、エージェントが
 * 出力に書き、承認の後に sacty が行う。
 */

/** GraphQL の API の URL（GitHub の仕様で、github.com だけが別のホスト）。 */
export function githubGraphqlUrl(host: string): string {
  return host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
}

/** 中継の転送先の起点（REST の API）。 */
export function githubRestBase(host: string): string {
  return githubApiBase(host);
}

/** 上流へ送るヘッダー（読み取りに要るものだけ。認証・cookie などは送らない）。 */
export const GITHUB_RELAY_REQUEST = new Set([
  "accept",
  "content-type",
  "x-github-api-version",
  "if-none-match",
  "if-modified-since",
  "user-agent",
]);

/** GraphQL の要求の本文の上限（読み取りの問い合わせには十分な大きさ）。 */
export const GITHUB_GRAPHQL_BODY_MAX = 256 * 1024;

/**
 * GraphQL の要求が、読み取り（query の操作と fragment だけ）か。mutation・subscription を含むもの、読めないもの、
 * 複数の要求をまとめたもの（配列）、query の文字列の無いもの（persisted query など）は、読み取りとみなさない。
 *
 * 判定は、文字列・コメントを除いた、括弧（{}・()）の外の語で行う。操作の種類（mutation など）は必ずそこに書くので、
 * そこに mutation・subscription があれば断る（操作の名前が mutation でも断る。読み取りを断ることはあっても、
 * 書き込みを通すことはない）。
 */
export function isReadOnlyGraphql(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const query = (parsed as { query?: unknown }).query;
  if (typeof query !== "string" || !query.trim()) return false;
  const words = topLevelWords(query);
  if (!words) return false;
  return !words.some((w) => w === "mutation" || w === "subscription");
}

/** 括弧の外の語（名前）。文字列・括弧が閉じていなければ undefined。 */
function topLevelWords(query: string): string[] | undefined {
  const words: string[] = [];
  let braces = 0;
  let parens = 0;
  let i = 0;
  while (i < query.length) {
    const c = query[i] ?? "";
    if (c === "#") {
      while (i < query.length && query[i] !== "\n" && query[i] !== "\r") i++;
      continue;
    }
    if (c === '"') {
      const block = query.startsWith('"""', i);
      const end = block ? blockStringEnd(query, i + 3) : stringEnd(query, i + 1);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "(") parens++;
    else if (c === ")") parens--;
    if (braces < 0 || parens < 0) return undefined;
    if (/[_A-Za-z]/.test(c)) {
      let end = i + 1;
      while (end < query.length && /[_0-9A-Za-z]/.test(query[end] ?? "")) end++;
      if (braces === 0 && parens === 0) words.push(query.slice(i, end));
      i = end;
      continue;
    }
    i++;
  }
  return braces === 0 && parens === 0 ? words : undefined;
}

/** 文字列（"…"）の終わりの次の位置。閉じていなければ undefined。 */
function stringEnd(query: string, from: number): number | undefined {
  for (let i = from; i < query.length; i++) {
    const c = query[i];
    if (c === "\\") i++;
    else if (c === '"') return i + 1;
    else if (c === "\n" || c === "\r") return undefined;
  }
  return undefined;
}

/** ブロックの文字列（"""…"""）の終わりの次の位置。閉じていなければ undefined。 */
function blockStringEnd(query: string, from: number): number | undefined {
  for (let i = from; i < query.length; i++) {
    if (query.startsWith('\\"""', i)) {
      i += 3;
      continue;
    }
    if (query.startsWith('"""', i)) return i + 3;
  }
  return undefined;
}

/**
 * 上流の応答のヘッダーの URL（ページ送りの link・リダイレクトの location）のうち、そのホストの API の URL を、
 * 中継の URL に置き換える（コンテナから直接 API に送ると、認証が付かないため）。
 */
export function relayHeaderValue(value: string, host: string, relayBase: string): string {
  const api = githubRestBase(host);
  return value.split(api).join(relayBase);
}

/** エージェントに渡す、GitHub の読み取りの中継の環境変数。 */
export function githubRelayEnv(
  url: string,
  hosts: readonly string[],
  defaultHost: string,
): Record<string, string> {
  return {
    SACTY_GITHUB_URL: url,
    SACTY_GITHUB_HOSTS: hosts.join(" "),
    // イメージの gh（gh api だけを中継に送るもの）の既定のホスト
    GH_HOST: defaultHost,
  };
}

/** 投稿を頼める、1 回の出力のコメントの数の上限。 */
export const GITHUB_COMMENTS_MAX = 10;
/** 投稿を頼めるコメントの本文の上限（GitHub の上限 65536 文字から、sacty が付ける分を引いたもの）。 */
export const GITHUB_COMMENT_BODY_MAX = 60_000;
/** 投稿を頼む JSON の見出し。 */
export const GITHUB_COMMENTS_HEADING = "sacty-github-comments";

/**
 * エージェントへの指示に足す、GitHub の読み方と、投稿の頼み方。投稿を頼めるのは、出力が工程の成果になる実行
 * （レビューを除く工程）だけ。レビューは、書いたレビューを sacty が投稿する。
 */
export function githubPromptLines(hosts: readonly string[], role: string): string[] {
  const posting = role !== "review" && (STEP_ROLES as readonly string[]).includes(role);
  return [
    "--- GitHub（読み取り） ---",
    "GitHub の API は、sacty のゲートウェイ経由で読み取りだけできます（トークンはコンテナにありません。ゲートウェイが、プロジェクトの GitHub のアカウントで認証します）。",
    `- 使えるホスト：${hosts.join("・")}（gh の既定は環境変数 GH_HOST。ほかのホストは --hostname で選ぶ）`,
    "- gh は gh api だけ使えます（REST の GET と、GraphQL の query）。gh pr view などのほかのコマンドと、書き込み（POST・PATCH・mutation）はできません",
    "- 例：gh api repos/<owner>/<repo>/pulls/<番号>、gh api --paginate repos/<owner>/<repo>/pulls/<番号>/comments、gh api repos/<owner>/<repo>/issues/<番号>/comments、gh api graphql -f query='query { … }'",
    '- curl でも読めます：curl "$SACTY_GITHUB_URL/<ホスト>/repos/<owner>/<repo>/pulls/<番号>"（GraphQL は $SACTY_GITHUB_URL/<ホスト>/graphql に POST）',
    ...(posting
      ? [
          "- PR・Issue にコメントを書く必要があれば、あなたは投稿しません。投稿する内容を、出力の最後に次の形の JSON で1つだけ書いてください。人間がこの工程の成果を承認した後に、sacty がプロジェクトの GitHub のアカウントで投稿します（承認されなければ投稿しません）",
          "```json",
          `{"${GITHUB_COMMENTS_HEADING}": {"comments": [{"url": "https://<ホスト>/<owner>/<repo>/pull/<番号>", "body": "Markdown の本文"}]}}`,
          "```",
          `  - url は、プロジェクトの対象のリポジトリの PR（/pull/<番号>）か Issue（/issues/<番号>）の URL。コメントは ${GITHUB_COMMENTS_MAX} 件まで、本文は ${GITHUB_COMMENT_BODY_MAX} 文字まで`,
          "  - AI による投稿である旨は sacty が付けるので、本文に書かない。投稿しないなら、この JSON を書かない",
        ]
      : role === "review"
        ? ["- PR への投稿は、書いたレビューを sacty がする。あなたは投稿しない"]
        : []),
  ];
}
