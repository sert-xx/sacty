import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({}));

const { AuditCard } = await import("./dashboard");
const { auditSection } = await import("@/lib/dashboard-data");

const project = (id: string, name: string) => ({
  id,
  name,
  targets: [],
  createdAt: "",
  updatedAt: "",
});

describe("ダッシュボードの監査の欄（PBI-124）", () => {
  it("プロジェクトの名前を添え、消したプロジェクトの分は出さない", () => {
    const section = auditSection([project("p1", "決済")], {
      mock: false,
      projects: [
        { projectId: "p1", causes: 2, recurred: 1, pending: 1, adopted: 1, rejected: 0 },
        { projectId: "gone", causes: 9, recurred: 0, pending: 0, adopted: 0, rejected: 0 },
      ],
      trend: [],
    });
    expect(section.projects).toEqual([
      {
        projectId: "p1",
        projectName: "決済",
        causes: 2,
        recurred: 1,
        pending: 1,
        adopted: 1,
        rejected: 0,
      },
    ]);
  });

  it("件数・採用率（判断が無ければ —）・週ごとの1件あたりの件数を出し、プロジェクトの監査の画面へ移れる", () => {
    const html = renderToStaticMarkup(
      createElement(AuditCard, {
        audit: {
          mock: true,
          projects: [
            {
              projectId: "p 1",
              projectName: "決済",
              causes: 3,
              recurred: 1,
              pending: 2,
              adopted: 1,
              rejected: 3,
            },
            {
              projectId: "p2",
              projectName: "Web",
              causes: 1,
              recurred: 0,
              pending: 1,
              adopted: 0,
              rejected: 0,
            },
          ],
          trend: [{ weekStart: "2026-10-12", tasks: 4, remarks: 6 }],
        },
      }),
    );
    expect(html).toContain('href="/projects/p%201/audit"');
    expect(html).toContain("25%");
    expect(html).toMatch(/data-testid="audit-project-p2"[\s\S]*?—/);
    expect(html).toContain("2026-10-12");
    expect(html).toContain("1.5");
    expect(html).toContain("モック");
  });

  it("監査の結果が無ければ、無いことを出す", () => {
    const html = renderToStaticMarkup(
      createElement(AuditCard, { audit: { mock: false, projects: [], trend: [] } }),
    );
    expect(html).toContain("監査の結果はまだありません。");
  });
});
