import { repoKey } from "@sacty/core";

/** 作成フォームのリポジトリ欄の上限（デーモンが受け付ける指定の件数と同じ）。 */
export const REPOSITORY_FIELDS_MAX = 10;

/** 作成フォームのリポジトリ欄を増減する。 */
export function addRepositoryField(fields: number[]): number[] {
  return fields.length >= REPOSITORY_FIELDS_MAX ? fields : [...fields, Math.max(...fields) + 1];
}

export function removeRepositoryField(fields: number[], field: number): number[] {
  return fields.length <= 1 ? fields : fields.filter((value) => value !== field);
}

/**
 * 欄を削除した後にフォーカスを移す欄（PBI-360）。消した位置に上がってきた欄、無ければ（最後の欄を消した）前の欄。
 * 削除できない（欄が1つ・無い欄）ときは undefined。
 */
export function focusAfterRemove(fields: number[], field: number): number | undefined {
  const index = fields.indexOf(field);
  const next = removeRepositoryField(fields, field);
  if (index < 0 || next.length === fields.length) return undefined;
  return next[index] ?? next[index - 1];
}

/**
 * 前の欄と同じリポジトリを入れた欄の番号（1 始まり。PBI-360）。空欄は数えない。比べ方はデーモンと同じ
 * （書き方の揺れをそろえ、大文字・小文字を区別しない）。デーモンは重複を除いて数えるので、画面は送る前に知らせる。
 */
export function duplicateRepositoryFields(values: readonly string[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = repoKey(trimmed);
    if (seen.has(key)) duplicates.push(index + 1);
    else seen.add(key);
  });
  return duplicates;
}
