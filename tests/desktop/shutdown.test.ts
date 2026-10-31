import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createShutdownHandler } = require("../../apps/desktop/shutdown.cjs");
function fixture() {
  let child: object | undefined = {};
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const waiting = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const callbacks = {
    getChild: () => child,
    stop: vi.fn(() => waiting),
    abort: vi.fn(),
    onStopping: vi.fn(),
    onStopped: vi.fn(),
    onFailure: vi.fn(),
  };
  return {
    handler: createShutdownHandler(callbacks),
    callbacks,
    finish,
    fail,
    clearChild: () => {
      child = undefined;
    },
  };
}
describe("desktop shutdown requests", () => {
  it("defers every quit request until stopping finishes, even after child exit", async () => {
    const f = fixture();
    const first = { preventDefault: vi.fn() };
    const pending = f.handler(first);
    await Promise.resolve();
    f.clearChild();
    const second = { preventDefault: vi.fn() };
    expect(f.handler(second)).toBe(pending);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(f.callbacks.stop).toHaveBeenCalledOnce();
    expect(f.callbacks.onStopped).not.toHaveBeenCalled();
    f.finish();
    await pending;
    expect(f.callbacks.onStopped).toHaveBeenCalledOnce();
    const final = { preventDefault: vi.fn() };
    f.handler(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });
  it("aborts preparation without blocking when no CLI was started", () => {
    const f = fixture();
    f.clearChild();
    const event = { preventDefault: vi.fn() };
    f.handler(event);
    expect(f.callbacks.abort).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(f.callbacks.stop).not.toHaveBeenCalled();
  });
  it("does not allow quitting after stop failure and permits retry", async () => {
    const f = fixture();
    const pending = f.handler({ preventDefault: vi.fn() });
    f.fail(new Error("stop failed"));
    await pending;
    expect(f.callbacks.onFailure).toHaveBeenCalledOnce();
    expect(f.callbacks.onStopped).not.toHaveBeenCalled();
    f.callbacks.stop.mockResolvedValueOnce(undefined);
    const event = { preventDefault: vi.fn() };
    await f.handler(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(f.callbacks.onStopped).toHaveBeenCalledOnce();
  });
});
