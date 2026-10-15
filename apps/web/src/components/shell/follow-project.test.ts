import { beforeEach, describe, expect, it, vi } from "vitest";

let cookie = "";
const listProjects = vi.fn();
vi.mock("@/lib/current-project", () => ({ currentProjectId: async () => cookie }));
vi.mock("@/lib/daemon", () => ({ listProjects }));
vi.mock("./select-project", () => ({ SelectProject: () => null }));

const { FollowProject } = await import("./follow-project");
const { SelectProject } = await import("./select-project");

const project = (id: string) => ({ id, name: id, targets: [], createdAt: "", updatedAt: "" });

describe("開いた画面のプロジェクトに、ヘッダーを合わせる（PBI-98）", () => {
  beforeEach(() => {
    listProjects.mockReset();
    listProjects.mockResolvedValue([project("p-a"), project("p-b")]);
  });

  it("表示しているプロジェクトと違えば、画面のプロジェクトに合わせる", async () => {
    cookie = "p-a";
    const element = (await FollowProject({ projectId: "p-b" })) as {
      type: unknown;
      props: { projectId: string };
    } | null;
    expect(element?.type).toBe(SelectProject);
    expect(element?.props.projectId).toBe("p-b");
  });

  it("同じなら何もせず、デーモンにも問い合わせない", async () => {
    cookie = "p-b";
    expect(await FollowProject({ projectId: "p-b" })).toBeNull();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("画面のプロジェクトが無くなっていれば（削除したプロジェクトのタスク）、選んでいるプロジェクトを変えない", async () => {
    cookie = "p-a";
    expect(await FollowProject({ projectId: "deleted" })).toBeNull();
    // デーモンにつながらなければ、変えない
    listProjects.mockRejectedValue(new Error("unreachable"));
    expect(await FollowProject({ projectId: "p-b" })).toBeNull();
  });
});
