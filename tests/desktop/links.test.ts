import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { isAppUrl, openExternalLink } = require("../../apps/desktop/links.cjs");

describe("desktop external links", () => {
  it.each(["https://github.com/acme/example/pull/1", "http://example.com/preview"])(
    "opens a web link in the browser: %s",
    async (url) => {
      const open = vi.fn().mockResolvedValue(undefined);
      await expect(openExternalLink(url, open)).resolves.toBe(true);
      expect(open).toHaveBeenCalledExactlyOnceWith(url);
    },
  );
  it.each([
    "javascript:alert(1)",
    "file:///tmp/example",
    "custom:example",
    "not a URL",
    "https://user:password@example.com",
    "http://127.0.0.1:4700/auth?token=example",
  ])("does not hand an unsafe or internal URL to the browser: %s", async (url) => {
    const open = vi.fn();
    await expect(openExternalLink(url, open)).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("keeps internal navigation confined to the application origin", () => {
    expect(isAppUrl("http://127.0.0.1:4700/tasks/example")).toBe(true);
    expect(isAppUrl("http://127.0.0.1:47000/tasks/example")).toBe(false);
    expect(isAppUrl("not a URL")).toBe(false);
  });
});
