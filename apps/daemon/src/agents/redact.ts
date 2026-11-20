import { type DaemonText, mapFreeText } from "@sacty/core";

export const REDACTED = "[REDACTED]";

/**
 * 推測で取り出す秘密情報らしい文字列の、最短の長さ。短すぎる値を置き換えると、無関係な文字まで消えてしまう。
 * 名前を指定して取り出した秘密情報（キーチェーンの値）は、短くても必ず取り除くので、この制限は使わない。
 */
const MIN_GUESSED_LENGTH = 8;

/** 値の全体の出現を探す木（Aho-Corasick）。値の集合が同じ間は、使い回せる。 */
export type SecretMatcher = {
  targets: string[];
  /** 節ごとの、文字（UTF-16 の1単位）から子の節への対応（節 0 が根） */
  children: Map<number, number>[];
  fail: number[];
  /** 節 n までの文字列の末尾に一致する、いちばん長い値の長さ（無ければ 0） */
  best: number[];
};

function uniqueTargets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].filter((s) => s.length > 0);
}

export function compileSecrets(secrets: readonly string[]): SecretMatcher {
  const targets = uniqueTargets(secrets);
  const children: Map<number, number>[] = [new Map()];
  const best: number[] = [0];
  for (const secret of targets) {
    let node = 0;
    for (let i = 0; i < secret.length; i++) {
      const code = secret.charCodeAt(i);
      let found = (children[node] as Map<number, number>).get(code);
      if (found === undefined) {
        found = children.length;
        children.push(new Map());
        best.push(0);
        (children[node] as Map<number, number>).set(code, found);
      }
      node = found;
    }
    best[node] = secret.length;
  }
  const fail: number[] = new Array(children.length).fill(0);
  const queue: number[] = [...(children[0] as Map<number, number>).values()];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as number;
    for (const [code, c] of children[node] as Map<number, number>) {
      let f = fail[node] as number;
      while (f !== 0 && !(children[f] as Map<number, number>).has(code)) f = fail[f] as number;
      fail[c] = (children[f] as Map<number, number>).get(code) ?? 0;
      best[c] = Math.max(best[c] as number, best[fail[c] as number] as number);
      queue.push(c);
    }
  }
  return { targets, children, fail, best };
}

type Cluster = { start: number; end: number; emitted: boolean };

/** text の中の値の全体の出現を、1回の走査で探し、重なる出現を束ねたかたまりにして返す（開始の昇順）。 */
function findClusters(text: string, m: SecretMatcher, covered: number): Cluster[] {
  // 各末尾の位置で、いちばん長く一致する出現（開始が最も前）だけで、和集合は変わらない。末尾の昇順に、重なるかたまりを束ねる
  const stack: Cluster[] = [];
  if (covered > 0) stack.push({ start: 0, end: covered, emitted: true });
  let state = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    while (state !== 0 && !(m.children[state] as Map<number, number>).has(code))
      state = m.fail[state] as number;
    state = (m.children[state] as Map<number, number>).get(code) ?? 0;
    const length = m.best[state] as number;
    if (length === 0) continue;
    const start = i + 1 - length;
    const end = i + 1;
    const top = stack[stack.length - 1];
    if (!top || top.end <= start) {
      stack.push({ start, end, emitted: false });
      continue;
    }
    // 重なる：直前のかたまりを延ばし、さらに前のかたまりに届いたら束ねる（出現ごとに作り直さない）
    top.start = Math.min(top.start, start);
    top.end = Math.max(top.end, end);
    for (
      let prev = stack[stack.length - 2];
      prev && prev.end > top.start;
      prev = stack[stack.length - 2]
    ) {
      prev.start = Math.min(prev.start, top.start);
      prev.end = Math.max(prev.end, top.end);
      prev.emitted = prev.emitted || top.emitted;
      stack.pop();
      top.start = prev.start;
      top.end = prev.end;
      top.emitted = prev.emitted;
    }
  }
  return stack;
}

