/**
 * 観点とテストの対応に出すテスト名の整え方（PBI-302 C3）。工程のエージェントは、テストの名前を「ファイル › describe › テスト名」の
 * 形で申告する。同じテストを、describe の接頭辞を付けた名前と付けない名前で2回書くことがあり、パラメータ化したテストの名前には
 * `%j` などの書式の文字が残る。人が読む場所（PR の本文・画面）では、同じテストを1回にし、書式の文字は値が入る印に置き換える。
 */

/**
 * テスト名を区切りで分ける（jest の `›`。vitest の ` > ` も区切りとして読む）。空白はそろえてから、文字列で分ける（正規表現の
 * 量指定子を重ねると、空白の長い並びで遅くなるため。PR #304 の CodeQL）。
 */
function splitSegments(whole: string): string[] {
  return whole
    .split("›")
    .flatMap((part) => part.split(" > "))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

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

type Parts = { file: string; middle: string[]; title: string; whole: string; key: string };

function partsOf(name: string): Parts {
  const whole = name.trim().replace(/\s+/g, " ");
  const segments = splitSegments(whole);
  if (segments.length < 2) return { file: "", middle: [], title: whole, whole, key: whole };
  const file = segments[0] ?? "";
  const middle = segments.slice(1, -1);
  const title = segments.at(-1) ?? "";
  // 区切りの書き方（`›` と ` > `）や空白の違いでは別のテストにしない、判定のためのキー（PR #304 のレビュー）
  return { file, middle, title, whole, key: [file, ...middle, title].join("\u0000") };
}

/** a の describe の並びが、b の末尾と一致する（空も含む。b より短い）。a の名前は b の名前の接頭辞を省いたもの。 */
function isShorterTail(a: readonly string[], b: readonly string[]): boolean {
  return a.length < b.length && a.every((segment, i) => segment === b[b.length - a.length + i]);
}

/** q が p を含む（同じファイル・同じテスト名で、p の describe の並びが q の末尾にあたる）。 */
function subsumes(q: Parts, p: Parts): boolean {
  return (
    q.key !== p.key &&
    q.file === p.file &&
    q.title === p.title &&
    (p.file !== "" || p.middle.length > 0) &&
    isShorterTail(p.middle, q.middle)
  );
}

/**
 * テスト名の一覧から、同じテストの重複を除く。区切りの書き方・空白だけが違う名前は同じテストとし、最初の表記を残す。
 * 同じファイル・同じテスト名で、describe の並びが他方の末尾にあたる名前（接頭辞を省いた名前）は、長い名前に統合する。
 * 統合した名前は、そのテストが最初に出てきた位置（短い名前・長い名前のどちらか早いほう）に置く（PR #304 のレビュー）。
 * ファイル・テスト名が同じでも、describe が別のものは別のテストとして残す。
 */
export function dedupeTestNames(names: readonly string[]): string[] {
  const parts = names.map(partsOf);
  // キーごとの最初の表記
  const firstShown = new Map<string, string>();
  for (const [index, p] of parts.entries()) {
    if (p.whole !== "" && !firstShown.has(p.key)) {
      firstShown.set(p.key, names[index]?.trim() ?? p.whole);
    }
  }
  // 含むもののうち、ほかに含まれない（いちばん長い）もの。出てきた順で最初のもの
  const widest = (p: Parts): Parts | undefined =>
    parts.find((q) => subsumes(q, p) && !parts.some((r) => subsumes(r, q)));
  const done = new Set<string>();
  const result: string[] = [];
  for (const p of parts) {
    if (p.whole === "" || done.has(p.key)) continue;
    const target = widest(p) ?? p;
    done.add(p.key);
    if (done.has(target.key) && target !== p) continue;
    done.add(target.key);
    result.push(firstShown.get(target.key) ?? target.whole);
  }
  return result;
}

/** 人が読む場所に出すテスト名の一覧。同じテストを1回にして、書式の文字を印に置き換える。 */
export function displayTestNames(names: readonly string[]): string[] {
  return dedupeTestNames(names.map(withoutFormatPlaceholders));
}
