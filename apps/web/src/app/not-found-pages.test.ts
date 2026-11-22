import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

/**
 * `notFound()` を呼ぶ 8 ページ（PBI-477）。無いとする条件ごとに、ページの部品を描いて `notFound()` で止まること、
 * `generateMetadata` が無いページの題を返すこと、`not-found.tsx` が本文とリンクを出すことを、日英で確かめる。
 * 読み込み（デーモンとのやり取り）だけを差し替え、ページの部品・`generateMetadata` は本物を使う。
 */

let locale: Locale = "ja";
type World = {
  down: boolean;
  detail: unknown;
  runLog: unknown;
  taskFound: unknown;
  list: unknown;
  project: unknown;
  projects: { id: string; name: string; targets: unknown[] }[];
  schedules: unknown;
  schedule: unknown;
  audits: unknown;
};
const found = (): World => ({
  down: false,
  detail: { task: { id: "t1", projectId: "p1" } },
  runLog: { projectId: "p1" },
  taskFound: { task: { id: "t1", projectId: "p1" } },
  list: {},
  project: { project: { id: "p1", name: "決済" }, exclusions: [] },
  projects: [{ id: "p1", name: "決済", targets: [] }],
  schedules: [],
  schedule: {
    schedule: {
      id: "s1",
      projectId: "p1",
      name: "毎朝",
      enabled: true,
      rule: { kind: "daily", time: "09:00" },
      task: { title: "確認" },
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    tasks: [],
  },
  audits: { projectId: "p1", mock: false, defaultCapUsd: 1, audits: [], causes: [], proposals: [] },
});
let world = found();

const { DaemonUnavailableError } = vi.hoisted(() => ({
  DaemonUnavailableError: class extends Error {},
}));
/** 読み込みを、世界の状態で答える関数にする。デーモンに届かない状態では、届かない例外を投げる。 */
const read =
  <T>(pick: (w: World) => T) =>
  async () => {
    if (world.down) throw new DaemonUnavailableError("down");
    return pick(world);
  };

vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/daemon", () => ({
  CONTEXT_CHECK_PARAM: "contextCheck",
  DaemonUnavailableError,
  getTask: vi.fn(read((w) => w.taskFound)),
  getProject: vi.fn(read((w) => w.project)),
  listProjects: vi.fn(read((w) => w.projects)),
  listSchedules: vi.fn(read((w) => w.schedules)),
  getSchedule: vi.fn(read((w) => w.schedule)),
  getProjectAudits: vi.fn(read((w) => w.audits)),
  getStatus: async () => undefined,
  getGitHubAccounts: async () => ({ accounts: [] }),
  getProjectContextError: async () => undefined,
  getProjectPlatforms: async () => undefined,
}));
vi.mock("@/lib/task-detail-data", () => ({ loadTaskDetail: vi.fn(read((w) => w.detail)) }));
vi.mock("@/lib/run-log-data", () => ({ loadRunLog: vi.fn(read((w) => w.runLog)) }));
vi.mock("@/lib/task-list-data", () => ({ loadTaskList: vi.fn(read((w) => w.list)) }));
vi.mock("@/lib/live-server", () => ({ liveVersion: () => "v" }));
// ここで確かめるのは、無いページの扱いだけ。部品の中身は描かない
const none = () => null;
vi.mock("@/components/task-detail", () => ({ LiveTaskDetail: none }));
vi.mock("@/components/run-log", () => ({ LiveRunLog: none }));
vi.mock("@/components/review", () => ({ LiveReview: none }));
vi.mock("@/components/task-list", () => ({ LiveTaskList: none, TasksSection: none }));
vi.mock("@/components/new-task", () => ({ NewTask: none, NewTaskPlaceholder: none }));
vi.mock("@/components/shell/follow-project", () => ({ FollowProject: none }));
vi.mock("@/components/shell/guarded-link", () => ({ GuardedLink: none }));
vi.mock("@/components/daemon-error", () => ({ DaemonError: none }));
vi.mock("@/components/schedule-dialog", () => ({
  ScheduleDialog: none,
  DeleteScheduleButton: none,
}));
vi.mock("@/components/card-section", () => ({ CardSection: none }));
vi.mock("@/components/task-bits", () => ({ StatusLabelView: none, StepChipsView: none }));
vi.mock("@/components/ui/hint", () => ({ Hint: none }));
vi.mock("@/components/audit-screen", () => ({ AuditScreen: none }));
vi.mock("@/components/delete-project", () => ({ DeleteProjectSection: none }));
vi.mock("@/components/project-editor", () => ({ ProjectEditor: none }));

type Component = (props: unknown) => Promise<unknown>;
type Page = {
  default: Component;
  generateMetadata: (props: unknown) => Promise<{ title?: string }>;
};
type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children), ...elements(el.props.fallback)];
}

/** ページの部品が返した `<Suspense>` の中の、名前 inner の部品（データを読む部品）を描く。 */
async function renderInner(page: Page, props: unknown, inner: string): Promise<unknown> {
  const tree = elements(await page.default(props));
  const el = tree.find((e) => (e.type as { name?: string }).name === inner);
  if (!el) throw new Error(`no ${inner}`);
  return await (el.type as Component)(el.props);
}

type PageCase = {
  /** ページ（`/tasks/<ID>` など） */
  name: string;
  load: () => Promise<Page>;
  props: unknown;
  inner: string;
  /** 見つかったときの題（既定は `{}`）。 */
  foundTitle?: (m: ReturnType<typeof messagesFor>) => string;
  /** 無いとする条件ごとの、世界の変え方。ほかの読み込みは見つかった結果のまま。 */
  missing: [string, (w: World) => void][];
};
const params = (p: Record<string, string>) => Promise.resolve(p);
const withQuery = (p: Record<string, string>) => ({
  params: params(p),
  searchParams: Promise.resolve({}),
});

