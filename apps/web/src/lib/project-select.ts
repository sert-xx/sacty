import type { Project } from "@sacty/core";

/** 表示しているプロジェクトを覚えておく cookie。 */
export const PROJECT_COOKIE = "sacty-project";
export const DEFAULT_PROJECT_ID = "default";

/** 表示しているプロジェクト。cookie のプロジェクトが無くなっていれば、既定のプロジェクト。 */
export function resolveProject(projects: readonly Project[], id: string): Project | undefined {
  return (
    projects.find((p) => p.id === id) ??
    projects.find((p) => p.id === DEFAULT_PROJECT_ID) ??
    projects[0]
  );
}

const BASE = "http://sacty.invalid";

/**
 * 画面の中の移動先なら、ブラウザが解釈するのと同じ形に正規化して返す（ほかのサイトへ移らせないため）。
 * 制御文字とバックスラッシュを含むものは拒否する（ブラウザは URL として解釈するときに、タブや改行を
 * 取り除き、バックスラッシュをスラッシュとして扱うので、「/<タブ>/evil.example/」は外部へ解決される）。
 * 固定の基準 URL で解決した結果が同じオリジンになることも確かめる。
 */
export function safeLocalPath(path: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するための検査
  if (!path.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(path)) return undefined;
  let url: URL;
  try {
    url = new URL(path, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE) return undefined;
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  // 正規化したパスも、ブラウザがもう一度解釈して同じ画面の中・同じパスになることを確かめる
  // （「/a/..//evil.example/」は正規化すると「//evil.example/」になり、外部へ解決されるため）
  if (normalized.startsWith("//")) return undefined;
  const again = new URL(normalized, BASE);
  if (again.origin !== BASE || `${again.pathname}${again.search}${again.hash}` !== normalized) {
    return undefined;
  }
  return normalized;
}
