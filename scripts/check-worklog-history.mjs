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

function linkFix(oldLine, newLine, file, head, cwd) {
  const pattern = /(!?\[[^\]]*\]\()([^\s)]+)(\))/g;
  const oldLinks = [...oldLine.matchAll(pattern)];
  const newLinks = [...newLine.matchAll(pattern)];
  if (!oldLinks.length || oldLinks.length !== newLinks.length) return false;
  const skeleton = (line) => line.replace(pattern, "$1$3");
  if (skeleton(oldLine) !== skeleton(newLine)) return false;
  let changed = false;
  for (let i = 0; i < oldLinks.length; i++) {
    const before = oldLinks[i][2];
    const after = newLinks[i][2];
    if (before === after) continue;
    changed = true;
    // 外部リンクや文書内アンカーの生存は Git のツリーから確認できない。
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(before)) return false;
    const exists = (target) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) return false;
      const clean = target.split(/[?#]/, 1)[0];
      if (!clean) return false;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), decodeURIComponent(clean)),
      );
      try {
        git(cwd, "cat-file", "-e", `${head}:${resolved}`);
        return true;
      } catch {
        return false;
      }
    };
    if (exists(before) || !exists(after)) return false;
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
    try {
      git(cwd, "cat-file", "-e", `${mergeBase}:${file}`);
    } catch {
      continue;
    }
    try {
      git(cwd, "cat-file", "-e", `${head}:${file}`);
    } catch {
      const content = git(cwd, "show", `${mergeBase}:${file}`);
      const count = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
      const lines = Array.from({ length: count }, (_, i) => `マージベースの版の行 ${i + 1}`);
      violations.push({ file, lines: lines.length ? lines : ["空のファイルを削除"] });
      continue;
    }
    const contents = [mergeBase, head].map((rev) =>
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
          (item, i) => i > last && linkFix(old.text, item.text, file, head, cwd),
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
        `${issue.file}: ${issue.lines.join(", ")}\nこのファイルの変更を戻してください（git checkout ${result.mergeBase} -- ${issue.file}）。同じタスクのファイルには、既存の行を変えずに書き足してください。`,
      );
    }
    if (result.violations.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
