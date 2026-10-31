import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { notificationPermissions } = require("../../apps/desktop/permissions.cjs");
const origin = "http://127.0.0.1:4700";
const contents = () => ({ getURL: () => `${origin}/settings`, isDestroyed: () => false });
describe("desktop notification permissions", () => {
  it("allows notification checks and requests only from the main application", () => {
    const main = contents();
    const policy = notificationPermissions(main, true);
    expect(policy.check(main, "notifications", origin, { isMainFrame: true })).toBe(true);
    const callback = vi.fn();
    policy.request(main, "notifications", callback, {
      requestingUrl: `${origin}/settings`,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenCalledWith(true);
  });
  it.each(["media", "geolocation", "clipboard-read", "unknown"])(
    "denies unrelated permission %s",
    (permission) => {
      const main = contents();
      expect(notificationPermissions(main, true).check(main, permission, origin)).toBe(false);
    },
  );
  it("denies setup windows, other contents, frames, and external origins", () => {
    const main = contents();
    const policy = notificationPermissions(main, true);
    expect(notificationPermissions(main, false).check(main, "notifications", origin)).toBe(false);
    expect(policy.check(contents(), "notifications", origin)).toBe(false);
    expect(policy.check(main, "notifications", "https://example.com")).toBe(false);
    expect(policy.check(main, "notifications", origin, { isMainFrame: false })).toBe(false);
    const callback = vi.fn();
    policy.request(main, "notifications", callback, {
      requestingUrl: "file:///tmp/example",
      isMainFrame: true,
    });
    expect(callback).toHaveBeenCalledWith(false);
  });
});
