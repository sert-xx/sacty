/** テーマの設定。system は OS の設定に従う。 */
export type ThemePreference = "system" | "light" | "dark";

const KEY = "sacty-theme";

/**
 * 最初の描画の前に、保存したテーマを適用するスクリプト（ちらつきを防ぐため <head> で実行する）。
 * 保存先が使えない環境では、システムに従う。
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${KEY}")||"system";var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.toggle("dark",d);e.dataset.theme=t}catch(_){}})();`;

export function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ThemePreference): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = theme;
}

export function writeTheme(theme: ThemePreference): void {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // 保存できなくても、この画面には適用する
  }
  applyTheme(theme);
}
