import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireInstanceLock,
  alreadyRunningMessage,
  type InstanceLock,
  LOCK_FILE,
  OWNER_FILE,
  readOwner,
} from "./instance-lock.js";

let dir: string;
const spawned: ChildProcess[] = [];
const locks: InstanceLock[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-lock-"));
});

afterEach(() => {
  for (const lock of locks.splice(0)) lock.release();
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const acquire = (home: string, url = "http://127.0.0.1:4900") => {
  const result = acquireInstanceLock(home, url);
  if (result.ok) locks.push(result.lock);
  return result;
};

const homeIn = (name: string) => {
  const home = join(dir, name);
  mkdirSync(home, { recursive: true });
  return home;
};

/**
 * 別のプロセスのデーモンの代わり（ロックを取って、取れたかを1行で知らせ、そのまま動き続ける）。SIGTERM では、
 * main.ts と同じく、ロックを外してから終わる。
 */
const holder = async (home: string, url: string, withChild = false) => {
  const file = join(dir, `holder-${spawned.length}.mjs`);
  const module = fileURLToPath(new URL("./instance-lock.ts", import.meta.url));
  writeFileSync(
    file,
    `const { acquireInstanceLock } = await import(${JSON.stringify(module)});
const result = acquireInstanceLock(${JSON.stringify(home)}, ${JSON.stringify(url)});
if (result.ok) {
  process.on("SIGTERM", () => { result.lock.release(); process.exit(0); });
  setInterval(() => {}, 1000);
}
if (${JSON.stringify(withChild)}) {
  // MCP サーバーのように、自分のグループで動く子を残す
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["300"], { detached: true, stdio: ["pipe", "pipe", "inherit"] });
  process.stdout.write("child " + child.pid + " ");
}
process.stdout.write(result.ok ? "locked\\n" : "busy\\n");
`,
  );
  // Node 22 では、型を消して読むのに、フラグが要る
  const flags = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
  const child = spawn(process.execPath, [...flags, file], { stdio: ["ignore", "pipe", "inherit"] });
  spawned.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve(out.trim());
    });
    child.once("exit", (code) => reject(new Error(`holder exited (${code})`)));
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { child, line, exited };
};

