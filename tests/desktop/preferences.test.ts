import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { saveLanguage } = require("../../apps/desktop/preferences.cjs");
describe("desktop language preference", () => {
  it("updates an existing HttpOnly cookie and persists it for a year", async () => {
    const cookies = {
      set: vi.fn(async (value) => {
        if (!value.httpOnly) throw new Error("EXCLUDE_OVERWRITE_HTTP_ONLY");
      }),
      flushStore: vi.fn(async () => {}),
    };
    await saveLanguage({ cookies }, "en", 1000);
    expect(cookies.set).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4700/",
      name: "sacty-lang",
      value: "en",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1 + 365 * 24 * 60 * 60,
    });
    expect(cookies.flushStore).toHaveBeenCalledOnce();
  });
  it("rejects unsupported languages without modifying cookies", async () => {
    const cookies = { set: vi.fn(), flushStore: vi.fn() };
    await expect(saveLanguage({ cookies }, "unsupported")).rejects.toThrow("Invalid language");
    expect(cookies.set).not.toHaveBeenCalled();
  });
});
