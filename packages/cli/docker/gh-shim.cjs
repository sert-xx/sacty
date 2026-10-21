#!/usr/bin/env node
// sacty のエージェント実行用イメージの gh。本物の gh の代わりに、gh api（REST の GET と GraphQL の query）だけを、
// sacty のゲートウェイの GitHub の読み取りの中継（$SACTY_GITHUB_URL/<ホスト>/…）に送る。トークンはコンテナに無く、
// ゲートウェイが、タスクのプロジェクトで選んだ gh のアカウントで認証する。書き込み（PR・Issue へのコメントなど）は
// できない。投稿する内容は工程の出力に書き、人間の承認の後に sacty が投稿する。
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const RELAY = process.env.SACTY_GITHUB_URL || "";
const HOSTS = (process.env.SACTY_GITHUB_HOSTS || "").split(/\s+/).filter(Boolean);

function usage() {
  return [
    "この gh は sacty のエージェント用で、gh api（REST の GET と、GraphQL の query）だけを使えます。",
    "書き込み（POST・PATCH・DELETE・mutation）と、gh pr view などのほかのコマンドは使えません。",
    "例：",
    "  gh api repos/<owner>/<repo>/pulls/<番号>",
    "  gh api --paginate repos/<owner>/<repo>/pulls/<番号>/comments",
    '  gh api graphql -f query=\'query($n: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $n) { title } } }\' -F n=1',
    `使えるホスト：${HOSTS.length > 0 ? HOSTS.join(" ") : "（なし）"}（既定は GH_HOST。ほかは --hostname）`,
    "PR・Issue にコメントするなら、工程の出力に sacty-github-comments の JSON で書いてください（承認の後に sacty が投稿します）。",
  ].join("\n");
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    method: undefined,
    headers: [],
    fields: [],
    hostname: undefined,
    paginate: false,
    include: false,
    silent: false,
    jq: undefined,
    input: undefined,
    endpoint: undefined,
  };
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined) die(`gh: ${name} の値がありません`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      const v = value(i, name);
      i++;
      return v;
    };
    switch (name) {
      case "-X":
      case "--method":
        opts.method = take().toUpperCase();
        break;
      case "-H":
      case "--header":
        opts.headers.push(take());
        break;
      case "-f":
      case "--raw-field":
        opts.fields.push({ raw: true, pair: take() });
        break;
      case "-F":
      case "--field":
        opts.fields.push({ raw: false, pair: take() });
        break;
      case "--hostname":
        opts.hostname = take();
        break;
      case "--paginate":
        opts.paginate = true;
        break;
      case "--slurp":
        break;
      case "-i":
      case "--include":
        opts.include = true;
        break;
      case "--silent":
        opts.silent = true;
        break;
      case "-q":
      case "--jq":
        opts.jq = take();
        break;
      case "--input":
        opts.input = take();
        break;
      case "-t":
      case "--template":
        die("gh: --template は使えません。--jq を使ってください");
        break;
      case "--cache":
        take();
        break;
      case "-p":
      case "--preview":
        opts.headers.push(`Accept: application/vnd.github.${take()}-preview+json`);
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") die(`gh: ${arg} は使えません\n\n${usage()}`);
        if (opts.endpoint !== undefined) die(`gh: 引数が多すぎます（${arg}）`);
        opts.endpoint = arg;
    }
  }
  if (!opts.endpoint) die(usage());
  return opts;
}

