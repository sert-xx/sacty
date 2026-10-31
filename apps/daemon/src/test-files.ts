import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DaemonText, message } from "@sacty/core";

/** テストのファイルを探すとき、見るファイル・ディレクトリの数の上限（大きなリポジトリで時間をかけないため）。 */
export const TEST_FILE_SCAN_LIMIT = 20_000;

/**
 * 文書のファイルの拡張子（大文字・小文字は問わない）。テストのディレクトリの中の説明（tests/README.md など）やテストについての文書は、
 * テストのコードではないので当てない（PR #105 レビュー指摘）。
 */
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "txt", "rst", "adoc", "asciidoc", "org"]);

/** 文書のファイルか（拡張子で見る）。 */
function isDocument(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * タスクの差分（起点からの変更のパス。名前の変更は変更元と変更先に分けたもの）が、文書のファイルだけか（PBI-158）。
 * 実行される振る舞いの無い変更なら、テストのコマンドのツールがイメージに無くても、検証を人の確認へ回して止めずに進める判断に使う。
 * 拡張子は上の文書の一覧のとおり（`md`・`markdown`・`txt`・`rst`・`adoc`・`asciidoc`・`org`）。コードなど文書でないファイルが
 * 1つでもあれば、文書と混ざっていても false。差分が空のときも false（確かめられないものは文書だけとは見なさない）。
 */
export function isDocumentsOnly(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      return isDocument(name);
    })
  );
}

/** テストのファイルを探しきれなかった理由（PR #105 再レビュー指摘）。 */
export type TestFileScanIncomplete =
  | { reason: "limit"; limit: number }
  | { reason: "unreadable"; path: string; detail: string };

/** テストのファイルを置くディレクトリの名前（大文字・小文字は問わない）。 */
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

/**
 * テストのファイルの名付けの慣習に当たるか（拡張子を除いた名前で見る。PBI-94）。言語やツールに依らない慣習だけを見る。
 * - `test`・`tests`（`test.sh` など）、`test_*`・`test-*`、`*_test`・`*-test`・`*.test`・`*_tests`・`*.spec`・`*_spec` など
 * - キャメルケースの `*Test`・`*Tests`（`FooTest.java`）と `Test*`（`TestFoo.cs`）
 * `latest`・`contest`・`attest`・`inspect` のように、単語の一部に含むだけのものは当たらない。
 */
export function looksLikeTestFile(name: string): boolean {
  if (isDocument(name)) return false;
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
 * 見つけたもの（最大 max 件、作業領域からの相対パス）と、すべてを見たか（complete。上限に達した・読めないディレクトリが
 * あると false。見つけたものがあれば、その時点で返す）を返す。見終わらなかったときは、その理由（incomplete）も返す
 * （上限に達した・読めないディレクトリの作業領域からの相対パスと、エラーのコード。PR #105 再レビュー指摘）。
 */
export function findTestFiles(
  dir: string,
  options: {
    max?: number;
    limit?: number;
    /** ディレクトリの中を列挙する（テストで失敗を作るために差し替える）。既定は readdirSync。 */
    readDir?: (path: string) => Dirent[];
  } = {},
): { files: string[]; complete: boolean; incomplete?: TestFileScanIncomplete } {
  const max = options.max ?? 5;
  const limit = options.limit ?? TEST_FILE_SCAN_LIMIT;
  const readDir = options.readDir ?? ((path: string) => readdirSync(path, { withFileTypes: true }));
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
      entries = readDir(current.abs);
    } catch (error) {
      // 読めないディレクトリがあれば、その中にテストがあるかもしれないので、確かめられなかったとする（PR #105 レビュー指摘）。
      // 利用者が原因を直せるよう、どこが・なぜ読めなかったかを返す
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return {
        files,
        complete: false,
        incomplete: {
          reason: "unreadable",
          path: current.rel || ".",
          detail: code ?? (error instanceof Error ? error.message : String(error)),
        },
      };
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      seen += 1;
      if (seen > limit) return { files, complete: false, incomplete: { reason: "limit", limit } };
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
      if ((current.inTestDir && !isDocument(entry.name)) || looksLikeTestFile(entry.name)) {
        files.push(rel);
        if (files.length >= max) return { files, complete: true };
      }
    }
  }
  return { files, complete: true };
}

/**
 * テストのファイル探しの結果から、テストの仕組みが無いという判断（reason）で進めずに止める理由を作る（PBI-94）。進めてよければ
 * undefined。テストのファイルが見つかった・上限に達した・読めないディレクトリがあった、で文言を分ける（利用者が直し方を
 * 選べるように。PR #105 再レビュー指摘）。
 */
export function noTestsStop(
  reason: string,
  found: ReturnType<typeof findTestFiles>,
): DaemonText | undefined {
  if (found.files.length > 0) {
    return message("orchestrator.noTestsContradicted", { reason, files: found.files.join(", ") });
  }
  if (found.complete) return undefined;
  const incomplete = found.incomplete;
  return incomplete?.reason === "unreadable"
    ? message("orchestrator.noTestsUnreadable", {
        reason,
        path: incomplete.path,
        detail: incomplete.detail,
      })
    : message("orchestrator.noTestsUncertain", { reason });
}
