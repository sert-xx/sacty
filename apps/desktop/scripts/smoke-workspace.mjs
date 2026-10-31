import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withSmokeWorkspace(run) {
  const testRoot = mkdtempSync(join(tmpdir(), "sacty-desktop-test-"));
  let application;
  const closeApplication = async () => {
    if (!application) return;
    await application.close();
    application = undefined;
  };
  try {
    return await run({
      testRoot,
      trackApplication: (value) => {
        application = value;
        return value;
      },
      closeApplication,
    });
  } finally {
    // Do not remove an application's files until shutdown has completed.
    await closeApplication();
    rmSync(testRoot, { recursive: true, force: true });
  }
}