/** {owner}・{repo}・{branch} を、GH_REPO か、作業ディレクトリの git の origin から埋める。 */
function fillPlaceholders(endpoint) {
  if (!/\{(owner|repo|branch)\}/.test(endpoint)) return endpoint;
  let owner;
  let repo;
  const ghRepo = process.env.GH_REPO;
  if (ghRepo) {
    const parts = ghRepo.split("/");
    [owner, repo] = parts.slice(-2);
  } else {
    try {
      const url = execFileSync("git", ["remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
      if (m) [, owner, repo] = m;
    } catch {}
  }
  let branch;
  if (endpoint.includes("{branch}")) {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
  }
  return endpoint.replace(/\{(owner|repo|branch)\}/g, (all, key) => {
    const v = key === "owner" ? owner : key === "repo" ? repo : branch;
    if (!v) die(`gh: ${all} を決められません。owner・repo を書いた endpoint にしてください`);
    return encodeURIComponent(v);
  });
}

function fieldValue(field) {
  const eq = field.pair.indexOf("=");
  if (eq <= 0) die(`gh: フィールドは key=value の形で書いてください（${field.pair}）`);
  const key = field.pair.slice(0, eq);
  const raw = field.pair.slice(eq + 1);
  if (field.raw) return [key, raw];
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    return [key, readFileSync(file === "-" ? 0 : file, "utf8")];
  }
  if (raw === "true") return [key, true];
  if (raw === "false") return [key, false];
  if (raw === "null") return [key, null];
  if (/^-?\d+$/.test(raw)) return [key, Number(raw)];
  return [key, raw];
}

function headersOf(opts, graphql) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "sacty-gh",
  };
  if (graphql) headers["content-type"] = "application/json";
  for (const h of opts.headers) {
    const colon = h.indexOf(":");
    if (colon <= 0) die(`gh: ヘッダーは "名前: 値" の形で書いてください（${h}）`);
    headers[h.slice(0, colon).trim().toLowerCase()] = h.slice(colon + 1).trim();
  }
  return headers;
}

function nextLink(link) {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return undefined;
}

/** 中継の URL（ゲートウェイが書き換えたもの）なら、SACTY_GITHUB_URL と同じ起点で送る。 */
function sameRelay(link) {
  if (!link) return undefined;
  try {
    const relay = new URL(RELAY);
    const next = new URL(link);
    if (next.pathname.startsWith(relay.pathname)) {
      return `${relay.origin}${next.pathname}${next.search}`;
    }
  } catch {}
  return link;
}

function pageInfo(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.pageInfo && typeof value.pageInfo === "object" && "hasNextPage" in value.pageInfo) {
    return value.pageInfo;
  }
  for (const v of Object.values(value)) {
    const found = pageInfo(v);
    if (found) return found;
  }
  return undefined;
}

function print(opts, res, text) {
  if (opts.include) {
    process.stdout.write(`HTTP/1.1 ${res.status} ${res.statusText}\n`);
    res.headers.forEach((v, k) => {
      process.stdout.write(`${k}: ${v}\n`);
    });
    process.stdout.write("\n");
  }
  if (opts.silent) return;
  if (opts.jq !== undefined) {
    const jq = spawnSync("jq", ["-r", opts.jq], { input: text, encoding: "utf8" });
    if (jq.error)
      die("gh: --jq には jq が要りますが、このイメージにありません。--jq を外して読んでください");
    process.stdout.write(jq.stdout);
    if (jq.status !== 0) die(jq.stderr.trim() || "gh: jq が失敗しました");
    return;
  }
  process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}

async function send(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: "follow" });
  } catch (error) {
    die(
      `gh: sacty のゲートウェイに届きませんでした：${error instanceof Error ? error.message : error}`,
    );
  }
  const text = await res.text();
  return { res, text };
}

function failed(res, text) {
  let message = res.statusText;
  try {
    const json = JSON.parse(text);
    message = json?.error?.message || json?.message || message;
  } catch {}
  return `gh: ${message} (HTTP ${res.status})`;
}

