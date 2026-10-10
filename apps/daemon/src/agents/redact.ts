export const REDACTED = "[REDACTED]";

/** 短すぎる値（"1" やリージョン名など）を置き換えると、無関係な文字まで消えてしまうため対象外にする。 */
const MIN_SECRET_LENGTH = 8;

/**
 * 実行に渡した秘密情報を、文字列から取り除く。
 * エージェントの出力やエラー文に認証値が含まれても、追記専用の台帳（後から消せない）に残さないため。
 */
export function redact(text: string, secrets: readonly string[]): string {
  const targets = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of targets) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
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
    if (text.trim()) found.push(text.trim());
  }
  return found;
}
