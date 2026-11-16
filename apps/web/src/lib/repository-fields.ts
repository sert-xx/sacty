/** 作成フォームのリポジトリ欄を増減する。 */
export function addRepositoryField(fields: number[]): number[] {
  return fields.length >= 10 ? fields : [...fields, Math.max(...fields) + 1];
}

export function removeRepositoryField(fields: number[], field: number): number[] {
  return fields.length <= 1 ? fields : fields.filter((value) => value !== field);
}
