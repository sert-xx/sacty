import { beforeEach, describe, expect, it, vi } from "vitest";

const createTask = vi.fn();
const saveProject = vi.fn();
const importProject = vi.fn();
const approveStep = vi.fn();
const requestChanges = vi.fn();
const saveSettings = vi.fn();
const getGitHubAccounts = vi.fn();
const cookieSet = vi.fn();
const refresh = vi.fn();
const order: string[] = [];
vi.mock("@/lib/daemon", () => ({
  createTask,
  saveProject,
  importProject,
  approveStep,
  requestChanges,
  saveSettings,
  getGitHubAccounts,
  CONTEXT_CHECK_PARAM: "contextCheck",
}));
// 送信時の cookie は、別のタブで切り替えた「B」になっている
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "sacty-project" ? { value: "project-b" } : undefined),
    set: cookieSet,
  }),
  headers: async () => new Headers({ "accept-language": "ja" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    order.push("redirect");
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/cache", () => ({
  refresh: () => {
    order.push("refresh");
    refresh();
  },
  revalidatePath: () => {},
}));

const {
  createTaskAction,
  gateAction,
  importProjectAction,
  reloadGitHubAccountsAction,
  saveProjectAction,
  saveSettingsAction,
  selectProjectAction,
} = await import("./actions");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
};

describe("タスクの作成先（PBI-4a レビュー指摘）", () => {
  beforeEach(() => createTask.mockReset());

  it("作成先は、フォームを表示したときのプロジェクトで、送信時の cookie ではない", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t1" } });
    await expect(
      createTaskAction({}, form({ title: "決済", body: "", projectId: "project-a" })),
    ).rejects.toThrow("redirect:/tasks/t1");
    // 対象リポジトリを空欄にしたら、リポジトリを指定しない（PBI-73）
    expect(createTask).toHaveBeenCalledWith({
      title: "決済",
      body: "",
      repo: null,
      projectId: "project-a",
    });
  });

  it("作成先が無い・見つからなければ、理由を返して作らない", async () => {
    expect(await createTaskAction({}, form({ title: "決済" }))).toMatchObject({
      message: expect.stringMatching(/作成先のプロジェクトが分かりません/),
    });
    expect(createTask).not.toHaveBeenCalled();

    createTask.mockResolvedValue({ ok: false, message: "プロジェクトが見つかりません。" });
    expect(await createTaskAction({}, form({ title: "決済", projectId: "deleted" }))).toMatchObject(
      { message: "プロジェクトが見つかりません。" },
    );
  });
});

describe("タスクの対象リポジトリ（PBI-21）", () => {
  beforeEach(() => createTask.mockReset());

  it("選んだ対象リポジトリを渡し、作れなければ入力を残して理由を返す", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t1" } });
    await expect(
      createTaskAction(
        {},
        form({ title: "決済", body: "", projectId: "project-a", repo: "acme/api" }),
      ),
    ).rejects.toThrow("redirect:/tasks/t1");
    expect(createTask).toHaveBeenCalledWith({
      title: "決済",
      body: "",
      projectId: "project-a",
      repo: "acme/api",
    });

    createTask.mockResolvedValue({
      ok: false,
      message: "対象リポジトリを、プロジェクト「決済」のリポジトリの設定から選んでください。",
    });
    expect(
      await createTaskAction({}, form({ title: "決済", projectId: "project-a", repo: "acme/x" })),
    ).toMatchObject({
      message: expect.stringMatching(/対象リポジトリを/),
      values: { title: "決済", repo: "acme/x" },
    });
  });
});

describe("タスクの進め方", () => {
  beforeEach(() => createTask.mockReset());

  it("選んだ進め方を渡し、自動（空）なら渡さない。作れなければ選んだまま理由を返す", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t1" } });
    await expect(
      createTaskAction(
        {},
        form({ title: "手順書", projectId: "project-a", repo: "acme/api", plan: "document" }),
      ),
    ).rejects.toThrow("redirect:/tasks/t1");
    expect(createTask).toHaveBeenCalledWith({
      title: "手順書",
      body: "",
      projectId: "project-a",
      repo: "acme/api",
      plan: "document",
    });

    createTask.mockClear();
    await expect(
      createTaskAction({}, form({ title: "決済", projectId: "project-a", plan: "" })),
    ).rejects.toThrow("redirect:/tasks/t1");
    expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty("plan");

    createTask.mockResolvedValue({ ok: false, message: "進め方「レビューだけ」は…" });
    expect(
      await createTaskAction({}, form({ title: "見る", projectId: "project-a", plan: "review" })),
    ).toMatchObject({ message: expect.stringMatching(/レビューだけ/), values: { plan: "review" } });
  });
});

