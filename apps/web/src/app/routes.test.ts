import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listProjects = vi.fn();
vi.mock("@/lib/daemon", () => ({ listProjects }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const { default: Home } = await import("./page");
const { default: ProjectPage } = await import("./projects/[id]/page");
const { GET: current } = await import("./projects/current/[[...view]]/route");
const { GET: switchProject } = await import("./switch/route");

const project = (id: string) => ({ id, name: id, targets: [], createdAt: "", updatedAt: "" });
const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie: `sacty-project=${cookie}` } : {},
  });
const currentAt = (view: string[] | undefined, cookie?: string) =>
  current(request(`/projects/current/${(view ?? []).join("/")}`, cookie), {
    params: Promise.resolve(view ? { view } : {}),
  });

beforeEach(() => {
  listProjects.mockReset();
  listProjects.mockResolvedValue([project("p1"), project("p 2")]);
});

describe("画面の URL のリダイレクト（PBI-114）", () => {
  it("/ はダッシュボードへ移す", () => {
    expect(() => Home()).toThrow(/^redirect:\/dashboard$/);
  });

  it("/projects/<ID> は、そのプロジェクトのタスクの一覧へ移す", async () => {
    await expect(ProjectPage({ params: Promise.resolve({ id: "p 2" }) })).rejects.toThrow(
      /^redirect:\/projects\/p%202\/tasks$/,
    );
  });

  it("サイドメニューの「設定」（/projects/current）は、表示しているプロジェクトの設定へ移す", async () => {
    const res = await currentAt(undefined, "p%202");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects/p%202/settings");
    // 別名は作らない（サイドメニューは /projects/current を使う）
    expect((await currentAt(["settings"], "p1")).status).toBe(404);
  });

  it("サイドメニューの「タスク」（/projects/current/tasks）は、表示しているプロジェクトのタスクの一覧へ移す", async () => {
    expect((await currentAt(["tasks"], "p%202")).headers.get("location")).toBe(
      "/projects/p%202/tasks",
    );
    // cookie のプロジェクトが無い・消えていれば、最初のプロジェクト
    expect((await currentAt(["tasks"], "gone")).headers.get("location")).toBe("/projects/p1/tasks");
    expect((await currentAt(["tasks"])).headers.get("location")).toBe("/projects/p1/tasks");
  });

  it("デーモンにつながらなければプロジェクトの一覧へ。知らない画面は 404", async () => {
    listProjects.mockRejectedValue(new Error("unreachable"));
    expect((await currentAt(["tasks"], "p1")).headers.get("location")).toBe("/projects");
    expect((await currentAt(["export"], "p1")).status).toBe(404);
    expect((await currentAt(["tasks", "x"], "p1")).status).toBe(404);
  });

  it("/switch は cookie を切り替え、移動先が無ければ切り替えたプロジェクトのタスクの一覧へ移す", () => {
    const res = switchProject(request("/switch?project=p1"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects/p1/tasks");
    expect(res.cookies.get("sacty-project")?.value).toBe("p1");
    // 移動先を指定すれば、そこへ
    expect(
      switchProject(request("/switch?project=p1&to=%2Ftasks%2Ft1%2Freview")).headers.get(
        "location",
      ),
    ).toBe("/tasks/t1/review");
    // 画面の外への移動先は受け付けない
    expect(
      switchProject(request("/switch?project=p1&to=%2F%2Fevil.example")).headers.get("location"),
    ).toBe("/projects/p1/tasks");
    // ID の形が違えば、切り替えずにダッシュボードへ
    const bad = switchProject(request("/switch?project=..%2Fx"));
    expect(bad.headers.get("location")).toBe("/dashboard");
    expect(bad.cookies.get("sacty-project")).toBeUndefined();
  });
});
