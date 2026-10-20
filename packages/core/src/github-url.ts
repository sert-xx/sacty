import { z } from "zod";
import { code } from "./message-code.js";
import type { MessageCode } from "./messages.js";

/**
 * GitHub のリポジトリ・Org は、ホストを含めた URL で表す（github.com も GitHub Enterprise Server も同じ形。PBI-40）。
 * 例 https://github.com/acme/app、https://ghe.example.co.jp/acme。
 */

/** Org・ユーザーの名前（先頭は英数字）。 */
const OWNER = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
/**
 * リポジトリの名前。GitHub では先頭がドット・アンダースコアのもの（.github、_tools など）も作れるので、
 * 先頭も制限しない。. と .. だけは名前にできない（PBI-40 レビュー指摘）。
 */
const NAME = "(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}";
const HOST = "[A-Za-z0-9.-]+(?::\\d+)?";
const REPO_URL = new RegExp(`^https://(${HOST})/(${OWNER})/(${NAME})$`);
const ORG_URL = new RegExp(`^https://(${HOST})/(${OWNER})$`);

/** 貼り付けで紛れ込む、見えない文字（ゼロ幅の空白・BOM など）。 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * 書き方の揺れ（全角の文字・見えない文字・クエリ・フラグメント・末尾の /・.git、ホストの大文字）をそろえる。
 * 全角の「：」「／」や、チャットからの貼り付けで入るゼロ幅の空白は、見た目では正しい URL と区別できない。
 */
function normalize(url: string): string {
  const trimmed = url
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return trimmed.replace(
    /^https:\/\/([^/]+)/i,
    (_, host: string) => `https://${host.toLowerCase()}`,
  );
}

/**
 * 対象の URL を読めない理由（読めれば undefined。空も undefined）。見た目では正しそうな URL を、どこが違うのか示すために使う。
 */
export function targetUrlProblem(scope: "org" | "repo", url: string): MessageCode | undefined {
  const normalized = normalize(url);
  if (!normalized) return undefined;
  if ((scope === "repo" ? REPO_URL : ORG_URL).test(normalized)) return undefined;
  if (/^(git@|ssh:\/\/)/i.test(normalized)) return "input.urlSsh";
  if (/^http:\/\//i.test(normalized)) return "input.urlNotHttps";
  const match = normalized.match(/^https:\/\/([^/]*)(\/.*)?$/);
  if (!match) return scope === "repo" ? "input.invalidRepo" : "input.invalidOrg";
  const [, authority = "", path = ""] = match;
  if (authority.includes("@")) return "input.urlCredentials";
  if (!new RegExp(`^${HOST}$`).test(authority)) return "input.urlHost";
  const segments = path.split("/").filter(Boolean).length;
  if (scope === "repo" && segments === 1) return "input.repoLooksLikeOrg";
  if (scope === "org" && segments === 2) return "input.orgLooksLikeRepo";
  if (segments > (scope === "repo" ? 2 : 1)) return "input.urlExtraPath";
  return scope === "repo" ? "input.invalidRepo" : "input.invalidOrg";
}

/** リポジトリの URL（https://<ホスト>/<owner>/<name>）。 */
export const RepoUrl = z
  .string()
  .transform(normalize)
  .superRefine((url, ctx) => {
    const problem = url ? targetUrlProblem("repo", url) : "input.invalidRepo";
    if (problem) ctx.addIssue({ code: "custom", message: code(problem) });
  });

/** Org（またはユーザー）の URL（https://<ホスト>/<owner>）。 */
export const OrgUrl = z
  .string()
  .transform(normalize)
  .superRefine((url, ctx) => {
    const problem = url ? targetUrlProblem("org", url) : "input.invalidOrg";
    if (problem) ctx.addIssue({ code: "custom", message: code(problem) });
  });

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
