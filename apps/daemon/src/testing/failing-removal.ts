/**
 * テストで、ファイル・ディレクトリを消すのを失敗させる（決めた場所だけ）。親をファイルにするなどの方法は、Node の版によって
 * rm が例外を出さないことがあるため、node:fs・node:fs/promises の差し替え（vi.mock）で確実に失敗させる。
 * 本体のコードからは使わない（ビルドの対象から外している）。
 *
 * 使うテストファイルでは、vi.mock を自分のファイルに書く（vi.mock は、書いたファイルの読み込みより前に効かせる必要があるため、
 * 共通の場所には置けない）。このファイルは、差し替えの中から読むので、node:fs を読み込まない。
 *
 *     vi.mock("node:fs", async (importOriginal) =>
 *       (await import("./testing/failing-removal.js")).failingFs(await importOriginal()));
 *     vi.mock("node:fs/promises", async (importOriginal) =>
 *       (await import("./testing/failing-removal.js")).failingFsPromises(await importOriginal()));
 */

/** 消すのを失敗させる場所（テストで指定したときだけ。ほかは本物の rmSync・rm に渡す）。 */
export const removal = { fail: undefined as RegExp | undefined };

const removalError = (path: unknown) =>
  Object.assign(new Error(`EACCES: permission denied, rm '${String(path)}'`), { code: "EACCES" });

/** node:fs の、rmSync だけを差し替えたもの。 */
export function failingFs(actual: typeof import("node:fs")): typeof import("node:fs") {
  return {
    ...actual,
    rmSync: (
      path: Parameters<typeof actual.rmSync>[0],
      options?: Parameters<typeof actual.rmSync>[1],
    ) => {
      if (removal.fail?.test(String(path))) throw removalError(path);
      return actual.rmSync(path, options);
    },
  };
}

/** node:fs/promises の、rm だけを差し替えたもの。 */
export function failingFsPromises(
  actual: typeof import("node:fs/promises"),
): typeof import("node:fs/promises") {
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      if (removal.fail?.test(String(path))) throw removalError(path);
      return actual.rm(path, options);
    },
  };
}
