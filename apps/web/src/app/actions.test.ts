import { beforeEach, describe, expect, it, vi } from "vitest";

const createTask = vi.fn();
vi.mock("@/lib/daemon", () => ({ createTask }));
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
vi.mock("next/cache", () => ({ refresh: () => {} }));

const { createTaskAction } = await import("./actions");

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
    expect(createTask).toHaveBeenCalledWith({ title: "決済", body: "", projectId: "project-a" });
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
