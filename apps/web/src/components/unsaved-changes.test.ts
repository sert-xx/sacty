// @vitest-environment jsdom
import type { Project } from "@sacty/core";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveProjectState, SaveSettingsState } from "@/app/actions";
import { messagesFor } from "@/i18n";

// 保存の結果は、テストから返すものにする
let settingsResults: SaveSettingsState[] = [];
let projectResults: SaveProjectState[] = [];
vi.mock("@/app/actions", () => ({
  saveSettingsAction: async () => settingsResults.shift() ?? {},
  testNotificationAction: async () => ({}),
  saveProjectAction: async () => projectResults.shift() ?? {},
  previewContextAction: async () => ({}),
  reloadGitHubAccountsAction: async () => ({ accounts: [] }),
}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));
// 移動は記録するだけにする。onNavigate が止めたら、移動しない（Next の Link と同じ）
const moved: string[] = [];
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onNavigate,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onNavigate?: (e: { preventDefault: () => void }) => void;
  }) =>
    h(
      "a",
      {
        href,
        ...rest,
        onClick: (e: { preventDefault: () => void }) => {
          e.preventDefault();
          let stopped = false;
          onNavigate?.({ preventDefault: () => (stopped = true) });
          if (!stopped) moved.push(href);
        },
      },
      children,
    ),
}));

const { SettingsForm } = await import("./settings-form");
const { ProjectEditor } = await import("./project-editor");
const { RailNav } = await import("./shell/rail");
const { GuardedLink } = await import("./shell/guarded-link");
const { HeaderFallback } = await import("./shell/header");
const { UnsavedChangesProvider } = await import("@/lib/unsaved-changes");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;

const unsaved = messagesFor("ja").shell.unsaved;
const saveLabel = messagesFor("ja").settings.save;

let container: HTMLDivElement;
let root: Root;
let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  moved.length = 0;
  settingsResults = [];
  projectResults = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const project = {
  id: "p1",
  name: "決済",
  targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
  githubAccounts: { "github.com": "me" },
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:01.000Z",
} as unknown as Project;

const github = { accounts: [{ host: "github.com", login: "me", active: true, state: "success" }] };

/** 2 つの設定の画面。どちらも、変える欄と、保存の結果を渡す。 */
const screens = {
  "sacty の設定": {
    field: 'input[name="intakeLabel"]',
    render: () =>
      h(SettingsForm, {
        intakeLabel: "sacty",
        reviewLabel: "sacty-review",
        reviewRequested: false,
      }),
    results: (r: SaveSettingsState[]) => {
      settingsResults = r;
    },
    saved: [{ saved: true }] as SaveSettingsState[],
    failed: [{ message: "保存できませんでした。" }] as SaveSettingsState[],
  },
  プロジェクトの設定: {
    field: 'input[id$="-name"]',
    render: () => h(ProjectEditor, { project, github }),
    results: (r: SaveProjectState[]) => {
      projectResults = r;
    },
    saved: [{ saved: true, updatedAt: "2026-10-30T00:00:02.000Z" }] as SaveProjectState[],
    failed: [{ message: "保存できませんでした。" }] as SaveProjectState[],
  },
} as const;

const mount = (screen: ReactNode) =>
  act(() =>
    root.render(
      h(
        UnsavedChangesProvider,
        null,
        h(HeaderFallback, { language: "ja" }),
        h(RailNav, { pathname: "/settings" }),
        screen,
      ),
    ),
  );
const edit = (selector: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
};
const submit = () =>
  act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
const bar = () => container.querySelector('[data-testid="save-bar"]') as HTMLElement;
const unsavedNote = () =>
  [...container.querySelectorAll("p")].find((p) => p.textContent === unsaved);
const click = (selector: string) =>
  act(() => (container.querySelector(selector) as HTMLElement).click());
/** 閉じる・リロードのときに出るイベントを起こし、ブラウザの確認を出すことになるか（defaultPrevented）を返す。 */
const beforeUnloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const logo = 'header a[href="/dashboard"]';
const railLink = 'nav a[href="/projects"]';

