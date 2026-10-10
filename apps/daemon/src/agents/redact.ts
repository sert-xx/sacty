import { type DaemonText, mapFreeText } from "@sacty/core";

export const REDACTED = "[REDACTED]";

/**
 * 推測で取り出す秘密情報らしい文字列の、最短の長さ。短すぎる値を置き換えると、無関係な文字まで消えてしまう。
 * 名前を指定して取り出した秘密情報（キーチェーンの値）は、短くても必ず取り除くので、この制限は使わない。
 */
const MIN_GUESSED_LENGTH = 8;

/**
 * 実行に渡した秘密情報を、文字列から取り除く。長さにかかわらず、渡した値はすべて対象にする。
 * エージェントの出力やエラー文に認証値が含まれても、追記専用の台帳（後から消せない）に残さないため。
 */
export function redact(text: string, secrets: readonly string[]): string {
  const targets = [...new Set(secrets)]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of targets) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

/**
 * 文（コードと引数の文言を含む）から、秘密情報を取り除く。コードと引数の文言は、引数の文を取り除く
 * （外から来た文を引数に入れているため）。
 */
export function redactText<T extends DaemonText>(text: T, secrets: readonly string[]): T {
  // コードや決まった値の引数（列挙など）は変えない（短い秘密情報と重なっても、文言が壊れないように）
  return mapFreeText(text, (value) => redact(value, secrets)) as T;
}

/** JSON（認証ファイルなど）に含まれる、秘密情報らしい文字列をすべて取り出す。 */
export function secretStringsInJson(text: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (value.length >= 16) found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };
  try {
    walk(JSON.parse(text));
  } catch {
    // JSONでなければ、ファイル全体を1つの秘密情報として扱う
    if (text.trim().length >= MIN_GUESSED_LENGTH) found.push(text.trim());
  }
  return found;
}
