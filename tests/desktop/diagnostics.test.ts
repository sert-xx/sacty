import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { captureDiagnostics } = require("../../apps/desktop/diagnostics.cjs");
const { waitForScreen } = require("../../apps/desktop/runtime.cjs");
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
describe("bounded desktop diagnostics", () => {
  it("captures startup errors, late stderr and output after readiness", async () => {
    const p = child();
    const log = captureDiagnostics(p);
    const starting = waitForScreen(p, { request: async () => ({ status: 200 }) });
    p.stdout.write("http://127.0.0.1:4700/auth?token=private-token\n");
    await starting;
    p.stderr.write("Error: EADDRINUSE 127.0.0.1:4700\n");
    p.emit("exit", 1);
    const closing = log.waitForClose();
    p.stderr.write("late ECONNRESET");
    p.emit("close", 1);
    await closing;
    expect(log.text()).toContain("EADDRINUSE");
    expect(log.text()).toContain("ECONNRESET");
    expect(log.text()).not.toContain("private-token");
  });
  it("redacts split credentials and treats streams independently", () => {
    const p = child();
    const log = captureDiagnostics(p);
    p.stdout.write("sk-");
    p.stderr.write("EACCES\n");
    p.stdout.write("private-key\n");
    p.stderr.write("Authorization: Bea");
    p.stderr.write("rer private-auth\n");
    p.stdout.write('Cookie: session=private-cookie\n{"token":"private-json"}\n');
    p.stderr.write("github_pat_private123 ghp_private456\n");
    p.stdout.write(
      "URL https://alice:opaque-pass@example.com/fail?q=opaque-query#opaque-fragment\n",
    );
    const text = log.text();
    expect(text).toContain("EACCES");
    for (const secret of [
      "private-key",
      "private-auth",
      "private-cookie",
      "private-json",
      "private123",
      "private456",
      "alice",
      "opaque-pass",
      "opaque-query",
      "opaque-fragment",
    ])
      expect(text).not.toContain(secret);
  });
  it("redacts incomplete lines before close", () => {
    const p = child();
    const log = captureDiagnostics(p);
    p.stderr.write("sk-private-key");
    expect(log.text()).toBe("[REDACTED]");
  });
  it("bounds retained output and discards oversized lines", () => {
    const p = child();
    const log = captureDiagnostics(p, { maxBytes: 128, maxLineBytes: 64 });
    for (let i = 0; i < 100; i++) p.stderr.write(`EACCES event ${i}\n`);
    expect(Buffer.byteLength(log.text())).toBeLessThanOrEqual(128);
    expect(log.text()).toContain("event 99");
    expect(log.text()).not.toContain("event 0\n");
    p.stdout.write(`sk-${"private".repeat(10000)}`);
    expect(log.text()).not.toContain("private");
    p.stdout.write("\nECONNREFUSED\n");
    expect(log.text()).toContain("ECONNREFUSED");
    expect(Buffer.byteLength(log.text())).toBeLessThanOrEqual(128);
  });
});
