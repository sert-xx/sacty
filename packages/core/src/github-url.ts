import { z } from "zod";
import { code } from "./message-code.js";

/**
 * GitHub のリポジトリ・Org は、ホストを含めた URL で表す（github.com も GitHub Enterprise Server も同じ形。PBI-40）。
 * 例 https://github.com/acme/app、https://ghe.example.co.jp/acme。
 */

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const HOST = "[A-Za-z0-9.-]+(?::\\d+)?";
const REPO_URL = new RegExp(`^https://(${HOST})/(${SEGMENT})/(${SEGMENT})$`);
const ORG_URL = new RegExp(`^https://(${HOST})/(${SEGMENT})$`);

/** 書き方の揺れ（末尾の /・.git、ホストの大文字）をそろえる。 */
function normalize(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return trimmed.replace(
    /^https:\/\/([^/]+)/i,
    (_, host: string) => `https://${host.toLowerCase()}`,
  );
}

/** リポジトリの URL（https://<ホスト>/<owner>/<name>）。 */
export const RepoUrl = z
  .string()
  .transform(normalize)
  .pipe(z.string().regex(REPO_URL, code("input.invalidRepo")));

/** Org（またはユーザー）の URL（https://<ホスト>/<owner>）。 */
export const OrgUrl = z
  .string()
  .transform(normalize)
  .pipe(z.string().regex(ORG_URL, code("input.invalidOrg")));

export type GitHubRepo = { url: string; host: string; owner: string; name: string; path: string };

/** リポジトリの URL を読む（読めなければ undefined）。 */
export function parseRepoUrl(url: string): GitHubRepo | undefined {
  const normalized = normalize(url);
  const match = normalized.match(REPO_URL);
  if (!match) return undefined;
  const [, host = "", owner = "", name = ""] = match;
  return { url: normalized, host, owner, name, path: `${owner}/${name}` };
}

/** Org の URL を読む（読めなければ undefined）。 */
export function parseOrgUrl(url: string): { url: string; host: string; owner: string } | undefined {
  const normalized = normalize(url);
  const match = normalized.match(ORG_URL);
  if (!match) return undefined;
  const [, host = "", owner = ""] = match;
  return { url: normalized, host, owner };
}

/** リポジトリの URL の、Org の URL。 */
export function orgUrlOf(repoUrl: string): string {
  const repo = parseRepoUrl(repoUrl);
  return repo ? `https://${repo.host}/${repo.owner}` : "";
}

/** URL が同じか（GitHub の名前は大文字・小文字を区別しない）。 */
export function sameGitHubUrl(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

/** GitHub の REST API の URL（GitHub の仕様で、github.com だけが別のホスト）。 */
export function githubApiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}
