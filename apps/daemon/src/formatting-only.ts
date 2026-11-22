import { extname } from "node:path";
import { type ParserPlugin, parse, parseExpression } from "@babel/parser";
import { type RepositoryWorkspace, validPath } from "./repository.js";

/** 差分の本文を作らず、比較できるファイルだけを検査する。 */
export async function formattingOnlyFiles(
  repos: RepositoryWorkspace,
  gitDir: string,
  baseline: { tree: string; merged: { before: string; after: string }[] },
  submitted: string,
): Promise<string[]> {
  const changed = await repos.treeChanges(gitDir, baseline.tree, submitted);
  const excluded = new Set<string>();
  for (const merge of baseline.merged) {
    for (const change of await repos.treeChanges(gitDir, merge.before, merge.after)) {
      excluded.add(change.path);
      if (change.oldPath) excluded.add(change.oldPath);
    }
  }
  const result: string[] = [];
  for (const change of changed) {
    if (
      change.status !== "M" ||
      change.oldMode !== change.newMode ||
      (change.oldMode !== "100644" && change.oldMode !== "100755") ||
      !validPath(change.path) ||
      excluded.has(change.path)
    )
      continue;
    try {
      const before = await repos.treeBlob(gitDir, change.oldObject);
      const after = await repos.treeBlob(gitDir, change.newObject);
      if (formattingOnly(change.path, before, after)) result.push(change.path);
    } catch {
      // 読めないファイルは検査しない。
    }
  }
  return result;
}

/** Compare syntax without ignoring literal spelling, comments, or meaningful whitespace. */
export function formattingOnly(path: string, before: string, after: string): boolean {
  if (Buffer.byteLength(before) > 256 * 1024 || Buffer.byteLength(after) > 256 * 1024) return false;
  if (before === after || before.includes("\0") || after.includes("\0")) return false;
  const extension = extname(path);
  const plugins: ParserPlugin[] = [];
  if ([".ts", ".mts", ".cts", ".tsx"].includes(extension)) plugins.push("typescript");
  if ([".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) plugins.push("jsx");
  if (![".ts", ".mts", ".cts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].includes(extension))
    return false;
  try {
    const tree = (source: string) => {
      if (extension === ".json") {
        JSON.parse(source);
        return parseExpression(source, { tokens: true });
      }
      return parse(source, { sourceType: "unambiguous", plugins, tokens: true });
    };
    const normalize = (key: string, value: unknown): unknown => {
      if (["start", "end", "loc", "range", "parenStart", "trailingComma", "tokens"].includes(key)) {
        return undefined;
      }
      if (key === "extra" && value && typeof value === "object") {
        const extra = Object.fromEntries(
          Object.entries(value).filter(
            ([name]) => name !== "parenStart" && name !== "trailingComma",
          ),
        );
        return Object.keys(extra).length ? extra : undefined;
      }
      return value;
    };
    const left = tree(before);
    const right = tree(after);
    if (JSON.stringify(left, normalize) !== JSON.stringify(right, normalize)) return false;
    // 構文木だけではセミコロンなどの付け外しを識別できないので、トークンも比較する。
    const tokens = (source: string, parsed: typeof left) => {
      const list = parsed.tokens ?? [];
      let following = "";
      const result: string[] = [];
      for (let index = list.length - 1; index >= 0; index--) {
        const token = list[index];
        if (!token) continue;
        const raw = source.slice(token.start, token.end);
        if (raw !== "" && !(raw === "," && [")", "]", "}"].includes(following))) result.push(raw);
        if (!raw.startsWith("//") && !raw.startsWith("/*")) following = raw;
      }
      return result.reverse();
    };
    return JSON.stringify(tokens(before, left)) === JSON.stringify(tokens(after, right));
  } catch {
    return false;
  }
}
