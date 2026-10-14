import { beforeEach, describe, expect, it, vi } from "vitest";

const createTask = vi.fn();
const saveProject = vi.fn();
const importProject = vi.fn();
vi.mock("@/lib/daemon", () => ({
  createTask,
  saveProject,
  importProject,
  CONTEXT_CHECK_PARAM: "contextCheck",
}));
// 送信時の cookie は、別のタブで切り替えた「B」になっている
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "sacty-project" ? { value: "project-b" } : undefined),
  }),
  headers: async () => new Headers({ "accept-language": "ja" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {} }));

const { createTaskAction, importProjectAction, saveProjectAction } = await import("./actions");

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
    ).rejects.toThrow("redirect:/projects/p%201?contextCheck=1");
    // 誤りが無ければ、これまでどおり
    saveProject.mockResolvedValue(created());
    await expect(
      saveProjectAction({}, form({ id: "", definition: JSON.stringify({ name: "決済" }) })),
    ).rejects.toThrow(/^redirect:\/projects\/p%201$/);
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
      "redirect:/projects/p1?contextCheck=1",
    );
    importProject.mockResolvedValue({ ok: true, project: { id: "p1", name: "決済" } });
    await expect(importProjectAction({}, file({ sacty: "project" }))).rejects.toThrow(
      /^redirect:\/projects\/p1$/,
    );
  });
});
