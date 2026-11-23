import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: Number.MAX_SAFE_INTEGER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ls-tree succeeds with an empty result for an absent path, but fails on Git errors.
function objectType(cwd, rev, file) {
  const output = git(cwd, "ls-tree", "-z", rev, "--", `:(literal)${file}`);
  const entry = output.split("\0").find((item) => item.slice(item.indexOf("\t") + 1) === file);
  return entry ? entry.split(" ")[1] : null;
}

function codeMaskedLines(content) {
  const lines = content.toString("utf8").split("\n");
  let fence = null;
  const masked = lines.map((line) => {
    // Block quotes can contain fenced and indented code blocks.
    const body = line.replace(/^ {0,3}(?:> ?)+/, "");
    const match = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const inside = fence !== null;
    if (match) {
      if (!fence && !(match[1][0] === "`" && match[2].includes("`"))) fence = match[1];
      else if (
        fence &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length &&
        !match[2].trim()
      )
        fence = null;
      return " ".repeat(line.length);
    }
    if (inside || /^(?: {4}|\t)/.test(body)) return " ".repeat(line.length);
    return line;
  });
  // A matching backtick run may close on a later line. Mask only matched spans.
  const text = masked.join("\n");
  const chars = text.split("");
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === "`") end++;
    const length = end - i;
    let close = end;
    while (close < text.length) {
      close = text.indexOf("`", close);
      if (close < 0) break;
      let stop = close;
      while (text[stop] === "`") stop++;
      if (stop - close === length) break;
      close = stop;
    }
    if (close < 0 || close >= text.length) {
      i = end;
      continue;
    }
    for (let j = i; j < close + length; j++) if (chars[j] !== "\n") chars[j] = " ";
    i = close + length;
  }
  return chars.join("").split("\n");
}

function inlineLinks(line) {
  const links = [];
  let code = 0;
  for (let i = 0; i < line.length; ) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === "`") {
      let end = i;
      while (line[end] === "`") end++;
      const length = end - i;
      if (code === length) code = 0;
      else if (!code && line.indexOf("`".repeat(length), end) !== -1) code = length;
      i = end;
      continue;
    }
    if (!code && line[i] === "[" && (i === 0 || line[i - 1] !== "!")) {
      const match = line.slice(i).match(/^\[([^\]\\]*)\]\(([^\s)\\]+)\)/);
      if (match) {
        const start = i + match[1].length + 3;
        links.push({ start, end: start + match[2].length, target: match[2] });
        i += match[0].length;
        continue;
      }
    }
    i++;
  }
  return links;
}

function linkFix(oldLine, newLine, oldMask, newMask, file, head, cwd) {
  const oldLinks = inlineLinks(oldMask);
  const newLinks = inlineLinks(newMask);
  if (!oldLinks.length || oldLinks.length !== newLinks.length) return false;
  const skeleton = (line, links) => {
    let result = "";
    let offset = 0;
    for (const link of links) {
      result += line.slice(offset, link.start);
      offset = link.end;
    }
    return result + line.slice(offset);
  };
  if (skeleton(oldLine, oldLinks) !== skeleton(newLine, newLinks)) return false;
  let changed = false;
  for (let i = 0; i < oldLinks.length; i++) {
    const before = oldLinks[i].target;
    const after = newLinks[i].target;
    if (before === after) continue;
    changed = true;
    // 外部リンクや文書内アンカーの生存は Git のツリーから確認できない。
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(before)) return false;
    const exists = (target) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) return false;
      const clean = target.split(/[?#]/, 1)[0];
      if (!clean) return false;
      let decoded;
      try {
        decoded = decodeURIComponent(clean);
      } catch {
        decoded = clean;
      }
      if (decoded.includes("\0")) return null;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
      return objectType(cwd, head, resolved);
    };
    if (exists(before) || exists(after) !== "blob") return false;
  }
  return changed;
}

