import { describe, expect, it } from "vitest";
import {
  addRepositoryField,
  duplicateRepositoryFields,
  focusAfterRemove,
  REPOSITORY_FIELDS_MAX,
  removeRepositoryField,
} from "./repository-fields";

describe("作成フォームのリポジトリ欄の増減（PBI-360）", () => {
  it("上限までは増やし、上限では増やさない。1欄は消さない", () => {
    let fields = [0];
    for (let i = 0; i < 20; i++) fields = addRepositoryField(fields);
    expect(fields).toHaveLength(REPOSITORY_FIELDS_MAX);
    expect(addRepositoryField(fields)).toBe(fields);
    expect(removeRepositoryField([3], 3)).toEqual([3]);
    // 消した後に増やしても、欄の ID は重ならない
    expect(addRepositoryField(removeRepositoryField([0, 1, 2], 1))).toEqual([0, 2, 3]);
  });

  it("削除の後のフォーカスは、消した位置に上がってきた欄。最後の欄を消したら前の欄", () => {
    expect(focusAfterRemove([0, 1, 2], 0)).toBe(1);
    expect(focusAfterRemove([0, 1, 2], 1)).toBe(2);
    expect(focusAfterRemove([0, 1, 2], 2)).toBe(1);
    expect(focusAfterRemove([4, 7], 7)).toBe(4);
    // 消せないとき（欄が1つ・無い欄）は移さない
    expect(focusAfterRemove([5], 5)).toBeUndefined();
    expect(focusAfterRemove([0, 1], 9)).toBeUndefined();
  });

  it("前の欄と同じリポジトリの欄を、1始まりの番号で返す（空欄は数えず、書き方の揺れはそろえる）", () => {
    expect(duplicateRepositoryFields([])).toEqual([]);
    expect(duplicateRepositoryFields(["", " ", ""])).toEqual([]);
    expect(duplicateRepositoryFields(["https://github.com/acme/a"])).toEqual([]);
    expect(
      duplicateRepositoryFields(["https://github.com/acme/a", "https://github.com/acme/b"]),
    ).toEqual([]);
    expect(
      duplicateRepositoryFields([
        "https://github.com/acme/a",
        "",
        " https://GITHUB.com/Acme/A.git ",
        "https://github.com/acme/b",
        "https://github.com/acme/a/",
      ]),
    ).toEqual([3, 5]);
    // 別のホストの同じ owner/name は、別のリポジトリ
    expect(
      duplicateRepositoryFields(["https://github.com/acme/a", "https://ghe.example.com/acme/a"]),
    ).toEqual([]);
  });
});
