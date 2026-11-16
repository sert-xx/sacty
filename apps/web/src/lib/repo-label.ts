import { parseRepoUrl } from "@sacty/core";

/** 指定したリポジトリの、画面に出す短い名前と URL の全体。href は、リポジトリの URL として読めたときだけ。 */
export type RepoLabel = { url: string; label: string; href?: string };

/** リポジトリの名前（URL として読めなければ、そのまま）。一覧の絞り込みと、作業するリポジトリの名前に合わせる。 */
export function repoShortName(url: string): string {
  return parseRepoUrl(url)?.name ?? url;
}

/**
 * 複数を指定したリポジトリを、単数と同じ短い名前にする（PBI-360）。shortest が name なら リポジトリ名（一覧）、
 * path なら owner/name（詳細）。その中で同じ名前が2つ以上あれば、区別できる長さ（owner/name、それでも同じなら URL の全体）にする。
 */
export function repoLabels(
  urls: readonly string[],
  shortest: "name" | "path" = "name",
): RepoLabel[] {
  const parsed = urls.map((url) => ({ url, repo: parseRepoUrl(url) }));
  const count = (values: (string | undefined)[]) => {
    const counts = new Map<string, number>();
    for (const value of values) {
      if (value !== undefined)
        counts.set(value.toLowerCase(), (counts.get(value.toLowerCase()) ?? 0) + 1);
    }
    return (value: string) => (counts.get(value.toLowerCase()) ?? 0) > 1;
  };
  const sameName = count(parsed.map((p) => p.repo?.name));
  const samePath = count(parsed.map((p) => p.repo?.path));
  return parsed.map(({ url, repo }) => {
    if (!repo) return { url, label: url };
    const label =
      shortest === "name" && !sameName(repo.name)
        ? repo.name
        : samePath(repo.path)
          ? repo.url
          : repo.path;
    return { url, label, href: repo.url };
  });
}
