/**
 * 観点とテストの対応に出すテスト名の整え方（PBI-302 C3）。工程のエージェントは、テストの名前を「ファイル › describe › テスト名」の
 * 形で申告する。同じテストを、describe の接頭辞を付けた名前と付けない名前で2回書くことがあり、パラメータ化したテストの名前には
 * `%j` などの書式の文字が残る。人が読む場所（PR の本文・画面）では、同じテストを1回にし、書式の文字は値が入る印に置き換える。
 */

/** テスト名の区切り（jest の `›`。vitest の ` > ` も区切りとして読む）。 */
const SEPARATOR = /\s*(?:›|\s>\s)\s*/;

/** テスト名の書式の文字（`%s` `%d` `%i` `%f` `%j` `%o` `%O` `%p` `%#` `%$`）。`%%` は `%` の文字。 */
const FORMAT_PLACEHOLDER = /(?<![0-9%])%[sdifjoOp#$]/g;

/** 書式の文字を置き換える印。実際の値は、実行ごとに違う（名前だけからは展開できない）。 */
export const TEST_NAME_VALUE_MARK = "‹…›";

/**
 * パラメータ化したテストの名前の書式の文字（`%j` `%s` など）を、値が入る印に置き換える。値は名前だけからは分からないので、
 * 展開はしない。印にすることで、書式の文字がそのまま読み手に出ない。
 */
export function withoutFormatPlaceholders(name: string): string {
  return name.replace(FORMAT_PLACEHOLDER, TEST_NAME_VALUE_MARK).replace(/%%/g, "%");
}

type Parts = { file: string; middle: string[]; title: string; whole: string };

function partsOf(name: string): Parts {
  const whole = name.trim().replace(/\s+/g, " ");
  const segments = whole.split(SEPARATOR).filter(Boolean);
  if (segments.length < 2) return { file: "", middle: [], title: whole, whole };
  return {
    file: segments[0] ?? "",
    middle: segments.slice(1, -1),
    title: segments.at(-1) ?? "",
    whole,
  };
}

/** a の describe の並びが、b の末尾と一致する（空も含む。b より短い）。a の名前は b の名前の接頭辞を省いたもの。 */
function isShorterTail(a: readonly string[], b: readonly string[]): boolean {
  return a.length < b.length && a.every((segment, i) => segment === b[b.length - a.length + i]);
}

/**
 * テスト名の一覧から、同じテストの重複を除く。同じファイル・同じテスト名で、describe の並びが他方の末尾にあたる名前
 * （接頭辞を省いた名前）は、長い名前に統合する。ファイル・テスト名が同じでも、describe が別のものは別のテストとして残す。
 * 順序は、最初に出てきた位置を保つ。
 */
export function dedupeTestNames(names: readonly string[]): string[] {
  const parts = names.map(partsOf);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, p] of parts.entries()) {
    if (p.whole === "" || seen.has(p.whole)) continue;
    seen.add(p.whole);
    const subsumed = parts.some(
      (q) =>
        q !== p &&
        q.file === p.file &&
        q.title === p.title &&
        (p.file !== "" || p.middle.length > 0) &&
        isShorterTail(p.middle, q.middle),
    );
    if (!subsumed) result.push(names[index]?.trim() ?? p.whole);
  }
  return result;
}

/** 人が読む場所に出すテスト名の一覧。同じテストを1回にして、書式の文字を印に置き換える。 */
export function displayTestNames(names: readonly string[]): string[] {
  return dedupeTestNames(names.map(withoutFormatPlaceholders));
}
