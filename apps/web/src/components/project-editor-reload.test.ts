// @vitest-environment jsdom
import type { Project } from "@sacty/core";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { GitHubAccounts } from "@/lib/daemon";

// 読み直しの結果は、テストから返すまで待たせる
let resolveReload: (value: GitHubAccounts) => void = () => {};
const reloadGitHubAccountsAction = vi.fn(
  () =>
    new Promise<GitHubAccounts>((resolve) => {
      resolveReload = resolve;
    }),
);
vi.mock("@/app/actions", () => ({
  saveProjectAction: async () => ({}),
  previewContextAction: async () => ({}),
  reloadGitHubAccountsAction: () => reloadGitHubAccountsAction(),
}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));

const { ProjectEditor } = await import("./project-editor");
const t = messagesFor("ja").projects.editor;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  reloadGitHubAccountsAction.mockClear();
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
  createdAt: "",
  updatedAt: "",
} as unknown as Project;

const reloadButton = () =>
  [...container.querySelectorAll("button")].find((b) =>
    [t.githubReload, t.githubReloading].includes(b.textContent ?? ""),
  ) as HTMLButtonElement;
const nameInput = () => container.querySelector<HTMLInputElement>('input[id$="-name"]');
const accountOptions = () =>
  [...container.querySelectorAll<HTMLOptionElement>('select[id$="-github-github.com"] option')].map(
    (o) => o.textContent,
  );

/** React が入力として受け取るように、値を書き換えて input を送る。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("gh のアカウントを画面から読み直す", () => {
  it("読み直すあいだはボタンを止め、結果で選択肢と一覧を置き換え、編集中の入力は残す", async () => {
    act(() =>
      root.render(
        h(ProjectEditor, {
          project,
          github: {
            accounts: [{ host: "github.com", login: "me", active: true, state: "success" }],
          },
        }),
      ),
    );
    expect(accountOptions()).toEqual(["me"]);
    act(() => typeInto(nameInput() as HTMLInputElement, "決済（編集中）"));

    act(() => reloadButton().click());
    expect(reloadGitHubAccountsAction).toHaveBeenCalledTimes(1);
    expect(reloadButton().disabled).toBe(true);
    expect(reloadButton().textContent).toBe(t.githubReloading);

    await act(async () =>
      resolveReload({
        accounts: [
          { host: "github.com", login: "me", active: true, state: "success" },
          { host: "github.com", login: "other", active: false, state: "success" },
        ],
      }),
    );
    expect(reloadButton().disabled).toBe(false);
    expect(reloadButton().textContent).toBe(t.githubReload);
    expect(accountOptions()).toEqual(["me", "other"]);
    expect(container.textContent).toContain(t.githubKnownTitle(2));
    expect(nameInput()?.value).toBe("決済（編集中）");
  });

  it("読み直せなければ理由を出し、もう一度押せる", async () => {
    act(() =>
      root.render(
        h(ProjectEditor, {
          project,
          github: {
            accounts: [{ host: "github.com", login: "me", active: true, state: "success" }],
          },
        }),
      ),
    );
    act(() => reloadButton().click());
    await act(async () => resolveReload({ error: t.githubReloadTimeout }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(t.githubReloadTimeout);
    expect(reloadButton().disabled).toBe(false);

    act(() => reloadButton().click());
    expect(reloadGitHubAccountsAction).toHaveBeenCalledTimes(2);
    await act(async () =>
      resolveReload({
        accounts: [{ host: "github.com", login: "me", active: true, state: "success" }],
      }),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(accountOptions()).toEqual(["me"]);
  });
});