export function checkWorklogHistory({ cwd = process.cwd(), base, head, title, number }) {
  if (!base || !head || !title || !number)
    throw new Error("ベース・先頭の SHA、PR の題・番号が必要です");
  for (const sha of [base, head]) {
    try {
      git(cwd, "rev-parse", "--verify", `${sha}^{commit}`);
    } catch {
      throw new Error(`SHA を解決できません: ${sha}`);
    }
  }
  const mergeBase = git(cwd, "merge-base", base, head).trim();
  const files = git(
    cwd,
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    mergeBase,
    head,
    "--",
    "docs/worklog/*.md",
  )
    .split("\0")
    .filter(Boolean)
    .filter((f) => /^docs\/worklog\/[^/]+\.md$/.test(f) && f !== "docs/worklog/README.md");
  const pbi = title.match(/PBI-(\d+)/i)?.[1];
  const prefix = pbi ? `pbi-${pbi}-` : `pr-${number}-`;
  const violations = [];
  for (const file of files) {
    if (!objectType(cwd, mergeBase, file)) continue;
    const headExists = objectType(cwd, head, file) !== null;
    const contents = (headExists ? [mergeBase, head] : [mergeBase]).map((rev) =>
      execFileSync("git", ["show", `${rev}:${file}`], {
        cwd,
        maxBuffer: Number.MAX_SAFE_INTEGER,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const binary = git(
      cwd,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      mergeBase,
      head,
      "--",
      file,
    ).startsWith("-\t-\t");
    const invalid = contents.some((content) => {
      if (content.includes(0)) return true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
        return false;
      } catch {
        return true;
      }
    });
    if (binary || invalid) {
      violations.push({ file, lines: ["テキストとして判定できないファイルの変更"] });
      continue;
    }
    if (!headExists) {
      const content = contents[0].toString("utf8");
      const count = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
      const lines = Array.from({ length: count }, (_, i) => `マージベースの版の行 ${i + 1}`);
      violations.push({ file, lines: lines.length ? lines : ["空のファイルを削除"] });
      continue;
    }
    const [oldMasks, newMasks] = contents.map(codeMaskedLines);
    const sameTask =
      /^\d{8}-/.test(path.posix.basename(file)) &&
      path.posix.basename(file).slice(9).startsWith(prefix);
    // Valid UTF-8 is checked before parsing the diff.
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--no-renames",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        mergeBase,
        head,
        "--",
        file,
      ],
      { cwd, maxBuffer: Number.MAX_SAFE_INTEGER, stdio: ["ignore", "pipe", "pipe"] },
    ).toString("utf8");
    const hunks = diff.split(/^@@ /m).slice(1);
    const issues = [];
    for (const hunk of hunks) {
      const lines = hunk.split("\n");
      const header = lines.shift().match(/^-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!header) throw new Error(`差分を解析できません: ${file}`);
      let oldNo = Number(header[1]);
      let newNo = Number(header[2]);
      const removed = [];
      const added = [];
      for (const line of lines) {
        if (line.startsWith("-")) removed.push({ text: line.slice(1), line: oldNo++ });
        else if (line.startsWith("+")) added.push({ text: line.slice(1), line: newNo++ });
      }
      let last = -1;
      const paired = new Set();
      for (const old of removed) {
        const index = added.findIndex(
          (item, i) =>
            i > last &&
            linkFix(
              old.text,
              item.text,
              oldMasks[old.line - 1],
              newMasks[item.line - 1],
              file,
              head,
              cwd,
            ),
        );
        if (index >= 0) {
          last = index;
          paired.add(index);
        } else issues.push(`マージベースの版の行 ${old.line}`);
      }
      if (!sameTask)
        added.forEach((item, i) => {
          if (!paired.has(i)) issues.push(`PR の先頭の版の行 ${item.line}`);
        });
    }
    if (issues.length) violations.push({ file, lines: issues });
  }
  return { mergeBase, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = checkWorklogHistory({
      base: process.env.BASE_SHA,
      head: process.env.HEAD_SHA,
      title: process.env.PR_TITLE,
      number: process.env.PR_NUMBER,
    });
    for (const issue of result.violations) {
      console.error(
        `${issue.file}: ${issue.lines.join(", ")}\nこのファイルの変更を戻してください（git checkout ${result.mergeBase} -- ${/^[a-zA-Z0-9_./-]+$/.test(issue.file) ? issue.file : `'${issue.file.replaceAll("'", "'\\''")}'`}）。同じタスクのファイルには、既存の行を変えずに書き足してください。`,
      );
    }
    if (result.violations.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
