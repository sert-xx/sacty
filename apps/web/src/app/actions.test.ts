import { beforeEach, describe, expect, it, vi } from "vitest";

const createTicket = vi.fn();
vi.mock("@/lib/daemon", () => ({ createTicket }));
// 送信時の cookie は、別のタブで切り替えた「B」になっている
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "project-b" }) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/cache", () => ({ refresh: () => {} }));

const { createTicketAction } = await import("./actions");

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
};

describe("チケットの作成先（PBI-4a レビュー指摘）", () => {
  beforeEach(() => createTicket.mockReset());

  it("作成先は、フォームを表示したときのプロジェクトで、送信時の cookie ではない", async () => {
    createTicket.mockResolvedValue({ ok: true, task: { id: "t1" } });
    await expect(
      createTicketAction({}, form({ title: "決済", body: "", projectId: "project-a" })),
    ).rejects.toThrow("redirect:/tasks/t1");
    expect(createTicket).toHaveBeenCalledWith({ title: "決済", body: "", projectId: "project-a" });
  });

  it("作成先が無い・見つからなければ、理由を返して作らない", async () => {
    expect(await createTicketAction({}, form({ title: "決済" }))).toMatchObject({
      message: expect.stringMatching(/作成先のプロジェクトが分かりません/),
    });
    expect(createTicket).not.toHaveBeenCalled();

    createTicket.mockResolvedValue({ ok: false, message: "プロジェクトが見つかりません。" });
    expect(
      await createTicketAction({}, form({ title: "決済", projectId: "deleted" })),
    ).toMatchObject({ message: "プロジェクトが見つかりません。" });
  });
});
