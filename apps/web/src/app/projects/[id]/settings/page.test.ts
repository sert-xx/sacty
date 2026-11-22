import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    h("a", { href }, children),
}));
vi.mock("next/navigation", () => ({ notFound: () => {} }));
vi.mock("@/components/project-editor", () => ({ ProjectEditor: () => null }));
vi.mock("@/components/delete-project", () => ({ DeleteProjectSection: () => null }));
vi.mock("@/components/shell/follow-project", () => ({ FollowProject: () => null }));
vi.mock("@/lib/daemon", () => {
  class DaemonUnavailableError extends Error {}
  return {
    CONTEXT_CHECK_PARAM: "contextCheck",
    DaemonUnavailableError,
    getProject: async (id: string) =>
      id === "gone" ? null : { project: { id, name: "Sacty" }, exclusions: [] },
    getGitHubAccounts: async () => ({ accounts: [] }),
    getProjectContextError: async () => undefined,
    getProjectPlatforms: async () => undefined,
    getStatus: async () => undefined,
  };
});

const { default: Page, generateMetadata } = await import("./page");
const { GuardedLink } = await import("@/components/shell/guarded-link");

function findAll(node: unknown, match: (el: ReactElement) => boolean, out: ReactElement[] = []) {
  if (Array.isArray(node)) for (const n of node) findAll(n, match, out);
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: unknown }>;
    if (match(el)) out.push(el);
    findAll(el.props.children, match, out);
  }
  return out;
}

const params = (id: string) => Promise.resolve({ id });

/** 名前が「Sacty」のプロジェクトの設定の見出し（h1）。非同期の部品は、呼んで中身を取り出して描く。 */
async function render(): Promise<ReactElement> {
  const page = (await Page({
    params: params("p1"),
    searchParams: Promise.resolve({}),
  })) as ReactElement<{
    children: ReactElement<{ children: ReactElement<{ params: Promise<{ id: string }> }> }>[];
  }>;
  const suspense = page.props.children[1] as ReactElement<{ children: ReactElement }>;
  const inner = suspense.props.children as ReactElement<Record<string, unknown>> & {
    type: (props: unknown) => Promise<ReactElement>;
  };
  return await inner.type(inner.props);
}

async function heading(): Promise<string> {
  const html = renderToStaticMarkup(await render());
  return /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1] ?? "";
}

describe.each([
  ["ja", "プロジェクト「Sacty」の設定"],
  ["en", 'Project "Sacty" settings'],
] as const)("プロジェクトの設定の見出しとブラウザーのタイトル（画面の言語 %s）", (lang, title) => {
  it("名前が Sacty のプロジェクトでも、見出しとタイトルが同じ文言で、Sacty の設定と取り違えない", async () => {
    locale = lang;
    // 見出しは HTML のエスケープ（" → &quot;）を戻して比べる
    expect((await heading()).replaceAll("&quot;", '"')).toBe(title);
    expect(await generateMetadata({ params: params("p1") })).toEqual({ title });
    expect(title).not.toBe(messagesFor(lang).settings.title);
  });

  it("プロジェクトが無ければ、タイトルは無いページのもの", async () => {
    locale = lang;
    expect(await generateMetadata({ params: params("gone") })).toEqual({
      title: `${messagesFor(lang).common.notFound.title} - Sacty`,
    });
  });
});

describe("パンくず", () => {
  it("プロジェクトの一覧へのパンくずは、保存していない変更を確かめる GuardedLink で描く", async () => {
    locale = "ja";
    const page = await Page({ params: params("p1"), searchParams: Promise.resolve({}) });
    const links = findAll(page, (el) => (el.props as { href?: string }).href === "/projects");
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((el) => el.type === GuardedLink)).toBe(true);
  });
});