/**
 * 少しずつ届く出力のための、`redact` の途中までの版。text の先頭の covered 文字は、すでに `[REDACTED]` を出したかたまりの中。
 * text の cut の手前までを伏せて返し、cut 以降（と、cut をまたぐかたまりの、すでに伏せた分の長さ）は、次につなげるために返す。
 * cut は、いちばん長い値の長さより1文字短い分だけ末尾に残す位置以前にする（そうすれば、cut の手前のかたまりは、次に届く分で変わらない）。
 */
export function redactPartial(
  text: string,
  matcher: SecretMatcher,
  covered: number,
  cut: number,
): { out: string; rest: string; covered: number } {
  // どの値も含まなければ、走査せずに切るだけ（持ち越しは伏せる前の文字列なので、これでよい）
  if (covered === 0 && !matcher.targets.some((s) => text.includes(s))) {
    return { out: text.slice(0, cut), rest: text.slice(cut), covered: 0 };
  }
  const clusters = findClusters(text, matcher, covered);
  let out = "";
  let done = 0;
  let restCovered = 0;
  for (const cluster of clusters) {
    if (cluster.end > cut) {
      if (cluster.start < cut || cluster.emitted) {
        out += text.slice(done, cluster.start) + (cluster.emitted ? "" : REDACTED);
        done = cut;
        restCovered = cluster.end - cut;
      }
      break;
    }
    out += text.slice(done, cluster.start) + (cluster.emitted ? "" : REDACTED);
    done = cluster.end;
  }
  if (done < cut) out += text.slice(done, cut);
  return { out, rest: text.slice(cut), covered: restCovered };
}

/**
 * 実行に渡した秘密情報を、文字列から取り除く。長さにかかわらず、渡した値はすべて対象にする。
 * エージェントの出力やエラー文に認証値が含まれても、追記専用の作業履歴（後から消せない）に残さないため。
 * 値の全体の出現（ほかの値や自分自身と重なる出現を含む）に含まれる文字は、1文字も残さない。重なる出現は、1つの `[REDACTED]` にする。
 */
export function redact(text: string, secrets: readonly string[]): string {
  // 一致が無い入力（ほとんどの入力）は、木を作らずに返す
  if (!secrets.some((s) => s.length > 0 && text.includes(s))) return text;
  return redactPartial(text, compileSecrets(secrets), 0, text.length).out;
}

/**
 * 出力の中の JSON の文字列（"…"）のうち、エスケープ（`\u0073` など）を戻すと秘密情報を含むものを、伏せた文字列に置き換える
 * （PBI-131）。sacty はエージェントの出力の JSON をデコードして使う（レビューのコメント・監査・再現のテストなど）ので、生の文字列で
 * 伏せただけでは、デコードで元の値に戻ってしまう。先に redact で生の文字列を伏せてから呼ぶ。
 * 文字列の始まりは、出力の中のどの `"` からでも試す（前にある地の文の `"` で、組がずれても見落とさないように）。ただし、
 * エスケープした `"`（前のバックスラッシュが奇数個）からは試さない。JSON の文字列はそこからは始まらず、試すと長い文字列の
 * 途中の `\"` ごとに末尾まで解析し直して、二乗の時間がかかる（PR #143 レビュー指摘）。どの位置も、隣の `"` までを
 * 一度ずつ読むだけにする。入れ子の JSON の文字列（エスケープした JSON）も、デコードした中身を同じように確かめる。
 */
export function redactEscaped(text: string, secrets: readonly string[]): string {
  const targets = secrets.filter((s) => s.length > 0);
  if (targets.length === 0 || !text.includes("\\")) return text;
  const literal = /"(?:[^"\\\n]|\\.)*"/y;
  const out: string[] = [];
  let last = 0;
  /** i の次の、エスケープしていない `"` の位置（無ければ -1）。 */
  const nextQuote = (from: number): number => {
    for (let at = text.indexOf('"', from); at !== -1; at = text.indexOf('"', at + 1)) {
      let slashes = 0;
      while (at - slashes - 1 >= 0 && text[at - slashes - 1] === "\\") slashes++;
      if (slashes % 2 === 0) return at;
    }
    return -1;
  };
  let i = nextQuote(0);
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
          i = nextQuote(last);
          continue;
        }
      }
    }
    i = nextQuote(i + 1);
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
