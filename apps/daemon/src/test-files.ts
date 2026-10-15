import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

/** テストのファイルを探すとき、見るファイル・ディレクトリの数の上限（大きなリポジトリで時間をかけないため）。 */
export const TEST_FILE_SCAN_LIMIT = 20_000;

/** テストのファイルを置くディレクトリの名前（大文字・小文字は問わない）。 */
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

/**
 * テストのファイルの名付けの慣習に当たるか（拡張子を除いた名前で見る。PBI-94）。言語やツールに依らない慣習だけを見る。
 * - `test`・`tests`（`test.sh` など）、`test_*`・`test-*`、`*_test`・`*-test`・`*.test`・`*_tests`・`*.spec`・`*_spec` など
 * - キャメルケースの `*Test`・`*Tests`（`FooTest.java`）と `Test*`（`TestFoo.cs`）
 * `latest`・`contest`・`attest`・`inspect` のように、単語の一部に含むだけのものは当たらない。
 */
export function looksLikeTestFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (/^(test|tests)$/i.test(stem)) return true;
  if (/^tests?[_.-]/i.test(stem)) return true;
  if (/[_.-](test|tests|spec|specs)$/i.test(stem)) return true;
  // キャメルケース（大文字で始まる Test の前後が、語の切れ目になっているもの）
  if (/[a-z0-9]Tests?$/.test(stem)) return true;
  if (/^Tests?[A-Z0-9_]/.test(stem)) return true;
  return false;
}

/**
 * 作業領域（対象リポジトリの起点のコード）から、テストのファイルらしいものを探す（PBI-94）。オーケストレーターが
 * 「テストの仕組みが無い」と答えたときに、黙ってテストなしで進めないための歯止め。`.git` は見ない。
 * 見つけたもの（最大 max 件、作業領域からの相対パス）と、すべてを見たか（complete。上限に達した・作業領域を読めないと false）を返す。
 */
export function findTestFiles(
  dir: string,
  options: { max?: number; limit?: number } = {},
): { files: string[]; complete: boolean } {
  const max = options.max ?? 5;
  const limit = options.limit ?? TEST_FILE_SCAN_LIMIT;
  const files: string[] = [];
  let seen = 0;
  // 浅いところから順に見る（見つけたファイルを、人が見てわかりやすい順にする）
  const queue: { abs: string; rel: string; inTestDir: boolean }[] = [
    { abs: dir, rel: "", inTestDir: false },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(current.abs, { withFileTypes: true });
    } catch {
      // 作業領域そのものを読めなければ、確かめられなかったとする（中のディレクトリは読めなくても続ける）
      if (current.rel === "") return { files, complete: false };
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      seen += 1;
      if (seen > limit) return { files, complete: false };
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        queue.push({
          abs: join(current.abs, entry.name),
          rel,
          inTestDir: current.inTestDir || TEST_DIRS.has(entry.name.toLowerCase()),
        });
        continue;
      }
      // シンボリックリンクはたどらない（名前だけ見る）
      if (current.inTestDir || looksLikeTestFile(entry.name)) {
        files.push(rel);
        if (files.length >= max) return { files, complete: true };
      }
    }
  }
  return { files, complete: true };
}
