import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const { DaemonUnavailableError, listProjectRepositories } = vi.hoisted(() => ({
  DaemonUnavailableError: class extends Error {},
  listProjectRepositories: vi.fn(),
}));
vi.mock("@/lib/daemon", () => ({ DaemonUnavailableError, listProjectRepositories }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));

const { GET } = await import("./route");
const get = (id: string) =>
  GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });
const t = messagesFor("ja").forms.task;

beforeEach(() => {
  listProjectRepositories.mockReset();
});

describe("リポジトリの候補を返す（PBI-109）", () => {
  it("候補と、読めなかった Org の理由（画面の言語の文言）を返す", async () => {
    listProjectRepositories.mockResolvedValue({
      repositories: ["acme/api"],
      errors: [{ org: "beta", message: "gh を実行できません" }],
    });
    const res = await get("p1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      repositories: ["acme/api"],
      problems: [t.listFailed("beta", "gh を実行できません")],
    });
    expect(listProjectRepositories).toHaveBeenCalledWith("p1");
  });

  it("デーモンにつながらない・失敗したときは、理由を返す", async () => {
    listProjectRepositories.mockImplementation(async () => {
      throw new DaemonUnavailableError("つながりません");
    });
    const down = await get("p1");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ message: "つながりません" });
    listProjectRepositories.mockImplementation(async () => {
      throw new Error("daemon responded 500");
    });
    const failed = await get("p1");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ message: t.repositoriesNoAnswer });
  });

  it("ID の形が違えば、デーモンに問い合わせない", async () => {
    const res = await get("../tasks");
    expect(res.status).toBe(404);
    expect(listProjectRepositories).not.toHaveBeenCalled();
  });
});
