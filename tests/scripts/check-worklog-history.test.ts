import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/check-worklog-history.mjs");
const dirs: string[] = [];
const a = "docs/worklog/20261122-pbi-489-x.md";
const b = "docs/worklog/20261023-pbi-152-x.md";
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worklog-test-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  const put = (name: string, text: string | Buffer) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "change");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  put(a, "one\ntwo\nthree\nfour\nfive\n");
  put(b, "[one](../adr/old.md)\n[two](../adr/old2.md)\n");
  put("docs/adr/new.md", "new");
  put("docs/adr/new2.md", "new");
  put("docs/worklog/README.md", "old\n");
  const base = commit();
  const run = (baseSha = base, title = "PBI-488 task", number = "600") =>
    spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        BASE_SHA: baseSha,
        HEAD_SHA: git("rev-parse", "HEAD"),
        PR_TITLE: title,
        PR_NUMBER: number,
      },
    });
  return { dir, git, put, commit, base, run };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("worklog history", () => {
  it("TV-1: protects history merged from main", () => {
    const r = repo();
    r.git("rm", a);
    const fork = r.commit();
    r.git("checkout", "-qb", "pr");
    r.git("checkout", "-qb", "main", fork);
    r.put(a, "one\ntwo\nthree\nfour\nfive\nmain\n");
    const base = r.commit();
    r.git("checkout", "-q", "pr");
    r.git("merge", "--no-ff", "-qm", "merge", "main");
    r.put(a, "one\ntwo\nchanged\nfour\nfive\nmain\n");
    r.commit();
    const x = r.run(base);
    expect(x.status).toBe(1);
    expect(x.stderr).toContain(a);
    expect(x.stderr).toContain("マージベースの版の行 3");
    expect(x.stderr).toContain(`git checkout ${base} -- ${a}`);
  });
  it("TV-2: rejects additions to another task", () => {
    const r = repo();
    r.put(a, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    r.commit();
    const x = r.run();
    expect(x.status).toBe(1);
    expect(x.stderr).toContain(a);
    expect(x.stderr).toContain("PR の先頭の版の行 6");
    expect(x.stderr).toContain("PR の先頭の版の行 7");
  });
  it("TV-3: rejects a rename", () => {
    const r = repo();
    r.git("mv", a, a.replace("-x.md", "-y.md"));
    r.commit();
    const x = r.run();
    expect(x.status).toBe(1);
    expect(x.stderr).toContain(a);
  });
  it("TV-4: allows a broken link repair", () => {
    const r = repo();
    r.put(b, "[one](../adr/new.md)\n[two](../adr/old2.md)\n");
    r.commit();
    const x = r.run();
    expect(x.status).toBe(0);
    expect(x.stderr).toBe("");
  });
  it("TV-5: rejects changing a live link", () => {
    const r = repo();
    r.put("docs/adr/old.md", "old");
    const base = r.commit();
    r.put(b, "[one](../adr/new.md)\n[two](../adr/old2.md)\n");
    r.commit();
    const x = r.run(base);
    expect(x.status).toBe(1);
    expect(x.stderr).toContain(b);
    expect(x.stderr).toContain("マージベースの版の行 1");
    expect(x.stderr).toContain("git checkout");
  });
  it("rejects binary-classified changes to merged histories", () => {
    for (const title of ["PBI-488 task", "PBI-489 task"]) {
      const r = repo();
      r.put(a, "one\ntwo\nchanged\0content\nfour\nfive\n");
      r.commit();
      const x = r.run(r.base, title);
      expect(x.status).toBe(1);
      expect(x.stderr).toContain(a);
      expect(x.stderr).toContain("テキストとして判定できない");
      expect(x.stderr).toContain("git checkout");
    }
  });
  it("rejects deletion of non-text history as a whole", () => {
    for (const bytes of [Buffer.from([0]), Buffer.from([0xff])]) {
      const r = repo();
      r.put(b, bytes);
      const base = r.commit();
      r.git("rm", b);
      r.commit();
      const result = r.run(base);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("テキストとして判定できない");
    }
  });
  it("rejects link replacements when the old target cannot be checked in the tree", () => {
    for (const target of [
      "#section",
      "https://example.com/a",
      "mailto:test@example.com",
      "//example.com/a",
    ]) {
      const r = repo();
      r.put(b, `[one](${target})\n`);
      const base = r.commit();
      r.put(b, "[one](../adr/new.md)\n");
      r.commit();
      const x = r.run(base);
      expect(x.status).toBe(1);
      expect(x.stderr).toContain(b);
      expect(x.stderr).toContain("マージベースの版の行 1");
      expect(x.stderr).toContain("git checkout");
    }
  });
  it("rejects invalid bytes and binary diffs even with a link repair through the CLI", () => {
    for (const bytes of [
      Buffer.from([0]),
      ...Array.from({ length: 128 }, (_, i) => Buffer.from([128 + i])),
    ]) {
      for (const invalidSide of ["before", "after"]) {
        const r = repo();
        const line = (target: string, value: Buffer) =>
          Buffer.concat([
            Buffer.from("prefix "),
            value,
            Buffer.from(` [one](../adr/${target}.md)\n`),
          ]);
        r.put(b, line("old", invalidSide === "before" ? bytes : Buffer.from("ok")));
        const base = r.commit();
        r.put(b, line("new", invalidSide === "after" ? bytes : Buffer.from("ok")));
        r.commit();
        const result = r.run(base);
        expect(result.status, `${bytes.toString("hex")} ${invalidSide}`).toBe(1);
        expect(result.stderr).toContain(b);
        expect(result.stderr).toContain("git checkout");
      }
    }
    const r = repo();
    r.put(".gitattributes", "docs/worklog/*.md binary\n");
    const base = r.commit();
    r.put(b, "[one](../adr/new.md)\n[two](../adr/old2.md)\n");
    r.commit();
    const result = r.run(base);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(b);
  }, 120000);
  it("allows large histories and large diffs through the CLI", () => {
    const r = repo();
    const large = `${"ordinary text ".repeat(90000)}\n`;
    r.put(a, large);
    const base = r.commit();
    r.put(a, `${large}${"extra text ".repeat(110000)}\n`);
    r.commit();
    expect(r.run(base, "PBI-489 task").status).toBe(0);
    const rejected = r.run(base, "PBI-488 task");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("PR の先頭の版の行 2");
  });
  it("allows broken Unicode link targets through the CLI", () => {
    const r = repo();
    r.put("docs/adr/新しい.md", "new");
    r.put(b, "[one](../adr/à-old.md)\n");
    const base = r.commit();
    r.put(b, "[one](../adr/新しい.md)\n");
    r.commit();
    const result = r.run(base);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
  it("rejects changing invalid bytes on both sides together with a link repair", () => {
    for (const [before, after] of [
      [0x80, 0x81],
      [0xfe, 0xff],
      [0, 1],
    ]) {
      const r = repo();
      const line = (byte: number, target: string) =>
        Buffer.concat([Buffer.from([byte]), Buffer.from(` [one](../adr/${target}.md)\n`)]);
      r.put(b, line(before, "old"));
      const base = r.commit();
      r.put(b, line(after, "new"));
      r.commit();
      const result = r.run(base);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(b);
    }
  });
  it("rejects code and escaped link changes, but allows ordinary repairs", () => {
    for (const [before, after, expected] of [
      ["`[x](../adr/old.md)`", "`[x](../adr/new.md)`", 1],
      ["```md\n[x](../adr/old.md)\n```", "```md\n[x](../adr/new.md)\n```", 1],
      ["~~~\n[x](../adr/old.md)\n~~~", "~~~\n[x](../adr/new.md)\n~~~", 1],
      ["\\[x](../adr/old.md)", "\\[x](../adr/new.md)", 1],
      ["![x](../adr/old.md)", "![x](../adr/new.md)", 1],
      ["[x](../adr/old.md)", "[x](../adr/new.md)", 0],
    ] as const) {
      const r = repo();
      r.put(b, `${before}\n`);
      const base = r.commit();
      r.put(b, `${after}\n`);
      r.commit();
      expect(r.run(base).status, before).toBe(expected);
    }
  });
  it("requires a file target and accepts literal percent paths", () => {
    const r = repo();
    r.put(b, "[x](../adr/50%-old.md)\n");
    const base = r.commit();
    r.put(b, "[x](../adr)\n");
    r.commit();
    expect(r.run(base).status).toBe(1);
    r.put("docs/adr/50%-new.md", "new");
    r.put(b, "[x](../adr/50%-new.md)\n");
    r.commit();
    expect(r.run(base).status).toBe(0);
  });
  it("fails closed when Git cannot inspect a tree", () => {
    const r = repo();
    r.put(b, "[one](../adr/new.md)\n");
    r.commit();
    const bin = path.join(r.dir, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(bin, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = ls-tree ]; then exit 42; fi\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const result = spawnSync(process.execPath, [script], {
      cwd: r.dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        BASE_SHA: r.base,
        HEAD_SHA: r.git("rev-parse", "HEAD"),
        PR_TITLE: "PBI-488",
        PR_NUMBER: "600",
      },
    });
    expect(result.status).toBe(2);
  });
  it("quotes special paths in the restoration command", () => {
    const r = repo();
    const file = "docs/worklog/20261122-pbi-489-quote ' x.md";
    r.put(file, "old\n");
    const base = r.commit();
    r.put(file, "changed\n");
    r.commit();
    const result = r.run(base);
    expect(result.status).toBe(1);
    const command = result.stderr.match(/git checkout [^）]+/)?.[0];
    expect(command).toBeDefined();
    execFileSync("sh", ["-c", command as string], { cwd: r.dir });
    expect(readFileSync(path.join(r.dir, file), "utf8")).toBe("old\n");
  });
  it("TV-6: rejects reordered repairs but accepts ordered repairs", () => {
    const r = repo();
    r.put(b, "[one](../adr/new.md)\n[two](../adr/new2.md)\n");
    r.commit();
    expect(r.run().status).toBe(0);
    r.put(b, "[two](../adr/new2.md)\n[one](../adr/new.md)\n");
    r.commit();
    const x = r.run();
    expect(x.status).toBe(1);
    expect(x.stderr).toContain(b);
    expect(x.stderr).toContain("行");
    expect(x.stderr).toContain("git checkout");
  });
  it("TV-7: allows same PBI additions", () => {
    const r = repo();
    r.put(a, "one\ntwo\nthree\nfour\nfive\nsection\n");
    r.commit();
    const x = r.run(r.base, "PBI-489 task", "999");
    expect(x.status).toBe(0);
    expect(x.stderr).toBe("");
  });
  it("TV-8: allows a link repair and additions in one hunk", () => {
    const r = repo();
    r.put(a, "one\n[one](../adr/old.md)\n");
    const base = r.commit();
    r.put(a, "one\n[one](../adr/new.md)\nextra\nextra2\n");
    r.commit();
    expect(r.run(base, "PBI-489 task").status).toBe(0);
  });
  it("TV-9: rejects same task deletions but allows additions", () => {
    const r = repo();
    r.put(a, "one\ntwo\nthree\nfour\nextra\n");
    r.commit();
    const x = r.run(r.base, "PBI-489 task");
    expect(x.status).toBe(1);
    expect(x.stderr).toContain("マージベースの版の行 5");
    expect(x.stderr).not.toContain("PR の先頭の版の行");
  });
  it("TV-10: allows edits to a new file", () => {
    const r = repo();
    const f = "docs/worklog/20261123-pbi-497-x.md";
    r.put(f, "first\n");
    r.commit();
    r.put(f, "changed\n");
    r.commit();
    expect(r.run().status).toBe(0);
  });
  it("TV-11: ignores the worklog README", () => {
    const r = repo();
    r.put("docs/worklog/README.md", "changed\n");
    r.commit();
    expect(r.run().status).toBe(0);
  });
  it("TV-12: uses PR number when title lacks PBI", () => {
    const r = repo();
    const own = "docs/worklog/20261020-pr-600-x.md";
    const other = "docs/worklog/20261019-codex-prompt-double-dash.md";
    r.put(own, "one\n");
    r.put(other, "one\n");
    const base = r.commit();
    r.put(own, "one\ntwo\n");
    r.put(other, "one\ntwo\n");
    r.commit();
    const x = r.run(base, "依存を上げる");
    expect(x.status).toBe(1);
    expect(x.stderr).toContain(other);
    expect(x.stderr).not.toContain(own);
  });
  it("TV-13: title edit triggers workflow and changes the result", () => {
    const workflow = readFileSync(".github/workflows/worklog-history.yml", "utf8");
    expect(workflow).toMatch(/types:.*edited/);
    expect(workflow).toContain("PR_TITLE: $" + "{{ github.event.pull_request.title }}");
    const r = repo();
    r.put(a, "one\ntwo\nthree\nfour\nfive\nextra\n");
    r.commit();
    expect(r.run(r.base, "PBI-488 task").status).toBe(1);
    expect(r.run(r.base, "PBI-489 task").status).toBe(0);
  });
  it("TV-14: fails closed for an unknown base", () => {
    const r = repo();
    const x = r.run("deadbeef");
    expect(x.status).toBe(2);
    expect(x.stderr).toContain("SHA を解決できません");
  });
});
