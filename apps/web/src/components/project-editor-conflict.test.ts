// @vitest-environment jsdom
import type { Project } from "@sacty/core";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveProjectState } from "@/app/actions";
import { messagesFor } from "@/i18n";

// 保存の結果は、テストから返すものにする。送られた版も記録する
const sent: string[] = [];
let results: SaveProjectState[] = [];
vi.mock("@/app/actions", () => ({
  saveProjectAction: async (_prev: SaveProjectState, data: FormData) => {
    sent.push(String(data.get("baseUpdatedAt")));
    return results.shift() ?? {};
  },
  previewContextAction: async () => ({}),
  reloadGitHubAccountsAction: async () => ({ accounts: [] }),
}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));

const { ProjectEditor } = await import("./project-editor");
const t = messagesFor("ja").projects.editor;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  sent.length = 0;
  results = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const project = {
  id: "p1",
  name: "決済",
  targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
  githubAccounts: { "github.com": "me" },
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:01.000Z",
} as unknown as Project;

const render = (p: Project = project) =>
  act(() =>
    root.render(
      h(ProjectEditor, {
        project: p,
        github: { accounts: [{ host: "github.com", login: "me", active: true, state: "success" }] },
      }),
    ),
  );
const submit = () =>
  act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
const reloadButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === t.reloadLatest);

describe("設定の画面は、読み込んだ版を保存に添える（PBI-274）", () => {
  it("最初は読み込んだ版を送り、自分で保存したら、保存した版に進める", async () => {
    results = [{ saved: true, updatedAt: "2026-10-30T00:00:02.000Z" }, {}];
    render();
    await submit();
    await submit();
    expect(sent).toEqual(["2026-10-30T00:00:01.000Z", "2026-10-30T00:00:02.000Z"]);
  });

  it("画面の取り直しで props が新しくなっても、自分が見ていない版には進めない", async () => {
    results = [{}, {}];
    render();
    render({ ...project, updatedAt: "2026-10-30T00:00:09.000Z" } as Project);
    await submit();
    expect(sent).toEqual(["2026-10-30T00:00:01.000Z"]);
  });

  it("ほかの保存で変わっていたら、理由と再読み込みのボタンを出し、版は進めない。編集中の入力は残す", async () => {
    results = [
      { message: "変わりました。", conflict: true },
      { message: "変わりました。", conflict: true },
    ];
    render();
    const name = container.querySelector<HTMLInputElement>(
      'input[id$="-name"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(name, "決済（編集中）");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(reloadButton()).toBeUndefined();
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("変わりました。");
    expect(reloadButton()).toBeDefined();
    expect(name.value).toBe("決済（編集中）");
    await submit();
    expect(sent).toEqual(["2026-10-30T00:00:01.000Z", "2026-10-30T00:00:01.000Z"]);
  });

  it("ほかの理由で保存できなかったときは、再読み込みのボタンを出さない", async () => {
    results = [{ message: "重複しています。" }];
    render();
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("重複しています。");
    expect(reloadButton()).toBeUndefined();
  });
});
