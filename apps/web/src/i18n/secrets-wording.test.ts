import { describe, expect, it } from "vitest";
import { messagesFor } from "./index";

describe("秘密情報の取り出し直しの結果の文言（PBI-107）", () => {
  it("読めなかったコンテキストがあれば、使う秘密情報が無いとは言い切らず、確かめていない対象があると書く", () => {
    const ja = messagesFor("ja").settings.secretsResult;
    expect(ja(0, 0, 1)).not.toContain("使う秘密情報はありません");
    expect(ja(0, 0, 1)).toContain(
      "読めなかったコンテキストが 1 件あり、その中の秘密情報は確かめていません",
    );
    expect(ja(2, 3, 2)).toBe(
      "3 件のうち 2 件を取り出しました。読めなかったコンテキストが 2 件あり、その中の秘密情報は確かめていません（下の警告を見てください）。",
    );
    const en = messagesFor("en").settings.secretsResult;
    expect(en(0, 0, 1)).not.toContain("No secrets are used");
    expect(en(0, 0, 1)).toContain(
      "1 context could not be read, so the secrets in it were not checked",
    );
    expect(en(2, 3, 2)).toContain(
      "2 contexts could not be read, so the secrets in them were not checked",
    );
  });

  it("読めなかったコンテキストが無ければ、今までどおり", () => {
    expect(messagesFor("ja").settings.secretsResult(0, 0)).toBe("使う秘密情報はありません。");
    expect(messagesFor("ja").settings.secretsResult(3, 3, 0)).toBe(
      "3 件のうち 3 件を取り出しました。",
    );
    expect(messagesFor("en").settings.secretsResult(0, 0, 0)).toBe("No secrets are used.");
    expect(messagesFor("en").settings.secretsResult(1, 2)).toBe("Got 1 of 2 secrets.");
  });
});