describe("タスクのテンプレート（PBI-90）", () => {
  beforeEach(() => createTask.mockReset());

  it("テンプレートを選んだら、題・内容を渡さず、テンプレートとリポジトリだけで作る", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t9" } });
    await expect(
      createTaskAction(
        {},
        form({
          template: "sacty-setup",
          projectId: "project-a",
          repo: " https://github.com/acme/api ",
          // 隠した欄の値が残っていても、渡さない
          title: "残った題",
          body: "残った内容",
        }),
      ),
    ).rejects.toThrow("redirect:/tasks/t9");
    expect(createTask).toHaveBeenCalledWith({
      template: "sacty-setup",
      projectId: "project-a",
      repo: "https://github.com/acme/api",
    });
  });

  it("リポジトリを空欄にしたら省いて渡し、作れなければテンプレートを選んだまま理由を返す", async () => {
    createTask.mockResolvedValue({
      ok: false,
      message:
        "このテンプレートでは、対象リポジトリを選んでください（リポジトリを指定せずには作れません）。",
    });
    expect(
      await createTaskAction(
        {},
        form({ template: "sacty-setup", projectId: "project-a", repo: "" }),
      ),
    ).toMatchObject({
      message: expect.stringMatching(/対象リポジトリを選んでください/),
      values: { template: "sacty-setup", repo: "" },
    });
    expect(createTask).toHaveBeenCalledWith({ template: "sacty-setup", projectId: "project-a" });
    // 作成先が無ければ、作らない
    createTask.mockReset();
    expect(await createTaskAction({}, form({ template: "sacty-setup" }))).toMatchObject({
      message: expect.stringMatching(/作成先のプロジェクトが分かりません/),
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("テンプレートが「なし」（空）・知らない値なら、通常のタスクとして作る", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t1" } });
    for (const template of ["", "unknown"]) {
      createTask.mockClear();
      await expect(
        createTaskAction({}, form({ template, title: "決済", body: "", projectId: "project-a" })),
      ).rejects.toThrow("redirect:/tasks/t1");
      expect(createTask).toHaveBeenCalledWith({
        title: "決済",
        body: "",
        repo: null,
        projectId: "project-a",
      });
    }
  });
});

describe("作成・インポートの後のコンテキストの誤り（PBI-76 レビュー指摘）", () => {
  beforeEach(() => {
    saveProject.mockReset();
    importProject.mockReset();
  });
  const created = (contextError?: unknown) => ({
    ok: true,
    project: { id: "p 1", name: "決済" },
    ...(contextError ? { contextError } : {}),
  });

  it("作成でコンテキストに誤りがあれば、移った先の設定の画面で確かめ直して知らせる", async () => {
    saveProject.mockResolvedValue(created({ code: "context.cycle", params: { key: "x" } }));
    await expect(
      saveProjectAction({}, form({ id: "", definition: JSON.stringify({ name: "決済" }) })),
    ).rejects.toThrow("redirect:/projects/p%201/settings?contextCheck=1");
    // 誤りが無ければ、これまでどおり
    saveProject.mockResolvedValue(created());
    await expect(
      saveProjectAction({}, form({ id: "", definition: JSON.stringify({ name: "決済" }) })),
    ).rejects.toThrow(/^redirect:\/projects\/p%201\/settings$/);
  });

  it("保存（作成でない）の誤りは、その場で返す", async () => {
    saveProject.mockResolvedValue(created({ code: "context.cycle", params: { key: "x" } }));
    const state = await saveProjectAction(
      {},
      form({ id: "p 1", definition: JSON.stringify({ name: "決済" }) }),
    );
    expect(state).toMatchObject({
      saved: true,
      contextError: expect.stringContaining("循環"),
    });
  });

  it("コンテキストリポジトリを持つ定義をインポートしたら、設定の画面で誤りを確かめる", async () => {
    const file = (body: unknown) => {
      const data = new FormData();
      data.set("file", new File([JSON.stringify(body)], "p.json"));
      return data;
    };
    importProject.mockResolvedValue({
      ok: true,
      project: { id: "p1", name: "決済", context: { repo: "https://example.com/ctx.git" } },
    });
    await expect(importProjectAction({}, file({ sacty: "project" }))).rejects.toThrow(
      "redirect:/projects/p1/settings?contextCheck=1",
    );
    importProject.mockResolvedValue({ ok: true, project: { id: "p1", name: "決済" } });
    await expect(importProjectAction({}, file({ sacty: "project" }))).rejects.toThrow(
      /^redirect:\/projects\/p1\/settings$/,
    );
  });
});

describe("ヘッダーの表示を今の状態に合わせる（PBI-98）", () => {
  beforeEach(() => {
    for (const f of [approveStep, requestChanges, createTask, saveProject, importProject]) {
      f.mockReset();
    }
    cookieSet.mockReset();
    refresh.mockReset();
    order.length = 0;
  });
  const gate = (decision: string, comments = "") =>
    form({ taskId: "t1", step: "requirements", decision, submission: "1", comments });

  it("承認・差し戻しの後は、移る前にヘッダーも描き直させる（お知らせの印を残さない）", async () => {
    approveStep.mockResolvedValue({ ok: true });
    await expect(gateAction({}, gate("approve"))).rejects.toThrow("redirect:/tasks/t1");
    expect(order).toEqual(["refresh", "redirect"]);

    order.length = 0;
    requestChanges.mockResolvedValue({ ok: true });
    await expect(gateAction({}, gate("request", "直す"))).rejects.toThrow("redirect:/tasks/t1");
    expect(order).toEqual(["refresh", "redirect"]);
  });

  it("承認できなければ、描き直さずに理由を返す", async () => {
    approveStep.mockResolvedValue({ ok: false, message: "承認できません。" });
    expect(await gateAction({}, gate("approve"))).toMatchObject({ message: "承認できません。" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("タスクを作った後も、ヘッダーを描き直させる", async () => {
    createTask.mockResolvedValue({ ok: true, task: { id: "t2" } });
    await expect(
      createTaskAction({}, form({ title: "決済", body: "", projectId: "project-a" })),
    ).rejects.toThrow("redirect:/tasks/t2");
    expect(order).toEqual(["refresh", "redirect"]);
    order.length = 0;
    await expect(
      createTaskAction({}, form({ template: "sacty-setup", projectId: "project-a" })),
    ).rejects.toThrow("redirect:/tasks/t2");
    expect(order).toEqual(["refresh", "redirect"]);
  });

  it("作った・インポートしたプロジェクトを、表示しているプロジェクトにする（ヘッダーを設定の画面と合わせる）", async () => {
    saveProject.mockResolvedValue({ ok: true, project: { id: "p-new", name: "B" } });
    await expect(
      saveProjectAction({}, form({ id: "", definition: JSON.stringify({ name: "B" }) })),
    ).rejects.toThrow(/^redirect:\/projects\/p-new\/settings$/);
    expect(cookieSet).toHaveBeenCalledWith(
      "sacty-project",
      "p-new",
      expect.objectContaining({ path: "/", httpOnly: true }),
    );

    cookieSet.mockReset();
    const data = new FormData();
    data.set("file", new File([JSON.stringify({ sacty: "project" })], "p.json"));
    importProject.mockResolvedValue({ ok: true, project: { id: "p-imported", name: "C" } });
    await expect(importProjectAction({}, data)).rejects.toThrow(
      /^redirect:\/projects\/p-imported\/settings$/,
    );
    expect(cookieSet).toHaveBeenCalledWith("sacty-project", "p-imported", expect.anything());
  });

  it("設定の保存（作成でない）では、表示しているプロジェクトを変えない", async () => {
    saveProject.mockResolvedValue({ ok: true, project: { id: "p-a", name: "A" } });
    expect(
      await saveProjectAction({}, form({ id: "p-a", definition: JSON.stringify({ name: "A" }) })),
    ).toMatchObject({ saved: true });
    expect(cookieSet).not.toHaveBeenCalled();
    // 名前の変更は、描き直しでヘッダーにも出る
    expect(refresh).toHaveBeenCalled();
  });

  it("開いた画面のプロジェクトに合わせる。ID の形が違えば変えない", async () => {
    await selectProjectAction("p-a");
    expect(cookieSet).toHaveBeenCalledWith("sacty-project", "p-a", expect.anything());
    cookieSet.mockReset();
    for (const bad of ["", "a b", "a;b", "x".repeat(101)]) await selectProjectAction(bad);
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe("sacty の設定の保存（PBI-99）", () => {
  it("チェックを外した種類だけを Off として送る。PR の取り込みの On/Off（pullRequests）は送らない", async () => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue({ ok: true, settings: {} });
    const data = form({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      "triage-reviewLabel": "on",
    });
    expect(await saveSettingsAction({}, data)).toEqual({ saved: true });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      triageOff: ["issues", "tickets"],
    });
  });

  it("取り込みの種類ごとの間隔を送る（空はそのまま送り、デーモンが「設定しない」にする。PBI-100）", async () => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue({ ok: true, settings: {} });
    await saveSettingsAction(
      {},
      form({ intakeLabel: "sacty", issueIntervalSec: "60", reviewIntervalSec: "900" }),
    );
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({
      issueIntervalSec: "60",
      reviewIntervalSec: "900",
      ticketIntervalSec: "",
    });
  });

  it("Slack の通知先（PBI-115）は画面の JSON を送り、空なら送らない。読めない JSON はそのまま送ってデーモンに断らせる", async () => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue({ ok: true, settings: {} });
    const notification = { kind: "slack-webhook", webhook: "slack-webhook", language: "en" };
    await saveSettingsAction(
      {},
      form({ intakeLabel: "sacty", notification: JSON.stringify(notification) }),
    );
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({ notification });
    await saveSettingsAction({}, form({ intakeLabel: "sacty", notification: "" }));
    expect(saveSettings.mock.calls[1]?.[0]).not.toHaveProperty("notification");
    await saveSettingsAction({}, form({ intakeLabel: "sacty" }));
    expect(saveSettings.mock.calls[2]?.[0]).not.toHaveProperty("notification");
    await saveSettingsAction({}, form({ intakeLabel: "sacty", notification: "{broken" }));
    expect(saveSettings.mock.calls[3]?.[0]).toMatchObject({ notification: "{broken" });
  });

  it("デーモンが拒否した理由（使えない文字のラベルなど）を、そのまま返す", async () => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue({ ok: false, message: 'ラベルに " と \\ は使えません。' });
    expect(await saveSettingsAction({}, form({ intakeLabel: 'a"b' }))).toEqual({
      message: 'ラベルに " と \\ は使えません。',
    });
  });
});

describe("gh のアカウントの読み直し（PR #194 レビュー指摘）", () => {
  beforeEach(() => {
    getGitHubAccounts.mockReset();
  });

  it("デーモンが答えないまま期限が来たら、問い合わせを止めて、時間切れの理由を返す", async () => {
    // 期限の中断は、テストから起こす
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    getGitHubAccounts.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const result = reloadGitHubAccountsAction();
    deadline.abort(new Error("timeout"));
    expect(await result).toEqual({
      error: expect.stringMatching(/アカウントを読み直せませんでした（時間切れ）/),
    });
    expect(getGitHubAccounts).toHaveBeenCalledWith(deadline.signal);
    timeout.mockRestore();
  });

  it("デーモンに届かなければ、届かない理由を返す。読めたら一覧をそのまま返す", async () => {
    getGitHubAccounts.mockRejectedValueOnce(new Error("unreachable"));
    expect(await reloadGitHubAccountsAction()).toEqual({
      error: expect.stringMatching(/デーモンが動いているか確認してください/),
    });
    const accounts = [{ host: "github.com", login: "me", active: true, state: "success" }];
    getGitHubAccounts.mockResolvedValueOnce({ accounts });
    expect(await reloadGitHubAccountsAction()).toEqual({ accounts });
  });
});
