import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("DMG の作成には macOS が必要です。");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const application = join(root, `dist/desktop/sacty-darwin-${process.arch}/sacty.app`);
if (!existsSync(application)) throw new Error("先に npm run desktop:package を実行してください。");
const output = resolve(
  process.env.SACTY_DESKTOP_DMG ||
    join(root, `dist/desktop/sacty-desktop-preview-macos-${process.arch}.dmg`),
);
mkdirSync(dirname(output), { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "sacty-dmg-"));
try {
  cpSync(application, join(temporary, "sacty.app"), { recursive: true, verbatimSymlinks: true });
  symlinkSync("/Applications", join(temporary, "Applications"));
  const result = spawnSync(
    "/usr/bin/hdiutil",
    [
      "create",
      "-volname",
      "sacty",
      "-srcfolder",
      temporary,
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-ov",
      output,
    ],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) throw new Error("DMG を作成できませんでした。");
  console.log(output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