describe.each(Object.entries(screens))("保存していない変更：%s", (_name, screen) => {
  const open = () => mount(screen.render());
  const original = () => container.querySelector<HTMLInputElement>(screen.field)?.value as string;

  it("変更が無いときは、表示も確認も出ない。リンクはそのまま移る", () => {
    open();
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
    click(railLink);
    click(logo);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(moved).toEqual(["/projects", "/dashboard"]);
  });

  it("欄を変えると、「保存する」と同じ下の帯に「保存していない変更があります」が出る", () => {
    open();
    edit(screen.field, "変えた値");
    expect(unsavedNote()).toBeDefined();
    expect(bar().contains(unsavedNote() as HTMLElement)).toBe(true);
    expect([...bar().querySelectorAll("button")].some((b) => b.textContent === saveLabel)).toBe(
      true,
    );
  });

  it("元の値に戻すと、表示が消え、離れるときの確認も出ない", () => {
    open();
    const before = original();
    edit(screen.field, "変えた値");
    expect(beforeUnloadPrevented()).toBe(true);
    edit(screen.field, before);
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
    click(railLink);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(moved).toEqual(["/projects"]);
  });

  it("変更があるときに、サイドメニュー・ヘッダーのロゴを押すと確かめ、断れば移らず、入力が残る", () => {
    open();
    const input = edit(screen.field, "変えた値");
    for (const link of [railLink, logo]) {
      click(link);
      expect(confirmSpy).toHaveBeenCalled();
      confirmSpy.mockClear();
    }
    expect(moved).toEqual([]);
    expect(input.value).toBe("変えた値");
    expect(unsavedNote()).toBeDefined();
    // 承知したときは移る
    confirmSpy.mockReturnValue(true);
    click(railLink);
    expect(moved).toEqual(["/projects"]);
  });

  it("変更があるときに閉じる・リロードすると、ブラウザの確認が出る", () => {
    open();
    edit(screen.field, "変えた値");
    expect(beforeUnloadPrevented()).toBe(true);
  });

  it("保存に成功すると、表示も確認も消える", async () => {
    screen.results(screen.saved as never);
    open();
    edit(screen.field, "変えた値");
    await submit();
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
    click(railLink);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(moved).toEqual(["/projects"]);
    // 保存した値からまた変えれば、変更ありに戻る
    edit(screen.field, "さらに変えた値");
    expect(unsavedNote()).toBeDefined();
  });

  it("保存に失敗すると、入力と表示が残り、確認も出たままになる", async () => {
    screen.results(screen.failed as never);
    open();
    const input = edit(screen.field, "変えた値");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("保存できませんでした。");
    expect(input.value).toBe("変えた値");
    expect(unsavedNote()).toBeDefined();
    expect(beforeUnloadPrevented()).toBe(true);
  });

  it("画面を外すと、確認も外れる", () => {
    open();
    edit(screen.field, "変えた値");
    act(() => root.render(h(UnsavedChangesProvider, null, h("p", null, "別の画面"))));
    expect(beforeUnloadPrevented()).toBe(false);
  });
});

describe("プロジェクトの設定の、併合・照合の失敗", () => {
  it("併合して保存したときも、変更なしの扱いになる", async () => {
    projectResults = [{ saved: true, merged: true }];
    mount(h(ProjectEditor, { project, github }));
    edit('input[id$="-name"]', "決済（編集）");
    await submit();
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("照合に失敗したときは、入力と表示が残り、確認も出たままになる", async () => {
    projectResults = [{ message: "変わりました。", conflict: true }];
    mount(h(ProjectEditor, { project, github }));
    const input = edit('input[id$="-name"]', "決済（編集）");
    await submit();
    expect(input.value).toBe("決済（編集）");
    expect(unsavedNote()).toBeDefined();
    expect(beforeUnloadPrevented()).toBe(true);
  });
});

describe("対象にしないもの", () => {
  it("押した時点で効くデスクトップ通知の On・Off だけを切り替えても、表示も確認も出ない", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "granted" }));
    mount(h(SettingsForm, { intakeLabel: "sacty", reviewLabel: "", reviewRequested: false }));
    const toggle = container.querySelector<HTMLInputElement>(
      '[data-testid="desktop-notification-on"]',
    ) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    act(() => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("プロジェクトの作成のフォームは、名前を入力しても、表示も確認も出ない", () => {
    mount(h(ProjectEditor, { github }));
    edit('input[id$="-name"]', "新しいプロジェクト");
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
    click(railLink);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe("Slack の通知の欄だけを変えたとき（親が描き直されない欄）", () => {
  const pick = (value: string) => {
    const select = container.querySelector("section select") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    act(() => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const open = () =>
    mount(h(SettingsForm, { intakeLabel: "sacty", reviewLabel: "", reviewRequested: false }));

  it("表示と確認が出る。元に戻すと消える", () => {
    open();
    expect(unsavedNote()).toBeUndefined();
    pick("slack-webhook");
    expect(unsavedNote()).toBeDefined();
    expect(beforeUnloadPrevented()).toBe(true);
    click(railLink);
    expect(confirmSpy).toHaveBeenCalled();
    expect(moved).toEqual([]);
    pick("");
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("Webhook の URL を入力しても出る", () => {
    open();
    pick("slack-webhook");
    edit('input[id$="-notify-webhook"]', "https://x.test/h");
    expect(
      (container.querySelector('input[name="notification"]') as HTMLInputElement).value,
    ).toContain("https://x.test/h");
    expect(unsavedNote()).toBeDefined();
  });

  it("保存に成功すると消える", async () => {
    settingsResults = [{ saved: true }];
    open();
    pick("slack-webhook");
    await submit();
    expect(unsavedNote()).toBeUndefined();
    expect(beforeUnloadPrevented()).toBe(false);
  });
});

describe("パンくずのリンク（GuardedLink）", () => {
  const crumb = 'nav[aria-label="crumb"] a';
  const open = () =>
    mount(
      h("nav", { "aria-label": "crumb" }, h(GuardedLink, { href: "/projects" }, "プロジェクト")),
    );
  it("変更があるとき、確認を断ると移らない", () => {
    mount(
      h(
        "div",
        null,
        h("nav", { "aria-label": "crumb" }, h(GuardedLink, { href: "/projects" }, "プロジェクト")),
        h(SettingsForm, { intakeLabel: "sacty", reviewLabel: "", reviewRequested: false }),
      ),
    );
    edit('input[name="intakeLabel"]', "変えた値");
    click(crumb);
    expect(confirmSpy).toHaveBeenCalled();
    expect(moved).toEqual([]);
  });
  it("変更が無いとき、確認せずに移る", () => {
    open();
    click(crumb);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(moved).toEqual(["/projects"]);
  });
});
