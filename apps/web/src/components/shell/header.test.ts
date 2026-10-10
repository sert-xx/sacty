import { describe, expect, it, vi } from "vitest";

// デーモンにつながらない（一覧の取得が失敗する）
vi.mock("@/lib/daemon", () => ({
  listProjects: () => Promise.reject(new Error("unreachable")),
  listTasks: () => Promise.reject(new Error("unreachable")),
}));
vi.mock("@/i18n/server", () => ({
  languagePreference: async () => "en",
  getMessages: async () => {
    throw new Error("not used");
  },
}));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "default",
  resolveProject: () => undefined,
}));

const { AppHeader, HeaderFallback } = await import("./header");

describe("デーモンにつながらないときのヘッダー（PBI-4b レビュー指摘）", () => {
  it("保存済みの言語の設定を、ユーザーメニューに渡す", async () => {
    const element = (await AppHeader()) as { type: unknown; props: { language?: string } };
    expect(element.type).toBe(HeaderFallback);
    expect(element.props.language).toBe("en");
  });
});
