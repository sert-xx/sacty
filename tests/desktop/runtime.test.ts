import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { waitForScreen, redact, stopChild, saveApiKey } = require("../../apps/desktop/runtime.cjs");

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
}

describe("desktop runtime", () => {
  it("waits for HTTP readiness and reassembles a URL split between chunks", async () => {
    const process = child();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue({ status: 307 });
    const waiting = waitForScreen(process, { request, timeout: 2000 });
    process.stdout.write("Open http://127.0.0.1:4700/auth?tok");
    process.stdout.write("en=example-token in your browser.\n");
    await expect(waiting).resolves.toBe("http://127.0.0.1:4700/auth?token=example-token");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(process.stdout.listenerCount("data")).toBe(0);
  });

  it("bounds a stalled request with an abort signal", async () => {
    const process = child();
    const request = (_url: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const waiting = waitForScreen(process, { request, timeout: 150 });
    process.stdout.write("http://127.0.0.1:4700/auth?token=example\n");
    await expect(waiting).rejects.toThrow("時間内");
  });

  it("reports a process exit instead of treating a printed URL as success", async () => {
    const process = child();
    const waiting = waitForScreen(process);
    process.emit("exit", 1);
    await expect(waiting).rejects.toThrow("起動できません");
  });

  it("waits for shutdown after sending SIGTERM", async () => {
    const process = child();
    const stopping = stopChild(process);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    process.emit("exit", 0);
    await stopping;
  });

  it("keeps API keys out of process arguments and rejects injected commands", async () => {
    const process = child();
    const spawn = vi.fn(() => process);
    let input = "";
    process.stdin.on("data", (data) => {
      input += data.toString();
    });
    const saving = saveApiKey("sk-example-key-value", spawn);
    expect(spawn.mock.calls[0]).toEqual([
      "/usr/bin/security",
      ["-i"],
      { stdio: ["pipe", "ignore", "pipe"] },
    ]);
    expect(input).toContain("-s sacty -a openai-api-key -w sk-example-key-value");
    process.emit("exit", 0);
    process.emit("close", 0);
    await saving;
    await expect(saveApiKey("sk-example\nother-command", spawn)).rejects.toThrow("形式");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports a keychain error even if the interactive command exits zero", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    process.stderr.write("security: SecKeychainItemCreateFromContent: error");
    process.emit("exit", 0);
    process.emit("close", 0);
    await expect(saving).rejects.toThrow("保存できません");
  });

  it("detects an error marker split between stderr chunks", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    const checked = expect(saving).rejects.toThrow("保存できません");
    process.stderr.write("err");
    process.stderr.write("or");
    process.emit("exit", 0);
    process.emit("close", 0);
    await checked;
  });

  it("waits for close and catches error output arriving after exit", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    const settled = vi.fn();
    void saving.then(settled, settled);
    process.emit("exit", 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const checked = expect(saving).rejects.toThrow("保存できません");
    process.stderr.write("security: error after exit");
    process.emit("close", 0);
    await checked;
  });

  it("rejects stderr overflow instead of accepting incomplete diagnostic output", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    const checked = expect(saving).rejects.toThrow("保存できません");
    process.stderr.write("x".repeat(128 * 1024));
    process.emit("close", 0);
    await checked;
  });

  it("retains an early error across later stderr output without exposing it", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    const checked = expect(saving).rejects.toThrow(
      /^保存できません。入力とキーチェーンを確認してください。$/,
    );
    process.stderr.write("error sk-example-key-value");
    process.stderr.write("x".repeat(128 * 1024));
    process.emit("close", 0);
    await checked;
  });

  it("allows harmless stderr only once stdio is closed", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    const settled = vi.fn();
    void saving.then(settled);
    process.stderr.write("security> ");
    process.emit("exit", 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    process.emit("close", 0);
    await expect(saving).resolves.toBeUndefined();
  });

  it("rejects nonzero close codes even without stderr", async () => {
    const process = child();
    const saving = saveApiKey("sk-example-key-value", () => process);
    process.emit("close", 1);
    await expect(saving).rejects.toThrow("保存できません");
  });

  it("redacts authentication tokens and keys", () => {
    expect(redact("token=example-secret sk-example-key")).toBe("token=[REDACTED] [REDACTED]");
  });
});
