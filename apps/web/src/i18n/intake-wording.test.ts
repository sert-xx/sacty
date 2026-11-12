import { describe, expect, it } from "vitest";
import { messagesFor } from "./index";

describe("取り込みの文言（PBI-99）", () => {
  it("プロジェクトの対象の案内は、Issue は取り込むラベル、PR はレビュー用のラベルかレビューの依頼で取り込むと書く", () => {
    const ja = messagesFor("ja").projects.editor.targetsHint;
    expect(ja).toContain("Issue は、取り込むラベル");
    expect(ja).toContain("PR は、レビュー用のラベル");
    expect(ja).toContain("レビューを依頼されて");
    expect(ja).not.toContain("Issue・PR");
    const en = messagesFor("en").projects.editor.targetsHint;
    expect(en).toContain("issues with the intake label");
    expect(en).toContain("PRs with the review label");
    expect(en).toContain("request your review");
    expect(en).not.toContain("issues and PRs");
  });

  it("作業履歴の PR のラベルは、レビュー用のラベルと書く", () => {
    for (const [locale, word, old] of [
      ["ja", "レビュー用のラベル", "取り込むラベル"],
      ["en", "review label", "intake label"],
    ] as const) {
      const labels = messagesFor(locale).labels.event;
      for (const text of [
        labels.PullRequestLabeled(7, "sacty-review", false),
        labels.PullRequestLabelFailed(7, "sacty-review", "403"),
      ]) {
        expect(text, locale).toContain(word);
        expect(text, locale).not.toContain(old);
      }
    }
  });

  it("sacty の PR にはラベルを付けず、子タスクがレビューすると書く（PBI-330）", () => {
    expect(messagesFor("ja").settings.reviewLabelHint).toContain(
      "Sacty が作る PR にはラベルを付けず、PR を作ったタスクの子タスクがレビューします",
    );
    expect(messagesFor("ja").settings.reviewLabelHint).not.toContain(
      "取り込みが Off の間も付けます",
    );
    expect(messagesFor("en").settings.reviewLabelHint).toContain(
      "Sacty does not add this label to the PRs it creates",
    );
  });
});
