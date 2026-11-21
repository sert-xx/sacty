import { type DaemonText, mapFreeText } from "@sacty/core";

export const REDACTED = "[REDACTED]";

/**
 * 推測で取り出す秘密情報らしい文字列の、最短の長さ。短すぎる値を置き換えると、無関係な文字まで消えてしまう。
 * 名前を指定して取り出した秘密情報（キーチェーンの値）は、短くても必ず取り除くので、この制限は使わない。
 */
const MIN_GUESSED_LENGTH = 8;

/**
 * 値の全体の出現を探す木（Aho-Corasick）。値の集合が同じ間は、使い回せる。
 * 節は型付き配列で持つ（1 文字あたり約 14 バイト）。子が 1 つの節（長い値の途中はほぼすべて）は、その子を配列に直接入れ、
 * 子が 2 つ以上ある節の 2 つ目以降だけを Map に入れる（そうなる節の数は、値の数以下）。
 */
export type SecretMatcher = {
  targets: string[];
  /** 節の数（根を含む）。 */
  nodes: number;
  /** 節（0 が根）の最初の子の文字・節（0 は子なし） */
  firstCode: Uint16Array;
  firstChild: Int32Array;
  /** 子が 2 つ以上ある節の、2 つ目以降の子（文字 → 節） */
  more: Map<number, Map<number, number>>;
  fail: Int32Array;
  /** 節 n までの文字列の末尾に一致する、いちばん長い値の長さ（無ければ 0） */
  best: Int32Array;
};

function uniqueTargets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].filter((s) => s.length > 0);
}

/** node の、文字 code の子の節（無ければ 0。根は誰の子でもないので、0 を「無い」に使える）。 */
function childOf(m: SecretMatcher, node: number, code: number): number {
  const first = m.firstChild[node] as number;
  if (first === 0) return 0;
  if (m.firstCode[node] === code) return first;
  return m.more.get(node)?.get(code) ?? 0;
}

export function compileSecrets(secrets: readonly string[]): SecretMatcher {
  const targets = uniqueTargets(secrets);
  let capacity = 1;
  for (const secret of targets) capacity += secret.length;
  const m: SecretMatcher = {
    targets,
    nodes: 0,
    firstCode: new Uint16Array(capacity),
    firstChild: new Int32Array(capacity),
    more: new Map(),
    fail: new Int32Array(capacity),
    best: new Int32Array(capacity),
  };
  let count = 1;
  for (const secret of targets) {
    let node = 0;
    for (let i = 0; i < secret.length; i++) {
      const code = secret.charCodeAt(i);
      let found = childOf(m, node, code);
      if (found === 0) {
        found = count++;
        if (m.firstChild[node] === 0) {
          m.firstCode[node] = code;
          m.firstChild[node] = found;
        } else {
          const extra = m.more.get(node) ?? new Map<number, number>();
          m.more.set(node, extra);
          extra.set(code, found);
        }
      }
      node = found;
    }
    m.best[node] = secret.length;
  }
  m.nodes = count;
  const queue = new Int32Array(count);
  let tail = 0;
  const link = (node: number, code: number, c: number) => {
    let f = m.fail[node] as number;
    while (f !== 0 && childOf(m, f, code) === 0) f = m.fail[f] as number;
    m.fail[c] = childOf(m, f, code);
    m.best[c] = Math.max(m.best[c] as number, m.best[m.fail[c] as number] as number);
    queue[tail++] = c;
  };
  // 根の子は fail が根（根からの link は、根自身の子に当たらないよう別に扱う）
  const rootFirst = m.firstChild[0] as number;
  if (rootFirst !== 0) queue[tail++] = rootFirst;
  for (const c of m.more.get(0)?.values() ?? []) queue[tail++] = c;
  for (let head = 0; head < tail; head++) {
    const node = queue[head] as number;
    const first = m.firstChild[node] as number;
    if (first !== 0) link(node, m.firstCode[node] as number, first);
    for (const [code, c] of m.more.get(node) ?? []) link(node, code, c);
  }
  return m;
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
    while (state !== 0 && childOf(m, state, code) === 0) state = m.fail[state] as number;
    state = childOf(m, state, code);
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