async function api(argv) {
  if (!RELAY)
    die(
      "gh: SACTY_GITHUB_URL がありません（このタスクのプロジェクトで GitHub のアカウントを選んでいないか、sacty の外で動いています）",
    );
  const opts = parseArgs(argv);
  let endpoint = fillPlaceholders(opts.endpoint);
  let host = opts.hostname || process.env.GH_HOST || HOSTS[0] || "github.com";
  // 完全な URL（https://api.github.com/… や https://<ホスト>/api/v3/…）も受け付ける
  const full = endpoint.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
  if (full) {
    const urlHost = full[1].toLowerCase();
    const rest = full[2] || "/";
    if (urlHost === "api.github.com") {
      host = "github.com";
      endpoint = rest;
    } else {
      host = urlHost;
      endpoint = rest.replace(/^\/api\/v3(?=\/|$)/, "").replace(/^\/api\/graphql$/, "/graphql");
    }
  }
  endpoint = endpoint.replace(/^\/+/, "");
  const graphql = endpoint === "graphql";
  const method = opts.method || (graphql ? "POST" : "GET");
  if (graphql ? method !== "POST" : method !== "GET" && method !== "HEAD") {
    die(`gh: ${method} は使えません（読み取りだけです）。\n\n${usage()}`);
  }
  const base = `${RELAY.replace(/\/+$/, "")}/${host}`;
  const headers = headersOf(opts, graphql);
  if (graphql) {
    let payload;
    if (opts.input) {
      payload = JSON.parse(readFileSync(opts.input === "-" ? 0 : opts.input, "utf8"));
    } else {
      const variables = {};
      let query;
      for (const field of opts.fields) {
        const [key, v] = fieldValue(field);
        if (key === "query") query = v;
        else variables[key] = v;
      }
      if (typeof query !== "string") die("gh: graphql には -f query='…' が要ります");
      payload = { query, variables };
    }
    for (let page = 0; ; page++) {
      const { res, text } = await send(`${base}/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        print(opts, res, text);
        die(failed(res, text));
      }
      print(opts, res, text);
      let json;
      try {
        json = JSON.parse(text);
      } catch {}
      // GraphQL は、問い合わせの誤り・権限の不足でも 200 で errors を返す（本物の gh と同じく、失敗で終わる）
      if (Array.isArray(json?.errors) && json.errors.length > 0) {
        die(
          json.errors
            .map((e) => `gh: ${typeof e?.message === "string" ? e.message : JSON.stringify(e)}`)
            .join("\n"),
        );
      }
      if (!opts.paginate || !/\$endCursor\b/.test(payload.query || "")) return;
      const info = pageInfo(json?.data);
      if (!info?.hasNextPage || !info.endCursor || page > 1000) return;
      payload = { ...payload, variables: { ...payload.variables, endCursor: info.endCursor } };
    }
  }
  // REST は読み取りだけなので、フィールドはクエリにする（本物の gh は、フィールドがあると POST になる）
  const [path, existing = ""] = endpoint.split(/\?(.*)/s);
  const params = new URLSearchParams(existing);
  for (const field of opts.fields) {
    const [key, v] = fieldValue(field);
    params.append(key, v === null ? "" : String(v));
  }
  const query = params.toString();
  let url = `${base}/${path}${query ? `?${query}` : ""}`;
  const pages = [];
  // 配列の応答を受け取ったか（0 件でも [] を出すため）
  let arrays = false;
  for (let page = 0; url; page++) {
    const { res, text } = await send(url, { method, headers });
    if (!res.ok) {
      print(opts, res, text);
      die(failed(res, text));
    }
    if (!opts.paginate) {
      print(opts, res, text);
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      print(opts, res, text);
      return;
    }
    if (!Array.isArray(json)) {
      print(opts, res, text);
    } else {
      arrays = true;
      pages.push(...json);
    }
    url = page < 1000 ? sameRelay(nextLink(res.headers.get("link"))) : undefined;
    if (!url && arrays) print({ ...opts, include: false }, res, JSON.stringify(pages));
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "api") return api(rest);
  if (command === "--version" || command === "version") {
    process.stdout.write("gh (sacty: gh api only, through the sacty gateway)\n");
    return;
  }
  if (command === "auth" && rest[0] === "status") {
    process.stdout.write(
      `${RELAY ? `gh api は sacty のゲートウェイ経由で使えます（ホスト：${HOSTS.join(" ") || "なし"}）。` : "SACTY_GITHUB_URL がありません。"}\n${usage()}\n`,
    );
    return;
  }
  die(`gh: ${command ? `${command} は` : "このコマンドは"}使えません。\n\n${usage()}`);
}

main().catch((error) => die(`gh: ${error instanceof Error ? error.message : error}`));
