import { type DaemonText, mapFreeText } from "@sacty/core";

export const REDACTED = "[REDACTED]";

/**
 * 推測で取り出す秘密情報らしい文字列の、最短の長さ。短すぎる値を置き換えると、無関係な文字まで消えてしまう。
 * 名前を指定して取り出した秘密情報（キーチェーンの値）は、短くても必ず取り除くので、この制限は使わない。
 */
const MIN_GUESSED_LENGTH = 8;

/**
 * 実行に渡した秘密情報を、文字列から取り除く。長さにかかわらず、渡した値はすべて対象にする。
 * エージェントの出力やエラー文に認証値が含まれても、追記専用の作業履歴（後から消せない）に残さないため。
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
 * 出力の中の JSON の文字列（"…"）のうち、エスケープ（`\u0073` など）を戻すと秘密情報を含むものを、伏せた文字列に置き換える
 * （PBI-131）。sacty はエージェントの出力の JSON をデコードして使う（レビューのコメント・監査・再現のテストなど）ので、生の文字列で
 * 伏せただけでは、デコードで元の値に戻ってしまう。先に redact で生の文字列を伏せてから呼ぶ。
 * 文字列の始まりは、出力の中のどの `"` からでも試す（前にある地の文の `"` で、組がずれても見落とさないように）。入れ子の JSON の
 * 文字列（エスケープした JSON）も、デコードした中身を同じように確かめる。
 */
export function redactEscaped(text: string, secrets: readonly string[]): string {
  const targets = secrets.filter((s) => s.length > 0);
  if (targets.length === 0 || !text.includes("\\")) return text;
  const literal = /"(?:[^"\\\n]|\\.)*"/y;
  const out: string[] = [];
  let last = 0;
  let i = text.indexOf('"');
  while (i !== -1) {
    literal.lastIndex = i;
    const found = literal.exec(text)?.[0];
    if (found?.includes("\\")) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(found);
      } catch {
        decoded = undefined;
      }
      if (typeof decoded === "string") {
        const hidden = redactEscaped(redact(decoded, targets), targets);
        if (hidden !== decoded) {
          out.push(text.slice(last, i), JSON.stringify(hidden));
          last = i + found.length;
          i = text.indexOf('"', last);
          continue;
        }
      }
    }
    i = text.indexOf('"', i + 1);
  }
  return last === 0 ? text : out.join("") + text.slice(last);
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
