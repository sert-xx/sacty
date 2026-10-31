import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withSmokeWorkspace } from "../../apps/desktop/scripts/smoke-workspace.mjs";

describe("smoke workspace cleanup", () => {
  it.each(["success", "copy failure", "launch failure", "assertion failure"])(
    "cleans up after %s",
    async (mode) => {
      let root = "";
      const close = vi.fn(async () => {
        expect(existsSync(root)).toBe(true);
      });
      const running = withSmokeWorkspace(
        async ({ testRoot, trackApplication, closeApplication }) => {
          root = testRoot;
          mkdirSync(join(root, "sacty.app"));
          writeFileSync(join(root, "sacty.app/partial-copy"), "fixture");
          if (mode === "copy failure" || mode === "launch failure") throw new Error(mode);
          trackApplication({ close });
          if (mode === "assertion failure") throw new Error(mode);
          await closeApplication();
          // The final shutdown check runs before workspace deletion.
          expect(existsSync(root)).toBe(true);
        },
      );
      if (mode === "success") await running;
      else await expect(running).rejects.toThrow(mode);
      expect(existsSync(root)).toBe(false);
      expect(close).toHaveBeenCalledTimes(
        mode === "success" || mode === "assertion failure" ? 1 : 0,
      );
    },
  );
  it("waits for application shutdown before deleting files", async () => {
    let finish!: () => void;
    let root = "";
    const stopping = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = withSmokeWorkspace(async ({ testRoot, trackApplication }) => {
      root = testRoot;
      trackApplication({ close: () => stopping });
    });
    await Promise.resolve();
    expect(existsSync(root)).toBe(true);
    finish();
    await running;
    expect(existsSync(root)).toBe(false);
  });
  it("keeps files if shutdown cannot be confirmed", async () => {
    let root = "";
    try {
      await expect(
        withSmokeWorkspace(async ({ testRoot, trackApplication }) => {
          root = testRoot;
          trackApplication({
            close: async () => {
              throw new Error("shutdown failed");
            },
          });
        }),
      ).rejects.toThrow("shutdown failed");
      expect(existsSync(root)).toBe(true);
    } finally {
      // This fixture has no process; remove the intentionally retained test folder.
      rmSync(root, { recursive: true, force: true });
    }
  });
});
