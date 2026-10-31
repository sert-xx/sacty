import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(new URL("../../apps/desktop/main.cjs", import.meta.url));
const source = readFileSync(new URL("../../apps/desktop/main.cjs", import.meta.url), "utf8");

async function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  });
  const handlers = new Map();
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getLocale: () => "ja",
    quit: vi.fn(),
  });
  const dialog = { showErrorBox: vi.fn() };
  const windows: Window[] = [];
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
      send: vi.fn(),
    });
    constructor() {
      super();
      windows.push(this);
    }
    loadFile = vi.fn(async () => {});
    loadURL = vi.fn(async () => {});
    isDestroyed = () => false;
    close = () => this.emit("closed");
    destroy = () => this.emit("closed");
  }
  const runtime = {
    ...require("./runtime.cjs"),
    runtimePaths: () => ({}),
    prepare: async () => {},
    launch: () => child,
    waitForScreen: async () => "http://127.0.0.1:4700",
    stopChild: vi.fn(async () => {}),
  };
  runInNewContext(source, {
    __dirname: "/desktop",
    process,
    AbortController,
    require: (id: string) => {
      if (id === "electron")
        return {
          app,
          BrowserWindow: Window,
          dialog,
          ipcMain: { handle: (key: string, fn: unknown) => handlers.set(key, fn) },
          session: { defaultSession: { cookies: { get: async () => [] } } },
        };
      if (id === "./runtime.cjs") return runtime;
      return require(id);
    },
  });
  await vi.waitFor(() => expect(handlers.has("desktop:start")).toBe(true));
  const result = await handlers.get("desktop:start")({
    sender: windows[0].webContents,
    senderFrame: { url: "file:///desktop/setup.html" },
  });
  expect(result).toEqual({ ok: true });
  return { child, app, dialog };
}

afterEach(() => vi.useRealTimers());

describe("desktop CLI exit handling", () => {
  it("reports exit within a bounded wait even when inherited pipes never close", async () => {
    const { child, app, dialog } = await fixture();
    child.exitCode = 1;
    child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(500);
    child.stderr.write("late EADDRINUSE\n");
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox.mock.calls[0][1]).toContain("late EADDRINUSE");
    expect(app.quit).toHaveBeenCalledOnce();
    child.emit("close", 1);
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
  });

  it("reports immediately after close and includes output arriving after exit", async () => {
    const { child, app, dialog } = await fixture();
    child.exitCode = 1;
    child.emit("exit", 1);
    child.stderr.write("late ECONNRESET\n");
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog.showErrorBox.mock.calls[0][1]).toContain("late ECONNRESET");
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("suppresses the failure message when quitting during the output wait", async () => {
    const { child, app, dialog } = await fixture();
    child.exitCode = 1;
    child.emit("exit", 1);
    const event = { preventDefault: vi.fn() };
    app.emit("before-quit", event);
    await vi.advanceTimersByTimeAsync(1000);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
