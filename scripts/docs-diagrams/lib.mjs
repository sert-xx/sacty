// docs の図（SVG）を、図の定義から日本語と英語の2つの版で作る。
// 定義は diagrams/ にある。色はライトとダークの表示で切り替わる（SVG の中の prefers-color-scheme）。
// 文言の幅は目安で見積もり、カードからはみ出しそうなら warnings に出す（描画の結果ではない）。

/** @typedef {"ja" | "en"} Lang */
/** @typedef {string | { ja: string, en: string }} Text */

export const LANGS = /** @type {const} */ (["ja", "en"]);

/** @param {string} ja @param {string} en @returns {Text} */
export const t = (ja, en) => ({ ja, en });

/** @param {Text | undefined} text @param {Lang} lang */
const pick = (text, lang) =>
  text === undefined ? "" : typeof text === "string" ? text : text[lang];

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const FONT = {
  title: 15,
  sub: 12.5,
  code: 11.5,
  label: 11.5,
  zone: 13,
};

/** 文字の幅の目安（全角は1字、半角はおよそ 0.56 字、等幅は 0.6 字）。 */
export function textWidth(s, size, mono = false) {
  let w = 0;
  for (const ch of String(s)) {
    const wide = /[　-鿿＀-￯←-⇿①-⓿■-➿]/.test(ch);
    w += wide
      ? size
      : size *
        (mono ? 0.6 : /[A-Z0-9]/.test(ch) ? 0.62 : /[ilj.,:;'|!()[\] ]/.test(ch) ? 0.3 : 0.52);
  }
  return w;
}

const TONES = ["blue", "green", "gray", "amber", "purple", "red"];

const STYLE = `
    svg { --text:#1f2328; --sub:#59636e; --card:#ffffff; --line:#d1d9e0; --arrow:#6e7781; --code-bg:#eff2f5;
          --blue:#0969da; --blue-bg:#ddf4ff; --blue-line:#54aeff;
          --green:#1a7f37; --green-bg:#dafbe1; --green-line:#4ac26b;
          --gray:#59636e; --gray-bg:#f6f8fa; --gray-line:#d1d9e0;
          --amber:#9a6700; --amber-bg:#fff8c5; --amber-line:#d4a72c;
          --purple:#8250df; --purple-bg:#fbefff; --purple-line:#c297ff;
          --red:#cf222e; --red-bg:#ffebe9; --red-line:#ff8182; }
    @media (prefers-color-scheme: dark) {
      svg { --text:#e6edf3; --sub:#9198a1; --card:#151b23; --line:#3d444d; --arrow:#9198a1; --code-bg:#262c36;
            --blue:#4493f8; --blue-bg:#0d2a4a; --blue-line:#1f6feb;
            --green:#3fb950; --green-bg:#0f2d1a; --green-line:#238636;
            --gray:#9198a1; --gray-bg:#10151c; --gray-line:#3d444d;
            --amber:#d29922; --amber-bg:#2e2410; --amber-line:#9e6a03;
            --purple:#ab7df8; --purple-bg:#271a3f; --purple-line:#8957e5;
            --red:#f85149; --red-bg:#3a1418; --red-line:#da3633; }
    }
    text { font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", "IPAGothic", sans-serif; fill: var(--text); }
    .zone { font-size: ${FONT.zone}px; font-weight: 600; }
    .title { font-size: ${FONT.title}px; font-weight: 600; }
    .sub { font-size: ${FONT.sub}px; fill: var(--sub); }
    .strong { font-size: ${FONT.sub}px; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${FONT.code}px; }
    .label { font-size: ${FONT.label}px; fill: var(--sub); }
    .card { fill: var(--card); stroke: var(--line); }
    .pill { fill: var(--code-bg); }
    .label-bg { fill: var(--card); opacity: .92; }
    .icon { fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .flow { fill: none; stroke: var(--arrow); stroke-width: 1.6; }
    .muted { fill: none; stroke: var(--arrow); stroke-width: 1.4; stroke-dasharray: 5 4; }
    .lifeline { fill: none; stroke: var(--line); stroke-width: 1.4; stroke-dasharray: 4 4; }`;

/** 線で描くアイコン（24 × 24）。外部の素材は使わない。 */
const ICONS = {
  box: '<path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>',
  shield:
    '<path d="M12 2.5 4.5 5.5v5.8c0 4.7 3.2 8.6 7.5 10.2 4.3-1.6 7.5-5.5 7.5-10.2V5.5z"/><path d="m8.8 12 2.3 2.3 4.3-4.6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="m10.5 12.5 9-9M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  cpu: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  server:
    '<rect x="3.5" y="3.5" width="17" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.5"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
  branch:
    '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 4.8-4 5.3-8.5 6.6-1.6.5-2.9 1.1-3.5 1.4"/>',
  plug: '<path d="M9 2.5v4.5M15 2.5v4.5M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v5.5"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.8-4 3.8-6.5 7.5-6.5s6.7 2.5 7.5 6.5"/>',
  browser:
    '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M2.5 8.5h19M6 6.3h.01M8.5 6.3h.01"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>',
  file: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M8 13h8M8 17h5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.8 2.8 5.2-5.6"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7M14 8.5v7"/>',
  cross: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  merge:
    '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="15" r="2.2"/><path d="M6 7.2v9.6M6 7.2c0 5 4 7.8 9.8 7.8"/>',
  loop: '<path d="M20 12a8 8 0 0 1-13.7 5.7M4 12a8 8 0 0 1 13.7-5.7"/><path d="M18 2.5v4h-4M6 21.5v-4h4"/>',
  flag: '<path d="M5 21.5V3.5M5 4h12l-2.5 4L17 12H5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.8M12 17.2h.01"/>',
  list: '<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
  bulb: '<path d="M9 18h6M10 21.5h4M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.6.5.8 1.2.8 1.9v1.8h6v-1.8c0-.7.3-1.4.8-1.9A6.5 6.5 0 0 0 12 2.5z"/>',
  network:
    '<rect x="9" y="2.5" width="6" height="5" rx="1"/><rect x="2.5" y="16.5" width="6" height="5" rx="1"/><rect x="15.5" y="16.5" width="6" height="5" rx="1"/><path d="M12 7.5V12M5.5 16.5V12h13v4.5"/>',
};

/** 辺の上の点。offset は辺の中央からのずれ。 */
function anchor(box, side, offset = 0) {
  const { x, y, w, h } = box;
  switch (side) {
    case "l":
      return [x, y + h / 2 + offset];
    case "r":
      return [x + w, y + h / 2 + offset];
    case "t":
      return [x + w / 2 + offset, y];
    case "b":
      return [x + w / 2 + offset, y + h];
    default:
      throw new Error(`unknown side ${side}`);
  }
}

/** 角を丸めた折れ線。 */
function polyline(points, radius = 10) {
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const l1 = Math.hypot(cx - px, cy - py);
    const l2 = Math.hypot(nx - cx, ny - cy);
    if (l1 === 0 || l2 === 0) continue;
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const ax = cx - ((cx - px) / l1) * r;
    const ay = cy - ((cy - py) / l1) * r;
    const bx = cx + ((nx - cx) / l2) * r;
    const by = cy + ((ny - cy) / l2) * r;
    d += ` L${round(ax)} ${round(ay)} Q${cx} ${cy} ${round(bx)} ${round(by)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

const round = (n) => Math.round(n * 10) / 10;

/** 2点を、辺の向きに合わせた曲線でつなぐ。 */
function curve(a, b, sa, sb) {
  const horizontal = (s) => s === "l" || s === "r";
  const dir = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
  const dist = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  const k = Math.max(
    24,
    (horizontal(sa) ? Math.abs(b[0] - a[0]) : Math.abs(b[1] - a[1])) / 2,
    dist / 4,
  );
  const c1 = [a[0] + dir[sa][0] * k, a[1] + dir[sa][1] * k];
  const c2 = [b[0] + dir[sb][0] * k, b[1] + dir[sb][1] * k];
  return `M${a[0]} ${a[1]} C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${b[0]} ${b[1]}`;
}

/**
 * 図を1つの言語で描く。
 * @param {object} def 図の定義
 * @param {Lang} lang
 * @returns {{ svg: string, warnings: string[] }}
 */
export function render(def, lang) {
  const warnings = [];
  const boxes = new Map();
  const warnWidth = (id, text, size, max, mono = false) => {
    const w = textWidth(text, size, mono);
    if (w > max)
      warnings.push(
        `${def.name}.${lang}: ${id} の「${text}」が幅を超えそう（${Math.round(w)} > ${max}）`,
      );
  };
  const tone = (name) => {
    if (!TONES.includes(name)) throw new Error(`${def.name}: unknown tone ${name}`);
    return name;
  };

  for (const item of def.items) {
    if (item.id && "w" in item) boxes.set(item.id, item);
  }

  const layers = { zones: [], edges: [], nodes: [], labels: [] };

  for (const item of def.items) {
    switch (item.kind) {
      case "zone": {
        const c = tone(item.tone ?? "gray");
        layers.zones.push(
          `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="14" style="fill:var(--${c}-bg);stroke:var(--${c}-line)"/>`,
        );
        if (item.label) {
          const label = pick(item.label, lang);
          warnWidth(item.id ?? "zone", label, FONT.zone, item.w - 40);
          layers.zones.push(
            `<text x="${item.x + 20}" y="${item.y + 26}" class="zone" style="fill:var(--${c})">${escapeXml(label)}</text>`,
          );
        }
        break;
      }
      case "card": {
        const c = tone(item.tone ?? "gray");
        const dash = item.dashed ? ";stroke-dasharray:5 4" : "";
        const stroke =
          item.strong || item.dashed ? `;stroke:var(--${c === "gray" ? "gray-line" : c})` : "";
        const sw = item.strong ? ";stroke-width:1.5" : "";
        layers.nodes.push(
          `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="10" class="card" style="${(stroke + sw + dash).slice(1)}"/>`,
        );
        const pad = 16;
        let tx = item.x + pad;
        const titleLines = [item.title]
          .flat()
          .filter((v) => v !== undefined)
          .map((v) => pick(v, lang));
        const center = item.align === "center";
        if (item.icon) {
          if (!ICONS[item.icon]) throw new Error(`${def.name}: unknown icon ${item.icon}`);
          const size = 26;
          const iy = item.y + (titleLines.length && !item.lines ? (item.h - size) / 2 : 14);
          layers.nodes.push(
            `<svg x="${item.x + pad}" y="${round(iy)}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" class="icon" style="stroke:var(--${c})">${ICONS[item.icon]}</svg>`,
          );
          tx = item.x + pad + size + 10;
        }
        const lines = (item.lines ?? []).map((l) =>
          typeof l === "object" && "text" in l ? l : { text: l, as: "sub" },
        );
        const titleTop = lines.length
          ? item.y + 32
          : item.y + item.h / 2 - ((titleLines.length - 1) * 19) / 2 + 5;
        titleLines.forEach((line, i) => {
          const avail = item.x + item.w - tx - 12;
          warnWidth(item.id, line, FONT.title, avail);
          const x = center && !item.icon ? item.x + item.w / 2 : tx;
          const anchorAttr = center && !item.icon ? ' text-anchor="middle"' : "";
          layers.nodes.push(
            `<text x="${round(x)}" y="${round(titleTop + i * 19)}" class="title"${anchorAttr}>${escapeXml(line)}</text>`,
          );
        });
        let ly = item.y + 32 + (titleLines.length - 1) * 19 + 28;
        let prev = "";
        for (const line of lines) {
          if (line.as === "code" && prev && prev !== "code") ly += 4;
          prev = line.as;
          const text = pick(line.text, lang);
          const lx = item.x + pad;
          const avail = item.w - pad * 2;
          if (line.as === "code") {
            const w = Math.min(avail, textWidth(text, FONT.code, true) + 16);
            warnWidth(item.id, text, FONT.code, avail - 16, true);
            layers.nodes.push(
              `<rect x="${lx}" y="${ly - 15}" width="${round(w)}" height="21" rx="5" class="pill"/>`,
              `<text x="${lx + 8}" y="${ly}" class="code">${escapeXml(text)}</text>`,
            );
            ly += 26;
          } else {
            warnWidth(item.id, text, FONT.sub, avail);
            layers.nodes.push(
              `<text x="${lx}" y="${ly}" class="${line.as === "strong" ? "strong" : "sub"}">${escapeXml(text)}</text>`,
            );
            ly += 20;
          }
        }
        if (ly - 20 + 12 > item.y + item.h + 2 && lines.length) {
          warnings.push(`${def.name}.${lang}: ${item.id} の中身が高さを超えそう`);
        }
        break;
      }
      case "edge": {
        const from = boxes.get(item.from);
        const to = boxes.get(item.to);
        if (!from || !to) throw new Error(`${def.name}: edge ${item.from} -> ${item.to}`);
        const a = anchor(from, item.fromSide ?? "r", item.fromOffset ?? 0);
        const b = anchor(to, item.toSide ?? "l", item.toOffset ?? 0);
        const d = item.via
          ? polyline([a, ...item.via, b])
          : item.straight
            ? polyline([a, b])
            : curve(a, b, item.fromSide ?? "r", item.toSide ?? "l");
        const cls = item.style === "muted" ? "muted" : "flow";
        const color = item.tone ? `stroke:var(--${tone(item.tone)})` : "";
        const marker = `ah-${item.tone ?? "arrow"}`;
        layers.edges.push(
          `<path d="${d}" class="${cls}" style="${color}" marker-end="url(#${marker})"/>`,
        );
        if (item.label) {
          const [lx, ly] = item.labelAt ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          labelAt(layers.labels, pick(item.label, lang), lx, ly, item.labelAnchor ?? "middle");
        }
        break;
      }
      case "text": {
        const text = pick(item.text, lang);
        layers.labels.push(
          `<text x="${item.x}" y="${item.y}" class="${item.as ?? "label"}"${item.anchor ? ` text-anchor="${item.anchor}"` : ""}>${escapeXml(text)}</text>`,
        );
        break;
      }
      case "lifeline": {
        layers.edges.push(`<path d="M${item.x} ${item.y1} V${item.y2}" class="lifeline"/>`);
        break;
      }
      case "message": {
        const y = item.y;
        const cls = item.dashed ? "muted" : "flow";
        if (item.self) {
          const d = polyline(
            [
              [item.x1, y],
              [item.x1 + 34, y],
              [item.x1 + 34, y + 18],
              [item.x1 + 4, y + 18],
            ],
            6,
          );
          layers.edges.push(`<path d="${d}" class="${cls}" marker-end="url(#ah-arrow)"/>`);
          labelAt(layers.labels, pick(item.label, lang), item.x1 + 44, y + 13, "start");
        } else {
          layers.edges.push(
            `<path d="M${item.x1} ${y} H${item.x2}" class="${cls}" marker-end="url(#ah-arrow)"/>`,
          );
          labelAt(
            layers.labels,
            pick(item.label, lang),
            (item.x1 + item.x2) / 2,
            y - 7,
            "middle",
            false,
          );
        }
        break;
      }
      case "frame": {
        layers.zones.push(
          `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="8" style="fill:none;stroke:var(--${tone(item.tone ?? "gray")}-line);stroke-dasharray:6 4"/>`,
          `<text x="${item.x + 10}" y="${item.y + 18}" class="label" style="fill:var(--${item.tone ?? "gray"})">${escapeXml(pick(item.label, lang))}</text>`,
        );
        break;
      }
      case "lane": {
        const c = tone(item.tone);
        layers.edges.push(
          `<path d="${polyline(item.points, 14)}" style="fill:none;stroke:var(--${c});stroke-width:4;stroke-linecap:round"/>`,
        );
        break;
      }
      case "commit": {
        const c = tone(item.tone);
        layers.nodes.push(
          item.merge
            ? `<circle cx="${item.x}" cy="${item.y}" r="8" style="fill:var(--card);stroke:var(--${c});stroke-width:4"/>`
            : `<circle cx="${item.x}" cy="${item.y}" r="8" style="fill:var(--${c})"/>`,
        );
        if (item.label) {
          const above = item.labelPos === "above";
          layers.labels.push(
            `<text x="${item.x}" y="${item.y + (above ? -16 : 26)}" class="label" text-anchor="middle">${escapeXml(pick(item.label, lang))}</text>`,
          );
        }
        break;
      }
      case "tag": {
        const c = tone(item.tone);
        const text = pick(item.text, lang);
        const w = textWidth(text, FONT.code, true) + 18;
        const x = item.anchor === "end" ? item.x - w : item.x;
        layers.nodes.push(
          `<rect x="${round(x)}" y="${item.y - 13}" width="${round(w)}" height="24" rx="12" style="fill:var(--${c}-bg);stroke:var(--${c}-line)"/>`,
          `<text x="${round(x + 9)}" y="${item.y + 4}" class="code" style="fill:var(--${c})">${escapeXml(text)}</text>`,
        );
        break;
      }
      default:
        throw new Error(`${def.name}: unknown kind ${item.kind}`);
    }
  }

  function labelAt(list, text, x, y, anchorPos, bg = true) {
    if (!text) return;
    const w = textWidth(text, FONT.label) + 10;
    const left = anchorPos === "middle" ? x - w / 2 : anchorPos === "end" ? x - w : x - 5;
    if (bg)
      list.push(
        `<rect x="${round(left)}" y="${round(y - 13)}" width="${round(w)}" height="18" rx="4" class="label-bg"/>`,
      );
    list.push(
      `<text x="${round(x)}" y="${round(y)}" class="label" text-anchor="${anchorPos}">${escapeXml(text)}</text>`,
    );
  }

  const markers = ["arrow", ...TONES]
    .map(
      (c) =>
        `<marker id="ah-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" style="fill:var(--${c})"/></marker>`,
    )
    .join("\n    ");

  const legend = def.legend
    ? `\n  <text x="20" y="28" class="label">${escapeXml(pick(def.legend, lang))}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${def.width} ${def.height}" width="${def.width}" height="${def.height}" role="img" aria-labelledby="title desc">
  <!-- scripts/docs-diagrams で作ったファイル。直すときは定義（scripts/docs-diagrams/diagrams/${def.name}.mjs）を直して npm run docs:diagrams で作り直す -->
  <title id="title">${escapeXml(pick(def.title, lang))}</title>
  <desc id="desc">${escapeXml(pick(def.desc, lang))}</desc>
  <style>${STYLE}
  </style>
  <defs>
    ${markers}
  </defs>${legend}
  ${[...layers.zones, ...layers.edges, ...layers.nodes, ...layers.labels].join("\n  ")}
</svg>
`;
  return { svg, warnings };
}

/** 図の出力先（docs からの相対パス）。日本語の版は <名前>.svg、英語の版は <名前>.en.svg。 */
export function outputPaths(def, lang) {
  return def.outputs.map((dir) => `${dir}/images/${def.name}${lang === "en" ? ".en" : ""}.svg`);
}