describe.skipIf(process.platform === "win32")("デーモンを二重に起動させない（PBI-79）", () => {
  it("同じ SACTY_HOME でほかのデーモンが動いていれば、ロックを取れず、その接続先と PID を返す", async () => {
    const home = homeIn("home");
    const first = await holder(home, "http://127.0.0.1:4900");
    expect(first.line).toBe("locked");

    // 別のポートを指定しても、同じホームなら取れない
    const second = acquire(home, "http://127.0.0.1:4910");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.owner).toMatchObject({ pid: first.child.pid, url: "http://127.0.0.1:4900" });
    const text = alreadyRunningMessage(home, second.owner);
    expect(text).toContain("http://127.0.0.1:4900");
    expect(text).toContain(`PID ${first.child.pid}`);
    // 動いているデーモンの表示を書き換えない
    expect(readOwner(home)?.pid).toBe(first.child.pid);
  });

  it("同じ SACTY_HOME を別の書き方（シンボリックリンク）で指しても、取れない", async () => {
    const home = homeIn("home");
    const alias = join(dir, "alias");
    symlinkSync(home, alias);
    expect((await holder(alias, "http://127.0.0.1:4900")).line).toBe("locked");
    expect(acquire(home).ok).toBe(false);
  });

  it("同じプロセスの中でも、二重には取れない", () => {
    const home = homeIn("home");
    expect(acquire(home).ok).toBe(true);
    expect(acquire(home).ok).toBe(false);
  });

  it("前のデーモンが突然落ちて（SIGKILL）印が残っていても、起動できる", async () => {
    const home = homeIn("home");
    const first = await holder(home, "http://127.0.0.1:4900");
    expect(first.line).toBe("locked");
    first.child.kill("SIGKILL");
    await first.exited;
    // 印（ロックのファイルと、表示用のファイル）は残っている
    expect(existsSync(join(home, LOCK_FILE))).toBe(true);
    expect(readOwner(home)?.pid).toBe(first.child.pid);

    const next = acquire(home, "http://127.0.0.1:4910");
    expect(next.ok).toBe(true);
    // 表示は、新しいデーモンのものに書き換わる
    expect(readOwner(home)).toMatchObject({ pid: process.pid, url: "http://127.0.0.1:4910" });
  });

  it("前のデーモンが、子のプロセス（MCP サーバーなど）を残して突然落ちても、起動できる", async () => {
    const home = homeIn("home");
    const first = await holder(home, "http://127.0.0.1:4900", true);
    const m = /^child (\d+) locked$/.exec(first.line);
    expect(m).not.toBeNull();
    const child = Number(m?.[1]);
    try {
      first.child.kill("SIGKILL");
      await first.exited;
      // 子は動き続けている
      expect(() => process.kill(child, 0)).not.toThrow();
      expect(acquire(home).ok).toBe(true);
    } finally {
      process.kill(child, "SIGKILL");
    }
  });

  it("残った印の PID が、いま動いているほかのプロセスに再利用されていても、起動できる", async () => {
    const home = homeIn("home");
    // 前のデーモンの印。PID は、いま動いている（ロックを持たない）ほかのプロセスのもの
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(other);
    writeFileSync(join(home, LOCK_FILE), "");
    writeFileSync(
      join(home, OWNER_FILE),
      JSON.stringify({ pid: other.pid, url: "http://127.0.0.1:4900", startedAt: "x" }),
    );
    expect(acquire(home).ok).toBe(true);
  });

  it("壊れた表示用のファイルが残っていても起動でき、取れないときは接続先・PID が読めないと表示する", async () => {
    const home = homeIn("home");
    writeFileSync(join(home, OWNER_FILE), "{");
    expect((await holder(home, "http://127.0.0.1:4900")).line).toBe("locked");
    writeFileSync(join(home, OWNER_FILE), "{");
    const second = acquire(home);
    expect(second).toEqual({ ok: false, owner: undefined });
    expect(alreadyRunningMessage(home, undefined)).toContain("読めませんでした");
  });

  it("違う SACTY_HOME のデーモンどうしは、並行して動ける", async () => {
    const a = homeIn("a");
    const b = homeIn("b");
    expect((await holder(a, "http://127.0.0.1:4900")).line).toBe("locked");
    expect((await holder(b, "http://127.0.0.1:4920")).line).toBe("locked");
    expect(acquire(homeIn("c")).ok).toBe(true);
  });

  it("止めたデーモンはロックを外して表示用のファイルを消し、次のデーモンが起動できる", async () => {
    const home = homeIn("home");
    const first = await holder(home, "http://127.0.0.1:4900");
    first.child.kill("SIGTERM");
    await first.exited;
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
    expect(acquire(home).ok).toBe(true);
  });

  it("ロックを外すとき、ほかのデーモンが書いた表示用のファイルは消さない", () => {
    const home = homeIn("home");
    const result = acquire(home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const other = JSON.stringify({ pid: 1, url: "http://127.0.0.1:4910", startedAt: "x" });
    writeFileSync(join(home, OWNER_FILE), other);
    result.lock.release();
    expect(readFileSync(join(home, OWNER_FILE), "utf8")).toBe(other);
  });
});

describe("デーモンの起動の順序（PBI-79）", () => {
  it("ロックは、データを触るどの起動の処理よりも先に取る", () => {
    const main = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
    const lock = main.indexOf("acquireInstanceLock(");
    const exit = main.indexOf("process.exit(ALREADY_RUNNING_EXIT_CODE)");
    expect(lock).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(lock);
    for (const step of [
      "new SqliteActivityStore(",
      "new SqliteProjectStore(",
      "new SqliteSettingsStore(",
      "composeServices.cleanupAll()",
      "cleanupSharedComposeRuns(",
      "hostMcpProcesses.cleanup()",
      "gateway.listen()",
      "service.recoverInterrupted()",
      "serve(",
    ]) {
      const at = main.indexOf(step);
      expect(at, step).toBeGreaterThan(exit);
    }
  });
});