const CASES: PageCase[] = [
  {
    name: "/tasks/<ID>",
    load: () => import("./tasks/[id]/page") as Promise<Page>,
    props: { params: params({ id: "t1" }) },
    inner: "TaskDetail",
    missing: [
      [
        "loadTaskDetail が null",
        (w) => {
          w.detail = null;
        },
      ],
    ],
  },
  {
    name: "/tasks/<ID>/runs/<ID>",
    load: () => import("./tasks/[id]/runs/[runId]/page") as Promise<Page>,
    props: { params: params({ id: "t1", runId: "r1" }) },
    inner: "RunLog",
    missing: [
      [
        "loadRunLog が null",
        (w) => {
          w.runLog = null;
        },
      ],
    ],
  },
  {
    name: "/tasks/<ID>/review",
    load: () => import("./tasks/[id]/review/page") as Promise<Page>,
    props: { params: params({ id: "t1" }) },
    inner: "Review",
    missing: [
      [
        "getTask が null",
        (w) => {
          w.taskFound = null;
        },
      ],
    ],
  },
  {
    name: "/projects/<ID>/tasks",
    load: () => import("./projects/[id]/tasks/page") as Promise<Page>,
    props: withQuery({ id: "p1" }),
    inner: "Tasks",
    missing: [
      [
        "loadTaskList が null",
        (w) => {
          w.list = null;
        },
      ],
    ],
  },
  {
    name: "/projects/<ID>/settings",
    load: () => import("./projects/[id]/settings/page") as Promise<Page>,
    props: withQuery({ id: "p1" }),
    inner: "ProjectSettings",
    foundTitle: (m) => m.projects.settingsTitle("決済"),
    missing: [
      [
        "getProject が null",
        (w) => {
          w.project = null;
        },
      ],
    ],
  },
  {
    name: "/projects/<ID>/schedules",
    load: () => import("./projects/[id]/schedules/page") as Promise<Page>,
    props: { params: params({ id: "p1" }) },
    inner: "Schedules",
    missing: [
      [
        "listProjects に ID が無い",
        (w) => {
          w.projects = [];
        },
      ],
      [
        "listSchedules が null",
        (w) => {
          w.schedules = null;
        },
      ],
    ],
  },
  {
    name: "/projects/<ID>/schedules/<ID>",
    load: () => import("./projects/[id]/schedules/[scheduleId]/page") as Promise<Page>,
    props: { params: params({ id: "p1", scheduleId: "s1" }) },
    inner: "Schedule",
    missing: [
      [
        "listProjects に ID が無い",
        (w) => {
          w.projects = [];
        },
      ],
      [
        "getSchedule が null",
        (w) => {
          w.schedule = null;
        },
      ],
      [
        "予定の projectId が URL のプロジェクトと違う",
        (w) => {
          (w.schedule as { schedule: { projectId: string } }).schedule.projectId = "other";
        },
      ],
    ],
  },
  {
    name: "/projects/<ID>/audit",
    load: () => import("./projects/[id]/audit/page") as Promise<Page>,
    props: withQuery({ id: "p1" }),
    inner: "Audit",
    missing: [
      [
        "listProjects に ID が無い",
        (w) => {
          w.projects = [];
        },
      ],
      [
        "getProjectAudits が null",
        (w) => {
          w.audits = null;
        },
      ],
    ],
  },
];

beforeEach(() => {
  world = found();
});

const { default: NotFound } = await import("./not-found");

describe.each(["ja", "en"] as const)("notFound() を呼ぶページ（画面の言語 %s）", (lang) => {
  const m = () => messagesFor(lang);
  const title = () => `${m().common.notFound.title} - Sacty`;
  beforeEach(() => {
    locale = lang;
  });

  describe.each(CASES)("$name", (c) => {
    it.each(c.missing)(
      "無いとする条件（%s）：部品は notFound() で止まり、題は無いページのもの",
      async (_n, apply) => {
        apply(world);
        const page = await c.load();
        await expect(renderInner(page, c.props, c.inner)).rejects.toThrow("notFound");
        expect(await page.generateMetadata(c.props)).toEqual({ title: title() });
      },
    );

    it("あるときは、部品は notFound() を呼ばず、題は今のまま", async () => {
      const page = await c.load();
      await expect(renderInner(page, c.props, c.inner)).resolves.toBeDefined();
      expect(await page.generateMetadata(c.props)).toEqual(
        c.foundTitle ? { title: c.foundTitle(m()) } : {},
      );
    });

    it("デーモンに届かないときは、例外を投げず、題は今のまま（既定）", async () => {
      world.down = true;
      const page = await c.load();
      await expect(page.generateMetadata(c.props)).resolves.toEqual({});
    });
  });

  it("無いページの本文は、見出しと /dashboard へのリンクを出す", async () => {
    const html = renderToStaticMarkup((await NotFound()) as never);
    expect(html).toContain(`>${m().common.notFound.title}</h1>`);
    expect(html).toContain(`<a href="/dashboard"`);
    expect(html).toContain(`>${m().common.notFound.toDashboard}</a>`);
  });
});

describe("無いページの題の文言", () => {
  it('日本語は「ページが見つかりません - Sacty」、英語は "Page not found - Sacty"', async () => {
    const { notFoundMetadata } = await import("@/lib/not-found-metadata");
    locale = "ja";
    expect(await notFoundMetadata()).toEqual({ title: "ページが見つかりません - Sacty" });
    locale = "en";
    expect(await notFoundMetadata()).toEqual({ title: "Page not found - Sacty" });
  });
});
