import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("npm test は Vitest をファイル直列で起動する", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-test-command-"));
  try {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: packageJson.scripts.test } }),
    );
    const bin = join(dir, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    const vitest = join(bin, "vitest");
    writeFileSync(vitest, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(vitest, 0o755);
    const output = execFileSync("npm", ["test", "--silent"], { cwd: dir, encoding: "utf8" });
    expect(output.trim().split("\n")).toEqual(["run", "--no-file-parallelism"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
