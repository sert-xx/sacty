import type { Project } from "@sacty/core";

/** 表示しているプロジェクトを覚えておく cookie。 */
export const PROJECT_COOKIE = "sacty-project";

/** 表示しているプロジェクトの cookie の属性（切り替え・作成・表示したプロジェクトに合わせるときに共通）。 */
export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** cookie に入れてよいプロジェクトの ID か（デーモンが作る ID の形。存在はデーモンで確かめる）。 */
export function isProjectId(id: string): boolean {
  return /^[\w-]{1,100}$/.test(id);
}

/**
 * プロジェクトの画面（タスク・プロジェクトの設定）を開いたとき、表示しているプロジェクトをそのプロジェクトに合わせる
 * 必要があるか（ヘッダーは cookie のプロジェクトを出すので、合わせないと本文とずれる。PBI-98）。cookie のプロジェクトが
 * 無くなっていて、たまたま最初のプロジェクトを開いたときも合わせる（cookie を今のプロジェクトにしておく）。
 */
export function needsProjectSelect(cookieId: string, pageProjectId: string): boolean {
  return cookieId !== pageProjectId && isProjectId(pageProjectId);
}

/**
 * 表示しているプロジェクト。cookie のプロジェクトが無い・無くなっていれば、最初のプロジェクト
 * （既定のプロジェクトは無い。PBI-22）。プロジェクトが1つも無ければ undefined。
 */
export function resolveProject(projects: readonly Project[], id: string): Project | undefined {
  return projects.find((p) => p.id === id) ?? projects[0];
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
