import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { remarkReplyAccountsOn } from "./service.js";

describe("指摘への返信に使ったアカウント（PBI-352）", () => {
  it("PR に返信したタスクが記録したアカウントを集める：PR を作った・引き継いだタスクと、レビューの子タスクの親", () => {
    const task = (patch: Partial<Task>) => ({ id: "t", ...patch }) as Task;
    const pull = { repo: "https://github.com/acme/app", number: 7 } as Task["pullRequest"];
    const tasks = [
      task({ id: "author", pullRequest: pull, remarkReplyAccounts: ["old-bot", "me"] }),
      task({
        id: "continued",
        continuedPullRequest: {
          repo: "https://github.com/acme/app",
          number: 7,
          url: "",
          branch: "b",
          baseBranch: "main",
        },
        remarkReplyAccounts: ["me", "helper"],
      }),
      task({ id: "parent", remarkReplyAccounts: ["step-bot"] }),
      task({
        id: "other-pr",
        pullRequest: { ...pull, number: 8 } as Task["pullRequest"],
        remarkReplyAccounts: ["elsewhere"],
      }),
      task({ id: "no-replies", pullRequest: pull }),
      // 要求要件・設計の PR に返信したタスク
      task({
        id: "design-author",
        stepPullRequests: [
          { repo: "https://github.com/acme/app", number: 7 },
        ] as Task["stepPullRequests"],
        remarkReplyAccounts: ["design-bot"],
      }),
    ];
    expect(remarkReplyAccountsOn(tasks, "parent", "https://github.com/acme/app", 7)).toEqual([
      "old-bot",
      "me",
      "helper",
      "step-bot",
      "design-bot",
    ]);
    expect(remarkReplyAccountsOn(tasks, undefined, "https://github.com/acme/app", 9)).toEqual([]);
  });
});
